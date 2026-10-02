#!/usr/bin/env node
// tools/download/plateau-ortho-archive.js
// [Mission 35C §2] PLATEAU のオルソ 7z を **repo の外** へ落とす。
//   repo 配下（OneDrive 同期下）に数 GB を置くと同期の衝突コピーが出るため、
//   既定の置き場は C:\LiveCityAssets\orthophoto-audit。
//   既にあるファイルは上書きしない（途中まであれば Range で続きから取る）。
//   ネットワークが要る。
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { isMainModule } from '../lib/paths.js';

export const WORK_DIR = process.env.LIVECITY_ORTHO_DIR || 'C:\\LiveCityAssets\\orthophoto-audit';
export const UA = 'livecity-data-pipeline/0.2.0 (Mission35C ortho GSD audit)';

/** 対象。URL は data/reports/umeda-ortho-source-catalog.json の実測値。 */
export const ARCHIVES = [
  { id: 'plateau-2020', year: 2020,
    url: 'https://gsic-opendata.s3.ap-northeast-1.amazonaws.com/national-gov/mlit/city-bureau/3d-city-model/2020/plateau-27100-osaka-shi-2020/ortho/27100_osaka-shi_2020_ortho_2_op.7z',
    file: '27100_osaka-shi_2020_ortho_2_op.7z', expectBytes: 1001582592 },
  { id: 'plateau-2022', year: 2022,
    url: 'https://gsic-opendata.s3.ap-northeast-1.amazonaws.com/national-gov/mlit/city-bureau/3d-city-model/2022/plateau-27100-osaka-shi-2022/ortho/27100_osaka-shi_2022_ortho_1_op.7z',
    file: '27100_osaka-shi_2022_ortho_1_op.7z', expectBytes: 5342081024 },
];

const MB = (n) => (n / 1048576).toFixed(0);

export async function headSize(url) {
  const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HEAD 失敗 ' + res.status);
  return { size: Number(res.headers.get('content-length')) || null,
    acceptRanges: res.headers.get('accept-ranges') };
}

/** 途中まで落ちていれば続きから。完了済みならそのまま返す。 */
export async function downloadResumable(a, dir = WORK_DIR, { onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, a.file);
  const { size, acceptRanges } = await headSize(a.url);
  let have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (size && have === size) return { ...a, dest, size, have, skipped: true };
  if (have > 0 && acceptRanges !== 'bytes') { fs.rmSync(dest); have = 0; }
  if (size && have > size) { fs.rmSync(dest); have = 0; }

  const headers = { 'User-Agent': UA };
  if (have > 0) headers.Range = `bytes=${have}-`;
  const res = await fetch(a.url, { headers });
  if (!(res.status === 200 || res.status === 206)) throw new Error('GET 失敗 ' + res.status);
  if (res.status === 200 && have > 0) have = 0;    // Range を無視された

  const out = fs.createWriteStream(dest, { flags: have > 0 ? 'a' : 'w' });
  let got = have, lastLog = Date.now();
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    got += c.length;
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      const pctNum = size ? ((got / size) * 100).toFixed(1) : '?';
      if (onProgress) onProgress({ got, size, pct: pctNum });
      else console.log(`[dl] ${a.id} ${MB(got)}/${MB(size)} MB (${pctNum}%)`);
    }
  });
  await pipeline(src, out);
  const final = fs.statSync(dest).size;
  return { ...a, dest, size, have: final, complete: !size || final === size, skipped: false };
}

export async function run(ids = null) {
  const targets = ids ? ARCHIVES.filter((a) => ids.includes(a.id)) : ARCHIVES;
  const out = [];
  for (const a of targets) {
    console.log(`[dl] ${a.id} 開始 ${a.url.split('/').pop()}`);
    const r = await downloadResumable(a);
    console.log(`[dl] ${a.id} ${r.skipped ? '取得済み' : '完了'} ${MB(r.have)} MB -> ${r.dest}`);
    out.push(r);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  const ids = process.argv.slice(2).filter((s) => !s.startsWith('-'));
  run(ids.length ? ids : null)
    .then((r) => { console.log('[dl] 完了', r.map((x) => x.id + ':' + MB(x.have) + 'MB').join(' ')); })
    .catch((e) => { console.error(e); process.exit(1); });
}
