#!/usr/bin/env node
// tools/validate/building-height-style.js
// [見た目改善 Mission10] 高層建物の高さ表現強化 validator。
//   - 実建物データ（24区 building datasets）の高さ分布を集計・報告する
//   - しきい値分類 / 境界値 / NaN・欠損フォールバックを検証する
//   - HTML 側で「geometry の実高度を書き換えていない」「CityBuildingLOD の
//     merged geometry / 単一 shared material 構造を維持している」ことを検証する
//   - production / protected HTML が無変更であることを検証する
//
// 実行: node tools/validate/building-height-style.js
//       npm run data:validate:building-height-style

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import {
  classifyBuildingHeight, getHeightStyle, summarizeHeights,
  HEIGHT_THRESHOLDS, SHADE_FLOOR, SHADE_CEIL, HEIGHT_CLASSES,
} from '../lib/building-height-style.js';

const BUILDINGS_ROOT = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const DEV_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.ward-ux-v1.html'));
const PROD_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.html'));
const PROTECTED_HTML = resolveProjectPath(path.join('public', 'osaka_3d_buildings.fullward-v3.html'));
const REPORT = resolveProjectPath(path.join('data', 'reports', 'building-height-style-validation.json'));

// 梅田/中之島など: ward → 参考名
const LANDMARK_WARDS = {
  'osaka-kita': '梅田・北区',
  'osaka-chuo': '本町・中央区',
  'osaka-nishi': '中之島南岸・西区',
  'osaka-naniwa': '難波・浪速区',
  'osaka-tennoji': '天王寺区',
  'osaka-abeno': '阿倍野区（あべのハルカス）',
};

function loadHeights() {
  const manifest = JSON.parse(fs.readFileSync(path.join(BUILDINGS_ROOT, 'manifest.json'), 'utf-8'));
  const all = [];
  const byWard = {};
  for (const ds of manifest.datasets || []) {
    const dir = path.join(BUILDINGS_ROOT, ds.id);
    if (!fs.existsSync(dir)) continue;
    const hs = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      for (const b of (tile.buildings || [])) {
        const h = (b.dz != null ? b.dz : b.h);
        if (typeof h === 'number') { hs.push(h); all.push(h); }
      }
    }
    byWard[ds.id] = hs;
  }
  return { all, byWard };
}

function checkClassification(errors) {
  // 境界値: しきい値ちょうどは「上の階級」へ
  const cases = [
    [-1, 'low'], [0, 'low'], [0.1, 'low'], [14.99, 'low'],
    [15, 'mid'], [39.99, 'mid'],
    [40, 'high'], [99.99, 'high'],
    [100, 'skyscraper'], [149.99, 'skyscraper'],
    [150, 'very_tall'], [500, 'very_tall'], [29997, 'very_tall'],
  ];
  for (const [h, want] of cases) {
    const got = classifyBuildingHeight(h);
    if (got !== want) errors.push(`classify(${h}) = ${got}, want ${want}`);
  }
  // NaN / 欠損 / 非数値 → low（安全側フォールバック）
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x', {}]) {
    if (classifyBuildingHeight(bad) !== 'low') errors.push(`classify(${String(bad)}) が low フォールバックでない`);
  }
  // low / mid は係数 1.0（現状表現を厳密維持）
  for (const mode of ['detail', 'cityLOD']) {
    for (const h of [5, 12, 20, 35]) {
      const s = getHeightStyle(h, mode);
      if (s.bottomMul !== 1 || s.topMul !== 1 || s.roofMul !== 1) errors.push(`getHeightStyle(${h},${mode}) が low/mid で係数 != 1`);
    }
  }
  // high 以上は bottom を下げ top/roof を上げる（垂直コントラスト方向）。過剰でないこと。
  for (const h of [50, 120, 200]) {
    const s = getHeightStyle(h, 'detail');
    if (!(s.bottomMul < 1 && s.topMul > 1 && s.roofMul >= 1)) errors.push(`getHeightStyle(${h}) の方向が不正: ${JSON.stringify(s)}`);
    if (s.bottomMul < 0.90 || s.topMul > 1.06 || s.roofMul > 1.07) errors.push(`getHeightStyle(${h}) の係数が過剰: ${JSON.stringify(s)}`);
  }
  // clamp 範囲
  if (!(SHADE_FLOOR >= 0.6 && SHADE_FLOOR <= 0.78)) errors.push(`SHADE_FLOOR=${SHADE_FLOOR} が想定外`);
  if (!(SHADE_CEIL >= 1.05 && SHADE_CEIL <= 1.15)) errors.push(`SHADE_CEIL=${SHADE_CEIL} が想定外`);
  // cityLOD は detail より弱い（遠景で騒がしくしない）
  const d = getHeightStyle(120, 'detail'), c = getHeightStyle(120, 'cityLOD');
  if (!(Math.abs(c.bottomMul - 1) < Math.abs(d.bottomMul - 1))) errors.push('cityLOD の垂直コントラストが detail 以上になっている');
}

