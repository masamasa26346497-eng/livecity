#!/usr/bin/env node
// tools/clean-embedded-water.js
// P1-5B: HTML 埋め込みの OSM_WATER から「川面を横断する巨大三角形」の原因になる壊れ record を
// ネットワーク無しで除去する（旧 fetch-water の個別way面化で生じた relation/18530061〜等）。
//
// 実行:
//   node tools/clean-embedded-water.js --html public/osaka_3d_buildings.html            (dry-run)
//   node tools/clean-embedded-water.js --html public/osaka_3d_buildings.html --write
//
// - kind='line'（河川中心線）は温存する（長い直線区間があっても正常）。
// - kind='area' で 巨大セグメント / 自己交差 / 退化 を含む record のみ除去する。
// - 除去した id を一覧で報告する。
// - 判定は tools/lib/water-geometry-validator.js と同一（analyzeRing）。

import fs from 'node:fs';
import { resolveProjectPath } from './lib/paths.js';
import { analyzeRing } from './lib/geometry-anomaly.js';

function parseArgs(argv) {
  const a = { html: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--html') a.html = argv[++i];
    else if (argv[i] === '--write') a.write = true;
  }
  return a;
}

function extractOsmWater(html) {
  const marker = 'const OSM_WATER = ';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const open = html.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) return { open, close: i + 1, arr: JSON.parse(html.slice(open, i + 1)) }; }
  }
  return null;
}

function isBroken(w) {
  if (!w || !Array.isArray(w.p) || w.p.length < 2) return { broken: true, why: 'no-points' };
  if (w.p.some((q) => !Array.isArray(q) || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) return { broken: true, why: 'non-finite' };
  if (w.kind === 'line') return { broken: false };
  for (const ring of [w.p, ...((w.holes || []))]) {
    const ev = analyzeRing(ring, { oversizedAbs: 350, oversizedMedianMult: 15, oversizedBboxRatio: 0.33 });
    if (ev.oversizedSegments > 0) return { broken: true, why: `oversized-segment(max ${Math.round(ev.maxSegment)}m)` };
    if (ev.selfIntersections > 0) return { broken: true, why: `self-intersection(${ev.selfIntersections})` };
    if (ev.uniquePoints < 3) return { broken: true, why: 'degenerate' };
  }
  return { broken: false };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.html) { console.error('使用法: node tools/clean-embedded-water.js --html <path> [--write]'); process.exit(1); }
  const htmlPath = resolveProjectPath(args.html);
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const found = extractOsmWater(html);
  if (!found) { console.error('OSM_WATER が見つかりません'); process.exit(1); }

  const kept = [];
  const dropped = [];
  for (const w of found.arr) {
    const r = isBroken(w);
    if (r.broken) dropped.push({ id: w.id, name: w.name || '', kind: w.kind, subtype: w.subtype, why: r.why });
    else kept.push(w);
  }

  console.log('=== OSM_WATER クリーニング ===');
  console.log(`入力: ${args.html}  元 ${found.arr.length}件（面 ${found.arr.filter((w) => w.kind !== 'line').length} / 線 ${found.arr.filter((w) => w.kind === 'line').length}）`);
  console.log(`保持: ${kept.length}件 / 除去: ${dropped.length}件`);
  for (const d of dropped) console.log(`  [DROP] ${d.id} (${d.name || 'name無し'}, ${d.subtype || d.kind}): ${d.why}`);

  if (!dropped.length) { console.log('除去対象なし。'); return; }
  if (!args.write) { console.log('\n--write を付けると HTML を更新します（dry-run）。'); return; }

  const newLiteral = JSON.stringify(kept);
  const updated = html.slice(0, found.open) + newLiteral + html.slice(found.close);
  fs.writeFileSync(htmlPath, updated);
  console.log(`\nHTML を更新しました: ${args.html}  （OSM_WATER ${found.arr.length} → ${kept.length}件）`);
}

main();
