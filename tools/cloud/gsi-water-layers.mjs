// Mission 211: 国土地理院 ベクトルタイル optimal_bvmap-v1 の WA(水域面ポリゴン)を、区レイヤー
//   ext-3dtiles/<ward>/layers/waterways.json (kind:'area' の面。h=穴) に変換する。
//   - 公式 PLATEAU 2025 大阪市パッケージ(CityGML/3D Tiles/MVT/関連データ)には wtr(水域)が存在しない(source-lock の gmlByKind と ZIP 中央ディレクトリで確認)ため、
//     「河川中心線を面と偽らない」実水面ポリゴンとして国土地理院(基盤地図情報)の WA を使う。出典: 国土地理院(基盤地図情報を含む)。OSM(ODbL)は使わない。
//   - 座標は建物・道路と同一 projection(tools/lib/mission46d-mvt.cjs の CONST = osaka-city.json と同値 / znorth-neg-v1)。補正オフセット無し。
//   - 区への割当: 外周頂点が 1 つでも区ポリゴン内にある面(長い川が複数区に跨るため。隣接区で重複しうる=同色同高さ)。
//   - 失敗しても建物ビルドは止めない(呼び出し側で捕捉)。0 件の区はファイルを作らず「none」と報告(捏造しない)。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../lib/mission46d-mvt.cjs');

export const SCHEMA = 'livecity.mission211.waterways-gsi-wa/1';
export const ZOOM = 16;
const r1 = (v) => Math.round(v * 10) / 10;
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; };
const pip = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (((r[i][1] > z) !== (r[j][1] > z)) && (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c; return c; };

/** ローカル m(x東, z南)のbbox → z16 タイル範囲(MVT の lat/lon 変換と同じ式の逆変換)。 */
export function tilesForBBox(b, z = ZOOM) {
  const C = M.CONST, n = 2 ** z;
  const ll = (x, zz) => ({ lon: C.clon + x / (Math.cos(C.clat * Math.PI / 180) * C.mpd), lat: C.clat - zz / C.mpd });
  const tile = (lon, lat) => { const s = Math.sin(lat * Math.PI / 180); return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2 * n) }; };
  const a = ll(b.minX, b.minZ), c = ll(b.maxX, b.maxZ);
  const t0 = tile(Math.min(a.lon, c.lon), Math.max(a.lat, c.lat)), t1 = tile(Math.max(a.lon, c.lon), Math.min(a.lat, c.lat));
  const out = []; for (let x = t0.x; x <= t1.x; x++) for (let y = t0.y; y <= t1.y; y++) out.push({ z, x, y });
  return out;
}

/** MVT 1 タイル(Buffer) → WA 面 [{outer, holes}](ローカル m)。外周と穴は巻き方向の違いで判別(mission50 と同じ規則)。 */
export function waPolygonsFromTile(buf, t) {
  const L = M.decodeMvt(buf);
  const out = [];
  if (!L.WA) return out;
  for (const ft of M.layerToLocal(L.WA, t.z, t.x, t.y)) {
    let cur = null, sign = 0;
    for (const ring of ft.rings) {
      if (ring.length < 3) continue;
      const a = ringArea(ring);
      if (!sign) sign = Math.sign(a);
      const rr = ring.map((p) => [r1(p[0]), r1(p[1])]);
      if (Math.sign(a) === sign) { cur = { outer: rr, holes: [] }; out.push(cur); } else if (cur) cur.holes.push(rr);
    }
  }
  return out;
}

const UA = 'livecity-preview-build (GSI vector tile, read-only; low rate)';
function getTile(t, timeoutMs = 20000) {
  return new Promise((res, rej) => {
    const rq = https.get({ host: 'cyberjapandata.gsi.go.jp', path: `/xyz/optimal_bvmap-v1/${t.z}/${t.x}/${t.y}.pbf`, timeout: timeoutMs, headers: { 'User-Agent': UA } }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, buf: Buffer.concat(c) })); r.on('error', rej);
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', rej);
  });
}

