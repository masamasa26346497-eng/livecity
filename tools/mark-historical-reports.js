#!/usr/bin/env node
// tools/mark-historical-reports.js
// [Mission 32P §26 / 35E] 「V1 建物を前提にしていた過去レポート」へ印を付け直す。
//
//   32P はこの印を手で付けた。そのため **そのレポートを再生成すると印が消える**。
//   35E で ROAD V3 を作り直した際に data/reports/road-visual-v3.json の印が消え、
//   32P の test が落ちて気付いた。再生成のたびに手で直すのは現実的でないので、
//   index（historical-invalidated-by-v2.json）を正本にして印を貼り直せるようにする。
//
//   レポートの中身は変えない。historicalStatus を足すだけ。
//   実行: node tools/mark-historical-reports.js [--check]
//   出力: data/reports/<各レポート>.json の historicalStatus
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const INDEX = P('data', 'reports', 'historical-invalidated-by-v2.json');
export const STATUS = 'historical-invalidated-by-v2';
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/** index の 1 件から historicalStatus を組み立てる。 */
export function statusFor(entry, now = new Date().toISOString()) {
  return {
    status: STATUS,
    markedAt: entry.markedAt || now,
    markedBy: entry.markedBy || 'Mission 32P §26',
    reason: entry.reason || 'V1 建物（第7系・0.93° 回転）を前提にした判定のため',
    supersededBy: entry.supersededBy || [],
  };
}

export function run({ check = false } = {}) {
  const idx = rj(INDEX);
  if (!idx || !Array.isArray(idx.invalidated)) throw new Error('index が無い: ' + INDEX);
  const results = [];
  for (const e of idx.invalidated) {
    const p = resolveProjectPath(e.json);
    const doc = rj(p);
    if (!doc) { results.push({ json: e.json, ok: false, reason: '読めない' }); continue; }
    const has = doc.historicalStatus && doc.historicalStatus.status === STATUS;
    if (has) { results.push({ json: e.json, ok: true, action: 'already' }); continue; }
    if (check) { results.push({ json: e.json, ok: false, action: 'missing' }); continue; }
    // 既に印のある別レポートから markedAt / supersededBy を引き継ぐ（時刻がばらけないように）
    const donor = idx.invalidated.map((q) => rj(resolveProjectPath(q.json)))
      .find((d) => d && d.historicalStatus && d.historicalStatus.status === STATUS);
    const base = { ...e };
    if (donor) {
      base.markedAt = base.markedAt || donor.historicalStatus.markedAt;
      base.markedBy = base.markedBy || donor.historicalStatus.markedBy;
      base.supersededBy = base.supersededBy || donor.historicalStatus.supersededBy;
    }
    doc.historicalStatus = statusFor(base);
    fs.writeFileSync(p, JSON.stringify(doc, null, 2));
    results.push({ json: e.json, ok: true, action: 'marked' });
  }
  return { index: INDEX, checked: results.length, results,
    allMarked: results.every((r) => r.ok) };
}

if (isMainModule(import.meta.url)) {
  const check = process.argv.includes('--check');
  const o = run({ check });
  for (const r of o.results) console.log('[historical]', (r.action || r.reason || '').padEnd(10), r.json);
  console.log('[historical] すべて印あり:', o.allMarked);
  process.exit(o.allMarked ? 0 : 1);
}
