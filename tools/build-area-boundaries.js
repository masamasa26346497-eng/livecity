#!/usr/bin/env node
// tools/build-area-boundaries.js
// [Mission 35K §10/§11/§12] 町名クリックで出す「範囲」を配信できる形にまとめる。
//
//   §12 のとおり **既存の境界データだけ** を使い、無い区について推測ポリゴンを作らない。
//   実際に手元にあるのは 2 つだけ:
//     1. 町丁目（TOWN_POLYGONS・住吉 / 東住吉 / 平野 の 3 区）… 出典未確認の legacy データ
//     2. 区界（N03 行政区域・24 区すべて）… 国土数値情報の正式データ
//   町丁目が無い区では **区界へ落とす**。区界は実在する正式な境界なので、
//   「町丁目の境界を作った」ことにはならない（UI 側でどちらを出しているか明示する）。
//
//   出力: public/map-data/osaka-city/derived/area-boundaries.json
//         data/processed/osaka-city/derived/area-boundaries.json
//         data/reports/area-boundaries.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { classifyPointToWard } from './lib/point-in-polygon.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  wards: P('data', 'processed', 'osaka-city', 'boundaries', 'administrative-boundaries.json'),
  wardPolys: P('data', 'processed', 'osaka-city', 'boundaries', 'ward-classification-polygons.json'),
  plateauTowns: P('data', 'processed', 'osaka-city', 'derived', 'plateau-place-labels.json'),
  placeLabels: P('public', 'map-data', 'osaka-city', 'labels', 'place-labels.json'),
};
export const OUT_FILES = [
  P('public', 'map-data', 'osaka-city', 'derived', 'area-boundaries.json'),
  P('data', 'processed', 'osaka-city', 'derived', 'area-boundaries.json'),
];
export const REPORT = P('data', 'reports', 'area-boundaries.json');

/** 町丁目名から「丁目」を落とした基準地名（33A/33C と同じ規則）。 */
export function baseTownName(name) {
  return String(name).replace(/(?:[一二三四五六七八九十百]+|[0-9０-９]+)\s*(?:丁目|丁|条)$/, '').trim();
}
/** 「住吉区我孫子4丁目」→ { ward: '住吉区', town: '我孫子4丁目', base: '我孫子' } */
export function splitTownKey(key) {
  const m = String(key).match(/^(.+?区)(.+)$/);
  if (!m) return null;
  return { ward: m[1], town: m[2], base: baseTownName(m[2]) };
}

/** リング列から bbox。 */
export function bboxOfRings(rings) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) continue;
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX: +minX.toFixed(2), maxX: +maxX.toFixed(2), minZ: +minZ.toFixed(2), maxZ: +maxZ.toFixed(2) };
}
/** bbox の中心と対角長。 */
export function bboxInfo(b) {
  if (!b) return null;
  return { cx: +((b.minX + b.maxX) / 2).toFixed(2), cz: +((b.minZ + b.maxZ) / 2).toFixed(2),
    w: +(b.maxX - b.minX).toFixed(2), h: +(b.maxZ - b.minZ).toFixed(2),
    diag: +Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ).toFixed(2) };
}

/** HTML に埋まっている TOWN_POLYGONS を読む（新しい座標は作らない）。 */
export function readTownPolygons(html) {
  const key = 'const TOWN_POLYGONS = ';
  const i = html.indexOf(key);
  if (i < 0) return {};
  const start = i + key.length;
  // 対応する閉じ括弧までを数える（文字列内の括弧は出てこないデータなので単純な深さ数えで足りる）
  let depth = 0, end = -1;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  if (end < 0) return {};
  try { return JSON.parse(html.slice(start, end)); } catch { return {}; }
}

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

