// tests/mission31-source-coverage.test.js
// [Mission31 大阪市北部 OSM道路 SOURCE_MISSING 完全解消]
//   §1 現 PBF bbox 監査 / §2 N03 required bbox / §4 coverage validator（現状 FAIL が正）/
//   §10 SOURCE_MISSING が data 駆動（hardcode なし）/ §18 SOURCE_MISSING vs SOURCE_SPARSE 区別 /
//   ランブック存在 / 既存監査（road/map-completeness/map-detail）への回帰。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { n03Bbox, expandBboxKm } from '../tools/lib/osm-source-coverage.js';

const R = (n) => path.join(PROJECT_ROOT, 'data', 'reports', n);
const rd = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null);
const cov = rd(R('osm-source-coverage.json'));
const covV = rd(R('osm-source-coverage-validation.json'));
const roadCov = rd(R('road-network-coverage.json'));
const mc = rd(R('map-completeness-audit.json'));
const mdA = rd(R('map-detail-audit.json'));

test('[Mission31] §2 N03 大阪市 bbox: lib 算出値がレポートと一致', () => {
  const wards = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'), 'utf-8')).wards;
  const b = n03Bbox(wards);
  // N03 2026 大阪府データの外接矩形（config/areas/osaka-city.json の note と一致）
  assert.ok(Math.abs(b.south - 34.586154) < 1e-4, 'south ' + b.south);
  assert.ok(Math.abs(b.north - 34.768849) < 1e-4, 'north ' + b.north);
  assert.ok(Math.abs(b.west - 135.343508) < 1e-4, 'west ' + b.west);
  assert.ok(Math.abs(b.east - 135.59935) < 1e-4, 'east ' + b.east);
  const req = expandBboxKm(b, 3);
  assert.ok(req.north > 34.79 && req.north < 34.80);
  if (cov) {
    assert.ok(Math.abs(cov.n03Bbox.north - b.north) < 1e-5, 'audit の n03Bbox と一致');
    assert.ok(Math.abs(cov.requiredBbox.north - req.north) < 1e-5);
  }
});

test('[Mission31] §1 現 PBF road-way-node bbox / lat cliff', { skip: !cov && 'no coverage audit' }, () => {
  // road way node の北端は N03 北端より南（切れている）
  assert.ok(cov.scan.roadWayNodeBbox.north < cov.n03Bbox.north, 'road node 北端が N03 を超えている（切れていない）');
  // 緯度ヒストグラムに cliff がある
  assert.ok(cov.latCliff && cov.latCliff.cliffLat != null, 'lat cliff が検出されていない');
  assert.ok(cov.latCliff.cliffLat >= 34.73 && cov.latCliff.cliffLat <= 34.76, 'cliff lat ' + cov.latCliff.cliffLat);
  assert.equal(cov.RESULT, 'FAIL', '現 PBF は N03 を包含していないので audit は FAIL のはず');
});

test('[Mission31] §4 osm-source-coverage validator: 現状 FAIL（北側不足 + cliff）', { skip: !covV && 'no validation' }, () => {
  assert.equal(covV.RESULT, 'FAIL');
  assert.equal(covV.contains.north, false);
  assert.equal(covV.contains.south, true);
  assert.equal(covV.contains.east, true);
  assert.equal(covV.contains.west, true);
  // remediation runbook がある
  assert.ok(cov.remediation && cov.remediation.step1 && /osaka-full-coverage/.test(cov.remediation.step1));
});

test('[Mission31] §10 SOURCE_MISSING は data 駆動（コードに hardcode した ward リストが無い）', () => {
  const files = [
    'tools/audit/map-completeness.js', 'tools/audit/map-detail-audit.js',
    'tools/lib/road-network.js', 'tools/lib/map-detail-audit.js',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf-8');
    // "higashiyodogawa" や "yodogawa" を SOURCE_MISSING と直に結びつける固定リストが無いこと
    assert.ok(!/(SOURCE.?MISSING|sourceMissing)[^\n]{0,40}\[[^\]]*['"]higashiyodogawa['"]/.test(src),
      f + ' に SOURCE_MISSING の hardcode ward リスト');
    assert.ok(!/const\s+\w*[Ss]ource\w*Wards?\s*=\s*\[[^\]]*higashiyodogawa/.test(src),
      f + ' に hardcode sparseWards');
  }
  // road-network.js は sourceMissingCells / landCells の比で判定している
  const rn = fs.readFileSync(path.join(PROJECT_ROOT, 'tools/lib/road-network.js'), 'utf-8');
  assert.ok(/d\.sourceMissingCells \/ d\.landCells\) >= 0\.08/.test(rn), 'sparseWards が data 駆動でない');
});

