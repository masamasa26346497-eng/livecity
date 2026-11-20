// Mission 156: independent loader/adapter. Does NOT touch public/osaka_3d_buildings.html or any PR #24/#50 file.
// const a = await loadMission156Manifest(url); a.tilesetUrlFor('sumiyoshi'); await a.addAllToCesium(viewer, Cesium)
// Buildings keep canonical gml:id so LOD2 (PR #50) can be joined later by id. Wards absent from the manifest get no 3D layer (nothing is guessed).
export async function loadMission156Manifest(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error('manifest HTTP ' + res.status);
  const m = await res.json();
  if (m.schema !== 'livecity-mission156-delivery/1') throw new Error('unexpected manifest schema');
  const base = new URL(url, globalThis.location ? globalThis.location.href : 'http://localhost/');
  const byWard = new Map(m.wards.map((w) => [w.ward, w]));
  return {
    manifest: m,
    wards: () => [...byWard.keys()],
    tilesetUrlFor: (ward) => (byWard.has(ward) ? new URL(byWard.get(ward).tileset, base).href : null),
    async addAllToCesium(viewer, Cesium) {
      const out = [];
      for (const w of byWard.values()) {
        const ts = await Cesium.Cesium3DTileset.fromUrl(new URL(w.tileset, base).href);
        viewer.scene.primitives.add(ts);
        out.push({ ward: w.ward, tileset: ts });
      }
      return out;
    },
  };
}
