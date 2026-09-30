// tools/google-places/lib/cross-language-name.mjs
// [Mission 36H follow-up] 日本語の施設名 ↔ Google が返す英語/ローマ字 displayName の、
//   「厳密に範囲を絞った」対応判定。純粋関数（ネットワークI/Oなし）。
//
//   距離だけで採らない。次の全てを満たすときだけ true:
//     1. 日本語名を「既知の接頭辞・施設種別語・地名語彙」だけで完全に説明できる
//        （説明できない語が残る = 例: 未登録の固有名 → 不一致扱い）
//     2. 地名語彙を最低1語含み、そのローマ字が英語名に「単語として」現れる
//        （"Higashisumiyoshi" は "sumiyoshi" とは一致しない）
//     3. 施設種別語（病院/学校/区役所…）の英語表現が英語名に全て現れる
//   タイプ互換（typesCompatible）と「近傍候補がちょうど1件」の条件は呼び出し側
//   （pilot-matching.mjs）で別途要求する。

// 施設名の前に付く、同定に寄与しない行政・格式の接頭辞（長い順に除去）。
const PREFIXES = ['大阪市消防局', '式内大社', '大阪市立', '大阪府立', '大阪市', '市立', '府立'];

// 施設種別語 → 英語表現（いずれか1つが英語名に含まれればよい）。notEn は含まれてはいけない語。
const TERMS = [
  { ja: '高等学校', en: ['high school'], notEn: ['junior'] },
  { ja: '中学校', en: ['junior high school', 'middle school'] },
  { ja: '小学校', en: ['elementary school', 'primary school'] },
  { ja: '区役所', en: ['ward office'] },
  { ja: '図書館', en: ['library'] },
  { ja: '消防署', en: ['fire station'] },
  { ja: '出張所', en: ['branch', 'substation'] },
  { ja: '警察署', en: ['police station'] },
  { ja: '交番', en: ['police box', 'koban'] },
  { ja: '駅前', en: ['ekimae'] },
  { ja: '郵便局', en: ['post office'] },
  { ja: '病院', en: ['hospital'] },
  { ja: '神社', en: ['shrine', 'jinja'] },
  { ja: 'スーパー', en: ['supermarket', 'super'] },
].sort((a, b) => b.ja.length - a.ja.length);

// 地名・固有名語彙 → ローマ字（パイロット候補に現れる語のみ。増やすときはここへ明示的に追加する）。
const PLACE_LEXICON = [
  { ja: '中臣須牟地', ro: 'nakatomi sumuchi' },
  { ja: '東住吉', ro: 'higashisumiyoshi' },
  { ja: '南住吉', ro: 'minamisumiyoshi' },
  { ja: '城南学園', ro: 'jonan gakuen' },
  { ja: '住吉', ro: 'sumiyoshi' },
  { ja: '我孫子', ro: 'abiko' },
  { ja: 'あびこ', ro: 'abiko' },
  { ja: 'アビコ', ro: 'abiko' },
  { ja: '矢田', ro: 'yata' },
  { ja: '玉出', ro: 'tamade' },
  { ja: 'ライフ', ro: 'life' },
].sort((a, b) => b.ja.length - a.ja.length);

// 運営主体を表す接頭辞（核名の比較でだけ除去する。固有名の同定には寄与しない）。
const OPERATOR_PREFIXES = ['医療法人', '社会福祉法人', '学校法人', '錦秀会'];

/**
 * 行政・運営主体の接頭辞を先頭から除いた「核となる名前」（NFKC・空白除去・小文字）。
 * 第二段階の曖昧さ解消で「正規化後に完全一致」を判定するために使う（部分一致は使わない）。
 */
export function coreName(name) {
  let s = String(name || '').normalize('NFKC').replace(/[\s・()（）]/g, '');
  for (let changed = true; changed;) {
    changed = false;
    for (const p of [...PREFIXES, ...OPERATOR_PREFIXES]) {
      if (s.startsWith(p) && s.length > p.length) { s = s.slice(p.length); changed = true; }
    }
  }
  return s.toLowerCase();
}

