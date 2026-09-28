// tools/photos/lib/photo-preference.mjs
// [Mission 36A 追加要件 §7/§8/§9] 「建物全体が写っている 1 枚」を先頭へ持ってくる。
//
//   hover に出すのは 1 枚だけなので、その 1 枚が外観の全景であることが大事。
//   Commons のタイトル・説明から簡単に点を付けて並べ替える。
//   自動判定が怪しいものは data/photos/building-photo-manual.json で指定できる（そちらが最優先）。
//
//   ネットワーク I/O を持たない純粋関数だけ（単体テストで検証できるように）。

/** 全景らしさを上げる語 */
const GOOD = [
  { re: /\bexterior\b|外観/i, w: 3 },
  { re: /\bfacade\b|\bfaçade\b|正面/i, w: 3 },
  { re: /\bfull\b.*\bview\b|\bwhole\b|全景|遠景/i, w: 3 },
  { re: /\bbuilding\b|ビル|会館|タワー|\btower\b/i, w: 1 },
  { re: /\bfrom\b.*\b(south|north|east|west)\b|南側|北側|東側|西側/i, w: 1 },
  { re: /\baerial\b|空撮/i, w: 1 },
];
/** 全景らしさを下げる語（一部のアップ・内部・夜景など） */
const BAD = [
  { re: /\binterior\b|\binside\b|店内|内部|ロビー/i, w: -4 },
  { re: /\bsign\b|\bsignage\b|\bplaque\b|看板|銘板|案内板/i, w: -4 },
  { re: /\bdetail\b|\bclose[- ]?up\b|接写|部分/i, w: -3 },
  { re: /\bnight\b|夜景|ライトアップ|illuminat/i, w: -2 },
  { re: /\bentrance\b|\bgate\b|入口|入り口|玄関/i, w: -2 },
  { re: /\bconstruction\b|建設中|工事/i, w: -2 },
  { re: /\bmap\b|\bplan\b|\bdiagram\b|図面|地図/i, w: -5 },
  { re: /\bstatue\b|\bmonument\b|像/i, w: -2 },
];

/** 画像の向き。naturalWidth/Height が無いときは Commons の width/height を使う。 */
export function orientationOf(photo) {
  const w = photo && (photo.width || photo.thumbWidth);
  const h = photo && (photo.height || photo.thumbHeight);
  if (!w || !h) return 'unknown';
  const r = w / h;
  if (r >= 1.15) return 'landscape';
  if (r <= 0.87) return 'portrait';
  return 'square';
}

/**
 * §7 1 枚あたりの「全景らしさ」。大きいほど全景に近いと判断する。
 *   タイトルと説明しか手がかりが無いので、あくまで並べ替えの目安。
 */
export function scorePhoto(photo) {
  const hay = [photo.title, photo.attribution, photo.author].filter(Boolean).join(' ');
  let s = 0;
  const hits = [];
  for (const g of GOOD) if (g.re.test(hay)) { s += g.w; hits.push('+' + g.w); }
  for (const b of BAD) if (b.re.test(hay)) { s += b.w; hits.push('' + b.w); }
  // 極端に細長い画像は建物の一部を切り取っていることが多い
  const o = orientationOf(photo);
  const w = photo.width, h = photo.height;
  if (w && h) {
    const r = Math.max(w / h, h / w);
    if (r > 3.2) { s -= 3; hits.push('-3(極端な縦横比)'); }
    else if (r < 2.2) { s += 1; hits.push('+1(扱いやすい比)'); }
  }
  return { score: s, orientation: o, hits };
}

/**
 * §8/§9 並べ替え。manual に preferredImageTitle / preferredPhotoIndex があればそれを先頭へ。
 * @param {Array} photos
 * @param {{preferredImageTitle?:string, preferredPhotoIndex?:number}} [manualEntry]
 */
export function pickPreferredPhoto(photos, manualEntry) {
  const list = (photos || []).slice();
  const scores = list.map((p) => ({ title: p.title, ...scorePhoto(p) }));
  if (!list.length) return { photos: list, scores, appliedManual: false };

  let manualIdx = -1;
  if (manualEntry) {
    if (typeof manualEntry.preferredImageTitle === 'string') {
      const want = manualEntry.preferredImageTitle.replace(/^File:/i, '').trim().toLowerCase();
      manualIdx = list.findIndex((p) => String(p.title || '').replace(/^File:/i, '').trim().toLowerCase() === want);
    }
    if (manualIdx < 0 && Number.isInteger(manualEntry.preferredPhotoIndex)
      && manualEntry.preferredPhotoIndex >= 0 && manualEntry.preferredPhotoIndex < list.length) {
      manualIdx = manualEntry.preferredPhotoIndex;
    }
  }
  if (manualIdx >= 0) {
    // §8 指定があれば最優先。残りは点数順。
    const chosen = list[manualIdx];
    const rest = list.filter((_, i) => i !== manualIdx)
      .map((p, i) => ({ p, s: scores[i < manualIdx ? i : i + 1].score }))
      .sort((a, b) => b.s - a.s).map((x) => x.p);
    return { photos: [chosen, ...rest], scores, appliedManual: true };
  }
  // 指定が無ければ点数順（同点なら元の順序を保つ）
  const order = list.map((p, i) => ({ p, s: scores[i].score, i }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i)).map((x) => x.p);
  return { photos: order, scores, appliedManual: false };
}
