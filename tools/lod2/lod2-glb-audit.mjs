// GLB material / vertex colour audit (read-only). usage: node lod2-glb-audit.mjs a.glb b.glb ...
import fs from 'fs';
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.slice(20, 20 + jl).toString());
  const bl = 20 + jl + ((4 - jl % 4) % 4);
  const bin = b.slice(bl + 8);
  console.log(f.split('/').slice(-2).join('/'), 'ext', JSON.stringify(j.extensionsUsed), 'mat', JSON.stringify(j.materials));
  const pa = j.meshes[0].primitives[0].attributes;
  const ca = j.accessors[pa.COLOR_0];
  if (!ca) { console.log(' no COLOR_0'); continue; }
  const bv = j.bufferViews[ca.bufferView];
  const off = (bv.byteOffset || 0) + (ca.byteOffset || 0);
  const n = ca.type === 'VEC4' ? 4 : 3;
  const s = [0, 0, 0];
  for (let i = 0; i < ca.count; i++) for (let c = 0; c < 3; c++) {
    s[c] += ca.componentType === 5126 ? bin.readFloatLE(off + (i * n + c) * 4)
      : ca.componentType === 5123 ? bin.readUInt16LE(off + (i * n + c) * 2) / 65535
      : bin[off + i * n + c] / 255;
  }
  console.log(' verts', ca.count, 'meanRGB', s.map(x => (x / ca.count).toFixed(3)).join(','), 'attrs', Object.keys(pa).join(','));
}
