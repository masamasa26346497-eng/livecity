#!/usr/bin/env node
// tools/audit/plateau-lod-availability.js
// [Mission 34A §1/§2/§3] リポジトリ内の PLATEAU Building CityGML を全部走査し、
//   建物ごとに「実データとして存在する LOD」を確定する。geometry は作らない（在庫調査だけ）。
//
//   走査対象:
//     - data/raw/ 配下の *_bldg_*.gml（OneDrive の conflict copy `-DESKTOP-` は正本にしない）
//     - data/raw/.../CityGML_v4.zip 内の同名エントリ（canonical V2 の build と同じ範囲）
//   同じ gml:id が複数の copy に現れたときは「どれかに LOD2 があれば LOD2 あり」と見なす（max 合成）。
//
//   出力:
//     data/reports/plateau-lod-availability.json                     （集計。§3 の報告用）
//     data/processed/osaka-city/canonical/plateau-lod-index.json     （LOD2/LOD3 を持つ建物の索引）
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readZipEntries, extractEntry } from '../lib/zip-reader.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const RAW = P('data', 'raw');
const RAW_ZIP = P('data', 'raw', 'osaka-sumiyoshi', 'plateau', 'buildings-lod2', '2024', 'archive', 'CityGML_v4.zip');
const OUT_REPORT = P('data', 'reports', 'plateau-lod-availability.json');
const OUT_INDEX = P('data', 'processed', 'osaka-city', 'canonical', 'plateau-lod-index.json');
const START = '<bldg:Building';

// CityGML 2.0 / IUR 3.x で建物 geometry が入りうる要素（§2）
export const LOD_TAGS = {
  lod0: ['<bldg:lod0FootPrint', '<bldg:lod0RoofEdge'],
  lod1: ['<bldg:lod1Solid', '<bldg:lod1MultiSurface'],
  lod2: ['<bldg:lod2Solid', '<bldg:lod2MultiSurface', '<bldg:lod2Geometry'],
  lod3: ['<bldg:lod3Solid', '<bldg:lod3MultiSurface', '<bldg:lod3Geometry'],
};
export const SEMANTIC_TAGS = ['bldg:RoofSurface', 'bldg:WallSurface', 'bldg:GroundSurface', 'bldg:ClosureSurface',
  'bldg:Window', 'bldg:Door', 'bldg:BuildingPart', 'bldg:BuildingInstallation'];

export function* gmlFiles(root = RAW) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/-DESKTOP-/.test(e.name)) stack.push(p); }
      else if (/_bldg_.*\.gml$/i.test(e.name) && !/-DESKTOP-/.test(e.name)) yield p;
    }
  }
}
/** <bldg:Building …> の開始位置（BuildingPart / BuildingInstallation は建物の一部なので区切らない） */
export function buildingStarts(text, from = 0) {
  const out = [];
  for (let i = text.indexOf(START, from); i >= 0; i = text.indexOf(START, i + 1)) {
    const c = text[i + START.length];
    if (c === ' ' || c === '>' || c === '\n' || c === '\r' || c === '\t') out.push(i);
  }
  return out;
}
/** 1 建物ぶんの XML から LOD の有無と属性を取り出す。
 *  返す値は使い捨て（呼び出し側は数値へ畳んで保持する）。600k 件ぶんのオブジェクトを
 *  Map に溜めると 6GB でも足りないので、ここで大きな中間データを作らない。 */
export function lodOf(seg, semSink) {
  const idm = /gml:id="([^"]+)"/.exec(seg);
  if (!idm) return null;
  const has = (tags) => tags.some((t) => seg.indexOf(t) >= 0);
  const wm = /<gen:stringAttribute name="区名"><gen:value>([^<]+)</.exec(seg);
  const l2 = has(LOD_TAGS.lod2), l3 = has(LOD_TAGS.lod3);
  // semantic surface は全体集計だけ取る（建物ごとには持たない）
  if (semSink && (l2 || l3)) for (const t of SEMANTIC_TAGS) { const n = countOf(seg, '<' + t); if (n) semSink[t.replace('bldg:', '')] = (semSink[t.replace('bldg:', '')] || 0) + n; }
  return {
    // ★ V8 では正規表現の捕獲も「親文字列を参照する SlicedString」になる。
    //   gml:id をそのまま Map のキーにすると、1 件ごとに数 MB のチャンクが保持され続けて
    //   建物 1 件あたり約 26KB のヒープを食う（実測: 6 万件で 1.6GB → 22 万件で OOM）。
    //   必ず平坦な新しい文字列へ写してから外へ出す。
    id: detach(idm[1]),
    l0: has(LOD_TAGS.lod0), l1: has(LOD_TAGS.lod1), l2, l3,
    ward: wm ? detach(wm[1]) : null,
    posLists: (l2 || l3) ? countOf(seg, '<gml:posList') : 0,
  };
}
export function countOf(s, needle) { let c = 0, i = s.indexOf(needle); while (i >= 0) { c++; i = s.indexOf(needle, i + 1); } return c; }
// V8 の String#slice は「親を参照する sliced string」を作る。chunk の残りをそのまま持ち回すと
//   8MB のバッファが世代をまたいで保持され続け、数百ファイルでヒープを食い潰す（実測 6GB で OOM）。
//   Buffer 経由で必ず新しい平坦な文字列にしてから次のチャンクへ渡す。
export function flatten(s) { return s.length > 4096 ? Buffer.from(s, 'utf-8').toString('utf-8') : s; }
// 短い文字列（gml:id / 区名）を親から切り離す。Buffer を経由すると必ず新しい平坦な文字列になる。
export function detach(s) { return Buffer.from(s, 'utf-8').toString('utf-8'); }

