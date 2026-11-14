#!/usr/bin/env node
// Mission 166: 同一 GML 内の同一 gml:id について LOD1(lod1Solid) と LOD2 の垂直・水平関係を数値比較する(読み取り専用)。
//   node tools/lod2/lod2-lod1-compare.mjs --meshes 51357371,51357381,51357382 [--gml-dir DIR] [--out temp/lod2-compare/report.json]
// LOD1 変換器(convert-plateau-buildings.js)は z0=0 (底面=0) + h(measuredHeight 優先)で建物を置く。
// LOD2 の「建物ごとに最低点を h=0」が LOD1 と同じ底面基準かを、LOD1 solid / LOD2 の最低標高差で測る。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitBuildings } from '../lib/citygml.js';
import { LOCK_PATH } from '../mission79-plateau2025-source.mjs';

const posLists = (xml) => [...xml.matchAll(/<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
const block = (xml, tag) => (xml.match(new RegExp('<bldg:' + tag + '>[\\s\\S]*?</bldg:' + tag + '>', 'g')) || []).join('\n');
function stats(lists) {
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const l of lists) {
    for (let i = 0; i + 2 < l.length; i += 3) {
      ymin = Math.min(ymin, l[i]); ymax = Math.max(ymax, l[i]); xmin = Math.min(xmin, l[i + 1]); xmax = Math.max(xmax, l[i + 1]);
      zmin = Math.min(zmin, l[i + 2]); zmax = Math.max(zmax, l[i + 2]);
    }
  }
  return Number.isFinite(zmin) ? { zmin, zmax, lat: [ymin, ymax], lon: [xmin, xmax] } : null;
}
/** 1棟の LOD1/LOD2 比較。LOD2 または LOD1 が無い棟は null。 */
export function compareBuilding(xml) {
  const l2 = stats(posLists(block(xml, 'lod2Solid') + block(xml, 'lod2MultiSurface')));
  const l1 = stats(posLists(block(xml, 'lod1Solid')));
  if (!l2 || !l1) return null;
  const mh = (xml.match(/<bldg:measuredHeight[^>]*>([\d.]+)<\/bldg:measuredHeight>/) || [])[1];
  const M = 111320, cosLat = Math.cos(l1.lat[0] * Math.PI / 180);
  return {
    l1Base: l1.zmin, l2Base: l2.zmin, baseDiffM: +(l2.zmin - l1.zmin).toFixed(3),
    l1Height: +(l1.zmax - l1.zmin).toFixed(3), l2Height: +(l2.zmax - l2.zmin).toFixed(3),
    heightDiffM: +((l2.zmax - l2.zmin) - (l1.zmax - l1.zmin)).toFixed(3),
    measuredHeight: mh ? +mh : null,
    // 水平: 外接矩形の四辺のずれ(m)の最大。同一 GML 由来なので小さいはず(屋根の軒の張り出し分は許容)
    horizDiffM: +Math.max(Math.abs(l2.lat[0] - l1.lat[0]) * M, Math.abs(l2.lat[1] - l1.lat[1]) * M,
      Math.abs(l2.lon[0] - l1.lon[0]) * M * cosLat, Math.abs(l2.lon[1] - l1.lon[1]) * M * cosLat).toFixed(3),
  };
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
export function summarize(rows) {
  const abs = (k) => rows.map((r) => Math.abs(r[k]));
  const d = (k) => ({ p50: q(abs(k), 0.5), p95: q(abs(k), 0.95), max: rows.length ? Math.max(...abs(k)) : null });
  const within = rows.filter((r) => Math.abs(r.baseDiffM) <= 0.5).length;
  return {
    n: rows.length, baseDiffM: d('baseDiffM'), heightDiffM: d('heightDiffM'), horizDiffM: d('horizDiffM'), baseWithin0_5m: within,
    // 建物ごと minH→0 が LOD1(z0=0 底面基準)と同じ意味になる条件 = LOD1/LOD2 の底面標高差が小さいこと
    perBuildingGroundToZeroConsistent: rows.length > 0 && within / rows.length >= 0.95,
  };
}
export function compareXml(xml) {
  const rows = [];
  for (const b of splitBuildings(xml)) {
    const r = compareBuilding(b);
    if (r) rows.push({ id: (b.match(/gml:id="([^"]+)"/) || [])[1], ...r });
  }
  return rows;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2), g = (k, d = null) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : d);
  const meshes = g('--meshes', '51357371,51357381,51357382').split(','), gmlDir = g('--gml-dir');
  const out = path.resolve(g('--out', 'temp/lod2-compare/report.json'));
  if (/[\\/]public[\\/]/.test(out)) throw new Error('refusing to write under public/');
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); const all = [], per = {};
  for (const m of meshes) {
    let xml;
    if (gmlDir) xml = fs.readFileSync(path.join(gmlDir, m + '_bldg_6697_op.gml'), 'utf8');
    else {
      const { fetchEntry } = await import('./lod2-audit.mjs');
      const e = lock.entries.find((x) => x.kind === 'bldg' && x.mesh === m);
      xml = await fetchEntry(lock.resource.url, e);
    }
    const rows = compareXml(xml); per[m] = summarize(rows); all.push(...rows);
  }
  const rep = { mission: 166, meshes, overall: summarize(all), perMesh: per, worst: [...all].sort((x, y) => Math.abs(y.baseDiffM) - Math.abs(x.baseDiffM)).slice(0, 5) };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rep, null, 1));
  console.log(JSON.stringify(rep));
}
