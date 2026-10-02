#!/usr/bin/env node
// tools/audit/gsi-photo-layer-catalog.js
// [Mission 35B §1/§2] 地理院地図が実際に配信している **全レイヤ定義** を取得し、
//   航空写真・オルソ系だけを抜き出して、梅田を覆うものと最大 zoom（= 実質の GSD）を出す。
//   「カタログにこう書いてあるはず」ではなく配信されている定義そのものを見る。
//   出力: data/reports/gsi-photo-layer-catalog.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { mppAt } from '../lib/gsi-tile-probe.js';
import { UMEDA_LL, UMEDA_BBOX, classifyGsd } from './umeda-aerial-source-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'gsi-photo-layer-catalog.json');
export const INDEX_URL = 'https://maps.gsi.go.jp/layers_txt/layers.txt';
export const BASE_URL = 'https://maps.gsi.go.jp/layers_txt/';
const UA = { 'User-Agent': 'livecity-data-pipeline/0.2.0 (Mission35B aerial evidence audit)' };

/** 写真・オルソ系と判断する手がかり。名前と id の両方を見る。 */
export const PHOTO_RE = /写真|オルソ|ortho|photo|空中|衛星|画像/i;
/** 災害時の臨時撮影など、梅田の屋根調査に使えないものを外す手がかり。 */
export const DISASTER_RE = /地震|豪雨|台風|噴火|津波|火山|災害|被災|洪水/;

/** レイヤ定義ツリーを平らにする。 */
export function flattenLayers(node, trail = [], out = []) {
  if (node && !Array.isArray(node) && Array.isArray(node.layers)) return flattenLayers(node.layers, trail, out);
  const arr = Array.isArray(node) ? node : [node];
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue;
    const name = n.title || n.name || null;
    const path2 = name ? trail.concat(name) : trail;
    if (n.url && !n.children && !n.src) {
      // 別ファイルへの参照
      out.push({ kind: 'ref', url: n.url, trail: path2 });
    }
    if (n.id || n.url) {
      out.push({ kind: 'layer', id: n.id || null, title: name, trail: path2,
        url: n.url || null, minZoom: n.minZoom ?? null, maxZoom: n.maxZoom ?? null,
        maxNativeZoom: n.maxNativeZoom ?? null, legendUrl: n.legendUrl ?? null,
        html: n.html ?? null, cocotile: n.cocotile ?? null });
    }
    if (n.children) flattenLayers(n.children, path2, out);
    if (n.entries) flattenLayers(n.entries, path2, out);
  }
  return out;
}

/** タイル URL テンプレートが梅田（日本の標準 XYZ）で使える形か。 */
export function isXyzTemplate(url) {
  return typeof url === 'string' && /\{z\}/.test(url) && /\{x\}/.test(url) && /\{y\}/.test(url);
}

/** そのレイヤの実質 GSD。maxNativeZoom があればそれを使う（無ければ maxZoom）。 */
export function layerGsd(layer, lat = UMEDA_LL.lat) {
  const z = layer.maxNativeZoom ?? layer.maxZoom;
  if (z == null) return null;
  return +mppAt(lat, z).toFixed(4);
}

export async function run() {
  const t0 = Date.now();
  const idx = await (await fetch(INDEX_URL, { headers: UA })).json();
  const files = idx.map((e) => e.url.replace(/^\.\//, ''));
  const all = [];
  const fileStats = [];
  for (const f of files) {
    const url = BASE_URL + f;
    try {
      const res = await fetch(url, { headers: UA });
      const txt = await res.text();
      const json = JSON.parse(txt);
      const flat = flattenLayers(json);
      fileStats.push({ file: f, status: res.status, bytes: txt.length, layers: flat.length });
      for (const l of flat) all.push({ ...l, sourceFile: f });
    } catch (e) {
      fileStats.push({ file: f, status: 0, error: String(e && e.message || e).slice(0, 120) });
    }
  }
  // 写真・オルソ系だけ
  const photo = all.filter((l) => l.kind === 'layer' && isXyzTemplate(l.url)
    && (PHOTO_RE.test(l.title || '') || PHOTO_RE.test((l.trail || []).join('/')) || /photo|ort|gazo|seamless/i.test(l.id || '')));
  const rows = photo.map((l) => {
    const gsd = layerGsd(l);
    return { id: l.id, title: l.title, trail: (l.trail || []).join(' / '), url: l.url,
      minZoom: l.minZoom, maxZoom: l.maxZoom, maxNativeZoom: l.maxNativeZoom,
      gsdAtUmedaM: gsd, gsdClass: classifyGsd(gsd),
      looksDisaster: DISASTER_RE.test((l.title || '') + ' ' + (l.trail || []).join(' ')),
      sourceFile: l.sourceFile };
  });
  // 重複（同じ id）をまとめる
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id + '|' + r.url)) byId.set(r.id + '|' + r.url, r);
  const uniq = [...byId.values()].sort((a, b) => (a.gsdAtUmedaM ?? 99) - (b.gsdAtUmedaM ?? 99));

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35B',
    indexUrl: INDEX_URL, files: fileStats,
    totalLayerEntries: all.length, photoLayerEntries: rows.length, uniquePhotoLayers: uniq.length,
    area: { id: 'umeda', ...UMEDA_LL, bbox: UMEDA_BBOX },
    note: 'gsdAtUmedaM は maxNativeZoom（無ければ maxZoom）から出した名目値。実際に配信されているかは umeda-aerial-source-probe.js で確認する。',
    layers: uniq, elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[gsi-catalog] レイヤ定義', o.totalLayerEntries, '写真系', o.uniquePhotoLayers);
    const fine = o.layers.filter((l) => l.gsdAtUmedaM != null && l.gsdAtUmedaM <= 0.30 && !l.looksDisaster);
    console.log('[gsi-catalog] 0.30m/px 以下（災害臨時を除く）', fine.length);
    for (const l of fine.slice(0, 30)) console.log('   ', l.id, '|', l.title, '| maxZ', l.maxNativeZoom ?? l.maxZoom, '|', l.gsdAtUmedaM + 'm', l.gsdClass);
    console.log('[gsi-catalog] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
