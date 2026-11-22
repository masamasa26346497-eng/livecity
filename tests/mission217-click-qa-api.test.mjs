import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Mission 217: QA が呼ぶ pick API は 37G で実在し、QA フック(__mission37dQA)側にあること。
const qa = fs.readFileSync('tools/lod2/lod2-click-qa.cjs', 'utf8');
const html = fs.readFileSync('public/mission37g-osaka-24ward-mvp.html', 'utf8');
test('QA は __mission37g ではなく __mission37dQA の drillIds 等を呼ぶ', () => {
  assert.doesNotMatch(qa, /__mission37g\.(drillIds|tilesReady|cameraVsTilesets|tilesetCount|clearSelection)/);
  assert.match(qa, /__mission37dQA\.drillIds/);
});
test('37G の __mission37dQA は drillIds/tilesReady を定義し、localhost かつ qa=1 でのみ公開', () => {
  const i = html.indexOf('window.__mission37dQA = {');
  assert.ok(i > 0);
  const gate = html.slice(html.lastIndexOf('if (', i), i);
  assert.match(gate, /localhost/); assert.match(gate, /get\('qa'\) === '1'/);
  assert.match(html.slice(i, i + 12000), /drillIds\(px, py\)/);
  assert.match(html.slice(i, i + 12000), /tilesReady:/);
});
test('QA は localhost + ?qa=1 で開く(ホスト名/qa フラグ不一致の再発防止)', () => {
  assert.match(qa, /const HOST = 'localhost'/);
  assert.match(qa, /\/mission37g-osaka-24ward-mvp\.html\?qa=1&ext45=1/);
  assert.doesNotMatch(qa, /port \+ '\/\?qa=1/); // index.html の meta refresh はクエリを落とす
  assert.match(qa, /failFast/);
});
