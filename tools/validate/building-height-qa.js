#!/usr/bin/env node
// tools/validate/building-height-qa.js
// [見た目改善 Mission11B / 13節] 建物高さデータの QA レポート。
//   Mission10 で maxHeight = 29997m という異常値を確認した。元データは変更しないが、
//   分布を可視化し、ランドマーク識別で異常値を誤採用しないための基準（suspicious/invalid）を提示する。
//
//   分類（実分布を見て確定）:
//     normal      <= 350m   （あべのハルカス 300m + 余裕。日本最高峰クラスまで許容）
//     suspicious  350–500m  （国内に前例が無い。要確認）
//     invalid     > 500m    （データ誤り確定）
//
//   RESULT は常に PASS（レポート専用）。ただし invalid が閾値以上のときは WARN を出す。
//
// 実行: node tools/validate/building-height-qa.js
//       npm run data:qa:building-height
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';

const BUILDINGS_ROOT = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'building-height-qa.json'));

export const HEIGHT_QA_THRESHOLDS = Object.freeze({ normalMax: 350, suspiciousMax: 500 });

export function classifyHeightQA(h) {
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return 'nonpositive';
  if (h <= HEIGHT_QA_THRESHOLDS.normalMax) return 'normal';
  if (h <= HEIGHT_QA_THRESHOLDS.suspiciousMax) return 'suspicious';
  return 'invalid';
}

function main() {
  if (!fs.existsSync(BUILDINGS_ROOT)) {
    console.error(`[building-height-qa] building datasets が無い: ${toProjectRelativePath(BUILDINGS_ROOT)}`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(BUILDINGS_ROOT, 'manifest.json'), 'utf-8'));
  const cls = { normal: 0, suspicious: 0, invalid: 0, nonpositive: 0 };
  const outliers = [];
  let total = 0, sum = 0, max = 0;
  const byWardOutliers = {};

  for (const ds of manifest.datasets || []) {
    const dir = path.join(BUILDINGS_ROOT, ds.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      for (const b of (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).buildings || [])) {
        const h = b.dz != null ? b.dz : b.h;
        if (typeof h !== 'number') continue;
        total++;
        const c = classifyHeightQA(h);
        cls[c]++;
        if (Number.isFinite(h)) { sum += h; if (h > max) max = h; }
        if (c === 'suspicious' || c === 'invalid') {
          outliers.push({ id: b.id, ward: ds.wardId, dz: h, usage: b.usage, repX: b.repX, repZ: b.repZ, class: c });
          byWardOutliers[ds.wardId] = (byWardOutliers[ds.wardId] || 0) + 1;
        }
      }
    }
  }
  outliers.sort((a, b) => b.dz - a.dz);

  console.log(`[building-height-qa] total=${total}  mean=${(sum / total).toFixed(1)}m  max=${max}m`);
  console.log(`  normal(<=${HEIGHT_QA_THRESHOLDS.normalMax}m)=${cls.normal}  suspicious(${HEIGHT_QA_THRESHOLDS.normalMax}-${HEIGHT_QA_THRESHOLDS.suspiciousMax}m)=${cls.suspicious}  invalid(>${HEIGHT_QA_THRESHOLDS.suspiciousMax}m)=${cls.invalid}  nonpositive=${cls.nonpositive}`);
  console.log(`  outliers (suspicious + invalid) = ${outliers.length}:`);
  for (const o of outliers.slice(0, 20)) console.log(`   [${o.class}] ${o.ward.padEnd(16)} dz=${o.dz}m  ${o.id}  usage=${o.usage}`);

  const warns = [];
  if (cls.invalid > 20) warns.push(`invalid（>500m）が ${cls.invalid} 件。Building Height QA Mission が必要`);
  if (cls.invalid > 0) console.log(`  ※ invalid ${cls.invalid} 件は元データの誤り。Mission11B ではランドマーク候補から除外済み（SUSPICIOUS_HEIGHT_M=500）。元データは変更しない。`);

  const report = {
    generatedAt: new Date().toISOString(),
    buildingsRoot: toProjectRelativePath(BUILDINGS_ROOT),
    thresholds: HEIGHT_QA_THRESHOLDS,
    total, meanHeightM: +(sum / total).toFixed(2), maxHeightM: max,
    classes: cls,
    outlierCount: outliers.length,
    outliersByWard: byWardOutliers,
    outliers: outliers.slice(0, 100),
    warns,
    note: '元データは変更しない。将来の Building Height QA Mission の入力。',
    RESULT: 'PASS',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT: PASS（レポート専用）');
}

main();
