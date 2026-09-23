#!/usr/bin/env node
// tools/audit/umeda-aerial-source-probe.js
// [Mission 35B §1/§2/§3/§4] 梅田で実際に取得できる航空画像 source を、
//   カタログの記載ではなく **実際に叩いて** 確かめる。
//   §2 のとおり Web 表示 zoom で判断せず、配信されている最大 native zoom を突き止めて
//   そこから地上画素寸法（GSD）を出す。
//   出力: data/reports/umeda-aerial-source-probe.json
//   ※ ネットワークが要る。使えない環境では NETWORK_UNAVAILABLE を記録して終わる。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { lonLatToTile, mppAt, tilesCovering, fetchTile, highFrequencyEnergy } from '../lib/gsi-tile-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'umeda-aerial-source-probe.json');
export const CACHE = P('data', 'raw', 'osaka-city', 'aerial-probe');

// 梅田 PoC 範囲（35A と同じ x=-2668 / z=-10942 / r=700m を緯度経度へ戻したもの）
export const UMEDA_LL = { lat: 34.702501, lon: 135.495867, radiusM: 700 };
export const UMEDA_BBOX = { south: 34.696213, west: 135.488219, north: 34.708789, east: 135.503516 };

/**
 * 調べる地理院タイル。maxNative は「カタログ上の値」で、実測で上書きする。
 * 出典の確認は §2 の要求どおり実際の配信で行う。
 */
export const GSI_LAYERS = [
  { id: 'seamlessphoto', name: 'シームレス空中写真', ext: 'jpg', catalogMaxZoom: 18,
    note: '複数時期の空中写真を継ぎ合わせたもの。撮影年は場所ごとに異なる' },
  { id: 'ort', name: '電子国土基本図（オルソ画像）', ext: 'jpg', catalogMaxZoom: 18,
    note: '2007 年以降撮影。正射変換済み' },
  { id: 'ort_old10', name: 'オルソ画像（2004〜2007 撮影）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'ort_USA10', name: '米軍撮影写真（1945〜1950）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'gazo1', name: '空中写真（1961〜1964）', ext: 'jpg', catalogMaxZoom: 17 },
  { id: 'gazo2', name: '空中写真（1974〜1978）', ext: 'jpg', catalogMaxZoom: 17 },
  { id: 'gazo3', name: '空中写真（1979〜1983）', ext: 'jpg', catalogMaxZoom: 17 },
  { id: 'gazo4', name: '空中写真（1984〜1986）', ext: 'jpg', catalogMaxZoom: 17 },
  { id: 'airphoto', name: '簡易空中写真（2004〜）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'nendophoto2023', name: '空中写真（2023 年度）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'nendophoto2022', name: '空中写真（2022 年度）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'nendophoto2021', name: '空中写真（2021 年度）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'nendophoto2020', name: '空中写真（2020 年度）', ext: 'jpg', catalogMaxZoom: 18 },
  { id: 'nendophoto2019', name: '空中写真（2019 年度）', ext: 'jpg', catalogMaxZoom: 18 },
];
export const TILE_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';
export const PROBE_ZOOMS = [16, 17, 18, 19, 20];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const POLITE_DELAY_MS = 120;   // 相手のサーバへ負荷をかけない

/** JPEG のヘッダから画素サイズを読む（依存を足さないための最小実装）。 */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0/1/2/3, SOF5..7, SOF9..11, SOF13..15
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
/** PNG のヘッダから画素サイズを読む。 */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
export function imageSize(buf) { return jpegSize(buf) || pngSize(buf); }

/**
 * §2 名目 zoom ではなく実質の解像度を見る。
 * 上位 zoom を拡大しただけのタイルは高周波成分がほとんど増えない。
 * JPEG のサイズ（bytes）と、デコードせずに測れる代理指標としての
 * 「圧縮後バイト数 / 画素数」を使う（拡大画像は平滑なのでよく縮む）。
 */
export function bytesPerPixel(bytes, size) {
  if (!size || !size.width || !size.height) return null;
  return +(bytes / (size.width * size.height)).toFixed(4);
}

