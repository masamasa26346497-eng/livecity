// tests/mission-36d-exact-highlight.test.js
// Mission 36D: 選択/ホバー双方のexact-geometryハイライトを、全selectable building sourceへ
// 一般化した部分の検証。
//
// 36Cはcanonical merged mesh(crTriBuilding+bi)の選択(クリック)だけをexact-triangle化したが、
// 36Dではさらに次を追加する:
//   - hover も同じexact-geometry経路を通す(footprint再押し出しへ絶対に戻さない)
//   - 'ranges'方式: PLATEAU高LOD(BuildingLODLayer)。1 tile内の複数kindバケットmeshに跨る
//     index range から対象建物だけを集める
//   - 'meshList'方式: 1棟=1mesh(またはmaterial別の少数mesh)をまるごと複製(LandmarkHD/35S点群LOD2)
//   - 'legacyVertexTri'方式: 旧bMesh(buildingIndex頂点属性)
//   - source meshにtransform(matrixWorld)があってもoverlayがworld座標へ正しく追従すること
//
// 既存のtests/exact-triangle-highlight.test.jsと同じ方針: 実際に配信されるHTML
// (public/osaka_3d_buildings.ward-ux-v1.html)内の実装済み関数を静的に取り出して実行する
// (再実装ではなく実コードを検証する)。THREE.js/DOMには依存しない純粋関数として実装している
// ため、node --testの環境だけで実行できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

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

const FN_NAMES = [
  'crExactTriangleIndices',
  'crBuildBiTriIndex',
  'crGetBiTriIndex',
  'crApplyMatrix4',
  'extractExactBuildingGeometry',
  'extractExactRangeGeometry',
  'extractWholeMeshGeometry',
  'extractMeshListGeometry',
  'extractLegacyVertexTriGeometry',
  'resolveExactTriSource',
];

function loadMission36DHelpers() {
  const html = loadHtml();
  const bodies = FN_NAMES.map((name) => {
    const body = extractFunctionBody(html, name);
    assert.ok(body, `${name}関数が見つかりません`);
    return body;
  });
  const factory = new Function(`${bodies.join('\n')}\nreturn { ${FN_NAMES.join(', ')} };`);
  return factory();
}

// non-indexed BufferGeometryのモック(実際のCanonicalRuntime/Umeda merged meshと同じ形)。
function mockNonIndexedGeometry(flatPositions, extraAttrs) {
  return {
    index: null,
    getAttribute(name) {
      if (name === 'position') {
        return {
          count: flatPositions.length,
          getX: (i) => flatPositions[i][0],
          getY: (i) => flatPositions[i][1],
          getZ: (i) => flatPositions[i][2],
        };
      }
      if (extraAttrs && extraAttrs[name]) return extraAttrs[name];
      return null;
    },
  };
}

// indexed BufferGeometryのモック。indexMap[i] = 実頂点index。
function mockIndexedGeometry(flatPositions, indexMap, extraAttrs) {
  return {
    index: { count: indexMap.length, getX: (i) => indexMap[i] },
    getAttribute(name) {
      if (name === 'position') {
        return {
          count: flatPositions.length,
          getX: (i) => flatPositions[i][0],
          getY: (i) => flatPositions[i][1],
          getZ: (i) => flatPositions[i][2],
        };
      }
      if (extraAttrs && extraAttrs[name]) return extraAttrs[name];
      return null;
    },
  };
}

// buildingIndex(頂点ごと。legacy bMesh方式)属性のモック。
function mockBuildingIndexAttr(values) {
  return { getX: (i) => values[i] };
}

test('crApplyMatrix4: 単位行列では座標をそのまま通す', { skip: SKIP_REASON }, () => {
  const { crApplyMatrix4 } = loadMission36DHelpers();
  const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  assert.deepEqual(crApplyMatrix4(identity, 3, 4, 5), [3, 4, 5]);
});

