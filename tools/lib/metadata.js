// tools/lib/metadata.js
// 全データセット共通のメタデータ生成。ご指示の最低8項目を必ず含める。
import crypto from 'crypto';

/**
 * データセット定義(config/datasets/*.json)とランタイム情報から、
 * 共通メタデータオブジェクトを生成する。
 * @param {object} dataset config/datasets/*.json の内容
 * @param {object} runtime {referenceDate, publishedAt, geographicLevel, valueType, processingVersion, checksumSource}
 */
export function buildMetadata(dataset, runtime) {
  return {
    datasetId: dataset.datasetId || dataset.id, // 新データセット(datasetId)・既存データセット(id)の両方に対応する
    provider: dataset.provider,
    sourceTitle: dataset.title,
    sourcePage: dataset.sourcePage,
    downloadUrl: dataset.downloadUrl || null,
    license: dataset.license,
    attribution: dataset.attribution || `${dataset.provider}「${dataset.title}」`,
    downloadedAt: runtime.downloadedAt || new Date().toISOString(),
    referenceDate: runtime.referenceDate || dataset.referenceDate || null,
    publishedAt: runtime.publishedAt || null,
    geographicLevel: runtime.geographicLevel || dataset.geographicLevel || null,
    valueType: runtime.valueType, // official | official-estimate | livecity-calculated | livecity-estimate (必須、デフォルトなし)
    processingVersion: runtime.processingVersion || '0.1.0',
    checksum: runtime.checksumSource ? computeChecksum(runtime.checksumSource) : null,
  };
}

export function computeChecksum(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * valueTypeの妥当性を検証する。不正な値は明確なエラーとする
 * （「公式値と計算値を同じ扱いにしない」という要件のため、ここでの曖昧さを許容しない）。
 */
const VALID_VALUE_TYPES = ['official', 'official-estimate', 'livecity-calculated', 'livecity-estimate'];
export function assertValidValueType(valueType) {
  if (!VALID_VALUE_TYPES.includes(valueType)) {
    throw new Error(`不正なvalueType: "${valueType}"。次のいずれかである必要があります: ${VALID_VALUE_TYPES.join(', ')}`);
  }
}
