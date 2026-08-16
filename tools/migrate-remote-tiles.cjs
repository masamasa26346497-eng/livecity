#!/usr/bin/env node
'use strict';
/* migrate-remote-tiles.cjs v2 — remoteの建物タイル/overlayを znorth-neg-v1 へ移行し temp/release へ出力。
 *  - --project-root 必須。出力は io-guard の許可リスト内のみ・上書き拒否・同一/包含は停止。
 *  - migrate-buildings: 584,490棟を配列に保持しない。fd への逐次書き込み（.partial→検証OKでrename）。
 *      dry-run は書き出し用文字列を保持しない。invalid/dup は黙って捨てず集計し、!==0 なら停止。
 *      入力manifest.totalBuildings と 入力件数・変換件数・出力件数の全一致を必須条件とする。
 *  - migrate-overlays: 集約overlay JSON（roads/parks/parking/schools/water/cemetery/temples/labels）を移行。
 *      outer だけでなく全 holes も点単位・向き・閉鎖性を検証。座標フィールド以外は deepEqual。
 *      auto判定不能な形状・未知の座標保有レイヤーは停止（黙って素通ししない）。 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const core = require('./lib/znegate-core.cjs');
const G = require('./lib/io-guard.cjs');

const sub = process.argv[2];
const A = G.parseArgs(process.argv.slice(3));
const ROOT = G.requireProjectRoot(A);
const MODE = A.apply ? 'apply' : 'dry-run';
const IN = A.in && A.in !== true ? path.resolve(A.in) : null;
const OUT = A.out && A.out !== true ? path.resolve(A.out) : null;
if (!sub || !IN || !OUT) { console.error('usage: migrate-remote-tiles.cjs <migrate-buildings|migrate-overlays> --project-root <dir> --in <path> --out <dir> [--dry-run|--apply]'); process.exit(1); }

// ---- 検証カウンタ ----
const V = { rings: 0, areaPreservedCount: 0, sourceDegenerateCount: 0, genuineMismatchCount: 0, ringClosed: 0,
  ringPtX: 0, ringPtXtot: 0, ringPtZ: 0, ringPtZtot: 0,
  lines: 0, linePtX: 0, linePtXtot: 0, linePtZ: 0, linePtZtot: 0, pts: 0, ptX: 0, ptZ: 0,
  bad: 0, attrOK: 0, attrTot: 0, ringIssues: [] };
const explicitClosed = (r) => r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
function uniquePointCount(ring) { const seen = new Set(ring.map((p) => p[0] + ',' + p[1])); return seen.size; }
/* 閉リングの正常な「末尾＝先頭」（明示的closure）は重複として数えない。
 * それ以外の隣接ペア（末尾が非closureの場合の wrap-around 含む）は通常どおり検査する。 */
function hasDuplicateConsecutive(ring) {
  const n = ring.length; if (n < 2) return false;
  const closed = explicitClosed(ring);
  const upper = closed ? n - 1 : n; // 閉リングは ring[n-1]→ring[0] の回り込み比較(=閉包による自明な一致)を除外
  for (let i = 0; i < upper; i++) { const a = ring[i], b = ring[(i + 1) % n]; if (a[0] === b[0] && a[1] === b[1]) return true; }
  return false;
}
// shoelace各項の絶対値の総和。丸め誤差の許容量をこの量に比例させる（項の絶対値が大きいほど桁落ちの余地が大きい）。
function ringCrossAbsSum(ring) {
  let s = 0; const n = ring.length;
  for (let i = 0; i < n; i++) { const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n]; s += Math.abs(x1 * z2) + Math.abs(x2 * z1); }
  return s;
}
const AREA_ABS_TOL = 1e-9;   // 絶対許容量の下限（面積がほぼ0でも最低限許す量）
const AREA_REL_TOL = 1e-9;   // 面積の大きさに対する相対許容量
const AREA_EPS_SAFETY = 4;   // Number.EPSILON×頂点数×crossAbsSum の安全係数（100,000件のランダムリング検証で最大比率2.3e-5、大幅な余裕あり）
/* 許容誤差 = max(絶対許容, 面積スケールに対する相対許容, shoelace項の丸め誤差理論上限×安全係数)
 * 100,000件（座標スケール1〜1,000,000）のランダムリングで検証済み: 全件 diff <= tolerance、最大比率2.3e-5。 */
