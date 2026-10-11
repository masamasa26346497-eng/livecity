#!/usr/bin/env node
'use strict';
// Mission 37F: 36L 写真索引の Commons 画像について、撮影日（DateTimeOriginal）を MediaWiki 公式 API から取得し photo-dates.json を生成する。
// 読み取り専用の公開 API のみ（トークン不要・費用ゼロ）。ビルド時専用（ブラウザからは呼ばない）。
//   node tools/mission37f-fetch-photo-dates.cjs [--limit N] [--offline] [--fresh]
//   --limit N : 先頭 N ファイルだけ処理（小規模サンプル。photo-dates.json は書き換えない）
//   --offline : ネットワークを使わずキャッシュだけで生成   --fresh : キャッシュを無視
// 撮影日として採用するのは extmetadata.DateTimeOriginal が ISO 形式（YYYY[-MM[-DD]] [時刻]）のときだけ。
// アップロード/更新 timestamp、DateTime、ファイル名の年は採用しない。曖昧・範囲・非 ISO・異常値は verified:false で原文と理由を保持する。
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const IDX = path.join(root, 'public/map-data/osaka-city/derived/building-photo-index.json');
const OUT = path.join(root, 'public/map-data/osaka-city/derived/photo-dates.json');
const CACHE = path.join(root, 'data/cache/mission37f-commons/imageinfo-cache.json');
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'LiveCityPhotoDateBot/0.1 (https://github.com/masamasa26346497-eng/livecity; read-only imageinfo batch, build-time)';
const BATCH = 50, DELAY_MS = 1500, TIMEOUT_MS = 20000, MAX_RETRY = 5, MAXLAG = 5;

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const limit = has('--limit') ? +args[args.indexOf('--limit') + 1] : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileNameOf(p) {
  const m = String((p && p.sourcePageUrl) || '').match(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:([^?#]+)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

// ── 撮影日の厳密な解釈（純関数。テスト対象）──
const stripTags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function parseTakenAt(raw, uploadedIso, now) {
  const text = stripTags(raw);
  if (!text) return { verified: false, reason: 'empty' };
  // 日付範囲・曖昧表現（between / circa / ~ / 複数日付 / 和文）は自動変換しない
  const m = text.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return { verified: false, reason: 'non-iso-or-ambiguous' };
  const y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
  if (y < 1900) return { verified: false, reason: 'year-out-of-range' };
  if (mo != null && (mo < 1 || mo > 12)) return { verified: false, reason: 'invalid-month' };
  if (d != null) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { verified: false, reason: 'invalid-day' };
  }
  if (m[4] != null && (+m[4] > 23 || +m[5] > 59 || (m[6] != null && +m[6] > 59))) return { verified: false, reason: 'invalid-time' };
  const takenAt = m[1] + (mo ? '-' + m[2] : '') + (d ? '-' + m[3] : '');
  const start = Date.UTC(y, (mo || 1) - 1, d || 1);
  if (start > now.getTime() + 36 * 3600 * 1000) return { verified: false, reason: 'future-date' };
  // 撮影はアップロードより後にならない（時差ぶん 36 時間は許容）。矛盾する値は採用しない。
  if (uploadedIso) {
    const up = Date.parse(uploadedIso);
    if (Number.isFinite(up) && start > up + 36 * 3600 * 1000) return { verified: false, reason: 'taken-after-upload' };
  }
  return { verified: true, takenAt, precision: d ? 'day' : mo ? 'month' : 'year' };
}

async function getJson(url, attempt) {
  attempt = attempt || 0;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let status = null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ac.signal });
    status = r.status;
    if (r.status === 429 || r.status === 503) {
      const ra = +r.headers.get('retry-after') || 0;
      throw Object.assign(new Error('HTTP ' + r.status), { retry: true, wait: ra * 1000 });
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.error && j.error.code === 'maxlag') throw Object.assign(new Error('maxlag'), { retry: true, wait: 5000 });
    if (j && j.error) throw new Error('API error ' + j.error.code);
    return j;
  } catch (e) {
    const retry = e.retry || e.name === 'AbortError' || (e.cause && e.cause.code);
    if (retry && attempt < MAX_RETRY) {
      const wait = Math.max(e.wait || 0, Math.min(60000, 2000 * Math.pow(2, attempt)));
      console.error('  retry ' + (attempt + 1) + '/' + MAX_RETRY + ' in ' + wait + 'ms (' + e.message + ')');
      clearTimeout(t);
      await sleep(wait);
      return getJson(url, attempt + 1);
    }
    throw Object.assign(e, { httpStatus: status });
  } finally { clearTimeout(t); }
}

