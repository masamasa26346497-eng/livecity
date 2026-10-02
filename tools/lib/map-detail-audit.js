// tools/lib/map-detail-audit.js
// [Mission30] 大阪市全域 細部欠落総合監査の純粋ロジック（THREE 非依存）。
//   Mission24 の map-completeness 監査（anomaly A/B/C/F）を土台に、
//     D: known waterway あり / rendered water = 0
//     E: rail network 断裂
//     G: park source あり / rendered park = 0
//     H: 極端な空白 cell（周囲は密なのに当該 cell だけ完全空白）
//   を加え、§5 の cause taxonomy へ正規化し、24区スコアと anomaly summary を作る。
// ══════════════════════════════════════════════════════════════════════════════════

// §5 cause taxonomy
export const CAUSE = Object.freeze([
  'SOURCE_MISSING', 'PORT', 'INDUSTRIAL', 'PARK', 'RIVERBANK', 'RAIL_YARD',
  'COAST', 'BOUNDARY', 'OSM_SPARSE', 'PLATEAU_MISSING', 'UNDERGROUND', 'ROUNDING', 'UNKNOWN',
]);
const CAUSE_SET = new Set(CAUSE);

export const DETAIL_SEVERITY = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

/**
 * Mission24 の自由文 cause note（「I: 建物が存在しない土地（…港湾・工業…）」等）や
 * anomaly の文脈から §5 taxonomy へ正規化する。
 * @param {{type?:string, note?:string, detail?:string, ward?:string, nearCityEdge?:boolean, explained?:boolean}} a
 * @returns {string} CAUSE の1つ
 */
export function normalizeCause(a) {
  const s = String((a && (a.note || a.detail)) || '').toLowerCase();
  const src = s + ' ' + String((a && a.cause) || '').toLowerCase();
  // 具体的・特異なものから先に判定する（複合 note は先勝ち）。
  if (/source[_\s-]?missing|抽出範囲外|pbf|収録範囲外|source なし|生 osm.*無い/.test(src)) return 'SOURCE_MISSING';
  if (/暗渠|地下|culvert|tunnel|underground|覆蓋/.test(src)) return 'UNDERGROUND';
  if (/丸め|ラスタ端|rounding|raster edge|granular|1 ?cell|境界の丸め/.test(src)) return 'ROUNDING';
  // Mission24 の catch-all（「鉄道ヤード/空港敷地/スポーツ島/大規模工業」）は複数施設種の総称 → INDUSTRIAL 代表。
  const isCatchAll = /大規模工業/.test(src) && /鉄道ヤード/.test(src);
  if (isCatchAll) return 'INDUSTRIAL';
  if (/鉄道ヤード|電車区|操車場|車両基地|rail.?yard|貨物駅|信号場|空港敷地/.test(src)) return 'RAIL_YARD';
  if (/港湾|埠頭|岸壁|ferry|フェリー|コンテナ|ポートターミナル|港湾ヤード/.test(src)) return 'PORT';
  if (/河川敷|riverbank|河川縁|川縁|堤外/.test(src)) return 'RIVERBANK';
  if (/舞洲|夢洲|咲洲|人工島|スポーツ島|埋立地|海岸線|海際|沿岸|coast/.test(src)) return 'COAST';
  if (/区界|市境|市外|boundary|隣接市|クリップ|外周|study extent/.test(src)) return 'BOUNDARY';
  if (/公園|緑地|park|グラウンド|運動場|球場|庭球/.test(src)) return 'PARK';
  if (/osm.*(疎|薄|未整備|不足|partial)|osm[_\s-]?sparse|データが薄い/.test(src)) return 'OSM_SPARSE';
  if (/工業|工場|industrial|コンビナート|製鉄|プラント|貯木場|大規模/.test(src)) return 'INDUSTRIAL';
  if (/plateau.*(欠落|不足|未収録|無い)|plateau[_\s-]?missing/.test(src)) return 'PLATEAU_MISSING';
  if (a && a.nearCityEdge) return 'BOUNDARY';
  if (a && a.explained) return 'INDUSTRIAL'; // 説明済みだが語彙が拾えない → 大区画系とみなす（保守的に非 UNKNOWN）
  return 'UNKNOWN';
}

