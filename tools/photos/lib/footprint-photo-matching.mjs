// tools/photos/lib/footprint-photo-matching.mjs
// [Mission 36A §3/§4/§5/§6] 「写真対象の座標が実 building footprint の中にあるか」で判定する。
//
//   36F までは 60m 半径の距離マッチ（+ 一意性の検査）だった。距離は当たり外れが読めないので、
//   ここでは **polygon の内外** に置き換える。ネットワーク I/O もファイル I/O も持たない
//   純粋関数だけにして、単体テストで安全性を検証できるようにする。
//
//   座標は呼び出し側で znorth-neg-v1 のローカル x/z へ変換して渡すこと。

/** 名前の表記ゆれを吸収（36F の normalizeBuildingName と同じ考え方）。 */
export function normalizeName(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　・･（）()「」【】]/g, '')
    .toLowerCase();
}

/**
 * §6 名前の突き合わせ。
 *   'agree'    … どちらかがもう一方を含む（表記ゆれ込みで一致とみなせる）
 *   'no-name'  … 建物側に名前が無い（矛盾はしていない）
 *   'conflict' … 両方に名前があり、互いに無関係
 */
export function compareNames(wikidataNames, buildingName) {
  const b = normalizeName(buildingName);
  if (!b) return 'no-name';
  for (const raw of wikidataNames) {
    const w = normalizeName(raw);
    if (!w) continue;
    if (w === b) return 'agree';
    // 片方がもう一方を含む場合も一致とみなす（「大阪城ホール」⊂「大阪城ホール本館」等）。
    //   ただし 2 文字以下の断片で誤って一致させない。
    if (w.length >= 3 && b.length >= 3 && (w.includes(b) || b.includes(w))) return 'agree';
  }
  return 'conflict';
}

/** §5 大型施設は 1 item = 複数棟のことがある。instance-of / 名前から複合施設らしさを見る。 */
const COMPLEX_HINT = /駅|ステーション|ショッピング|モール|百貨店|大学|学校|キャンパス|病院|医療センター|団地|公園|城|遊園地|スタジアム|空港|市場|複合/;
export function looksComplex(names, instanceLabels) {
  const hay = [...(names || []), ...(instanceLabels || [])].join(' ');
  return COMPLEX_HINT.test(hay);
}

/**
 * §3/§4 point-in-polygon の結果から対応付けを決める。
 *
 * @param {Array<{canonicalId:string, name?:string|null, areaM2:number, wardId?:string|null}>} inside
 *        その点を内側に含む建物（footprint-lookup が返したもの。0 件 / 1 件 / 複数）
 * @param {string[]} wikidataNames  Wikidata 側の呼び名（ja / en / curation 名）
 * @param {{ landmarkId?:string|null, osmId?:string|null, instanceLabels?:string[],
 *           buildingOsmIds?:Record<string,string> }} [ctx]
 * @returns {{canonicalId:string|null, matchConfidence:'VERY_HIGH'|'HIGH'|'AMBIGUOUS'|'UNRESOLVED',
 *           matchType:'exact-building'|'building-part'|'complex'|'unresolved',
 *           nameEvidence:string, ambiguityReason:string|null, reason:string,
 *           insideCount:number, candidates:string[]}}
 */
export function classifyFootprintMatch(inside, wikidataNames, ctx = {}) {
  const base = {
    canonicalId: null, matchConfidence: 'UNRESOLVED', matchType: 'unresolved',
    nameEvidence: 'none', ambiguityReason: null, reason: '',
    insideCount: inside.length, candidates: inside.map((b) => b.canonicalId),
  };

  // ── footprint の外 ───────────────────────────────────────────
  if (!inside.length) {
    return { ...base, reason: '座標がどの建物 footprint の中にも無い' };
  }

  // ── ちょうど 1 棟の中 ────────────────────────────────────────
  if (inside.length === 1) {
    const b = inside[0];
    const ev = compareNames(wikidataNames, b.name);
    if (ev === 'conflict') {
      // §6 名前が矛盾するなら採らない（別の建物の写真を付けないため）
      return { ...base, canonicalId: null, matchConfidence: 'UNRESOLVED', matchType: 'unresolved',
        nameEvidence: 'conflict',
        reason: '座標は「' + b.name + '」の中だが、名前が一致しない' };
    }
    // §5 複合施設は 1 棟へ勝手に割り当てない。名前が一致したときだけ建物として扱う。
    if (looksComplex(wikidataNames, ctx.instanceLabels) && ev !== 'agree') {
      return { ...base, canonicalId: null, matchConfidence: 'AMBIGUOUS', matchType: 'complex',
        nameEvidence: ev, ambiguityReason: 'complex-facility',
        reason: '駅・商業施設などの複合施設らしく、1 棟に決められない' };
    }
    // §4 VERY_HIGH は「内側 + 追加の裏付け」
    const idAgrees = !!(ctx.osmId && ctx.buildingOsmIds && ctx.buildingOsmIds[b.canonicalId]
      && String(ctx.buildingOsmIds[b.canonicalId]) === String(ctx.osmId));
    const strong = ev === 'agree' || !!ctx.landmarkId || idAgrees;
    return {
      ...base,
      canonicalId: b.canonicalId,
      matchConfidence: strong ? 'VERY_HIGH' : 'HIGH',
      matchType: 'exact-building',
      nameEvidence: idAgrees ? 'osm-id' : (ev === 'agree' ? 'name' : (ctx.landmarkId ? 'landmark' : 'none')),
      reason: '座標がちょうど 1 棟の footprint の中'
        + (ev === 'agree' ? '（名前も一致）' : (ctx.landmarkId ? '（ランドマーク登録あり）' : '（建物側に名前なし）')),
    };
  }

  // ── 複数の footprint に入っている ────────────────────────────
  //   §5 building part（小さいほうが大きいほうにすっぽり入る関係）かどうかを見る。
  const sorted = [...inside].sort((a, b) => a.areaM2 - b.areaM2);
  const smallest = sorted[0], largest = sorted[sorted.length - 1];
  const named = inside.filter((b) => compareNames(wikidataNames, b.name) === 'agree');

  if (named.length === 1) {
    // 名前が一致する棟が 1 つだけなら、それが答え
    return { ...base, canonicalId: named[0].canonicalId, matchConfidence: 'VERY_HIGH',
      matchType: 'exact-building', nameEvidence: 'name',
      reason: '重なった ' + inside.length + ' 棟のうち、名前が一致するのは 1 棟だけ' };
  }
  const partLike = inside.length === 2 && largest.areaM2 > smallest.areaM2 * 3;
  return {
    ...base,
    canonicalId: null,
    matchConfidence: 'AMBIGUOUS',
    matchType: partLike ? 'building-part' : 'complex',
    nameEvidence: named.length > 1 ? 'multiple-name-agree' : 'none',
    ambiguityReason: partLike ? 'building-part-overlap' : 'overlapping-footprints',
    reason: '座標が ' + inside.length + ' 棟の footprint に同時に入っている',
  };
}

/** hover に出してよいか（§4: HIGH / VERY_HIGH のみ）。 */
export const HOVER_CONFIDENCES = ['VERY_HIGH', 'HIGH'];
export const showsOnHover = (c) => HOVER_CONFIDENCES.includes(c);
