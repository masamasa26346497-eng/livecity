const test = require('node:test'), assert = require('node:assert');
test('HTTP 分類', async () => {
  const { classifyUrl, recordHttp, realFailures, EX_MAX } = await import('../tools/cloud/http-classify.mjs');
  assert.equal(classifyUrl('/ext-3dtiles/_city-lod0/tileset.json'), 'lod0Tileset');
  assert.equal(classifyUrl('/ext-3dtiles/_city-lod0/t_1.glb'), 'lod0Glb');
  assert.equal(classifyUrl('/ext-3dtiles/kita/lod/g_1.glb'), 'realGlb');
  assert.equal(classifyUrl('/ext-3dtiles/kita/tileset.json'), 'realTileset');
  assert.equal(classifyUrl('/towns-24.json'), 'optionalAsset');
  assert.equal(classifyUrl('/favicon.ico'), 'optionalAsset');
  const st = {};
  recordHttp(st, 'http://127.0.0.1:1/towns-24.json', 404);
  recordHttp(st, 'http://127.0.0.1:1/ext-3dtiles/_city-lod0/a.glb', 200);
  assert.equal(realFailures(st), 0); // 404 だけでは実建物失敗にならない
  assert.equal(st.optionalAsset.nNon2xx, 1); assert.equal(st.lod0Glb.n2xx, 1);
  recordHttp(st, 'http://127.0.0.1:1/ext-3dtiles/kita/lod/x.glb', 500);
  assert.equal(realFailures(st), 1);
  for (let i = 0; i < EX_MAX + 5; i++) recordHttp(st, `http://127.0.0.1:1/x${i}.json`, 404);
  assert.equal(st.optionalAsset.examples.length, EX_MAX); assert.equal(st.optionalAsset.truncated, true);
  assert.equal(st.optionalAsset.nNon2xx, EX_MAX + 6); // 件数は打切りなし
});
