// tests/osm-fallback-v2-rebuild.test.js
// [Mission 32O] REBUILD OSM BUILDING FALLBACK AGAINST CORRECTED V2
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildPlateauIndex, measureOverlap, classifyOverlap, isRetainedClass, FALLBACK_V2_CLASS as C } from '../tools/lib/osm-fallback-v2-classify.js';
import { selectFallback } from '../tools/build-osm-fallback-v2.js';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const REPORT = 'osm-fallback-v2-rebuild.json';
const VALIDATION = 'osm-fallback-v2-rebuild-validation.json';
const skip = (n) => (!rpt(n) && 'no report');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const HTML = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const sq = (x, z, w, h) => [[x, z], [x + w, z], [x + w, z + h], [x, z + h]];
const IDX = buildPlateauIndex([{ id: 'A', ring: sq(0, 0, 10, 10) }, { id: 'B', ring: sq(12, 0, 10, 10) }, { id: 'S', ring: sq(100, 100, 2, 2) }]);
const cls = (ring) => classifyOverlap(measureOverlap(ring, IDX));

test('[32O §6] 同じ建物（ほぼ同形）は CLEAR_DUPLICATE', () => {
  const m = measureOverlap(sq(0.5, 0.5, 10, 10), IDX);
  assert.ok(m.coveredFraction > 0.85 && m.maxIoU > 0.75);
  assert.equal(classifyOverlap(m).cls, C.CLEAR_DUPLICATE);
});

test('[32O §9] 1 棟の OSM が複数 PLATEAU にまたがる（one-to-many）も重複として扱う', () => {
  const m = measureOverlap(sq(0, 0, 22, 10), IDX);
  assert.equal(m.plateauPartners, 2);
  assert.ok(m.maxIoU < 0.5, 'IoU 単独では同一建物にならない');
  assert.equal(classifyOverlap(m).cls, C.CLEAR_DUPLICATE);
});

test('[32O §8/§9] 離れた建物は近くても VALID（最近傍距離だけで重複にしない）', () => {
  const m = measureOverlap(sq(0, 11, 10, 10), IDX);
  assert.equal(m.coveredFraction, 0);
  assert.ok(m.nearestDistanceM > 0 && m.nearestDistanceM < 2);
  assert.equal(classifyOverlap(m).cls, C.VALID_FALLBACK);
});

test('[32O §7] 一部だけ重なる大きな建物は落とさない（AMBIGUOUS として残す）', () => {
  // A と 3m×10m だけ重なる 30m×10m の建物: 重なり 10%・重ならない部分 270m²
  const r = cls(sq(7, 0, 30, 10).map(([x, z]) => [x + 100, z + 50]));
  assert.equal(r.cls, C.VALID_FALLBACK); // 位置をずらすと重なり無し（前提確認）
  const m = measureOverlap(sq(-20, 0, 23, 10), IDX); // A と 3m×10m 重なる → 13%
  const k = classifyOverlap(m);
  assert.equal(k.cls, C.AMBIGUOUS);
  assert.ok(isRetainedClass(k.cls));
  // 重心が PLATEAU の中でも、重ならない部分が大きく重なりが小さければ残す
  const big = measureOverlap([[5, 5], [5, 9], [55, 9], [55, 5]], buildPlateauIndex([{ id: 'X', ring: sq(20, 0, 12, 12) }]));
  assert.equal(big.centroidInPlateau, true);
  assert.equal(classifyOverlap(big).cls, C.AMBIGUOUS);
  assert.equal(classifyOverlap(big).rule, 'likely-but-large-uncovered');
});

test('[32O §5] 小さな PLATEAU を含むだけの大きな OSM は VALID、PLATEAU を包む輪郭は LIKELY', () => {
  assert.equal(cls(sq(90, 90, 30, 30)).cls, C.VALID_FALLBACK);
  // OSM 20×20 の端に、面積 36% の PLATEAU の半分が入る（OSM 側の被覆は 18% で likelyCovered 未満）
  const env = measureOverlap(sq(0, 0, 20, 20), buildPlateauIndex([{ id: 'P', ring: sq(14, 0, 12, 12) }]));
  assert.ok(env.coveredFraction < 0.2 && env.maxPlateauInside >= 0.5 && env.maxPlateauInsideShare >= 0.3);
  assert.deepEqual({ ...classifyOverlap(env) }, { cls: C.LIKELY_DUPLICATE, rule: 'osm-envelops-plateau' });
});

