// tests/mission-36e-full-surface-highlight.test.js
// Mission 36E: 「同じ1棟なのに壁の一部だけ色が付き、屋根や別の面が未選択のまま残る」
// (partial highlight)の根本修正を検証する。
//
// 36D は選択/ホバーのexact-geometryハイライトを全selectable building sourceへ一般化したが、
// 実機では次の2つの経路で「同じ建物なのに一部の面だけハイライトされない」ことが確認された:
//
//   (A) [§5] exact overlay の material が side: THREE.FrontSide 固定だった。実際の建物
//       material(crBuildingMaterial / LandmarkHDLayer / BuildingLODLayer / CustomLod2Layer)は
//       いずれも side: THREE.DoubleSide で描画されており、凹型/L字建物や壁面を裏側から見る
//       角度では、実際には見えている面がoverlay側だけ裏面カリングされて消えていた。
//       → makeExactOverlay が hl.fill.material を clone し、side だけ DoubleSide へ変える
//         ことで修正する(このファイルではHTML内の該当コードをテキストとして検証する。
//         THREE.js自体はこのテスト環境に無いため、実際のMesh/Materialは生成しない)。
//
//   (B) [§1/§3] 選択対象の「logical building」(=canonicalId)が、usageCategory等のbucket分け
//       やtile境界をまたぐことで複数mesh/tileGroupに分かれて描画されている場合、triSourceが
//       指す「hitした1 mesh/tileGroupだけ」を抽出すると、同じ建物の別fragment(別bucketの
//       roof/wall、隣接tileに分かれたfragment等)が欠落していた。
//       → tile/bucket mesh構築時にcanonicalId→fragment一覧の索引(crTriFragmentsById /
//         crRangeGroupsById)を作り、exact-geometry解決時にその索引から同一canonicalIdの
//         全fragmentをunionする(pointermoveごとの全scene走査はしない)。
//
// 既存のtests/mission-36d-exact-highlight.test.jsと同じ方針: 実際に配信されるHTML
// (public/osaka_3d_buildings.ward-ux-v1.html)内の実装済みコードを静的に取り出して実行/検証する。
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

