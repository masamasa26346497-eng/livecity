// tests/mission35y-precise-building-picking.test.js
// [Mission 35Y §19] 建物 picking。
//   守りたいのは「三角形から建物 ID を引いていること」と
//   「bbox だけ / 一番近い centroid だけで選ばないこと」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission35y-precise-building-picking');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const pickFn = () => html.match(/function pickBuilding\(rayObj\) \{[\s\S]*?\n  \}/)[0];
const fromHit = () => html.match(/function buildingFromHit\(hit\) \{[\s\S]*?\n  \}/)[0];

// ── §2/§4 1 棟単位 ID を merged geometry でも保持する ──────────────
test('[35Y §2/§4] 三角形 → 建物 の対応表を mesh が持っている', () => {
  // 建て込み側: 建物ごとに三角形の範囲を記録している
  assert.match(html, /const triBefore = bucket\.pos\.length \/ 9;/);
  assert.match(html, /const triAfter = bucket\.pos\.length \/ 9;/);
  assert.match(html, /for \(let t = triBefore; t < triAfter; t\+\+\) bucket\.tri\.push\(bIdx\);/);
  // mesh 側: typed array で保持（draw call も三角形も増やさない）
  assert.match(html, /m\.userData\.crTriBuilding = \(bucket\.fps\.length < 65535\)/);
  assert.match(html, /Uint16Array\.from\(bucket\.tri/);
  assert.match(html, /Uint32Array\.from\(bucket\.tri/);
  assert.match(html, /m\.userData\.crBuildingFps = bucket\.fps;/);
  // footprint が無い建物は「当たっても建物なし」にする番兵
  assert.match(html, /m\.userData\.crTriEmpty =/);
});

test('[35Y §2] footprint が無い建物は pick しても何も返さない', () => {
  const b = fromHit();
  assert.match(b, /if \(bi !== ud\.crTriEmpty\)/);
  assert.match(b, /return null;              \/\/ この三角形は建物に紐づかない/);
});

// ── §3 picking 方式 ────────────────────────────────────────────
test('[35Y §3] raycast の faceIndex から建物を引いている', () => {
  const b = fromHit();
  assert.match(b, /ud\.crTriBuilding\[hit\.faceIndex\]/);
  assert.match(b, /pickStats\.byFace\+\+/);
});

test('[35Y §3] bbox だけ / 一番近い centroid だけでは選ばない', () => {
  const p = pickFn() + fromHit();
  // 旧実装にあった「一番近い centroid を採る」処理が消えていること
  assert.ok(!/let fp = null, fpD = Infinity;/.test(html), '最近傍 centroid 方式が残っている');
  assert.ok(!/if \(d < fpD\) \{ fpD = d; if \(!fp\) fp = f; \}/.test(html), 'centroid fallback が残っている');
  assert.ok(!/fpD > 90000/.test(html), '300m の centroid fallback が残っている');
  // fallback は point-in-polygon のみ
  assert.match(p, /pointInRing\(px, pz, f\.ring\)/);
  assert.match(p, /centroid は使わない/);
});

test('[35Y §3-C] 対応表を持たない mesh のときだけ footprint 判定へ落ちる', () => {
  const b = fromHit();
  // faceIndex が使えるなら、そこで必ず決着させる（polygon へは行かない）
  const faceBlock = b.slice(0, b.indexOf('// C:'));
  assert.match(faceBlock, /if \(ud && ud\.crTriBuilding && hit\.faceIndex != null\)/);
  assert.match(faceBlock, /return null;/);
  assert.match(b, /pickStats\.byPolygon\+\+/);
});

// ── §5 footprint 形状（穴 / 凹） ────────────────────────────────
test('[35Y §5] 屋根は穴を抜いて三角形化されている（中庭では当たらない）', () => {
  // pushExtrude が hole を渡して triangulateShape している＝穴の三角形が存在しない
  assert.match(html, /const holes = \[\];/);
  assert.match(html, /for \(let k = 1; k < poly\.length; k\+\+\) if \(poly\[k\] && poly\[k\]\.length >= 3\) holes\.push\(ringVec2\(poly\[k\]\)\);/);
  assert.match(html, /THREE\.ShapeUtils\.triangulateShape\(contour, holes\)/);
  // MultiPolygon も 1 建物として扱う（polys を回して同じ建物へ積む）
  assert.match(html, /const polys = geometryType === 'Polygon' \? \[coordinates\] : coordinates;/);
});

// ── §6 屋根と壁の両方 ──────────────────────────────────────────
test('[35Y §6] 屋根でも壁でも同じ経路で同じ建物になる', () => {
  const p = pickFn();
  // 面の向きで分岐していない（どちらも同じ faceIndex 経路）
  assert.match(p, /const fp = buildingFromHit\(hit\);/);
  // 内訳を数えているだけで、判定は分けていない
  assert.match(p, /pickStats\.roofHits\+\+; else pickStats\.wallHits\+\+;/);
});

// ── §8 hover と click が同じ ───────────────────────────────────
test('[35Y §8] hover と click が同じ pick 関数を通る', () => {
  // どちらも pickHit() → CanonicalRuntime.pickBuilding()
  assert.match(html, /const h=pickHit\(e\);/);
  assert.equal((html.match(/CanonicalRuntime\.pickBuilding\(ray\)/g) || []).length, 1,
    'pickBuilding の呼び出し口が 1 つでない（hover と click で別経路になっている）');
});

test('[35Y §7] hover の highlight は bbox ではなく footprint に沿う', () => {
  assert.match(html, /const P = building\.fp, n = P\.length;/);
  assert.match(html, /屋上（fan三角形分割/);
  // 大きな四角を出していない
  assert.ok(!/new THREE\.BoxGeometry\([^)]*\);\s*\/\/\s*hover/i.test(html));
});

// ── §12 タイル境界の重複 ───────────────────────────────────────
test('[35Y §12] 同じ canonicalId を 2 回返さない', () => {
  assert.match(html, /const seen = new Set\(\);/);
  assert.match(html, /if \(seen\.has\(f\.canonicalId\)\) continue;/);
  assert.match(html, /seen\.add\(f\.canonicalId\);/);
  // pick 側は手前の 1 枚で決着する
  assert.match(pickFn(), /同じ canonicalId がタイル境界で重複していても、採るのは手前の 1 枚だけ/);
});

// ── §14 hover 性能 ─────────────────────────────────────────────
test('[35Y §14] mousemove ごとに全部 traverse し直さない', () => {
  assert.match(html, /function pickCandidateMeshes\(\) \{/);
  assert.match(html, /if \(pickMeshCache && pickMeshCacheKey === key\) return pickMeshCache;/);
  assert.match(html, /function invalidatePickCache\(\)/);
  // タイルが変わったらキャッシュを捨てる
  assert.match(html, /if \(job\.layer === 'buildings'\) invalidatePickCache\(\);/);
  // 60 万棟を毎回 raycast していない（候補は見えている建物 mesh のみ）
  assert.match(html, /layerGroup\.buildings\.traverse\(\(o\) => \{/);
});

test('[35Y] picking の内訳を外から測れる', () => {
  assert.match(html, /getPickDebug: \(\) => \(\{ \.\.\.pickStats \}\)/);
  assert.match(html, /const pickStats = \{ calls: 0, byFace: 0, byPolygon: 0, miss: 0/);
});

// ── §0 production / protected ──────────────────────────────────
test('[35Y §0] production / protected は変更していない', () => {
  for (const [n, p] of [['production', PROD], ['protected', PROT]]) {
    const s = fs.readFileSync(p, 'utf-8');
    assert.ok(!/crTriBuilding/.test(s), n + ' に 35Y が入っている');
    assert.ok(!/UrbanDetailLayer/.test(s), n + ' に 35X が入っている');
  }
});

// ── §17 自動 QA の結果 ─────────────────────────────────────────
test('[35Y §17] 実機: 100 棟規模の hover で success 95% 以上',
  { skip: !fs.existsSync(path.join(REPORT, 'picking-after.json')) && 'no report' }, () => {
    const a = rj(path.join(REPORT, 'picking-after.json')).summary;
    assert.equal(a.jsErrors, 0, 'JS 例外がある');
    assert.ok(a.samples >= 200, '標本が少なすぎる: ' + a.samples);
    assert.ok(a.successRate >= 95, 'success rate が目標未満: ' + a.successRate + '%');
    assert.ok(a.wrongNeighborRate <= 3, '隣を拾う率が高い: ' + a.wrongNeighborRate + '%');
    // §6 壁でも屋根でも当たる
    assert.ok(a.byKind.wall >= 90, '壁の成功率が低い: ' + a.byKind.wall + '%');
    assert.ok(a.byKind.center >= 90, '中央の成功率が低い: ' + a.byKind.center + '%');
    // §13 小さい建物も拾える
    assert.ok(a.smallBuildings.successRate >= 90, '小さい建物の成功率が低い: ' + a.smallBuildings.successRate + '%');
    // §12 重複ゼロ
    assert.equal(a.duplicateFootprints, 0, 'footprint が重複している: ' + a.duplicateFootprints);
    // §3 faceIndex で決着していて、polygon fallback に頼っていない
    assert.ok(a.pickBy.byFace > 0, 'faceIndex で引けていない');
    assert.equal(a.pickBy.byPolygon, 0, 'polygon fallback に落ちている: ' + a.pickBy.byPolygon);
    // 真上からの ray（遮蔽が起こり得ない）では取りこぼしゼロ
    assert.equal(a.verticalAgreement.wrong, 0, '真上からの pick が外れている');
    assert.equal(a.verticalAgreement.nohit, 0, '真上からの pick が当たらない');
  });

test('[35Y §20] hover 性能が落ちていない',
  { skip: (!fs.existsSync(path.join(REPORT, 'picking-before.json'))
    || !fs.existsSync(path.join(REPORT, 'picking-after.json'))) && 'no before/after' }, () => {
    const b = rj(path.join(REPORT, 'picking-before.json')).summary;
    const a = rj(path.join(REPORT, 'picking-after.json')).summary;
    assert.ok(a.hoverFpsAvg >= b.hoverFpsAvg * 0.90,
      'hover 中の FPS が 10% 超で落ちた: ' + b.hoverFpsAvg + ' → ' + a.hoverFpsAvg);
    assert.ok(a.pointerMsAvg <= b.pointerMsAvg * 1.25,
      'pointer handler が重くなった: ' + b.pointerMsAvg + ' → ' + a.pointerMsAvg);
    // 直したこと自体の確認
    assert.ok(a.successRate > b.successRate, 'success rate が改善していない');
  });
