// tests/max-plateau-lod.test.js
// [Mission 34A] PLATEAU の実データとして存在する最高 LOD への昇格
//   - 在庫調査（LOD タグの読み取り・メモリ保持の罠）
//   - geometry 抽出（座標変換 / 妥当性 / 地面合わせ / 三角形分割）
//   - ランタイム（距離 LOD / LOD1 抑制 / 優先順位 / picking / 用途色）
//   - 実ブラウザ QA と validator
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOD_TAGS, SEMANTIC_TAGS, buildingStarts, lodOf, detach, countOf } from '../tools/audit/plateau-lod-availability.js';
import {
  VALID, SURFACE_KINDS, parsePosListLatLonAlt, openRing, newellNormal, triangulatePolygon,
  extractSurfaces, buildRepresentation,
} from '../tools/build-plateau-high-lod.js';
import { POSITION_TOLERANCE_M, LOD_BANDS } from '../tools/validate/max-plateau-lod.js';
import { latLonToLiveCityWorld } from '../tools/lib/livecity-coordinate-system.js';
import { productionMatchesBuildRecord, devUiIsGated } from '../tools/lib/production-invariants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = rj(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high', 'manifest.json'));

// CityGML 2.0 の建物 1 件（LOD1 + LOD2 の semantic surface 付き）
const SAMPLE = `<bldg:Building gml:id="bldg_test-0001">
  <gen:stringAttribute name="区名"><gen:value>中央区</gen:value></gen:stringAttribute>
  <bldg:measuredHeight uom="m">10.0</bldg:measuredHeight>
  <bldg:lod0FootPrint><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>34.6 135.5 0 34.6001 135.5 0 34.6001 135.5001 0 34.6 135.5001 0 34.6 135.5 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod0FootPrint>
  <bldg:lod1Solid><gml:Solid><gml:exterior><gml:CompositeSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>34.6 135.5 0 34.6001 135.5 0 34.6001 135.5001 0 34.6 135.5001 0 34.6 135.5 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod1Solid>
  <bldg:lod2Solid><gml:Solid><gml:exterior><gml:CompositeSurface><gml:surfaceMember xlink:href="#p1" /></gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod2Solid>
  <bldg:boundedBy><bldg:GroundSurface gml:id="g1"><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon gml:id="p0"><gml:exterior><gml:LinearRing><gml:posList>34.6 135.5 2 34.6 135.5001 2 34.6001 135.5001 2 34.6001 135.5 2 34.6 135.5 2</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:GroundSurface></bldg:boundedBy>
  <bldg:boundedBy><bldg:WallSurface gml:id="w1"><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon gml:id="p1"><gml:exterior><gml:LinearRing><gml:posList>34.6 135.5 2 34.6001 135.5 2 34.6001 135.5 12 34.6 135.5 12 34.6 135.5 2</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:WallSurface></bldg:boundedBy>
  <bldg:boundedBy><bldg:RoofSurface gml:id="r1"><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon gml:id="p2"><gml:exterior><gml:LinearRing><gml:posList>34.6 135.5 12 34.6001 135.5 12 34.6001 135.5001 14 34.6 135.5001 14 34.6 135.5 12</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:RoofSurface></bldg:boundedBy>
</bldg:Building>`;

test('[34A §2] LOD タグの定義が CityGML の実体に合っている', () => {
  assert.ok(LOD_TAGS.lod0.includes('<bldg:lod0FootPrint'));
  assert.ok(LOD_TAGS.lod1.includes('<bldg:lod1Solid') && LOD_TAGS.lod1.includes('<bldg:lod1MultiSurface'));
  assert.ok(LOD_TAGS.lod2.includes('<bldg:lod2Solid') && LOD_TAGS.lod2.includes('<bldg:lod2MultiSurface'));
  assert.ok(LOD_TAGS.lod3.includes('<bldg:lod3Solid') && LOD_TAGS.lod3.includes('<bldg:lod3MultiSurface'));
  // §9 semantic surface
  for (const t of ['bldg:RoofSurface', 'bldg:WallSurface', 'bldg:GroundSurface', 'bldg:Window', 'bldg:Door']) {
    assert.ok(SEMANTIC_TAGS.includes(t), t);
  }
});

test('[34A §2] 1 建物から LOD の有無と区名を読み取る', () => {
  const starts = buildingStarts(SAMPLE);
  assert.equal(starts.length, 1, 'BuildingPart を建物として数えていない');
  const r = lodOf(SAMPLE, {});
  assert.equal(r.id, 'bldg_test-0001');
  assert.equal(r.l0, true);
  assert.equal(r.l1, true);
  assert.equal(r.l2, true);
  assert.equal(r.l3, false);
  assert.equal(r.ward, '中央区');
  assert.ok(r.posLists > 0);
});

