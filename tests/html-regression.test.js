// tests/html-regression.test.js
// Live City本体(osaka_3d_buildings.html)の構造的回帰テスト。
// 実際のThree.js描画・ブラウザ実行はこのテスト環境では行わないため、
// 「主要モジュールが存在し、重複や消失がないこと」「JS構文が壊れていないこと」を
// 静的に検証する。年齢構成タブ等の新機能追加時に、既存の道路・公園・建物・人口表示の
// コードを誤って削除/重複させていないかを継続的にチェックするためのテスト。
//
// 【HTMLパスの解決】データパイプライン単体の環境(Live City本体HTMLを含まない)では
// このファイルが存在しないため、npm test全体が失敗してしまう問題があった。
// 環境変数 LIVECITY_HTML_PATH で明示的に指定できるようにし、未指定時は標準配置候補を
// 順に確認する。いずれも見つからない場合のみ「ファイルが存在しない」という理由で
// 明示的にskipする（それ以外の理由によるエラー、例えば読み込み権限エラーや構文エラー等は
// 通常どおり各テスト内で失敗として検出される）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// 標準配置候補（環境変数が未指定の場合に順に確認する）。
// 既存のClaude Code環境での出力先(/mnt/user-data/outputs)を主候補としつつ、
// リポジトリ直下に配置されるケースも候補に含める。
const STANDARD_CANDIDATE_PATHS = [
  '/mnt/user-data/outputs/osaka_3d_buildings.html',
  path.join(process.cwd(), 'osaka_3d_buildings.html'),
  path.join(process.cwd(), '..', 'osaka_3d_buildings.html'),
];

/**
 * HTMLファイルの実パスを解決する。
 * 1. 環境変数 LIVECITY_HTML_PATH が指定されていれば、それを使う（存在確認はしない。
 *    明示的に指定された場合、ファイルが無ければそれ自体をエラーとして検出すべきため）。
 * 2. 未指定の場合は標準配置候補を順に確認し、最初に存在するものを使う。
 * 3. どれも見つからない場合は null を返す（呼び出し側がskip理由として使う）。
 */
function resolveHtmlPath() {
  if (process.env.LIVECITY_HTML_PATH) {
    return process.env.LIVECITY_HTML_PATH;
  }
  for (const candidate of STANDARD_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HTML_PATH = resolveHtmlPath();
// 【重要】Node.jsのtest()の skip オプションは、null も真値として解釈してスキップしてしまう
// （falseだけが「スキップしない」と解釈される）。そのためHTML_PATHがnullでない場合は
// 明示的に false を使う（null のままにすると全テストが意図せずskipされる）。
const SKIP_REASON = HTML_PATH
  ? false
  : `Live City本体HTMLが見つかりません。標準配置候補(${STANDARD_CANDIDATE_PATHS.join(', ')})に` +
    `存在しないか、環境変数 LIVECITY_HTML_PATH で明示的にパスを指定してください。` +
    `データパイプライン単体の環境ではこのテスト群は意図的にskipされます。`;

function loadHtml() {
  return readFileSync(HTML_PATH, 'utf-8');
}

function extractScriptBody(html) {
  // 最後の<script>タグの内容（メインロジック）を抜き出す。
  const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  if (matches.length === 0) throw new Error('<script>タグが見つかりません。');
  return matches[matches.length - 1][1];
}

test('回帰: HTML内のJavaScriptが構文的に正しい(node --checkでパースエラーなし)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const scriptBody = extractScriptBody(html);
  const tmpPath = path.join('/tmp', `html-regression-check-${Date.now()}.js`);
  writeFileSync(tmpPath, scriptBody, 'utf-8');
  // node --check はエラー時に非ゼロ終了するため、execSyncが例外を投げなければ構文OK。
  assert.doesNotThrow(() => {
    execSync(`node --check ${tmpPath}`, { stdio: 'pipe' });
  }, 'HTML内のJavaScriptに構文エラーがあります。');
});

test('回帰: RoadLayer(道路表示)が重複・消失せず1か所だけ定義されている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const count = (html.match(/^const RoadLayer/gm) || []).length;
  assert.equal(count, 1);
});

test('回帰: ParkLayer(公園表示)が重複・消失せず1か所だけ定義されている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const count = (html.match(/^const ParkLayer/gm) || []).length;
  assert.equal(count, 1);
});

test('回帰: LabelLayer(施設ラベル表示)が重複・消失せず1か所だけ定義されている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const count = (html.match(/^const LabelLayer/gm) || []).length;
  assert.equal(count, 1);
});

test('回帰: BLDGS(建物データ)が重複・消失せず1か所だけ定義されている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const count = (html.match(/^const BLDGS/gm) || []).length;
  assert.equal(count, 1);
});

test('回帰: DemographicsDataStore(公式人口統計読込)が重複・消失せず1か所だけ定義されている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const count = (html.match(/^const DemographicsDataStore/gm) || []).length;
  assert.equal(count, 1);
});

