// Mission 36L cost guard: pessimistic, fail-closed local reservation ledger.
// The ledger covers only callers using this module. Cloud project quotas remain necessary.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_COST_GUARD = Object.freeze({
  monthlyBudgetYen: 3000,
  estimatedYenPerRequest: 10, // conservative planning allowance, NOT Google's published price
  dailyRequestCap: 50,
  runRequestCap: 10,
});

export function jstPeriod(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('invalid clock');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type) => parts.find((x) => x.type === type)?.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  return { month: day.slice(0, 7), day };
}

export function checkReservation({ ledger, month, day, runId, config }) {
  const { monthlyBudgetYen, estimatedYenPerRequest, dailyRequestCap, runRequestCap } = config;
  if (![monthlyBudgetYen, estimatedYenPerRequest, dailyRequestCap, runRequestCap].every((v) => Number.isSafeInteger(v) && v > 0)) throw new Error('invalid cost guard settings');
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(runId)) throw new Error('invalid runId');
  if (ledger && (ledger.version !== 1 || typeof ledger.month !== 'string' || !Array.isArray(ledger.reservations))) throw new Error('invalid ledger');
  const rows = ledger?.month === month ? ledger.reservations : [];
  if (rows.some((r) => !r || r.day > day || !Number.isSafeInteger(r.estimatedYen) || r.estimatedYen <= 0 || !r.runId || !r.day)) throw new Error('invalid ledger reservations');
  const spent = rows.reduce((sum, r) => sum + r.estimatedYen, 0);
  const daily = rows.filter((r) => r.day === day).length;
  const perRun = rows.filter((r) => r.runId === runId).length;
  if (spent + estimatedYenPerRequest > monthlyBudgetYen) throw new Error('MONTHLY_BUDGET_EXHAUSTED');
  if (daily >= dailyRequestCap) throw new Error('DAILY_REQUEST_CAP_EXHAUSTED');
  if (perRun >= runRequestCap) throw new Error('RUN_REQUEST_CAP_EXHAUSTED');
  return { version: 1, month, reservations: [...rows, { day, runId, estimatedYen: estimatedYenPerRequest }] };
}

// Lock acquisition uses exclusive create. An abandoned lock deliberately blocks new requests
// until an operator investigates; never auto-break it and risk duplicate paid calls.
export async function reservePlacesRequest({ ledgerPath, runId, now = () => new Date(), config = DEFAULT_COST_GUARD }) {
  if (!path.isAbsolute(ledgerPath)) throw new Error('ledgerPath must be absolute');
  const lockPath = ledgerPath + '.lock';
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    let ledger = null;
    try { ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const { month, day } = jstPeriod(now());
    const next = checkReservation({ ledger, month, day, runId, config });
    const tmp = ledgerPath + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, ledgerPath);
    } finally { await fs.rm(tmp, { force: true }); }
    return { month, day, reservations: next.reservations.length,
      estimatedYen: next.reservations.reduce((sum, x) => sum + x.estimatedYen, 0) };
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
