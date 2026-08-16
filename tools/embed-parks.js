#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/embed-parks.js
// ══════════════════════════════════════════════════════════════
// landuse.json の公園データを HTML の OSM_PARKS 定数へ反映する。
//
// 対象: leisure_park（公園） / landuse_recreation_ground（運動場）のみ。
//   ※ 墓地(landuse_cemetery)・森林(natural_wood)・河川・駐車場・学校は今回の対象外（指示による除外）。
// 既存OSM_PARKSのエントリは保持し、重心+面積で重複判定して未収録のものだけを追加する。
//
// 使い方:
//   node tools/embed-parks.js --html public/osaka_3d_buildings.html --landuse data/landuse.json [--dry-run]

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}
const centroid = pts => {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
};
const areaOf = pts => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
};
// 凹頂点の有無（fan分割が破綻する形状か）
function isConcave(pts) {
  let sign = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return true;
  }
  return false;
}

const args = parseArgs(process.argv.slice(2));
const htmlPath = args.html || 'public/osaka_3d_buildings.html';
const landusePath = args.landuse || 'data/landuse.json';

const html = fs.readFileSync(htmlPath, 'utf8');
const line = html.split('\n').find(l => l.startsWith('const OSM_PARKS = '));
if (!line) { console.error('const OSM_PARKS = ... が見つかりません'); process.exit(1); }
let existing;
eval(line.replace('const OSM_PARKS = ', 'existing = ').replace(/;\s*$/, ';'));

const landuse = JSON.parse(fs.readFileSync(landusePath, 'utf8'));
const TARGET = ['leisure_park', 'landuse_recreation_ground'];
const cands = landuse.filter(x => TARGET.includes(x.subtype) && x.polygons && x.polygons[0] &&
  Array.isArray(x.polygons[0].outer) && x.polygons[0].outer.length >= 3);

const stats = { landuseCandidates: cands.length, existing: existing.length,
  added: 0, duplicate: 0, tooSmall: 0, invalid: 0, concaveAdded: 0, concaveExisting: 0 };
const MIN_AREA = 50; // m²未満は描画しても視認できずノイズになるため除外

const exIndex = existing.map(p => ({ c: centroid(p.p), a: areaOf(p.p) }));
for (const e of existing) if (isConcave(e.p)) stats.concaveExisting++;

const merged = existing.slice();
for (const f of cands) {
  const outer = f.polygons[0].outer;
  if (outer.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) { stats.invalid++; continue; }
  const a = areaOf(outer), c = centroid(outer);
  if (a < MIN_AREA) { stats.tooSmall++; continue; }
  const dup = exIndex.some(e => Math.hypot(e.c[0] - c[0], e.c[1] - c[1]) < 15 &&
    Math.abs(e.a - a) < Math.max(e.a, a) * 0.25);
  if (dup) { stats.duplicate++; continue; }
  // 閉リング（先頭=末尾）なら末尾を除去して開リング化（既存OSM_PARKSと同形式）
  let p = outer.map(q => [Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100]);
  if (p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
  merged.push({ tag: f.subtype, name: (f.tags && f.tags.name) || '', p });
  exIndex.push({ c, a });
  stats.added++;
  if (isConcave(p)) stats.concaveAdded++;
}

const totalArea = Math.round(merged.reduce((s, p) => s + areaOf(p.p), 0));
console.log('landuse候補:', stats.landuseCandidates, '件（leisure_park + landuse_recreation_ground）');
console.log('既存OSM_PARKS:', stats.existing, '件 / 重複除外:', stats.duplicate,
  '/ 面積過小除外:', stats.tooSmall, '/ 無効:', stats.invalid);
console.log('追加:', stats.added, '件 → 合計:', merged.length, '件 / 総面積:', totalArea, 'm²');
console.log('凹形状（fan分割では破綻する形状）: 既存', stats.concaveExisting, '件 + 追加分', stats.concaveAdded, '件');
console.log('名称あり:', merged.filter(p => p.name).length, '件');

if (args['dry-run']) { console.log('--dry-run のためHTMLは更新していません。'); process.exit(0); }

const newLine = 'const OSM_PARKS = ' + JSON.stringify(merged) + ';';
fs.writeFileSync(htmlPath, html.replace(line, newLine));
console.log('HTMLのOSM_PARKSを更新しました:', htmlPath);
