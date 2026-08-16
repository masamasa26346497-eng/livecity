// tests/lifestyle-tab-wiring.test.js
// 「生活」タブの呼び出し配線(selectBuilding → updateLifeTab、FacilityDataStore.onReady
// による再描画、closePropCardでのselectedLifePointクリア)を検証する回帰テスト。
//
// 実際に配信されるHTML内のJavaScriptソースを静的に解析し、関数の呼び出し関係・
// 二重呼び出しの有無・状態クリア処理の有無を直接確認する(再実装ではなく実コードを検証)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const STANDARD_CANDIDATE_PATHS = [
  '/mnt/user-data/outputs/osaka_3d_buildings.html',
  path.join(process.cwd(), 'osaka_3d_buildings.html'),
  path.join(process.cwd(), '..', 'osaka_3d_buildings.html'),
];

function resolveHtmlPath() {
  if (process.env.LIVECITY_HTML_PATH) return process.env.LIVECITY_HTML_PATH;
  for (const candidate of STANDARD_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HTML_PATH = resolveHtmlPath();
const SKIP_REASON = HTML_PATH
  ? false
  : `Live City本体HTMLが見つかりません。標準配置候補(${STANDARD_CANDIDATE_PATHS.join(', ')})に` +
    `存在しないか、環境変数 LIVECITY_HTML_PATH で明示的にパスを指定してください。`;

function loadHtml() {
  return readFileSync(HTML_PATH, 'utf-8');
}

/** 指定した関数名の本体(波括弧のバランスを取って抽出)をHTML内から取り出す。 */
function extractFunctionBody(html, functionName) {
  const startMatch = html.match(new RegExp(`function ${functionName}\\([^)]*\\)\\s*\\{`));
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = startIdx;
  while (depth > 0 && i < html.length) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') depth--;
    i++;
  }
  return html.slice(startMatch.index, i);
}

test('配線: selectBuildingからupdateLifeTabが呼ばれること', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'selectBuilding');
  assert.ok(body, 'selectBuilding関数が見つかりません');
  assert.ok(/updateLifeTab\(/.test(body), 'selectBuilding内でupdateLifeTabが呼ばれていません');
});

test('配線: selectBuilding内でupdateLifeTabが1回だけ呼ばれること(二重呼び出し防止)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'selectBuilding');
  const calls = (body.match(/updateLifeTab\(/g) || []).length;
  assert.equal(calls, 1, `selectBuilding内のupdateLifeTab呼び出し回数: ${calls}`);
});

test('配線: showPropertyCard内ではupdateLifeTabを呼ばないこと(二重呼び出し防止)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'showPropertyCard');
  assert.ok(body, 'showPropertyCard関数が見つかりません');
  // コメント行(// で始まる行)を除去してから実際の呼び出しの有無を判定する。
  // コメント内に説明として "updateLifeTab(d)" という文字列が含まれていても
  // それは実際の呼び出しではないため、誤検知を避ける。
  const codeOnly = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/updateLifeTab\(/.test(codeOnly),
    'showPropertyCard内でupdateLifeTabが呼ばれています(selectBuildingと二重呼び出しになる可能性)');
});

test('配線: showPropertyCard内でupdateAgeTabとupdateTownStatsTabは引き続き呼ばれること(既存機能維持)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'showPropertyCard');
  assert.ok(/updateAgeTab\(/.test(body), 'updateAgeTab呼び出しが消失しています');
  assert.ok(/updateTownStatsTab\(/.test(body), 'updateTownStatsTab呼び出しが消失しています');
});

test('配線: updateLifeTabがselectedLifePointを設定すること', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'updateLifeTab');
  assert.ok(body, 'updateLifeTab関数が見つかりません');
  assert.ok(/selectedLifePoint\s*=/.test(body), 'updateLifeTab内でselectedLifePointが設定されていません');
});

test('配線: updateLifeTabがrefreshLifeTabDataとrunNearbySearchを呼ぶこと', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'updateLifeTab');
  assert.ok(/refreshLifeTabData\(/.test(body));
  assert.ok(/runNearbySearch\(/.test(body));
});

test('配線: closePropCard内でselectedLifePointがnullにリセットされること', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'closePropCard');
  assert.ok(body, 'closePropCard関数が見つかりません');
  assert.ok(/selectedLifePoint\s*=\s*null/.test(body),
    'closePropCard内でselectedLifePointがnullにリセットされていません');
});

test('配線: FacilityDataStore.onReadyにselectedLifePoint依存の再描画コールバックが登録されていること', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  // FacilityDataStore.onReady(...) の呼び出しのうち、selectedLifePointを参照し
  // refreshLifeTabDataとrunNearbySearchを呼ぶものが少なくとも1つ存在することを確認する。
  const onReadyBlocks = [...html.matchAll(/FacilityDataStore\.onReady\(\(\)\s*=>\s*\{[\s\S]*?\}\);/g)]
    .map(m => m[0]);
  const found = onReadyBlocks.some(block =>
    /selectedLifePoint/.test(block) &&
    /refreshLifeTabData\(/.test(block) &&
    /runNearbySearch\(/.test(block)
  );
  assert.ok(found, 'selectedLifePointを参照してrefreshLifeTabData/runNearbySearchを呼ぶonReadyコールバックが見つかりません');
});

test('配線: selectBuildingがupdateLifeTab呼び出し前にh.dを使用していること(建物Aから建物Bへの切替で基準点が更新される設計)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'selectBuilding');
  // updateLifeTab(h.d) という形で呼ばれていることを確認(引数が選択建物そのもの)
  assert.ok(/updateLifeTab\(\s*h\.d\s*\)/.test(body),
    'updateLifeTabがh.d(選択建物データ)を引数に呼ばれていません。建物切替時の基準点更新が保証されません');
});

test('配線: refreshLifeTabDataがFacilityDataStore.getState()でloading/readyを判別すること(データ読込中表示)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'refreshLifeTabData');
  assert.ok(body, 'refreshLifeTabData関数が見つかりません');
  assert.ok(/loading/.test(body), 'loading状態の判定が見当たりません');
  assert.ok(/読込中/.test(body), '「データ読込中」相当の表示テキストが見当たりません');
});

test('回帰: HTML全体のJavaScript構文が引き続き正しいこと(node --check)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.ok(matches.length > 0, '<script>タグが見つかりません');
  const scriptBody = matches[matches.length - 1][1];
  const tmpPath = path.join('/tmp', `wiring-check-${Date.now()}.js`);
  writeFileSync(tmpPath, scriptBody, 'utf-8');
  assert.doesNotThrow(() => {
    execSync(`node --check ${tmpPath}`, { stdio: 'pipe' });
  }, 'HTML内のJavaScriptに構文エラーがあります');
});