/** 開始位置の正規表現(波括弧の直前まで)を渡して、本体(波括弧のバランスを取って抽出)を取り出す。 */
function extractFunctionBodyByStartPattern(html, startPattern) {
  const startMatch = html.match(startPattern);
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

/**
 * 指定した関数名の本体を取り出す。同名の関数が複数(別closure)存在する場合は最初の1件が
 * 返る点に注意(このファイル内では disposeTile のみ2箇所に存在するため、その検証には
 * extractFunctionBodyByStartPattern を直接シグネチャ込みで使う)。
 */
function extractFunctionBody(html, functionName) {
  return extractFunctionBodyByStartPattern(html, new RegExp(`function ${functionName}\\([^)]*\\)\\s*\\{`));
}

/** `const NAME = new Map();` 形式のモジュールスコープ宣言をそのまま取り出す。 */
function extractConstMapDecl(html, constName) {
  const m = html.match(new RegExp(`const ${constName} = new Map\\(\\);`));
  return m ? m[0] : null;
}

const FN_NAMES = [
  'extractExactBuildingGeometry',
  'extractExactRangeGeometry',
  'crRegisterTriFragments',
  'crUnregisterTriFragments',
  'crRegisterRangeGroup',
  'crUnregisterRangeGroup',
  'extractExactTriUnionGeometry',
  'extractExactRangeUnionGeometry',
  'resolveExactTriSource',
  // resolveExactTriSourceのdefault/legacy分岐やmeshList/legacyVertexTri分岐が参照する依存関数
  'extractMeshListGeometry',
  'extractWholeMeshGeometry',
  'extractLegacyVertexTriGeometry',
];
const CONST_NAMES = ['crTriFragmentsById', 'crRangeGroupsById'];

function loadMission36EHelpers() {
  const html = loadHtml();
  const decls = CONST_NAMES.map((name) => {
    const decl = extractConstMapDecl(html, name);
    assert.ok(decl, `${name}宣言が見つかりません`);
    return decl;
  });
  const bodies = FN_NAMES.map((name) => {
    const body = extractFunctionBody(html, name);
    assert.ok(body, `${name}関数が見つかりません`);
    return body;
  });
  const factory = new Function(
    `${decls.join('\n')}\n${bodies.join('\n')}\n` +
    `return { ${CONST_NAMES.join(', ')}, ${FN_NAMES.join(', ')} };`
  );
  return factory();
}

// non-indexed BufferGeometryのモック(実際のCanonicalRuntime/Umeda merged meshと同じ形)。
function mockNonIndexedGeometry(flatPositions) {
  return {
    index: null,
    getAttribute(name) {
      if (name !== 'position') return null;
      return {
        count: flatPositions.length,
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
    index: { count: indexMap.length, getX: (i) => indexMap[i] },
    getAttribute(name) {
      if (name !== 'position') return null;
      return {
        count: flatPositions.length,
        getX: (i) => flatPositions[i][0],
        getY: (i) => flatPositions[i][1],
        getZ: (i) => flatPositions[i][2],
      };
    },
  };
}

// ── (B) canonicalId→fragment索引の基本動作 ─────────────────────────────
test('crRegisterTriFragments: 同一canonicalIdが複数meshに分かれていても両方登録される(bucket/tile跨ぎを想定)', { skip: SKIP_REASON }, () => {
  const { crTriFragmentsById, crRegisterTriFragments } = loadMission36EHelpers();
  // deepEqualが参照ではなく構造で比較するため、{}同士の取り違えを検出できるよう識別用propertyを持たせる
  const meshRoof = { name: 'roofBucketMesh' };
  const meshWall = { name: 'wallBucketMesh' };
  // 建物Aがroof bucket(meshRoof, bi=2)とwall bucket(meshWall, bi=0)の2箇所に分かれているケース
  crRegisterTriFragments(meshRoof, [{ canonicalId: 'X' }, { canonicalId: 'A' }, { canonicalId: 'Y' }]);
  crRegisterTriFragments(meshWall, [{ canonicalId: 'A' }]);
  const frags = crTriFragmentsById.get('A');
  assert.equal(frags.length, 2, '建物Aは2つのmesh(roof/wall)にfragmentを持つはず');
  assert.deepEqual(frags, [{ mesh: meshRoof, bi: 1 }, { mesh: meshWall, bi: 0 }]);
});

test('crUnregisterTriFragments: 指定meshのfragmentだけを索引から取り除き、他meshの分は残す', { skip: SKIP_REASON }, () => {
  const { crTriFragmentsById, crRegisterTriFragments, crUnregisterTriFragments } = loadMission36EHelpers();
  const meshRoof = { name: 'roofBucketMesh' };
  const meshWall = { name: 'wallBucketMesh' };
  const roofFps = [{ canonicalId: 'A' }];
  const wallFps = [{ canonicalId: 'A' }];
  crRegisterTriFragments(meshRoof, roofFps);
  crRegisterTriFragments(meshWall, wallFps);
  assert.equal(crTriFragmentsById.get('A').length, 2);

  crUnregisterTriFragments(meshRoof, roofFps); // tile破棄でroof bucketだけ消えたケース
  const remaining = crTriFragmentsById.get('A');
  assert.equal(remaining.length, 1, 'wall側のfragmentは残るはず');
  assert.equal(remaining[0].mesh, meshWall);

  crUnregisterTriFragments(meshWall, wallFps); // 残りも消えたら索引からcanonicalId自体を削除する
  assert.equal(crTriFragmentsById.has('A'), false);
});

test('crRegisterRangeGroup/crUnregisterRangeGroup: tile境界をまたぐ建物のtileGroupを登録・解除できる', { skip: SKIP_REASON }, () => {
  const { crRangeGroupsById, crRegisterRangeGroup, crUnregisterRangeGroup } = loadMission36EHelpers();
  // deepEqualが参照ではなく構造で比較するため、{}同士の取り違えを検出できるよう識別用propertyを持たせる
  const tileGroup1 = { name: 'tileGroup1' };
  const tileGroup2 = { name: 'tileGroup2' };
  crRegisterRangeGroup('A', tileGroup1);
  crRegisterRangeGroup('A', tileGroup2);
  crRegisterRangeGroup('A', tileGroup1); // 同じtileGroupを二重登録しても増えない
  assert.deepEqual(crRangeGroupsById.get('A'), [tileGroup1, tileGroup2]);

  crUnregisterRangeGroup(tileGroup1, ['A', 'B']); // 'B'はこの索引に無くてもエラーにならない
  assert.deepEqual(crRangeGroupsById.get('A'), [tileGroup2]);

  crUnregisterRangeGroup(tileGroup2, ['A']);
  assert.equal(crRangeGroupsById.has('A'), false);
});

// ── (B) fragment unionによるexact geometry抽出 ─────────────────────────
test('extractExactTriUnionGeometry: 1棟が複数meshに分割されたfixtureで、overlayが全meshのtriangle unionと一致する', { skip: SKIP_REASON }, () => {
  const { extractExactTriUnionGeometry } = loadMission36EHelpers();
  // roof bucket mesh: 建物Aのtriangle1枚 + 建物Bのtriangle1枚(混入していないことの検証用)
  const roofFlat = [[0, 10, 0], [1, 10, 0], [1, 10, 1], [5, 10, 5], [6, 10, 5], [6, 10, 6]];
  const roofMesh = { userData: { crTriBuilding: [0, 1], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(roofFlat) };
  // wall bucket mesh: 建物Aのtriangle2枚(別bucket = 別mesh)
  const wallFlat = [[0, 0, 0], [1, 0, 0], [0, 10, 0], [1, 0, 0], [1, 0, 1], [1, 10, 1]];
  const wallMesh = { userData: { crTriBuilding: [0, 0], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(wallFlat) };

  const fragments = [{ mesh: roofMesh, bi: 0 }, { mesh: wallMesh, bi: 0 }];
  const r = extractExactTriUnionGeometry(fragments);
  assert.ok(r, '建物Aのexact geometryが取れませんでした');
  assert.equal(r.fragmentCount, 2, '2つのfragment(roof mesh + wall mesh)からunionされたはず');
  assert.equal(r.triCount, 3, 'roof1枚 + wall2枚 = 3枚のはず(roof/wall両方が選択される§: roof mesh + wall meshが別々のfixtureで両方選択されること)');
  const flatOut = Array.from(r.positions);
  // 建物Bの座標(5,10,5/ 6,10,5 / 6,10,6)が1つも混ざっていないこと
  assert.deepEqual(flatOut, [...roofFlat.slice(0, 3).flat(), ...wallFlat.flat()]);
});

test('extractExactTriUnionGeometry: fragmentの一部が解決できなくても、解決できた分だけunionする(0件ならnull)', { skip: SKIP_REASON }, () => {
  const { extractExactTriUnionGeometry } = loadMission36EHelpers();
  assert.equal(extractExactTriUnionGeometry([]), null);
  assert.equal(extractExactTriUnionGeometry(null), null);
  const emptyMesh = { userData: { crTriBuilding: [], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry([]) };
  assert.equal(extractExactTriUnionGeometry([{ mesh: emptyMesh, bi: 0 }]), null);
});

test('extractExactRangeUnionGeometry: tile境界をまたいだ複数tileGroupのroof/wall/groundを全てunionする', { skip: SKIP_REASON }, () => {
  const { extractExactRangeUnionGeometry } = loadMission36EHelpers();
  // tile1: 建物Aのroof
  const roofFlat = [[0, 10, 0], [1, 10, 0], [1, 10, 1]];
  const roofMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }] } },
    geometry: mockIndexedGeometry(roofFlat, [0, 1, 2]),
  };
  const tileGroup1 = { children: [roofMesh] };
  // tile2(隣接tile。建物Aの足元がまたがっている想定): 建物Aのwall + 無関係な建物Cのground
  const wallFlat = [[0, 0, 0], [1, 0, 0], [0, 10, 0]];
  const wallMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }] } },
    geometry: mockIndexedGeometry(wallFlat, [0, 1, 2]),
  };
  const groundMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'C' }] } },
    geometry: mockIndexedGeometry([[9, 0, 9], [9, 0, 9], [9, 0, 9]], [0, 1, 2]),
  };
  const tileGroup2 = { children: [wallMesh, groundMesh] };

  const r = extractExactRangeUnionGeometry([tileGroup1, tileGroup2], 'A');
  assert.ok(r, '建物Aのexact geometryが取れませんでした');
  assert.equal(r.fragmentCount, 2, 'tile1(roof) + tile2(wall) の2 tileGroupからunionされたはず');
  assert.equal(r.triCount, 2, 'roof1枚 + wall1枚 = 2枚のはず');
  const flatOut = Array.from(r.positions);
  assert.deepEqual(flatOut, [...roofFlat.flat(), ...wallFlat.flat()]);
  // 隣接建物Cの座標が混ざっていないこと(別棟まで巻き込まない)
  assert.ok(!flatOut.includes(9));
});

