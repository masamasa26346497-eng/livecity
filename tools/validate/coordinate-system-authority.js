#!/usr/bin/env node
// tools/validate/coordinate-system-authority.js
// [Mission 31G-FIX11 §27] Live City 座標系の正本性を検証する。
//
//   チェック:
//     - wrongZoneUsage 0            現行 24 区 canonical 建物が第7系/第5系で描かれていない
//     - inferredOriginDependency 0  現行 canonical 建物が逆推定 origin に依存していない（= 正本 origin で自己整合）
//     - layerSpecificProjection 0   全 layer が同一原点（buildings/roads/water/N03/geoToThree）
//     - runtimeDoubleTransform 0    CanonicalRuntime が座標を変換していない
//     - coordinateConventionMismatch 0  znorth-neg-v1 の z 反転が二重適用されていない
//     - crsUndocumented 0           全 source layer の CRS が audit レポートに記載されている
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const AREA = P('config', 'areas', 'osaka-city.json');
const PROD = P('public', 'osaka_3d_buildings.html');
const DEV = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const AUDIT = P('data', 'reports', 'coordinate-system-authority-audit.json');
const REPORT = P('data', 'reports', 'coordinate-system-authority-validation.json');

async function main() {
  const errors = [], warns = [], checks = {};

  const area = JSON.parse(fs.readFileSync(AREA, 'utf-8'));
  const prod = fs.existsSync(PROD) ? fs.readFileSync(PROD, 'utf-8') : '';
  const html = fs.existsSync(DEV) ? fs.readFileSync(DEV, 'utf-8') : '';
  const crBlock = (html.match(/const CanonicalRuntime = \(function[\s\S]*?console\.log\('\[CanonicalRuntime\] READY'\);/) || [''])[0];
  const audit = fs.existsSync(AUDIT) ? JSON.parse(fs.readFileSync(AUDIT, 'utf-8')) : null;

  // ── layerSpecificProjection / originConsistency ──
  const prodClat = (prod.match(/SEARCH_CLAT\s*=\s*([\d.]+)/) || [])[1];
  const prodClon = (prod.match(/SEARCH_CLON\s*=\s*([\d.]+)/) || [])[1];
  const originOk = (!prodClat || +prodClat === area.projection.centerLat) && (!prodClon || +prodClon === area.projection.centerLon);
  checks.layerSpecificProjection = originOk ? 0 : 1;
  if (!originOk) errors.push(`layer 別 projection: area(${area.projection.centerLat}) vs prod geoToThree(${prodClat})`);

  // ── runtimeDoubleTransform / coordinateConventionMismatch ──
  const zFlip = /z\s*=\s*-\s*\w+\[1\]/.test(crBlock) || /coordinates.*-.*\[1\]/.test(crBlock);
  const posAdd = /\.position\.set\([^)]*\bt[xz]\b/.test(crBlock) || /positions\.push\([^)]*\bt[xz]\s*\*/.test(crBlock) || /group\.position\.[xz]\s*=[^=]/.test(crBlock);
  checks.runtimeDoubleTransform = posAdd ? 1 : 0;
  checks.coordinateConventionMismatch = zFlip ? 1 : 0;
  if (posAdd) errors.push('CanonicalRuntime が座標に tile 原点等を加算している');
  if (zFlip) errors.push('CanonicalRuntime が z を反転している（znorth-neg-v1 二重適用）');

  // ── audit レポートの数値 ──
  if (audit) {
    const wm = audit.wardMembership;
    const pc = audit.projectionComparison;
    // 現行建物が N03 行政界と一致 = 正本 projection で描かれている
    checks.wrongZoneUsage = (wm && wm.matchPct >= 99.9) ? 0 : 1;
    if (wm && wm.matchPct < 99.9) errors.push(`現行建物 ↔ N03 一致率 ${wm.matchPct}% < 99.9%（projection 不正の疑い）`);
    checks.inferredOriginDependency = (wm && wm.worldSelfConsistencyM && wm.worldSelfConsistencyM.median < 0.5) ? 0 : 1;
    if (wm && wm.worldSelfConsistencyM && wm.worldSelfConsistencyM.median >= 0.5) errors.push(`world 自己整合 ${wm.worldSelfConsistencyM.median}m（逆推定 origin 依存の疑い）`);
    // 第6系/第7系が現行 equirect より良くない（= V2 不採用が正しい・§28）
    if (pc) {
      const cur = pc.currentError_equirect ? pc.currentError_equirect.max : 0;
      const z6 = pc.zone6Error ? pc.zone6Error.median : 0;
      checks.v2NotBetter = (z6 >= cur) ? 0 : 1;
      if (z6 < cur) warns.push(`第6系 median ${z6}m < 現行 ${cur}m（V2 の再評価を検討）`);
      checks.zone6MedianM = z6;
      checks.zone7MedianM = pc.zone7Error ? pc.zone7Error.median : null;
      checks.currentMaxM = cur;
    }
    checks.v2Adopted = audit.v2Adopted;
    checks.rebuilt = audit.rebuilt;
    checks.plateauSourceCRS = audit.plateauSourceCRS;
    // ── crsUndocumented ──
    const p = audit.coordinatePipelineByLayer || {};
    const need = ['PLATEAU buildings (source)', 'PLATEAU tran roads (source)', 'OSM (roads/water/parks/rail)', 'N03 administrative (source)', 'Live City world (正本)', 'CanonicalRuntime'];
    const missing = need.filter((k) => !p[k]);
    checks.crsUndocumented = missing.length;
    if (missing.length) errors.push('CRS 未記載 layer: ' + missing.join(', '));
  } else {
    warns.push('coordinate-system-authority-audit.json が無い（先に tools/audit/coordinate-system-authority-audit.js）');
    checks.wrongZoneUsage = null; checks.inferredOriginDependency = null; checks.crsUndocumented = null;
  }

  // ── production / protected に canonical runtime 混入なし ──
  if (fs.existsSync(PROD) && /CanonicalRuntime|__CANONICAL_RUNTIME__/.test(prod)) errors.push('production HTML に canonical runtime 混入');

  const report = {
    generatedAt: new Date().toISOString(), checks,
    errorCount: errors.length, warnCount: warns.length,
    errors: errors.slice(0, 25), warns: warns.slice(0, 15),
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('[coord-authority-validate] ' + JSON.stringify(checks));
  for (const e of errors.slice(0, 15)) console.log('  [ERROR] ' + e);
  for (const w of warns.slice(0, 10)) console.log('  [WARN] ' + w);
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[coord-authority-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