test('crApplyMatrix4: 平行移動+スケールを含む行列を正しく適用する(THREE.Matrix4.elements同一レイアウト)', { skip: SKIP_REASON }, () => {
  const { crApplyMatrix4 } = loadMission36DHelpers();
  // スケール2倍 + 平行移動(10,20,30)。THREE.Matrix4.elementsは列優先。
  const m = [2,0,0,0,  0,2,0,0,  0,0,2,0,  10,20,30,1];
  assert.deepEqual(crApplyMatrix4(m, 1, 1, 1), [12, 22, 32]);
});

test('extractExactBuildingGeometry: mesh.matrixWorldが無ければ従来通りローカル座標をそのまま返す(36C互換)', { skip: SKIP_REASON }, () => {
  const { extractExactBuildingGeometry } = loadMission36DHelpers();
  const flat = [[0,0,0],[1,0,0],[1,0,1]];
  const mesh = { userData: { crTriBuilding: [0], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(flat) };
  const r = extractExactBuildingGeometry(mesh, 0);
  assert.deepEqual(Array.from(r.positions), flat.flat());
});

test('extractExactBuildingGeometry: mesh.matrixWorldがあればworld座標へ変換してから返す(§6)', { skip: SKIP_REASON }, () => {
  const { extractExactBuildingGeometry } = loadMission36DHelpers();
  const flat = [[0,0,0],[1,0,0],[1,0,1]];
  const mesh = {
    userData: { crTriBuilding: [0], crTriEmpty: 65535 },
    geometry: mockNonIndexedGeometry(flat),
    matrixWorld: { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 100,0,0,1] }, // x方向に+100
  };
  const r = extractExactBuildingGeometry(mesh, 0);
  assert.deepEqual(Array.from(r.positions), [100,0,0, 101,0,0, 101,0,1]);
});

test('extractExactRangeGeometry: 同じ建物のroof/wallが別バケットmeshに分かれていても両方まとめて集める', { skip: SKIP_REASON }, () => {
  const { extractExactRangeGeometry } = loadMission36DHelpers();
  // roofバケット: 建物Aのtriangle1枚 + 建物Bのtriangle1枚(index空間で連続)
  const roofFlat = [[0,10,0],[1,10,0],[1,10,1],  [5,10,5],[6,10,5],[6,10,6]];
  const roofMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }, { start: 3, count: 3, canonicalId: 'B' }] } },
    geometry: mockIndexedGeometry(roofFlat, [0,1,2,3,4,5]),
  };
  // wallバケット: 建物Aのtriangle1枚だけ
  const wallFlat = [[0,0,0],[1,0,0],[0,10,0]];
  const wallMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }] } },
    geometry: mockIndexedGeometry(wallFlat, [0,1,2]),
  };
  // groundバケット: 建物Aとは無関係(混入していないことの検証用)
  const groundMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'C' }] } },
    geometry: mockIndexedGeometry([[9,0,9],[9,0,9],[9,0,9]], [0,1,2]),
  };
  const tileGroup = { children: [roofMesh, wallMesh, groundMesh] };
  const r = extractExactRangeGeometry(tileGroup, 'A');
  assert.ok(r, '建物Aのexact geometryが取れませんでした');
  assert.equal(r.triCount, 2, 'roof 1枚 + wall 1枚 = 2枚のはず');
  // 検証: 建物B(roofバケットの後半)やC(groundバケット)の座標が1つも混ざっていないこと
  const flatOut = Array.from(r.positions);
  assert.deepEqual(flatOut, [...roofFlat.slice(0, 3).flat(), ...wallFlat.flat()]);
});

test('extractExactRangeGeometry: 対象canonicalIdのrangeが1つも無ければnullを返す', { skip: SKIP_REASON }, () => {
  const { extractExactRangeGeometry } = loadMission36DHelpers();
  const mesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'X' }] } },
    geometry: mockIndexedGeometry([[0,0,0],[1,0,0],[1,0,1]], [0,1,2]),
  };
  assert.equal(extractExactRangeGeometry({ children: [mesh] }, 'not-found'), null);
});

