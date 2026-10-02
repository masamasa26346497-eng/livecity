// tests/picking-visibility.test.js
// [AutoDev P0-2] WARM/picking調査: 非表示(hide()済み/loaded-hidden)なタイルのメッシュが
// raycast(pickHit)対象から除外されない問題の再現テスト、および修正後の挙動の確認。
//
// 【背景】public/osaka_3d_buildings.ward-ux-v1.html のBuildingTileLayerでは、
// tile.hide()はmesh.visible=falseにするのみでbMesh配列からは除去しない(dispose()時のみ除去)。
// three.jsのRaycaster.intersectObjects()はmesh.visible=falseでも自動除外しないため、
// pickHit()がhits[0](最も近いヒット)をそのまま採用すると、画面に描画されていない
// (hide()済みの)建物のジオメトリが、実際に見えている建物より手前で当たり判定されうる。
//
// 【方針】ブラウザ・Three.jsを実際には起動できない環境のため、HTMLからpickHit/
// resolveBuildingFromHitの関数ソースをそのまま抽出し、Raycasterを差し替えて
// (visible:falseなメッシュを含む複数ヒットを返すモック)実際に評価・実行する。
// 再実装ではなく、実際に配信されるコードそのものをテストする(tests/ward-lifecycle.test.jsと同じ考え方)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const STANDARD_CANDIDATE_PATHS = [
  path.join(process.cwd(), 'public', 'osaka_3d_buildings.ward-ux-v1.html'),
  path.join(process.cwd(), '..', 'public', 'osaka_3d_buildings.ward-ux-v1.html'),
];

function resolveHtmlPath() {
  if (process.env.LIVECITY_WARD_HTML_PATH) return process.env.LIVECITY_WARD_HTML_PATH;
  for (const candidate of STANDARD_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HTML_PATH = resolveHtmlPath();
const SKIP_REASON = HTML_PATH
  ? false
  : `Ward UX検証用HTML(osaka_3d_buildings.ward-ux-v1.html)が見つかりません。標準配置候補(` +
    `${STANDARD_CANDIDATE_PATHS.join(', ')})に存在しないか、環境変数 LIVECITY_WARD_HTML_PATH で` +
    `明示的にパスを指定してください。`;

function loadHtml() {
  return readFileSync(HTML_PATH, 'utf-8');
}

function findMatchingBrace(str, openIdx) {
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    const next = str[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`対応する'}'が見つかりません(開始index=${openIdx})`);
}

function extractFunctionDecl(html, fnName, fromIdx = 0) {
  const marker = `function ${fnName}(`;
  const startIdx = html.indexOf(marker, fromIdx);
  if (startIdx === -1) throw new Error(`"${marker}" がHTML内に見つかりません`);
  const braceIdx = html.indexOf('{', startIdx);
  const closeIdx = findMatchingBrace(html, braceIdx);
  return html.slice(startIdx, closeIdx + 1);
}

// 建物用の pickHit(グローバルスコープの方。FacilityLayer/LabelLayer内のpickHitとは別物で、
// 引数が pickHit(e) の1引数版のみが対象)を抽出する。
function extractBuildingPickHit(html) {
  const marker = 'function pickHit(e){';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error(`"${marker}" がHTML内に見つかりません(建物用pickHitの想定シグネチャと異なる可能性)`);
  const braceIdx = html.indexOf('{', startIdx);
  const closeIdx = findMatchingBrace(html, braceIdx);
  return html.slice(startIdx, closeIdx + 1);
}

function loadPickModules(html) {
  const pickHitSrc = extractBuildingPickHit(html);
  const resolveSrc = extractFunctionDecl(html, 'resolveBuildingFromHit');
  return new Function(
    'ray', 'mouse', 'camera', 'innerWidth', 'innerHeight', 'bMesh', 'BLDGS',
    `'use strict';\n${pickHitSrc}\n${resolveSrc}\nreturn pickHit;`,
  );
}

// buildingIndex頂点属性・faceIndexから建物を逆引きするresolveBuildingFromHit()互換のモックhitを作る。
function makeHit({ visible, buildingIndex }) {
  return {
    object: {
      visible,
      geometry: {
        getAttribute(name) {
          if (name !== 'buildingIndex') return null;
          return { getX: () => buildingIndex };
        },
      },
    },
    faceIndex: 0,
  };
}

function buildPickHit(html, hitsToReturn) {
  const pickHit = loadPickModules(html)(
    { setFromCamera() {}, intersectObjects: () => hitsToReturn },
    {},
    {},
    1920, 1080,
    [],
    [{ id: 'hidden-building' }, { id: 'visible-building' }],
  );
  return pickHit;
}

test('pickHit: hide()済み(非表示)メッシュへの近いヒットより、visibleなメッシュへのヒットを優先する', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  // hits[0]は非表示(loaded-hidden)タイルの建物(index 0)、hits[1]は画面に見えている建物(index 1)。
  // three.jsのRaycasterはvisible=falseでも自動除外しないため、この順序のヒットは実際に起こりうる
  // (hide()はmesh.visible=falseにするのみでbMeshからは除去されないため)。
  const hits = [
    makeHit({ visible: false, buildingIndex: 0 }),
    makeHit({ visible: true, buildingIndex: 1 }),
  ];
  const pickHit = buildPickHit(html, hits);

  const result = pickHit({ clientX: 100, clientY: 100 });

  assert.ok(result, 'visibleな建物へのヒットがあるにもかかわらずnullが返った');
  assert.equal(result.d.id, 'visible-building', '非表示メッシュ(hits[0])が優先して選択されてはいけない');
});

test('pickHit: 全てのヒットが非表示メッシュの場合はnullを返す(見えている建物が無いのに選択されない)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const hits = [
    makeHit({ visible: false, buildingIndex: 0 }),
    makeHit({ visible: false, buildingIndex: 0 }),
  ];
  const pickHit = buildPickHit(html, hits);

  const result = pickHit({ clientX: 100, clientY: 100 });

  assert.equal(result, null, '画面上に見えている建物が無い場合はnullが返るべき');
});

test('pickHit: ヒットが無い場合はnullを返す(既存挙動)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const pickHit = buildPickHit(html, []);

  const result = pickHit({ clientX: 100, clientY: 100 });

  assert.equal(result, null);
});

test('pickHit: 最初のヒットがvisibleな場合は従来どおりそれを返す(既存挙動の維持)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const hits = [
    makeHit({ visible: true, buildingIndex: 1 }),
    makeHit({ visible: false, buildingIndex: 0 }),
  ];
  const pickHit = buildPickHit(html, hits);

  const result = pickHit({ clientX: 100, clientY: 100 });

  assert.ok(result);
  assert.equal(result.d.id, 'visible-building');
});