test('[34A] 走査の文字列は親チャンクを保持しない（60 万件で OOM した原因）', () => {
  // detach は必ず新しい平坦な文字列を返す（同値・別実体）
  const big = 'x'.repeat(100000) + 'gml:id="bldg_abc"';
  const m = /gml:id="([^"]+)"/.exec(big);
  const d = detach(m[1]);
  assert.equal(d, 'bldg_abc');
  assert.notEqual(d, m[1] === d ? null : m[1]);   // 値は同じでも実体を作り直している
  assert.equal(countOf('aXbXc', 'X'), 2);
});

test('[34A §6] 座標変換は local-equirectangular のみ（Zone VII を経由しない）', () => {
  const pts = parsePosListLatLonAlt('34.604208 135.52502 5  34.605208 135.52502 5');
  assert.equal(pts.length, 2);
  // 原点は (0,0)
  assert.ok(Math.abs(pts[0][0]) < 1e-6 && Math.abs(pts[0][2]) < 1e-6);
  assert.equal(pts[0][1], 5, 'alt が Y に入っていない');
  // 北へ 0.001 度 → z が負方向（znorth-neg-v1）
  assert.ok(pts[1][2] < -100 && pts[1][2] > -120, 'z=' + pts[1][2]);
  const w = latLonToLiveCityWorld(34.605208, 135.52502);
  assert.ok(Math.abs(pts[1][0] - w.x) < 1e-9 && Math.abs(pts[1][2] - w.z) < 1e-9, '共通変換と一致しない');
  // ビルダーのソースに平面直角座標系が出てこない
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-plateau-high-lod.js'), 'utf-8');
  assert.doesNotMatch(src, /latLonToJPRect|jprect/i);
  assert.match(src, /latLonToLiveCityWorld/);
});

test('[34A] 幾何ヘルパー: リング・法線・三角形分割', () => {
  const closed = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 0, 0]];
  assert.equal(openRing(closed).length, 4, '閉じ点が落ちていない');
  const n = newellNormal(openRing(closed));
  assert.ok(Math.abs(Math.abs(n[1]) - 1) < 1e-9, '水平面の法線が Y 軸でない');
  const t = triangulatePolygon(openRing(closed));
  assert.equal(t.indices.length / 3, 2, '四角形が 2 三角形にならない');
  // 穴あり
  const outer = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
  const hole = [[3, 0, 3], [3, 0, 7], [7, 0, 7], [7, 0, 3]];
  const th = triangulatePolygon(outer, [hole]);
  assert.ok(th.indices.length / 3 >= 8, '穴が三角形分割に反映されていない');
  // 退化（直線）は分割できない
  assert.equal(triangulatePolygon([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), null);
});

test('[34A §9] semantic surface を種別ごとに取り出す', () => {
  const s = extractSurfaces(SAMPLE, 2);
  assert.equal(s.length, 3);
  const kinds = s.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['ground', 'roof', 'wall']);
  assert.equal(SURFACE_KINDS.RoofSurface, 'roof');
  assert.equal(SURFACE_KINDS.WallSurface, 'wall');
  assert.equal(SURFACE_KINDS.GroundSurface, 'ground');
  // LOD3 は存在しないので空
  assert.equal(extractSurfaces(SAMPLE, 3).length, 0);
});

test('[34A §5/§8] 妥当性検査と地面合わせ', () => {
  const surfaces = extractSurfaces(SAMPLE, 2);
  const canon = { canonicalId: 'cg_bldg_bldg_test-0001', centroid: [latLonToLiveCityWorld(34.60005, 135.50005).x, latLonToLiveCityWorld(34.60005, 135.50005).z] };
  const rep = buildRepresentation(surfaces, canon, 2);
  assert.equal(rep.ok, true, rep.reason);
  assert.equal(rep.lod, 2);
  // §8 GroundSurface の最低標高（2m）が 0 になる
  assert.equal(rep.baseAltM, 2);
  assert.equal(rep.bbox.maxY, 12, '屋根の頂部が全高と合わない');
  assert.equal(rep.heightM, 12);
  // §7 canonical 重心とのズレを記録している
  assert.ok(rep.centroidShiftM >= 0 && rep.centroidShiftM < VALID.maxCentroidShiftM);
  // §9/§10 種別ごとに分かれている
  const kinds = rep.parts.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ['ground', 'roof', 'wall']);
  assert.ok(rep.triangles >= 6);
  assert.equal(rep.degenerate, 0);
  // 地面基準に平行移動されている（最低 Y が 0）
  for (const p of rep.parts) for (let i = 1; i < p.positions.length; i += 3) assert.ok(p.positions[i] >= -0.01, 'Y が負');
});

