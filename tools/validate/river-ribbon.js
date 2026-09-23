#!/usr/bin/env node
// tools/validate/river-ribbon.js
// [河川再構築/河川再導入] 河川レイヤー（centerline+width ribbon方式）のvalidator CLI。
// polygon validator（water-semantic-validator等）とは別に、「巨大な水色面が構造的に
// 生成できないこと」+「市外への数km級の飛び出しが無いこと」を検証する。
//
// 実行: node tools/validate/river-ribbon.js
//       node tools/validate/river-ribbon.js --input public/map-data/osaka-city/rivers-v2/rivers.json

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { validateRiverRibbons, validateCityBboxContainment } from '../lib/river-ribbon-validator.js';

// config/areas/osaka-city.json の bbox を znorth-neg-v1 へ変換した値。
// public/osaka_3d_buildings.ward-ux-v1.html の OSAKA_CITY_GROUND_EXTENT と同一（P1-5B算出）。
const OSAKA_CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const CITY_BBOX_MARGIN_M = 500; // 橋・河口部の実測揺らぎを許容する余白

function parseArgs(argv) {
  const a = { input: path.join('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json'), report: path.join('data', 'reports', 'river-ribbon-validation.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') a.input = argv[++i];
    else if (argv[i] === '--report') a.report = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveProjectPath(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`[river-ribbon-validate] 入力が見つかりません: ${toProjectRelativePath(inputPath)}`);
    console.error('  先に node tools/build-river-layer.js を実行してください。');
    process.exitCode = 1;
    return;
  }
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const rivers = data.rivers || [];
  const okRivers = rivers.filter((r) => r.ok !== false);
  const failedToBuild = rivers.filter((r) => r.ok === false);

  const { errors, warns, riverCount, errorCount, warnCount } = validateRiverRibbons(okRivers);
  for (const r of failedToBuild) errors.push(`[${r.name || r.id}] ribbon生成失敗: ${r.reason}`);

  // [指示書8節] 市外への数km級の飛び出しが無いか（ribbon bbox vs 大阪市24区外接矩形+margin）
  const bboxCheck = validateCityBboxContainment(okRivers, OSAKA_CITY_BBOX, CITY_BBOX_MARGIN_M);
  for (const v of bboxCheck.violations) {
    errors.push(`[${v.name || v.id}] ribbon bboxが大阪市外接矩形+${CITY_BBOX_MARGIN_M}mを${v.overflowM}mはみ出す（市外への飛び出し）`);
  }

  console.log(`[river-ribbon-validate] input=${toProjectRelativePath(inputPath)}`);
  console.log(`  river=${riverCount} (build失敗=${failedToBuild.length}) error=${errors.length} warn=${warns.length} cityBboxViolations=${bboxCheck.violationCount}`);
  const majorNames = ['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'];
  for (const name of majorNames) {
    const segs = rivers.filter((r) => r.name === name);
    const segErrors = segs.flatMap((s) => s.validationErrors || (s.ok === false ? [`ribbon生成失敗: ${s.reason}`] : []));
    const suppressed = segs.filter((s) => s.suppressed).length;
    if (suppressed) errors.push(`[${name}] major river が ${suppressed} セグメント suppress されている（major は消してはいけない）`);
    console.log(`  [${segErrors.length || suppressed ? 'FAIL' : 'PASS'}] ${name}: segment=${segs.length} error=${segErrors.length} suppressed=${suppressed}`);
  }

  // [Mission04-B] 建物干渉チェック
  const minors = rivers.filter((r) => r.riverClass === 'minor');
  const shownMinorsWithConflict = minors.filter((r) => !r.suppressed && r.ok && ((r.conflictCenterInFrac || 0) > 0.35 || (r.conflictEdgeInFrac || 0) > 0.40));
  const suppressedMinors = minors.filter((r) => r.suppressed).length;
  const shrunkMinors = minors.filter((r) => r.conflictAction === 'shrink').length;
  console.log(`  -- Mission04-B 建物干渉 --`);
  console.log(`  minor=${minors.length} 表示中=${minors.filter((r) => !r.suppressed && r.ok).length} suppress=${suppressedMinors} shrink=${shrunkMinors}`);
  console.log(`  [${shownMinorsWithConflict.length ? 'WARN' : 'PASS'}] 表示中minorで建物干渉が残る: ${shownMinorsWithConflict.length}件`);
  for (const r of shownMinorsWithConflict.slice(0, 10)) {
    warns.push(`[${r.name || r.id}] 表示中minorに建物干渉が残る（center=${r.conflictCenterInFrac} edge=${r.conflictEdgeInFrac}）`);
  }
  // major が過度に消えていないか（31 は Mission04-B 時点の major セグメント数）
  const majorShown = rivers.filter((r) => r.riverClass === 'major' && r.ok && !r.suppressed).length;
  if (majorShown < 25) errors.push(`major river の表示セグメントが ${majorShown} 本まで減少（主要河川が消えすぎ）`);
  console.log(`  major表示セグメント=${majorShown}`);
  if (errors.length) {
    console.log('  -- errors --');
    for (const e of errors.slice(0, 30)) console.log('  [ERROR] ' + e);
    if (errors.length > 30) console.log(`  … 他 ${errors.length - 30} 件`);
  }
  if (warns.length) {
    console.log('  -- warns --');
    for (const w of warns.slice(0, 15)) console.log('  [WARN] ' + w);
    if (warns.length > 15) console.log(`  … 他 ${warns.length - 15} 件`);
  }

  const report = {
    generatedAt: new Date().toISOString(), input: toProjectRelativePath(inputPath),
    riverCount, buildFailedCount: failedToBuild.length, errorCount: errors.length, warnCount: warns.length,
    errors, warns,
  };
  const reportPath = resolveProjectPath(args.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log('保存:', toProjectRelativePath(reportPath));
  console.log('RESULT:', errors.length === 0 ? 'PASS' : 'FAIL');
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[river-ribbon-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