/** タイプ情報（primaryType / types）が1つでもあるか。無いなら「互換でない」ではなく「不明」。 */
export function hasTypeInfo(place) {
  return !!(place.primaryType || (Array.isArray(place.types) && place.types.length));
}

function englishWords(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasPhrase(words, phrase) {
  const p = phrase.split(' ');
  for (let i = 0; i + p.length <= words.length; i++) {
    if (p.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

/** 英語/ローマ字名が含みうる日本語名か。@returns {{ok:boolean, reason:string}} */
export function crossLanguageNameAgree(jaName, enName) {
  let s = String(jaName || '').normalize('NFKC').replace(/[\s・()（）]/g, '');
  const words = englishWords(enName);
  if (!s || !words.length) return { ok: false, reason: '名前が空' };

  for (const p of PREFIXES) s = s.split(p).join('|');
  const terms = [];
  for (const t of TERMS) if (s.includes(t.ja)) { terms.push(t); s = s.split(t.ja).join('|'); }
  const places = [];
  for (const l of PLACE_LEXICON) if (s.includes(l.ja)) { places.push(l); s = s.split(l.ja).join('|'); }

  const leftover = s.replace(/\|/g, '').replace(/店$/, '');
  if (leftover) return { ok: false, reason: '日本語名に語彙で説明できない部分がある: "' + leftover + '"' };
  if (!places.length) return { ok: false, reason: '固有名（地名語彙）の手掛かりが無い' };

  for (const l of places) {
    if (!hasPhrase(words, l.ro)) return { ok: false, reason: '地名 "' + l.ja + '" のローマ字 "' + l.ro + '" が英語名に無い' };
  }
  for (const t of terms) {
    if (!t.en.some((e) => hasPhrase(words, e)) || (t.notEn || []).some((n) => words.includes(n))) {
      return { ok: false, reason: '施設種別 "' + t.ja + '" に対応する英語表現が英語名に無い' };
    }
  }
  return { ok: true, reason: '日本語名と英語名が語彙対応で一致（地名: ' + places.map((l) => l.ro).join('+') + '）' };
}

// OSM subcategory → Google Places のタイプ（primaryType / types のいずれかに含まれればよい）。
const COMPATIBLE_TYPES = {
  hospital: ['hospital', 'general_hospital', 'medical_center'],
  clinic: ['doctor', 'medical_clinic', 'hospital', 'health'],
  kindergarten: ['preschool', 'school', 'educational_institution'],
  school: ['school', 'primary_school', 'secondary_school', 'middle_school', 'high_school', 'preschool', 'educational_institution'],
  college: ['university', 'college', 'school', 'educational_institution'],
  station: ['train_station', 'subway_station', 'transit_station', 'light_rail_station'],
  government: ['city_hall', 'local_government_office', 'government_office'],
  library: ['library'],
  community_centre: ['community_center', 'cultural_center', 'city_hall', 'local_government_office'],
  fire_station: ['fire_station'],
  police: ['police', 'police_station'],
  post_office: ['post_office'],
  supermarket: ['supermarket', 'grocery_store', 'grocery_or_supermarket'],
  bank: ['bank', 'atm', 'finance'],
  historic_memorial: ['shinto_shrine', 'place_of_worship', 'hindu_temple', 'buddhist_temple', 'tourist_attraction'],
};

/** Google側のタイプ情報が候補のOSM分類と両立するか。タイプ情報が無い場合は false（証拠不足）。 */
export function typesCompatible(osmSubcategory, place) {
  const allowed = COMPATIBLE_TYPES[osmSubcategory];
  if (!allowed) return false;
  const have = new Set([place.primaryType, ...(Array.isArray(place.types) ? place.types : [])].filter(Boolean));
  return allowed.some((t) => have.has(t));
}
