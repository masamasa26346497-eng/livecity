#!/usr/bin/env node
// tools/audit/plateau-height-provenance-scan.js
// [Mission 32S §3/§13] PLATEAU の生 CityGML を走査し、建物ごとに「高さの実測値があるか」を確定する。
//   canonical（V2）には heightM しか残っておらず、変換時の既定値 3.0m と実測 3.0m を画面で区別できない。
//   ここでは変換器（tools/convert-plateau-buildings.js）と同じ判定順で、建物ごとに
//     measuredHeight があるか / storeysAboveGround があるか だけを取り出す（geometry には触らない）。
//   出力: data/reports/plateau-height-provenance.json（集計）
//         data/processed/osaka-city/canonical/plateau-height-facts.json（gmlId → {m:実測高さ, s:階数}）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readZipEntries, extractEntry } from '../lib/zip-reader.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW = P('data', 'raw');
// canonical V2 は folder の GML に加えてこの ZIP 内の GML も読んでいる（build-canonical-buildings-v2-corrected.js）
const RAW_ZIP = P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip');
const OUT_REPORT = P('data', 'reports', 'plateau-height-provenance.json');
const OUT_FACTS = P('data', 'processed', 'osaka-city', 'canonical', 'plateau-height-facts.json');
const START = '<bldg:Building';

function* gmlFiles() {
  const stack = [RAW];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/_bldg_.*\.gml$/i.test(e.name) && !/-DESKTOP-/.test(e.name)) yield p;
    }
  }
}
/** <bldg:Building …> の開始位置（BuildingPart / BuildingInstallation は除く） */
function buildingStarts(text, from = 0) {
  const out = [];
  for (let i = text.indexOf(START, from); i >= 0; i = text.indexOf(START, i + 1)) {
    const c = text[i + START.length];
    if (c === ' ' || c === '>' || c === '\n' || c === '\r' || c === '\t') out.push(i);
  }
  return out;
}
function factsOf(seg) {
  const idm = /gml:id="([^"]+)"/.exec(seg);
  if (!idm) return null;
  const mm = /<bldg:measuredHeight[^>]*>([-\d.]+)<\/bldg:measuredHeight>/.exec(seg);
  const sm = /<bldg:storeysAboveGround>(\d+)<\/bldg:storeysAboveGround>/.exec(seg);
  // 変換器は [\d.]+ でしか拾わないため -9999 等の負値は「measuredHeight 無し」として扱われる。同じ判定にする。
  const measured = mm && /^[\d.]+$/.test(mm[1]) ? parseFloat(mm[1]) : null;
  return { id: idm[1], m: Number.isFinite(measured) ? measured : null, s: sm ? parseInt(sm[1], 10) : null };
}

/** 文字列（ZIP 内の 1 エントリ全体）を走査する */
export function scanText(text, sink) {
  const starts = buildingStarts(text);
  for (let i = 0; i < starts.length; i++) sink(factsOf(text.slice(starts[i], starts[i + 1] ?? text.length)));
}

export async function scanFile(file, sink) {
  return new Promise((resolve, reject) => {
    let carry = '';
    const rs = fs.createReadStream(file, { encoding: 'utf-8', highWaterMark: 8 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      carry += chunk;
      const starts = buildingStarts(carry);
      if (starts.length < 2) return;
      for (let i = 0; i + 1 < starts.length; i++) sink(factsOf(carry.slice(starts[i], starts[i + 1])));
      carry = carry.slice(starts[starts.length - 1]);
    });
    rs.on('end', () => {
      const starts = buildingStarts(carry);
      for (let i = 0; i < starts.length; i++) sink(factsOf(carry.slice(starts[i], starts[i + 1] ?? carry.length)));
      resolve();
    });
    rs.on('error', reject);
  });
}

async function main() {
  const files = [...gmlFiles()].sort();
  const facts = Object.create(null);
  // storeysAboveGround / measuredHeight には 9999・-9999 の「不明」センチネルが混ざる（実測 1 ファイルで確認済み）。
  const okStoreys = (v) => v != null && v >= 1 && v <= 200;
  const okMeasured = (v) => v != null && v > 0 && v < 1000;
  const stat = { files: files.length, buildings: 0, withMeasuredHeight: 0, measuredSentinel: 0, withStoreys: 0, storeysSentinel: 0, neither: 0, duplicateIds: 0, measuredNegativeOrMissing: 0 };
  let done = 0, bytes = 0;
  // canonical V2 は folder の GML に加えて ZIP 内の GML も読んでいるので、同じ範囲を走査する
  const zipEntries = fs.existsSync(RAW_ZIP) ? readZipEntries(RAW_ZIP).filter((e) => /bldg\/\d{8}_bldg_\d+_op\.gml$/.test(e.name)) : [];
  const sources = [
    ...files.map((f) => ({ name: f, size: fs.statSync(f).size, scan: (sink) => scanFile(f, sink) })),
    ...zipEntries.map((e) => ({ name: RAW_ZIP + '::' + e.name, size: e.size || 0, scan: async (sink) => scanText(extractEntry(RAW_ZIP, e).toString('utf-8'), sink) })),
  ];
  stat.folderFiles = files.length;
  stat.zipEntries = zipEntries.length;
  stat.files = sources.length;
  for (const f of sources) {
    bytes += f.size;
    await f.scan((r) => {
      if (!r) return;
      stat.buildings++;
      if (facts[r.id] !== undefined) stat.duplicateIds++;
      if (okMeasured(r.m)) stat.withMeasuredHeight++; else stat.measuredNegativeOrMissing++;
      if (r.m != null && !okMeasured(r.m)) stat.measuredSentinel++;
      if (okStoreys(r.s)) stat.withStoreys++;
      if (r.s != null && !okStoreys(r.s)) stat.storeysSentinel++;
      if (!okMeasured(r.m) && !okStoreys(r.s)) stat.neither++;
      facts[r.id] = { m: r.m, s: r.s };
    });
    if (++done % 20 === 0 || done === sources.length) console.log(`[plateau-facts] ${done}/${sources.length} sources, ${stat.buildings} buildings`);
  }
  fs.writeFileSync(OUT_FACTS, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), missionId: '32S', note: 'gmlId → { m: measuredHeight（無し/負値は null）, s: storeysAboveGround }。変換器と同じ判定。', stat, facts }));
  fs.writeFileSync(OUT_REPORT, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), missionId: '32S', scannedBytes: bytes, stat }, null, 2));
  return stat;
}

if (isMainModule(import.meta.url)) {
  main().then((s) => { console.log('[plateau-facts]', JSON.stringify(s)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
