import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jstPeriod, checkReservation, reservePlacesRequest } from '../tools/google-places/lib/monthly-cost-guard.mjs';

const config = { monthlyBudgetYen: 30, estimatedYenPerRequest: 10, dailyRequestCap: 2, runRequestCap: 2 };
test('JST day and month boundaries', () => {
  assert.deepEqual(jstPeriod(new Date('2026-09-30T15:01:00Z')), { day: '2026-10-01', month: '2026-10' });
  assert.deepEqual(jstPeriod(new Date('2026-10-31T15:01:00Z')), { day: '2026-11-01', month: '2026-11' });
});
test('budget and caps fail closed', () => {
  const p = { month: '2026-10', day: '2026-10-09', runId: 'r1', config };
  assert.throws(() => checkReservation({ ...p, ledger: null }), /MISSING_LEDGER/);
  const a = checkReservation({ ...p, ledger: { version: 1, month: '2026-10', reservations: [] } });
  const b = checkReservation({ ...p, ledger: a });
  assert.throws(() => checkReservation({ ...p, ledger: b }), /DAILY_REQUEST_CAP/);
  assert.throws(() => checkReservation({ ...p, ledger: b, day: '2026-10-10' }), /RUN_REQUEST_CAP/);
  const c = checkReservation({ ...p, ledger: b, day: '2026-10-10', runId: 'r2' });
  assert.throws(() => checkReservation({ ...p, ledger: c, day: '2026-10-10', runId: 'r3' }), /MONTHLY_BUDGET/);
  assert.equal(checkReservation({ ...p, ledger: c, month: '2026-11', day: '2026-11-01' }).reservations.length, 1);
  assert.throws(() => checkReservation({ ...p, ledger: { version: 1, month: '2026-10', reservations: [{ estimatedYen: -1 }] } }), /invalid ledger/);
  assert.throws(() => checkReservation({ ...p, ledger: { version: 1, month: '2026-11', reservations: [] } }), /FUTURE_LEDGER/);
});
test('atomic file reservation, lock rejection and corrupt ledger rejection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-cost-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const approval = { approved: true, runId: 'r1', api: 'places.searchText', maxRequests: 2,
    maxEstimatedYen: 20, expiresAt: '2026-10-09T01:00:00Z' };
  const args = { ledgerPath, runId: 'r1', approval, config, now: () => new Date('2026-10-09T00:00:00Z') };
  try {
    await assert.rejects(reservePlacesRequest(args), /MISSING_LEDGER/);
    await fs.writeFile(ledgerPath, JSON.stringify({ version: 1, month: '2026-10', reservations: [] }));
    assert.equal((await reservePlacesRequest(args)).estimatedYen, 10);
    assert.equal((await reservePlacesRequest(args)).estimatedYen, 20);
    await assert.rejects(reservePlacesRequest(args), /APPROVAL_BUDGET_EXCEEDED/);
    await assert.rejects(reservePlacesRequest({ ...args, approval: null }), /APPROVAL_REQUIRED/);
    await fs.writeFile(ledgerPath + '.lock', 'blocked');
    await assert.rejects(reservePlacesRequest(args), { code: 'EEXIST' });
    await fs.unlink(ledgerPath + '.lock');
    await fs.writeFile(ledgerPath, 'not-json');
    await assert.rejects(reservePlacesRequest(args), SyntaxError);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
