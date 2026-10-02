// tools/photos/footprint-lookup.mjs
// [Mission 36A §1/§3] build 時に「この座標はどの建物の footprint の中か」を引く。
//
//   35Z では build 時に footprint を持っていなかったため、名前一致でしか建物へ結び付けられず
//   （hover 対応 5 棟）、近さで結ぶと実測で全部ちがう建物になった。
//   ここでは配信中の canonical 建物タイル（V4 / near）をそのまま読み、
//   **点が polygon の内側かどうか** で判定する。距離は一切使わない。
//
//   巨大な索引ファイルは作らない。点が属する 500m タイルとその周囲だけを読み、
//   読んだタイルは LRU で持ち回る（618,749 棟を全部メモリに載せない）。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'public/map-data/osaka-city/derived-v4-final/near/buildings';
const TILE = 500;                  // manifest の tileSize
const MAX_TILES = 900;             // LRU 上限（1 タイル ≒ 500 棟）

// 既存レイヤーと同じ投影（znorth-neg-v1）。ここを変えてはいけない。
export const CLAT = 34.604208, CLON = 135.52502, MPD = 111320;
export const toLocal = (lat, lon) => ({
  x: (lon - CLON) * Math.cos(CLAT * Math.PI / 180) * MPD,
  z: -((lat - CLAT) * MPD),
});

const cache = new Map();           // 'tx_tz' -> features[]（無いタイルは null）
const stats = { tileReads: 0, tileMisses: 0, pointTests: 0, ringTests: 0 };

function loadTile(tx, tz) {
  const key = tx + '_' + tz;
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key); cache.set(key, v);      // LRU: 使ったら末尾へ
    return v;
  }
  const f = path.join(BASE, 'tile_' + key + '.json');
  let feats = null;
  if (fs.existsSync(f)) {
    try { feats = JSON.parse(fs.readFileSync(f, 'utf-8')).features || []; stats.tileReads++; }
    catch (e) { feats = null; }
  } else stats.tileMisses++;
  cache.set(key, feats);
  if (cache.size > MAX_TILES) cache.delete(cache.keys().next().value);
  return feats;
}

/** 点が ring の内側か（ray casting）。境界上はどちらでもよい。 */
function inRing(px, pz, ring) {
  stats.ringTests++;
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) c = !c;
  }
  return c;
}

/**
 * §3 点が feature の内側か。Polygon / MultiPolygon / 穴（hole）に対応する。
 *   穴の中は「内側ではない」。
 */
export function pointInFeature(px, pz, f) {
  const b = f.bbox;
  if (b && (px < b.minX || px > b.maxX || pz < b.minZ || pz > b.maxZ)) return false;
  const polys = (f.geometryType === 'MultiPolygon') ? f.coordinates : [f.coordinates];
  for (const poly of polys) {
    if (!poly || !poly.length) continue;
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    if (!inRing(px, pz, outer)) continue;
    // 穴の中なら内側扱いしない
    let inHole = false;
    for (let k = 1; k < poly.length; k++) {
      const hole = poly[k];
      if (hole && hole.length >= 3 && inRing(px, pz, hole)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/** ring の面積（m2）。footprint の大小比較に使う。 */
export function featureAreaM2(f) {
  const polys = (f.geometryType === 'MultiPolygon') ? f.coordinates : [f.coordinates];
  let A = 0;
  for (const poly of polys) {
    const r = poly && poly[0];
    if (!r || r.length < 3) continue;
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    A += Math.abs(a) / 2;
    for (let k = 1; k < poly.length; k++) {
      const h = poly[k];
      if (!h || h.length < 3) continue;
      let ah = 0;
      for (let i = 0; i < h.length; i++) {
        const p = h[i], q = h[(i + 1) % h.length];
        ah += p[0] * q[1] - q[0] * p[1];
      }
      A -= Math.abs(ah) / 2;
    }
  }
  return A;
}

/**
 * §3 その点を含む建物を全部返す（0 件 / 1 件 / 複数）。
 *   大きな建物は隣のタイルに割り当てられていることがあるので 3x3 を見る。
 */
export function buildingsAt(x, z) {
  stats.pointTests++;
  const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  const hits = [];
  const seen = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const feats = loadTile(tx + dx, tz + dz);
      if (!feats) continue;
      for (const f of feats) {
        if (seen.has(f.canonicalId)) continue;     // タイル境界で重複しうる
        if (!pointInFeature(x, z, f)) continue;
        seen.add(f.canonicalId);
        hits.push(f);
      }
    }
  }
  return hits;
}

export const lookupStats = () => ({ ...stats, cachedTiles: cache.size });
export const TILE_SIZE = TILE;