test('[Mission31] §18 road-network-coverage: sourceMissingWards / sourceSparseWards の区別', { skip: !roadCov && 'no road coverage' }, () => {
  const d = roadCov.density;
  assert.ok(Array.isArray(d.sourceMissingWards), 'sourceMissingWards が無い');
  assert.ok(Array.isArray(d.sourceSparseWards), 'sourceSparseWards が無い');
  // 現状: 東淀川・淀川は cliff より北へ張り出す → SOURCE_MISSING（ソース拡張で解消可）
  assert.ok(d.sourceMissingWards.includes('higashiyodogawa'));
  assert.ok(d.sourceMissingWards.includes('yodogawa'));
  // sparseWards は両者の和集合
  for (const w of [...d.sourceMissingWards, ...d.sourceSparseWards]) assert.ok(d.sparseWards.includes(w));
});

test('[Mission31] map-completeness: 東淀川・淀川 roadStatus = SOURCE-MISSING（PASS を阻害しない）', { skip: !mc && 'no mc' }, () => {
  assert.equal(mc.byWard.higashiyodogawa.roadStatus, 'SOURCE-MISSING');
  assert.equal(mc.byWard.yodogawa.roadStatus, 'SOURCE-MISSING');
  // FAIL ステータスは無い / 全体 100 維持
  for (const [w, W] of Object.entries(mc.byWard)) {
    for (const k of ['landStatus', 'buildingStatus', 'roadStatus', 'waterStatus', 'parkStatus', 'railStatus']) {
      assert.notEqual(W[k], 'FAIL', w + '.' + k);
    }
  }
  assert.equal(mc.overallScore, 100);
  assert.equal(mc.criticalCount, 0);
  assert.equal(mc.highCount, 0);
});

test('[Mission31] map-detail-audit: sourceMissing に kind、24区 road SOURCE 総数', { skip: !mdA && 'no md' }, () => {
  const roads = mdA.sourceMissing.filter((s) => s.layer === 'roads');
  assert.equal(roads.length, 2, 'roads の sourceMissing 数');
  for (const s of roads) {
    assert.ok(['SOURCE_MISSING', 'SOURCE_SPARSE'].includes(s.kind), 's.kind: ' + s.kind);
    assert.ok(['higashiyodogawa', 'yodogawa'].includes(s.ward));
  }
  assert.equal(mdA.criticalCount, 0);
  assert.equal(mdA.highCount, 0);
  assert.equal(mdA.unexplained, 0);
  assert.equal(mdA.RESULT, 'PASS');
});

test('[Mission31] ランブック MISSION31_RUNBOOK.md が存在し必要手順を含む', () => {
  const rb = fs.readFileSync(path.join(PROJECT_ROOT, 'MISSION31_RUNBOOK.md'), 'utf-8');
  for (const kw of ['osaka-full-coverage.osm.pbf', 'osm-source-coverage', 'data:import:osm-pbf', 'kansai-latest',
    '34.795798', 'SOURCE_MISSING vs SOURCE_SPARSE', '架空生成しない']) {
    assert.ok(rb.includes(kw), 'runbook に ' + kw + ' が無い');
  }
});

test('[Mission31] projection / protected 不変（production は 32U cutover で promoted build）', () => {
  const dev = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  assert.ok(/const z = -\(\(lat - SEARCH_CLAT\) \* SEARCH_MPD\); \/\/ \[znorth-neg-v1\]/.test(dev));
  for (const rel of ['osaka_3d_buildings.fullward-v3.html']) {   // [32U] production は promoted build になったため protected のみを守る
    const p = path.join(PROJECT_ROOT, 'public', rel);
    if (!fs.existsSync(p)) continue;
    const h = fs.readFileSync(p, 'utf-8');
    assert.ok(!/osm-source-coverage|sourceMissingWards/.test(h), rel + ' に Mission31 混入');
  }
});
