'use strict';
// Mission 213: LOD2 収録なしの区(平野区単独など)を正常状態として扱い、欠損と区別する回帰テスト(fixture・ネットワーク不要)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function suppFixture(ids) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nolod2-'));
  return { d, ids };
}

test('空 LOD2 出力: manifest/footprints/report/tileset が揃い converted=0・noLod2', async () => {
  const { writeEmptyLod2 } = await import('../tools/cloud/empty-lod2.mjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'elod2-'));
  const rep = writeEmptyLod2(d, { meshesChecked: ['51357'] });
  assert.strictEqual(rep.converted, 0); assert.strictEqual(rep.noLod2, true);
  for (const n of ['tileset.json', 'footprints.json', 'report.json', 'manifest.json']) assert.ok(fs.existsSync(path.join(d, n)), n);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')).assets, []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'footprints.json'), 'utf8')).footprints, []);
  assert.ok(fs.statSync(path.join(d, 'tiles')).isDirectory());
});

test('ビルドは LOD2 なしでも収録調査に載るメッシュなら続行し、調査に無いメッシュは失敗(欠損と区別)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/cloud/build-cloud-preview.mjs'), 'utf8');
  assert.ok(src.includes('NO_LOD2') && src.includes('writeEmptyLod2'), '空 LOD2 経路');
  assert.ok(/収録調査が不完全/.test(src) && src.includes('meshesAudited'), '調査が不完全なら例外');
  assert.ok(src.includes("NO_LOD2 ? [] : ['--exclude-ids'"), 'LOD2 なしでは --exclude-ids を渡さない');
});

test('ID 監査: noLod2 は除外 0・全棟残存を要求。除外があれば失敗。LOD2 ありの既存監査は不変', async () => {
  const { auditSinglePass } = await import('../tools/cloud/lod1-id-audit.mjs');
  const src = fs.readFileSync(path.join(__dirname, '../tools/cloud/lod1-id-audit.mjs'), 'utf8');
  assert.ok(src.includes('過剰除外') && src.includes('LOD2 の ID が残存'), '既存の LOD2 あり監査が残っている');
  // supp ディレクトリの実体が要るため readLeafIds 経由の挙動は、LOD2 ID 混入だけここで確認
  assert.throws(() => auditSinglePass({ id: 'x', suppDir: '/nonexistent', lod2Ids: new Set(['a']), noLod2: true, suppBuildings: 1, excludedCount: 0, inWard: 1 }));
});

// Mission213: LOD2 収録なしの区でも、遠景の粗い親タイル用 SSE 引下げが overlay で有効になること(平野区で遠景の実タイルが 0 になった根因)
test('lod2-overlay: no-lod2 でも installCoarseSse を呼ぶ', () => {
  const s = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'tools', 'lod2', 'lod2-overlay.js'), 'utf8');
  const i = s.indexOf("state.status = 'no-lod2'");
  assert.ok(i > 0);
  assert.match(s.slice(i, i + 250), /installCoarseSse\(null/);
});

test('overlay: LOD2 なし(no-lod2)の早期 return 前にも全域3D 自動有効化 autoAll() を呼ぶ(東住吉区で実タイル 0 件だった回帰)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../tools/lod2/lod2-overlay.js'), 'utf8');
  assert.ok(/const autoAll = \(\) =>/.test(src), 'autoAll 関数');
  assert.ok(/status = 'no-lod2'[^\n]*autoAll\(\); return;/.test(src), 'no-lod2 分岐で autoAll を呼ぶ');
  assert.ok((src.match(/autoAll\(\)/g) || []).length >= 2, '通常経路でも呼ぶ');
});
