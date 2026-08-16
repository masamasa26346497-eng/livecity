#!/usr/bin/env node
'use strict';
/* regen-embedded-from-remote.cjs v2 — 移行済みremoteを正本に embedded bootstrap を再生成。
 *  - BLDGS: 移行済み建物JSONLを readline で1行ずつ読み、bbox内のみ保持（全件を配列に載せない）。
 *  - BLDGS以外:
 *      集約overlay JSON（移行済み）から明示的キー対応表で 6変数を再埋め込み:
 *        OSM_ROADS←roads / OSM_PARKS←parks / OSM_CEMETERY←cemetery / OSM_WATER←water /
 *        OSM_PARKING←parking / OSM_LABELS←labels
 *      embedded専用の ROADS / TOWN_POLYGONS は --extra-dir の移行済み {VAR}.json から再埋め込み。
 *  - 必須（BLDGS + 上記8変数）が1つでも欠けたら停止。overlay内の schools/temples は
 *    embedded変数を持たないため対象外（既知・報告のみ）。未知の座標保有レイヤーは停止。
 *  - 入力HTMLと出力HTMLは「ファイル絶対パスそのもの」を比較（同一フォルダ内の別ファイルは許可、
 *    完全同一ファイルのみ停止）。出力は io-guard 許可リスト内のみ・上書き拒否。
 * usage: node tools/regen-embedded-from-remote.cjs --project-root <dir> \
 *   --buildings <jsonl> --bbox minX,maxX,minZ,maxZ --overlays <migrated overlay json> \
 *   --extra-dir <dir with ROADS.json,TOWN_POLYGONS.json> --html <src html> --out <dst html> [--apply] */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const core = require('./lib/znegate-core.cjs');
const G = require('./lib/io-guard.cjs');
const A = G.parseArgs(process.argv.slice(2));
const ROOT = G.requireProjectRoot(A);
const MODE = A.apply ? 'apply' : 'dry-run';
for (const k of ['buildings', 'bbox', 'overlays', 'extra-dir', 'html', 'out']) {
  if (!A[k] || A[k] === true) { console.error('usage: --project-root --buildings <jsonl> --bbox minX,maxX,minZ,maxZ --overlays <json> --extra-dir <dir> --html <src> --out <dst> [--apply]'); process.exit(1); }
}
const [minX, maxX, minZ, maxZ] = String(A.bbox).split(',').map(Number);
if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) { console.error('[stop] bbox が不正:', A.bbox); process.exit(1); }
const HTML_IN = path.resolve(A.html), HTML_OUT = path.resolve(A.out);
G.assertSafeOutput(ROOT, HTML_IN, HTML_OUT);       // 同一ファイルのみ停止（同一親フォルダの別ファイルは許可）

const OVERLAY_MAP = { OSM_ROADS: 'roads', OSM_PARKS: 'parks', OSM_CEMETERY: 'cemetery', OSM_WATER: 'water', OSM_PARKING: 'parking', OSM_LABELS: 'labels' };
const EXTRA_VARS = ['ROADS', 'TOWN_POLYGONS'];
const KNOWN_UNEMBEDDED = new Set(['schools', 'temples']);   // overlayにあるがembedded変数なし（既知）
const META_KEYS = new Set(['datasetId', 'generatedAt', 'bbox', 'source', 'coordinateConfig']);

