// tests/building-canonical-v2-corrected.test.js
// [Mission 32N] CORRECTED BUILDING CANONICAL V2（生 CityGML → Live City 共通座標）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { latLonToLiveCityWorld, liveCityWorldToLatLon, LIVECITY_COORDINATE_SYSTEM_ID } from '../tools/lib/livecity-coordinate-system.js';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const REPORT = 'building-canonical-v2-corrected.json';
const VALIDATION = 'building-canonical-v2-corrected-validation.json';
const skip = (n) => (!rpt(n) && 'no report');
const HTML = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

test('[32N §4] 共通座標 module は config の equirect をそのまま使い、第7系を使わない', () => {
  const proj = rj(path.join(ROOT, 'config', 'areas', 'osaka-city.json')).projection;
  assert.equal(proj.type, 'local-equirectangular');
  assert.deepEqual(latLonToLiveCityWorld(proj.centerLat, proj.centerLon), { x: 0, z: -0 });
  // 北へ 0.01° → −Z に 1113.2m、東へ 0.01° → +X に cos(lat)·1113.2m
  const n = latLonToLiveCityWorld(proj.centerLat + 0.01, proj.centerLon);
  assert.ok(Math.abs(n.z + 1113.2) < 1e-6 && Math.abs(n.x) < 1e-9);
  const e = latLonToLiveCityWorld(proj.centerLat, proj.centerLon + 0.01);
  assert.ok(Math.abs(e.x - Math.cos((proj.centerLat * Math.PI) / 180) * 1113.2) < 1e-6);
  const back = liveCityWorldToLatLon(e.x, e.z);
  assert.ok(Math.abs(back.lon - (proj.centerLon + 0.01)) < 1e-12);
  assert.equal(LIVECITY_COORDINATE_SYSTEM_ID, 'livecity-equirect-znorth-neg-v1');
  const src = read('tools/lib/livecity-coordinate-system.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /JPRect/);
});

test('[32N §0/§3] V2 ビルダーは第7系・単純 rotation を使わず、共通 module と生 CityGML から作る', () => {
  const raw = read('tools/build-canonical-buildings-v2-corrected.js');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /latLonToJPRect|JPRect|convert-plateau-buildings|ward-poc-all-buildings/);
  assert.doesNotMatch(src, /rotate\w*\(/);
  assert.match(raw, /import \{ latLonToLiveCityWorld, LIVECITY_COORDINATE_SYSTEM_ID \} from '\.\/lib\/livecity-coordinate-system\.js'/);
  assert.match(src, /lod0FootPrint/);
  assert.match(src, /CityGML_v4\.zip/);
  // §11: 区は corrected 座標から再判定する
  assert.match(src, /representativePoint/);
  assert.match(src, /classifyPointToWard/);
});

test('[32N §14] V2 ビルダーは共有 derived 親を消さず、自分の出力を上書き＋検証で書く', () => {
  const src = read('tools/build-canonical-buildings-v2-corrected.js');
  // ディレクトリごとの削除はしない（OneDrive 競合で正規 tile を失うため）
  assert.doesNotMatch(src, /fs\.rmSync\(/);
  assert.match(src, /writeFilesVerified\(V2\.outDir,/);
  assert.match(src, /writeFilesVerified\(V2\.outAttrDir,/);
  assert.match(src, /syncedWrite: true/);
  const lib = read('tools/lib/synced-dir-writer.js');
  // 消すのは対象ディレクトリ直下の「期待外の通常ファイル」だけ（再帰削除しない）
  assert.doesNotMatch(lib, /recursive: true, force/);
  const derived = read('tools/build-derived-geometry.js');
  assert.match(derived, /STRICT_TILE_RE\.test\(f\)/);
  const side = read('tools/build-buildings-v2-corrected-sidecars.js');
  for (const m of side.matchAll(/fs\.rmSync\((.+?), \{ recursive/g)) assert.equal(m[1].trim(), 'pubPlacement');
});

test('[32N §16/§31] development HTML に V1/V2 切替がある（既定は 32P で V2N、35E で V4 へ昇格）', () => {
  const html = fs.readFileSync(HTML, 'utf-8');
  // この test の主旨は「V1/V2 の切替が残っている」こと。既定の版名は固定しない。
  assert.match(html, /let buildingsVersion = '(V2N|V3|V4)';/);
  assert.match(html, /BUILDINGS V2 CORRECTED/);
  assert.match(html, /const BASE_V2_CORRECTED = BASE\.replace\(\/\\\/derived\$\/, '\/derived-v2-corrected'\);/);
  // tile cache key に版が入る（同じ tx/tz の V1/V2 を混ぜない）
  assert.match(html, /\+ '#' \+ buildingsVersion\)/);
});

test('[32N §16/§23] runtime: V2 へ切替えても camera・scale・rotation は変わらず、V1 へ戻せる', async () => {
  const { runInlineScript } = require_('./_ward-ux-v1-smoke-harness.cjs');
  const boot = runInlineScript(HTML, { fetchRoot: path.join(ROOT, 'public') });
  assert.ok(boot.ok, boot.error && boot.error.message);
  const w = boot.window;
  // [32P] 既定 V2N → [35E §2] V4。この test の主旨は「切替しても camera/scale/rotation が変わらない」こと。
  assert.equal(w.__BUILDINGS_VERSION_DEBUG__().version, 'V4');
  const cam = w.camera ? [w.camera.position.x, w.camera.position.y, w.camera.position.z] : null;
  const r = await w.__SET_BUILDINGS_VERSION__('V2');
  assert.equal(r.version, 'V2');
  const d = w.__BUILDINGS_VERSION_DEBUG__();
  assert.equal(d.base, 'map-data/osaka-city/derived-v2-corrected');
  // vm 内の配列は別 realm なので JSON で比べる
  assert.equal(JSON.stringify(d.buildingsGroupScale), '[1,1,1]');
  assert.equal(JSON.stringify(d.buildingsGroupRotation), '[0,0,0]');
  const v2Published = fs.existsSync(path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-corrected', 'building-ward-index.json'));
  assert.equal(d.wardIndexLoaded, v2Published);
  assert.equal(d.placementManifestLoaded, v2Published);
  assert.equal(w.__CANONICAL_SELF_CHECK__().total, 0);
  if (cam) assert.equal(JSON.stringify([w.camera.position.x, w.camera.position.y, w.camera.position.z]), JSON.stringify(cam));
  assert.equal((await w.__SET_BUILDINGS_VERSION__('V1')).version, 'V1');
  assert.equal(w.__BUILDINGS_VERSION_DEBUG__().base, 'map-data/osaka-city/derived');
  assert.ok(w.document.getElementById('buildings-version-V1'));
  assert.ok(w.document.getElementById('buildings-version-V2'));
});

test('[32N §28] production / protected HTML は 32N の変更対象に含まれない', () => {
  for (const rel of ['tools/build-canonical-buildings-v2-corrected.js', 'tools/build-buildings-v2-corrected-sidecars.js', 'tools/audit/building-canonical-v2-corrected.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /osaka_3d_buildings\.html|fullward-v3\.html/, rel);
  }
});

test('[32N §26] validator が PASS', { skip: skip(VALIDATION) }, () => {
  const v = rpt(VALIDATION);
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.classification, 'CORRECTED_BUILDING_CANONICAL_SUCCESS');
  assert.equal(v.canonicalV1Mutation, 0);
  assert.equal(v.canonicalV2Count, 615617);
  assert.equal(v.canonicalIdPreserved, true);
  assert.equal(v.zone7UsedInCorrectedPipeline, false);
  assert.equal(v.commonCoordinateSystemUsed, true);
  assert.equal(v.rawLatLonTruthUsed, true);
  assert.equal(v.inverseDerivedTruthUsed, false);
  assert.equal(v.wardReassignedFromCorrectedCoordinates, true);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('[32N §7/§8/§9] 615,617 件・生 lat/lon と丸め誤差内で一致・rotation≈0 / scale≈1', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  assert.equal(r.count.v2, 615617);
  assert.equal(r.count.canonicalIdPreserved, true);
  assert.equal(r.count.build.missingPlateau, 0);
  assert.equal(r.rawTruthError.plateauChecked, 574112);
  assert.equal(r.rawTruthError.unmatched, 0);
  assert.ok(r.rawTruthError.maxM <= 0.01, String(r.rawTruthError.maxM));
  assert.ok(Math.abs(r.coordinate.rotationBefore.rotationDeg) > 0.8, 'V1 の回転が測れていない');
  assert.ok(Math.abs(r.coordinate.rotationAfter.rotationDeg) < 0.01);
  assert.ok(Math.abs(r.coordinate.scaleAfter - 1) < 1e-4);
  assert.ok(Math.hypot(r.coordinate.rotationAfter.tx, r.coordinate.rotationAfter.tz) < 0.05);
});

test('[32N §10/§12] 梅田の OSM 重なりと区判定が改善し、住吉は悪化しない', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  assert.ok(r.osmOverlap.umeda.v2 > r.osmOverlap.umeda.v1);
  assert.ok(r.osmOverlap.sumiyoshi.v2 >= r.osmOverlap.sumiyoshi.v1);
  assert.ok(r.ward.correctedAccuracy > r.ward.oldAccuracy);
  assert.ok(r.ward.kita.correctedAccuracy > r.ward.kita.oldAccuracy);
});

test('[32N §25] レポートに必要な項目が揃っている', { skip: skip(REPORT) }, () => {
  const r = rpt(REPORT);
  for (const k of ['count', 'coordinate', 'rawTruthError', 'osmOverlap', 'ward', 'roadOverlap', 'waterOverlap', 'gsiBuildingAlignment', 'landBlockContainment', 'performance']) assert.ok(r[k] != null, k);
  for (const k of ['rotationBefore', 'rotationAfter', 'scaleBefore', 'scaleAfter']) assert.ok(r.coordinate[k] != null, k);
  for (const k of ['umeda', 'sumiyoshi', 'otherFixtures']) assert.ok(r.osmOverlap[k] != null, k);
  for (const k of ['oldAccuracy', 'correctedAccuracy']) assert.ok(r.ward[k] != null, k);
  for (const k of ['fix13', 'V2', 'V3']) assert.ok(r.roadOverlap[k] != null, k);
  // §18: V1/V2 の両方をこの場で測っている
  for (const k of ['fix13', 'V2', 'V3']) { assert.equal(typeof r.roadOverlap[k].v1, 'number'); assert.equal(typeof r.roadOverlap[k].v2, 'number'); }
  // §24: near は V1 と同じ件数構成（fallback は同一・PLATEAU は同一頂点数）
  assert.equal(r.performance.v2.near.features, r.performance.v1.near.features);
});