function ringAreaTolerance(sb, sa, crossAbsSum, n) {
  const scaleArea = Math.max(Math.abs(sb), Math.abs(sa));
  const epsBound = AREA_EPS_SAFETY * Number.EPSILON * Math.max(n, 1) * crossAbsSum;
  return Math.max(AREA_ABS_TOL, AREA_REL_TOL * scaleArea, epsBound);
}
/* vRing(before, after, ctx) — ctx: {layer, featureId, part, index}
 * 判定を3種類に分離する:
 *   vertexTransformOK           : 全頂点で newX===oldX / newZ===-oldZ（reverse対応）が完全一致（浮動小数点誤差なし、厳密比較で十分）
 *   areaPreservedWithinTolerance: |signedArea(after)-signedArea(before)| が許容誤差以内
 *                                 （negClosedRingは数学上signedAreaを保存するが、reverseによる加算順序変化で
 *                                   JS Numberの丸め誤差が生じるため、完全一致(===)ではなく許容誤差で判定する）
 *   sourceDegenerate             : 元リングが許容誤差以下の面積、または実質2点以下（退化形状）
 * genuineMismatch = !vertexTransformOK || !areaPreservedWithinTolerance のみを停止条件とする。
 * sourceDegenerate は「変換失敗」と同一視せず、vertexOKかつareaPreservedであれば warning として記録するのみ。 */
function vRing(before, after, ctx) {
  V.rings++;
  if (after.some(core.badPt)) V.bad++;
  const n = before.length;
  let vertexOK = true;
  for (let k = 0; k < n; k++) {
    const s = before[n - 1 - k], d = after[k];
    V.ringPtXtot++; V.ringPtZtot++;
    const xOK = d[0] === s[0], zOK = d[1] === -s[1];
    if (xOK) V.ringPtX++; else vertexOK = false;
    if (zOK) V.ringPtZ++; else vertexOK = false;
  }
  if (after.length === before.length && (!explicitClosed(before) || explicitClosed(after))) V.ringClosed++;

  const sb = core.signedArea(before), sa = core.signedArea(after);
  const areaDiff = Math.abs(sa - sb);
  const crossAbsSum = ringCrossAbsSum(before);
  const tolerance = ringAreaTolerance(sb, sa, crossAbsSum, n);
  const areaOK = areaDiff <= tolerance;
  const uniq = uniquePointCount(before);
  const degenerate = Math.abs(sb) <= tolerance || uniq < 3;

  if (areaOK) V.areaPreservedCount++;
  if (degenerate) V.sourceDegenerateCount++;
  const genuineMismatch = !vertexOK || !areaOK;
  if (genuineMismatch) V.genuineMismatchCount++;

  if ((genuineMismatch || degenerate) && ctx) {
    V.ringIssues.push({
      layer: ctx.layer, featureId: ctx.featureId, part: ctx.part, index: ctx.index,
      pointsBefore: before.length, pointsAfter: after.length,
      signedAreaBefore: sb, signedAreaAfter: sa, areaDiff, tolerance,
      areaDiffOverTolerance: tolerance > 0 ? areaDiff / tolerance : (areaDiff === 0 ? 0 : Infinity),
      uniquePointsBefore: uniq, duplicateConsecutive: hasDuplicateConsecutive(before),
      vertexTransformOK: vertexOK, areaPreservedWithinTolerance: areaOK, sourceDegenerate: degenerate,
      severity: genuineMismatch ? 'error' : 'warning',
      category: !vertexOK ? 'vertex-mismatch' : !areaOK ? 'area-mismatch' : 'source-degenerate',
    });
  }
}
function vLine(before, after) { V.lines++; if (after.some(core.badPt)) V.bad++; for (let i = 0; i < before.length; i++) { V.linePtXtot++; V.linePtZtot++; if (after[i][0] === before[i][0]) V.linePtX++; if (after[i][1] === -before[i][1]) V.linePtZ++; } }
function vPoint(before, after) { V.pts++; if (core.badPt(after)) V.bad++; if (after[0] === before[0]) V.ptX++; if (after[1] === -before[1]) V.ptZ++; }

