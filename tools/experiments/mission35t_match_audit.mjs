// tools/experiments/mission35t_match_audit.mjs
// [Mission 35T §1-§5/§9] Custom LOD2 の照合精度を確定させる。
//
//   §1 OSM way 267613423 の footprint を出す（途中で別の建物へ置き換えない）
//   §2 source 重心から 100m 以内の canonical 候補を **全部** 出す（最寄り 1 棟だけを選ばない）
//   §3 IoU 主体で HIGH / MEDIUM / AMBIGUOUS / UNMATCHED を決める
//   §4 best と second を比べて、断定できないときは AMBIGUOUS
//   §5 高さの食い違いの原因を調べる材料を出す
//
//   出力: data/reports/mission35t-custom-lod2-matching/{SUMMARY.md,candidates.json}
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath } from '../lib/paths.js';
import {
  ringArea, ringBbox, ringCentroid, evaluateCandidate, decideMatch,
  rankCandidates, MATCH_RULES,
} from '../lib/footprint-match.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = {
  custom: P('public', 'map-data', 'osaka-city', 'experimental', 'mission35s', 'custom-lod2-267613423.json'),
  buildings: P('public', 'map-data', 'osaka-city', 'derived-v4-final', 'near', 'buildings'),
};
export const OUT_DIR = P('data', 'reports', 'mission35t-custom-lod2-matching');

const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

/** 35S が採用していた canonicalId（維持 / 棄却を明示するため）。 */
export const MISSION35S_CANONICAL_ID = 'cg_bldg_bldg_be65d290-931f-441a-ac8c-b71f09c8728d';

/** source 重心の周囲のタイルだけ読む（500m グリッド）。 */
function loadNearbyBuildings(dir, cx, cz, radiusM) {
  const n = Math.ceil(radiusM / 500) + 1;
  const tx = Math.floor(cx / 500), tz = Math.floor(cz / 500);
  const out = [];
  const seen = new Set();
  for (let dx = -n; dx <= n; dx++) {
    for (let dz = -n; dz <= n; dz++) {
      const f = path.join(dir, `tile_${tx + dx}_${tz + dz}.json`);
      if (!fs.existsSync(f)) continue;
      let j; try { j = rj(f); } catch { continue; }
      for (const b of (j.features || [])) {
        if (!b.canonicalId || seen.has(b.canonicalId)) continue;
        const coords = b.coordinates;
        if (!coords) continue;
        const ring = (b.geometryType === 'Polygon') ? coords[0] : (coords[0] && coords[0][0]);
        if (!Array.isArray(ring) || ring.length < 3) continue;
        const c = b.centroid || ringCentroid(ring);
        if (Math.hypot(c[0] - cx, c[1] - cz) > radiusM) continue;
        seen.add(b.canonicalId);
        const a = b.attributes || {};
        out.push({
          id: b.canonicalId, ring,
          heightM: (typeof a.heightM === 'number' && a.heightM > 0) ? a.heightM : null,
          usageCategory: a.usageCategory || null,
          source: a.source || null,
          wardId: a.wardId || null,
          attributes: a,
        });
      }
    }
  }
  return out;
}

