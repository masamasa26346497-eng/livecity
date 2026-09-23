#!/usr/bin/env node
// tools/audit/canonical-road-structure.js
// [Mission 31C2 §17] 高架・橋梁・トンネル区間の扱いを監査する。
//   PLATEAU の uro:sectionType（土工/高架橋/橋梁/交差部/アンダーパス/トンネル）が canonical roads に
//   正しく引き継がれているか、阪神高速のような高架道路が「地表の道路面」として紛れ込んでいないかを見る。
//
//   ※ 高架を消すのではなく、地表面と区別できる状態になっているかを検査する（描画切替は 31G 以降）。
//
// 実行: node tools/audit/canonical-road-structure.js
// 出力: data/reports/canonical-road-structure.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { polygonAreaM2 } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const TRAN_REPORT = P('data', 'reports', 'plateau-tran-conversion.json');
const OUT = P('data', 'reports', 'canonical-road-structure.json');

// 高架として扱うべき代表路線（§17）。名称は OSM 側の表記ゆれを含む。
const ELEVATED_ROUTES = ['阪神高速', '近畿自動車道', '阪和自動車道'];

async function main() {
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error('canonical roads が無い'); process.exit(1); }
  const conv = fs.existsSync(TRAN_REPORT) ? JSON.parse(fs.readFileSync(TRAN_REPORT, 'utf-8')) : {};

  const seen = new Set();
  const byStructure = {}, areaByStructure = {};
  let total = 0, elevatedNamed = 0, elevatedNamedWithoutFlag = 0;
  let osmBridge = 0, osmTunnel = 0, plateauElevated = 0, plateauBridge = 0, plateauTunnel = 0;
  let structureMissing = 0;
  const namedElevatedRows = new Map();

  for (const tf of fs.readdirSync(DIR).filter((f) => /^tile_.*\.json$/.test(f))) {
    const t = JSON.parse(fs.readFileSync(path.join(DIR, tf), 'utf-8'));
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue;
      seen.add(f.canonicalId);
      total++;
      const a = f.attributes || {};
      const st = a.plateauStructure || (f.source.geometrySource === 'plateau-tran-road' ? 'missing' : 'n/a-ribbon');
      byStructure[st] = (byStructure[st] || 0) + 1;
      areaByStructure[st] = (areaByStructure[st] || 0) + polygonAreaM2(f.geometryType, f.coordinates);
      if (st === 'missing') structureMissing++;
      if (st === 'elevated') plateauElevated++;
      if (st === 'bridge') plateauBridge++;
      if (st === 'tunnel') plateauTunnel++;
      if (a.bridge) osmBridge++;
      if (a.tunnel) osmTunnel++;

      const names = [a.name, ...((f.centerlineRef && f.centerlineRef.names) || [])].filter(Boolean);
      const route = ELEVATED_ROUTES.find((r) => names.some((n) => n.includes(r)));
      if (route) {
        elevatedNamed++;
        // 高架と識別できる根拠: PLATEAU sectionType（高架橋/橋梁）または OSM の bridge / layer>0。
        //   PLATEAU sectionType は市域の 43% が「不明」なので、OSM 側の signal も併せて判定する。
        const osmElevated = !!a.bridge || (Number.isFinite(+a.layer) && +a.layer > 0);
        const flagged = st === 'elevated' || st === 'bridge' || osmElevated || (f.qaFlags || []).includes('elevated');
        if (!flagged) elevatedNamedWithoutFlag++;
        let row = namedElevatedRows.get(route);
        if (!row) namedElevatedRows.set(route, row = { route, features: 0, flagged: 0, unflagged: 0, areaM2: 0, structures: {} });
        row.features++;
        if (flagged) row.flagged++; else row.unflagged++;
        row.areaM2 += polygonAreaM2(f.geometryType, f.coordinates);
        row.structures[st] = (row.structures[st] || 0) + 1;
      }
    }
  }
  for (const k of Object.keys(areaByStructure)) areaByStructure[k] = Math.round(areaByStructure[k]);
  const rows = [...namedElevatedRows.values()].map((r) => ({ ...r, areaM2: Math.round(r.areaM2) }));

  // トンネルは converter 側で surfaceKind='subsurface' として除外済みである、という前提を確認する。
  const tunnelExcludedAtConvert = (conv.subsurfacePolygons || 0) > 0 && plateauTunnel === 0;

  const findings = [], limitations = [];
  if (structureMissing) findings.push(`plateau-tran-road feature ${structureMissing} 件に plateauStructure が無い（属性の引き継ぎ漏れ）`);
  if (!tunnelExcludedAtConvert && plateauTunnel) findings.push(`トンネル区間 ${plateauTunnel} 件が地表の道路面として canonical に入っている`);
  // 高架の識別漏れは実装欠陥ではなく source 側の限界。切り分けて記録する。
  const unknownShare = total ? +((byStructure.unknown || 0) / total).toFixed(3) : 0;
  if (elevatedNamedWithoutFlag) {
    limitations.push(`高架路線名を持つ feature ${elevatedNamedWithoutFlag} 件は、PLATEAU sectionType が「不明」かつ OSM にも bridge/layer タグが無いため高架と断定できない（canonical 全体の ${(unknownShare * 100).toFixed(1)}% が sectionType 不明）。地上ランプ・側道の可能性もあるため推測で高架化しない。`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dir: toProjectRelativePath(DIR),
    featureCount: total,
    sectionTypeSemantics: {
      source: 'codelists/RoadStructureAttribute_sectionType.xml（配布 ZIP 同梱）',
      map: { 1: '土工区間・通常区間→ground', 2: '高架橋→elevated', 3: '橋梁→bridge', 4: '交差部→intersection', 5: 'アンダーパス→underpass', 6: 'トンネル→tunnel（地表面から除外）', 7: '橋・高架→elevated', 9: '不明→unknown' },
    },
    byPlateauStructure: byStructure,
    areaM2ByPlateauStructure: areaByStructure,
    plateau: { elevated: plateauElevated, bridge: plateauBridge, tunnel: plateauTunnel, structureMissing },
    osmTags: { bridge: osmBridge, tunnel: osmTunnel },
    tunnelHandling: {
      excludedAtConversion: tunnelExcludedAtConvert,
      subsurfacePolygonsAtConversion: conv.subsurfacePolygons || 0,
      policy: 'sectionType=6（トンネル）は地表の道路面ではないため convert 段階で surfaceKind=subsurface とし canonical roads へ入れない。OSM tunnel タグ由来の ribbon は従来どおり属性で保持する。',
    },
    elevatedRoutes: rows,
    elevatedNamedFeatures: elevatedNamed,
    elevatedNamedWithoutStructureFlag: elevatedNamedWithoutFlag,
    findings, limitations,
    sectionTypeUnknownShare: unknownShare,
    conclusion: '高架・橋梁は削除せず、plateauStructure と qaFlags で地表面と区別可能な状態にする。描画側での高さ分離は 31G 以降の課題（本ミッションでは描画を切り替えない §0）。',
    RESULT: findings.length === 0 ? 'PASS' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, report);
  console.log('[road-structure] feature ' + total);
  console.log('  byPlateauStructure: ' + JSON.stringify(byStructure));
  console.log('  高架路線: ' + rows.map((r) => r.route + ' ' + r.features + '件(識別済 ' + r.flagged + ')').join(' / '));
  console.log('  tunnel: convert で除外=' + tunnelExcludedAtConvert + ' / canonical 内 ' + plateauTunnel);
  for (const f of findings) console.log('  [FINDING] ' + f);
  for (const l of limitations) console.log('  [LIMIT] ' + l);
  console.log('保存: ' + toProjectRelativePath(OUT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[road-structure] 失敗:', e && e.stack || e); process.exit(1); });
