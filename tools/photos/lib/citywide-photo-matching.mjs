// tools/photos/lib/citywide-photo-matching.mjs
// [Mission 36F] 35Z の curated 24件から大阪市全域へ拡張するための、
// 「推測しない」判定ロジックだけを切り出したライブラリ。
//
//   35Z (`tools/photos/build-building-photo-index.mjs`) の curated 経路は
//   そのまま残す（このファイルからは触らない）。ここは新しく増える2経路専用:
//
//   A. direct-id  : OSM 等に wikidata=Q... が直接ついている場合。
//                   名前一致は求めないが、その座標の近くに建物が「ちょうど1つ」
//                   無ければ結び付けない（複数あれば ambiguous、ゼロなら no-match）。
//   B. citywide-verified : 直接IDが無い名前付き建物。正規化した名前が完全一致し、
//                   かつ Wikidata 座標がその建物に最も近く、かつ「2番目に近い
//                   同名候補」と十分離れている（僅差なら unresolved）ときだけ結ぶ。
//
//   どちらも「近いから」だけでは採用しない。単体の網羅テスト
//   (tests/mission36f-citywide-photo-index.test.js) だけで安全性を検証できるよう、
//   ネットワーク I/O・ファイル I/O を一切含まない純粋関数だけを置く。
//
// 座標系は既存 build スクリプトと同じ znorth-neg-v1（呼び出し側で toLocal 済みの
// x/z を渡すこと。projection の再定義はここではしない）。

/** 建物名の表記ゆれを吸収する正規化。35Z の norm() と同じ考え方（重複だが依存を増やさない）。 */
export function normalizeBuildingName(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　・･]/g, '')
    .toLowerCase();
}

/**
 * direct-id 経路: 座標だけで建物を1つに絞れるときだけ結ぶ。
 * @param {{x:number, z:number}} point  Wikidata の座標をローカル座標へ変換したもの
 * @param {Array<{id:string, name:string, x:number, z:number}>} buildings  全建物ラベル
 * @param {{radiusM?: number}} [opts]
 */
export function resolveByDirectId(point, buildings, opts = {}) {
  const radiusM = opts.radiusM ?? 60;
  const within = [];
  for (const b of buildings) {
    const d = Math.hypot(b.x - point.x, b.z - point.z);
    if (d <= radiusM) within.push({ b, d });
  }
  if (within.length === 0) {
    return {
      canonicalId: null, matchedName: null, distanceM: null,
      matchConfidence: 'unresolved', matchMethod: 'direct-id',
      reasonCode: 'direct-id-no-building-nearby',
      reason: 'direct ID の座標から ' + radiusM + 'm 以内に建物が無い',
    };
  }
  if (within.length > 1) {
    within.sort((a, b) => a.d - b.d);
    return {
      canonicalId: null, matchedName: null, distanceM: +within[0].d.toFixed(1),
      matchConfidence: 'unresolved', matchMethod: 'direct-id',
      reasonCode: 'direct-id-ambiguous-radius',
      reason: 'direct ID の座標から ' + radiusM + 'm 以内に建物が ' + within.length + ' 件あり一意に決まらない',
    };
  }
  const only = within[0];
  return {
    canonicalId: only.b.id, matchedName: only.b.name, distanceM: +only.d.toFixed(1),
    matchConfidence: 'high', matchMethod: 'direct-id',
    reasonCode: 'direct-id-unique-nearby',
    reason: 'direct ID の座標から ' + only.d.toFixed(1) + 'm 以内に建物が一意に存在',
  };
}

/**
 * citywide-verified 経路: 正規化名が完全一致し、かつ Wikidata 座標に一意に近いときだけ結ぶ。
 * @param {{x:number, z:number}} point
 * @param {Array<{id:string, name:string, x:number, z:number}>} buildings  全建物ラベル
 * @param {string[]} candidateNames  Wikidata 側の候補名（curatedName / labelJa / labelEn 等、正規化前）
 * @param {{nameRadiusM?: number, ambiguityMarginM?: number}} [opts]
 */
export function resolveByNameAndCoordinate(point, buildings, candidateNames, opts = {}) {
  const nameRadiusM = opts.nameRadiusM ?? 400;
  const ambiguityMarginM = opts.ambiguityMarginM ?? 30;
  const names = new Set((candidateNames || []).filter(Boolean).map(normalizeBuildingName));

  const matches = [];
  for (const b of buildings) {
    if (!names.has(normalizeBuildingName(b.name))) continue;
    matches.push({ b, d: Math.hypot(b.x - point.x, b.z - point.z) });
  }
  if (matches.length === 0) {
    return {
      canonicalId: null, matchedName: null, distanceM: null,
      matchConfidence: 'unresolved', matchMethod: 'citywide-verified',
      reasonCode: 'name-no-match',
      reason: '建物名が一致しないので建物へは結び付けない',
    };
  }
  matches.sort((a, b) => a.d - b.d);
  const best = matches[0];
  if (best.d > nameRadiusM) {
    return {
      canonicalId: null, matchedName: best.b.name, distanceM: +best.d.toFixed(1),
      matchConfidence: 'unresolved', matchMethod: 'citywide-verified',
      reasonCode: 'name-match-too-far',
      reason: '名前は一致する建物があるが Wikidata 座標から ' + best.d.toFixed(1) + 'm 離れており遠すぎる',
    };
  }
  const second = matches[1];
  if (second && (second.d - best.d) < ambiguityMarginM) {
    return {
      canonicalId: null, matchedName: best.b.name, distanceM: +best.d.toFixed(1),
      matchConfidence: 'unresolved', matchMethod: 'citywide-verified',
      reasonCode: 'name-ambiguous-multiple-candidates',
      reason: '同名の建物が複数（' + matches.length + '件）近くにあり、どちらが正しいか一意に決まらない',
    };
  }
  return {
    canonicalId: best.b.id, matchedName: best.b.name, distanceM: +best.d.toFixed(1),
    matchConfidence: 'high', matchMethod: 'citywide-verified',
    reasonCode: 'name-and-coordinate-verified',
    reason: '名前が一致し、Wikidata 座標から ' + best.d.toFixed(1) + 'm',
  };
}

