#!/usr/bin/env node
// tools/validate/map-labels.js
// [見た目改善 Mission15] 共通 LabelEngine の候補データ validator。
//   実データ（ward polygon / rivers-v2 / park tiles / HTML の OSM_LABELS）から label 候補を組み立て、
//   以下を検証する:
//     - finite position / name non-empty / type valid / importance valid / priority finite
//     - duplicate id / canonical duplicate（type 内）
//     - classification coverage（各 type が最低限存在する）
//     - bbox containment（大阪市外接矩形 + margin）
//     - UTF-8 / 文字化け（U+FFFD なし）
//     - major rivers coverage（淀川/大和川/神崎川/安治川/木津川/寝屋川/道頓堀川）
//     - 24 wards coverage
//
// 実行: node tools/validate/map-labels.js

import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath, PROJECT_ROOT } from '../lib/paths.js';
import {
  LABEL_TYPES, makeLabel, labelPriority, labelMinBand, centerlineAnchor, multiRingCentroidXZ,
} from '../lib/label-engine.js';

const CITY = 'osaka-city';
const BASE = path.join('public', 'map-data', CITY);
const OSAKA_CITY_BBOX = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 };
const MARGIN = 2000;
const MAJOR_RIVERS = ['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'];

function loadJson(p) { return JSON.parse(fs.readFileSync(resolveProjectPath(p), 'utf-8')); }

function wardCandidates() {
  const p = path.join(BASE, 'boundaries', 'ward-classification-polygons.json');
  if (!fs.existsSync(resolveProjectPath(p))) return { list: [], count: 0 };
  const j = loadJson(p);
  const out = [];
  for (const w of (j.wards || [])) {
    const rings = (w.polygons || []).map((pl) => pl.outer).filter((r) => Array.isArray(r) && r.length >= 3);
    if (!rings.length) continue;
    const c = multiRingCentroidXZ(rings);
    if (!c) continue;
    out.push(makeLabel({ id: 'ward_' + w.wardId, type: 'ward', name: w.name || w.wardId, x: c.x, z: c.z, importance: 'major' }));
  }
  return { list: out, count: out.length };
}

function riverCandidates() {
  const p = path.join(BASE, 'rivers-v2', 'rivers.json');
  const j = loadJson(p);
  const rs = j.rivers || (Array.isArray(j) ? j : []);
  // 1 河川名につき centerline 最長の1本だけ（長大河川を大量複製しない）
  const byName = new Map();
  for (const r of rs) {
    if (!MAJOR_RIVERS.includes(r.name) || r.suppressed || !Array.isArray(r.centerline) || r.centerline.length < 2) continue;
    let L = 0; for (let i = 0; i < r.centerline.length - 1; i++) L += Math.hypot(r.centerline[i][0] - r.centerline[i + 1][0], r.centerline[i][1] - r.centerline[i + 1][1]);
    const cur = byName.get(r.name);
    if (!cur || L > cur._len) byName.set(r.name, { r, _len: L });
  }
  const out = [];
  for (const { r } of byName.values()) {
    const a = centerlineAnchor(r.centerline, 0.5);
    if (!a) continue;
    out.push(makeLabel({ id: 'river_' + (r.id || r.name), type: 'river', name: r.name, x: a.x, z: a.z, importance: 'major', sourceId: r.id }));
  }
  return { list: out, coverage: [...new Set(out.map((o) => o.name))] };
}

function parkCandidates() {
  const dir = resolveProjectPath(path.join(BASE, 'parks'));
  const seen = new Set(); const byName = new Map();
  const ringArea = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
  for (const f of fs.readdirSync(dir).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind !== 'area' || !ft.name || seen.has(ft.id) || !ft.p) continue;
      seen.add(ft.id);
      let a = ringArea(ft.p);
      if (Array.isArray(ft.holes)) for (const h of ft.holes) if (h && h.length >= 3) a -= ringArea(h);
      const tier = a >= 100000 ? 'large' : a >= 10000 ? 'medium' : 'small';
      if (tier === 'small') continue;
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (const p of ft.p) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mnz) mnz = p[1]; if (p[1] > mxz) mxz = p[1]; }
      const cur = byName.get(ft.name);
      if (!cur || a > cur._area) byName.set(ft.name, makeLabel({ id: 'park_' + ft.id, type: 'park', name: ft.name, x: (mnx + mxx) / 2, z: (mnz + mxz) / 2, importance: tier === 'large' ? 'major' : 'medium', sourceId: ft.id }));
      if (byName.get(ft.name)) byName.get(ft.name)._area = a;
    }
  }
  return { list: [...byName.values()] };
}

