#!/usr/bin/env node
// Mission 35L: e-Stat 2020 小地域（町丁・字等）境界を Live City の町名クリック用データへ変換する。
// 35K の 3区 legacy TOWN_POLYGONS / 21区 ward fallback を、24区の公式統計境界へ置き換える。
// 建物・道路・鉄道・水域の geometry は一切変更しない。

import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries, extractEntry } from './lib/zip-reader.js';
import { shapefileToFeatureCollection } from './lib/shapefile-polygon.js';
import { convertGeometryToRings } from './lib/geojson-geometry.js';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { baseTownName, bboxOfRings, bboxInfo } from './build-area-boundaries.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC_ZIP = P('data', 'raw', 'osaka-city', 'boundaries', 'estat-2020-town-boundaries-osaka.zip');
export const SRC_META = P('data', 'raw', 'osaka-city', 'boundaries', 'estat-2020-town-boundaries-osaka.meta.json');
export const REGISTRY = P('config', 'wards', 'registry.json');
export const AREA_CONFIG = P('config', 'areas', 'osaka-city.json');
export const WARD_SOURCE = P('data', 'processed', 'osaka-city', 'boundaries', 'administrative-boundaries.json');
export const PLACE_LABELS = P('public', 'map-data', 'osaka-city', 'labels', 'place-labels.json');
export const OUT_MASTER = P('data', 'processed', 'osaka-city', 'boundaries', 'town-boundaries-2020.json');
export const OUT_DERIVED = P('public', 'map-data', 'osaka-city', 'derived', 'area-boundaries.json');
export const OUT_DERIVED_LOCAL = P('data', 'processed', 'osaka-city', 'derived', 'area-boundaries.json');
export const OUT_REPORT = P('data', 'reports', 'town-boundaries-35l.json');

const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const clean = (v) => String(v ?? '').trim();

function findZipEntry(entries, ext) {
  const candidates = entries.filter((e) => e.name.toLowerCase().endsWith(ext));
  const preferred = candidates.find((e) => /(^|\/)r2ka27\./i.test(e.name));
  return preferred || candidates[0] || null;
}

function toZNorthNeg(rings) {
  return rings.map((ring) => ring.map(([x, z]) => [x, -z]));
}

function wardNameFromCityName(cityName) {
  const m = clean(cityName).match(/^大阪市(.+区)$/);
  return m ? m[1] : null;
}

function pickProp(props, ...keys) {
  for (const k of keys) if (props[k] != null && clean(props[k])) return clean(props[k]);
  return '';
}

export function featureToTown(feature, context) {
  const props = feature.properties || {};
  const keyCode = pickProp(props, 'KEY_CODE', 'KEYCODE');
  const sName = pickProp(props, 'S_NAME', 'SNAME');
  const cityName = pickProp(props, 'CITY_NAME', 'CITYNAME');
  if (!keyCode || !sName || !feature.geometry) return null;
  const municipalityCode = keyCode.slice(0, 5);
  const wardDef = context.wardByCode.get(municipalityCode);
  if (!wardDef) return null; // 大阪府内の大阪市24区以外
  const wardNameByAttr = wardNameFromCityName(cityName);
  if (wardNameByAttr && wardNameByAttr !== wardDef.name) {
    throw new Error(`ward mismatch KEY_CODE=${keyCode}: registry=${wardDef.name}, CITY_NAME=${cityName}`);
  }
  const rings = toZNorthNeg(convertGeometryToRings(feature.geometry, context.projection));
  const bbox = bboxOfRings(rings);
  if (!bbox) return null;
  const townName = sName;
  return {
    id: `town:${keyCode}`,
    kind: 'town',
    keyCode,
    municipalityCode,
    chochoCode: keyCode.slice(5),
    name: townName,
    baseName: baseTownName(townName),
    wardId: wardDef.id,
    wardName: wardDef.name,
    rings,
    bbox,
    ...bboxInfo(bbox),
    boundarySource: 'estat-census-2020-official',
    boundaryGranularity: 'chochome',
    referenceDate: '2020-10-01',
    officialBoundary: true,
  };
}

/**
 * [Mission 35L §8] e-Stat は 1 つの町丁目が飛び地に分かれている場合、
 * **同じ KEY_CODE を持つ別レコード**として収録する（住之江区 南港南 = 4 レコード）。
 * そのまま並べると id（town:KEY_CODE）が重複し、ラベルから範囲を引けなくなるうえ、
 * クリックしても飛び地の 1 つしか選べない。KEY_CODE 単位でリングをまとめて 1 件にする。
 * 形は足すだけで、新しい境界は作らない。
 */