// 手法間の優先順位。数字が小さいほど強い（curated の手動確認済みが最優先）。
export const METHOD_PRIORITY = { curated: 0, 'direct-id': 1, 'citywide-verified': 2 };

/**
 * 複数の手法から出てきた records を canonicalId でまとめ、衝突を解決する。
 * 同じ canonicalId を複数の record が主張したら:
 *   - 優先度が最も高い手法が1件だけならそれを残す
 *   - 同率首位が複数（同じ手法内の別候補も含む）なら、全て unresolved に落とす
 * record を直接書き換えず、新しい配列を返す。
 * @param {Array<object>} records  各 record は {canonicalId, matchMethod, matchConfidence, reason, reasonCode, ...}
 */
export function resolvePriorityCollisions(records) {
  const claims = new Map();
  for (const r of records) {
    if (!r.canonicalId) continue;
    if (!claims.has(r.canonicalId)) claims.set(r.canonicalId, []);
    claims.get(r.canonicalId).push(r);
  }
  const demote = new Set();
  for (const [, list] of claims) {
    if (list.length < 2) continue;
    let bestPriority = Infinity;
    for (const r of list) bestPriority = Math.min(bestPriority, METHOD_PRIORITY[r.matchMethod] ?? Infinity);
    const top = list.filter((r) => (METHOD_PRIORITY[r.matchMethod] ?? Infinity) === bestPriority);
    if (top.length === 1) {
      for (const r of list) if (r !== top[0]) demote.add(r);
    } else {
      for (const r of list) demote.add(r);
    }
  }
  return records.map((r) => {
    if (!demote.has(r)) return r;
    const others = claims.get(r.canonicalId).filter((x) => x !== r).map((x) => x.matchMethod + ':' + (x.curatedName || x.matchedName || '?'));
    return {
      ...r,
      canonicalId: null,
      matchConfidence: 'unresolved',
      reasonCode: 'collision-lost-to-other-claim',
      matchReason: '同じ建物を複数の情報源が主張したため採用しない（競合: ' + others.join(' / ') + '）',
    };
  });
}

/**
 * 区別カバレッジ・手法別内訳・unresolved 理由の内訳を集計する。
 * @param {Array<{id:string, wardId?: string|null}>} namedBuildings  名前付き建物（ward 分類済み）
 * @param {Array<object>} records  最終的な（衝突解決済みの）record 一覧
 * @param {Object<string, number>} [selectableTotalsByWard]  区ごとの全selectable建物数（分かる範囲。既知の値を渡す）
 */
export function summarizeCoverage(namedBuildings, records, selectableTotalsByWard = {}) {
  const wardOfBuilding = new Map(namedBuildings.map((b) => [b.id, b.wardId || null]));
  const wardStats = {};
  const ensureWard = (w) => {
    const key = w || 'unknown';
    if (!wardStats[key]) {
      wardStats[key] = {
        selectableTotal: selectableTotalsByWard[key] ?? null,
        namedTotal: 0, resolved: 0,
        byMethod: { curated: 0, 'direct-id': 0, 'citywide-verified': 0 },
      };
    }
    return wardStats[key];
  };
  for (const b of namedBuildings) ensureWard(b.wardId).namedTotal++;

  const unresolvedReasons = {};
  let resolvedTotal = 0, unresolvedTotal = 0;
  const byMethodTotals = { curated: 0, 'direct-id': 0, 'citywide-verified': 0 };
  for (const r of records) {
    if (r.canonicalId) {
      resolvedTotal++;
      const stat = ensureWard(wardOfBuilding.get(r.canonicalId) || 'unknown');
      stat.resolved++;
      if (r.matchMethod) { stat.byMethod[r.matchMethod] = (stat.byMethod[r.matchMethod] || 0) + 1; byMethodTotals[r.matchMethod] = (byMethodTotals[r.matchMethod] || 0) + 1; }
    } else {
      // unresolved は「どの建物か決まらなかった」記録なので、特定の区へは割り当てない
      // （区別集計を汚さない）。理由の内訳だけ全市で集計する。
      unresolvedTotal++;
      const code = r.reasonCode || 'unknown';
      unresolvedReasons[code] = (unresolvedReasons[code] || 0) + 1;
    }
  }
  return {
    wardStats,
    coverage: {
      wardsWithActivity: Object.keys(wardStats).filter((w) => w !== 'unknown').length,
      namedBuildingsTotal: namedBuildings.length,
      resolvedTotal, unresolvedTotal,
      byMethod: byMethodTotals,
    },
    unresolvedReasons,
  };
}
