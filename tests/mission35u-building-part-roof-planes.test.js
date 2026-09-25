// tests/mission35u-building-part-roof-planes.test.js
// [Mission 35U §10] building part 判定と、点群からの平面屋根。
//   いちばん大事なのは「canonical 建物全体を置き換えない」こと。
//   building part なので canonical 全体の LOD1 は絶対に消さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const BUILDER = path.join(ROOT, 'tools', 'experiments', 'mission35u_build_part_roof_planes.py');
const PATCH = path.join(ROOT, 'tools', 'experiments', 'mission35s_patch_dev.py');
const DATA = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'experimental', 'mission35u',
  'part-roof-planes-267613423.json');
const REPORT_DIR = path.join(ROOT, 'data', 'reports', 'mission35u-building-part-roof-planes');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);

// ── §1 building part 判定 ─────────────────────────────────────────
test('[35U §1] part 判定の条件が生成元に書かれている', () => {
  const b = read(BUILDER);
  assert.match(b, /'sourceCoveredRatioMin': 0\.90/);
  assert.match(b, /'candidateCoveredRatio': \(0\.25, 0\.75\)/);
  assert.match(b, /def decide_building_part\(metrics: dict\) -> dict:/);
  // 断定できないときは止める
  assert.match(b, /PART_UNCERTAIN/);
  assert.match(b, /BUILDING_PART_CANDIDATE/);
});

test('[35U §1] 実データ: way 267613423 は building part と判定された', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  const p = d.buildingPart;
  assert.equal(p.verdict, 'BUILDING_PART_CANDIDATE', JSON.stringify(p.failed));
  assert.deepEqual(p.failed, []);
  // 5 つの条件すべてを満たしている
  for (const [k, v] of Object.entries(p.checks)) assert.equal(v, true, k);
  assert.equal(d.source.osmWayId, 267613423);
});

test('[35U §1] 全体マッチと part を取り違えていない', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  // 35T の判定は UNMATCHED（= 建物全体としては一致していない）
  assert.equal(d.buildingPart.mission35tConfidence, 'UNMATCHED');
  // それでも part としては扱う。関係は PART_OF_CANONICAL
  assert.equal(d.match.relation, 'PART_OF_CANONICAL');
  // 公式 LOD2 を名乗らない
  assert.equal(d.officialPlateauLod2, false);
  assert.equal(d.status, 'EXPERIMENTAL_POINT_CLOUD_PLANAR_ROOF');
  assert.match(d.note, /公式 PLATEAU LOD2 ではない/);
});

// ── §2 点群 ───────────────────────────────────────────────────────
test('[35U §2] 屋根は「上から見た一番上の面」で取る', () => {
  const b = read(BUILDER);
  // 近傍の高さのばらつきで切る方式は、高い棟そのものを捨てるのでやめた
  assert.ok(!/TREE_LOCAL_STD_M/.test(b), '樹木判定の旧しきい値が残っている');
  assert.match(b, /TOP_SURFACE_CELL_M = /);
  assert.match(b, /TOP_SURFACE_BAND_M = /);
  assert.match(b, /CELL_SPIKE_M = /);
  assert.match(b, /ISOLATION_MIN_NEIGHBORS/);
  assert.match(b, /OUTLIER_LOW_Q|OUTLIER_HIGH_Q/);
});

test('[35U §2] 実データ: 屋根候補点が 35S の 40 点から大きく増えた', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  const pc = d.pointCloud;
  assert.ok(pc.roofCandidatePoints >= 500, '屋根候補点が ' + pc.roofCandidatePoints + ' 点しかない');
  assert.ok(pc.roofCandidatePoints > 40 * 10, '35S の 40 点から 10 倍も増えていない');
  // 何をどれだけ落としたか残っている
  for (const k of ['inFootprint', 'droppedGround', 'droppedHeightOutlier',
    'droppedBelowTopSurface', 'topSurfacePoints', 'droppedIsolated']) {
    assert.ok(pc[k] !== undefined, k + ' が無い');
  }
  assert.ok(pc.droppedBelowTopSurface > 0, '壁面の反射を 1 点も落としていない');
});