test('[34A §5] 壊れた高 LOD は採用しない（building 単位の fallback）', () => {
  const surfaces = extractSurfaces(SAMPLE, 2);
  // surface が足りない
  assert.equal(buildRepresentation(surfaces.slice(0, 1), null, 2).ok, false);
  // 異常な高さ
  const tall = JSON.parse(JSON.stringify(surfaces));
  for (const p of tall[2].outer) p[1] = 5000;
  const r1 = buildRepresentation(tall, null, 2);
  assert.equal(r1.ok, false);
  assert.ok(r1.reason === 'absurd-altitude' || r1.reason === 'absurd-height', r1.reason);
  // canonical 重心から大きく離れている
  const r2 = buildRepresentation(surfaces, { centroid: [99999, 99999] }, 2);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'centroid-shift');
  // しきい値の妥当性
  assert.ok(VALID.maxHeightM >= 300 && VALID.maxHeightM <= 400, 'あべのハルカス 300m が入らない');
  assert.ok(VALID.maxCentroidShiftM <= 30);
});

test('[34A §12] 出力の namespace と宣言', () => {
  assert.ok(manifest, 'building-lod-high の manifest が無い');
  assert.equal(manifest.kind, 'building-lod-high');
  assert.equal(manifest.namespace, 'derived-v2-osmv2');
  assert.equal(manifest.coordinateConvention, 'znorth-neg-v1');
  assert.equal(manifest.zone7Used, false);
  assert.ok(manifest.buildingCount > 0);
  assert.equal(manifest.buildingCount, manifest.lod2Count + manifest.lod3Count);
  assert.ok(manifest.tiles.length > 0);
});

test('[34A §11] 高 LOD は canonicalId に紐づく別表現（ID を作り替えない）', () => {
  const dir = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-lod-high');
  const files = fs.readdirSync(dir).filter((f) => /^tile_/.test(f)).slice(0, 4);
  let n = 0;
  for (const f of files) {
    const t = rj(path.join(dir, f));
    assert.ok(t.buildings.length > 0);
    for (const b of t.buildings) {
      n++;
      assert.match(b.canonicalId, /^cg_bldg_bldg_/, 'canonicalId の形式が違う');
      assert.ok(b.lod === 2 || b.lod === 3, 'lod が 2/3 でない');
      assert.ok(b.parts.length >= 1);
      assert.ok(b.heightM > 0);
      for (const p of b.parts) {
        assert.equal(p.indices.length % 3, 0);
        assert.ok(Math.max(...p.indices) < p.positions.length / 3, 'index が範囲外');
      }
    }
  }
  assert.ok(n > 10);
});

