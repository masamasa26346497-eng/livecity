import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve('public/osaka_3d_buildings.ward-ux-v1.html');
const protectedFiles = [
  path.resolve('public/osaka_3d_buildings.html'),
  path.resolve('public/osaka_3d_buildings.fullward-v3.html'),
];

if (!fs.existsSync(target)) throw new Error(`missing target: ${target}`);
const protectedBefore = new Map(protectedFiles.map((p) => [p, fs.readFileSync(p)]));
let html = fs.readFileSync(target, 'utf8');

function replaceExactlyOnce(needle, replacement, label) {
  const count = html.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly 1 match, got ${count}`);
  html = html.replace(needle, replacement);
}

if (!html.includes('const FACILITY_CONFIG = Object.freeze({')) {
  const demographicsBlock = `const DEMOGRAPHICS_CONFIG = Object.freeze({\n  areaId: 'osaka-sumiyoshi',\n  basePath: 'map-data', // このHTMLから見た public/map-data への相対パス\n});`;
  const facilityBlock = `${demographicsBlock}\n\n// [Mission 36J] 人口統計は既存の住吉区データを維持し、施設レイヤーだけ24区全域へ拡張する。\nconst FACILITY_CONFIG = Object.freeze({\n  areaId: 'osaka-city',\n  basePath: 'map-data',\n});\nif (typeof window !== 'undefined') window.__LIVE_CITY_FACILITY_CONFIG__ = FACILITY_CONFIG;`;
  replaceExactlyOnce(demographicsBlock, facilityBlock, 'insert FACILITY_CONFIG');
}

replaceExactlyOnce(
  'const url = `${DEMOGRAPHICS_CONFIG.basePath}/${DEMOGRAPHICS_CONFIG.areaId}/facilities/facilities.json`;',
  'const url = `${FACILITY_CONFIG.basePath}/${FACILITY_CONFIG.areaId}/facilities/facilities.json`;',
  'facility data source'
);
replaceExactlyOnce(
  'const metaUrl = `${DEMOGRAPHICS_CONFIG.basePath}/${DEMOGRAPHICS_CONFIG.areaId}/facilities/metadata.json`;',
  'const metaUrl = `${FACILITY_CONFIG.basePath}/${FACILITY_CONFIG.areaId}/facilities/metadata.json`;',
  'facility metadata source'
);

replaceExactlyOnce(
  "const MAPPING_URL = 'map-data/osaka-city/derived/google-places-pilot-mapping.json';",
  "const MAPPING_URLS = [\n    'map-data/osaka-city/derived/google-places-osaka-city-mapping.json',\n    'map-data/osaka-city/derived/google-places-pilot-mapping.json',\n  ];",
  'Google Places mapping URLs'
);

const oldEnsureMapping = `  function ensureMapping() {\n    if (mapping || mappingLoading) return mappingLoading || Promise.resolve(mapping);\n    mappingLoading = fetch(MAPPING_URL).then((r) => (r.ok ? r.json() : null)).then((j) => {\n      const byFacilityId = {};\n      for (const e of (j && j.entries) || []) if (e.facilityId) byFacilityId[e.facilityId] = e;\n      mapping = { byFacilityId, raw: j };\n      return mapping;\n    }).catch(() => { mapping = { byFacilityId: {}, raw: null }; return mapping; });\n    return mappingLoading;\n  }`;
const newEnsureMapping = `  function ensureMapping() {\n    if (mapping || mappingLoading) return mappingLoading || Promise.resolve(mapping);\n    mappingLoading = (async () => {\n      for (const url of MAPPING_URLS) {\n        try {\n          const r = await fetch(url, { cache: 'no-store' });\n          if (!r.ok) continue;\n          const j = await r.json();\n          const byFacilityId = {};\n          for (const e of (j && j.entries) || []) {\n            if (e.facilityId && e.googlePlaceId && e.matchConfidence === 'VERIFIED') byFacilityId[e.facilityId] = e;\n          }\n          mapping = { byFacilityId, raw: j, sourceUrl: url };\n          return mapping;\n        } catch (_) { /* 次のmappingへフォールバック */ }\n      }\n      mapping = { byFacilityId: {}, raw: null, sourceUrl: null };\n      return mapping;\n    })();\n    return mappingLoading;\n  }`;
replaceExactlyOnce(oldEnsureMapping, newEnsureMapping, 'citywide mapping loader');

// 古い「30施設のみ」の説明を24区向けに更新。ロジックではなく開発者向けコメントのみ。
html = html.replace(
  '（＝このMissionの検証パイロット対象 30施設以外では、今は何も出ない。全施設対象ではない）。',
  '（＝24区mappingでVERIFIED済みの施設だけ表示し、未照合・曖昧な施設では何も出さない）。'
);
html = html.replace(
  '事前生成された pilot mapping に facilityId が無ければ何もしない',
  '事前生成された24区Google Places mappingにVERIFIED facilityIdが無ければ何もしない'
);

fs.writeFileSync(target, html, 'utf8');

// Safety assertions.
const out = fs.readFileSync(target, 'utf8');
if (!out.includes("areaId: 'osaka-city'")) throw new Error('FACILITY_CONFIG was not applied');
if (!out.includes('google-places-osaka-city-mapping.json')) throw new Error('citywide mapping URL was not applied');
if (!out.includes('matchConfidence === \'VERIFIED\'')) throw new Error('VERIFIED-only UI mapping guard missing');
if (out.includes('fetch(MAPPING_URL)')) throw new Error('legacy single pilot mapping loader remains');
for (const [p, before] of protectedBefore) {
  const after = fs.readFileSync(p);
  if (!before.equals(after)) throw new Error(`protected production HTML changed: ${p}`);
}

console.log('[36J UI] citywide facility + Google Places photo UI applied safely');
