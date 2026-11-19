'use strict';
// Mission 206: single-pass 監査(元=補完+除外)の fail closed を fixture で検証(ネットワーク不要)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mk(supp, excluded) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  fs.mkdirSync(path.join(d, 'ids'));
  fs.writeFileSync(path.join(d, 'ids', 't_0.json'), JSON.stringify(supp));
  fs.writeFileSync(path.join(d, 'ids', 'g_0.json'), JSON.stringify(supp)); // g_ は数えない
  fs.writeFileSync(path.join(d, 'lod1-excluded-ids.json'), JSON.stringify({ count: excluded.length, ids: excluded }));
  return d;
}

test('single-pass 監査: 正常 / 残存 / 過剰除外 / 件数不一致', async () => {
  const { auditSinglePass } = await import('../tools/cloud/lod1-id-audit.mjs');
  const lod2 = new Set(['e1', 'e2', 'z9']);
  const ok = mk(['a', 'b'], ['e1', 'e2']);
  const r = auditSinglePass({ id: 'x', suppDir: ok, lod2Ids: lod2, suppBuildings: 2, excludedCount: 2, inWard: 4 });
  assert.strictEqual(r.origIds, 4); assert.strictEqual(r.doubleDrawn, 0);
  assert.throws(() => auditSinglePass({ id: 'x', suppDir: mk(['a', 'z9'], ['e1']), lod2Ids: lod2, suppBuildings: 2, excludedCount: 1, inWard: 3 }), /残存/);
  assert.throws(() => auditSinglePass({ id: 'x', suppDir: mk(['a'], ['nope']), lod2Ids: lod2, suppBuildings: 1, excludedCount: 1, inWard: 2 }), /過剰除外/);
  assert.throws(() => auditSinglePass({ id: 'x', suppDir: ok, lod2Ids: lod2, suppBuildings: 2, excludedCount: 2, inWard: 5 }), /inWard/);
});

test('build は --all-wards で single-pass、ガード、2 パス再変換を行わない', () => {
  const b = fs.readFileSync(path.join(__dirname, '..', 'tools/cloud/build-cloud-preview.mjs'), 'utf8');
  for (const s of ["'--all-wards'", 'legacy-two-pass', 'statfsSync', '時間ガード', '空きディスク不足', '自主上限']) assert.ok(b.includes(s), s);
});