/** タイル取得+WA 抽出のキャッシュ(隣接区が共有するタイルを再取得しない)。fetchTile は差し替え可能(テスト用)。 */
export function makeTileSource({ fetchTile = getTile, concurrency = 4, retries = 2, maxTiles = 1500, delayMs = 60 } = {}) {
  const cache = new Map(); const st = { requested: 0, fetched: 0, empty: 0, failed: 0, notFound: 0 };
  async function one(t) {
    const k = t.z + '/' + t.x + '/' + t.y;
    if (cache.has(k)) return cache.get(k);
    if (st.requested >= maxTiles) throw new Error('GSI tile count exceeds cap ' + maxTiles);
    st.requested++;
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetchTile(t);
        if (r.status === 404) { st.notFound++; cache.set(k, []); return []; }   // 海上などタイル無し
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const polys = waPolygonsFromTile(r.buf, t); st.fetched++; if (!polys.length) st.empty++;
        cache.set(k, polys); return polys;
      } catch (e) { last = e; await new Promise((s) => setTimeout(s, 300 * (i + 1))); }
    }
    st.failed++; throw last;
  }
  async function many(tiles) {
    const res = new Array(tiles.length); let i = 0; const errs = [];
    await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, async () => {
      while (i < tiles.length) {
        const my = i++;
        try { res[my] = await one(tiles[my]); } catch (e) { errs.push({ tile: tiles[my], error: String(e.message).slice(0, 120) }); res[my] = null; }
        if (delayMs) await new Promise((s) => setTimeout(s, delayMs));
      }
    }));
    return { res, errs };
  }
  return { many, stats: st };
}

/**
 * 区ポリゴン(wardPolygons: [{outer,holes}])内に外周頂点を持つ WA 面を outDir/waterways.json に書く。
 * タイル取得失敗が 1 つでもあれば欠けた水面を成功扱いにしない(失敗として throw)。0 件なら null(ファイル無し)。
 */
export async function buildWaterLayer({ source, ward, wardCode, wardPolygons, outDir, maxMB = 12 }) {
  let b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of wardPolygons) for (const q of p.outer) b = { minX: Math.min(b.minX, q[0]), maxX: Math.max(b.maxX, q[0]), minZ: Math.min(b.minZ, q[1]), maxZ: Math.max(b.maxZ, q[1]) };
  const tiles = tilesForBBox(b);
  const { res, errs } = await source.many(tiles);
  if (errs.length) throw new Error(`${ward}: GSI タイル ${errs.length}/${tiles.length} 件の取得に失敗(${errs[0].error})。欠けた水面を成功扱いにしない`);
  const inWard = (x, z) => wardPolygons.some((p) => pip(p.outer, x, z) && !(p.holes || []).some((h) => pip(h, x, z)));
  const feats = []; let wb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }, areaM2 = 0;
  res.forEach((polys, ti) => polys.forEach((w, i) => {
    if (w.outer.length < 3 || !w.outer.some((q) => inWard(q[0], q[1]))) return;
    const a = Math.abs(ringArea(w.outer)) - w.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
    areaM2 += a;
    const f = { id: `gsi-wa-${tiles[ti].z}-${tiles[ti].x}-${tiles[ti].y}-${i}`, kind: 'area', p: w.outer };
    if (w.holes.length) f.h = w.holes;
    feats.push(f);
    for (const q of w.outer) wb = { minX: Math.min(wb.minX, q[0]), maxX: Math.max(wb.maxX, q[0]), minZ: Math.min(wb.minZ, q[1]), maxZ: Math.max(wb.maxZ, q[1]) };
  }));
  const rep = { status: feats.length ? 'ok' : 'none', geometry: 'water-area-polygon (GSI WA。河川中心線ではない)', tiles: tiles.length, features: feats.length, areaM2: Math.round(areaM2) };
  if (!feats.length) return rep;
  const body = JSON.stringify({ layer: 'waterways', mission: '211', schema: SCHEMA, ward, wardCode, coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'local-meters',
    geometry: 'water-area-polygon (国土地理院 optimal_bvmap-v1 WA。h=穴)', source: '国土地理院(基盤地図情報を含む) ベクトルタイル optimal_bvmap-v1 z16 WA', clipped: 'any-vertex-in-ward', bboxLocal: wb, count: feats.length, features: feats });
  const mb = body.length / 1048576;
  if (mb > maxMB) throw new Error(`${ward}: waterways.json ${mb.toFixed(1)}MB > ${maxMB}MB`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'waterways.json'), body);
  rep.sizeMB = +mb.toFixed(2);
  return rep;
}

/** layers-report.json の waterways 欄を実測値で置換(道路の報告は保持)。 */
export function mergeWaterReport(outDir, rep, extra = {}) {
  const f = path.join(outDir, 'layers-report.json');
  const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { layers: {} };
  j.layers = j.layers || {};
  j.layers.waterways = { ...rep, ...extra, source: { name: '国土地理院 optimal_bvmap-v1 WA(水域面)', publisher: '国土地理院(基盤地図情報を含む)', note: '公式 PLATEAU 2025 大阪市に wtr は無い。出典: 国土地理院' } };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j));
}