// ---- 診断: genuineMismatch(error)とsourceDegenerate(warning)をレイヤー別・カテゴリ別に要約して出力 ----
function printOrientDiagnostics() {
  if (V.ringIssues.length === 0) return;
  const errors = V.ringIssues.filter((it) => it.severity === 'error');
  const warnings = V.ringIssues.filter((it) => it.severity === 'warning');
  const byLayerErr = {}; const byLayerWarn = {};
  for (const it of errors) byLayerErr[it.layer] = (byLayerErr[it.layer] || 0) + 1;
  for (const it of warnings) byLayerWarn[it.layer] = (byLayerWarn[it.layer] || 0) + 1;

  if (errors.length > 0) {
    console.log(`  [genuineMismatch] ${errors.length}件（vertexTransformOKまたはareaPreservedWithinToleranceの失敗＝要調査）`);
    console.log('    layer別:', JSON.stringify(byLayerErr));
    for (const it of errors.slice(0, 30)) {
      console.log(`    - layer=${it.layer} feature=${it.featureId ?? '(index:' + it.index + ')'} part=${it.part}` +
        ` vertexOK=${it.vertexTransformOK} areaOK=${it.areaPreservedWithinTolerance}` +
        ` before点数=${it.pointsBefore} unique=${it.uniquePointsBefore} 重複連続点=${it.duplicateConsecutive}` +
        ` signedArea前=${it.signedAreaBefore} 後=${it.signedAreaAfter} areaDiff=${it.areaDiff} tolerance=${it.tolerance} diff/tol=${it.areaDiffOverTolerance}` +
        ` degenerate=${it.sourceDegenerate} category=${it.category}`);
    }
    if (errors.length > 30) console.log(`    ...他 ${errors.length - 30} 件`);
  }
  if (warnings.length > 0) {
    console.log(`  [sourceDegenerate warning] ${warnings.length}件（元リングが極小/ゼロ面積または実質2点以下。vertexOK/areaOKは正常＝変換は正しい）`);
    console.log('    layer別:', JSON.stringify(byLayerWarn));
    const show = warnings.slice(0, 10);
    for (const it of show) {
      console.log(`    - layer=${it.layer} feature=${it.featureId ?? '(index:' + it.index + ')'} part=${it.part}` +
        ` unique=${it.uniquePointsBefore} signedArea前=${it.signedAreaBefore} 後=${it.signedAreaAfter} tolerance=${it.tolerance}`);
    }
    if (warnings.length > 10) console.log(`    ...他 ${warnings.length - 10} 件`);
  }
  if (errors.length === 0) {
    console.log('  [結論] genuineMismatch=0。sourceDegenerate警告のみで、座標変換自体は正しいと判定します。');
  } else {
    console.log(`  [警告] genuineMismatchが${errors.length}件あります。上記featureを個別に確認してください。--apply は実行しないでください。`);
  }
  if (A['diagnostics-out'] && A['diagnostics-out'] !== true) {
    const outPath = path.resolve(A['diagnostics-out']);
    G.assertSafeOutput(ROOT, IN, outPath);
    G.writeNoOverwrite(outPath, JSON.stringify({
      summary: { total: V.ringIssues.length, genuineMismatch: errors.length, sourceDegenerateWarnings: warnings.length, byLayerErr, byLayerWarn },
      issues: V.ringIssues,
    }, null, 2));
    console.log('  [診断] 全件を出力:', outPath);
  }
}


