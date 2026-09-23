#!/usr/bin/env node
// tools/audit/umeda-ortho-source-catalog.js
// [Mission 35B §1/§2/§3/§4/§5] 梅田を覆うオルソ画像成果を、**配信元のヘッダを実際に読んで** 分類する。
//   §2 の要求どおり Web タイルの見かけ zoom では判断しない。
//   対象:
//     - 大阪市航空写真（G空間情報センター / H20〜R07 の各年度、区別 GeoTIFF）
//     - PLATEAU 大阪市（各年度の ortho ZIP。3 次メッシュ別 GeoTIFF）
//   ZIP は HTTP Range で中央ディレクトリと 1 エントリだけを取り、全体は落とさない。
//   出力: data/reports/umeda-ortho-source-catalog.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readTiffHeader, gsdFromHeader, rangeReader } from '../lib/geotiff-header.js';
import { listRemoteZip, readEntryFull } from '../lib/remote-zip.js';
import { UMEDA_LL, classifyGsd } from './umeda-aerial-source-probe.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'umeda-ortho-source-catalog.json');
export const CACHE = P('data', 'raw', 'osaka-city', 'aerial-probe');
export const CKAN = 'https://www.geospatial.jp/ckan/api/3/action';
export const UA = 'livecity-data-pipeline/0.2.0 (Mission35B aerial evidence audit)';
const H = { 'User-Agent': UA };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 梅田が属する区と 3 次メッシュ。 */
export const UMEDA_WARD_RE = /23_大阪市北区|kita/i;
export function meshCode3(lat, lon) {
  const p = Math.floor(lat * 1.5);
  const u = Math.floor(lon) - 100;
  const q = Math.floor(((lat * 60) % 40) / 5);
  const v = Math.floor(((lon - Math.floor(lon)) * 60) / 7.5);
  const r = Math.floor((((lat * 60) % 40) % 5) * 60 / 30);
  const w = Math.floor(((((lon - Math.floor(lon)) * 60) % 7.5) * 60) / 45);
  return `${p}${u}${q}${v}${r}${w}`;
}
export const UMEDA_MESH3 = meshCode3(UMEDA_LL.lat, UMEDA_LL.lon);

/** 大阪市航空写真の年度データセット（CKAN の名前）。 */
export const OSAKA_PHOTO_DATASETS = ['r07', 'r06-photo', 'r05-photo', 'r04-photo', 'r03-photo',
  'r02-photo', 'r01-photo', 'h30-photo', 'h29-photo', 'h28-photo', 'h27-photo', 'h26-photo',
  'h25-photo', 'h24-photo', 'h23-photo', 'h22-photo', 'h21-photo', 'h20-photo'];
/** PLATEAU 大阪市の年度データセット。 */
export const PLATEAU_DATASETS = ['plateau-27100-osaka-shi-2025', 'plateau-27100-osaka-shi-2024',
  'plateau-27100-osaka-shi-2022', 'plateau-27100-osaka-shi-2020'];

async function ckanShow(id) {
  const r = await fetch(`${CKAN}/package_show?id=${encodeURIComponent(id)}`, { headers: H });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.success ? j.result : null;
}

/** 撮影年月を notes から拾う（§1 撮影年月日 / §4 capture date）。 */
export function captureFromNotes(notes) {
  if (!notes) return null;
  const m = String(notes).match(/(?:令和|平成)?\s*([0-9０-９]{1,2})?\s*年?\s*[（(]?\s*(\d{4})\s*年\s*[)）]?\s*(\d{1,2})\s*月/);
  if (m) return { text: m[0].trim(), year: +m[2], month: +m[3] };
  const m2 = String(notes).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (m2) return { text: m2[0], year: +m2[1], month: +m2[2] };
  return null;
}

/** 大阪市航空写真 1 年度分。北区（梅田）の GeoTIFF ヘッダだけ読む。 */
export async function probeOsakaPhotoYear(id) {
  const p = await ckanShow(id);
  if (!p) return { dataset: id, ok: false, reason: 'CKAN に無い' };
  const res = (p.resources || []).find((r) => UMEDA_WARD_RE.test(r.name || '') || UMEDA_WARD_RE.test(r.url || ''));
  const rec = { dataset: id, title: p.title, provider: (p.organization && p.organization.title) || null,
    license: p.license_title || p.license_id || null, licenseUrl: p.license_url || null,
    capture: captureFromNotes(p.notes), notesHead: (p.notes || '').slice(0, 220).replace(/\s+/g, ' '),
    resourceCount: p.num_resources, umedaResource: res ? res.name : null,
    umedaUrl: res ? res.url : null, bytes: res ? res.size : null, ok: false };
  if (!res) { rec.reason = '北区の成果が見つからない'; return rec; }
  try {
    const h = await readTiffHeader(rangeReader(res.url, { userAgent: UA }));
    const g = gsdFromHeader(h, UMEDA_LL.lat);
    rec.ok = true; rec.header = g; rec.gsdM = g.gsdM; rec.gsdClass = classifyGsd(g.gsdM);
  } catch (e) { rec.reason = String(e && e.message || e).slice(0, 160); }
  return rec;
}

