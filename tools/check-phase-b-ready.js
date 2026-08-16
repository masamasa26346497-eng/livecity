#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/check-phase-b-ready.js
// ══════════════════════════════════════════════════════════════
// Phase B（東住吉区追加・区境検証）へ進める状態かを判定するgo/no-goチェッカー。
// HTML・BUILD_ID・描画には一切触れない読み取り専用ツール。
//
// 実行: node tools/check-phase-b-ready.js [--input <東住吉区CityGMLのパス>]

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const checks = [];
const add = (ok, name, detail) => checks.push({ ok, name, detail });

// 1. coordinate-config.json（正式値）
const cfgPath = 'data/buildings/coordinate-config.json';
if (!fs.existsSync(cfgPath)) {
  add(false, '座標設定', cfgPath + ' が未作成。自動生成: node tools/setup-area.js --dataset <id> --ward <区名> --citygml <path>（STEP1-3で自動較正）。個別実行なら fetch-osm-references.js → estimate-origin.js --emit-config');
} else {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const ok = (cfg.coordinateMode === 'projected' || cfg.coordinateMode === 'geographic-jprect') &&
      cfg.localOrigin && Number.isFinite(cfg.localOrigin.projectedE) && Number.isFinite(cfg.localOrigin.projectedN) &&
      cfg.axisMapping && Math.abs(cfg.axisMapping.sceneXSign) === 1 && Math.abs(cfg.axisMapping.sceneZSign) === 1 &&
      (cfg.coordinateMode !== 'geographic-jprect' || Number.isInteger(cfg.jprectZone));
    add(ok, '座標設定', ok ? '実測値が設定済み' : 'null/不正値が残っている（推測値の記入は禁止）');
  } catch (e) { add(false, '座標設定', 'JSON解析エラー: ' + e.message); }
}

// 2. 逆推定の検証記録（estimate-origin.js --out の出力）
const repPath = 'data/buildings/origin-estimation-report.json';
if (fs.existsSync(repPath)) {
  try {
    const rep = JSON.parse(fs.readFileSync(repPath, 'utf8'));
    const ok = rep.best && rep.best.maxResidual <= 20;
    add(ok, '原点検証記録', 'maxResidual=' + (rep.best ? rep.best.maxResidual : '?') + 'm（≤20mで合格）');
  } catch (e) { add(false, '原点検証記録', 'JSON解析エラー'); }
} else {
  add(false, '原点検証記録', repPath + ' が未生成。setup-area.js が自動生成する（個別実行時は estimate-origin.js --out ' + repPath + '）');
}

// 2.5 参照点（自動取得）
const refsPath = 'data/buildings/references.auto.json';
if (fs.existsSync(refsPath)) {
  try {
    const r = JSON.parse(fs.readFileSync(refsPath, 'utf8'));
    const n = (r.references || []).length;
    add(n >= 3, '参照点(自動取得)', n + '点 / ソース: ' + (r.source || '-'));
  } catch (e) { add(false, '参照点(自動取得)', 'JSON解析エラー'); }
} else {
  add(false, '参照点(自動取得)', refsPath + ' が未生成（node tools/fetch-osm-references.js で自動取得。手入力は不要）');
}

// 3. 東住吉区の入力データ
const input = args.input || 'data/source/osaka-higashisumiyoshi';
if (fs.existsSync(input)) {
  const gmls = fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter(f => f.endsWith('.gml')).length
    : (input.endsWith('.gml') ? 1 : 0);
  add(gmls > 0, '東住吉区CityGML', input + ' に .gml ' + gmls + '件');
} else {
  add(false, '東住吉区CityGML', input + ' が存在しない（PLATEAU 27114 東住吉区の建物CityGMLを配置する）');
}

// 4. 受け皿（前フェーズで整備済みの想定を確認）
add(fs.existsSync('tools/convert-plateau-buildings.js'), '変換スクリプト', 'tools/convert-plateau-buildings.js');
add(fs.existsSync('tools/split-building-tiles.js'), 'タイル分割', 'tools/split-building-tiles.js');
add(fs.existsSync('public/data/buildings/manifest.json'), '上位manifest', 'public/data/buildings/manifest.json');

// 判定
console.log('══ Phase B 事前チェック ══');
for (const c of checks) console.log((c.ok ? ' OK  ' : ' NG  ') + c.name + ' … ' + c.detail);
const go = checks.every(c => c.ok);
console.log(go
  ? '判定: GO — PHASE_B_RUNBOOK.md の手順で実行してください。'
  : '判定: NO-GO — 上記NGを解消してから再実行してください（HTML/BUILD_IDは変更不要）。');
process.exit(go ? 0 : 1);
