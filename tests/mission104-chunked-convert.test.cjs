'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
const MB = 1048576;
const ent = (mesh, kind, mb) => ({ mesh, kind, uncompressedBytes: mb * MB });
test('planChunks bounds each chunk and keeps every mesh once', async () => {
  const { planChunks } = await import('../tools/mission104/chunked-run.mjs');
  const meshes = Array.from({ length: 24 }, (_, i) => '5135' + String(1000 + i).padStart(4, '0'));
  const entries = meshes.map((m) => ent(m, 'bldg', 50));
  const c = planChunks(entries, meshes, 300);
  assert.ok(c.every((x) => x.bytes <= 300 * MB));
  assert.deepStrictEqual(c.flatMap((x) => x.meshes), meshes);
  assert.throws(() => planChunks([ent('51350000', 'bldg', 400)], ['51350000'], 300), /exceeds --chunk-mb/);
});
test('gates: 1260MB ward passes only via bounded peak; 1200 gate and hard ceiling not relaxed', async () => {
  const { planChunks, checkChunkGates, HARD_TOTAL_MB } = await import('../tools/mission104/chunked-run.mjs');
  const meshes = Array.from({ length: 24 }, (_, i) => 'm' + i);
  const entries = meshes.flatMap((m) => [ent(m, 'bldg', 50), ent(m, 'tran', 2.5)]);
  const c = planChunks(entries, meshes, 300);
  const g = checkChunkGates(entries, meshes, c, 1200);
  assert.ok(g.peakMb <= 360 && g.totalMb > 1200 && g.totalMb <= HARD_TOTAL_MB);
  assert.throws(() => checkChunkGates(entries, meshes, c, 100), /peak inflated/);
  assert.throws(() => checkChunkGates(entries, meshes, c, 1200, 1000), /total inflated/);
  assert.throws(() => checkChunkGates(entries, meshes, c, 1200, 99999), /hard ceiling/);
  assert.strictEqual(HARD_TOTAL_MB, 1500);
});
test('audited 1200MB gate and pinned closure files are untouched; dry-run on real lock (read-only)', () => {
  const crypto = require('node:crypto');
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.strictEqual(h('tools/mission79-run.mjs'), 'c95c1be46c49514e9c67a0845e52b65e221f0522fa6c62325a0bc04a5eff5657');
  assert.strictEqual(h('tools/mission80-batch.mjs'), 'fe1e4a1ee5e6aa64ed67826c9a5a69de41cd1ee988e4aea675850ec34cf04ae2');
  assert.match(fs.readFileSync('tools/mission79-run.mjs', 'utf8'), /if \(infl > maxMb\) throw/);
  for (const w of ['ikuno', 'abeno', 'yodogawa']) {
    const out = execFileSync(process.execPath, ['tools/mission104/chunked-run.mjs', '--ward', w, '--chunk-mb', '300', '--max-mb', '1200', '--dry-run'], { encoding: 'utf8' });
    const plan = JSON.parse(out.split('plan ')[1]);
    assert.ok(plan.chunks >= 3 && plan.gates.peakMb <= 1200 && plan.gates.totalMb <= 1500, w);
  }
});
test('scratch deletion is confined; no secrets/upload/network-write in new code', () => {
  const src = fs.readFileSync('tools/mission104/chunked-run.mjs', 'utf8');
  assert.match(src, /refusing to delete outside scratch/);
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /GITHUB_TOKEN|secrets\.|mission87-persist|mission95-persist|'gh'|curl|process\.env/);
});