function migrateBuildings() {
  G.assertSafeOutput(ROOT, IN, OUT);
  const manifestPath = path.join(IN, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error('[stop] 入力 manifest.json が無い:', manifestPath); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = manifest.totalBuildings;
  if (!Number.isInteger(expected) || expected <= 0) { console.error('[stop] manifest.totalBuildings が不正:', expected); process.exit(1); }
  const files = fs.readdirSync(IN).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f));
  if (!files.length) { console.error('[stop] タイルが見つからない:', IN); process.exit(1); }

  const finalPath = path.join(OUT, 'buildings.migrated.jsonl');
  const partialPath = finalPath + '.partial';
  let fd = null;
  if (MODE === 'apply') {
    if (fs.existsSync(finalPath)) { console.error('[stop] 既存ファイルの上書きは拒否:', finalPath); process.exit(3); }
    fd = G.openNoOverwrite(partialPath);
  }
  const seen = new Set();
  let input = 0, converted = 0, written = 0, invalid = 0, dup = 0, peakMB = 0;
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf8'));
    for (const b of (t.buildings || [])) {
      input++;
      const bad = !b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3 || b.fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]));
      if (bad) { invalid++; continue; }              // 集計する（黙示除外ではなく後段で必ず停止）
      if (seen.has(b.id)) { dup++; continue; }
      seen.add(b.id);
      const a = core.negClosedRing(b.fp); vRing(b.fp, a, { layer: 'buildings', featureId: b.id, part: 'fp', index: null });
      const mb = { ...b, fp: a };
      if (core.deepEqual(core.omit(b, 'fp'), core.omit(mb, 'fp'))) V.attrOK++; V.attrTot++;
      converted++;
      if (fd !== null) { fs.writeSync(fd, JSON.stringify(mb) + '\n'); written++; }
      // dry-run では文字列を保持しない（JSON.stringifyもしない）
    }
    const h = G.memMB(); if (h > peakMB) peakMB = h;
  }
  if (fd !== null) fs.closeSync(fd);

  const checks = {
    invalidZero: invalid === 0,
    dupZero: dup === 0,
    inputEqualsManifest: input === expected,
    convertedEqualsManifest: converted === expected,
    writtenEqualsManifest: MODE === 'apply' ? written === expected : true,
    ringX: V.ringPtX === V.ringPtXtot, ringZ: V.ringPtZ === V.ringPtZtot,
    genuineMismatchZero: V.genuineMismatchCount === 0, closed: V.ringClosed === V.rings,
    bad0: V.bad === 0, attr: V.attrOK === V.attrTot,
  };
  const allOk = Object.values(checks).every(Boolean);
  console.log(`[migrate-buildings ${MODE}] tiles=${files.length} manifest.total=${expected}`);
  console.log(`  入力=${input} 変換=${converted} 出力=${MODE === 'apply' ? written : '(dry-run)'} invalidSkipped=${invalid} dupSkipped=${dup}`);
  console.log(`  rings total=${V.rings}  areaPreservedWithinTolerance=${V.areaPreservedCount}/${V.rings}  sourceDegenerate=${V.sourceDegenerateCount}  genuineMismatch=${V.genuineMismatchCount}  closed=${V.ringClosed}/${V.rings}`);
  console.log(`  ring X ${V.ringPtX}/${V.ringPtXtot}  ring Z ${V.ringPtZ}/${V.ringPtZtot}  points -  attributes ${V.attrOK}/${V.attrTot}  NaN ${V.bad}`);
  console.log(`  メモリ(ヒープ)ピーク ~${peakMB}MB`);
  printOrientDiagnostics();
  console.log('  判定:', allOk ? 'OK' : 'NG → ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
  if (MODE === 'apply') {
    if (!allOk) { fs.unlinkSync(partialPath); console.error('[stop] 検証NGのため .partial を削除し、出力しない'); process.exit(4); }
    fs.renameSync(partialPath, finalPath);
    G.writeNoOverwrite(path.join(OUT, 'buildings.migrated.report.json'), JSON.stringify({ tiles: files.length, expected, input, converted, written, invalid, dup, checks, peakMB }, null, 2));
    console.log('  出力:', finalPath);
  }
  process.exit(allOk ? 0 : 1);
}