// cause が「説明可能」＝ そのままでは CRITICAL/HIGH にしない対象。
//   UNKNOWN と PLATEAU_MISSING（OSM にも建物があるのに PLATEAU 側で欠落＝要 fallback）は未説明扱い。
const UNEXPLAINED_CAUSES = new Set(['UNKNOWN', 'PLATEAU_MISSING']);
export function isExplainableCause(cause) {
  return !UNEXPLAINED_CAUSES.has(cause);
}

/**
 * anomaly cell（A）のうち「周囲は密なのに当該だけ完全空白」= H を抽出する（§3 neighbor 比較）。
 * @param {Array<{cx:number,cz:number,x:number,z:number,ward:string}>} aCells  auditMapCompleteness().anomalyCells.A
 * @param {Map<string,{plat:number,fb:number}>} bG                            grids.bG
 * @param {object} opts { neighborMedianMin=8, radius=1 }
 * @returns {Array} H cell（cause 付き）
 */
export function extractExtremeBlank(aCells, bG, opts = {}) {
  const neighborMedianMin = opts.neighborMedianMin ?? 8;
  const radius = opts.radius ?? 1;
  const bAt = (cx, cz) => { const e = bG.get(cx + ',' + cz); return e ? (e.plat + e.fb) : 0; };
  const out = [];
  for (const c of aCells) {
    const counts = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (!dx && !dz) continue;
      counts.push(bAt(c.cx + dx, c.cz + dz));
    }
    counts.sort((p, q) => p - q);
    const med = counts[Math.floor(counts.length / 2)];
    if (med >= neighborMedianMin) out.push({ ...c, neighborMedianBuildings: med });
  }
  return out;
}

/**
 * anomaly リストを severity/type/cause で集計する（§15 summary 中心）。
 * @param {Array<{type:string, severity:string, cause:string, explained?:boolean}>} anomalies
 */
export function anomalySummary(anomalies) {
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  const byType = {};
  const byCause = {};
  let explained = 0;
  for (const a of anomalies) {
    bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    byType[a.type] = (byType[a.type] || 0) + 1;
    const c = CAUSE_SET.has(a.cause) ? a.cause : 'UNKNOWN';
    byCause[c] = (byCause[c] || 0) + 1;
    if (a.explained || (a.severity === 'LOW' || a.severity === 'INFO')) explained++;
  }
  const unexplained = anomalies.filter((a) => !a.explained
    && (a.severity === 'CRITICAL' || a.severity === 'HIGH' || a.severity === 'MEDIUM')
    && !isExplainableCause(a.cause)).length;
  return {
    total: anomalies.length,
    bySeverity, byType, byCause,
    explained,
    unexplained,
  };
}

/**
 * 24区スコアを、map-completeness の byWard に mission別 QA を重ねて再構成する（§6）。
 * @param {object} mcByWard  map-completeness-audit.json の byWard
 * @param {Array} anomalies  Mission30 の全 anomaly（ward 付き）
 * @returns {object} wardId -> ward score
 */
export function consolidateWardScores(mcByWard, anomalies) {
  const out = {};
  for (const [wid, W] of Object.entries(mcByWard || {})) {
    const wa = anomalies.filter((a) => a.ward === wid);
    const crit = wa.filter((a) => a.severity === 'CRITICAL').length;
    const high = wa.filter((a) => a.severity === 'HIGH').length;
    const med = wa.filter((a) => a.severity === 'MEDIUM').length;
    const low = wa.filter((a) => a.severity === 'LOW').length;
    const explained = wa.filter((a) => a.explained || a.severity === 'LOW' || a.severity === 'INFO').length;
    out[wid] = {
      overallCompleteness: Math.max(0, 100 - crit * 100 - high * 20 - med * 4),
      buildingCoverage: W.buildingCoverage != null ? W.buildingCoverage : null,
      roadCoverage: W.roadCoverage != null ? W.roadCoverage : null,
      waterCoverage: W.landCells ? +((W.riverCells || 0) / W.landCells).toFixed(3) : 0,
      parkCoverage: W.landCells ? +((W.parkCells || 0) / W.landCells).toFixed(3) : 0,
      railCoverage: W.landCells ? +((W.railCells || 0) / W.landCells).toFixed(3) : 0,
      landCells: W.landCells != null ? W.landCells : W.land,
      criticalCount: crit, highCount: high, mediumCount: med, lowCount: low, explainedCount: explained,
      statuses: {
        land: W.landStatus, building: W.buildingStatus, road: W.roadStatus,
        water: W.waterStatus, park: W.parkStatus, rail: W.railStatus,
      },
    };
  }
  return out;
}
