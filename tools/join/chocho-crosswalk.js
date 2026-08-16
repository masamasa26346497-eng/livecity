// tools/join/chocho-crosswalk.js
// 町丁目コードでの結合を最優先とし、地域コードがない場合は正規化名称でフォールバックする。
// 結合できなかったレコードは黙って削除せず、unmatchedレポートに出力する。
//
// 【複合キーについて】町丁目コード(chochoCode)は区内連番であり、区をまたいで一意ではない
// （例: 住吉区の"1001"と東住吉区の"1001"が別の町丁目を指す可能性がある）。
// そのため正式コードでの結合は必ず municipalityCode + chochoCode の複合キーで行い、
// chochoCode単独でMapを構築してはならない。
import { normalizeChochoName } from '../lib/chocho-normalize.js';

/**
 * municipalityCodeとchochoCodeから複合キー文字列を生成する唯一の関数。
 * 形式: "{municipalityCode}:{chochoCode}" 例: "27120:1001"
 * どちらかが欠けている場合はnullを返す（不完全なキーでの誤結合を防ぐ）。
 */
export function buildCompositeCode(municipalityCode, chochoCode) {
  if (!municipalityCode || !chochoCode) return null;
  return `${municipalityCode}:${chochoCode}`;
}

/**
 * 統計データの配列(各要素は {municipalityCode?, chochoCode?, chochoName, fullChochoName?, ...values}) を、
 * 町丁目マスタ(各要素は {municipalityCode?, chochoCode?, chochoName, originalFullName?, boundaryId?, ...}) と結合する。
 *
 * @param {object[]} records 統計データ
 * @param {object[]} master 町丁目マスタ（地域コード・正規化済み名称を持つ）
 * @returns {{matched: object[], unmatched: object[], matchStats: object, multipleCandidates: object[], masterOnlyEntries: object[]}}
 */
export function joinByChochoCode(records, master) {
  const matched = [];
  const unmatched = [];
  const multipleCandidates = []; // 正規化名称が複数マスタエントリに一致した記録(誤結合防止のため、結合せず報告する)
  const stats = {
    byCode: 0, byNormalizedName: 0, unmatchedCount: 0, total: records.length,
    multipleCandidatesCount: 0,
  };

  // 優先順位1: municipalityCode + chochoCode の複合キー（正式な主キー）。
  // chochoCode単独でのMap構築は、異なる区で同じ短いコードが衝突するリスクがあるため禁止する。
  const masterByCompositeCode = new Map();
  for (const m of master) {
    const key = buildCompositeCode(m.municipalityCode, m.chochoCode);
    if (key) masterByCompositeCode.set(key, m);
  }

  // 優先順位2: 正規化名称。比較の粒度をレコード側と完全に揃えるため、2種類のインデックスを用意する。
  // - 区名込み(fullChochoName/originalFullName)のインデックス: レコードがward情報を持つ場合に使う
  // - 区名なし(chochoNameのみ)のインデックス: レコードがward情報を持たない場合に使う
  //   （区名情報がないレコードと、区名込みの完全名を比較すると、文字列が異なるため永遠に
  //   一致しない。区名なし同士で比較することで、初めて「本町1丁目」のような同名衝突を
  //   複数候補として正しく検知できる）
  const masterByFullName = new Map(); // 区名込みキー
  const masterByChochoNameOnly = new Map(); // 区名なしキー
  for (const m of master) {
    const fullKey = normalizeChochoName(m.originalFullName || m.fullChochoName || m.chochoName);
    if (!masterByFullName.has(fullKey)) masterByFullName.set(fullKey, []);
    masterByFullName.get(fullKey).push(m);

    const chochoOnlyKey = normalizeChochoName(m.chochoName);
    if (!masterByChochoNameOnly.has(chochoOnlyKey)) masterByChochoNameOnly.set(chochoOnlyKey, []);
    masterByChochoNameOnly.get(chochoOnlyKey).push(m);
  }

  const usedMasterBoundaryIds = new Set(); // マスタ側で実際に結合に使われたエントリを記録する
                                             // （結合に一度も使われなかったマスタ側のみのエントリを
                                             //  後で特定するため）

  for (const record of records) {
    let masterEntry = null;
    let matchMethod = null;

    const recordCompositeKey = buildCompositeCode(record.municipalityCode, record.chochoCode);
    if (recordCompositeKey && masterByCompositeCode.has(recordCompositeKey)) {
      masterEntry = masterByCompositeCode.get(recordCompositeKey);
      matchMethod = 'municipality-and-chocho-code';
      stats.byCode++;
    } else {
      const hasWardInfo = !!(record.fullChochoName);
      const key = hasWardInfo
        ? normalizeChochoName(record.fullChochoName)
        : normalizeChochoName(record.chochoName);
      const candidates = (hasWardInfo ? masterByFullName.get(key) : masterByChochoNameOnly.get(key)) || [];
      if (candidates.length === 1) {
        masterEntry = candidates[0];
        matchMethod = hasWardInfo ? 'full-normalized-name' : 'normalized-name';
        stats.byNormalizedName++;
      } else if (candidates.length > 1) {
        // 複数候補: 誤結合を避けるため、ここでは結合せずunmatchedへ送り、別途報告する
        multipleCandidates.push({
          chochoName: record.chochoName,
          fullChochoName: record.fullChochoName,
          candidateCount: candidates.length,
          candidateBoundaryIds: candidates.map((c) => c.boundaryId || c.originalFullName || c.chochoName),
        });
        stats.multipleCandidatesCount++;
      }
    }

    if (masterEntry) {
      if (masterEntry.boundaryId) usedMasterBoundaryIds.add(masterEntry.boundaryId);
      matched.push({
        ...record,
        chochoCode: masterEntry.chochoCode || record.chochoCode || null,
        municipalityCode: masterEntry.municipalityCode || record.municipalityCode || null,
        boundaryId: masterEntry.boundaryId || null,
        matchMethod,
        // 結合結果の状態。後から「正式コードで結合されたか、町名フォールバックで結合されたか」
        // を確認できるようにする。
        joinMethod: matchMethod,
        boundaryDataStatus: masterEntry.boundaryDataStatus || 'legacy-unverified',
        joinConfidence: matchMethod === 'municipality-and-chocho-code' ? 'high' : 'fallback',
      });
    } else {
      stats.unmatchedCount++;
      unmatched.push({
        ...record,
        joinMethod: 'unmatched',
        joinConfidence: 'unavailable',
        unmatchedReason: record.chochoCode
          ? 'コードが町丁目マスタに存在しない（複合キーで未検出）'
          : 'コードがなく、正規化名称でも一致する町丁目が見つからない、または複数候補があり自動結合を見送った',
      });
    }
  }

  // 境界マスタ側にのみ存在する(人口データ側で一度も結合に使われなかった)エントリを特定する
  const masterOnlyEntries = master.filter((m) => m.boundaryId && !usedMasterBoundaryIds.has(m.boundaryId));

  return { matched, unmatched, matchStats: stats, multipleCandidates, masterOnlyEntries };
}