// ── (B) resolveExactTriSourceでの統合検証(実際にpickHitが返すtriSourceの形) ──────
test('resolveExactTriSource(kind:tri): canonicalId索引に複数fragmentが登録されていれば、hitした1meshだけでなく全fragmentをunionする', { skip: SKIP_REASON }, () => {
  const { crRegisterTriFragments, resolveExactTriSource } = loadMission36EHelpers();
  const roofFlat = [[0, 10, 0], [1, 10, 0], [1, 10, 1]];
  const roofMesh = { userData: { crTriBuilding: [0], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(roofFlat) };
  const wallFlat = [[0, 0, 0], [1, 0, 0], [0, 10, 0]];
  const wallMesh = { userData: { crTriBuilding: [0], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(wallFlat) };
  // tile/bucket構築時と同じ形で索引へ登録する
  crRegisterTriFragments(roofMesh, [{ canonicalId: 'A' }]);
  crRegisterTriFragments(wallMesh, [{ canonicalId: 'A' }]);

  // pickBuilding が実際に返す triSource: hitしたのは roofMesh 側だけ
  const triSource = { kind: 'tri', mesh: roofMesh, bi: 0, canonicalId: 'A' };
  const r = resolveExactTriSource(triSource);
  assert.ok(r, 'exact geometryが取れませんでした');
  assert.equal(r.triCount, 2, 'roofだけでなくwallも含めて2枚のはず(壁だけ/屋根だけのpartial highlightにならない)');
  const flatOut = Array.from(r.positions);
  assert.deepEqual(flatOut, [...roofFlat.flat(), ...wallFlat.flat()]);
});

test('resolveExactTriSource(kind:tri): 索引が無い(未登録)ときは36D互換でtriSource自体の{mesh,bi}だけを使う', { skip: SKIP_REASON }, () => {
  const { resolveExactTriSource } = loadMission36EHelpers();
  const flat = [[0, 0, 0], [1, 0, 0], [1, 0, 1]];
  const mesh = { userData: { crTriBuilding: [0], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry(flat) };
  const r = resolveExactTriSource({ kind: 'tri', mesh, bi: 0, canonicalId: 'unregistered' });
  assert.ok(r);
  assert.equal(r.triCount, 1);
  assert.deepEqual(Array.from(r.positions), flat.flat());
});

test('resolveExactTriSource(kind:tri): 隣接する別棟のfragmentは混ざらない', { skip: SKIP_REASON }, () => {
  const { crRegisterTriFragments, resolveExactTriSource } = loadMission36EHelpers();
  const flatA = [[0, 0, 0], [1, 0, 0], [1, 0, 1]];
  const flatB = [[9, 0, 9], [9, 0, 9], [9, 0, 9]];
  // 建物Aとその隣の建物Bが同じbucket meshに同居しているケース(bi=0がA, bi=1がB)
  const mesh = { userData: { crTriBuilding: [0, 1], crTriEmpty: 65535 }, geometry: mockNonIndexedGeometry([...flatA, ...flatB]) };
  crRegisterTriFragments(mesh, [{ canonicalId: 'A' }, { canonicalId: 'B' }]);

  const r = resolveExactTriSource({ kind: 'tri', mesh, bi: 0, canonicalId: 'A' });
  assert.equal(r.triCount, 1);
  assert.deepEqual(Array.from(r.positions), flatA.flat(), '建物Bの座標が混ざってはいけない');
});

test('resolveExactTriSource(kind:ranges): canonicalId索引に複数tileGroupが登録されていれば、hitしたtileGroupだけでなく全tileGroupをunionする', { skip: SKIP_REASON }, () => {
  const { crRegisterRangeGroup, resolveExactTriSource } = loadMission36EHelpers();
  const roofFlat = [[0, 10, 0], [1, 10, 0], [1, 10, 1]];
  const roofMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }] } },
    geometry: mockIndexedGeometry(roofFlat, [0, 1, 2]),
  };
  const tileGroup1 = { children: [roofMesh] };
  const wallFlat = [[0, 0, 0], [1, 0, 0], [0, 10, 0]];
  const wallMesh = {
    userData: { lodHigh: { ranges: [{ start: 0, count: 3, canonicalId: 'A' }] } },
    geometry: mockIndexedGeometry(wallFlat, [0, 1, 2]),
  };
  const tileGroup2 = { children: [wallMesh] };
  crRegisterRangeGroup('A', tileGroup1);
  crRegisterRangeGroup('A', tileGroup2);

  // pickHitはtileGroup1(roof)側を返すが、tileGroup2(wall)も一緒にunionされるはず
  const r = resolveExactTriSource({ kind: 'ranges', tileGroup: tileGroup1, canonicalId: 'A' });
  assert.equal(r.triCount, 2);
  const flatOut = Array.from(r.positions);
  assert.deepEqual(flatOut, [...roofFlat.flat(), ...wallFlat.flat()]);
});

