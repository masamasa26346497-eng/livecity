import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROTECTED = [
  path.join(ROOT, 'public', 'osaka_3d_buildings.html'),
  path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'),
];
const MARKER = '[Mission 36J CLICK PERF V2] screen-space facility picking';

const protectedBefore = new Map(PROTECTED.map((p) => [p, fs.readFileSync(p, 'utf8')]));
let html = fs.readFileSync(DEV, 'utf8');

if (html.includes(MARKER)) {
  console.log('[36J CLICK PERF V2] already applied');
  process.exit(0);
}

const layerStart = html.indexOf('const FacilityLayer = (function () {');
if (layerStart < 0) throw new Error('FacilityLayer start not found');
const layerEnd = html.indexOf('\n})();', layerStart);
if (layerEnd < 0) throw new Error('FacilityLayer end not found');
let layer = html.slice(layerStart, layerEnd + '\n})();'.length);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, got ${count}`);
  return source.replace(needle, replacement);
}

// Keep the full 40,585-record datastore. Only the active visual/pick set is bounded.
// Normalize older 800/4.5km patch revisions to the already field-tested 200/2.5km budget.
const perfDeclRe = /  const MAX_RENDERED_FACILITIES = \d+;\n  const FACILITY_RENDER_RADIUS_METERS = \d+;/;
if (!perfDeclRe.test(layer)) throw new Error('facility performance constants not found');
layer = layer.replace(perfDeclRe, `  // ${MARKER}\n  const MAX_RENDERED_FACILITIES = 200;\n  const FACILITY_RENDER_RADIUS_METERS = 2500;\n  const FACILITY_PICK_RADIUS_NDC = 0.055;`);

// The real camera/map centre is cs.tgt.{x,z}. cs.tx/cs.tz do not exist in the current controller.
// Using the wrong fields silently fell back to (0,0), so a ward rebuild could select facilities around
// the origin instead of the ward currently being viewed.
const oldCenter = `    const centerX = (typeof cs !== 'undefined' && Number.isFinite(cs.tx)) ? cs.tx : 0;\n    const centerZ = (typeof cs !== 'undefined' && Number.isFinite(cs.tz)) ? cs.tz : 0;`;
const newCenter = `    const centerX = (typeof cs !== 'undefined' && cs.tgt && Number.isFinite(cs.tgt.x)) ? cs.tgt.x : 0;\n    const centerZ = (typeof cs !== 'undefined' && cs.tgt && Number.isFinite(cs.tgt.z)) ? cs.tgt.z : 0;`;
layer = replaceOnce(layer, oldCenter, newCenter, 'camera centre');

// Facility sprites are already projected to NDC every update for overlap suppression. Reuse those
// coordinates for click picking instead of asking THREE.Raycaster to intersect every visible sprite
// before the building picker gets a chance to run.
const oldPickerDecl = `  const facilityRaycaster = new THREE.Raycaster();\n  const facilityMouse = new THREE.Vector2();`;
const newPickerDecl = `  let pickCandidates = []; // { item, sx, sy }; rebuilt by update(), max 200`;
layer = replaceOnce(layer, oldPickerDecl, newPickerDecl, 'facility raycaster declarations');

// Never let stale screen positions survive a rebuild.
layer = replaceOnce(
  layer,
  `    group = new THREE.Group(); group.name = 'FacilityLayer';`,
  `    group = new THREE.Group(); group.name = 'FacilityLayer';\n    pickCandidates = [];`,
  'build candidate reset'
);

// Keep the exact same overlap/visibility decision as before, but cache only the final visible set for clicks.
const finalVisibleNeedle = `    const OVERLAP_THRESHOLD = 0.05;\n    const placed = [];\n    const finalVisible = new Set();\n    for (const p of projected) {\n      const overlapping = placed.some((q) => Math.hypot(p.sx - q.sx, p.sy - q.sy) < OVERLAP_THRESHOLD);\n      if (overlapping && !p.isSelected) continue;\n      placed.push(p);\n      finalVisible.add(p.item);\n    }\n\n    for (const item of sprites) {`;
const finalVisibleReplacement = `    const OVERLAP_THRESHOLD = 0.05;\n    const placed = [];\n    const finalVisible = new Set();\n    for (const p of projected) {\n      const overlapping = placed.some((q) => Math.hypot(p.sx - q.sx, p.sy - q.sy) < OVERLAP_THRESHOLD);\n      if (overlapping && !p.isSelected) continue;\n      placed.push(p);\n      finalVisible.add(p.item);\n    }\n    // Reuse the projection work above. Building clicks no longer wait for a sprite Raycaster pass.\n    pickCandidates = placed.map((p) => ({ item: p.item, sx: p.sx, sy: p.sy }));\n\n    for (const item of sprites) {`;
layer = replaceOnce(layer, finalVisibleNeedle, finalVisibleReplacement, 'pick candidate cache');

