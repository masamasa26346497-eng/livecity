#!/usr/bin/env node
// Mission 95: Mission80 manifest の区エントリを厳格検査（万博 27999 / 2025 以外 / ID 重複 / skipped を拒否）。
import fs from 'node:fs';
export function strictOk(m) {
  return !!m && m.status === 'ok' && String(m.vintage) === '2025' && !String(m.wardCode).startsWith('27999')
    && m.idsUnique === true && m.skipped === 0 && m.buildings > 0;
}
const ward = process.argv[2];
if (ward) {
  const man = JSON.parse(fs.readFileSync('data/reports/mission80/batch-manifest.json', 'utf8'));
  const m = (man.wards || {})[ward];
  console.log(JSON.stringify(m ? { status: m.status, vintage: m.vintage, wardCode: m.wardCode, buildings: m.buildings, idsUnique: m.idsUnique, skipped: m.skipped } : { missing: true }));
  if (!strictOk(m)) { console.error('FAIL: strict check'); process.exit(1); }
}