export function mergeTownsByKeyCode(towns) {
  const byKey = new Map();
  for (const t of towns) {
    const cur = byKey.get(t.keyCode);
    if (!cur) { byKey.set(t.keyCode, { ...t, rings: [...t.rings], partCount: 1 }); continue; }
    cur.rings.push(...t.rings);
    cur.partCount++;
  }
  const merged = [];
  for (const t of byKey.values()) {
    if (t.partCount > 1) {
      const bbox = bboxOfRings(t.rings);
      Object.assign(t, { bbox, ...bboxInfo(bbox) });
    }
    merged.push(t);
  }
  return merged;
}

export function buildTownGroups(towns) {
  const byBase = new Map();
  for (const t of towns) {
    const k = `${t.wardName}|${t.baseName}`;
    if (!byBase.has(k)) byBase.set(k, []);
    byBase.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of byBase) {
    if (list.length < 2) continue;
    const rings = list.flatMap((t) => t.rings);
    const bbox = bboxOfRings(rings);
    const [wardName, name] = k.split('|');
    out.push({
      id: `towngroup:${k}`,
      kind: 'town-group',
      name,
      wardName,
      wardId: list[0].wardId,
      memberIds: list.map((t) => t.id),
      memberCount: list.length,
      rings,
      bbox,
      ...bboxInfo(bbox),
      boundarySource: 'estat-census-2020-official',
      boundaryGranularity: 'chochome-union',
      referenceDate: '2020-10-01',
      officialBoundary: true,
    });
  }
  return out;
}

function wardAreas(wardDoc) {
  return (wardDoc.records || []).map((r) => {
    const rings = r.geometry?.rings || [];
    const bbox = bboxOfRings(rings);
    return {
      id: `ward:${r.wardId}`, kind: 'ward', name: r.wardName,
      wardId: r.wardId, wardName: r.wardName, rings, bbox, ...bboxInfo(bbox),
      boundarySource: 'n03-official', boundaryGranularity: 'ward', officialBoundary: true,
    };
  }).filter((x) => x.rings.length && x.bbox);
}

/**
 * [Mission 35L] 地名ラベル（OSM）と公式町丁目名の表記ゆれを吸収する。
 *   - 「ヶ」と「ケ」: OSM は 照ヶ丘矢田 / e-Stat は 照ケ丘矢田。7 件がこれで引けなかった。
 * ここでやるのは **突き合わせ用のキーを揃えること** だけで、表示名は元のまま変えない。
 */
export function normalizeTownKey(name) {
  return String(name ?? '').trim().replace(/ヶ/g, 'ケ');
}

export function buildLabelMap({ places, towns, groups, wards }) {
  const wardById = new Map(wards.map((w) => [w.wardId, w]));
  const byExact = new Map();
  const byBase = new Map();
  const K = (ward, name) => `${ward}|${normalizeTownKey(name)}`;
  for (const t of towns) {
    byExact.set(K(t.wardName, t.name), t.id);
    const k = K(t.wardName, t.baseName);
    if (!byBase.has(k)) byBase.set(k, t.id);
  }
  for (const g of groups) byBase.set(K(g.wardName, g.name), g.id);

  const labelMap = {};
  let town = 0, ward = 0, unresolved = 0;
  for (const p of places) {
    let wardName = p.ward || null;
    let wardId = p.wardId || null;
    if (!wardName && wardId && wardById.has(wardId)) wardName = wardById.get(wardId).wardName;
    if (!wardName) { unresolved++; continue; }
    // 1) そのままの名前 2) 「丁目」を落とした基準地名 3) ラベル名そのものを基準地名として
    //   3) が要るのは、baseTownName が「十八条」「九条」の **末尾の「条」を丁目の数え方**と
    //   みなして削ってしまうため（十八条→"" / 西九条→"西"）。地名側は既に基準地名なので、
    //   そのまま基準地名の表として引く。baseTownName 自体は 35K の束ね方を変えないよう触らない。
    const areaId = byExact.get(K(wardName, p.name))
      || byBase.get(K(wardName, baseTownName(p.name)))
      || byBase.get(K(wardName, p.name))
      || null;
    if (areaId) {
      labelMap[p.id] = { areaId, name: p.name, wardName, fitBbox: null };
      town++;
      continue;
    }
    const w = wards.find((x) => x.wardName === wardName || x.wardId === wardId);
    if (w) {
      labelMap[p.id] = { areaId: w.id, name: p.name, wardName: w.wardName, fitBbox: null, fallback: 'ward' };
      ward++;
    } else unresolved++;
  }
  return { labelMap, counts: { labelsToTown: town, labelsToWard: ward, labelsUnresolved: unresolved } };
}