// ── §3 平面 ───────────────────────────────────────────────────────
test('[35U §3] RANSAC の support しきい値がある', () => {
  const b = read(BUILDER);
  assert.match(b, /PLANE_MIN_SUPPORT = /);
  assert.match(b, /PLANE_MIN_SUPPORT_FRAC = /);
  assert.match(b, /RANSAC_TOL_M = /);
  assert.match(b, /def ransac_planes\(/);
  assert.match(b, /def plane_metrics\(/);
});

test('[35U §3] 実データ: 平面ごとに support / slope / RMS が出ている', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  const r = d.roof;
  assert.ok(r.planeCount >= 2, '平面が ' + r.planeCount + ' 面しかない');
  assert.ok(r.minSupport >= 1);
  for (const p of r.planes) {
    for (const k of ['support', 'normal', 'slopeDeg', 'rmsErrorM', 'bbox', 'polygonAreaM2', 'triangles']) {
      assert.ok(p[k] !== undefined, 'plane に ' + k + ' が無い');
    }
    // support のしきい値を下回る面は残っていない
    assert.ok(p.support >= r.minSupport, 'support ' + p.support + ' < ' + r.minSupport);
    // 当てはまりが悪い面は残っていない
    assert.ok(p.rmsErrorM <= 0.5, 'RMS が大きすぎる: ' + p.rmsErrorM);
    assert.equal(p.normal.length, 3);
  }
});

// ── §4 分類 ───────────────────────────────────────────────────────
test('[35U §4] 分類できないときは UNKNOWN_PLANAR_ROOF に留める', () => {
  const b = read(BUILDER);
  assert.match(b, /UNKNOWN_PLANAR_ROOF/);
  assert.match(b, /FLAT_ROOF/);
  assert.match(b, /def classify_roof\(planes\)/);
  // 無理に切妻・寄棟へ決めない
  assert.ok(!/GABLE|HIP_ROOF/.test(b), '根拠なく切妻・寄棟へ決めている');
});

test('[35U §4/§5] 実データ: 屋根と壁の両方があり、footprint からはみ出さない', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  const g = d.geometry;
  assert.ok(g.roofTriangles > 0, '屋根の三角形が無い');
  assert.ok(g.wallTriangles > 0, '壁の三角形が無い');
  assert.equal(g.triangleCount, g.roofTriangles + g.wallTriangles);
  const kinds = g.groups.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['roof', 'wall']);
  // §8 footprint containment
  assert.equal(d.containment.ok, true, JSON.stringify(d.containment));
  assert.equal(d.containment.outsideFootprint, 0, 'footprint の外へ出ている頂点がある');
  assert.ok(['FLAT_ROOF', 'STEPPED_FLAT_ROOF', 'UNKNOWN_PLANAR_ROOF'].includes(d.roof.type));
});

test('[35U] 実データ: 単純三角形化より面が増え、平面でならされている', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  // 35S の RAW は 103 三角形・40 支持点。35U は平面ごとに polygon 化している。
  assert.ok(d.geometry.triangleCount > 103, '三角形が 35S(103) より増えていない: ' + d.geometry.triangleCount);
  // 平面へ当てはめているので、面ごとの RMS が小さい
  const worst = Math.max(...d.roof.planes.map((p) => p.rmsErrorM));
  assert.ok(worst <= 0.5, '平面の当てはまりが悪い（ギザギザのまま）: ' + worst);
});

// ── §7 suppression ────────────────────────────────────────────────
test('[35U §7] canonical 建物全体の LOD1 は絶対に消さない', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35U] PlanarRoofLayer')) return;
  // 35U 側は常に false
  const i = s.indexOf('const PlanarRoofLayer');
  const block = s.slice(i, s.indexOf('window.__PLANAR_ROOF_LAYER__', i));
  assert.match(block, /function isSuppressedBuilding\(\) \{ return false; \}/);
  assert.match(block, /lod1SuppressionAllowed: false/);
});