test('[34A §13/§14/§15] ランタイム: 独立レイヤーと距離 LOD', () => {
  assert.match(html, /const BuildingLODLayer = \(function \(\) \{/);
  assert.match(html, /group\.name = 'CR_buildingLodHigh';/);
  assert.match(html, /if \(typeof canonicalRoot !== 'undefined'\) canonicalRoot\.add\(group\); else scene\.add\(group\);/);
  assert.match(html, /const BAND = \{ highLodMaxR: 2500, nearMaxR: 800 \};/);
  assert.match(html, /function bandOf\(r\) \{ return r <= BAND\.nearMaxR \? 'near' : \(r <= BAND\.highLodMaxR \? 'mid' : 'far'\); \}/);
  // far では高 LOD を出さない
  assert.match(html, /if \(band === 'far'\) \{[\s\S]{0,400}g\.visible = false;/);
  // mid は地面 surface を落とす（距離に応じたコスト差）
  assert.match(html, /const kindsFor = \(band\) => \(band === 'near' \? null : new Set\(\['roof', 'wall', 'closure'\]\)\);/);
  assert.equal(LOD_BANDS.highLodMaxR, 2500);
  assert.equal(LOD_BANDS.nearMaxR, 800);
});

test('[34A §11/§17/§18] 優先順位と LOD1 抑制', () => {
  // LandmarkHD が持っている棟は高 LOD を描かない
  assert.match(html, /function landmarkOwns\(id\) \{/);
  assert.match(html, /if \(landmarkOwns\(b\.canonicalId\)\) continue;/);
  // 高 LOD を描いている棟は LOD1 を描かない
  assert.match(html, /if \(typeof BuildingLODLayer !== 'undefined' && BuildingLODLayer\.isSuppressedBuilding\(f\.canonicalId\)\) \{/);
  assert.match(html, /function invalidateBuildingTiles\(tileKeys\) \{/);
  // LandmarkHD の抑制はそのまま残っている（33E）
  assert.match(html, /if \(typeof LandmarkHDLayer !== 'undefined' && LandmarkHDLayer\.isSuppressedBuilding\(f\.canonicalId\)\) \{/);
  // OSM fallback に高 LOD は作っていない（抽出元は PLATEAU の lod2/lod3 タグのみ）
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'build-plateau-high-lod.js'), 'utf-8');
  assert.match(src, /const want = 'lod' \+ lod \+ 'MultiSurface';/);
  assert.doesNotMatch(src, /osm-fallback/);
});

test('[34A §16/§19] 色を変えない / 同じ card へ到達する', () => {
  // 用途色は LOD1 と同じものを使い、頂点カラーへ焼く（draw call を増やさない）
  assert.match(html, /function usageColor\(cat, band\) \{/);
  assert.match(html, /CanonicalRuntime\.buildingMaterial\(cat, band === 'near' \? 'near' : 'mid'\)/);
  // [Mission 34B §4] material は Lambert → Standard（flatShading）。頂点カラーで用途色を運ぶ点は不変。
  assert.match(html, /vertexColors: true, side: THREE\.DoubleSide, flatShading: true,/);
  // [Mission 34B §4] 屋根は暗くするのではなく明度を上げる（色相は不変）
  assert.match(html, /const cc = p\.kind === 'roof' \? tintRoof\(col\) : col;/);
  // picking
  assert.match(html, /window\.__BUILDING_LOD_LAYER__\.pick\(ray\)/);
  assert.match(html, /CanonicalRuntime\.buildingDataById\(hl\.canonicalId\)/);
  assert.match(html, /for \(const r of ranges\) if \(i3 >= r\.start && i3 < r\.start \+ r\.count\) return \{ canonicalId: r\.canonicalId/);
});

test('[34A §22] LOD カバレッジの QA 表示（production には出さない）', () => {
  assert.match(html, /function setQaMode\(on\) \{/);
  assert.match(html, /const QA_COLOR = \{ lod2: 0x3f8fe0, lod3: 0xd8a83a \};/);
  assert.match(html, /window\.__BUILDING_LOD_QA__/);
  // [Mission 35G] QA の入口（__BUILDING_LOD_QA__）は production のバイトにも入るが、
  //   **既定で off** で、トグルは production で非表示になる箱の中にある。
  const prod = fs.readFileSync(PROD, 'utf-8');
  assert.match(prod, /let qaMode = false, qaGroup = null;/, 'QA が既定 off でない');
  assert.deepEqual(devUiIsGated(['max-lod-qa-toggle']), { ok: true });
});

test('[34A §3] 在庫調査の結果', { skip: skip('plateau-lod-availability.json') }, () => {
  const a = rpt('plateau-lod-availability.json');
  assert.ok(a.counts.total > 500000, '走査件数が少なすぎる（ファイル欠落の疑い）: ' + a.counts.total);
  assert.equal(a.counts.noGeometry, 0);
  assert.equal(a.counts.lod1Only + a.counts.lod2Available + a.counts.lod3Available + a.counts.noGeometry, a.counts.total);
  assert.ok(a.sources.folderFiles > 0 && a.sources.zipEntries > 0, 'ZIP 内エントリを見ていない');
  assert.ok(a.byWard.length >= 20, '区別の集計が足りない');
  // semantic surface が実在する（LOD2 が「LOD1 と同じポリゴン」ではない証拠）
  assert.ok(a.semanticSurfaces.RoofSurface > 1000);
  assert.ok(a.semanticSurfaces.WallSurface > 1000);
});

test('[34A §4/§7] 採用結果', { skip: skip('plateau-high-lod-build.json') }, () => {
  const b = rpt('plateau-high-lod-build.json');
  assert.equal(b.adopted, b.adoptedLod2 + b.adoptedLod3);
  assert.equal(b.adopted + b.fallbackToLod1 + b.noCanonicalSkipped, b.targets, '採用・差し戻し・対象外の合計が対象数と合わない');
  assert.ok(b.adopted > 1000);
  assert.equal(b.degenerateTrianglesDropped, 0);
  // §7 位置が LOD1 から動いていない
  assert.ok(b.centroidShiftM.median <= POSITION_TOLERANCE_M.median, '重心ズレ中央値 ' + b.centroidShiftM.median);
  assert.ok(b.centroidShiftM.p95 <= POSITION_TOLERANCE_M.p95);
  assert.ok(b.centroidShiftM.max <= POSITION_TOLERANCE_M.max);
  // §9 semantic surface を保持している
  assert.ok(b.surfaceTotals.roof > 0 && b.surfaceTotals.wall > 0 && b.surfaceTotals.ground > 0);
});

test('[34A §19/§21] 実ブラウザ: 二重表示なし / 穴なし / picking', { skip: skip('building-lod-qa.json') }, () => {
  const q = rpt('building-lod-qa.json');
  assert.deepEqual(q.errors, []);
  for (const s of q.sites) {
    assert.equal(s.doubleHits, 0, `${s.site}: 高 LOD と LOD1 の二重表示`);
    assert.equal(s.residual, 0, `${s.site}: legacy residual`);
    // LOD1 を消した数と高 LOD を出した数が一致（＝地図に穴が空いていない）
    assert.equal(s.visibleLod2 + s.visibleLod3, s.suppressedLod1, `${s.site}: 抑制 ${s.suppressedLod1} に対し表示 ${s.visibleLod2 + s.visibleLod3}`);
  }
  // §14/§15 距離で切り替わる
  for (const d of q.distanceSwitch) {
    if (d.cameraR > LOD_BANDS.highLodMaxR) { assert.equal(d.band, 'far'); assert.equal(d.triangles, 0, 'far で高 LOD を描いている'); }
    else assert.notEqual(d.band, 'far');
  }
  // §8/§16 切替で浮き沈み・位置の跳びが無い
  const boxes = q.switchCheck.filter((s) => s.bbox);
  for (const s of boxes) assert.ok(Math.abs(s.bbox.minY) <= 0.5, 'r=' + s.r + ' で建物が地面から離れている: ' + s.bbox.minY);
  const xs = boxes.map((s) => s.bbox.minX);
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 30, 'LOD 切替で位置が動いている');
  // §19 picking
  assert.equal(q.pick.found, true);
  assert.equal(q.pick.onScreen, true);
  assert.equal(q.pick.sameId, true, '高 LOD と LOD1 で canonicalId が違う');
  assert.equal(q.pick.high.display, 'block');
  assert.equal(q.pick.low.display, 'block');
  assert.deepEqual(q.pick.high.fake, []);
});

test('[34A §20] 実ブラウザ: 性能', { skip: skip('building-lod-qa.json') }, () => {
  const q = rpt('building-lod-qa.json');
  for (const on of q.performance.filter((p) => p.highLod)) {
    const off = q.performance.find((p) => !p.highLod && p.site === on.site);
    assert.ok(off, on.site);
    assert.ok(on.fpsAverage >= off.fpsAverage * 0.8, `${on.site}: FPS ${off.fpsAverage} → ${on.fpsAverage}`);
    assert.ok(on.fpsAverage >= 20, `${on.site}: FPS が 20 を下回る ${on.fpsAverage}`);
    // 高 LOD が無い地点では描画量が変わらない
    if (on.visibleLod2 === 0 && on.visibleLod3 === 0) assert.equal(on.trianglesAvg, off.trianglesAvg, on.site);
  }
});

test('[34A §24] validator が PASS', { skip: skip('max-plateau-lod-validation.json') }, () => {
  const v = rpt('max-plateau-lod-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'MAX_PLATEAU_LOD_SUCCESS');
  assert.equal(v.zoneVIIProjectionUsed, false);
  assert.equal(v.canonicalIdChanged, false);
  assert.equal(v.buildingPositionMutation, false);
  assert.equal(v.roadMutation, false);
  assert.equal(v.placementMutation, false);
  assert.equal(v.highestAvailableLodSelected, true);
  assert.equal(v.perBuildingFallbackWorks, true);
  assert.equal(v.lod2UsesRealPlateauOnly, true);
  assert.equal(v.lod3UsesRealPlateauOnly, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('[34A] production / protected は変更していない', () => {
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256);
  assert.equal(sha(PROD), build.productionSha256);
  const baseline = rpt('baselines/prod-protected-hashes.json');
  assert.ok(baseline && baseline.prot);
  assert.equal(sha(PROT), baseline.prot);
  // [Mission 35G] cutover 後は高 LOD のコードも production に入る（高 LOD は
  //   production の通常表示の一部として意図的に有効）。勝手な差分が無いことを見る。
  // [Mission 35H] dev 先行が正常なので、production 自身のビルド記録と比べる。
  assert.deepEqual(productionMatchesBuildRecord(build.productionSha256), { ok: true, now: sha(PROD), expected: build.productionSha256 });
});