export async function probeLayer(layer, { zooms = PROBE_ZOOMS, cacheDir = CACHE } = {}) {
  const rec = { id: layer.id, name: layer.name, note: layer.note || null,
    catalogMaxZoom: layer.catalogMaxZoom, url: `${TILE_BASE}/${layer.id}/{z}/{x}/{y}.${layer.ext}`,
    zooms: [], maxNativeZoom: null, nominalGsdM: null, effective: null, available: false };
  for (const z of zooms) {
    const t = lonLatToTile(UMEDA_LL.lon, UMEDA_LL.lat, z);
    const url = `${TILE_BASE}/${layer.id}/${z}/${t.x}/${t.y}.${layer.ext}`;
    const r = await fetchTile(url);
    await sleep(POLITE_DELAY_MS);
    const size = r.ok ? imageSize(r.buf) : null;
    const row = { z, x: t.x, y: t.y, status: r.status, ok: r.ok, bytes: r.bytes,
      imageSize: size, bytesPerPixel: r.ok ? bytesPerPixel(r.bytes, size) : null,
      mppAtCenter: +mppAt(UMEDA_LL.lat, z).toFixed(4) };
    if (r.ok && r.buf && cacheDir) {
      fs.mkdirSync(cacheDir, { recursive: true });
      const f = path.join(cacheDir, `${layer.id}_${z}_${t.x}_${t.y}.${layer.ext}`);
      fs.writeFileSync(f, r.buf);
      row.file = path.relative(resolveProjectPath('.'), f).replace(/\\/g, '/');
    }
    rec.zooms.push(row);
    if (r.ok) { rec.available = true; rec.maxNativeZoom = z; }
  }
  if (rec.maxNativeZoom != null) {
    // 256px タイル前提。実際のタイル画素数が違えば補正する。
    const top = rec.zooms.find((q) => q.z === rec.maxNativeZoom);
    const px = (top.imageSize && top.imageSize.width) || 256;
    rec.nominalGsdM = +(mppAt(UMEDA_LL.lat, rec.maxNativeZoom) * (256 / px)).toFixed(4);
    rec.tilePixels = px;
  }
  return rec;
}

/** §3 の分類。 */
export const GSD_CLASS = [
  { cls: 'A', maxM: 0.20, label: '≤ 0.20 m/px' },
  { cls: 'B', maxM: 0.30, label: '0.20–0.30 m/px' },
  { cls: 'C', maxM: 0.50, label: '0.30–0.50 m/px' },
  { cls: 'D', maxM: Infinity, label: '> 0.50 m/px' },
];
export function classifyGsd(m) {
  if (m == null) return null;
  for (const c of GSD_CLASS) if (m <= c.maxM) return c.cls;
  return 'D';
}

export async function run({ zooms = PROBE_ZOOMS } = {}) {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35B',
    area: { id: 'umeda', name: '梅田', ...UMEDA_LL, bbox: UMEDA_BBOX },
    tileBase: TILE_BASE, probeZooms: zooms, network: 'unknown', layers: [], gsdClasses: GSD_CLASS };
  for (const L of GSI_LAYERS) {
    const rec = await probeLayer(L, { zooms });
    rec.gsdClass = classifyGsd(rec.nominalGsdM);
    out.layers.push(rec);
    console.log('[aerial-probe]', L.id.padEnd(16),
      rec.available ? `maxZ=${rec.maxNativeZoom} GSD=${rec.nominalGsdM}m class=${rec.gsdClass}` : '取得できず',
      rec.zooms.map((q) => `${q.z}:${q.status}`).join(' '));
  }
  out.network = out.layers.some((l) => l.available) ? 'available' : 'NETWORK_UNAVAILABLE';
  out.elapsedMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    const ok = o.layers.filter((l) => l.available);
    console.log('[aerial-probe] 取得できた層', ok.length, '/', o.layers.length);
    const best = ok.filter((l) => l.nominalGsdM != null).sort((a, b) => a.nominalGsdM - b.nominalGsdM)[0];
    if (best) console.log('[aerial-probe] 最も細かいもの', best.id, best.nominalGsdM + 'm/px', 'class ' + best.gsdClass);
    console.log('[aerial-probe] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