test('extractWholeMeshGeometry: indexed/non-indexedの両方でmeshの全ジオメトリをworld座標でコピーする', { skip: SKIP_REASON }, () => {
  const { extractWholeMeshGeometry } = loadMission36DHelpers();
  const flat = [[0,0,0],[1,0,0],[1,0,1],[0,0,1]];
  const nonIndexed = { geometry: mockNonIndexedGeometry(flat.slice(0, 3)) };
  const r1 = extractWholeMeshGeometry(nonIndexed);
  assert.equal(r1.triCount, 1);
  assert.deepEqual(Array.from(r1.positions), flat.slice(0, 3).flat());

  const indexed = { geometry: mockIndexedGeometry(flat, [0,1,2, 0,2,3]) };
  const r2 = extractWholeMeshGeometry(indexed);
  assert.equal(r2.triCount, 2);
});

test('extractMeshListGeometry: 複数meshの座標を1本のFloat32Arrayへ連結する(LandmarkHDの複数部材を想定)', { skip: SKIP_REASON }, () => {
  const { extractMeshListGeometry } = loadMission36DHelpers();
  const roofMesh = { geometry: mockNonIndexedGeometry([[0,10,0],[1,10,0],[1,10,1]]) };
  const wallMesh = { geometry: mockNonIndexedGeometry([[0,0,0],[1,0,0],[0,10,0]]) };
  const r = extractMeshListGeometry([roofMesh, wallMesh]);
  assert.equal(r.triCount, 2);
  assert.equal(r.positions.length, 2 * 9);
});

test('extractMeshListGeometry: 空配列やジオメトリ無しmeshはnullを返す(空overlayを描かせない)', { skip: SKIP_REASON }, () => {
  const { extractMeshListGeometry } = loadMission36DHelpers();
  assert.equal(extractMeshListGeometry([]), null);
  assert.equal(extractMeshListGeometry([{ geometry: null }]), null);
});

test('extractLegacyVertexTriGeometry: buildingIndex頂点属性から対象建物の三角形だけを抽出する(旧bMesh方式)', { skip: SKIP_REASON }, () => {
  const { extractLegacyVertexTriGeometry } = loadMission36DHelpers();
  // triangle0(頂点0,1,2)=建物5 / triangle1(頂点3,4,5)=建物9
  const flat = [[0,0,0],[1,0,0],[1,0,1],  [9,0,9],[9,0,9],[9,0,9]];
  const biValues = [5,5,5, 9,9,9];
  const mesh = {
    geometry: mockNonIndexedGeometry(flat, { buildingIndex: mockBuildingIndexAttr(biValues) }),
  };
  const r = extractLegacyVertexTriGeometry(mesh, 5);
  assert.equal(r.triCount, 1);
  assert.deepEqual(Array.from(r.positions), flat.slice(0, 3).flat());
  assert.equal(extractLegacyVertexTriGeometry(mesh, 999), null);
});

test('crBuildBiTriIndex: crExactTriangleIndicesの全biを一度に求めたMapと一致する(§11 キャッシュ基盤)', { skip: SKIP_REASON }, () => {
  const { crExactTriangleIndices, crBuildBiTriIndex } = loadMission36DHelpers();
  const triBuilding = [0, 1, 1, 0, 2, 2, 0, 65535, 1];
  const map = crBuildBiTriIndex(triBuilding, 65535);
  for (const bi of [0, 1, 2]) {
    assert.deepEqual(map.get(bi), crExactTriangleIndices(triBuilding, bi, 65535), `bi=${bi}の抽出結果が一致しません`);
  }
  assert.equal(map.has(65535), false, '欠損分類(emptyValue)はMapに含まれてはいけません');
});

