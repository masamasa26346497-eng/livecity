#!/usr/bin/env node
// Mission 164: make content-less interior tiles always refine.
// Cause of "nothing drawn / no GLB request": the generated tileset has an EMPTY root (and empty group tiles).
// If an empty tile's screen-space error is below maximumScreenSpaceError (small canvas or far camera), Cesium treats it
// as "good enough", selects nothing, and never requests the children -> blank. Raising geometricError of content-less
// parents (kept >= children, as 3D Tiles requires) forces refinement down to the leaf GLBs. Transforms/IDs/bounds untouched.
//   node tools/mission164/harden-tileset.mjs <tilesDir> [--ge 100000]
import fs from 'node:fs';
import path from 'node:path';

export function hardenTileset(ts, ge = 1e5) {
  let changed = 0;
  const walk = (n, depth) => {
    const kids = n.children || [];
    for (const c of kids) walk(c, depth + 1);
    if (!(n.content && (n.content.uri || n.content.url)) && kids.length) {
      const want = Math.max(n.geometricError || 0, ge / Math.pow(10, depth)); // root ge, groups ge/10, ...
      const kidMax = Math.max(0, ...kids.map((c) => c.geometricError || 0));
      const v = Math.max(want, kidMax + 1);
      if (v !== n.geometricError) { n.geometricError = v; changed++; }
    }
  };
  walk(ts.root, 0);
  ts.geometricError = Math.max(ts.geometricError || 0, ts.root.geometricError);
  return changed;
}

export function hardenDir(dir, ge) {
  const f = path.join(dir, 'tileset.json');
  const ts = JSON.parse(fs.readFileSync(f, 'utf8'));
  const changed = hardenTileset(ts, ge);
  fs.writeFileSync(f, JSON.stringify(ts));
  return changed;
}

if (process.argv[1] && process.argv[1].endsWith('harden-tileset.mjs')) {
  const dir = process.argv[2];
  const i = process.argv.indexOf('--ge');
  console.log(JSON.stringify({ dir, changedNodes: hardenDir(dir, i > 0 ? Number(process.argv[i + 1]) : 1e5) }));
}