export function run() {
  const t0 = Date.now();
  const doc = rj(SRC.custom);
  const m = doc.match || {};
  const meas = doc.measurement || {};

  // ── §1 source footprint ─────────────────────────────────────────
  const srcRing = m.sourceRing;
  if (!Array.isArray(srcRing) || srcRing.length < 3) throw new Error('source ring が無い');
  const srcArea = ringArea(srcRing);
  const srcCentroid = ringCentroid(srcRing);
  const source = {
    osmWayId: doc.source && doc.source.osmWayId,
    osmUrl: doc.source && doc.source.osmUrl,
    buildingTag: doc.source && doc.source.buildingTag,
    name: (doc.source && doc.source.name) || null,
    ring: srcRing,
    vertexCount: srcRing.length,
    areaM2: +srcArea.toFixed(2),
    declaredAreaM2: m.sourceFootprintAreaM2 != null ? m.sourceFootprintAreaM2 : null,
    centroid: [+srcCentroid[0].toFixed(3), +srcCentroid[1].toFixed(3)],
    declaredCentroid: m.sourceCentroid || null,
    bbox: (() => { const b = ringBbox(srcRing); return {
      minX: +b.minX.toFixed(2), maxX: +b.maxX.toFixed(2), minZ: +b.minZ.toFixed(2), maxZ: +b.maxZ.toFixed(2) }; })(),
    coordinateConvention: doc.coordinateConvention,
  };

  // ── §2 候補を全列挙 ─────────────────────────────────────────────
  const radius = MATCH_RULES.CANDIDATE_RADIUS_M;
  const nearby = loadNearbyBuildings(SRC.buildings, srcCentroid[0], srcCentroid[1], radius);
  const evaluated = nearby.map((c) => evaluateCandidate(
    { ring: srcRing, area: srcArea, centroid: srcCentroid }, c));
  const ranked = rankCandidates(evaluated);
  const top10 = ranked.slice(0, 10);
  const best = ranked[0] || null;
  const second = ranked[1] || null;

  // ── §3/§4 判定 ─────────────────────────────────────────────────
  const decision = decideMatch(best, second);

  // ── §5 高さの食い違い ───────────────────────────────────────────
  const bestRaw = best ? nearby.find((c) => c.id === best.canonicalId) : null;
  const heightDeltaM = (best && best.heightM != null && meas.heightMedianM != null)
    ? +(best.heightM - meas.heightMedianM).toFixed(2) : null;
  const heightCheck = {
    pointCloud: {
      heightMedianM: meas.heightMedianM ?? null,
      heightP90M: meas.heightP90M ?? null,
      roofMinM: meas.roofMinM ?? null,
      roofMaxM: meas.roofMaxM ?? null,
      localGroundAltitudeM: meas.localGroundAltitudeM ?? null,
      roofCandidatePoints: meas.roofCandidatePoints ?? null,
      roofSupportPoints: meas.roofSupportPoints ?? null,
      roofType: meas.roofType ?? null,
      note: '点群の高さは localGroundAltitude を 0 とした相対高さ。'
        + 'roofSupportPoints が 40 点しかなく、屋根面の支持が薄い。',
    },
    canonical: bestRaw ? {
      heightM: bestRaw.heightM,
      attributeKeys: Object.keys(bestRaw.attributes || {}),
      heightAttribute: (bestRaw.attributes && bestRaw.attributes.heightM != null) ? 'attributes.heightM' : null,
      source: bestRaw.source,
      usageCategory: bestRaw.usageCategory,
      note: 'canonical の高さは PLATEAU 由来の attributes.heightM のみ。'
        + '取得元（measuredHeight / storeysAboveGround のどちらか）は canonical に残っていない。',
    } : null,
    heightDeltaM,
    findings: [],
  };
  if (best && best.areaRatio > 1.3) {
    heightCheck.findings.push(
      `best の footprint が source の ${best.areaRatio} 倍。source は建物全体ではなく一部（棟の片側）か、`
      + 'canonical 側が複数棟をまとめた形の可能性がある。');
  }
  if (best && best.sourceCoveredRatio < 0.9) {
    heightCheck.findings.push(
      `source の ${(100 * (1 - best.sourceCoveredRatio)).toFixed(1)}% が best の外にはみ出している。`);
  }
  if (meas.roofSupportPoints != null && meas.roofSupportPoints < 200) {
    heightCheck.findings.push(
      `屋根面を支える点が ${meas.roofSupportPoints} 点しかない。中央値 ${meas.heightMedianM}m は`
      + '建物全体の代表値として弱く、樹木・設備の混入も否定できない。');
  }
  if (heightDeltaM != null && Math.abs(heightDeltaM) > 20) {
    heightCheck.findings.push(
      `canonical ${best.heightM}m と点群中央値 ${meas.heightMedianM}m の差が ${heightDeltaM}m。`
      + '高さだけで別建物と断定はしないが、照合の信頼度を下げる材料になる。');
  }

  // ── 旧 35S match の扱い ────────────────────────────────────────
  const old = evaluated.find((c) => c.canonicalId === MISSION35S_CANONICAL_ID) || null;
  const mission35s = {
    canonicalId: MISSION35S_CANONICAL_ID,
    stillBest: !!(best && best.canonicalId === MISSION35S_CANONICAL_ID),
    metrics: old,
    verdict: null,
  };
  if (!old) mission35s.verdict = '棄却（候補に現れない）';
  else if (decision.matchConfidence === 'HIGH' && mission35s.stillBest) mission35s.verdict = '維持（HIGH）';
  else mission35s.verdict = `棄却（${decision.matchConfidence}: ${decision.reason}）`;

  const report = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '35T',
    coordinateConvention: 'znorth-neg-v1',
    rules: MATCH_RULES,
    source,
    candidateRadiusM: radius,
    candidateCount: evaluated.length,
    top10,
    best, second,
    ...decision,
    heightCheck,
    mission35s,
    elapsedMs: Date.now() - t0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'candidates.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'SUMMARY.md'), renderSummary(report));
  return report;
}

