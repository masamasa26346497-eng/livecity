// tests/coordinate-system-authority.test.js
// [Mission 31G-FIX11] Live City 座標系の正本性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] canonical の生成物が無い素のチェックアウトでは検証対象が無いので skip（assertion 失敗では skip しない）
const CANONICAL_SKIP = skipIfMissingRel('data/processed/osaka-city/canonical/buildings/manifest.json');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rpt = (n) => { try { return JSON.parse(fs.readFileSync(R('data', 'reports', n), 'utf-8')); } catch { return null; } };

test('[FIX11 §27] coordinate-system-authority validator が PASS', { skip: !rpt('coordinate-system-authority-validation.json') && 'no report' }, () => {
  const v = rpt('coordinate-system-authority-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.wrongZoneUsage, 0);
  assert.equal(v.checks.inferredOriginDependency, 0);
  assert.equal(v.checks.layerSpecificProjection, 0);
  assert.equal(v.checks.runtimeDoubleTransform, 0);
  assert.equal(v.checks.coordinateConventionMismatch, 0);
  assert.equal(v.checks.crsUndocumented, 0);
});

test('[FIX11 §2/§3] PLATEAU source CRS = EPSG:6697（地理座標・実ファイル名から）', { skip: !rpt('coordinate-system-authority-audit.json') && 'no audit' }, () => {
  const a = rpt('coordinate-system-authority-audit.json');
  assert.match(a.plateauSourceCRS, /EPSG:6697/);
  assert.match(a.coordinatePipelineByLayer['PLATEAU buildings (source)'].sourceCRS, /6697/);
});

test('[FIX11 §4/§13] 現行 canonical 建物 = local-equirectangular（N03 行政界と 99.9%+ 一致・world 自己整合 0m）', { skip: !rpt('coordinate-system-authority-audit.json') && 'no audit' }, () => {
  const a = rpt('coordinate-system-authority-audit.json');
  assert.ok(a.wardMembership.matchPct >= 99.9, 'N03 一致率 ' + a.wardMembership.matchPct + '%');
  assert.ok(a.wardMembership.outsideAllWards <= 3, '行政界外 ' + a.wardMembership.outsideAllWards + '（境界建物のみ許容）');
  assert.ok(a.wardMembership.worldSelfConsistencyM.median < 0.5, 'world 自己整合 ' + a.wardMembership.worldSelfConsistencyM.median + 'm');
});

test('[FIX11 §12/§21/§28] 第6系/第7系は現行 equirect より誤差が大きい → V2 不採用', { skip: !rpt('coordinate-system-authority-audit.json') && 'no audit' }, () => {
  const a = rpt('coordinate-system-authority-audit.json');
  const pc = a.projectionComparison;
  assert.ok(pc.zone6Error.median > pc.currentError_equirect.max, '第6系 ' + pc.zone6Error.median + 'm > 現行 ' + pc.currentError_equirect.max + 'm');
  assert.ok(pc.zone7Error.median > pc.currentError_equirect.max);
  assert.equal(a.v2Adopted, false);
  assert.equal(a.rebuilt, false);
  assert.match(a.RESULT, /CURRENT-PROJECTION-CORRECT-KEEP/);
});

test('[FIX11 §7/§14] building ↔ tran road（同一 PLATEAU 事業）の相対変位が小さい', { skip: !rpt('coordinate-system-authority-audit.json') && 'no audit' }, () => {
  const a = rpt('coordinate-system-authority-audit.json');
  const br = a.buildingTranRoadRelative;
  assert.ok(Math.abs(br.medianDx) <= 4 && Math.abs(br.medianDz) <= 4, 'dx/dz ' + br.medianDx + '/' + br.medianDz);
});

test('[FIX11 §1] coordinate-config.json（第7系）は現行 pipeline 未接続と明記', () => {
  const cfg = JSON.parse(fs.readFileSync(R('data', 'buildings', 'coordinate-config.json'), 'utf-8'));
  assert.ok(cfg._deprecated, '_deprecated note が必要');
  assert.match(cfg._deprecated, /未接続|local-equirectangular/);
  // 元フィールドは保持（convert-plateau-buildings.js 互換）
  assert.equal(cfg.coordinateMode, 'geographic-jprect');
  assert.equal(cfg.jprectZone, 7);
});

test('[FIX11 §22/§23/§24] geometry / placement policy / conflict は不変（再build なし）', { skip: CANONICAL_SKIP }, () => {
  const m = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'), 'utf-8'));
  assert.equal(m.featureCount, 615617);
  const a = rpt('coordinate-system-authority-audit.json');
  assert.match(a.placementPolicyImpact, /なし|不変/);
});
