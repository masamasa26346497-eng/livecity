#!/usr/bin/env node
// tools/audit/plateau-source-inventory.js
// [Mission 34D §3/§4/§5/§6/§7/§8] リポジトリ内の PLATEAU 建物 source をゼロベースで洗い直し、
//   CityGML の schema バリエーション（LOD タグの置き場所 / BuildingPart / XLink / surface semantics）を
//   建物単位で in数える。**geometry は作らない。在庫と構造の調査だけ。**
//
//   前回（34A）は「data/raw 配下の *_bldg_*.gml + CityGML_v4.zip」という決め打ちだったので、
//   ここではファイル名に頼らず中身で判定する（§4）。
//
//   除外: OneDrive の conflict copy（-DESKTOP-）/ derived・processed の出力 / public 配信物
//   ネットワーク取得はしない（§3）。
//
//   実行: node --max-old-space-size=8192 tools/audit/plateau-source-inventory.js
//   出力: data/reports/plateau-source-inventory.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { readZipEntries, extractEntry } from '../lib/zip-reader.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const INV = {
  scanRoots: [P('data')],
  out: P('data', 'reports', 'plateau-source-inventory.json'),
};
// raw source として数えないもの（§3）
export const EXCLUDE_DIR = /(^|[\\/])(processed|derived[^\\/]*|reports|manifests|node_modules|\.git)([\\/]|$)/i;
export const EXCLUDE_NAME = /-DESKTOP-|\.tmp$|~\$/i;
const BUILDING_MARKER = '<bldg:Building';
const CITYMODEL_MARKER = 'CityModel';

// §5 LOD geometry が入りうる要素
export const LOD_ELEMENTS = {
  lod1: ['lod1Solid', 'lod1MultiSurface', 'lod1Geometry', 'lod1TerrainIntersection'],
  lod2: ['lod2Solid', 'lod2MultiSurface', 'lod2Geometry'],
  lod3: ['lod3Solid', 'lod3MultiSurface', 'lod3Geometry'],
  lod0: ['lod0FootPrint', 'lod0RoofEdge'],
};
// §8 surface semantics
export const SEMANTIC_ELEMENTS = ['RoofSurface', 'WallSurface', 'GroundSurface', 'ClosureSurface',
  'OuterFloorSurface', 'OuterCeilingSurface', 'Window', 'Door', 'BuildingInstallation'];

/** V8 の SlicedString 対策（34A で 6GB OOM を踏んだ）。Map のキーにする文字列は必ず平坦化する。 */
export const detach = (s) => Buffer.from(s, 'utf-8').toString('utf-8');
export function countOf(s, needle) {
  let c = 0, i = s.indexOf(needle);
  while (i >= 0) { c++; i = s.indexOf(needle, i + 1); }
  return c;
}
/** `<bldg:Building ` の開始位置（BuildingPart は含めない）。 */
export function buildingStarts(text) {
  const out = [];
  let i = text.indexOf(BUILDING_MARKER);
  while (i >= 0) {
    const nx = text.charCodeAt(i + BUILDING_MARKER.length);
    // '<bldg:Building ' / '<bldg:Building>' だけを取る（BuildingPart / BuildingInstallation を除く）
    if (nx === 32 || nx === 62 || nx === 10 || nx === 13 || nx === 9) out.push(i);
    i = text.indexOf(BUILDING_MARKER, i + 1);
  }
  return out;
}

/**
 * 建物 1 件ぶんのテキストを読み、LOD タグがどこに出ているかを分類する（§5/§6/§7/§8）。
 * 返す形:
 *   { lodDirect: {lod1,lod2,lod3}, lodInPart: {...}, lodInBounded: {...},
 *     parts, xlinkHrefs, semantics: {RoofSurface: n, ...} }
 */
