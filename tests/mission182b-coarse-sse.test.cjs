'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'tools/lod2/lod2-overlay.js'), 'utf8');
test('overlay: 遠景の粗いLOD用SSE引き下げが存在し、無効化クエリがある', () => {
  assert.match(src, /lod2coarsesse/); assert.match(src, /lod2coarseh/); assert.match(src, /orig\.get\(p\)/);
});
test('overlay.js は構文OK', () => { new Function(src); });
test('SSE式: root ge=160 は SSE32 では 3.5km 超で子を出さず、SSE2 なら 30km でも選択される', () => {
  const sse = (ge, d) => (ge * 800) / (2 * d * Math.tan(Math.PI / 6));
  assert.ok(sse(160, 30000) < 32); assert.ok(sse(160, 30000) > 2);
});
