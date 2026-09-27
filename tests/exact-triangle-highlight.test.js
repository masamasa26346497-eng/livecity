// tests/exact-triangle-highlight.test.js
// Mission 36C: 選択ハイライトのexact-triangle抽出ロジックの検証。
//
// 36Bまでの選択ハイライトは building.fp/z0/dz からの footprint 再押し出しだったが、
// これは picking(35Y: hit.faceIndex → crTriBuilding → 建物index)が使う三角形分割とは
// 別物の形状再構成であり、隣接/付帯形状まで覆って見える不一致があった。36Cでは
// pickingが特定した merged mesh の実三角形を crTriBuilding[t] === bi の条件だけで
// 抽出してそのまま描く方式に置き換えている。
//
// ここでは実際に配信されるHTML(public/osaka_3d_buildings.ward-ux-v1.html)内の
// crExactTriangleIndices / extractExactBuildingGeometry を静的に取り出し、
// 実装済みの関数そのものを実行して検証する(再実装ではなく実コードを検証する。
// 既存のhtml-regression.test.js等と同じ方針)。THREE.js/DOMには依存しない純粋関数として
// 実装しているため、node --testの環境だけで実行できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// [Mission 36C §11] 対象は public/osaka_3d_buildings.ward-ux-v1.html のみ。
// osaka_3d_buildings.html(production/protected)は変更していないため対象に含めない。
const HTML_PATH = path.join(process.cwd(), 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const SKIP_REASON = existsSync(HTML_PATH)
  ? false
  : `対象HTML(${HTML_PATH})が見つかりません。`;

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

/** crExactTriangleIndices と extractExactBuildingGeometry を実HTMLから取り出し、実行可能にする。 */
function loadExactTriangleHelpers() {
  const html = loadHtml();
  const indicesFn = extractFunctionBody(html, 'crExactTriangleIndices');
  const extractFn = extractFunctionBody(html, 'extractExactBuildingGeometry');
  assert.ok(indicesFn, 'crExactTriangleIndices関数が見つかりません');
  assert.ok(extractFn, 'extractExactBuildingGeometry関数が見つかりません');
  const factory = new Function(`${indicesFn}\n${extractFn}\nreturn { crExactTriangleIndices, extractExactBuildingGeometry };`);
  return factory();
}

// non-indexed BufferGeometryのモック(実際のCanonicalRuntime buildingsメッシュと同じ形)。
// flatPositions: [[x,y,z], ...] を頂点indexの並びどおりに渡す。
function mockNonIndexedGeometry(flatPositions) {
  return {
    index: null,
    getAttribute(name) {
      if (name !== 'position') return null;
      return {
        getX: (i) => flatPositions[i][0],
        getY: (i) => flatPositions[i][1],
        getZ: (i) => flatPositions[i][2],
      };
    },
  };
}

// indexed BufferGeometryのモック。indexMap[i] = 実頂点index。
function mockIndexedGeometry(flatPositions, indexMap) {
  return {
    index: { getX: (i) => indexMap[i] },
    getAttribute(name) {
      if (name !== 'position') return null;
      return {
        getX: (i) => flatPositions[i][0],
        getY: (i) => flatPositions[i][1],
        getZ: (i) => flatPositions[i][2],
      };
    },
  };
}

test('crExactTriangleIndices: 対象biの三角形indexだけを、他棟を混ぜずに抽出する', { skip: SKIP_REASON }, () => {
  const { crExactTriangleIndices } = loadExactTriangleHelpers();
  // 三角形0,3,6が建物0、1,2が建物1、4,5が建物2、7は欠損(65535=empty)というbucketを想定
  const triBuilding = [0, 1, 1, 0, 2, 2, 0, 65535];
  const result = crExactTriangleIndices(triBuilding, 1, 65535);
  assert.deepEqual(result, [1, 2], '建物1に属する三角形indexが一致しません');
  // 検証: 抽出後のtriangle数は、crTriBuilding内の対象bi出現数と一致すること
  const expectedCount = triBuilding.filter((v) => v === 1).length;
  assert.equal(result.length, expectedCount, '抽出数がbi出現数と一致しません');
  // 検証: 隣接建物(0, 2)や欠損(65535)のtriangle indexが1枚も混ざっていないこと
  for (const t of result) assert.notEqual(triBuilding[t], 0, '建物0の三角形が混入しています');
  for (const t of result) assert.notEqual(triBuilding[t], 2, '建物2の三角形が混入しています');
  for (const t of result) assert.notEqual(triBuilding[t], 65535, '欠損分類の三角形が混入しています');
});

test('crExactTriangleIndices: emptyValueと同じbiやnull/undefinedなtriBuildingは空配列を返す', { skip: SKIP_REASON }, () => {
  const { crExactTriangleIndices } = loadExactTriangleHelpers();
  assert.deepEqual(crExactTriangleIndices([0, 1, 65535], 65535, 65535), []);
  assert.deepEqual(crExactTriangleIndices(null, 1, 65535), []);
  assert.deepEqual(crExactTriangleIndices([0, 1], null, 65535), []);
});

test('extractExactBuildingGeometry: non-indexed meshから対象建物の頂点だけを、元meshと完全に同じ座標でコピーする', { skip: SKIP_REASON }, () => {
  const { extractExactBuildingGeometry } = loadExactTriangleHelpers();
  // 建物0: triangle0 (頂点0,1,2) / 建物1: triangle1,2 (頂点3..8)
  const flat = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1],       // triangle0 → 建物0
    [10, 0, 10], [11, 0, 10], [11, 0, 11], // triangle1 → 建物1
    [10, 3, 10], [11, 3, 10], [11, 3, 11], // triangle2 → 建物1
  ];
  const mesh = {
    userData: { crTriBuilding: [0, 1, 1], crTriEmpty: 65535 },
    geometry: mockNonIndexedGeometry(flat),
  };

  const buildingOneResult = extractExactBuildingGeometry(mesh, 1);
  assert.ok(buildingOneResult, '抽出結果がnullです');
  // 検証: 抽出後のtriangle数はcrTriBuilding内のbi=1出現数(2)と一致する
  assert.equal(buildingOneResult.triCount, 2);
  assert.equal(buildingOneResult.positions.length, 2 * 9);
  // 検証: 元meshの頂点3..8とビット単位で完全一致すること(bbox/円/scale拡大等の再構成をしていないこと)。
  // 配列長・順序も含めた完全一致のため、建物0(triangle0/頂点0..2)の座標が1つでも
  // 混ざっていたり抜けていたりすれば、この時点でテストは失敗する。
  const expected = flat.slice(3).flat();
  assert.deepEqual(Array.from(buildingOneResult.positions), expected);

  const buildingZeroResult = extractExactBuildingGeometry(mesh, 0);
  assert.equal(buildingZeroResult.triCount, 1);
  assert.deepEqual(Array.from(buildingZeroResult.positions), flat.slice(0, 3).flat());
});