export function analyzeBuilding(seg) {
  const parts = countOf(seg, '<bldg:BuildingPart');
  // BuildingPart の範囲を切り出す（consistsOfBuildingPart の中身）
  const partRanges = [];
  let pi = seg.indexOf('<bldg:BuildingPart');
  while (pi >= 0) {
    const end = seg.indexOf('</bldg:BuildingPart>', pi);
    partRanges.push([pi, end >= 0 ? end + 20 : seg.length]);
    pi = seg.indexOf('<bldg:BuildingPart', end >= 0 ? end : pi + 1);
  }
  const inPart = (idx) => partRanges.some(([a, b]) => idx >= a && idx < b);
  // boundedBy の範囲
  const boundedRanges = [];
  let bi = seg.indexOf('<bldg:boundedBy');
  while (bi >= 0) {
    const end = seg.indexOf('</bldg:boundedBy>', bi);
    boundedRanges.push([bi, end >= 0 ? end + 17 : seg.length]);
    bi = seg.indexOf('<bldg:boundedBy', end >= 0 ? end : bi + 1);
  }
  const inBounded = (idx) => boundedRanges.some(([a, b]) => idx >= a && idx < b);

  const res = {
    lodDirect: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
    lodInPart: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
    lodInBounded: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
    elements: {},                 // 'lod2MultiSurface' → 件数
    parts, xlinkHrefs: countOf(seg, 'xlink:href'),
    posLists: countOf(seg, '<gml:posList'),
    semantics: {},
  };
  for (const [lod, names] of Object.entries(LOD_ELEMENTS)) {
    for (const nm of names) {
      const tag = '<bldg:' + nm;
      let i = seg.indexOf(tag);
      while (i >= 0) {
        res.elements[nm] = (res.elements[nm] || 0) + 1;
        if (inPart(i)) res.lodInPart[lod]++;
        else if (inBounded(i)) res.lodInBounded[lod]++;
        else res.lodDirect[lod]++;
        i = seg.indexOf(tag, i + 1);
      }
    }
  }
  for (const nm of SEMANTIC_ELEMENTS) {
    const n = countOf(seg, '<bldg:' + nm);
    if (n) res.semantics[nm] = n;
  }
  return res;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (EXCLUDE_NAME.test(e.name)) continue;
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.test(p)) continue;
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

/**
 * ファイルが CityGML の **建物** データか（名前ではなく中身で判定 §4）。
 * 注意: 「CityModel かつ bldg という語を含む」では判定できない。
 *   道路（tran）の CityGML も XML ヘッダで bldg 名前空間を宣言しているため、
 *   288 本の tran ファイルまで建物 source として拾ってしまう（実測で 1,642 件に膨張した）。
 *   実際に `<bldg:Building` の開始タグがあることを条件にする。
 */
//   逆に、先頭 64KB だけ見ると「ヘッダ（範囲・appearance 等）が長い建物ファイル」を取りこぼす
//   （実測で 205 → 192 に減った）。PLATEAU の命名規則 `_bldg_` も併用して両側の取りこぼしを防ぐ。
export const HEAD_BYTES = 65536;
export const BLDG_NAME_RE = /_bldg_/i;
export function looksLikeBuildingCityGml(head, name) {
  if (name && BLDG_NAME_RE.test(name)) return true;         // PLATEAU の建物ファイル命名
  const i = head ? head.indexOf(BUILDING_MARKER) : -1;
  if (i < 0) return false;
  const nx = head.charCodeAt(i + BUILDING_MARKER.length);
  return nx === 32 || nx === 62 || nx === 10 || nx === 13 || nx === 9;   // Building / Building> のみ（Part 等は除く）
}

