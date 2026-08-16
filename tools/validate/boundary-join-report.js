// tools/validate/boundary-join-report.js
// 統計データと町丁目境界マスタの結合結果を、機械可読JSONと人間向けログの両方で報告する。
import path from 'path';
import { writeJson } from '../lib/area.js';
import { toProjectRelativePath } from '../lib/paths.js';

/**
 * unmatchedレコードのreasonCode(機械可読)を判定する。
 * 【重要】杉本三丁目・今林一丁目は、複合キー(municipalityCode+chochoCode)結合の
 * 修正(chochoCodeの6桁ゼロパディング統一)により、現在は正式コード結合に成功しており、
 * この関数が呼ばれることはない(joinByChochoCodeのmatched配列に含まれるため)。
 */
function classifyUnmatchedReasonCode(record) {
  // これは「未結合（原因不明）」ではなく「正式境界データを今回取得していない区」という、
  // 明確で正当な理由であるため、別のreasonCodeで区別する。
  if (record.ward === '平野区') {
    return {
      reasonCode: 'official-boundary-not-acquired-for-this-ward',
      reason: '平野区は今回の正式境界データ取得対象外（取得範囲は住吉区・東住吉区のみ）。境界データ自体が存在しないため、正式コード結合・名称結合のいずれも試行できない。統計データの欠落や表記揺れによる未結合ではない。',
      sourceDataset: null, sourceRecordCode: null, sourceFile: null, checkedAt: null,
    };
  }

  if (record.populationSuppressed || record.totalPopulationSuppressed) {
    return { reasonCode: 'official-statistics-suppressed', reason: '統計上秘匿されている地域のため、境界マスタとの対応関係が未調査。', sourceDataset: null, sourceRecordCode: null, sourceFile: null, checkedAt: null };
  }
  return { reasonCode: 'unmatched-unclassified', reason: '個別調査未実施の未結合レコード。表記揺れ・境界データ欠落・対象地図範囲外のいずれかの可能性があるが、未確認。', sourceDataset: null, sourceRecordCode: null, sourceFile: null, checkedAt: null };
}

/**
 * joinByChochoCode()の戻り値から、結合結果レポートを生成して保存する。
 * @param {string} areaId
 * @param {string} datasetLabel レポート内で表示するデータセット名（例: "population-households"）
 * @param {{matched, unmatched, matchStats, multipleCandidates, masterOnlyEntries}} joinResult
 * @param {{boundaryDataStatus: string, officialBoundary: boolean, boundarySourceType: string}} boundaryInfo
 */
export async function generateBoundaryJoinReport(areaId, datasetLabel, joinResult, boundaryInfo = {}) {
  const unmatchedWithReasonCode = joinResult.unmatched.map((r) => {
    const classification = classifyUnmatchedReasonCode(r);
    return { chochoName: r.chochoName, fullChochoName: r.fullChochoName, ward: r.ward, ...classification };
  });

  const report = {
    areaId,
    dataset: datasetLabel,
    generatedAt: new Date().toISOString(),
    // 境界データ自体の品質情報。正式データへ切り替えた際、ここが official に変わることで
    // 確認できる。
    boundaryDataStatus: boundaryInfo.boundaryDataStatus || 'legacy-unverified',
    officialBoundary: boundaryInfo.officialBoundary || false,
    boundarySourceType: boundaryInfo.boundarySourceType || 'embedded-html-town-polygons',
    // 属性データと境界形状の区別。officialAttributeRecordsは公式属性(コード・名称・人口等)を
    // 持つレコード数、officialBoundaryRecordsはそのうち実際にPolygon/MultiPolygon形状を
    // 保持しているレコード数(両者は別の軸であり、前者が多いことは後者の保証にならない)。
    officialAttributeRecords: boundaryInfo.officialAttributeRecords || 0,
    officialBoundaryRecords: boundaryInfo.officialBoundaryRecords || 0,
    legacyGeometryRecords: boundaryInfo.legacyGeometryRecords || 0,
    recordsWithoutGeometry: boundaryInfo.recordsWithoutGeometry || 0,
    summary: {
      totalRecords: joinResult.matchStats.total,
      matchedByOfficialCode: joinResult.matchStats.byCode,
      matchedByFallbackName: joinResult.matchStats.byNormalizedName,
      unmatched: joinResult.matchStats.unmatchedCount,
      multipleCandidates: joinResult.matchStats.multipleCandidatesCount,
      // 境界マスタ側にのみ存在する町丁目(人口データ側には現れなかったもの)
      boundaryOnlyCount: joinResult.masterOnlyEntries.length,
    },
    unmatchedRecords: unmatchedWithReasonCode,
    multipleCandidateRecords: joinResult.multipleCandidates,
    boundaryOnlyEntries: joinResult.masterOnlyEntries.map((m) => ({
      boundaryId: m.boundaryId, chochoName: m.chochoName, ward: m.ward,
    })),
  };

  const outputPath = path.resolve(process.cwd(), 'data', 'processed', areaId, `statistics-boundary-join-report-${datasetLabel}.json`);
  await writeJson(outputPath, report);

  // 人が確認できるログ出力（コンソール）
  console.log(`\n=== 結合結果検証: ${datasetLabel} (境界データ: ${report.boundaryDataStatus}) ===`);
  console.log(`  公式属性レコード数: ${report.officialAttributeRecords}件`);
  console.log(`  └ うち有効な公式ポリゴン形状あり: ${report.officialBoundaryRecords}件`);
  console.log(`  └ うち暫定TOWN_POLYGONS形状で補完: ${report.legacyGeometryRecords}件`);
  console.log(`  └ うち境界形状なし(属性のみ): ${report.recordsWithoutGeometry}件`);
  console.log(`  正式コードで結合(municipalityCode+chochoCode): ${report.summary.matchedByOfficialCode}件`);
  console.log(`  町名フォールバックで結合: ${report.summary.matchedByFallbackName}件`);
  console.log(`  未結合: ${report.summary.unmatched}件`);
  console.log(`  複数候補（自動結合を見送り）: ${report.summary.multipleCandidates}件`);
  console.log(`  境界データ側にのみ存在（人口データ側に対応なし）: ${report.summary.boundaryOnlyCount}件`);
  if (report.summary.unmatched > 0) {
    for (const u of unmatchedWithReasonCode) {
      console.log(`    - ${u.fullChochoName}: [${u.reasonCode}] ${u.reason}`);
    }
  }
  if (report.summary.unmatched > 0 || report.summary.multipleCandidates > 0) {
    console.warn(`  [WARN] 未結合・複数候補が存在します。詳細: ${toProjectRelativePath(outputPath)}`);
  }
  console.log(`  レポート保存先: ${toProjectRelativePath(outputPath)}`);

  return report;
}
