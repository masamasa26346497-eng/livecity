// Mission 162: launcher / 診断 / フック (ネットワーク不要・Chrome 不要)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('launcher --check-only は別の cwd から呼んでも ROOT を解決し前提 OK', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/lod2/lod2-launch.mjs'), '--check-only', '--port', '8199'], { cwd: '/', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp('ROOT = ' + ROOT.replace(/[\\/]/g, '.')));
  assert.match(r.stdout, /37G HTML に LOD2 フック/);
});

test('サーバ診断は生成物の有無と HTML フックを返し、秘密/絶対パスを含まない', () => {
  const { diagnose } = require('../tools/lod2/lod2-preview-serve.cjs');
  const d = diagnose();
  assert.equal(d.html37g.hasLod2Hook, true);
  assert.equal(d.overlayJs, true);
  assert.ok('tileset.json' in d.files && 'lod2.glb' in d.files);
  assert.ok(!JSON.stringify(d).includes(ROOT));
});

test('37G HTML: LOD2 は localhost かつ ?lod2=1 のみ、読み込み失敗時は日本語バナー', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
  assert.match(html, /localhost\|127\\\.0\\\.0\\\.1[\s\S]{0,80}lod2'\) === '1'/);
  assert.match(html, /s152\.onerror/);
});

test('PowerShell ラッパーは $PSScriptRoot 基準で launcher を呼ぶ', () => {
  const ps = fs.readFileSync(path.join(ROOT, 'Start-LOD2-Preview.ps1'), 'utf8');
  assert.match(ps, /\$PSScriptRoot/);
  assert.match(ps, /lod2-launch\.mjs/);
});

test('Mission168: .ps1 は ASCII のみ(PS 5.1 の ANSI 解釈で文字化け/ParserError にならない)、括弧・引用符が釣り合う', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'Start-LOD2-Preview.ps1'));
  const bad = [...buf].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
  assert.equal(bad, -1, 'non-ASCII byte at ' + bad);
  const code = buf.toString('ascii').split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  for (const l of code) assert.equal((l.match(/"/g) || []).length % 2, 0, 'unbalanced quote: ' + l);
  const src = code.join('\n');
  assert.equal((src.match(/\{/g) || []).length, (src.match(/\}/g) || []).length);
  assert.match(src, /\[switch\]\$All/);
  assert.match(src, /"--all"/);
});