function valueSpan(html, name) {
  const re = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*'); const m = re.exec(html); if (!m) throw new Error('宣言なし: ' + name);
  const j = m.index + m[0].length; const oc = html[j], cc = oc === '[' ? ']' : '}'; let depth = 0, inStr = false, q = '';
  for (let k = j; k < html.length; k++) { const c = html[k]; if (inStr) { if (c === q && html[k - 1] !== '\\') inStr = false; continue; } if (c === '"' || c === "'") { inStr = true; q = c; continue; } if (c === oc) depth++; else if (c === cc) { depth--; if (depth === 0) return [j, k + 1]; } }
  throw new Error('閉じ括弧なし: ' + name);
}
function containsCoords(v, depth = 0) {
  if (depth > 6) return false;
  if (core.isPoint(v)) return true;
  if (Array.isArray(v)) return v.some((x) => containsCoords(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => containsCoords(x, depth + 1));
  return false;
}

async function main() {
  // ---- 集約overlay（移行済み）を読み、6変数の再埋め込み材料を作る（必須欠落は停止） ----
  const ov = JSON.parse(fs.readFileSync(path.resolve(A.overlays), 'utf8'));
  const overlayJson = {};
  for (const [varName, layer] of Object.entries(OVERLAY_MAP)) {
    if (!(layer in ov) || !Array.isArray(ov[layer])) { console.error('[stop] 必須overlayレイヤー欠落:', layer, '（→', varName, '）'); process.exit(5); }
    overlayJson[varName] = JSON.stringify(ov[layer]);
  }
  for (const k of Object.keys(ov)) {
    if (META_KEYS.has(k) || Object.values(OVERLAY_MAP).includes(k) || KNOWN_UNEMBEDDED.has(k)) continue;
    if (containsCoords(ov[k])) { console.error('[stop] 未知の座標保有レイヤーを検出:', k); process.exit(5); }
  }
  // ---- extra（embedded専用: ROADS / TOWN_POLYGONS 移行済み） 欠落は停止 ----
  for (const v of EXTRA_VARS) {
    const p = path.join(path.resolve(A['extra-dir']), v + '.json');
    if (!fs.existsSync(p)) { console.error('[stop] extra欠落:', p); process.exit(5); }
    overlayJson[v] = fs.readFileSync(p, 'utf8');
  }

  // ---- BLDGS: JSONL を1行ずつ読み、bbox内のみ保持 ----
  const selected = []; const selIds = new Set();
  let lineNo = 0, dupSel = 0, badSel = 0, peakMB = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(path.resolve(A.buildings), { encoding: 'utf8' }) });
  for await (const line of rl) {
    const s = line.trim(); if (!s) continue;
    lineNo++;
    const b = JSON.parse(s);
    if (!b || !b.id || !Array.isArray(b.fp) || b.fp.length < 3 || b.fp.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { badSel++; continue; }
    let sx = 0, sz = 0; for (const p of b.fp) { sx += p[0]; sz += p[1]; }
    const cx = sx / b.fp.length, cz = sz / b.fp.length;
    if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) continue;
    if (selIds.has(b.id)) { dupSel++; continue; }
    selIds.add(b.id); selected.push(b);
    const h = G.memMB(); if (h > peakMB) peakMB = h;
  }
  const checks = { bldgsNonEmpty: selected.length > 0, noDupInSelection: dupSel === 0, noBadInStream: badSel === 0 };
  const allOk = Object.values(checks).every(Boolean);
  console.log(`[regen-embedded ${MODE}] JSONL行=${lineNo} bbox内=${selected.length} dup=${dupSel} bad=${badSel} heapピーク~${peakMB}MB`);
  console.log('  再埋め込み: BLDGS + overlay6変数(' + Object.keys(OVERLAY_MAP).join(',') + ') + extra(' + EXTRA_VARS.join(',') + ')');
  console.log('  overlay対象外(既知): schools, temples（embedded変数なし）');
  console.log('  判定:', allOk ? 'OK' : 'NG → ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
  if (!allOk) process.exit(1);

  // ---- HTML差し替え（後方から） ----
  let html = fs.readFileSync(HTML_IN, 'utf8');
  const repl = [{ name: 'BLDGS', json: JSON.stringify(selected) }];
  for (const [name, json] of Object.entries(overlayJson)) repl.push({ name, json });
  repl.map((r) => ({ ...r, span: valueSpan(html, r.name) })).sort((a, b) => b.span[0] - a.span[0])
    .forEach((r) => { html = html.slice(0, r.span[0]) + r.json + html.slice(r.span[1]); });

  if (MODE === 'apply') {
    G.writeNoOverwrite(HTML_OUT, html);
    G.writeNoOverwrite(HTML_OUT.replace(/\.html$/, '') + '.regen-report.json',
      JSON.stringify({ bbox: [minX, maxX, minZ, maxZ], bldgs: selected.length, vars: ['BLDGS', ...Object.keys(overlayJson)], checks, peakMB }, null, 2));
    console.log('  出力:', HTML_OUT);
  }
  process.exit(0);
}
main().catch((e) => { console.error('[stop]', e.message); process.exit(1); });