test('crGetBiTriIndex: 同じmeshへの2回目の呼び出しはキャッシュ(同じMap参照)を再利用する(§11 pointermove性能)', { skip: SKIP_REASON }, () => {
  const { crGetBiTriIndex } = loadMission36DHelpers();
  const triBuilding = [0, 1, 1, 0];
  const mesh = { userData: {} };
  const map1 = crGetBiTriIndex(mesh, triBuilding, 65535);
  const map2 = crGetBiTriIndex(mesh, triBuilding, 65535);
  assert.equal(map1, map2, '同一meshかつ同一crTriBuilding参照なら再スキャンせずキャッシュを返すはず');
  assert.deepEqual(map1.get(1), [1, 2]);

  // triBuilding配列の参照自体が変わった(=geometry再構築)場合は新しいMapを作り直す
  const rebuiltTriBuilding = [2, 2];
  const map3 = crGetBiTriIndex(mesh, rebuiltTriBuilding, 65535);
  assert.notEqual(map3, map1, 'crTriBuilding参照が変わったら古いキャッシュを使ってはいけません');
  assert.deepEqual(map3.get(2), [0, 1]);
});

test('extractExactBuildingGeometry: 同一meshで異なるbiを連続抽出しても、それぞれ正しい三角形だけを返す(キャッシュ経路の検証)', { skip: SKIP_REASON }, () => {
  const { extractExactBuildingGeometry } = loadMission36DHelpers();
  const flat = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1],       // triangle0 → 建物0
    [10, 0, 10], [11, 0, 10], [11, 0, 11], // triangle1 → 建物1
    [10, 3, 10], [11, 3, 10], [11, 3, 11], // triangle2 → 建物1
  ];
  const mesh = { userData: { crTriBuilding: [0, 1, 1], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(flat) };

  const first = extractExactBuildingGeometry(mesh, 1);
  assert.equal(first.triCount, 2);
  assert.deepEqual(Array.from(first.positions), flat.slice(3).flat());

  // 1回目の呼び出しでmesh.userDataにキャッシュが構築されているはず
  assert.ok(mesh.userData.crBiTriIndex, 'crBiTriIndexキャッシュが構築されていません');

  // キャッシュ構築後に別のbiを抽出しても、他棟の三角形を混ぜずに正しく取れること
  const second = extractExactBuildingGeometry(mesh, 0);
  assert.equal(second.triCount, 1);
  assert.deepEqual(Array.from(second.positions), flat.slice(0, 3).flat());
});

test('resolveExactTriSource: kind別に正しい抽出関数へ振り分ける', { skip: SKIP_REASON }, () => {
  const { resolveExactTriSource } = loadMission36DHelpers();
  assert.equal(resolveExactTriSource(null), null);
  assert.equal(resolveExactTriSource({ kind: 'unknown-kind' }), null);

  const triMesh = { userData: { crTriBuilding: [0], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry([[0,0,0],[1,0,0],[1,0,1]]) };
  assert.ok(resolveExactTriSource({ kind: 'tri', mesh: triMesh, bi: 0 }), 'tri kindが解決できません');

  // 後方互換: kind省略(36C由来)
  assert.ok(resolveExactTriSource({ mesh: triMesh, bi: 0 }), 'kind省略時の後方互換が壊れています');

  const meshListSrc = { meshes: [{ geometry: mockNonIndexedGeometry([[0,0,0],[1,0,0],[1,0,1]]) }] };
  assert.ok(resolveExactTriSource({ kind: 'meshList', ...meshListSrc }), 'meshList kindが解決できません');

  const rangesMesh = { userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }] } }, geometry: mockIndexedGeometry([[0,0,0],[1,0,0],[1,0,1]], [0,1,2]) };
  assert.ok(resolveExactTriSource({ kind: 'ranges', tileGroup: { children: [rangesMesh] }, canonicalId: 'A' }), 'ranges kindが解決できません');

  const legacyMesh = { geometry: mockNonIndexedGeometry([[0,0,0],[1,0,0],[1,0,1]], { buildingIndex: mockBuildingIndexAttr([7,7,7]) }) };
  assert.ok(resolveExactTriSource({ kind: 'legacyVertexTri', mesh: legacyMesh, bi: 7 }), 'legacyVertexTri kindが解決できません');
});
