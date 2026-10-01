import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROTECTED = [
  path.join(ROOT, 'public', 'osaka_3d_buildings.html'),
  path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'),
];
const MARKER = '[Mission 36J PERF] bounded facility renderer';

const protectedBefore = new Map(PROTECTED.map((p) => [p, fs.readFileSync(p, 'utf8')]));
let html = fs.readFileSync(DEV, 'utf8');

if (html.includes(MARKER)) {
  console.log('[36J UI PERF] already applied');
  process.exit(0);
}

const layerStart = html.indexOf('const FacilityLayer = (function () {');
if (layerStart < 0) throw new Error('FacilityLayer start not found');
const layerEnd = html.indexOf('\n})();', layerStart);
if (layerEnd < 0) throw new Error('FacilityLayer end not found');
let layer = html.slice(layerStart, layerEnd + '\n})();'.length);

const declNeedle = `const FacilityLayer = (function () {\n  let group = null;`;
if (!layer.includes(declNeedle)) throw new Error('FacilityLayer declaration anchor not found');
layer = layer.replace(declNeedle, `const FacilityLayer = (function () {\n  // ${MARKER}\n  // 40,585件を一括CanvasTexture/Sprite化するとブラウザが固まるため、\n  // カメラ中心付近だけを上限付きで描画する。元データ40,585件はDataStoreに保持する。\n  const MAX_RENDERED_FACILITIES = 800;\n  const FACILITY_RENDER_RADIUS_METERS = 4500;\n  let renderedFacilityCount = 0;\n  let totalFacilityCount = 0;\n  let group = null;`);

const loopNeedle = '    for (const record of FacilityDataStore.getAllRecords()) {';
if (!layer.includes(loopNeedle)) throw new Error('FacilityLayer all-record loop anchor not found');
const selection = `    const allFacilityRecords = FacilityDataStore.getAllRecords();\n    totalFacilityCount = allFacilityRecords.length;\n    const centerX = (typeof cs !== 'undefined' && Number.isFinite(cs.tx)) ? cs.tx : 0;\n    const centerZ = (typeof cs !== 'undefined' && Number.isFinite(cs.tz)) ? cs.tz : 0;\n    const radiusSq = FACILITY_RENDER_RADIUS_METERS * FACILITY_RENDER_RADIUS_METERS;\n    const selectedFacilityRecords = allFacilityRecords\n      .map((record) => {\n        const dx = Number(record.localX) - centerX;\n        const dz = Number(record.localZ) - centerZ;\n        return { record, d2: dx * dx + dz * dz };\n      })\n      .filter((x) => Number.isFinite(x.d2) && x.d2 <= radiusSq)\n      .sort((a, b) => Number(!!b.record.majorFacility) - Number(!!a.record.majorFacility) || a.d2 - b.d2)\n      .slice(0, MAX_RENDERED_FACILITIES)\n      .map((x) => x.record);\n    renderedFacilityCount = selectedFacilityRecords.length;\n\n    for (const record of selectedFacilityRecords) {`;
layer = layer.replace(loopNeedle, selection);

// Expose a tiny debug hook without touching production HTML.
const returnNeedle = '  return {';
const returnPos = layer.lastIndexOf(returnNeedle);
if (returnPos < 0) throw new Error('FacilityLayer return anchor not found');
const debugFn = `  function getPerformanceDebug() {\n    return {\n      totalFacilityCount,\n      renderedFacilityCount,\n      maxRenderedFacilities: MAX_RENDERED_FACILITIES,\n      renderRadiusMeters: FACILITY_RENDER_RADIUS_METERS,\n    };\n  }\n\n`;
layer = layer.slice(0, returnPos) + debugFn + layer.slice(returnPos);

// Add getPerformanceDebug to the returned object, conservatively by inserting after return opening.
const updatedReturnPos = layer.lastIndexOf(returnNeedle);
layer = layer.slice(0, updatedReturnPos + returnNeedle.length) + '\n    getPerformanceDebug,' + layer.slice(updatedReturnPos + returnNeedle.length);

html = html.slice(0, layerStart) + layer + html.slice(layerEnd + '\n})();'.length);

// Public debug hook for PC verification.
const hookAnchor = html.indexOf('\n})();', layerStart) + '\n})();'.length;
html = html.slice(0, hookAnchor) + `\nif (typeof window !== 'undefined') window.__FACILITY_LAYER_PERF__ = () => FacilityLayer.getPerformanceDebug();` + html.slice(hookAnchor);

// Safety assertions.
if (!html.includes(MARKER)) throw new Error('performance marker missing after patch');
if (!html.includes('MAX_RENDERED_FACILITIES = 800')) throw new Error('render cap missing');
if (!html.includes('for (const record of selectedFacilityRecords)')) throw new Error('bounded loop missing');
if (html.includes('for (const record of FacilityDataStore.getAllRecords()) {')) throw new Error('unbounded facility loop still present');
if (!html.includes("areaId: 'osaka-city'")) throw new Error('citywide facility config lost');
if (!html.includes('google-places-osaka-city-mapping.json')) throw new Error('citywide Google mapping wiring lost');

fs.writeFileSync(DEV, html, 'utf8');

for (const [p, before] of protectedBefore) {
  const after = fs.readFileSync(p, 'utf8');
  if (before !== after) throw new Error('protected production HTML changed: ' + path.basename(p));
}

console.log('[36J UI PERF] patched dev UI: citywide source retained, facility sprites capped at 800 within 4.5km');