// ── (A) exact overlay materialの裏面カリング(FrontSide/DoubleSide)修正の静的検証 ──
// THREE.js自体はこのテスト環境に無いため、実際にMesh/Materialを生成してレンダリングを
// 確認することはできない。そのため「実装コードにDoubleSide化が実際に書かれていること」を
// ソーステキストとして検証する(html-regression.test.jsと同じ方針)。
test('§5: makeExactOverlayはhl.fill.materialをcloneし、side をTHREE.DoubleSideへ変えている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'makeExactOverlay');
  assert.ok(body, 'makeExactOverlay関数が見つかりません');
  assert.match(body, /hl\.fill\.material\.clone\(\)/, 'hl.fill.materialをcloneしていません(既存material自体を書き換えると旧footprint fan描画にも影響するため、必ずcloneする)');
  assert.match(body, /material\.side\s*=\s*THREE\.DoubleSide/, 'exact overlay用materialのsideをDoubleSideへ変更していません');
});

test('§5: 旧footprint fan描画用のfillMat自体(makeHighlightSet内)はFrontSideのまま変更していない(退行防止)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'makeHighlightSet');
  assert.ok(body, 'makeHighlightSet関数が見つかりません');
  assert.match(body, /const fillMat = new THREE\.MeshBasicMaterial\(\{[^}]*side:\s*THREE\.FrontSide/, 'fillMat定義そのものを書き換えてしまっている可能性があります(makeExactOverlay側でcloneして変えるべき)');
});