function renderSummary(r) {
  const s = r.source, b = r.best, sec = r.second;
  const row = (c, i) => `| ${i + 1} | \`${c.canonicalId.slice(0, 30)}…\` | ${c.iou} | ${c.centroidDistanceM} | `
    + `${c.areaRatio} | ${c.sourceCoveredRatio} | ${c.candidateCoveredRatio} | ${c.candidateAreaM2} | `
    + `${c.heightM ?? '—'} | ${c.hausdorffM} |`;
  return `# Mission 35T｜Custom LOD2 建物照合精度の確定

生成 ${r.generatedAt} / 座標規約 ${r.coordinateConvention}

## 1. source（OSM）

| 項目 | 値 |
|---|---|
| OSM way | ${s.osmWayId} |
| URL | ${s.osmUrl} |
| building タグ | ${s.buildingTag} |
| 名称 | ${s.name ?? '（無し）'} |
| 頂点数 | ${s.vertexCount} |
| 面積 | ${s.areaM2} m²（生成時の記録 ${s.declaredAreaM2} m²） |
| 重心 | ${s.centroid.join(', ')} |
| bbox | minX ${s.bbox.minX} / maxX ${s.bbox.maxX} / minZ ${s.bbox.minZ} / maxZ ${s.bbox.maxZ} |

source は OSM way ${s.osmWayId} のまま。途中で別の建物へ置き換えていない。

## 2. canonical 候補（重心から ${r.candidateRadiusM}m 以内を全列挙）

候補数 **${r.candidateCount}**。最寄り 1 棟だけを選ぶ実装は使っていない。

| # | canonicalId | IoU | 重心距離m | 面積比 | source被覆 | 候補被覆 | 候補面積m² | 高さm | Hausdorff m |
|---|---|---|---|---|---|---|---|---|---|
${r.top10.map(row).join('\n')}

## 3/4. 判定

| 項目 | 値 |
|---|---|
| best | \`${b ? b.canonicalId : '—'}\` |
| second | \`${sec ? sec.canonicalId : '—'}\` |
| best IoU | ${b ? b.iou : '—'} |
| best 重心距離 | ${b ? b.centroidDistanceM : '—'} m |
| best 面積比 | ${b ? b.areaRatio : '—'} |
| source 被覆率 | ${b ? b.sourceCoveredRatio : '—'} |
| 候補 被覆率 | ${b ? b.candidateCoveredRatio : '—'} |
| **最終判定** | **${r.matchConfidence}** |
| 理由 | ${r.reason} |
| AMBIGUOUS の理由 | ${r.ambiguousReason ?? '—'} |
| **LOD1 suppression** | **${r.lod1SuppressionAllowed ? '許可' : '不許可'}** |

しきい値: HIGH = IoU ≥ ${r.rules.HIGH.iou} かつ 重心 ≤ ${r.rules.HIGH.centroidM}m かつ 面積比 ${r.rules.HIGH.areaRatio.join('〜')} /
MEDIUM = IoU ≥ ${r.rules.MEDIUM.iou} かつ 重心 ≤ ${r.rules.MEDIUM.centroidM}m かつ 面積比 ${r.rules.MEDIUM.areaRatio.join('〜')}

## 5. 高さの食い違い

| 出どころ | 値 |
|---|---|
| 点群 中央値 | ${r.heightCheck.pointCloud.heightMedianM} m |
| 点群 p90 | ${r.heightCheck.pointCloud.heightP90M} m |
| 点群 roofMin / roofMax | ${r.heightCheck.pointCloud.roofMinM} / ${r.heightCheck.pointCloud.roofMaxM} m |
| 点群 地面標高 | ${r.heightCheck.pointCloud.localGroundAltitudeM} m（これを 0 とした相対高さ） |
| 屋根候補点 / 支持点 | ${r.heightCheck.pointCloud.roofCandidatePoints} / ${r.heightCheck.pointCloud.roofSupportPoints} |
| canonical 高さ | ${r.heightCheck.canonical ? r.heightCheck.canonical.heightM : '—'} m |
| canonical 高さの属性 | ${r.heightCheck.canonical ? (r.heightCheck.canonical.heightAttribute ?? '—') : '—'} |
| 差 | ${r.heightCheck.heightDeltaM ?? '—'} m |

${r.heightCheck.findings.length ? r.heightCheck.findings.map((f) => '- ' + f).join('\n') : '- 特記なし'}

canonical の高さは PLATEAU 由来の \`attributes.heightM\` だけで、
measuredHeight と storeysAboveGround のどちらから来たかは canonical に残っていない。
高さが違うことだけを理由に別建物とは断定していない。

## 旧 35S match の扱い

| 項目 | 値 |
|---|---|
| 35S の canonicalId | \`${r.mission35s.canonicalId}\` |
| いまも best か | ${r.mission35s.stillBest ? 'はい' : 'いいえ'} |
| IoU | ${r.mission35s.metrics ? r.mission35s.metrics.iou : '—'} |
| 重心距離 | ${r.mission35s.metrics ? r.mission35s.metrics.centroidDistanceM : '—'} m |
| 面積比 | ${r.mission35s.metrics ? r.mission35s.metrics.areaRatio : '—'} |
| **結論** | **${r.mission35s.verdict}** |
`;
}

if (process.argv[1] && process.argv[1].endsWith('mission35t_match_audit.mjs')) {
  const r = run();
  console.log('[35T] source OSM way', r.source.osmWayId, '/ 面積', r.source.areaM2, 'm2 / 頂点', r.source.vertexCount);
  console.log('[35T] 候補', r.candidateCount, '件');
  if (r.best) console.log('[35T] best  ', r.best.canonicalId, 'IoU', r.best.iou, '重心', r.best.centroidDistanceM + 'm', '面積比', r.best.areaRatio);
  if (r.second) console.log('[35T] second', r.second.canonicalId, 'IoU', r.second.iou, '重心', r.second.centroidDistanceM + 'm');
  console.log('[35T] 判定', r.matchConfidence, '/ suppression', r.lod1SuppressionAllowed ? '許可' : '不許可');
  console.log('[35T] 旧 35S match:', r.mission35s.verdict);
  console.log('[35T] out', OUT_DIR);
}
