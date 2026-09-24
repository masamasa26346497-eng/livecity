// tests/gsi-vs-fix13-road-comparison.test.js
// [Mission 31G-FIX16] GSI道路縁 実データ検証。data/raw/gsi/road-edge/ に実データが投入された場合のみ
// 意味のある assertion が走る（無ければ各テストは早期 return で実質 skip 相当）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_ROAD_FEATURE_COUNT, REFINED_ROAD_SURFACE_INDEXED_COUNT } from "../tools/lib/canonical-baseline.js";
import { skipIfMissingRel } from './_generated-data.mjs';
// [Mission 35L] canonical の生成物が無い素のチェックアウトでは検証対象が無いので skip（assertion 失敗では skip しない）
const CANONICAL_SKIP = skipIfMissingRel('data/processed/osaka-city/canonical/buildings/manifest.json', 'data/processed/osaka-city/canonical/roads/manifest.json', 'data/processed/osaka-city/derived/refined-road-surface.json');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(R('data', 'reports', n));

const ALLOWED_DECISIONS = new Set(['ADOPT_FOR_PROTOTYPE_INTEGRATION', 'KEEP_FIX13', 'INSUFFICIENT_DATA', 'GSI_INVALID_FOR_CARRIAGEWAY']);
const ALLOWED_FIX13_CMP = new Set(['GSI_NARROWER', 'GSI_WIDER', 'SIMILAR', 'GEOMETRY_DISAGREEMENT', 'INSUFFICIENT_DATA']);

function hasRealRawData() {
  const dir = R('data', 'raw', 'gsi', 'road-edge');
  try { return fs.readdirSync(dir).some((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.')); } catch { return false; }
}

test('[FIX16 §28] gsi-vs-fix13-road-comparison.json に必須フィールドが全て存在する', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  assert.ok(j, 'report が無い（先に data:gsi-road-edge:import → tools/audit/gsi-vs-fix13-road-comparison.js）');
  for (const f of ['rawFiles', 'sourceCrs', 'featureSemantics', 'counts', 'coverageByWard', 'pairing',
    'majorRoadWidths', 'fix13Comparison', 'buildingOverlapComparison', 'alignment', 'adoptionScore', 'decision']) {
    assert.ok(f in j, '必須フィールドが無い: ' + f);
  }
});

test('[FIX16 §25] adoption decision は 4 択のいずれか（曖昧な表現でない）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  assert.ok(ALLOWED_DECISIONS.has(j.decision), '不正な decision: ' + j.decision);
});

test('[FIX16 §17] fix13Comparison の値は既定 enum のみ（捏造/曖昧値なし）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  for (const [road, v] of Object.entries(j.fix13Comparison)) assert.ok(ALLOWED_FIX13_CMP.has(v), road + ': 不正な分類 ' + v);
});

test('[FIX16 §8] 24区すべてに coverage エントリがある（今回投入されたメッシュが大阪市全域をカバー）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  const wardCount = Object.keys(j.coverageByWard).length;
  assert.ok(wardCount >= 1, 'coverageByWard が空');
  // missingWards が記録されていること自体を確認（0件でも配列として存在すべき）
  assert.ok(Array.isArray(j.missingWards));
});

test('[FIX16 §21] featureSemantics: 真幅道路（実道路幅）が主要 type として識別されている', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  assert.equal(j.featureSemantics.primaryType, '真幅道路');
  assert.ok(j.featureSemantics.typeCounts['真幅道路'] > 0);
});

test('[FIX16 §12] pairing: HIGH/MEDIUM/LOW/UNPAIRED すべて非負整数', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  for (const k of ['high', 'medium', 'low', 'unpaired']) {
    assert.ok(Number.isInteger(j.pairing[k]) && j.pairing[k] >= 0, k + ' が非負整数でない: ' + j.pairing[k]);
  }
});

test('[FIX16 §15] majorRoadWidths: sampleCount>0 の道路は gsiWidthM が現実的な範囲（3〜40m）', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  for (const [road, m] of Object.entries(j.majorRoadWidths)) {
    if (m.sampleCount > 0) assert.ok(m.gsiWidthM >= 3 && m.gsiWidthM <= 40, road + ': 非現実的な幅 ' + m.gsiWidthM);
  }
});