// ── 全source監査: 索引の登録/解除がすべての生成・破棄経路に配線されていることを確認する ──
test('§1: canonical tiled buildingsのbucket mesh構築時にcrRegisterTriFragmentsが呼ばれている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  assert.match(html, /crRegisterTriFragments\(m,\s*bucket\.fps\)/, 'canonical tiled buildings(usageCategoryバケット)がcanonicalId索引へ登録されていません');
});

test('§1: Umeda Visual Building PoC merged mesh構築時にもcrRegisterTriFragmentsが呼ばれている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  assert.match(html, /crRegisterTriFragments\(mesh,\s*fps\)/, 'Umeda Visual Building PoC merged meshがcanonicalId索引へ登録されていません');
});

test('§9: canonical tile破棄(disposeEntry)でcrUnregisterTriFragmentsが呼ばれ、索引からfragmentが漏れなく外れる', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'disposeEntry');
  assert.ok(body, 'disposeEntry関数が見つかりません');
  assert.match(body, /crUnregisterTriFragments\(o,\s*o\.userData\.crBuildingFps\)/, 'tile破棄時にcanonicalId索引からfragmentを外していません(破棄済みmeshが索引に残ると、exact overlayが破棄後のgeometryを読みに行く)');
});

test('§3: BuildingLODLayerのtile構築(fetchTile/rebuildTile)でcrRegisterRangeGroupが呼ばれている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const matches = html.match(/crRegisterRangeGroup\(id,\s*built\.group\)/g) || [];
  assert.equal(matches.length, 2, 'fetchTile(新規取得)とrebuildTile(band切替での再構築)の両方でtileGroupを索引へ登録している必要があります');
});