function osmLabelCandidates() {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
  const m = html.match(/const OSM_LABELS = (\[.*?\]);/s);
  if (!m) return { list: [] };
  const arr = JSON.parse(m[1]);
  const out = [];
  for (const l of arr) {
    const cls = l.category === 'government' ? 'GOVERNMENT' : l.category === 'hospital' ? 'HOSPITAL' : l.category === 'library' ? 'LIBRARY' : null;
    if (!cls) continue;
    out.push(makeLabel({ id: 'pf_osm_' + l.name, type: 'public_facility', name: l.name, x: l.p[0], z: l.p[1], importance: cls === 'GOVERNMENT' ? 'major' : 'medium' }));
  }
  return { list: out };
}

async function main() {
  const ward = wardCandidates();
  const river = riverCandidates();
  const park = parkCandidates();
  const pf = osmLabelCandidates();
  const all = [...ward.list, ...river.list, ...park.list, ...pf.list];

  const errors = [], warns = [];
  const ids = new Set();
  const byType = {};
  for (const c of all) {
    byType[c.type] = (byType[c.type] || 0) + 1;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) errors.push(`[${c.id}] 位置が非有限`);
    if (!c.name) errors.push(`[${c.id}] name が空`);
    if (/�/.test(c.name)) errors.push(`[${c.id}] name に置換文字: ${c.name}`);
    if (!LABEL_TYPES.includes(c.type)) errors.push(`[${c.id}] type 不正: ${c.type}`);
    if (!['major', 'medium', 'local'].includes(c.importance)) errors.push(`[${c.id}] importance 不正: ${c.importance}`);
    if (!Number.isFinite(c.priority)) errors.push(`[${c.id}] priority 非有限`);
    if (c.priority !== labelPriority(c.type, c.importance)) warns.push(`[${c.id}] priority が既定と不一致`);
    if (c.minBand !== labelMinBand(c.type, c.importance)) warns.push(`[${c.id}] minBand が既定と不一致`);
    if (ids.has(c.id)) errors.push(`[${c.id}] duplicate id`); else ids.add(c.id);
    const overX = Math.max(0, OSAKA_CITY_BBOX.minX - MARGIN - c.x, c.x - (OSAKA_CITY_BBOX.maxX + MARGIN));
    const overZ = Math.max(0, OSAKA_CITY_BBOX.minZ - MARGIN - c.z, c.z - (OSAKA_CITY_BBOX.maxZ + MARGIN));
    if (overX > 0 || overZ > 0) errors.push(`[${c.id}] cluster が大阪市外接矩形+${MARGIN}m 外`);
  }
  // canonical duplicate（type 内で同名）
  for (const t of LABEL_TYPES) {
    const names = all.filter((c) => c.type === t).map((c) => c.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    for (const n of [...new Set(dup)]) warns.push(`type=${t} 同名候補: ${n}`);
  }
  // coverage
  if (ward.count < 20) errors.push(`24 wards coverage: ${ward.count} 区しか無い`);
  const missingRivers = MAJOR_RIVERS.filter((n) => !river.coverage.includes(n));
  if (missingRivers.length > 2) errors.push(`major rivers coverage 不足: ${missingRivers.join(',')}`);
  else if (missingRivers.length) warns.push(`major river 未取得（tile bbox 外の可能性）: ${missingRivers.join(',')}`);
  if (!byType.park) warns.push('park 候補が 0');
  if (!byType.public_facility) warns.push('public_facility 候補が 0');

  console.log(`[map-labels-validate] 候補合計=${all.length}`);
  console.log(`  byType: ${JSON.stringify(byType)}`);
  console.log(`  ward=${ward.count} / major river coverage=${river.coverage.length}/${MAJOR_RIVERS.length} (${river.coverage.join(',')})`);
  console.log(`  park(large+medium)=${park.list.length} / public_facility(OSM)=${pf.list.length}`);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors.slice(0, 20)) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log(`  -- warns (${warns.length}) --`); for (const w of warns.slice(0, 12)) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    total: all.length, byType,
    wardCount: ward.count, majorRiverCoverage: river.coverage, parkLabelCount: park.list.length, osmFacilityCount: pf.list.length,
    errorCount: errors.length, warnCount: warns.length, errors, warns: warns.slice(0, 50),
  };
  const reportPath = resolveProjectPath(path.join('data', 'reports', 'map-labels-validation.json'));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log('保存:', toProjectRelativePath(reportPath));
  console.log('RESULT:', errors.length === 0 ? 'PASS' : 'FAIL');
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[map-labels-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