export function run() {
  const t0 = Date.now();
  const files = [];
  for (const root of INV.scanRoots) {
    for (const p of walk(root)) {
      const ext = path.extname(p).toLowerCase();
      if (ext === '.gml' || ext === '.xml' || ext === '.zip') files.push(p);
    }
  }
  console.log('[inv] 候補ファイル', files.length);

  const sources = [];          // 実際に建物 CityGML だったもの
  const skipped = { notBuilding: 0, unreadable: 0, zipNoBuilding: 0 };
  const zipArchives = [];
  for (const p of files) {
    const ext = path.extname(p).toLowerCase();
    if (ext === '.zip') {
      let entries;
      try { entries = readZipEntries(p); } catch { skipped.unreadable++; continue; }
      const cands = entries.filter((e) => /\.(gml|xml)$/i.test(e.name) && !EXCLUDE_NAME.test(e.name));
      let found = 0;
      for (const e of cands) {
        let buf;
        try { buf = extractEntry(p, e); } catch { continue; }
        const head = buf.slice(0, HEAD_BYTES).toString('utf-8');
        if (!looksLikeBuildingCityGml(head, e.name)) continue;
        found++;
        sources.push({ kind: 'zip', archive: path.relative(resolveProjectPath('.'), p).replace(/\\/g, '/'),
          name: e.name, bytes: buf.length, read: () => extractEntry(p, e).toString('utf-8') });
      }
      zipArchives.push({ archive: path.relative(resolveProjectPath('.'), p).replace(/\\/g, '/'), entries: entries.length, buildingEntries: found });
      if (!found) skipped.zipNoBuilding++;
      continue;
    }
    let st;
    try { st = fs.statSync(p); } catch { skipped.unreadable++; continue; }
    let head;
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf-8');
    } catch { skipped.unreadable++; continue; }
    if (!looksLikeBuildingCityGml(head, path.basename(p))) { skipped.notBuilding++; continue; }
    sources.push({ kind: 'file', path: path.relative(resolveProjectPath('.'), p).replace(/\\/g, '/'),
      bytes: st.size, mtime: st.mtimeMs, read: () => fs.readFileSync(p, 'utf-8') });
  }
  console.log('[inv] 建物 CityGML', sources.length, '（file', sources.filter((s) => s.kind === 'file').length,
    '/ zip entry', sources.filter((s) => s.kind === 'zip').length, '）', JSON.stringify(skipped));

  // ── 建物単位で schema を数える ─────────────────────────────────────────
  const perSource = [];
  const totals = {
    buildings: 0, uniqueIds: 0,
    lodDirect: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
    lodInPart: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
    lodInBounded: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
    elements: {}, semantics: {},
    withBuildingPart: 0, buildingPartCount: 0,
    withXlink: 0, xlinkCount: 0,
    // §6 本体に LOD2/3 が無いのに BuildingPart 側にあるもの（見落としの本命）
    highLodOnlyInPart: 0,
    // §7 geometry が xlink 参照だけで posList を持たないもの
    noPosList: 0,
  };
  const idBits = new Map();     // gml:id → bitfield（1=lod1 2=lod2 4=lod3 8=partLod2 16=partLod3）
  const ID_RE = /gml:id="([^"]+)"/;

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    let text;
    try { text = s.read(); } catch (e) { skipped.unreadable++; continue; }
    const starts = buildingStarts(text);
    const agg = { buildings: starts.length, lodDirect: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
      lodInPart: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 }, lodInBounded: { lod0: 0, lod1: 0, lod2: 0, lod3: 0 },
      elements: {}, semantics: {}, withBuildingPart: 0, withXlink: 0, highLodOnlyInPart: 0, noPosList: 0 };
    for (let k = 0; k < starts.length; k++) {
      const seg = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length);
      const a = analyzeBuilding(seg);
      totals.buildings++;
      agg.buildings = starts.length;
      for (const g of ['lodDirect', 'lodInPart', 'lodInBounded']) {
        for (const lod of ['lod0', 'lod1', 'lod2', 'lod3']) { totals[g][lod] += a[g][lod]; agg[g][lod] += a[g][lod]; }
      }
      for (const [k2, v] of Object.entries(a.elements)) { totals.elements[k2] = (totals.elements[k2] || 0) + v; agg.elements[k2] = (agg.elements[k2] || 0) + v; }
      for (const [k2, v] of Object.entries(a.semantics)) { totals.semantics[k2] = (totals.semantics[k2] || 0) + v; agg.semantics[k2] = (agg.semantics[k2] || 0) + v; }
      if (a.parts) { totals.withBuildingPart++; agg.withBuildingPart++; totals.buildingPartCount += a.parts; }
      if (a.xlinkHrefs) { totals.withXlink++; agg.withXlink++; totals.xlinkCount += a.xlinkHrefs; }
      if (!a.posLists) { totals.noPosList++; agg.noPosList++; }
      const directHigh = a.lodDirect.lod2 + a.lodDirect.lod3 + a.lodInBounded.lod2 + a.lodInBounded.lod3;
      const partHigh = a.lodInPart.lod2 + a.lodInPart.lod3;
      if (!directHigh && partHigh) { totals.highLodOnlyInPart++; agg.highLodOnlyInPart++; }
      // gml:id の bitfield（copy を跨いだ max 合成）
      const m = ID_RE.exec(seg);
      if (m) {
        const id = detach(m[1]);
        let bits = idBits.get(id) || 0;
        if (a.lodDirect.lod1 || a.lodInPart.lod1) bits |= 1;
        if (a.lodDirect.lod2 || a.lodInBounded.lod2) bits |= 2;
        if (a.lodDirect.lod3 || a.lodInBounded.lod3) bits |= 4;
        if (a.lodInPart.lod2) bits |= 8;
        if (a.lodInPart.lod3) bits |= 16;
        idBits.set(id, bits);
      }
    }
    text = null;
    perSource.push({ kind: s.kind, path: s.path || (s.archive + '::' + s.name), bytes: s.bytes, ...agg });
    if ((i + 1) % 50 === 0) console.log('  …' + (i + 1) + '/' + sources.length + ' 建物 ' + totals.buildings + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
  }
  totals.uniqueIds = idBits.size;

  // gml:id 単位の集計（copy を跨いだ max 合成）
  const byId = { lod1: 0, lod2: 0, lod3: 0, partLod2: 0, partLod3: 0, highLodAny: 0, highLodOnlyInPart: 0 };
  for (const bits of idBits.values()) {
    if (bits & 1) byId.lod1++;
    if (bits & 2) byId.lod2++;
    if (bits & 4) byId.lod3++;
    if (bits & 8) byId.partLod2++;
    if (bits & 16) byId.partLod3++;
    const direct = (bits & 2) || (bits & 4);
    const part = (bits & 8) || (bits & 16);
    if (direct || part) byId.highLodAny++;
    if (!direct && part) byId.highLodOnlyInPart++;
  }

  const out = { version: 1, generatedAt: new Date().toISOString(), missionId: '34D',
    scan: { candidateFiles: files.length, buildingSources: sources.length,
      fileSources: sources.filter((s) => s.kind === 'file').length,
      zipEntrySources: sources.filter((s) => s.kind === 'zip').length, skipped },
    zipArchives, totals, byId,
    perSource: perSource.sort((a, b) => b.buildings - a.buildings),
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(INV.out), { recursive: true });
  fs.writeFileSync(INV.out, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  const o = run();
  console.log('[inv] 建物セグメント', o.totals.buildings, '/ 一意 gml:id', o.totals.uniqueIds);
  console.log('[inv] LOD 要素', JSON.stringify(o.totals.elements));
  console.log('[inv] 置き場所 direct/part/bounded', JSON.stringify({ d: o.totals.lodDirect, p: o.totals.lodInPart, b: o.totals.lodInBounded }));
  console.log('[inv] BuildingPart を持つ建物', o.totals.withBuildingPart, '/ part 総数', o.totals.buildingPartCount);
  console.log('[inv] xlink を持つ建物', o.totals.withXlink, '/ posList 無し', o.totals.noPosList);
  console.log('[inv] ★ 本体に無く BuildingPart にだけ高 LOD', o.totals.highLodOnlyInPart);
  console.log('[inv] id 単位', JSON.stringify(o.byId));
  console.log('[inv] out', INV.out);
}
