#!/usr/bin/env node
// Mission 35L: e-Stat 令和2年国勢調査「小地域（町丁・字等）境界データ」大阪府版を取得する。
// 公式の統計GIS直ダウンロードURLを使用し、raw ZIPを無加工で保存する。
// データ年は2020。令和7年国勢調査の小地域境界が公開されたら、別Missionで更新を判断する。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';

export const DEFAULT_URL =
  'https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=A002005212020&code=27&coordSys=1&format=shape&downloadType=5&datum=2011';
export const OUT_ZIP = resolveProjectPath(path.join('data', 'raw', 'osaka-city', 'boundaries', 'estat-2020-town-boundaries-osaka.zip'));
export const OUT_META = resolveProjectPath(path.join('data', 'raw', 'osaka-city', 'boundaries', 'estat-2020-town-boundaries-osaka.meta.json'));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function downloadEstatTownBoundaries({ url = DEFAULT_URL, force = false } = {}) {
  try {
    if (!force) {
      await fs.access(OUT_ZIP);
      return { status: 'skipped-exists', zip: OUT_ZIP, meta: OUT_META };
    }
  } catch { /* absent: continue */ }

  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'LiveCity-boundary-pipeline/35L' },
  });
  if (!res.ok) throw new Error(`e-Stat境界ZIP取得失敗: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf.readUInt32LE(0) !== 0x04034b50) {
    const prefix = buf.subarray(0, Math.min(120, buf.length)).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(`e-Stat応答がZIPではありません (${buf.length} bytes): ${prefix}`);
  }

  await fs.mkdir(path.dirname(OUT_ZIP), { recursive: true });
  await fs.writeFile(OUT_ZIP, buf);
  const meta = {
    missionId: '35L',
    sourceName: '令和2年国勢調査 小地域（町丁・字等）境界データ',
    provider: '総務省統計局 / e-Stat',
    surveyId: 'A002005212020',
    prefectureCode: '27',
    coordinateSystem: 'JGD2011 geographic (e-Stat coordSys=1, datum=2011)',
    sourceUrl: url,
    downloadedAt: new Date().toISOString(),
    bytes: buf.length,
    sha256: sha256(buf),
    note: '国勢調査の統計境界であり、住居表示上の法的町界と常に一致することを保証するものではない。Live Cityでは出典と基準年を明示して利用する。',
  };
  await fs.writeFile(OUT_META, JSON.stringify(meta, null, 2));
  return { status: 'downloaded', zip: OUT_ZIP, meta: OUT_META, bytes: buf.length, sha256: meta.sha256 };
}

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') out.url = argv[++i];
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  downloadEstatTownBoundaries(parseArgs(process.argv.slice(2)))
    .then((r) => console.log('[35L e-Stat]', JSON.stringify(r, null, 2)))
    .catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}
