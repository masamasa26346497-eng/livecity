#!/usr/bin/env node
// tools/audit/umeda-aerial-availability.js
// [Mission 35B §1/§2/§3/§4] 地理院のレイヤ定義（gsi-photo-layer-catalog.js の出力）を正本にして、
//   **梅田で実際にタイルが返るか** を全写真レイヤについて確かめる。
//   併せて `*_spec` の GeoJSON から撮影期間・撮影縮尺などの属性を取り出す（§1 撮影年月日 / §4 capture date）。
//   出力: data/reports/umeda-aerial-availability.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { lonLatToTile, mppAt, fetchTile } from '../lib/gsi-tile-probe.js';
import { UMEDA_LL, UMEDA_BBOX, classifyGsd, imageSize, bytesPerPixel } from './umeda-aerial-source-probe.js';
import { OUT as CATALOG_OUT } from './gsi-photo-layer-catalog.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'umeda-aerial-availability.json');
export const CACHE = P('data', 'raw', 'osaka-city', 'aerial-probe');
const UA = { 'User-Agent': 'livecity-data-pipeline/0.2.0 (Mission35B aerial evidence audit)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const POLITE_DELAY_MS = 100;
/** 画像レイヤを試す zoom。定義上の maxZoom より 2 段上まで見て、上限を実測する。 */
export const EXTRA_ZOOMS = 2;

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** URL テンプレートへ z/x/y を入れる。 */
export function fillTemplate(tpl, z, x, y) {
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** 撮影期間 GeoJSON の属性から、日付らしきものと縮尺らしきものを拾う。 */
export function summarizeSpecFeature(props) {
  if (!props) return null;
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === '') continue;
    const key = String(k);
    if (/date|期間|年月|撮影|year|時期/i.test(key)) out[key] = v;
    else if (/scale|縮尺/i.test(key)) out[key] = v;
    else if (/gsd|解像|画素|分解能/i.test(key)) out[key] = v;
    else if (/color|カラー|種別|type|kind/i.test(key)) out[key] = v;
    else if (/course|コース|course_no|撮影者|機関|provider/i.test(key)) out[key] = v;
    else out['_' + key] = v;
  }
  return out;
}

/** 梅田の点を含む feature だけを返す（点包含。線・点は距離で拾う）。 */
export function featuresAtPoint(geojson, lon, lat) {
  const hits = [];
  for (const f of ((geojson && geojson.features) || [])) {
    const g = f.geometry;
    if (!g) continue;
    const rings = g.type === 'Polygon' ? [g.coordinates]
      : g.type === 'MultiPolygon' ? g.coordinates : null;
    if (!rings) { hits.push(f); continue; }   // 点・線はそのまま候補に
    let inside = false;
    for (const poly of rings) {
      const outer = poly[0];
      let ins = false;
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const xi = outer[i][0], yi = outer[i][1], xj = outer[j][0], yj = outer[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) ins = !ins;
      }
      if (ins) { inside = true; break; }
    }
    if (inside) hits.push(f);
  }
  return hits;
}

export async function probeImageLayer(layer) {
  const defMax = layer.maxNativeZoom ?? layer.maxZoom ?? 18;
  const defMin = Math.max(10, layer.minZoom ?? 10);
  const zooms = [];
  for (let z = Math.max(defMin, defMax - 2); z <= defMax + EXTRA_ZOOMS; z++) zooms.push(z);
  const rec = { id: layer.id, title: layer.title, url: layer.url, trail: layer.trail,
    defMinZoom: layer.minZoom ?? null, defMaxZoom: layer.maxZoom ?? null,
    defMaxNativeZoom: layer.maxNativeZoom ?? null,
    zooms: [], available: false, maxServedZoom: null, gsdM: null, gsdClass: null };
  for (const z of zooms) {
    const t = lonLatToTile(UMEDA_LL.lon, UMEDA_LL.lat, z);
    const r = await fetchTile(fillTemplate(layer.url, z, t.x, t.y));
    await sleep(POLITE_DELAY_MS);
    const size = r.ok ? imageSize(r.buf) : null;
    rec.zooms.push({ z, status: r.status, ok: r.ok, bytes: r.bytes, imageSize: size,
      bytesPerPixel: r.ok ? bytesPerPixel(r.bytes, size) : null });
    if (r.ok && r.bytes > 0) {
      rec.available = true; rec.maxServedZoom = z;
      if (CACHE) {
        fs.mkdirSync(CACHE, { recursive: true });
        const ext = (layer.url.match(/\.(\w+)$/) || [, 'bin'])[1];
        fs.writeFileSync(path.join(CACHE, `${layer.id}_${z}_${t.x}_${t.y}.${ext}`), r.buf);
      }
    }
  }
  if (rec.maxServedZoom != null) {
    const top = rec.zooms.find((q) => q.z === rec.maxServedZoom);
    const px = (top.imageSize && top.imageSize.width) || 256;
    rec.tilePixels = px;
    rec.gsdM = +(mppAt(UMEDA_LL.lat, rec.maxServedZoom) * (256 / px)).toFixed(4);
    rec.gsdClass = classifyGsd(rec.gsdM);
  }
  return rec;
}

