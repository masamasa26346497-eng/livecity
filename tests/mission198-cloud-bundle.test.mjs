import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-cloud-bundle.mjs'), ...args], { encoding: 'utf8' });

test('バンドル出力先が public/ なら拒否する', () => {
  const r = run(['--wards', 'kita', '--out', 'public/cloud-bundle']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /public|temp/);
});

test('temp/ 外への出力は拒否する', () => {
  const r = run(['--wards', 'kita', '--out', 'dist-cloud']);
  assert.equal(r.status, 2);
});

test('registry に無い区は拒否する(temp 出力でも)', () => {
  const r = run(['--wards', 'nonexistent-ward', '--out', 'temp/cloud-bundle-test']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /registry/);
});