export function run() {
  const t0 = Date.now();
  const html = fs.readFileSync(SRC.html, 'utf-8');
  const townPolys = readTownPolygons(html);
  const wardDoc = rj(SRC.wards) || { records: [] };
  const plateau = rj(SRC.plateauTowns) || { towns: [] };
  const places = rj(SRC.placeLabels) || { places: [] };

  // ── 1. 区界（24 区・正式データ）──────────────────────────────────
  const wards = [];
  for (const r of (wardDoc.records || [])) {
    const rings = (r.geometry && r.geometry.rings) || [];
    if (!rings.length) continue;
    const bbox = bboxOfRings(rings);
    wards.push({ id: 'ward:' + r.wardId, kind: 'ward', name: r.wardName, wardId: r.wardId,
      wardName: r.wardName, rings, bbox, ...bboxInfo(bbox),
      boundarySource: 'n03-official', boundaryGranularity: 'ward' });
  }

  // ── 2. 町丁目（3 区のみ・legacy）─────────────────────────────────
  const towns = [];
  const wardNameToId = new Map(wards.map((w) => [w.wardName, w.wardId]));
  for (const [key, rings] of Object.entries(townPolys)) {
    if (!Array.isArray(rings) || !rings.length) continue;
    const sp = splitTownKey(key);
    if (!sp) continue;
    const bbox = bboxOfRings(rings);
    if (!bbox) continue;
    towns.push({ id: 'town:' + key, kind: 'town', name: sp.town, baseName: sp.base,
      wardName: sp.ward, wardId: wardNameToId.get(sp.ward) || null,
      rings, bbox, ...bboxInfo(bbox),
      boundarySource: 'legacy-unverified', boundaryGranularity: 'chochome' });
  }

  // ── 3. 基準地名（「梅田」など）→ 町丁目の束ね（§11）───────────────
  //   梅田一〜三丁目のように複数の丁目があるときは、その **union bbox** を持つ。
  //   新しい町界は作らない（輪郭は各丁目のリングをそのまま並べる）。
  const byBase = new Map();
  for (const t of towns) {
    const k = t.wardName + '|' + t.baseName;
    if (!byBase.has(k)) byBase.set(k, []);
    byBase.get(k).push(t);
  }
  const groups = [];
  for (const [k, list] of byBase) {
    if (list.length < 2) continue;              // 1 つだけなら町丁目そのもの
    const rings = list.flatMap((t) => t.rings);
    const bbox = bboxOfRings(rings);
    const [wardName, baseName] = k.split('|');
    groups.push({ id: 'towngroup:' + k, kind: 'town-group', name: baseName,
      wardName, wardId: wardNameToId.get(wardName) || null,
      memberIds: list.map((t) => t.id), memberCount: list.length,
      rings, bbox, ...bboxInfo(bbox),
      boundarySource: 'legacy-unverified', boundaryGranularity: 'chochome-union' });
  }

  // ── 4. ラベル → 範囲 の対応表（§10/§11）─────────────────────────
  //   地名ラベル（872 + PLATEAU 町丁目）から引けるようにする。
  //   町丁目のリングがあればそれ、無ければ区界へ落とす。
  const townByWardBase = new Map();
  for (const g of groups) townByWardBase.set(g.wardName + '|' + g.name, g.id);
  for (const t of towns) {
    const k = t.wardName + '|' + t.baseName;
    if (!townByWardBase.has(k)) townByWardBase.set(k, t.id);
    townByWardBase.set(t.wardName + '|' + t.name, t.id);   // 丁目そのものの名前でも引ける
  }
  const wardIdToName = new Map(wards.map((w) => [w.wardId, w.wardName]));
  const labelMap = {};
  let resolvedTown = 0, resolvedWard = 0, unresolved = 0;
  // ラベルの 4 割は ward を持っていない。**点から正式な区ポリゴンで引く**（推測ではない）。
  const wardPolys = (rj(SRC.wardPolys) || {}).wards || [];
  for (const p of (places.places || [])) {
    let wardName = p.ward || (p.wardId ? wardIdToName.get(p.wardId) : null);
    let wardIdHit = p.wardId || null;
    if (!wardName && wardPolys.length) {
      const r = classifyPointToWard(p.x, p.z, wardPolys);
      if (r && r.wardId) { wardIdHit = r.wardId; wardName = wardIdToName.get(r.wardId) || null; }
    }
    let areaId = null;
    if (wardName) {
      areaId = townByWardBase.get(wardName + '|' + p.name)
        || townByWardBase.get(wardName + '|' + baseTownName(p.name)) || null;
    }
    if (!areaId && !wardName) {
      // 区が分からない地名（市域外など）は引けない
      unresolved++; continue;
    }
    // §15 ズームは「その地名の広がり」に合わせる。区界へ落ちたときでも、
    //   クリックした場所の周りが見える距離になるよう、地名自身の広がりを添える。
    const spread = Number.isFinite(p.spreadM) ? Math.max(180, Math.min(2200, p.spreadM)) : null;
    const fitBbox = spread ? { minX: +(p.x - spread).toFixed(1), maxX: +(p.x + spread).toFixed(1),
      minZ: +(p.z - spread).toFixed(1), maxZ: +(p.z + spread).toFixed(1) } : null;
    if (areaId) resolvedTown++;
    else {
      const wid = wardIdHit || [...wardIdToName.entries()].find(([, n]) => n === wardName)?.[0];
      areaId = wid ? 'ward:' + wid : null;
      if (areaId) resolvedWard++; else { unresolved++; continue; }
    }
    labelMap[p.id] = { areaId, name: p.name, wardName: wardName || null, fitBbox };
  }

  const areas = [...towns, ...groups, ...wards];
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35K',
    coordinateConvention: 'znorth-neg-v1',
    note: '町丁目の境界は既存データがある 3 区のみ。無い区は区界（N03 正式データ）へ落とす。'
      + '推測した町界は作っていない（§12）。',
    counts: { towns: towns.length, townGroups: groups.length, wards: wards.length,
      labelsToTown: resolvedTown, labelsToWard: resolvedWard, labelsUnresolved: unresolved },
    townWards: [...new Set(towns.map((t) => t.wardName))],
    areas, labelMap,
  };
  const text = JSON.stringify(doc);
  for (const f of OUT_FILES) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  const report = { version: 1, generatedAt: doc.generatedAt, missionId: '35K',
    counts: doc.counts, townWards: doc.townWards,
    plateauTownCount: (plateau.towns || []).length,
    sampleTown: towns[0] ? { id: towns[0].id, name: towns[0].name, bbox: towns[0].bbox } : null,
    sampleGroup: groups[0] ? { id: groups[0].id, name: groups[0].name, memberCount: groups[0].memberCount } : null,
    elapsedMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  return { doc, report };
}

if (isMainModule(import.meta.url)) {
  const { doc } = run();
  console.log('[area] 町丁目', doc.counts.towns, '（', doc.townWards.join(' '), '）/ 基準地名の束ね', doc.counts.townGroups, '/ 区界', doc.counts.wards);
  console.log('[area] ラベル →', doc.counts.labelsToTown, '件が町丁目 /', doc.counts.labelsToWard, '件が区界 / 引けず', doc.counts.labelsUnresolved);
  console.log('[area] out', OUT_FILES[0]);
}
