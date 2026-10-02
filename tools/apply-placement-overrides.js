#!/usr/bin/env node
// tools/apply-placement-overrides.js
// [Mission 32Q §10-§13] V2 placement policy へ、個別に確認した建物の判定だけを上書きする。
//   placement 全体（600,764 棟）は再生成しない。対象 tile と manifest の集計だけを書き換える。
//   上書きの根拠は data/processed/osaka-city/v2-final/placement-overrides.json に残す。
//   書き込みは synced-dir-writer（removeStray:false = 対象ファイル以外に触れない）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const PO = {
  overrides: P('data', 'processed', 'osaka-city', 'v2-final', 'placement-overrides.json'),
  overlaps: P('data', 'processed', 'osaka-city', 'v2-final', 'building-overlaps.json'),
  dataDir: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-placement'),
  publicDir: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement'),
  buildings: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  wardIndex: P('data', 'processed', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'),
  publicRoot: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2'),
  wardIndexReport: P('data', 'reports', 'ward-building-index-v2-final.json'),
  policyReport: P('data', 'reports', 'v2-placement-policy.json'),
};
const rj = (p) => JSON.parse(readFileRetry(p));

export function applyPlacementOverrides() {
  const ov = rj(PO.overrides);
  const overlaps = rj(PO.overlaps);
  const tileOf = new Map(overlaps.buildings.map((b) => [b.id, b.tile]));
  const manifest = rj(path.join(PO.dataDir, 'manifest.json'));
  const files = new Map();
  const applied = [];
  const delta = { DISPLAY: 0, SUPPRESS: 0, REVIEW: 0, EXEMPT: 0 };
  for (const o of ov.overrides) {
    const tile = tileOf.get(o.canonicalId);
    if (!tile) throw new Error('overlap 記録に無い建物: ' + o.canonicalId);
    const file = `tile_${tile}.json`;
    const t = files.has(file) ? JSON.parse(files.get(file)) : rj(path.join(PO.dataDir, file));
    const cur = t.policies[o.canonicalId];
    const from = cur ? cur.policy : 'DISPLAY';
    if (from !== o.expectedFrom && from !== o.policy) throw new Error(`${o.canonicalId}: 現在の判定 ${from} が想定 ${o.expectedFrom} と違う`);
    if (from !== o.policy) {
      delta[from]--; delta[o.policy]++;
      t.policies[o.canonicalId] = { ...(cur || {}), policy: o.policy, reason: o.reason, individualReview: { mission: '32Q', previous: from, evidence: o.evidence } };
      files.set(file, JSON.stringify(t));
    }
    applied.push({ canonicalId: o.canonicalId, from, to: o.policy, file });
  }
  if (!files.size) return { applied, changed: 0 };
  for (const k of Object.keys(delta)) manifest.policyCounts[k] += delta[k];
  manifest.individualOverrides = { mission: '32Q', file: toProjectRelativePath(PO.overrides), count: ov.overrides.length, applied };
  files.set('manifest.json', JSON.stringify(manifest, null, 2));
  writeFilesVerified(PO.dataDir, files, { label: 'placement overrides', settleMs: 5000, removeStray: false });
  writeFilesVerified(PO.publicDir, files, { label: 'public placement overrides', settleMs: 5000, removeStray: false });

  // ward index の suppress / renderable 集計を最新の placement で作り直す（建物・区の割当は不変）
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', P('tools', 'build-ward-building-index.js')], {
    env: { ...process.env, WARD_INDEX_BUILD_DIR: PO.buildings, WARD_INDEX_ATTR_DIR: path.join(PO.buildings, 'attributes'), WARD_INDEX_PLACE_DIR: PO.dataDir, WARD_INDEX_OUT: PO.wardIndex, WARD_INDEX_REPORT: PO.wardIndexReport },
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('ward index 更新に失敗');
  writeFilesVerified(PO.publicRoot, new Map([['building-ward-index.json', readFileRetry(PO.wardIndex)]]), { label: 'public ward index', settleMs: 5000, removeStray: false });

  // 32P の placement レポートへ個別判断を追記（集計値も同じ差分で更新）
  const rep = rj(PO.policyReport);
  for (const k of Object.keys(delta)) rep.policyCounts[k] += delta[k];
  for (const a of applied) {
    const o = ov.overrides.find((x) => x.canonicalId === a.canonicalId);
    if (a.from === a.to) continue;
    const fromKey = Object.keys(rep.byReason).find((k) => k.startsWith(a.from + ' '));
    if (fromKey && a.from === 'SUPPRESS') { rep.byReason[fromKey]--; if (!rep.byReason[fromKey]) delete rep.byReason[fromKey]; }
    const toKey = a.to + ' ' + o.reason.split(':')[0];
    rep.byReason[toKey] = (rep.byReason[toKey] || 0) + 1;
  }
  rep.individualOverrides = { mission: '32Q', file: toProjectRelativePath(PO.overrides), applied, delta };
  fs.writeFileSync(PO.policyReport, JSON.stringify(rep, null, 2));
  return { applied, delta, changed: files.size - 1, policyCounts: manifest.policyCounts };
}

if (isMainModule(import.meta.url)) {
  try { console.log('[placement-overrides]', JSON.stringify(applyPlacementOverrides())); }
  catch (e) { console.error('[placement-overrides] 失敗:', e && e.stack || e); process.exit(1); }
}
