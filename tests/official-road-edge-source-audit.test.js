// tests/official-road-edge-source-audit.test.js
// [Mission 31G-FIX14] Official Road Edge Source Acquisition Audit。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ROAD_FEATURE_COUNT } from "../tools/lib/canonical-baseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

test('[FIX14 §22] official-road-edge-source-audit validator が PASS', { skip: !rpt('official-road-edge-source-audit-validation.json') && 'no report' }, () => {
  const v = rpt('official-road-edge-source-audit-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors || []));
  assert.equal(v.checks.requiredFieldsMissing, 0);
  assert.equal(v.checks.adoptionDecisionValid, true);
  assert.equal(v.checks.noUniformBufferHack, true);
  assert.equal(v.checks.productionUnchanged, true);
  assert.equal(v.checks.protectedUnchanged, true);
});

test('[FIX14 §20] official-road-edge-source-audit.json に必須フィールドが全て存在する', { skip: !rpt('official-road-edge-source-audit.json') && 'no audit' }, () => {
  const a = rpt('official-road-edge-source-audit.json');
  for (const f of ['sourcesChecked', 'usableSources', 'rejectedSources', 'coverage', 'license', 'commercialUse', 'geometryType', 'accuracy', 'updateFrequency', 'sampleResults', 'majorRoadWidths', 'recommendedSource', 'adoptionDecision']) {
    assert.ok(f in a, '必須フィールドが無い: ' + f);
  }
  assert.ok(Array.isArray(a.sourcesChecked) && a.sourcesChecked.length >= 5, '§1 の調査対象 A-G のうち最低限を満たしていない');
});

test('[FIX14 §1/§4] GSI 基盤地図情報 道路縁を調査している', { skip: !rpt('official-road-edge-source-audit.json') && 'no audit' }, () => {
  const a = rpt('official-road-edge-source-audit.json');
  const gsi = a.sourceDetail.find((s) => s.id === 'gsi-kiban-road-edge');
  assert.ok(gsi, 'GSI 基盤地図情報が調査対象に無い');
  assert.match(gsi.geometryType, /line/);
  assert.ok(gsi.sources && gsi.sources.length > 0, '一次情報 URL が記録されていない');
});

test('[FIX14 §5] 大阪市道路台帳を調査し、Web閲覧のみ（download/API不可）と記録している', { skip: !rpt('official-road-edge-source-audit.json') && 'no audit' }, () => {
  const a = rpt('official-road-edge-source-audit.json');
  const ledger = a.sourceDetail.find((s) => s.id === 'osaka-city-road-ledger');
  assert.ok(ledger, '大阪市道路台帳が調査対象に無い');
  assert.match(ledger.apiOrDownload, /download不可/);
});

test('[FIX14 §0/§18] 未採用パス: FIX13 の canonical / building geometry が完全に不変', { skip: !rpt('official-road-edge-source-audit.json') && 'no audit' }, () => {
  const a = rpt('official-road-edge-source-audit.json');
  if (a.adoptionDecision !== 'OFFICIAL_SOURCE_ADOPTED') {
    assert.equal(a.fix13GeometryUnchanged, true);
    assert.equal(a.canonicalRoadSourceGeometryUnchanged, true);
    assert.equal(a.buildingGeometryUnchanged, true);
    assert.equal(a.integrationDesignCreated, false, '未採用なのに integration design を作っている（§19 違反）');
  }
  const bm = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'), 'utf-8'));
  assert.equal(bm.featureCount, 615617);
  const rm = JSON.parse(fs.readFileSync(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'), 'utf-8'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
});

test('[FIX14 §16] 商用利用条件が不明な source は採用していない（§16 準拠）', { skip: !rpt('official-road-edge-source-audit.json') && 'no audit' }, () => {
  const a = rpt('official-road-edge-source-audit.json');
  for (const s of a.sourceDetail) {
    if (a.usableSources.includes(s.id)) {
      assert.ok(s.commercialUse && !/不明|要確認|要申請/.test(s.commercialUse), s.id + ' は commercialUse が不明確なのに usableSources に入っている');
    }
  }
});

test('[FIX14 §0] protected HTML は変更されていない（本ミッションは調査のみ・HTML 無変更）（production は 32U cutover で promoted build）', () => {
  for (const f of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = R('public', f);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf-8');
    assert.doesNotMatch(t, /official-road-edge|gsi-kiban|road-edge-source/, f + ' に混入');
  }
});

test('[FIX14] audit script が一律 buffer / 建物基準 clip を実装していない（§0 禁止の静的確認）', () => {
  const src = fs.readFileSync(R('tools', 'audit', 'official-road-edge-source-audit.js'), 'utf-8');
  assert.doesNotMatch(src, /\.buffer\(-\d/);
  assert.doesNotMatch(src, /clipByBuilding|shrinkToBuilding/);
});
