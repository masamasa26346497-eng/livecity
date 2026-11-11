#!/usr/bin/env node
'use strict';
// Mission 37G 第2段階: 一時生成した 52 tile 3D Tiles の検証（読み取り専用）。
//   node tools/mission37b-build-3dtiles.cjs --all --out temp/m37g2-all
//   node tools/mission37g-verify-52tile.cjs [temp/m37g2-all]
// 検証: GLB 構造 / ids sidecar と元 tile の canonicalId 照合 / 重複 / 建物代表点の住吉区(N03)境界内率 / 総容量
const fs = require('fs');
const path = require('path');
const lib = require('./mission37b-build-3dtiles.cjs');

const root = path.join(__dirname, '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'temp', 'm37g2-all'));
const src = path.join(root, 'public', 'map-data', 'osaka-city', 'buildings', 'osaka-sumiyoshi');
const rep = { dir: path.relative(root, dir), tiles: 0, glbBytes: 0, idsBytes: 0, buildings: 0, idMismatch: [], dup: 0, badGlb: [], outsideWard: 0, checkedPts: 0 };

const wardsDoc = JSON.parse(fs.readFileSync(path.join(root, 'public', 'mission37g-data', 'osaka-24-wards.json'), 'utf8'));
const ward = wardsDoc.wards.find((x) => x.wardName === '住吉区');
const rings = ward ? ward.polygons.map((p) => p.outer) : []; // 区境界は建物と同じ局所座標 (x, z)
function inside(x, z) {
  return rings.some((r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > z) !== (yj > z) && x < (xj - xi) * (z - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  });
}

const seen = new Set();
for (const f of fs.readdirSync(path.join(dir, 'tiles'))) {
  const name = f.replace('.glb', '');
  const m = /^t_(-?\d+)_(-?\d+)$/.exec(name);
  if (!m) continue;
  rep.tiles++;
  const buf = fs.readFileSync(path.join(dir, 'tiles', f));
  rep.glbBytes += buf.length;
  try { const g = lib.parseGlb(buf); if (!g || !g.json) throw new Error('no json'); } catch (e) { rep.badGlb.push(f + ': ' + e.message); }
  const idPath = path.join(dir, 'ids', name + '.json');
  const ids = JSON.parse(fs.readFileSync(idPath, 'utf8'));
  rep.idsBytes += fs.statSync(idPath).size;
  const sj = JSON.parse(fs.readFileSync(path.join(src, `tile_${m[1]}_${m[2]}.json`), 'utf8'));
  const blds = Array.isArray(sj) ? sj : (sj.buildings || sj.features || []);
  const srcIds = new Set(blds.map((b) => b.id));
  rep.buildings += ids.length;
  for (const id of ids) {
    if (seen.has(id)) rep.dup++;
    seen.add(id);
    if (!srcIds.has(id)) rep.idMismatch.push(id);
  }
  if (ids.length !== srcIds.size) rep.idMismatch.push(`${name}: count ${ids.length} vs ${srcIds.size}`);
  if (rings.length) {
    for (const b of blds) {
      if (typeof b.repX !== 'number') continue;
      rep.checkedPts++;
      if (!inside(b.repX, b.repZ)) rep.outsideWard++;
    }
  }
}
rep.wardFound = !!ward;
console.log(JSON.stringify(rep, null, 1));