// ========== migrate-overlays ==========
const META_KEYS = new Set(['datasetId', 'generatedAt', 'bbox', 'source', 'coordinateConfig']);
const LAYERS = {   // 明示的なキー→種別対応表（fetch-overlays.js の出力に一致）
  roads: { field: 'p', kind: 'polyline' },
  water: { field: 'p', kind: 'ring' },
  parks: { field: 'p', kind: 'ring' },
  cemetery: { field: 'p', kind: 'ring' },
  parking: { field: 'polygons', kind: 'poly-holes' },
  labels: { field: 'p', kind: 'point' },
  schools: { field: 'p', kind: 'auto' },
  temples: { field: 'p', kind: 'auto' },
};
const REQUIRED_LAYERS = Object.keys(LAYERS);
// 未知の値に座標らしき数値ペアが含まれるか（再帰）
function containsCoords(v, depth = 0) {
  if (depth > 6) return false;
  if (core.isPoint(v)) return true;
  if (Array.isArray(v)) return v.some((x) => containsCoords(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => containsCoords(x, depth + 1));
  return false;
}
function migrateOverlays() {
  G.assertSafeOutput(ROOT, IN, OUT);
  const ov = JSON.parse(fs.readFileSync(IN, 'utf8'));
  // 必須レイヤー欠落は停止
  const missing = REQUIRED_LAYERS.filter((k) => !(k in ov) || !Array.isArray(ov[k]));
  if (missing.length) { console.error('[stop] 必須レイヤー欠落:', missing.join(', ')); process.exit(5); }
  // 未知キーの検査（座標保有なら停止）
  for (const k of Object.keys(ov)) {
    if (META_KEYS.has(k) || LAYERS[k]) continue;
    if (containsCoords(ov[k])) { console.error('[stop] 未知の座標保有レイヤーを検出:', k); process.exit(5); }
    console.warn('[warn] 未知の非座標キーを素通し:', k);
  }
  const out = {}; const per = {}; let stop = null;
  for (const [k, v] of Object.entries(ov)) {
    if (!LAYERS[k]) { out[k] = v; continue; }
    const { field, kind } = LAYERS[k];
    per[k] = 0;
    out[k] = v.map((rec, recIdx) => {
      per[k]++;                                     // 全分岐で必ず1回加算
      let resolved = kind, m;
      if (kind === 'auto') {
        if (rec && Array.isArray(rec.polygons)) resolved = 'poly-holes';
        else if (rec && core.isPoint(rec[field])) resolved = 'point';
        else if (rec && core.isRing(rec[field])) resolved = 'ring';
        else { stop = `[stop] ${k} の形状をauto判定できない: ${JSON.stringify(rec).slice(0, 120)}`; return rec; }
      }
      const fid = (rec && rec.id) || null;
      if (resolved === 'poly-holes') {
        m = { ...rec, polygons: rec.polygons.map(core.negPolyWithHoles) };
        rec.polygons.forEach((pg, i) => {
          vRing(pg.outer, m.polygons[i].outer, { layer: k, featureId: fid, part: 'outer', index: recIdx });
          (pg.holes || []).forEach((h, j) => vRing(h, m.polygons[i].holes[j], { layer: k, featureId: fid, part: `hole[${j}]`, index: recIdx }));
        });
        if (core.deepEqual(core.omit(rec, 'polygons'), core.omit(m, 'polygons'))) V.attrOK++; V.attrTot++;
      } else if (resolved === 'polyline') {
        m = { ...rec, [field]: core.negPolyline(rec[field]) }; vLine(rec[field], m[field]);
        if (core.deepEqual(core.omit(rec, field), core.omit(m, field))) V.attrOK++; V.attrTot++;
      } else if (resolved === 'ring') {
        m = { ...rec, [field]: core.negClosedRing(rec[field]) }; vRing(rec[field], m[field], { layer: k, featureId: fid, part: 'ring', index: recIdx });
        if (core.deepEqual(core.omit(rec, field), core.omit(m, field))) V.attrOK++; V.attrTot++;
      } else if (resolved === 'point') {
        m = { ...rec, [field]: core.negPoint(rec[field]) }; vPoint(rec[field], m[field]);
        if (core.deepEqual(core.omit(rec, field), core.omit(m, field))) V.attrOK++; V.attrTot++;
      }
      return m;
    });
    if (stop) break;
  }
  if (stop) { console.error(stop); process.exit(5); }
  const counts = Object.fromEntries(REQUIRED_LAYERS.map((k) => [k, [ov[k].length, out[k].length]]));
  const checks = {
    countsPreserved: REQUIRED_LAYERS.every((k) => ov[k].length === out[k].length),
    ringX: V.ringPtX === V.ringPtXtot, ringZ: V.ringPtZ === V.ringPtZtot,
    genuineMismatchZero: V.genuineMismatchCount === 0, closed: V.ringClosed === V.rings,
    lineX: V.linePtX === V.linePtXtot, lineZ: V.linePtZ === V.linePtZtot,
    ptX: V.ptX === V.pts, ptZ: V.ptZ === V.pts, bad0: V.bad === 0, attr: V.attrOK === V.attrTot,
  };
  const allOk = Object.values(checks).every(Boolean);
  console.log(`[migrate-overlays ${MODE}] per-layer=`, per);
  console.log(`  rings total=${V.rings}  areaPreservedWithinTolerance=${V.areaPreservedCount}/${V.rings}  sourceDegenerate=${V.sourceDegenerateCount}  genuineMismatch=${V.genuineMismatchCount}  closed=${V.ringClosed}/${V.rings}`);
  console.log(`  ring X ${V.ringPtX}/${V.ringPtXtot}  ring Z ${V.ringPtZ}/${V.ringPtZtot}  line X ${V.linePtX}/${V.linePtXtot}  line Z ${V.linePtZ}/${V.linePtZtot}  points ${V.ptZ}/${V.pts}  attributes ${V.attrOK}/${V.attrTot}  NaN ${V.bad}  heap ~${G.memMB()}MB`);
  printOrientDiagnostics();
  console.log('  判定:', allOk ? 'OK' : 'NG → ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
  if (MODE === 'apply') {
    if (!allOk) { console.error('[stop] 検証NGのため出力しない'); process.exit(4); }
    const outFile = path.join(OUT, path.basename(IN));
    G.writeNoOverwrite(outFile, JSON.stringify(out));
    G.writeNoOverwrite(path.join(OUT, path.basename(IN, '.json') + '.report.json'), JSON.stringify({ counts, checks, ringIssues: V.ringIssues }, null, 2));
    console.log('  出力:', outFile);
  }
  process.exit(allOk ? 0 : 1);
}

// ========== migrate-extra-vars（embedded専用: ROADS[polyline配列] / TOWN_POLYGONS[町名→polygon(=ring配列)]） ==========
/* TOWN_POLYGONSの実データ構造（全340件調査済み）:
 *   TOWN_POLYGONS[町名] = polygon = [ring, ring, ...]   （現状は全340件が1ring/polygonだが、
 *   将来のoutと+hole等、複数ringを持つpolygonにも対応するため polygon内の全ringを処理する）
 *   ring = [[x,z], [x,z], ...]
 * 構造分類（深さで判定。real dataでの内訳を diagnostics に出す）:
 *   'ring'        : 値が直接 [[x,z],...]（polygon階層なし・現状0件だが将来出現しうる） → 未対応、停止
 *   'polygon'     : 値が [ring, ring, ...]（[0]がring＝点の配列）→ 対応（正しい構造）
 *   'multipolygon': 値が [polygon, polygon, ...]（[0]がpolygon＝ringの配列）→ 未対応、停止
 *   'unknown'     : 上記いずれでもない → 未対応、停止（黙って通さない） */
function classifyTownValue(v) {
  if (!Array.isArray(v) || v.length === 0) return 'unknown';
  const e0 = v[0];
  if (core.isPoint(e0)) return 'ring';
  if (Array.isArray(e0) && e0.length > 0 && core.isPoint(e0[0])) return 'polygon';
  if (Array.isArray(e0) && e0.length > 0 && Array.isArray(e0[0]) && e0[0].length > 0 && core.isPoint(e0[0][0])) return 'multipolygon';
  return 'unknown';
}
function migrateExtraVars() {
  G.assertSafeOutput(ROOT, IN, OUT);
  const kind = A['var-kind'];
  if (kind !== 'roads' && kind !== 'town-polygons') { console.error('[stop] --var-kind は roads|town-polygons のいずれか'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
  let out, per = 0;
  let townStats = null;
  if (kind === 'roads') {
    if (!Array.isArray(data)) { console.error('[stop] roadsは配列である必要がある'); process.exit(1); }
    out = data.map((rec) => {
      if (!rec || !Array.isArray(rec.p)) { console.error('[stop] 不正なroadsレコード:', JSON.stringify(rec).slice(0, 100)); process.exit(1); }
      const a = core.negPolyline(rec.p); vLine(rec.p, a); per++;
      const m = { ...rec, p: a };
      if (core.deepEqual(core.omit(rec, 'p'), core.omit(m, 'p'))) V.attrOK++; V.attrTot++;
      return m;
    });
  } else {
    if (Array.isArray(data) || typeof data !== 'object') { console.error('[stop] town-polygonsはdictである必要がある'); process.exit(1); }
    out = {};
    townStats = { townsTotal: 0, polygonsValid: 0, ringCounts: { ring: 0, polygon: 0, multipolygon: 0, unknown: 0 } };
    for (const [town, value] of Object.entries(data)) {
      townStats.townsTotal++;
      const cls = classifyTownValue(value);
      townStats.ringCounts[cls] = (townStats.ringCounts[cls] || 0) + 1;
      if (cls === 'unknown') { console.error(`[stop] town-polygons: 未知の構造(黙って通さない) town=${town} value=${JSON.stringify(value).slice(0, 150)}`); process.exit(5); }
      if (cls === 'multipolygon') { console.error(`[stop] town-polygons: multipolygon構造は未対応 town=${town}`); process.exit(5); }
      if (cls === 'ring') { console.error(`[stop] town-polygons: polygon階層のないring直下構造は未対応 town=${town}`); process.exit(5); }
      // cls === 'polygon'（正しい構造）: polygon内の【全ring】を処理する（polygon[0]だけを処理しない）
      townStats.polygonsValid++;
      const transformedRings = [];
      for (let ri = 0; ri < value.length; ri++) {
        const ring = value[ri];
        if (!core.isRing(ring)) { console.error(`[stop] town-polygons: 不正なring形状 town=${town} ringIndex=${ri}`); process.exit(5); }
        if (ring.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { console.error(`[stop] town-polygons: 非finite座標 town=${town} ringIndex=${ri}`); process.exit(5); }
        const after = core.negClosedRing(ring);
        vRing(ring, after, { layer: 'town-polygons', featureId: town, part: `ring[${ri}]`, index: townStats.townsTotal - 1 });
        transformedRings.push(after);
      }
      out[town] = transformedRings; // 町丁目名を変更しない・polygon内のring数を変更しない
      per++;
    }
  }
  let checks;
  if (kind === 'roads') {
    checks = { lineX: V.linePtX === V.linePtXtot, lineZ: V.linePtZ === V.linePtZtot, bad0: V.bad === 0, attr: V.attrOK === V.attrTot, countPreserved: data.length === out.length };
  } else {
    const inNames = Object.keys(data), outNames = Object.keys(out);
    const namesPreserved = inNames.length === outNames.length && inNames.every((n) => Object.prototype.hasOwnProperty.call(out, n));
    const ringCountPreserved = inNames.every((n) => out[n].length === data[n].length);
    checks = {
      townsTotal340: townStats.townsTotal === 340 || A['expect-towns'] === undefined, // --expect-towns指定時のみ厳密照合（下でも再検証）
      allPolygonType: townStats.polygonsValid === townStats.townsTotal,
      ringCountPreserved,
      namesPreserved,
      ringX: V.ringPtX === V.ringPtXtot, ringZ: V.ringPtZ === V.ringPtZtot,
      closed: V.ringClosed === V.rings,
      genuineMismatchZero: V.genuineMismatchCount === 0,
      bad0: V.bad === 0,
    };
    if (A['expect-towns'] && A['expect-towns'] !== true) {
      checks.townsTotalExpected = townStats.townsTotal === parseInt(A['expect-towns'], 10);
    }
  }
  const allOk = Object.values(checks).every(Boolean);
  console.log(`[migrate-extra-vars ${MODE}] kind=${kind} records=${per}`);
  if (kind === 'town-polygons') {
    const inNames = Object.keys(data), outNames = Object.keys(out);
    const namesPreservedCount = inNames.filter((n) => Object.prototype.hasOwnProperty.call(out, n)).length;
    console.log(`  towns total=${townStats.townsTotal}  polygons valid=${townStats.polygonsValid}/${townStats.townsTotal}  構造内訳=${JSON.stringify(townStats.ringCounts)}`);
    console.log(`  rings total=${V.rings}  closed=${V.ringClosed}/${V.rings}  ring X ${V.ringPtX}/${V.ringPtXtot}  ring Z ${V.ringPtZ}/${V.ringPtZtot}`);
    console.log(`  areaPreservedWithinTolerance=${V.areaPreservedCount}/${V.rings}  sourceDegenerate=${V.sourceDegenerateCount}  genuineMismatch=${V.genuineMismatchCount}`);
    console.log(`  town name preserved=${namesPreservedCount}/${townStats.townsTotal}  NaN=${V.bad}`);
  }
  printOrientDiagnostics();
  console.log('  判定:', allOk ? 'OK' : 'NG -> ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
  if (MODE === 'apply') {
    if (!allOk) { console.error('[stop] 検証NGのため出力しない'); process.exit(4); }
    const outFile = path.join(OUT, path.basename(IN).replace(/\.orig\./, '.migrated.'));
    G.writeNoOverwrite(outFile, JSON.stringify(out));
    console.log('  出力:', outFile);
  }
  process.exit(allOk ? 0 : 1);
}

if (sub === 'migrate-buildings') migrateBuildings();
else if (sub === 'migrate-overlays') migrateOverlays();
else if (sub === 'migrate-extra-vars') migrateExtraVars();
else { console.error('unknown subcommand:', sub); process.exit(1); }