test('[35U §7] 実データ: suppression を許可していない', { skip: !fs.existsSync(DATA) && 'no data' }, () => {
  const d = rj(DATA);
  assert.equal(d.match.lod1SuppressionAllowed, false);
  assert.match(d.match.suppressionNote, /LOD1 は消さない/);
});

// ── §6 dev 表示 ───────────────────────────────────────────────────
test('[35U §6] RAW / PLANAR / BOTH の表示モードと別色ラベル', () => {
  const s = read(DEV);
  if (!s.includes('[Mission 35U] PlanarRoofLayer')) return;
  assert.match(s, /const MODES = \['RAW', 'PLANAR', 'BOTH'\];/);
  assert.match(s, /const LABEL_TEXT = '35U PLANAR ROOF';/);
  // 35S の青（0x2f9bff）と違う色
  assert.match(s, /const QA_COLOR = \{ roof: 0x35d17a, wall: 0x1b7a4b \}/);
  assert.match(s, /CR_planarRoof_35U_mesh/);
  assert.match(s, /CR_planarRoof_35U_label/);
  assert.match(s, /__PLANAR_ROOF_MODE__/);
  // RAW のときは 35S 側だけを出す
  assert.match(s, /if \(mode === 'RAW'\) return false;/);
  assert.match(s, /window\.__CUSTOM_LOD2_LAYER__\.setEnabled\(mode !== 'PLANAR'\)/);
});

test('[35U] 生成元にも入っている（再生成で戻らない）', () => {
  const p = read(PATCH);
  assert.match(p, /const PlanarRoofLayer = \(function/);
  assert.match(p, /35U PLANAR ROOF/);
  assert.match(p, /LAYER = LAYER\.replace\('__MISSION35U_LAYER__', LAYER_35U\)/);
});

// ── §0 production / protected ─────────────────────────────────────
test('[35U §0] production / protected は変更していない', () => {
  const base = rj(path.join(ROOT, 'data', 'reports', 'baselines', 'prod-protected-hashes.json'));
  const build = rj(path.join(ROOT, 'data', 'reports', 'production-cutover-build.json'));
  if (build && build.productionSha256) assert.equal(sha(PROD), build.productionSha256, 'production が変わっている');
  if (base && base.prot) assert.equal(sha(PROT), base.prot, 'protected が変わっている');
  assert.ok(!read(PROD).includes('PlanarRoofLayer'), 'production に試作レイヤーが入っている');
  assert.ok(!read(PROT).includes('PlanarRoofLayer'), 'protected に試作レイヤーが入っている');
});

// ── §8 実機 QA ────────────────────────────────────────────────────
test('[35U §8] 実機: 3 視点でモードが効き、LOD1 を消していない',
  { skip: !fs.existsSync(path.join(REPORT_DIR, 'browser-qa.json')) && 'no report' }, () => {
    const q = rj(path.join(REPORT_DIR, 'browser-qa.json')).summary;
    assert.equal(q.jsErrors, 0);
    assert.deepEqual(q.views, ['oblique', 'top-down', 'side']);
    assert.equal(q.rawModeShowsRawOnly, true, 'RAW モードで planar が出ている');
    assert.equal(q.planarModeShowsPlanarOnly, true, 'PLANAR モードで raw が出ている');
    assert.equal(q.bothModeShowsBoth, true, 'BOTH モードで両方出ていない');
    assert.equal(q.lod1NeverSuppressed, true, 'canonical 全体の LOD1 を消している');
    assert.equal(q.planarInViewAllViews, true, '平面屋根が画面に入っていない視点がある');
    assert.equal(q.partVerdict, 'BUILDING_PART_CANDIDATE');
    assert.ok(q.planarTriangles > q.rawTriangles, 'planar が raw より面が少ない');
    assert.equal(q.containment.ok, true);
    // 撮影のために隠した canonical 建物を毎回戻している（§7 の suppression とは別物）
    assert.equal(q.buildingsRestored, true, '隠した canonical 建物を戻せていない');
  });
