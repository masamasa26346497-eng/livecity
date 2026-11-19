const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = {}; sb.window = sb; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/mission45f-streaming.js'), 'utf8'), sb);
const L = sb.LC45F;
const fov = Math.PI / 3;
test('M76: coarse 親→leaf 切替距離が従来(sse128)より遠くなる', () => {
  const before = L.refineDistance(40, 128, fov, 1080), after = L.refineDistance(40, L.DEFAULTS.coarseSse, fov, 1080);
  assert.ok(before < 300); assert.ok(after > 1000 && after > before * 3);
});
test('M76: coarse 層が詳細既定SSE16より細かくならない', () => assert.ok(L.DEFAULTS.coarseSse >= 16));