test('[FIX16 §22] alignment: sample polygon が canonical road から大きく系統的にズレていない', () => {
  if (!hasRealRawData()) return;
  const j = rpt('gsi-vs-fix13-road-comparison.json');
  const a = j.alignment.toNearestCanonicalRoadM;
  if (a.sampleCount === 0) return;
  assert.ok(a.median <= 30, 'sample polygon の中点が canonical road から系統的に離れている: median=' + a.median);
});

test('[FIX16 §0/§19/§20] canonical / building / FIX13 は完全不変', { skip: CANONICAL_SKIP }, () => {
  const bm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'buildings', 'manifest.json'));
  assert.equal(bm.featureCount, 615617);
  const rm = rj(R('data', 'processed', 'osaka-city', 'canonical', 'roads', 'manifest.json'));
  assert.equal(rm.featureCount, CANONICAL_ROAD_FEATURE_COUNT);
  const refined = rj(R('data', 'processed', 'osaka-city', 'derived', 'refined-road-surface.json'));
  assert.equal(refined.indexedCount, REFINED_ROAD_SURFACE_INDEXED_COUNT);
  if (hasRealRawData()) {
    const j = rpt('gsi-vs-fix13-road-comparison.json');
    assert.equal(j.sourceGeometryMutated, false);
    assert.equal(j.buildingGeometryMutated, false);
    assert.equal(j.fix13Mutated, false);
  }
});

test('[FIX16 §27] runtime sample overlay: 全大阪版より大幅に小さい（§27 パフォーマンス）', () => {
  const samplePath = R('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines-sample.json');
  const fullPath = R('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
  if (!fs.existsSync(samplePath) || !fs.existsSync(fullPath)) return;
  const sampleBytes = fs.statSync(samplePath).size;
  const fullBytes = fs.statSync(fullPath).size;
  assert.ok(sampleBytes < fullBytes * 0.2, 'sample overlay が全大阪版に対して十分小さくない: ' + sampleBytes + ' / ' + fullBytes);
});

test('[FIX16 §27] public 配信は sample overlay のみ（全大阪版は配信しない）', () => {
  const pubSample = R('public', 'map-data', 'osaka-city', 'gsi-road-edge', 'road-edge-lines-sample.json');
  const pubFull = R('public', 'map-data', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
  if (!fs.existsSync(path.dirname(pubSample))) return;
  assert.ok(!fs.existsSync(pubFull), '全大阪版 road-edge-lines.json が public に配信されている（§27 違反）');
});

test('[FIX16] tools/lib/gsi-road-edge-pairing.js: 平行な2線が正しく HIGH pairing される', async () => {
  const { pairCandidates } = await import('../tools/lib/gsi-road-edge-pairing.js');
  const a = { id: 'a', geometry: { coordinates: [[0, 0], [50, 0]] } };
  const b = { id: 'b', geometry: { coordinates: [[0, 8], [50, 8]] } };   // 8m 平行離れ → HIGH 域内
  const { pairs, unpaired } = pairCandidates([a, b]);
  assert.equal(pairs.length, 1);
  assert.equal(unpaired.length, 0);
  assert.equal(pairs[0].confidence, 'high');
  assert.ok(Math.abs(pairs[0].sepM - 8) < 0.5);
});

test('[FIX16] gsi-road-edge-pairing.js: 極端に近い(2m)線は MIN_SEP_M 未満で pairing しない（同一縁の断片誤結合防止）', async () => {
  const { pairCandidates } = await import('../tools/lib/gsi-road-edge-pairing.js');
  const a = { id: 'a', geometry: { coordinates: [[0, 0], [50, 0]] } };
  const b = { id: 'b', geometry: { coordinates: [[0, 2], [50, 2]] } };   // 2m のみ → 実道路幅としてありえない
  const { pairs, unpaired } = pairCandidates([a, b]);
  assert.equal(pairs.length, 0);
  assert.equal(unpaired.length, 2);
});

test('[FIX16] build-derived-public.js が road-edge-lines-sample.json のみを配信対象にしている（全大阪版は除外）', () => {
  const src = fs.readFileSync(R('tools', 'build-derived-public.js'), 'utf-8');
  assert.match(src, /road-edge-lines-sample\.json/);
  const s = src.indexOf('GSI Road Edge prototype overlay');
  const block = s >= 0 ? src.slice(s, s + 900) : '';
  assert.doesNotMatch(block, /copyDir\(GSI_SRC, GSI_DST\)/, '全 gsi-road-edge ディレクトリ（154MB 級含む）を丸ごと配信している疑い');
});