export async function scanFileStream(file, sink, semSink) {
  return new Promise((resolve, reject) => {
    let carry = '';
    const rs = fs.createReadStream(file, { encoding: 'utf-8', highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      carry = carry ? carry + chunk : chunk;
      const starts = buildingStarts(carry);
      if (starts.length < 2) return;
      for (let i = 0; i + 1 < starts.length; i++) sink(lodOf(carry.slice(starts[i], starts[i + 1]), semSink));
      carry = flatten(carry.slice(starts[starts.length - 1]));
    });
    rs.on('end', () => {
      const starts = buildingStarts(carry);
      for (let i = 0; i < starts.length; i++) sink(lodOf(carry.slice(starts[i], starts[i + 1] ?? carry.length), semSink));
      carry = '';
      resolve();
    });
    rs.on('error', reject);
  });
}
export function scanText(text, sink, semSink) {
  const starts = buildingStarts(text);
  for (let i = 0; i < starts.length; i++) sink(lodOf(text.slice(starts[i], starts[i + 1] ?? text.length), semSink));
}

export async function main() {
  const folderFiles = [...gmlFiles()].sort();
  const zipEntries = fs.existsSync(RAW_ZIP)
    ? readZipEntries(RAW_ZIP).filter((e) => /_bldg_\d+_op\.gml$/i.test(e.name))
    : [];
  const sources = [
    ...folderFiles.map((f) => ({ kind: 'folder', name: path.relative(resolveProjectPath('.'), f), base: path.basename(f), scan: (sink, sem) => scanFileStream(f, sink, sem) })),
    ...zipEntries.map((e) => ({ kind: 'zip', name: 'CityGML_v4.zip::' + e.name, base: path.basename(e.name), scan: async (sink, sem) => scanText(extractEntry(RAW_ZIP, e).toString('utf-8'), sink, sem) })),
  ];

  // gml:id → ビットで畳んだ状態（600k 件ぶんのオブジェクトは持てない）
  //   bit0..3 = lod0/1/2/3 / bit4.. = ward 番号 / bit12.. = 採用元ファイル番号 / bit22 = 複数 copy あり
  const F = { L0: 1, L1: 2, L2: 4, L3: 8, WARD_SHIFT: 4, WARD_MASK: 0xff, SRC_SHIFT: 12, SRC_MASK: 0x3ff, DUP: 1 << 22 };
  const byId = new Map();
  const wardIds = [], wardIdx = new Map();
  const srcIds = [], srcIdx = new Map();
  const idxOf = (list, map, key) => { let i = map.get(key); if (i === undefined) { i = list.length; list.push(key); map.set(key, i); } return i; };
  const semTotals = {};
  const perFile = [];
  const posListTotals = new Map();     // gml:id → LOD2/3 の posList 数（索引にだけ入れる）
  const t0 = Date.now();
  let done = 0;
  for (const s of sources) {
    let n = 0, l2 = 0, l3 = 0, noId = 0;
    const si = idxOf(srcIds, srcIdx, s.base + (s.kind === 'zip' ? '@zip' : ''));
    await s.scan((r) => {
      if (!r) { noId++; return; }
      n++;
      if (r.l2) l2++;
      if (r.l3) l3++;
      let v = byId.get(r.id);
      const first = v === undefined;
      if (first) v = 0; else v |= F.DUP;
      const hadHigh = !first && (v & (F.L2 | F.L3));
      if (r.l0) v |= F.L0;
      if (r.l1) v |= F.L1;
      if (r.l2) v |= F.L2;
      if (r.l3) v |= F.L3;
      if (r.ward && !((v >> F.WARD_SHIFT) & F.WARD_MASK)) v |= (idxOf(wardIds, wardIdx, r.ward) + 1) << F.WARD_SHIFT;
      // 採用元は「最初にその建物を見つけた copy」、ただし上位 LOD を初めて持ってきた copy があればそちら
      if (first || ((r.l2 || r.l3) && !hadHigh)) {
        v = (v & ~(F.SRC_MASK << F.SRC_SHIFT)) | ((si + 1) << F.SRC_SHIFT);
        if (r.l2 || r.l3) posListTotals.set(r.id, r.posLists);
      }
      byId.set(r.id, v);
    }, semTotals);
    perFile.push({ source: s.name, kind: s.kind, buildings: n, lod2: l2, lod3: l3, withoutId: noId });
    done++;
    if (done % 25 === 0 || done === sources.length) {
      const mb = Math.round(process.memoryUsage().heapUsed / 1048576);
      console.log(`[lod-audit] ${done}/${sources.length} files  unique=${byId.size}  heap=${mb}MB  ${(Date.now() - t0) / 1000 | 0}s`);
    }
  }

  // ── 集計 ──
  const total = byId.size;
  const counts = { total, lod0: 0, lod1: 0, lod2: 0, lod3: 0, lod1Only: 0, lod2Available: 0, lod3Available: 0, noGeometry: 0, duplicatedAcrossCopies: 0 };
  const byWard = new Map();
  const index = {};       // LOD2/LOD3 を持つ建物だけ（geometry 生成の入力）
  for (const [id, v] of byId) {
    const l0 = !!(v & F.L0), l1 = !!(v & F.L1), l2 = !!(v & F.L2), l3 = !!(v & F.L3);
    if (l0) counts.lod0++;
    if (l1) counts.lod1++;
    if (l2) counts.lod2++;
    if (l3) counts.lod3++;
    if (v & F.DUP) counts.duplicatedAcrossCopies++;
    const highest = l3 ? 3 : l2 ? 2 : l1 ? 1 : l0 ? 0 : -1;
    if (highest === 3) counts.lod3Available++;
    else if (highest === 2) counts.lod2Available++;
    else if (highest === 1) counts.lod1Only++;
    else counts.noGeometry++;
    const wi = (v >> F.WARD_SHIFT) & F.WARD_MASK;
    const w = wi ? wardIds[wi - 1] : '(区名なし)';
    if (!byWard.has(w)) byWard.set(w, { ward: w, total: 0, lod1Only: 0, lod2: 0, lod3: 0, noGeometry: 0 });
    const wr = byWard.get(w);
    wr.total++;
    if (highest === 3) wr.lod3++; else if (highest === 2) wr.lod2++; else if (highest === 1) wr.lod1Only++; else wr.noGeometry++;
    if (highest >= 2) {
      const si = (v >> F.SRC_SHIFT) & F.SRC_MASK;
      index[id] = { lod: highest, src: si ? srcIds[si - 1] : null, ward: wi ? wardIds[wi - 1] : null, posLists: posListTotals.get(id) || 0 };
    }
  }

  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '34A',
    sources: { folderFiles: folderFiles.length, zipEntries: zipEntries.length, conflictCopiesSkipped: 'ファイル名/フォルダ名に -DESKTOP- を含むものは読まない' },
    counts,
    pct: {
      lod1Only: +(counts.lod1Only / total * 100).toFixed(2),
      lod2Available: +(counts.lod2Available / total * 100).toFixed(2),
      lod3Available: +(counts.lod3Available / total * 100).toFixed(2),
    },
    byWard: [...byWard.values()].sort((a, b) => (b.lod3 + b.lod2) - (a.lod3 + a.lod2) || b.total - a.total),
    semanticSurfaces: semTotals,
    perFile: perFile.sort((a, b) => (b.lod3 + b.lod2) - (a.lod3 + a.lod2)).slice(0, 60),
    filesWithHighLod: perFile.filter((f) => f.lod2 + f.lod3 > 0).length,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };
  fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
  fs.writeFileSync(OUT_REPORT, JSON.stringify(doc, null, 2));
  fs.mkdirSync(path.dirname(OUT_INDEX), { recursive: true });
  fs.writeFileSync(OUT_INDEX, JSON.stringify({ version: 1, generatedAt: doc.generatedAt, count: Object.keys(index).length, buildings: index }));
  return doc;
}

if (isMainModule(import.meta.url)) {
  main().then((d) => {
    console.log('[lod-audit] 全建物', d.counts.total);
    console.log('[lod-audit] LOD1 only', d.counts.lod1Only, '(' + d.pct.lod1Only + '%)');
    console.log('[lod-audit] LOD2 available', d.counts.lod2Available, '(' + d.pct.lod2Available + '%)');
    console.log('[lod-audit] LOD3 available', d.counts.lod3Available, '(' + d.pct.lod3Available + '%)');
    console.log('[lod-audit] 区別', JSON.stringify(d.byWard.slice(0, 8)));
    console.log('[lod-audit] semantic', JSON.stringify(d.semanticSurfaces));
    console.log('[lod-audit] out', OUT_REPORT, OUT_INDEX, d.elapsedSec + 's');
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