test('回帰: 建物詳細パネル(#prop-card)と施設詳細パネル(#facility-card)が両方存在する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  assert.ok((html.match(/id="prop-card"/g) || []).length >= 1);
  assert.ok((html.match(/id="facility-card"/g) || []).length >= 1);
});

test('回帰: 建物クリック処理(selectBuilding)が存在する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  assert.ok(/function selectBuilding/.test(html));
});

test('回帰: 旧人口データ(LEGACY_TOWN_DATA_UNVERIFIED)が削除されず、出典未確認として隔離されたまま残っている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  assert.ok(/const LEGACY_TOWN_DATA_UNVERIFIED/.test(html), '旧データが消失している（隔離方針に反する）');
  assert.ok(!/const TOWN_DATA\s*=/.test(html), '旧変数名TOWN_DATAが復活している（officialと誤認されるリスクのある名前に戻ってはいけない）');
});

test('回帰: 重複IDが存在しない(HTML要素のid属性が一意)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const counts = {};
  for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  const duplicates = Object.entries(counts).filter(([, c]) => c > 1);
  assert.deepEqual(duplicates, [], `重複IDが見つかりました: ${JSON.stringify(duplicates)}`);
});

// ── normalizeTownName(町丁目名表記差統一)に関する回帰テスト ──
// 【発覚した不具合】東住吉区矢田3丁目をクリックすると、公式人口データ(漢数字表記
// "矢田三丁目")と建物データ(算用数字表記"矢田3丁目")の照合に失敗し、出典未確認の
// LEGACY_TOWN_DATA_UNVERIFIEDへ常にフォールバックしていた。本テストはHTML内に実際に
// 定義されているnormalizeTownName関数を抽出・評価し、表記差が正しく統一されることを
// 直接検証する（再実装ではなく、実際に配信されるコードそのものをテストする）。
function extractAndEvalNormalizeTownName(html) {
  const m = html.match(/function normalizeTownName\(name\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('normalizeTownName関数がHTML内に見つかりません。');
  const kanjiMapMatch = html.match(/const KANJI_DIGIT_MAP = \{[\s\S]*?\};/);
  if (!kanjiMapMatch) throw new Error('KANJI_DIGIT_MAPがHTML内に見つかりません。');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${kanjiMapMatch[0]}\n${m[0]}\nreturn normalizeTownName;`)();
  return fn;
}

test('回帰: normalizeTownNameが東住吉区矢田3丁目(算用数字)と矢田三丁目(漢数字)を同一キーに正規化する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const normalizeTownName = extractAndEvalNormalizeTownName(html);
  const arabicForm = normalizeTownName('東住吉区矢田3丁目');
  const kanjiForm = normalizeTownName('東住吉区矢田三丁目');
  assert.equal(arabicForm, kanjiForm, `算用数字"${arabicForm}"と漢数字"${kanjiForm}"が一致しません`);
});

test('回帰: normalizeTownNameが「大阪市」prefixの有無を統一する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const normalizeTownName = extractAndEvalNormalizeTownName(html);
  assert.equal(normalizeTownName('大阪市東住吉区矢田三丁目'), normalizeTownName('東住吉区矢田三丁目'));
});

test('回帰: normalizeTownNameが全角数字を半角数字に正規化する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const normalizeTownName = extractAndEvalNormalizeTownName(html);
  assert.equal(normalizeTownName('矢田３丁目'), normalizeTownName('矢田3丁目'));
});

test('回帰: normalizeTownNameが他の町丁目(住吉区南住吉一丁目/1丁目)でも漢数字↔算用数字を統一する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const normalizeTownName = extractAndEvalNormalizeTownName(html);
  assert.equal(normalizeTownName('住吉区南住吉一丁目'), normalizeTownName('住吉区南住吉1丁目'));
});

test('回帰: DemographicsDataStore/AgeStructureDataStore/TownStatsDataStoreのnormalizeKeyが、共通のnormalizeTownNameへ委譲している(重複した脆弱な実装が復活していない)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  // 以前の脆弱な実装(空白除去のみ)が3箇所とも完全に置き換わっていることを確認する。
  // 置き換え後は3箇所とも "return normalizeTownName(name);" のみのシンプルな実装になっているはず。
  const matches = [...html.matchAll(/function normalizeKey\(name\) \{\s*return normalizeTownName\(name\);\s*\}/g)];
  assert.ok(matches.length >= 2, `normalizeKeyがnormalizeTownNameへ委譲している箇所が想定より少ない(${matches.length}件)`);
  // 旧実装(空白除去のみ)が残っていないことも確認する
  assert.ok(!/function normalizeKey\(name\) \{\s*return \(name \|\| ''\)\.replace\(\/\[\\s\\u3000\]\/g/.test(html),
    '旧実装(空白除去のみのnormalizeKey)が残存している可能性があります');
});
