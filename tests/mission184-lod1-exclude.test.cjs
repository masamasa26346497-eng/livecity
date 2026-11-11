'use strict';
// Mission184: --exclude-ids is strict gml:id match; non-LOD2 buildings are never dropped. Synthetic fixture.
const test = require('node:test'), assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { prepareBuildings } = require('../tools/mission79-build-ward-2025.cjs');
test('excludes only exact LOD2 ids, keeps the rest', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm184-')), 'b.jsonl');
  const fp = (x) => [[x, 0], [x + 10, 0], [x + 10, -10], [x, -10]];
  const rows = ['a', 'b', 'c', 'bldg_a2'].map((id, i) => ({ id, fp: fp(i * 20), z0: 0, h: 5, sourceMesh: 'm' }));
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n'));
  const ward = { bbox: { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 }, polygons: [{ outer: [[-1e6, -1e6], [1e6, -1e6], [1e6, 1e6], [-1e6, 1e6]] }] };
  const base = prepareBuildings(f, ward, null), ex = prepareBuildings(f, ward, new Set(['b', 'zzz']));
  assert.equal(base.all.length, 4);
  assert.deepEqual(ex.all.map((b) => b.id).sort(), ['a', 'bldg_a2', 'c']);
  assert.equal(ex.stat.excluded, 1);
});
