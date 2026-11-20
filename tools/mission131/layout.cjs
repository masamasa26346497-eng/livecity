'use strict';
// Mission 131: archive-layout discovery shared by the Mission129 data check and the Mission130 browser runner.
// Mission129 run 42240020830 extracted 21/21 archives but found 0 at <ward>25/tileset.json, so the real layout was never known.
// This module finds tileset.json wherever it landed (depth <= 4, real dirs only, no symlinks) and attributes it to a ward by an EXACT
// path-segment match (ward, <ward>25, plateau2025-<ward>, _x_<ward>), so sumiyoshi never matches higashisumiyoshi. Read-only; no network.
const fs = require('fs');
const path = require('path');
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const tokens = (ward) => [ward, ward + '25', 'plateau2025-' + ward, 'plateau2025-' + ward + '25', '_x_' + ward];
const isTilesetDir = (d) => { const s = lst(path.join(d, 'tileset.json')); return !!(s && s.isFile() && !s.isSymbolicLink()); };

/** All directories under root (including root itself) that contain tileset.json. */
function findTilesetDirs(root, maxDepth) {
  const out = [], lim = maxDepth == null ? 4 : maxDepth;
  (function walk(d, depth) {
    if (isTilesetDir(d)) out.push(d);
    if (depth >= lim) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name), depth + 1);
  })(root, 0);
  return out;
}
/** Attributes a tileset dir to the ward. Returns {dir, rel, layout} | {dir:null, layout:'ambiguous'} | null. */
function discoverWard(root, ward, dirs) {
  const list = dirs || findTilesetDirs(root);
  const tk = tokens(ward);
  const hits = list.filter((d) => path.relative(root, d).split(path.sep).some((s) => tk.includes(s)));
  if (!hits.length) return null;
  const depth = (d) => path.relative(root, d).split(path.sep).length;
  const min = Math.min(...hits.map(depth)), top = hits.filter((d) => depth(d) === min);
  if (top.length > 1) return { dir: null, rel: null, layout: 'ambiguous', candidates: top.length };
  const rel = path.relative(root, top[0]);
  const layout = rel === ward + '25' ? 'expected(<ward>25)' : rel.split(path.sep).length === 1 ? 'alt(' + rel.replace(ward, '<ward>') + ')' : 'nested';
  return { dir: top[0], rel, layout };
}
/** Names only (never contents): per-extension file counts + a few top dirs, to diagnose an unknown layout from a CI log. */
function probeTree(root, maxDepth) {
  const lim = maxDepth == null ? 3 : maxDepth, ext = {}, dirs = [];
  let files = 0;
  (function walk(d, depth) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (depth < lim) { if (depth <= 1) dirs.push(path.relative(root, path.join(d, e.name))); walk(path.join(d, e.name), depth + 1); }
      } else if (e.isFile()) { files++; const x = path.extname(e.name).toLowerCase() || '(none)'; ext[x] = (ext[x] || 0) + 1; }
    }
  })(root, 0);
  return { files, byExt: ext, dirsSample: dirs.sort().slice(0, 12), tilesetDirs: findTilesetDirs(root).length };
}
/** Relative content URIs referenced by tileset.json (content.uri / url, recursively). Only plain relative paths are returned. */
function contentUris(dir) {
  let ts; try { ts = JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8')); } catch (e) { return null; }
  const out = new Set();
  (function walk(t) {
    if (!t || typeof t !== 'object') return;
    const list = [t.content].concat(Array.isArray(t.contents) ? t.contents : []);
    for (const cc of list) {
      const u = cc && (cc.uri || cc.url);
      if (typeof u === 'string' && !/^[a-z]+:|^\/|\.\.|\\/i.test(u)) out.add(u.replace(/^\.\//, ''));
    }
    for (const ch of t.children || []) walk(ch);
  })(ts.root);
  return [...out];
}
module.exports = { tokens, findTilesetDirs, discoverWard, probeTree, contentUris };
