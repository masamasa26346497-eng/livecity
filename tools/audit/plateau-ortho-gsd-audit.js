#!/usr/bin/env node
// tools/audit/plateau-ortho-gsd-audit.js
// [Mission 35C §3/§4/§5/§6/§8] ローカルへ展開した PLATEAU オルソ（2020 / 2022）の
//   GeoTIFF ヘッダを全枚読んで、実際の地上画素寸法（GSD）を確定する。
//
//   §4 地理座標系のときは度を m へ直す（ここを誤ると桁を間違える。35B で実際に間違えた）。
//   §5 梅田 PoC 範囲を覆う画像だけを抜き出して min/median/max を出す。
//   §11(35B) / §9(35C) geometry は作らない。測るだけ。
//
//   展開は bsdtar（Windows 同梱 tar.exe / libarchive）で行う。7-Zip の導入は不要。
//   出力: data/reports/plateau-ortho-gsd-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readTiffHeader, gsdFromHeader, parseGeoKeys } from '../lib/geotiff-header.js';
import { UMEDA_LL, UMEDA_BBOX, classifyGsd, GSD_CLASS } from './umeda-aerial-source-probe.js';
import { WORK_DIR, ARCHIVES } from '../download/plateau-ortho-archive.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const OUT = P('data', 'reports', 'plateau-ortho-gsd-audit.json');
/** 展開先も repo の外（OneDrive の同期衝突を避ける）。 */
export const EXTRACT_ROOT = process.env.LIVECITY_ORTHO_EXTRACT || path.join(WORK_DIR, 'extracted');
/**
 * 展開に使う tar。
 * Windows では PATH の先頭に Git 同梱の GNU tar（MSYS）が居ることがあり、そちらは
 * `C:\...` を「ホスト C のパス」と解釈して `Cannot connect to C: resolve failed` で落ちる。
 * OS 同梱の bsdtar（libarchive。7z を読める）を明示して呼ぶ。
 */
export function resolveTar() {
  if (process.env.LIVECITY_TAR) return process.env.LIVECITY_TAR;
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}
export const TAR = resolveTar();

/** §8 の比較に使う、35B で確定済みの値。 */
export const KNOWN_SOURCES = [
  { id: 'plateau-2024', label: 'PLATEAU 大阪市 2024 オルソ', gsdXm: 0.3724, gsdYm: 0.4529, gsdM: 0.4529, source: '35B 実測（GeoTIFF ヘッダ）' },
  { id: 'osaka-city-0.50', label: '大阪市航空写真（公開版・全 18 年度）', gsdXm: 0.50, gsdYm: 0.50, gsdM: 0.50, source: '35B 実測（GeoTIFF ヘッダ）' },
  { id: 'gsi-seamlessphoto', label: '地理院タイル seamlessphoto / ort（z18）', gsdXm: 0.4909, gsdYm: 0.4909, gsdM: 0.4909, source: '35B 実測（配信 zoom の上限）' },
];

/** 7z の中身を一覧する（展開しない）。 */
export function listArchive(archivePath) {
  const out = execFileSync(TAR, ['-tvf', archivePath], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // bsdtar -tvf: "-rw-r--r--  0 0      0   18874368 Jan  1  2020 52350349.tif"
    const m = line.match(/\s(\d+)\s+\S+\s+\d+\s+[\d:]+\s+(\d{4}|\d{2}:\d{2})\s+(.+)$/)
      || line.match(/\s(\d+)\s+(.+?)\s+(\S+)$/);
    const name = line.trim().split(/\s+/).slice(-1)[0];
    const sizeM = line.match(/\s(\d{3,})\s/);
    rows.push({ name, bytes: sizeM ? Number(sizeM[1]) : (m ? Number(m[1]) : null), raw: line });
  }
  return rows.filter((r) => r.name && !r.name.endsWith('/'));
}

/** 指定したエントリだけ展開する。既に展開済みならスキップ。 */
export function extractEntries(archivePath, names, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar はアーカイブ内のパスをそのまま再現する。basename で存在確認すると必ず外れる。
  const need = names.filter((n) => !fs.existsSync(path.join(destDir, n)));
  if (!need.length) return { extracted: 0, skipped: names.length };
  // bsdtar はワイルドカードでも個別名でも受ける。数が多いと引数が長くなるので分割する。
  const CHUNK = 60;
  let done = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const part = need.slice(i, i + CHUNK);
    execFileSync(TAR, ['-xf', archivePath, '-C', destDir, ...part], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    done += part.length;
  }
  return { extracted: done, skipped: names.length - need.length };
}