/** PLATEAU 1 年度分。ortho ZIP の中から梅田のメッシュ 1 枚だけ取る。 */
export async function probePlateauYear(id, { download = true } = {}) {
  const p = await ckanShow(id);
  if (!p) return { dataset: id, ok: false, reason: 'CKAN に無い' };
  const res = (p.resources || []).find((r) => /ortho/i.test(r.url || '') || /オルソ/.test(r.name || '')
    || /GeoTIFF/i.test(r.name || ''));
  const rec = { dataset: id, title: p.title, provider: (p.organization && p.organization.title) || null,
    license: p.license_title || p.license_id || null,
    capture: captureFromNotes(p.notes), resourceCount: p.num_resources,
    orthoResource: res ? res.name : null, orthoUrl: res ? res.url : null, ok: false };
  if (!res) { rec.reason = 'ortho / GeoTIFF の成果が無い'; return rec; }
  // 7z は部分読みできない（展開に外部ライブラリが要る）。事実として記録して次へ。
  if (/\.7z(\?|$)/i.test(res.url) || /7z/i.test(res.format || '')) {
    rec.archiveFormat = '7z';
    rec.reason = '7z 形式のため HTTP Range での部分確認ができない（全体を取得して展開する必要がある）';
    try {
      const h = await fetch(res.url, { method: 'HEAD', headers: H });
      rec.archiveBytes = Number(h.headers.get('content-length')) || null;
      rec.archiveSizeMB = rec.archiveBytes ? +(rec.archiveBytes / 1048576).toFixed(0) : null;
    } catch { /* noop */ }
    return rec;
  }
  try {
    const zip = await listRemoteZip(res.url, { userAgent: UA });
    rec.archiveFormat = 'zip';
    rec.zipSizeMB = +(zip.size / 1048576).toFixed(0);
    rec.zipEntries = zip.entries.length;
    rec.meshNaming = zip.entries.slice(0, 3).map((e) => e.name);
    const entry = zip.entries.find((e) => e.name.replace(/\.\w+$/, '') === UMEDA_MESH3)
      || zip.entries.find((e) => e.name.startsWith(UMEDA_MESH3.slice(0, 6)));
    if (!entry) { rec.reason = `梅田のメッシュ ${UMEDA_MESH3} が ZIP に無い`; return rec; }
    rec.umedaEntry = entry.name;
    rec.umedaEntryMB = +(entry.uncompressedSize / 1048576).toFixed(1);
    if (!download) { rec.ok = true; return rec; }
    const cached = path.join(CACHE, `${id}_${entry.name}`);
    let buf;
    if (fs.existsSync(cached)) buf = fs.readFileSync(cached);
    else {
      buf = await readEntryFull(zip, entry);
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(cached, buf);
    }
    rec.cachedFile = path.relative(resolveProjectPath('.'), cached).replace(/\\/g, '/');
    const h = await readTiffHeader(async (a, b) => buf.slice(a, b + 1));
    const g = gsdFromHeader(h, UMEDA_LL.lat);
    rec.ok = true; rec.header = g; rec.gsdM = g.gsdM; rec.gsdClass = classifyGsd(g.gsdM);
  } catch (e) { rec.reason = String(e && e.message || e).slice(0, 160); }
  return rec;
}

export async function run({ plateauDownload = true } = {}) {
  const t0 = Date.now();
  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35B',
    area: { id: 'umeda', name: '梅田', ...UMEDA_LL, mesh3: UMEDA_MESH3 },
    gsdClassDefinition: { A: '≤0.20 m/px', B: '0.20–0.30', C: '0.30–0.50', D: '>0.50' },
    osakaCityPhoto: [], plateauOrtho: [] };
  for (const id of OSAKA_PHOTO_DATASETS) {
    const r = await probeOsakaPhotoYear(id);
    out.osakaCityPhoto.push(r);
    console.log('[ortho] 大阪市', String(id).padEnd(10),
      r.ok ? `${r.header.width}x${r.header.height} GSD=${r.gsdM}m ${r.gsdClass} ${r.header.crsName || ''}` : ('× ' + (r.reason || '')),
      r.capture ? '撮影 ' + r.capture.text : '');
    await sleep(150);
  }
  for (const id of PLATEAU_DATASETS) {
    const r = await probePlateauYear(id, { download: plateauDownload });
    out.plateauOrtho.push(r);
    console.log('[ortho] PLATEAU', String(id).replace('plateau-27100-osaka-shi-', '').padEnd(6),
      r.ok ? (r.header ? `${r.header.width}x${r.header.height} GSD=${r.header.gsdXm}x${r.header.gsdYm}m → ${r.gsdM}m ${r.gsdClass}` : 'entry のみ確認')
        : ('× ' + (r.reason || '')));
    await sleep(150);
  }
  const all = [...out.osakaCityPhoto, ...out.plateauOrtho].filter((r) => r.ok && r.gsdM != null);
  out.best = all.length ? all.reduce((a, b) => (a.gsdM <= b.gsdM ? a : b)) : null;
  out.bestGsdM = out.best ? out.best.gsdM : null;
  out.bestGsdClass = classifyGsd(out.bestGsdM);
  out.anyClassAorB = all.some((r) => r.gsdClass === 'A' || r.gsdClass === 'B');
  out.elapsedMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[ortho] 最も細かい成果', o.best ? `${o.best.dataset} ${o.bestGsdM}m/px class ${o.bestGsdClass}` : 'なし');
    console.log('[ortho] class A/B が存在するか', o.anyClassAorB);
    console.log('[ortho] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