async function fetchBatch(names) {
  const u = new URL(API);
  u.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo', iiprop: 'extmetadata|timestamp',
    iiextmetadatafilter: 'DateTimeOriginal|DateTime', titles: names.map((n) => 'File:' + n).join('|'), maxlag: String(MAXLAG) }).toString();
  const j = await getJson(u.toString());
  const norm = {}; // 正規化後タイトル → 元タイトル
  for (const n of (j.query && j.query.normalized) || []) norm[n.to] = n.from;
  const out = {};
  for (const pg of (j.query && j.query.pages) || []) {
    const orig = (norm[pg.title] || pg.title).replace(/^File:/, '');
    const key = names.find((n) => n === orig || n.replace(/_/g, ' ') === orig.replace(/_/g, ' '));
    if (!key) continue;
    if (pg.missing || !pg.imageinfo || !pg.imageinfo[0]) { out[key] = { missing: true }; continue; }
    const ii = pg.imageinfo[0], em = ii.extmetadata || {};
    out[key] = { uploadedAt: ii.timestamp || null,
      dateTimeOriginal: em.DateTimeOriginal ? { value: em.DateTimeOriginal.value, source: em.DateTimeOriginal.source } : null };
  }
  return out;
}

async function main() {
  const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
  const names = [...new Set(Object.values(idx.byCanonicalId).flatMap((e) => (e.photos || []).map(fileNameOf)).filter(Boolean))].slice(0, limit);
  let cache = {};
  if (!has('--fresh') && fs.existsSync(CACHE)) cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const todo = names.filter((n) => !cache[n]);
  console.log('files=' + names.length + ' cached=' + (names.length - todo.length) + ' todo=' + todo.length + (has('--offline') ? ' (offline)' : ''));
  const net = { requests: 0, failedBatches: 0, lastError: null };
  if (!has('--offline')) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      try {
        net.requests++;
        const res = await fetchBatch(batch);
        for (const n of batch) cache[n] = res[n] || { notReturned: true };
        fs.writeFileSync(CACHE, JSON.stringify(cache)); // バッチごとに保存（中断再開）
        console.log('  batch ' + (i / BATCH + 1) + ': ' + Object.keys(res).length + '/' + batch.length);
      } catch (e) {
        net.failedBatches++;
        net.lastError = { message: e.message, httpStatus: e.httpStatus || null, code: (e.cause && e.cause.code) || null };
        console.error('  batch failed:', JSON.stringify(net.lastError));
      }
      if (i + BATCH < todo.length) await sleep(DELAY_MS);
    }
  }
  const now = new Date(), dates = {};
  const stat = { total: 0, verified: 0, unknown: 0, reasons: {} };
  for (const n of names) {
    stat.total++;
    const c = cache[n];
    const evidenceUrl = 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(n).replace(/%2F/g, '/');
    let rec;
    if (!c) rec = { verified: false, reason: 'not-fetched' };
    else if (c.missing || c.notReturned) rec = { verified: false, reason: c.missing ? 'file-missing' : 'not-returned' };
    else if (!c.dateTimeOriginal) rec = { verified: false, reason: 'no-DateTimeOriginal', uploadedAt: c.uploadedAt };
    else {
      const p = parseTakenAt(c.dateTimeOriginal.value, c.uploadedAt, now);
      rec = p.verified
        ? { verified: true, takenAt: p.takenAt, precision: p.precision, field: 'extmetadata.DateTimeOriginal', fieldSource: c.dateTimeOriginal.source, raw: stripTags(c.dateTimeOriginal.value), uploadedAt: c.uploadedAt }
        : { verified: false, reason: p.reason, raw: stripTags(c.dateTimeOriginal.value).slice(0, 200), uploadedAt: c.uploadedAt };
    }
    rec.evidenceUrl = evidenceUrl;
    dates[n] = rec;
    if (rec.verified) stat.verified++; else { stat.unknown++; stat.reasons[rec.reason] = (stat.reasons[rec.reason] || 0) + 1; }
  }
  if (has('--limit')) { console.log('(sample run: photo-dates.json は書き換えません)'); console.log(JSON.stringify({ stat, net })); return; }
  const doc = { generatedAt: now.toISOString(), source: 'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata|timestamp (read-only, public)',
    policy: 'verified:true は extmetadata.DateTimeOriginal が ISO 形式で、未来日でなく、アップロードより前のときだけ。uploadedAt は参考情報で撮影日ではない。', stats: stat, network: net, dates };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log(JSON.stringify({ stat, net }));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { parseTakenAt, stripTags, fileNameOf };