export async function probeSpecLayer(layer) {
  const z = Math.min(layer.maxNativeZoom ?? layer.maxZoom ?? 11, 12);
  const t = lonLatToTile(UMEDA_LL.lon, UMEDA_LL.lat, z);
  const url = fillTemplate(layer.url, z, t.x, t.y);
  try {
    const res = await fetch(url, { headers: UA });
    await sleep(POLITE_DELAY_MS);
    if (!res.ok) return { id: layer.id, url, status: res.status, features: 0, atUmeda: [] };
    const gj = await res.json();
    const hits = featuresAtPoint(gj, UMEDA_LL.lon, UMEDA_LL.lat);
    return { id: layer.id, title: layer.title, url, status: res.status,
      features: (gj.features || []).length,
      atUmeda: hits.map((f) => summarizeSpecFeature(f.properties)).slice(0, 10) };
  } catch (e) {
    return { id: layer.id, url, status: 0, error: String(e && e.message || e).slice(0, 120) };
  }
}

export async function run() {
  const t0 = Date.now();
  const cat = rj(CATALOG_OUT);
  if (!cat) throw new Error('先に tools/audit/gsi-photo-layer-catalog.js を実行する');
  const imageLayers = cat.layers.filter((l) => l.url && !/\.geojson$/.test(l.url) && !l.looksDisaster
    && !/southpole|南極/.test((l.title || '') + (l.trail || '')));
  const specLayers = cat.layers.filter((l) => l.url && /\.geojson$/.test(l.url) && !/southpole/.test(l.id || ''));

  const images = [];
  for (const L of imageLayers) {
    const r = await probeImageLayer(L);
    images.push(r);
    console.log('[avail]', String(L.id).padEnd(24),
      r.available ? `z<=${r.maxServedZoom} GSD=${r.gsdM}m ${r.gsdClass}` : '梅田では配信なし');
  }
  const specs = [];
  for (const L of specLayers) {
    const r = await probeSpecLayer(L);
    if (r.atUmeda && r.atUmeda.length) {
      specs.push(r);
      console.log('[spec]', String(L.id).padEnd(24), JSON.stringify(r.atUmeda[0]).slice(0, 180));
    }
  }

  const served = images.filter((i) => i.available);
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35B',
    area: { id: 'umeda', name: '梅田', ...UMEDA_LL, bbox: UMEDA_BBOX },
    imageLayersProbed: images.length, imageLayersServed: served.length,
    bestGsdM: served.length ? Math.min(...served.map((s) => s.gsdM)) : null,
    byClass: served.reduce((a, s) => { a[s.gsdClass] = (a[s.gsdClass] || 0) + 1; return a; }, {}),
    images, specs, elapsedMs: Date.now() - t0 };
  out.bestGsdClass = classifyGsd(out.bestGsdM);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[avail] 梅田で配信されている写真レイヤ', o.imageLayersServed, '/', o.imageLayersProbed);
    console.log('[avail] 最も細かい GSD', o.bestGsdM + 'm/px', 'class', o.bestGsdClass, JSON.stringify(o.byClass));
    console.log('[avail] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
