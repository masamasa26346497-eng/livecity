'use strict';
const test = require('node:test');
const assert = require('node:assert');

const gml = (id, lod2) => `<bldg:Building gml:id="${id}"><bldg:lod0FootPrint/><bldg:lod1Solid/>${lod2 || ''}</bldg:Building>`;

test('lod2 id extraction: solid and surface counted, lod1-only and no-id handled', async () => {
  const { lod2IdsFromXml } = await import('../tools/mission182/extract-lod2-ids.mjs');
  const xml = gml('a', '<bldg:lod2Solid/>') + gml('b') + gml('c', '<bldg:lod2MultiSurface/>') +
    '<bldg:Building><bldg:lod2Solid/></bldg:Building><bldg:BuildingPart gml:id="p"><bldg:lod2Solid/></bldg:BuildingPart>';
  const { ids, stat } = lod2IdsFromXml(xml);
  assert.deepStrictEqual(ids.sort(), ['a', 'c']);
  assert.strictEqual(stat.lod1Only, 1);
  assert.strictEqual(stat.noId, 1);
});

test('audit: passes only when complement + excluded == full and no LOD2 id remains', async () => {
  const { auditSets } = await import('../tools/mission182/audit-complement.mjs');
  const full = new Set(['1', '2', '3', '4']);
  const lod2 = new Set(['2', '9']); // 9 is in another ward / no LOD1 counterpart -> never removes anything
  assert.strictEqual(auditSets(full, new Set(['1', '3', '4']), lod2, new Set(['2'])).pass, true);
  assert.strictEqual(auditSets(full, new Set(['1', '3', '4']), lod2, new Set(['2'])).lod2IdsNotInWardLod1, 1);
  assert.strictEqual(auditSets(full, new Set(['1', '3']), lod2, new Set(['2'])).pass, false, 'building 4 silently lost');
  assert.strictEqual(auditSets(full, new Set(['1', '2', '3', '4']), lod2, new Set()).pass, false, 'LOD2 id still drawn as LOD1');
});

test('build script is opt-in: --exclude-ids path exists, default path untouched', () => {
  const s = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'tools', 'mission79-build-ward-2025.cjs'), 'utf8');
  assert.match(s, /opt\('exclude-ids'\)/);
  assert.match(s, /Number\(lod2Meta\.vintage\) === 2025/);
  assert.match(s, /if \(exclude && exclude\.has/);
});