// 行コメント（//…）を除いた本文を返す（URL の :// は行頭 // ではないので概ね安全）。
function stripLineComments(src) {
  return src.split('\n').map((ln) => {
    const i = ln.indexOf('//');
    if (i < 0) return ln;
    // ':' の直後の // は URL とみなして残す（雑だが十分）
    if (i > 0 && ln[i - 1] === ':') return ln;
    return ln.slice(0, i);
  }).join('\n');
}

function checkHtmlInvariants(errors, warns) {
  const htmlRaw = fs.readFileSync(DEV_HTML, 'utf-8');
  const html = stripLineComments(htmlRaw);

  if (!/const BUILDING_HEIGHT_STYLE = \(function \(\) \{/.test(html)) errors.push('dev HTML に BUILDING_HEIGHT_STYLE IIFE が無い');
  if (!/window\.__BUILDING_HEIGHT_DEBUG__ = /.test(html)) errors.push('dev HTML に __BUILDING_HEIGHT_DEBUG__ が無い');

  // geometry 実高度を書き換えていない: b.dz / b.h / b.z0 への代入が無い（コメント除去済み本文で判定）
  const mutations = html.match(/\bb\.(dz|z0|h)\s*[*+/-]?=\s*[^=]/g) || [];
  if (mutations.length) errors.push(`建物の実高度への代入が見つかった: ${mutations.map((s) => s.trim()).join(' | ')}`);
  // dz へ倍率を掛けた押し出しをしていない（y1 = z0 + dz * k のような改変）
  if (/(z0\s*\+\s*b?\.?dz|b\.dz)\s*\*\s*[0-9(]/.test(html.replace(/[ \t]+/g, ' '))) warns.push('dz に乗算している箇所がある可能性（要目視）');

  // CityBuildingLOD: 単一 shared material（建物ごとの new material を作っていない）
  const cityLodStart = html.indexOf('const CityBuildingLOD = (function');
  const cityLodEnd = html.indexOf('const CityModeManager = (function', cityLodStart);
  const cityLodBlock = (cityLodStart >= 0 && cityLodEnd > cityLodStart) ? html.slice(cityLodStart, cityLodEnd) : '';
  if (cityLodBlock) {
    if (!/if \(!sharedMaterial\) sharedMaterial = new THREE\.MeshLambertMaterial/.test(cityLodBlock)) {
      errors.push('CityBuildingLOD の単一 shared material 構造が変わっている');
    }
    const newMats = (cityLodBlock.match(/new THREE\.(Mesh\w*Material|LineBasicMaterial)/g) || []);
    if (newMats.length > 1) errors.push(`CityBuildingLOD 内の material 生成が ${newMats.length} 箇所（1 のはず）: ${newMats.join(', ')}`);
    // appendBuilding は wv/wc（頂点＋頂点カラー）のみ。per-building geometry / mesh を作っていない
    const appendFn = cityLodBlock.slice(cityLodBlock.indexOf('function appendBuilding'), cityLodBlock.indexOf('function buildWardMesh'));
    if (/new THREE\.(Mesh|BufferGeometry)\(/.test(appendFn)) errors.push('CityBuildingLOD.appendBuilding が per-building mesh/geometry を生成している');
  } else {
    warns.push('CityBuildingLOD ブロックを特定できなかった');
  }

  // 高さ階級カラー（青/赤/黄など）を入れていない: BUILDING_HEIGHT_STYLE 内に色コード/emissive が無い
  const iife = html.slice(html.indexOf('const BUILDING_HEIGHT_STYLE = (function'), html.indexOf('function msLerpClamp'));
  if (/0x[0-9a-fA-F]{6}|emissive|new THREE\.Color/.test(iife)) errors.push('BUILDING_HEIGHT_STYLE に色/emissive が混入している（明度係数のみのはず）');
}

function checkProtected(errors) {
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf-8');
    if (/BUILDING_HEIGHT_STYLE|__BUILDING_HEIGHT_DEBUG__/.test(html)) {
      errors.push(`${label} HTML に Mission10 の変更が混入している`);
    }
  }
}

async function main() {
  const errors = [], warns = [];

  checkClassification(errors);
  checkHtmlInvariants(errors, warns);
  checkProtected(errors);

  const { all, byWard } = loadHeights();
  const dist = summarizeHeights(all);

  console.log('[building-height-style] 実データ高さ分布（24区 building datasets）:');
  console.log(`  total=${dist.total} valid=${dist.valid}`);
  console.log(`  min=${dist.min} p25=${dist.p25} median=${dist.median} p75=${dist.p75} p90=${dist.p90} p95=${dist.p95} p99=${dist.p99} max=${dist.max}`);
  console.log(`  >=30m:${dist.ge30}  >=60m:${dist.ge60}  >=100m:${dist.ge100}  >=150m:${dist.ge150}  >=200m:${dist.ge200}`);
  console.log(`  class: LOW=${dist.byClass.low} MID=${dist.byClass.mid} HIGH=${dist.byClass.high} SKYSCRAPER=${dist.byClass.skyscraper} VERY_TALL=${dist.byClass.very_tall}`);
  console.log('  -- landmark wards --');
  const landmarks = {};
  for (const [id, name] of Object.entries(LANDMARK_WARDS)) {
    const s = summarizeHeights(byWard[id] || []);
    landmarks[id] = { name, ...s };
    console.log(`  ${name.padEnd(24)} n=${String(s.valid).padStart(6)} median=${String(s.median).padStart(5)} p95=${String(s.p95).padStart(6)} max=${String(s.max).padStart(6)}  >=60:${String(s.ge60).padStart(4)} >=100:${String(s.ge100).padStart(3)} >=150:${s.ge150}`);
  }

  // データが十分な高さ差を持っているか
  if (dist.valid < 100000) errors.push(`建物データが少なすぎる（valid=${dist.valid}）。24区 dataset が未配置の可能性`);
  if (dist.ge100 < 20) errors.push(`>=100m 建物が ${dist.ge100} 件。スカイライン表現に足るデータが無い`);
  if (dist.byClass.skyscraper + dist.byClass.very_tall < 20) errors.push('SKYSCRAPER+VERY_TALL が 20 件未満');
  if (dist.p99 < 20) warns.push(`p99=${dist.p99}m と低い（大半が低層。表現効果は限定的）`);

  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    buildingsRoot: toProjectRelativePath(BUILDINGS_ROOT),
    thresholds: HEIGHT_THRESHOLDS, classes: HEIGHT_CLASSES,
    shadeClamp: { floor: SHADE_FLOOR, ceil: SHADE_CEIL },
    distribution: dist,
    landmarks,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[building-height-style] 失敗:', e && e.stack || e); process.exitCode = 1; });
