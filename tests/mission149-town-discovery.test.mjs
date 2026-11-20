// Mission 149: town-boundary source auto-detection (read-only) + no-store fetch of the generated labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { townSourceCandidates, discoverTownSource } from '../tools/mission141-local-24.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('finds the e-Stat ZIP next to the old pipeline without a path argument', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc149-'));
  const root = path.join(tmp, 'livecity'); fs.mkdirSync(root);
  const d = path.join(tmp, 'livecity-data-pipeline', 'data', 'raw', 'osaka-city', 'boundaries'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'estat-2020-town-boundaries-osaka.zip'), 'x');
  fs.writeFileSync(path.join(d, 'estat-2020-town-boundaries-osaka.meta.json'), '{}');
  const found = townSourceCandidates({ root, env: {}, home: '' });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'zip');
  assert.ok(found[0].file.endsWith('.zip'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GeoJSON source is detected, meta.json is ignored, nothing found -> null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc149-'));
  const root = path.join(tmp, 'livecity'); fs.mkdirSync(root);
  assert.equal(discoverTownSource({ root, env: {}, home: '' }), null);
  const d = path.join(root, 'data', 'raw', 'osaka-city', 'boundaries'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'town.meta.json'), '{}');
  fs.writeFileSync(path.join(d, 'osaka-town-boundaries.geojson'), '{}');
  const f = discoverTownSource({ root, env: {}, home: '' });
  assert.equal(f.kind, 'geojson');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('launcher never deletes the source and the page fetches town labels with no-store', () => {
  const l = fs.readFileSync(path.join(ROOT, 'tools/mission141-local-24.mjs'), 'utf8');
  const blk = l.slice(l.indexOf('[149] towns'), l.indexOf('town build skipped'));
  assert.ok(!/unlinkSync|rmSync|renameSync/.test(blk));
  const page = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(page, /towns-24\.local\.json', \{ cache: 'no-store' \}/);
  assert.match(page, /towns-24\.json', \{ cache: 'no-store' \}/);
});