export function run() {
  const started = Date.now();
  if (!fs.existsSync(SRC_ZIP)) throw new Error(`e-Stat ZIPがありません: ${SRC_ZIP}\n先に node tools/download/estat-town-boundaries.js を実行してください。`);
  const registry = rj(REGISTRY);
  const area = rj(AREA_CONFIG);
  const wardByCode = new Map(registry.wards.map((w) => [w.code, w]));

  const entries = readZipEntries(SRC_ZIP);
  const shpEntry = findZipEntry(entries, '.shp');
  const dbfEntry = findZipEntry(entries, '.dbf');
  if (!shpEntry || !dbfEntry) throw new Error('ZIP内に .shp / .dbf が見つかりません');
  const fc = shapefileToFeatureCollection(extractEntry(SRC_ZIP, shpEntry), extractEntry(SRC_ZIP, dbfEntry), { encoding: 'shift_jis' });

  const rawTowns = [];
  for (const f of fc.features) {
    const t = featureToTown(f, { wardByCode, projection: area.projection });
    if (t) rawTowns.push(t);
  }
  const towns = mergeTownsByKeyCode(rawTowns);
  const wardSet = new Set(towns.map((t) => t.wardId));
  const missingWards = registry.wards.filter((w) => !wardSet.has(w.id)).map((w) => w.name);
  if (missingWards.length) throw new Error(`町丁目境界がない区: ${missingWards.join('、')}`);

  const groups = buildTownGroups(towns);
  const wards = wardAreas(rj(WARD_SOURCE));
  const places = (rj(PLACE_LABELS).places || []);
  const mapped = buildLabelMap({ places, towns, groups, wards });
  const sourceMeta = fs.existsSync(SRC_META) ? rj(SRC_META) : null;

  const master = {
    version: 1, missionId: '35L', referenceDate: '2020-10-01', coordinateConvention: 'znorth-neg-v1',
    source: 'e-Stat 令和2年国勢調査 小地域（町丁・字等）境界データ', sourceMeta,
    towns,
  };
  const derived = {
    version: 2, missionId: '35L', generatedAt: new Date().toISOString(), coordinateConvention: 'znorth-neg-v1',
    referenceDate: '2020-10-01',
    note: '24区の町丁・字等境界はe-Stat 2020国勢調査統計境界。法的な住居表示境界と常に一致する保証はない。町丁目が一致しないラベルのみN03区界へfallback。',
    counts: { towns: towns.length, townGroups: groups.length, wards: wards.length, ...mapped.counts },
    // [Mission 35L] 35K と同じ **区名** で書く（wardSet は区 id なので、そのまま出すと
    //   既存の読み手（validator / HTML の debug）が「町丁目のある区」を引けなくなる）。
    townWards: [...new Set(towns.map((t) => t.wardName))].sort(),
    areas: [...towns, ...groups, ...wards],
    labelMap: mapped.labelMap,
  };
  const report = {
    version: 1, missionId: '35L', generatedAt: derived.generatedAt,
    shpEntry: shpEntry.name, dbfEntry: dbfEntry.name, dbfFields: fc._dbfFields,
    counts: derived.counts, wardCount: wardSet.size, missingWards,
    officialTownBoundaryCount: towns.length,
    legacyBoundaryCount: 0,
    inventedBoundary: 0,
    elapsedMs: Date.now() - started,
  };

  for (const [file, value, pretty] of [[OUT_MASTER, master, false], [OUT_DERIVED, derived, false], [OUT_DERIVED_LOCAL, derived, false], [OUT_REPORT, report, true]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, pretty ? 2 : 0));
  }
  console.log(`[35L] official towns=${towns.length} groups=${groups.length} wards=${wardSet.size}`);
  console.log(`[35L] labels town=${mapped.counts.labelsToTown} wardFallback=${mapped.counts.labelsToWard} unresolved=${mapped.counts.labelsUnresolved}`);
  return { master, derived, report };
}

if (isMainModule(import.meta.url)) {
  try { run(); }
  catch (err) { console.error(err.stack || err.message); process.exit(1); }
}