// Clear the click cache whenever the layer is hidden.
layer = replaceOnce(
  layer,
  `    if (!group || !visible) {\n      if (group) group.visible = false;\n      return;\n    }`,
  `    if (!group || !visible) {\n      if (group) group.visible = false;\n      pickCandidates = [];\n      return;\n    }`,
  'hidden candidate reset'
);

const oldPickHit = `    pickHit(mouseX, mouseY, camera) {\n      if (!group) return null;\n      facilityMouse.set(mouseX, mouseY);\n      facilityRaycaster.setFromCamera(facilityMouse, camera);\n      const visibleSprites = sprites.filter((item) => item.sprite.visible).map((item) => item.sprite);\n      const hits = facilityRaycaster.intersectObjects(visibleSprites, false);\n      if (!hits.length) return null;\n      const hitSprite = hits[0].object;\n      const item = sprites.find((s) => s.sprite === hitSprite);\n      return item ? item.record : null;\n    },`;
const newPickHit = `    pickHit(mouseX, mouseY, camera) {\n      if (!group || !visible || !pickCandidates.length) return null;\n      const maxD2 = FACILITY_PICK_RADIUS_NDC * FACILITY_PICK_RADIUS_NDC;\n      let best = null;\n      let bestD2 = maxD2;\n      for (const candidate of pickCandidates) {\n        const dx = mouseX - candidate.sx;\n        const dy = mouseY - candidate.sy;\n        const d2 = dx * dx + dy * dy;\n        if (d2 <= bestD2) { bestD2 = d2; best = candidate.item; }\n      }\n      return best ? best.record : null;\n    },`;
layer = replaceOnce(layer, oldPickHit, newPickHit, 'screen-space pickHit');

// Make debug output explicit so PC verification can confirm the lightweight click path is active.
const oldDebug = `      maxRenderedFacilities: MAX_RENDERED_FACILITIES,\n      renderRadiusMeters: FACILITY_RENDER_RADIUS_METERS,`;
const newDebug = `      maxRenderedFacilities: MAX_RENDERED_FACILITIES,\n      renderRadiusMeters: FACILITY_RENDER_RADIUS_METERS,\n      pickCandidateCount: pickCandidates.length,\n      pickMode: 'screen-space-nearest',\n      pickRadiusNdc: FACILITY_PICK_RADIUS_NDC,`;
layer = replaceOnce(layer, oldDebug, newDebug, 'performance debug');

// Dispose/rebuild must drop stale projected references immediately.
layer = replaceOnce(
  layer,
  `      group = null; sprites = []; built = false;\n    },`,
  `      group = null; sprites = []; pickCandidates = []; built = false;\n    },`,
  'dispose candidate reset'
);
layer = replaceOnce(
  layer,
  `      group = null; sprites = []; built = false;\n      build();`,
  `      group = null; sprites = []; pickCandidates = []; built = false;\n      build();`,
  'rebuild candidate reset'
);

html = html.slice(0, layerStart) + layer + html.slice(layerEnd + '\n})();'.length);

// Safety assertions: data wiring is untouched, production HTML is untouched, and facility click picking
// no longer uses THREE.Raycaster. Building picking itself remains unchanged and therefore receives control
// immediately whenever no visible facility label is within the small NDC click radius.
if (!html.includes(MARKER)) throw new Error('click performance marker missing');
if (!html.includes('MAX_RENDERED_FACILITIES = 200')) throw new Error('render cap is not 200');
if (!html.includes('FACILITY_RENDER_RADIUS_METERS = 2500')) throw new Error('render radius is not 2500m');
if (!html.includes("pickMode: 'screen-space-nearest'")) throw new Error('screen-space picker debug hook missing');
if (!html.includes('cs.tgt && Number.isFinite(cs.tgt.x)')) throw new Error('camera-centre x fix missing');
if (!html.includes('cs.tgt && Number.isFinite(cs.tgt.z)')) throw new Error('camera-centre z fix missing');
const patchedLayer = html.slice(layerStart, html.indexOf('\n})();', layerStart) + '\n})();'.length);
if (patchedLayer.includes('facilityRaycaster.intersectObjects')) throw new Error('facility Raycaster path still present');
if (!html.includes("areaId: 'osaka-city'")) throw new Error('citywide facility config lost');
if (!html.includes('ward-manifest.json')) throw new Error('24-ward lazy loading lost');
if (!html.includes('google-places-osaka-city-mapping.json')) throw new Error('Google Places mapping wiring lost');

fs.writeFileSync(DEV, html, 'utf8');
for (const [p, before] of protectedBefore) {
  if (fs.readFileSync(p, 'utf8') !== before) throw new Error('protected production HTML changed: ' + path.basename(p));
}

console.log('[36J CLICK PERF V2] patched dev UI: 40,585 records retained; 200 active sprites; screen-space facility picking; cs.tgt centre');
