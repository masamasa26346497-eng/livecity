#!/usr/bin/env node
'use strict';
// Mission 37F-3: 既存建物に対する「新しい別画像」の候補探索（調査サンプル。本番データは書き換えない）。
//   node tools/mission37f-candidate-survey.cjs [--n 16] [--out data/reports/mission37f-candidates/survey.json]
// Commons 公式 API (generator=search, 読み取り専用・公開 GET のみ) で建物名を検索し、候補ごとに証拠を集計する。画像ファイルは取得・複製しない。
// 自動採用の条件(すべて必須): 撮影座標が建物の Wikidata 座標から 100m 以内 / 説明かタイトルに建物名 / オープンライセンス /
//   DateTimeOriginal が ISO で検証済み(parseTakenAt) / 現在の先頭写真より新しい / 既存索引に未収録 / 古写真・日付矛盾カテゴリでない。
// 満たさないものは 'rejected' として理由付きで候補レポートに残す。座標のない候補は、どれだけ新しくても自動採用しない(手動確認待ち)。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseTakenAt, categoryDateConflict, stripTags } = require('./mission37f-fetch-photo-dates.cjs');
const root = path.resolve(__dirname, '..');
const D = path.join(root, 'public/map-data/osaka-city/derived');
const UA = 'LiveCityPhotoDateBot/0.1 (https://github.com/masamasa26346497-eng/livecity; read-only candidate survey, build-time)';
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const N = Math.min(20, +arg('--n', 16));
// 増分モード: --incremental で ledger を読み、調査済み建物を除外して区ごとに分散した新規建物を選ぶ。--ids a,b で建物指定、--recheck-days で再調査間隔(既定 30)。
const INCR = args.includes('--incremental');
const IDS = arg('--ids', '') ? arg('--ids', '').split(',') : [];
const RECHECK_DAYS = +arg('--recheck-days', 30);
const LEDGER = path.join(root, 'data/reports/mission37f-candidates/ledger.json');
const OUT = path.join(root, arg('--out', 'data/reports/mission37f-candidates/survey.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sb = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb);
const PS = sb.module.exports;
const OPEN = /^(CC0|CC BY(-SA)?\b|Public domain|PD)/i;

const rad = Math.PI / 180;
const distM = (a, b, c, d) => { const x = (d - b) * rad * Math.cos(((a + c) / 2) * rad), y = (c - a) * rad; return Math.hypot(x, y) * 6371000; };

async function search(term) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', generator: 'search', gsrnamespace: '6', gsrlimit: '20', gsrsearch: term,
    prop: 'imageinfo|coordinates|categories', cllimit: 'max', iiprop: 'extmetadata|timestamp|size',
    iiextmetadatafilter: 'ImageDescription|DateTimeOriginal|Artist|LicenseShortName' }).toString();
  for (let a = 0; a < 4; a++) {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429 || r.status === 503) { await sleep(2000 * 2 ** a); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.error && j.error.code === 'maxlag') { await sleep(5000); continue; }
    return (j.query && j.query.pages) || [];
  }
  throw new Error('retries exhausted');
}