/** 1 枚の GeoTIFF のヘッダを読んで、必要な項目を揃える（§3/§4）。 */
export async function readOne(file, lat = UMEDA_LL.lat) {
  const buf = fs.readFileSync(file);
  const h = await readTiffHeader(async (a, b) => buf.slice(a, b + 1));
  const g = gsdFromHeader(h, lat);
  const keys = parseGeoKeys(h.tags.GeoKeyDirectory, h.tags.GeoAsciiParams, h.tags.GeoDoubleParams) || {};
  const tp = h.tags.ModelTiepoint;
  let bbox = null;
  if (Array.isArray(tp) && tp.length >= 6 && g.pixelScaleX != null) {
    const x0 = tp[3], y0 = tp[4];
    const w = h.tags.ImageWidth * g.pixelScaleX;
    const ht = h.tags.ImageLength * g.pixelScaleY;
    // ModelTiepoint は左上。Y は下向きに減る。
    bbox = { west: x0, north: y0, east: x0 + w, south: y0 - ht };
  }
  return {
    file: path.basename(file),
    width: g.width, height: g.height,
    crsKind: g.crsKind, crs: g.crs, crsName: g.crsName,
    modelPixelScale: [g.pixelScaleX, g.pixelScaleY],
    modelTiepoint: tp || null,
    gsdXm: g.gsdXm, gsdYm: g.gsdYm, gsdM: g.gsdM, gsdClass: classifyGsd(g.gsdM),
    bbox, groundWidthM: g.groundWidthM, groundHeightM: g.groundHeightM,
    samplesPerPixel: g.samplesPerPixel, bitsPerSample: g.bitsPerSample,
    compression: g.compression, tileWidth: g.tileWidth, tileLength: g.tileLength,
    dateTime: g.dateTime, software: g.software,
    geoKeys: keys,
  };
}

/** §5 その画像が梅田 PoC 範囲と重なるか。地理座標系の bbox のみ判定できる。 */
export function overlapsUmeda(rec, bbox = UMEDA_BBOX) {
  if (!rec.bbox) return null;
  if (rec.crsKind !== 'geographic') return null;   // 投影座標系は別途変換が要る
  const b = rec.bbox;
  return !(b.east < bbox.west || b.west > bbox.east || b.north < bbox.south || b.south > bbox.north);
}

/**
 * 3 次メッシュコードから、その範囲の緯度経度を出す（ファイル名が 8 桁のとき使える）。
 *   1 次: 緯度 40 分（= 1/1.5 度）、経度 1 度
 *   2 次: 1 次を緯度 8 分割（5 分 = 1/12 度）、経度 8 分割（7 分 30 秒 = 1/8 度）
 *   3 次: 2 次を緯度 10 分割（30 秒 = 1/120 度）、経度 10 分割（45 秒 = 1/80 度）
 * **3 次の分割は 8 ではなく 10**。ここを 8 にすると範囲がずれ、梅田の判定枚数が狂う。
 */
export const MESH3_LAT_SPAN = 1 / 120;
export const MESH3_LON_SPAN = 1 / 80;
export function mesh3Bounds(code) {
  const s = String(code);
  if (!/^\d{8}$/.test(s)) return null;
  const p = +s.slice(0, 2), u = +s.slice(2, 4), q = +s.slice(4, 5), v = +s.slice(5, 6), r = +s.slice(6, 7), w = +s.slice(7, 8);
  if (q > 7 || v > 7) return null;
  const south = p / 1.5 + q / 12 + r / 120;
  const west = 100 + u + v / 8 + w / 80;
  return { south, west, north: south + MESH3_LAT_SPAN, east: west + MESH3_LON_SPAN };
}
export function meshOverlapsUmeda(code, bbox = UMEDA_BBOX) {
  const m = mesh3Bounds(code);
  if (!m) return null;
  return !(m.east < bbox.west || m.west > bbox.east || m.north < bbox.south || m.south > bbox.north);
}

export function stats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (t) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * t)))];
  return { n: s.length, min: +s[0].toFixed(4), median: +q(0.5).toFixed(4), max: +s[s.length - 1].toFixed(4),
    distinct: [...new Set(s.map((x) => +x.toFixed(4)))].slice(0, 10) };
}

