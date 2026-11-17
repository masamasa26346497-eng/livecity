// public/supplement-layer/projection.js  [Issue #65 / 第7段階]
// world(x,z)[m] <-> lon/lat。PR#68 mission37g-osaka-24ward-mvp.html の PROJ / COS_CLAT / toLon / toLat / cartToLocal と同一式
// （znorth-neg-v1: lon = clon + x/(cos(clat)*mpd), lat = clat - z/mpd）。定数は変更禁止（既存建物とズレる）。
export const PROJ = Object.freeze({ clat: 34.604208, clon: 135.525020, mpd: 111320 });

export function makeProjection(proj = PROJ) {
  const cosClat = Math.cos(proj.clat * Math.PI / 180);
  const toLon = (x) => proj.clon + x / (cosClat * proj.mpd);
  const toLat = (z) => proj.clat - z / proj.mpd;
  const toLocal = (lon, lat) => ({ x: (lon - proj.clon) * cosClat * proj.mpd, z: -((lat - proj.clat) * proj.mpd) });
  return { proj, cosClat, toLon, toLat, toLocal };
}