test('extractExactBuildingGeometry: indexed meshでもindex経由で正しい頂点を取り出す', { skip: SKIP_REASON }, () => {
  const { extractExactBuildingGeometry } = loadExactTriangleHelpers();
  // 頂点プールは共有され、indexが三角形→頂点を対応づける(indexed BufferGeometryの一般形)
  const flat = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1],    // pool 0,1,2 (建物0が使う)
    [5, 0, 5], [6, 0, 5], [6, 0, 6],    // pool 3,4,5 (建物1が使う)
  ];
  // triangle0(頂点0,1,2)=建物0 / triangle1(頂点3,4,5)=建物1
  const indexMap = [0, 1, 2, 3, 4, 5];
  const mesh = {
    userData: { crTriBuilding: [0, 1], crTriEmpty: 65535 },
    geometry: mockIndexedGeometry(flat, indexMap),
  };
  const result = extractExactBuildingGeometry(mesh, 1);
  assert.equal(result.triCount, 1);
  assert.deepEqual(Array.from(result.positions), flat.slice(3).flat());
});

test('extractExactBuildingGeometry: 対象biの三角形が0枚ならnullを返す(空のoverlayを描かせない)', { skip: SKIP_REASON }, () => {
  const { extractExactBuildingGeometry } = loadExactTriangleHelpers();
  const mesh = {
    userData: { crTriBuilding: [0, 0, 0], crTriEmpty: 65535 },
    geometry: mockNonIndexedGeometry([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]]),
  };
  assert.equal(extractExactBuildingGeometry(mesh, 99), null);
});
