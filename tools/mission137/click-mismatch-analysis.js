#!/usr/bin/env node
// Mission 137: footprint 建物の canonicalId クリック不一致の原因分類（読み取り専用・ネットワーク不要）。
//   node tools/mission137/click-mismatch-analysis.js --dir public/map-data/osaka-city/buildings/osaka-sumiyoshi [--ids a,b] [--out new.json]
// 屋根中心(repX,repZ)を pick した結果が別 ID だった場合の原因を、幾何から区別する:
//   - overlap-higher : 屋根中心が「より高い頂部を持つ別建物の footprint」の内側にある（重なり合う建物。上の建物が pick される＝画面上は正常）
//   - overlap-lower  : 屋根中心が別建物の footprint 内だが、そちらの方が低い（pick が逆転しているなら取り違えの疑い）
//   - duplicate-fp   : ほぼ同一面積の footprint が別 ID で重複
//   - none           : 他建物と重ならない（代表点が自身の footprint 外、または pick 側の問題の疑い）
// canonicalId は一切変更しない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pip(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const polyArea = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
const bboxOf = (p) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const q of p) { a = Math.min(a, q[0]); b = Math.max(b, q[0]); c = Math.min(c, q[1]); d = Math.max(d, q[1]); } return [a, b, c, d]; };

export function loadBuildings(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), out = [];
  for (const t of m.tiles) for (const b of JSON.parse(fs.readFileSync(path.join(dir, t.file), 'utf8')).buildings || []) out.push(b);
  return out;
}

/** targetIds の各建物について、屋根中心を覆う他建物を列挙して分類する。 */
export function classify(buildings, targetIds) {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const prepared = buildings.map((b) => ({ b, bb: bboxOf(b.fp || []) }));
  return targetIds.map((id) => {
    const b = byId.get(id); if (!b) return { id, class: 'unknown-id' };
    const own = pip(b.repX, b.repZ, b.fp);
    const top = (b.z0 || 0) + b.h, area = polyArea(b.fp), covers = [];
    for (const o of prepared) {
      if (o.b.id === id) continue;
      const [x0, x1, z0, z1] = o.bb;
      if (b.repX < x0 || b.repX > x1 || b.repZ < z0 || b.repZ > z1) continue;
      if (pip(b.repX, b.repZ, o.b.fp)) covers.push({ id: o.b.id, top: +((o.b.z0 || 0) + o.b.h).toFixed(2), areaM2: +polyArea(o.b.fp).toFixed(1) });
    }
    let cls = 'none';
    if (covers.some((c) => Math.abs(c.areaM2 - area) < 0.5)) cls = 'duplicate-fp';
    else if (covers.some((c) => c.top > top)) cls = 'overlap-higher';
    else if (covers.length) cls = 'overlap-lower';
    return { id, class: cls, ownContainsRep: own, top: +top.toFixed(2), areaM2: +area.toFixed(1), coveredBy: covers };
  });
}

/** 区全体の重なり統計（クリック不一致が起こり得る母数）。 */
export function overlapStats(buildings) {
  const r = classify(buildings, buildings.map((b) => b.id)), byClass = {};
  for (const x of r) byClass[x.class] = (byClass[x.class] || 0) + 1;
  return { total: buildings.length, byClass };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  const dir = opt('dir'); if (!dir) { console.error('usage: --dir <footprints dir> [--ids id1,id2] [--out new.json]'); process.exit(2); }
  const bl = loadBuildings(dir), ids = (opt('ids') || '').split(',').filter(Boolean);
  const rep = { schema: 'livecity.mission137.click-mismatch/1', dir, buildings: bl.length, targets: classify(bl, ids), wardOverlap: overlapStats(bl) };
  if (opt('out')) { fs.mkdirSync(path.dirname(path.resolve(opt('out'))), { recursive: true }); fs.writeFileSync(opt('out'), JSON.stringify(rep, null, 1), { flag: 'wx' }); }
  console.log(JSON.stringify(rep, null, 1));
}
