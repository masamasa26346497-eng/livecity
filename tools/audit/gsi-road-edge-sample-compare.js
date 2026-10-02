#!/usr/bin/env node
// tools/audit/gsi-road-edge-sample-compare.js
// [Mission 31G-FIX15 §11-22 / FIX16] sample エリアでの GSI Road Edge ⇔ FIX13 比較・pairing 評価・
//   幹線道路幅比較・adoption recommendation。
//
//   ★ GSI raw data が無い（data/processed/osaka-city/gsi-road-edge/road-edge-lines.json が
//   0 件 or 存在しない）場合は、比較結果を捏造しない。NOT_AVAILABLE として正直に記録する（§20/§23）。
//   全大阪への polygon 化・採用判定はこのスクリプトでは行わない（sample エリア限定・§15/§19）。
//
//   [FIX16] 実データ到着後の本格計測（ward coverage・pairing・named road 幅実測・alignment・
//   adoption score/decision）は tools/audit/gsi-vs-fix13-road-comparison.js（§28 の
//   data/reports/gsi-vs-fix13-road-comparison.json を生成）に実装した。重複した pairing ロジックを
//   2 箇所に持たない（数値の食い違いを避ける）ため、実データがある場合はそちらへ委譲する。
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { geoToLocal } from '../lib/projection.js';
import { OSAKA_PROJECTION } from '../lib/gsi-road-edge-transform.js';
import { main as runFullComparison } from './gsi-vs-fix13-road-comparison.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const GSI_LINES = P('data', 'processed', 'osaka-city', 'gsi-road-edge', 'road-edge-lines.json');
const REPORT = P('data', 'reports', 'gsi-road-edge-prototype.json');
const FIX13_REPORT = P('data', 'reports', 'refined-road-visual-surface.json');

// ── §11 sample エリア（緯度経度は一般的な代表点。既存 HTML の OSAKA_SPOTS と同じ位置付け）──
const SAMPLE_SPOTS = [
  { name: '梅田', lat: 34.7025, lon: 135.4959 }, { name: '本町', lat: 34.6823, lon: 135.5024 },
  { name: '難波', lat: 34.6627, lon: 135.5013 }, { name: '天王寺', lat: 34.6457, lon: 135.5135 },
  { name: '十三', lat: 34.7203, lon: 135.4830 }, { name: '住吉', lat: 34.6115, lon: 135.4928 },
  { name: '中之島', lat: 34.6937, lon: 135.4956 }, { name: '阿倍野', lat: 34.6455, lon: 135.5138 },
  { name: '京橋', lat: 34.6969, lon: 135.5345 }, { name: '平野', lat: 34.6398, lon: 135.5474 },
];
const SAMPLE_HALF_M = 450;
function sampleAreas() {
  return SAMPLE_SPOTS.map((s) => {
    const { x, z } = geoToLocal(s.lat, s.lon, OSAKA_PROJECTION);
    const worldZ = -z;
    return { name: s.name, centerWorld: [x, worldZ], bbox: { minX: x - SAMPLE_HALF_M, maxX: x + SAMPLE_HALF_M, minZ: worldZ - SAMPLE_HALF_M, maxZ: worldZ + SAMPLE_HALF_M } };
  });
}

function readExistingReport() { try { return JSON.parse(fs.readFileSync(REPORT, 'utf-8')); } catch { return {}; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

const NAMED_ROADS = ['御堂筋', '新御堂筋', '中央大通', '玉造筋', '今里筋', 'あびこ筋', '松虫通', '国道1号', '国道25号', '国道43号'];
function buildMajorRoadWidthsWithoutGsi() {
  const fix13 = readJson(FIX13_REPORT);
  const src = (fix13 && fix13.majorRoadWidths) || {};
  const out = {};
  for (const name of NAMED_ROADS) {
    const m = src[name];
    out[name] = {
      gsiWidthM: null, plateauTranWidthM: m ? m.polygonEffW_median : null, fix13VisualWidthM: m ? m.polygonEffW_median : null,
      osmLanesWidthM: m ? m.laneAdvisoryWidthM : null, osmWidthTagM: null, sampleCount: m ? m.samples : 0,
      note: m ? null : '名称属性が canonical road attributes に無い（ref/route 番号は現行 pipeline 未収録）',
    };
  }
  return out;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const areas = sampleAreas();
  const gsi = readJson(GSI_LINES);
  const gsiFeatureCount = gsi && Array.isArray(gsi.features) ? gsi.features.length : 0;

  if (!gsi || gsiFeatureCount === 0) {
    const existing = readExistingReport();
    const report = {
      ...existing,
      generatedAt,
      sampleAreas: areas.map((a) => ({ name: a.name, centerWorld: a.centerWorld })),
      pairing: { high: 0, medium: 0, low: 0, unpaired: 0, note: 'GSI normalized line が 0 件のため pairing 評価は実施不能（NOT_AVAILABLE）' },
      samplePolygonCount: 0,
      majorRoadWidths: buildMajorRoadWidthsWithoutGsi(),
      fix13Comparison: 'NOT_AVAILABLE — GSI road edge データが無いため FIX13 との幾何比較（GSI_NARROWER/WIDER/SIMILAR 等の分類）は実施できない',
      buildingOverlapComparison: 'NOT_AVAILABLE — sample polygon が生成できないため building overlap 比較は実施不能',
      adoptionRecommendation: {
        decision: 'INSUFFICIENT_DATA_NOT_EVALUATED',
        reason: '§22 の採用条件（coverage十分性・精度安定性・pairing実用性・幅の妥当性・道路区域過大問題の改善度・交差点破綻制御・利用条件）はいずれも実 geometry を見なければ判定できない。GSI raw data が data/raw/gsi/road-edge/ に無いため、今回は評価できていない（「GSI が FIX13 より劣る」という判定ではない点に注意）。',
        checklist: {
          coverageSufficient: 'unknown', positionalAccuracyStable: 'unknown', edgePairingPractical: 'unknown',
          majorRoadWidthRealistic: 'unknown', tranOverExtentImproved: 'unknown', intersectionBreakageControlled: 'unknown',
          licenseConditionsClear: 'pending（FIX14: 測量法上の複製・使用申請要否を個別照会する必要あり）',
        },
      },
      RESULT: 'GSI_ROAD_EDGE_RAW_DATA_MISSING',
    };
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    await writeJson(REPORT, report);
    console.log('[gsi-road-edge-sample-compare] GSI normalized line 0 件 → sample 比較は NOT_AVAILABLE として記録');
    console.log('保存: ' + toProjectRelativePath(REPORT));
    return;
  }

  // [FIX16] 実データがある場合は、pairing/幅実測/alignment/adoption score を一元管理している
  //   tools/audit/gsi-vs-fix13-road-comparison.js に委譲する（gsi-road-edge-prototype.json も
  //   そちら側で更新される。ここで独自の簡易 pairing を再実装すると数値が食い違うため行わない）。
  console.log('[gsi-road-edge-sample-compare] GSI normalized line ' + gsiFeatureCount + ' 件 → gsi-vs-fix13-road-comparison.js に委譲');
  await runFullComparison();
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[gsi-road-edge-sample-compare] 失敗:', e && e.stack || e); process.exit(1); });
