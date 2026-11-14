'use strict';
// Mission 198: ID 監査の fail-closed 動作(合成 fixture。実データの照合は実ビルド時に build が行う)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mk(leaves, excluded, groupExtra) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idaudit-'));
  fs.mkdirSync(path.join(d, 'ids'));
  leaves.forEach((l, i) => fs.writeFileSync(path.join(d, 'ids', `t_${i}.json`), JSON.stringify(l)));
  if (groupExtra) fs.writeFileSync(path.join(d, 'ids', 'g_0.json'), JSON.stringify(groupExtra));
  if (excluded) fs.writeFileSync(path.join(d, 'lod1-excluded-ids.json'), JSON.stringify({ count: excluded.length, ids: excluded }));
  return d;
}
const load = () => import('../tools/cloud/lod1-id-audit.mjs');

test('正常: 元4 = 補完2 + 除外2、g_ は数えない', async () => {
  const { auditWard } = await load();
  const orig = mk([['a', 'b'], ['c', 'd']], null, ['a', 'b', 'c', 'd']);
  const supp = mk([['a'], ['c']], ['b', 'd'], ['a', 'c']);
  const r = auditWard({ id: 't', origDir: orig, suppDir: supp, lod2Ids: new Set(['b', 'd', 'zz']), origBuildings: 4, suppBuildings: 2, excludedCount: 2 });
  assert.strictEqual(r.doubleDrawn, 0); assert.strictEqual(r.lod2CoveredInOrig, 2);
});
test('fail closed: 想定外フォーマット / 0 件 / ダブり / 除外漏れ / 件数不一致', async () => {
  const { auditWard } = await load();
  const o = mk([['a', 'b']]);
  const base = { id: 't', origDir: o, lod2Ids: new Set(['b']), origBuildings: 2, suppBuildings: 1, excludedCount: 1 };
  assert.throws(() => auditWard({ ...base, suppDir: mk([{ ids: ['a'] }], ['b']) }), /配列ではない/);
  assert.throws(() => auditWard({ ...base, suppDir: mk([[]], ['b']) }), /0 件/);
  assert.throws(() => auditWard({ ...base, suppDir: mk([['a', 'b']], ['b']), suppBuildings: 2 }), /元 ≠ 補完 \+ 除外|残存/);
  assert.throws(() => auditWard({ ...base, lod2Ids: new Set(['a', 'b']), suppDir: mk([['a']], ['b']) }), /除外漏れ|残存/);
  assert.throws(() => auditWard({ ...base, suppBuildings: 3, suppDir: mk([['a']], ['b']) }), /≠ 棟数/);
  assert.throws(() => auditWard({ ...base, suppDir: mk([['a']]) }), /excluded-ids/);
});
test('build は auditWard を使い cloud-preview.json に idAudit を出す', () => {
  const b = fs.readFileSync(path.join(__dirname, '../tools/cloud/build-cloud-preview.mjs'), 'utf8');
  assert.ok(b.includes('auditWard(') && b.includes('idAuditedIds: w.idAuditedIds') && b.includes('idAudit: w.idAudit'));
});