test('[32O §8/§10] 選定: gap 内の VALID/AMBIGUOUS だけ採用。旧 fallback の除外理由を区別する', () => {
  const base = { metrics: { partnerIds: [] } };
  const { selected, removed } = selectFallback([
    { ...base, canonicalId: 'a', isOld: true, gapReason: 'hole', cls: C.VALID_FALLBACK },
    { ...base, canonicalId: 'b', isOld: true, gapReason: null, cls: C.CLEAR_DUPLICATE },
    { ...base, canonicalId: 'c', isOld: true, gapReason: null, cls: C.VALID_FALLBACK },
    { ...base, canonicalId: 'd', isOld: false, gapReason: 'sparse-mismatch', cls: C.AMBIGUOUS },
    { ...base, canonicalId: 'e', isOld: false, gapReason: 'hole', cls: C.LIKELY_DUPLICATE },
  ]);
  assert.deepEqual(selected.map((c) => c.canonicalId), ['a', 'd']);
  assert.deepEqual(removed.map((x) => [x.c.canonicalId, x.reason]), [['b', C.CLEAR_DUPLICATE], ['c', 'NOT_IN_PLATEAU_GAP']]);
});

test('[32O §3/§24] ビルダーは V1 footprint を読まず、共通座標・synced-dir-writer を使い、rmSync しない', () => {
  const raw = read('tools/build-osm-fallback-v2.js');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /canonical', 'buildings'\)|map-data', 'osaka-city', 'buildings'|latLonToJPRect|ward-poc-all-buildings/);
  assert.match(src, /'buildings-v2-corrected'/);
  assert.match(raw, /import \{ latLonToLiveCityWorld/);
  assert.match(src, /writeFilesVerified\(O2\.fallbackDir/);
  assert.match(src, /writeFilesVerified\(O2\.mergedDir/);
  assert.match(src, /syncedWrite: true/);
  assert.doesNotMatch(src, /fs\.rmSync\(/);
  assert.match(src, /PLACEMENT_NO_31E: '1'/);
  assert.match(src, /classifyPointToWard/);
});

test('[32O §13/§14] dev HTML: V2 + OLD OSM / V2 + NEW OSM を切替。V2N は derived-v2-osmv2 だけを読む', () => {
  const html = fs.readFileSync(HTML, 'utf-8');
  // [32P] 既定を V2N へ昇格 → [35E §2] V4 へ昇格。
  //   この test の主旨は「V2N の切替が残っていて derived-v2-osmv2 だけを読む」こと。
  assert.match(html, /let buildingsVersion = 'V4';/);
  assert.match(html, /\['V2', 'V2 \+ OLD OSM'/);
  assert.match(html, /\['V2N', 'V2 \+ NEW OSM'/);
  assert.match(html, /const BASE_V2_OSMV2 = BASE\.replace\(\/\\\/derived\$\/, '\/derived-v2-osmv2'\);/);
  // [Mission 34C] V3（回収分を足した namespace）を追加した。ここで守りたいのは
  //   「V2N は derived-v2-osmv2 だけを読む」ことなので、その対応だけを見る。
  // [Mission 35D] 版を足すたびに行全体の一致で落ちるので、V2N の割り当てだけを固定する。
  //   この test の主旨は「V2N が derived-v2-osmv2 を読む」ことの確認。
  assert.match(html, /const BUILDINGS_VERSION_BASE = \{[^}]*V2N: BASE_V2_OSMV2[^}]*\};/);
  assert.match(html, /const BASE_V2_OSMV2 = BASE\.replace\(\/\\\/derived\$\/, '\/derived-v2-osmv2'\);/);
  assert.match(html, /if \(layer === 'buildings' && buildingsVersion !== 'V1'\) return `\$\{buildingDataBase\(\)\}\/\$\{band\}\/buildings\/tile_/);
});

test('[32O §13/§19] runtime: V2N へ切替・同一 camera・scale 1・付帯データを V2N namespace から読む', async () => {
  const { runInlineScript } = require_('./_ward-ux-v1-smoke-harness.cjs');
  const boot = runInlineScript(HTML, { fetchRoot: path.join(ROOT, 'public') });
  assert.ok(boot.ok, boot.error && boot.error.message);
  const w = boot.window;
  const cam = w.camera ? JSON.stringify([w.camera.position.x, w.camera.position.y, w.camera.position.z]) : null;
  assert.equal((await w.__SET_BUILDINGS_VERSION__('V2N')).version, 'V2N');
  // [32P] 既定が V2N なので上の呼び出しは即 return する。起動時の付帯 manifest 読込（非同期）を待つ。
  for (let i = 0; i < 100 && !w.__BUILDINGS_VERSION_DEBUG__().wardIndexLoaded; i++) await new Promise((r) => setTimeout(r, 100));
  const d = w.__BUILDINGS_VERSION_DEBUG__();
  assert.equal(d.base, 'map-data/osaka-city/derived-v2-osmv2');
  assert.equal(d.osmFallback, 'osm-fallback-v2');
  assert.equal(JSON.stringify(d.buildingsGroupScale), '[1,1,1]');
  assert.equal(JSON.stringify(d.buildingsGroupRotation), '[0,0,0]');
  const published = fs.existsSync(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'));
  assert.equal(d.wardIndexLoaded, published);
  assert.equal(d.placementManifestLoaded, published);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  if (cam) assert.equal(JSON.stringify([w.camera.position.x, w.camera.position.y, w.camera.position.z]), cam);
  assert.equal((await w.__SET_BUILDINGS_VERSION__('V2')).base, 'map-data/osaka-city/derived-v2-corrected');
  assert.equal((await w.__SET_BUILDINGS_VERSION__('V1')).version, 'V1');
  assert.equal((await w.__SET_BUILDINGS_VERSION__('bogus')).version, 'V1');
  assert.ok(w.document.getElementById('buildings-version-V2N'));
});

test('[32O §23/§25] validator が PASS', { skip: skip(VALIDATION) }, () => {
  const v = rpt(VALIDATION);
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.classification, 'OSM_FALLBACK_V2_REBUILD_SUCCESS');
  assert.equal(v.plateauV2Mutation, 0);
  assert.equal(v.plateauCanonicalIdPreserved, true);
  assert.equal(v.oldFallbackNotUsedInV2Runtime, true);
  assert.equal(v.duplicateOverlapMeasured, true);
  assert.equal(v.newFallbackSelectedAgainstCorrectedV2, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('[32O §10/§15/§22] レポート: 件数・重複 KPI・区別・fixture が揃っている', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  assert.equal(r.plateauCount, 574112);
  assert.equal(r.oldOsmFallbackCount, 41505);
  assert.equal(r.newTotalBuildingCount, r.plateauCount + r.newOsmFallbackCount);
  // 32N §A は頂点平均の重心で 22,758（面積重心だと 22,771）
  assert.equal(r.duplicateKpi.before.overlapBuildingsVertexMeanCentroid, 22758, '32N の値を同じ基準で再現');
  assert.ok(r.duplicateKpi.after.excludingAmbiguous <= 50);
  for (const k of ['clear', 'likely', 'ambiguous', 'removed']) assert.equal(typeof r.duplicates[k], 'number', k);
  assert.equal(Object.keys(r.byWard).filter((k) => k !== 'none').length, 24);
  for (const w of Object.values(r.byWard)) for (const k of ['oldFallback', 'newFallback', 'removedDuplicate', 'retainedFallback', 'ambiguous']) assert.equal(typeof w[k], 'number');
  for (const s of ['umeda', 'honmachi', 'namba', 'tennoji', 'sumiyoshi', 'higashiyodogawa']) assert.ok(r.visualFixtures[s], s);
  assert.ok(r.picking && r.picking.fixtures.umeda);
  assert.equal(r.picking.fixtures.umeda.after.pointsHittingMultipleFootprints <= r.picking.fixtures.umeda.before.pointsHittingMultipleFootprints, true);
});