test('§9: BuildingLODLayerのtile破棄(disposeTile(rec))でcrUnregisterRangeGroupが呼ばれている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  // このファイルにはdisposeTileが2箇所ある(汎用tile層 disposeTile(layer,key,opts) と
  // BuildingLODLayer内 disposeTile(rec))。シグネチャで後者だけを指定して抽出する。
  const body = extractFunctionBodyByStartPattern(html, /function disposeTile\(rec\)\s*\{/);
  assert.ok(body, 'BuildingLODLayer内のdisposeTile(rec)関数が見つかりません');
  assert.match(body, /crUnregisterRangeGroup\(rec\.group,\s*rec\.ids\)/, 'tile破棄時にcanonicalId索引からtileGroupを外していません');
});

test('§4: buildingFromHitが返すtri triSourceにcanonicalIdが含まれている(索引解決に必須)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const body = extractFunctionBody(html, 'buildingFromHit');
  assert.ok(body, 'buildingFromHit関数が見つかりません');
  assert.match(body, /kind:\s*'tri',\s*mesh:\s*hit\.object,\s*bi,\s*canonicalId:\s*fp\.canonicalId/, 'triSourceにcanonicalIdが含まれていないと、resolveExactTriSourceが索引を引けずhitした1meshだけに戻ってしまいます');
});

// ── QA stats: fragment数の内訳を実機QAから確認できること ──
test('QA: highlightQaStatsがmultiFragmentByKind/lastResolvedを持ち、window.__MISSION36E_STATS__としても公開されている', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  assert.match(html, /multiFragmentByKind:\s*\{\s*tri:\s*0,\s*ranges:\s*0,\s*meshList:\s*0,\s*legacyVertexTri:\s*0\s*\}/, 'highlightQaStatsにmultiFragmentByKindが定義されていません');
  assert.match(html, /window\.__MISSION36E_STATS__\s*=\s*highlightQaStats/, 'QA statsがwindow.__MISSION36E_STATS__として公開されていません');
});