async function main() {
  const idx = JSON.parse(fs.readFileSync(path.join(D, 'building-photo-index.json'), 'utf8')).byCanonicalId;
  const dates = JSON.parse(fs.readFileSync(path.join(D, 'photo-dates.json'), 'utf8')).dates;
  const holds = JSON.parse(fs.readFileSync(path.join(D, 'photo-review.json'), 'utf8')).holds.map((h) => h.file);
  const all = Object.values(idx).filter((e) => e.matchConfidence === 'VERY_HIGH' && e.buildingName && e.lat && (e.photos || []).length);
  const sumi = all.filter((e) => /sumiyoshi|hirano/i.test(e.ward || '')).sort((a, b) => a.buildingName.localeCompare(b.buildingName, 'ja')).slice(0, Math.ceil(N / 2));
  const others = all.filter((e) => !sumi.includes(e) && !/sumiyoshi|hirano/i.test(e.ward || '')).sort((a, b) => b.photos.length - a.photos.length || a.buildingName.localeCompare(b.buildingName, 'ja')).slice(0, N - sumi.length);
  let sample = sumi.concat(others);
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : { schema: 'mission37f-survey-ledger/1', buildings: {} };
  if (INCR || IDS.length) {
    if (IDS.length) sample = all.filter((e) => IDS.includes(e.canonicalId));
    else {
      const byWard = {};
      all.filter((e) => { const L = ledger.buildings[e.canonicalId]; return !L || (Date.now() - Date.parse(L.lastSurveyedAt)) / 864e5 >= RECHECK_DAYS * 12; })
        .sort((a, b) => b.photos.length - a.photos.length || a.buildingName.localeCompare(b.buildingName, 'ja'))
        .forEach((e) => (byWard[e.ward || '?'] = byWard[e.ward || '?'] || []).push(e));
      sample = [];
      for (let i = 0; sample.length < N && Object.values(byWard).some((l) => l[i]); i++) for (const l of Object.values(byWard)) if (l[i] && sample.length < N) sample.push(l[i]);
    }
  }
  const now = new Date(), report = [];
  for (const e of sample) {
    const known = new Set((e.photos || []).map((p) => PS.fileName(p).replace(/_/g, ' ')));
    const cur = PS.rankPhotos(e, { dates, exclude: holds }).photos[0];
    const curDate = cur ? cur.date : { basis: 'unknown' };
    const rec = { canonicalId: e.canonicalId, name: e.buildingName, ward: e.ward, current: cur ? { file: PS.fileName(cur.photo), takenAt: curDate.takenAt || null, basis: curDate.basis } : null, candidates: [] };
    let pages = [];
    try { pages = await search(e.buildingName); } catch (err) { rec.error = err.message; }
    for (const pg of pages) {
      const file = pg.title.replace(/^File:/, ''), ii = (pg.imageinfo || [])[0];
      if (!ii || known.has(file.replace(/_/g, ' '))) continue;
      const em = ii.extmetadata || {}, license = stripTags(em.LicenseShortName && em.LicenseShortName.value);
      const desc = stripTags(em.ImageDescription && em.ImageDescription.value);
      const cats = (pg.categories || []).map((c) => c.title.replace(/^Category:/, ''));
      const pd = em.DateTimeOriginal ? parseTakenAt(em.DateTimeOriginal.value, ii.timestamp, now) : { verified: false, reason: 'no-DateTimeOriginal' };
      const conf = pd.verified ? categoryDateConflict(cats, pd.takenAt) : null;
      const co = (pg.coordinates || [])[0];
      const dist = co ? Math.round(distM(e.lat, e.lon, co.lat, co.lon)) : null;
      const nameHit = file.includes(e.buildingName) || desc.includes(e.buildingName);
      const why = [];
      if (!OPEN.test(license)) why.push('license-not-open');
      if (!pd.verified || conf) why.push(conf || pd.reason || 'date-unverified');
      if (dist == null) why.push('no-coordinates');
      else if (dist > 100) why.push('coordinates-too-far:' + dist + 'm');
      if (!nameHit) why.push('no-name-in-title-or-description');
      if (pd.verified && !conf && curDate.takenAt && pd.takenAt <= curDate.takenAt) why.push('not-newer');
      if (pd.verified && !conf && curDate.basis !== 'verified') { /* 現在の先頭の日付が未確認でも、候補が自動採用条件を満たせば『新しい』ことは確認済み */ }
      rec.candidates.push({ file, takenAt: pd.verified && !conf ? pd.takenAt : null, license, distanceM: dist, size: ii.width + 'x' + ii.height,
        evidenceUrl: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file), verdict: why.length ? 'rejected' : 'auto-adoptable', rejectedBecause: why });
    }
    rec.summary = { found: rec.candidates.length, autoAdoptable: rec.candidates.filter((c) => c.verdict === 'auto-adoptable').length };
    report.push(rec);
    // ledger: 再調査日時・候補ごとの自動判定と理由を保持。人手の decision / decisionBasis は上書きしない。
    const L = ledger.buildings[e.canonicalId] = ledger.buildings[e.canonicalId] || { name: e.buildingName, ward: e.ward, candidates: {} };
    L.lastSurveyedAt = now.toISOString(); L.currentFile = rec.current && rec.current.file; L.currentTakenAt = rec.current && rec.current.takenAt;
    for (const c of rec.candidates) L.candidates[c.file] = Object.assign(L.candidates[c.file] || {}, { takenAt: c.takenAt, license: c.license, distanceM: c.distanceM, autoVerdict: c.verdict, autoReasons: c.rejectedBecause, evidenceUrl: c.evidenceUrl });
    console.log(e.buildingName + ' [' + e.ward + '] cand=' + rec.summary.found + ' ok=' + rec.summary.autoAdoptable);
    await sleep(1500);
  }
  const reasons = {};
  report.forEach((r) => r.candidates.forEach((c) => c.rejectedBecause.forEach((w) => { const k = w.replace(/:.*/, ''); reasons[k] = (reasons[k] || 0) + 1; })));
  const doc = { generatedAt: now.toISOString(), note: '調査サンプル。本番の索引・日付表には反映しない。auto-adoptable も人手確認を経て photo-review/索引に取り込む前提。', sampleSize: report.length,
    totals: { candidates: report.reduce((s, r) => s + r.candidates.length, 0), autoAdoptable: report.reduce((s, r) => s + r.summary.autoAdoptable, 0), rejectedReasons: reasons }, buildings: report };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  ledger.updatedAt = now.toISOString();
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1) + '\n');
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log(JSON.stringify(doc.totals));
}
main().catch((e) => { console.error(e); process.exit(1); });