export async function auditArchive(a, { sampleAll = true } = {}) {
  const archivePath = path.join(WORK_DIR, a.file);
  const rec = { id: a.id, year: a.year, archive: a.file, archivePath, exists: fs.existsSync(archivePath) };
  if (!rec.exists) { rec.reason = 'アーカイブが無い。先に tools/download/plateau-ortho-archive.js を実行する'; return rec; }
  rec.archiveBytes = fs.statSync(archivePath).size;

  const entries = listArchive(archivePath);
  const tifs = entries.filter((e) => /\.tiff?$/i.test(e.name));
  rec.entryCount = entries.length;
  rec.tifCount = tifs.length;
  rec.nonTifKinds = countExtensions(entries.filter((e) => !/\.tiff?$/i.test(e.name)));
  rec.uncompressedSizes = stats(tifs.map((t) => t.bytes).filter((n) => n > 0));
  rec.naming = tifs.slice(0, 3).map((t) => t.name);

  // 1 つのアーカイブに **複数の撮影年度** が入っていることがある。
  // 2022 の配布物には R2（令和2年度）と R3（令和3年度）の 2 組が入っている。
  // images/ の直下のフォルダ名で分けて、年度ごとに測る。
  const bySet = new Map();
  for (const t of tifs) {
    const k = setNameOf(t.name);
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(t);
  }
  rec.setCount = bySet.size;
  rec.meshNamed = tifs.length > 0 && tifs.every((t) => /^\d{8}$/.test(path.basename(t.name).replace(/\.tiff?$/i, '')));

  const base = (n) => path.basename(n).replace(/\.tiff?$/i, '');
  const destDir = path.join(EXTRACT_ROOT, a.id);
  rec.extractDir = destDir;
  rec.sets = [];
  let allHeaders = [];

  for (const [setName, list] of [...bySet.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const umedaByName = list.filter((t) => meshOverlapsUmeda(base(t.name)) === true);
    const sample = [];
    if (sampleAll) {
      const step = Math.max(1, Math.floor(list.length / 20));
      for (let i = 0; i < list.length; i += step) sample.push(list[i].name);
    }
    const want = [...new Set([...umedaByName.map((t) => t.name), ...sample])];
    const ex = extractEntries(archivePath, want, destDir);

    const headers = [];
    for (const n of want) {
      const f = path.join(destDir, n);
      if (!fs.existsSync(f)) continue;
      try {
        const h = await readOne(f);
        h.set = setName;
        h.meshCode = base(n);
        h.isUmeda = meshOverlapsUmeda(h.meshCode) === true;
        headers.push(h);
      } catch (e) { headers.push({ file: path.basename(n), set: setName, error: String(e && e.message || e).slice(0, 160) }); }
    }
    allHeaders = allHeaders.concat(headers);

    const ok = headers.filter((h) => h.gsdM != null);
    const um = ok.filter((h) => h.isUmeda);
    rec.sets.push({
      set: setName, captureFiscalYear: fiscalYearOf(setName, a.year),
      tifCount: list.length,
      umedaMeshes: umedaByName.map((t) => base(t.name)),
      extractPlan: { umeda: umedaByName.length, sample: sample.length, total: want.length },
      extract: ex, headersRead: headers.length,
      crsSeen: [...new Set(ok.map((h) => h.crsName || h.crs || h.crsKind))],
      crsKind: [...new Set(ok.map((h) => h.crsKind))],
      sizesSeen: [...new Set(ok.map((h) => `${h.width}x${h.height}`))],
      gsdXStats: stats(ok.map((h) => h.gsdXm)), gsdYStats: stats(ok.map((h) => h.gsdYm)),
      gsdStats: stats(ok.map((h) => h.gsdM)),
      gsdClass: ok.length ? classifyGsd(stats(ok.map((h) => h.gsdM)).median) : null,
      umeda: { count: um.length, meshes: um.map((h) => h.meshCode),
        gsdXStats: stats(um.map((h) => h.gsdXm)), gsdYStats: stats(um.map((h) => h.gsdYm)),
        gsdStats: stats(um.map((h) => h.gsdM)),
        gsdClass: um.length ? classifyGsd(stats(um.map((h) => h.gsdM)).median) : null },
      headers,
    });
  }
  rec.headersRead = allHeaders.length;

  const ok = allHeaders.filter((h) => h.gsdM != null);
  const um = ok.filter((h) => h.isUmeda);
  rec.crsSeen = [...new Set(ok.map((h) => h.crsName || h.crs || h.crsKind))];
  rec.sizesSeen = [...new Set(ok.map((h) => `${h.width}x${h.height}`))];
  rec.gsdStats = stats(ok.map((h) => h.gsdM));
  rec.gsdClass = rec.gsdStats ? classifyGsd(rec.gsdStats.median) : null;
  rec.umeda = { count: um.length, meshes: [...new Set(um.map((h) => h.meshCode))],
    gsdXStats: stats(um.map((h) => h.gsdXm)), gsdYStats: stats(um.map((h) => h.gsdYm)),
    gsdStats: stats(um.map((h) => h.gsdM)),
    gsdClass: um.length ? classifyGsd(stats(um.map((h) => h.gsdM)).median) : null };
  return rec;
}

/** images/ の直下のフォルダ名（無ければ既定名）。撮影年度の組を見分けるのに使う。 */
export function setNameOf(entryName) {
  const parts = entryName.split('/');
  const i = parts.indexOf('images');
  if (i >= 0 && parts.length > i + 2) return parts[i + 1];
  return '(single)';
}
/** R2 / R3 のような和暦フォルダ名から撮影年度（西暦）を出す。 */
export function fiscalYearOf(setName, fallbackYear) {
  const m = String(setName).match(/^([RH])(\d{1,2})$/);
  if (!m) return fallbackYear ?? null;
  const n = +m[2];
  return m[1] === 'R' ? 2018 + n : 1988 + n;
}
/** 拡張子ごとの件数。 */
export function countExtensions(entries) {
  const out = {};
  for (const e of entries) {
    const ext = (e.name.match(/\.([A-Za-z0-9]+)$/) || [, '(none)'])[1].toLowerCase();
    out[ext] = (out[ext] || 0) + 1;
  }
  return out;
}

/** §7 判定。 */
export function decide(results) {
  const classes = [];
  for (const r of results) {
    for (const st of (r.sets || [])) {
      if (st.umeda && st.umeda.gsdClass) {
        classes.push({ id: r.id + '/' + st.set, captureFiscalYear: st.captureFiscalYear,
          cls: st.umeda.gsdClass, gsdM: st.umeda.gsdStats.median });
      }
    }
  }
  const hasA = classes.some((c) => c.cls === 'A');
  const hasB = classes.some((c) => c.cls === 'B');
  if (hasA) return { verdict: 'A', action: '35A 再実行候補', freeDataSufficient: 'YES', classes };
  if (hasB) return { verdict: 'B', action: 'ground truth で精度を再評価', freeDataSufficient: 'YES', classes };
  return { verdict: 'C/D', action: '大阪市の原成果の取得検討へ進む', freeDataSufficient: 'NO', classes };
}

export async function run() {
  const t0 = Date.now();
  const results = [];
  for (const a of ARCHIVES) {
    console.log('[gsd]', a.id, '調査開始');
    const r = await auditArchive(a);
    results.push(r);
    if (r.exists) {
      console.log('[gsd]', a.id, 'tif', r.tifCount, '| 撮影年度の組', r.setCount, '| 他', JSON.stringify(r.nonTifKinds));
      for (const st of r.sets) {
        console.log('   ', (st.set + ' (' + st.captureFiscalYear + '年度)').padEnd(18),
          'tif', String(st.tifCount).padStart(4), '|', st.crsKind.join(','), '|', st.sizesSeen.slice(0, 3).join(' '),
          '| GSD 中央', st.gsdStats ? st.gsdStats.median + ' → ' + st.gsdClass : '不明',
          '| 梅田', st.umeda.count + '枚',
          st.umeda.gsdStats ? `min ${st.umeda.gsdStats.min} / med ${st.umeda.gsdStats.median} / max ${st.umeda.gsdStats.max} → ${st.umeda.gsdClass}` : '');
      }
    } else console.log('[gsd]', a.id, '×', r.reason);
  }
  const decision = decide(results);
  const comparison = [
    ...results.flatMap((r) => (r.sets || []).filter((st) => st.umeda && st.umeda.gsdStats).map((st) => ({
      id: r.id + (st.set === '(single)' ? '' : '/' + st.set),
      label: `PLATEAU ${r.year} 配布 / 撮影 ${st.captureFiscalYear} 年度`
        + (st.set === '(single)' ? '' : `（${st.set}）`),
      gsdXm: st.umeda.gsdXStats.median, gsdYm: st.umeda.gsdYStats.median,
      gsdM: st.umeda.gsdStats.median, gsdClass: st.umeda.gsdClass, source: '35C 実測（GeoTIFF ヘッダ）' }))),
    ...KNOWN_SOURCES.map((k) => ({ ...k, gsdClass: classifyGsd(k.gsdM) })),
  ].sort((a, b) => a.gsdM - b.gsdM);

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '35C',
    area: { id: 'umeda', name: '梅田', ...UMEDA_LL, bbox: UMEDA_BBOX },
    workDir: WORK_DIR, extractRoot: EXTRACT_ROOT,
    gsdClassDefinition: GSD_CLASS.map((g) => ({ cls: g.cls, label: g.label })),
    archives: results, comparison, decision,
    geometryGenerated: false,
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  run().then((o) => {
    console.log('[gsd] ── §8 比較 ──');
    for (const c of o.comparison) console.log('   ', String(c.gsdM).padStart(7) + 'm', c.gsdClass, '|', c.label, `(X ${c.gsdXm} / Y ${c.gsdYm})`);
    console.log('[gsd] 判定:', o.decision.verdict, '→', o.decision.action);
    console.log('[gsd] 無料データだけで次へ進めるか:', o.decision.freeDataSufficient);
    console.log('[gsd] out', OUT);
  }).catch((e) => { console.error(e); process.exit(1); });
}
