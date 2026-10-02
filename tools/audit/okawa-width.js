#!/usr/bin/env node
// tools/audit/okawa-width.js
// [追加修正タスク §1/§2] 大川（および強実測 named river 群）の幅を監査する。
//   現在の centerline 長 / widths[] 統計 / smoothing 前後 / 建物干渉による shrink / riverbank 実測。
//   出力: data/reports/okawa-width-audit.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { resolveRiverWidth } from '../lib/river-width.js';
import { normalizeRiverName, polylineLengthXZ } from '../lib/river-network.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SRC_DIR = P('public', 'map-data', 'osaka-city', 'waterways');
const RIVERS = P('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json');
const REPORT = P('data', 'reports', 'okawa-width-audit.json');

const RIBBON_CLASSES = new Set(['river', 'canal', 'stream']);
// §3 重点: 大川。ただし一般化ロジック検証のため強実測 named river 群も並べる。
const FOCUS = ['大川', '堂島川', '土佐堀川', '寝屋川', '安治川', '木津川', '大和川', '淀川', '道頓堀川', '尻無川', '中島川', '三十間堀川'];

function stat(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return { count: a.length, min: +a[0].toFixed(2), median: +p(0.5).toFixed(2), max: +a[a.length - 1].toFixed(2), p95: +p(0.95).toFixed(2) };
}

function loadFeatures() {
  const byId = new Map();
  for (const f of fs.readdirSync(SRC_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) if (!byId.has(ft.id)) byId.set(ft.id, ft);
  }
  return [...byId.values()];
}

async function main() {
  const feats = loadFeatures();
  const lines = feats.filter((f) => f.kind === 'line' && RIBBON_CLASSES.has(f.waterClass) && f.surface !== false);
  const riverbanks = feats.filter((f) => f.kind === 'area' && (RIBBON_CLASSES.has(f.waterClass) || f.waterClass === 'river'));
  const rj = JSON.parse(fs.readFileSync(RIVERS, 'utf-8'));

  const byName = {};
  for (const nm of FOCUS) {
    const key = normalizeRiverName(nm);
    const srcSegs = lines.filter((l) => normalizeRiverName(l.name || '') === key);
    const built = (rj.rivers || []).filter((r) => r.normName === key && r.ok);
    if (!srcSegs.length && !built.length) { byName[nm] = { resolved: false }; continue; }

    // §2: source geometry から幅を再計測（riverbank polygon で横断計測）
    const measures = srcSegs.map((l) => {
      const w = resolveRiverWidth(l, riverbanks, { bufferM: 300 });
      return {
        sourceId: l.source ? `${l.source.type}/${l.source.id}` : l.id,
        lengthM: Math.round(polylineLengthXZ(l.p)),
        method: w.method, measuredWidth: w.width != null ? +w.width.toFixed(2) : null,
        matchedRiverbanks: w.matchedRiverbanks || 0, sampleCount: w.sampleCount || 0,
        rawSamples: (w.samples || []).map((x) => +x.toFixed(1)),
      };
    });

    // 現在描画されている widths[]（rivers.json）
    const drawn = built.map((r) => ({
      id: r.id, class: r.riverClass, waterwayTag: r.waterwayTag,
      centerlineLengthM: Math.round(r.centerlineLength || 0),
      widthRawInput: r.widthRaw, widthMethod: r.widthMethod, widthSmoothed: !!r.widthSmoothed,
      widthMatchedRiverbanks: r.widthMatchedRiverbanks, widthSampleCount: r.widthSampleCount,
      widthsStat: stat(r.widths || []),
      conflictAction: r.conflictAction, conflictWidthScale: r.conflictWidthScale,
      conflictEdgeInFrac: r.conflictEdgeInFrac, conflictCenterInFrac: r.conflictCenterInFrac,
      finalMedianWidth: r.widthMedian,
      triangleCount: r.triangleCount, maxTriangleEdge: r.maxTriangleEdge, maxTriangleArea: r.maxTriangleArea,
      bbox: r.bbox, validationErrors: r.validationErrors || [], validationWarns: r.validationWarns || [],
    }));

    const allMeasured = measures.flatMap((m) => m.rawSamples);
    byName[nm] = {
      resolved: true,
      sourceSegmentCount: srcSegs.length,
      sourceIds: srcSegs.map((l) => (l.source ? `${l.source.type}/${l.source.id}` : l.id)),
      sourceLengthM: measures.reduce((s, m) => s + m.lengthM, 0),
      measurement: {
        perSegment: measures,
        allRawSamples: stat(allMeasured),
        strongMeasurement: measures.some((m) => m.method === 'measured' && m.matchedRiverbanks >= 6 && m.measuredWidth >= 45),
      },
      drawn,
      // §1 diagnosis
      diagnosis: (() => {
        const shrunk = drawn.filter((d) => (d.conflictAction === 'shrink' || d.conflictAction === 'thin') && (d.conflictWidthScale || 1) < 0.5);
        if (shrunk.length && measures.some((m) => m.method === 'measured' && m.matchedRiverbanks >= 6 && m.measuredWidth >= 45)) {
          return `強実測（riverbank ${measures.map((m) => m.matchedRiverbanks).join('/')}）で幅 ${measures.map((m) => m.measuredWidth).join('/')}m だが、建物干渉回避で ${shrunk.map((d) => d.conflictWidthScale).join('/')} 倍まで縮小され最終 median ${shrunk.map((d) => d.finalMedianWidth).join('/')}m ＝過剰 shrink。`;
        }
        return '幅は妥当（実測 or default に近い）。';
      })(),
    };
  }

  const okawa = byName['大川'] || {};
  const report = {
    generatedAt: new Date().toISOString(),
    method: 'rivers-v2/rivers.json の widths[] と waterways tile の line/riverbank から幅を再計測して比較。強実測 named river の過剰 shrink を検出。',
    focus: '大川',
    okawa,
    riverbankPolygonSource: toProjectRelativePath(SRC_DIR),
    others: Object.fromEntries(Object.entries(byName).filter(([k]) => k !== '大川')),
    RESULT: okawa.resolved ? 'AUDIT-DONE' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[okawa-width-audit] 大川:');
  if (okawa.resolved) {
    console.log('  source: ' + okawa.sourceIds.join(', ') + '  length ' + okawa.sourceLengthM + 'm');
    console.log('  measurement: ' + JSON.stringify(okawa.measurement.perSegment.map((m) => ({ rb: m.matchedRiverbanks, w: m.measuredWidth, samples: m.sampleCount }))));
    console.log('  allRawSamples: ' + JSON.stringify(okawa.measurement.allRawSamples));
    console.log('  drawn: ' + JSON.stringify(okawa.drawn.map((d) => ({ rawInput: d.widthRawInput, method: d.widthMethod, conflict: d.conflictAction, scale: d.conflictWidthScale, finalMedian: d.finalMedianWidth, edgeInFrac: d.conflictEdgeInFrac }))));
    console.log('  diagnosis: ' + okawa.diagnosis);
  } else console.log('  UNRESOLVED');
  console.log('保存: ' + toProjectRelativePath(REPORT));
}

main().catch((e) => { console.error('[okawa-width-audit] 失敗:', e && e.stack || e); process.exitCode = 1; });
