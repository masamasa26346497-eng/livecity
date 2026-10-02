# Mission 36A — Wikidata 座標 × 建物 footprint で写真対応を拡張

対象: dev `public/osaka_3d_buildings.ward-ux-v1.html` と写真索引のみ
production / protected: **変更なし**

---

## 先に: ブランチ番号の重複について

開始時にリポジトリを確認したところ、35Z 以降に別セッションで作業が進んでいた。

- `81efe4e 36A: strengthen roads and render them above water` — **別の 36A** が既にある（道路）
- `8eabd13 Merge Mission 36F: citywide building photo linkage` — **36F が写真の全域拡張を済ませていた**

ただし 36F の対応付けは `resolveByDirectId` / `resolveByNameAndCoordinate` による
**半径 60m の距離マッチ**（+ 一意性の検査）で、本ミッションが求める
「座標が実 building polygon の内側か」ではなかった。よってこの作業は重複ではない。
ブランチ名は指示どおり `feature/mission-36a-footprint-photo-matching` を使っている。

---

## §1 build 時に footprint を使う

配信中の canonical 建物タイル（`derived-v4-final/near/buildings`・500m グリッド・618,749 棟）を
そのまま読む。巨大な索引ファイルは作らず、**点が属する 500m タイルとその周囲 3×3 だけ**を読み、
LRU（900 タイル）で持ち回る（`tools/photos/footprint-lookup.mjs`）。

canonical タイルの属性には **建物名が無い**（usage / heightM / wardId など）ので、
§6 の名前照合には 35O の `building-name-labels.json`（canonicalId → 実在する建物名）を
join している。

## §2 Wikidata 候補

35Z/36F が取得済みの 2,596 件（Wikidata の QID・ラベル・P625 座標・P18 画像・Wikipedia）を
そのまま使った。写真とライセンスは取得済みなので、**ネットワークは一切使わずに
対応付けだけを引き直す**（`tools/photos/rematch-photos-by-footprint.mjs`）。

参考までに SPARQL で数え直すと、大阪市 bbox 内で「座標あり かつ P18 画像あり」の
Wikidata item は **2,947 件**。現在の索引 2,596 件はこのほぼ全量にあたる。

## §3/§4 point-in-polygon による判定

| 判定 | 条件 | 件数 |
|---|---|---:|
| **VERY_HIGH** | 1 棟の内側 ＋ 名前一致 / ランドマーク登録 / OSM id 一致 | **345** |
| **HIGH** | 1 棟の内側。建物側に名前が無く、矛盾もしない | **231** |
| AMBIGUOUS | 複数棟に入る / 複合施設 / building part / **同じ建物の取り合い** | 530 |
| UNRESOLVED | どの footprint の中にも無い、または名前が矛盾 | 1,490 |

判定そのものは exact-building が 952 件あるが、そのうち
**同じ Wikidata item の重複 349 件**と、**同じ建物を別の item と取り合った 27 件**を
AMBIGUOUS へ落としているため、採用は 576 件（VERY_HIGH 345 + HIGH 231）になる。
「1 棟につき主張できる記録は 1 件だけ」を保つための整理で、
索引全体で canonicalId の重複は **0 件**。

- footprint の内側にあった: **1,273 / 2,596**
- matchType: exact-building **952** / complex 146 / building-part 8
- 名前の裏付け: 一致 **556** / ランドマーク 20 / 建物に名前なし 146 / **矛盾のため不採用 167**

穴（中庭）は内側にしない。MultiPolygon はどのパートでも内側になる。**距離は一切使っていない**
（`footprint-photo-matching.mjs` に `Math.hypot` も `nearest` も存在しないことをテストで検査）。

## §5 BuildingPart / 複合施設

- 点が 2 棟に入り、一方が他方の 3 倍以上の面積 → `building-part`（**採用しない**）
- 駅・商業施設・大学・病院などを示す名前/instance → `complex`（**採用しない**）
- ただし重なっていても **名前が一致する棟が 1 つだけ**なら、それを採る

## §6 名前による二重確認

polygon の内側だけでは確定しない。Wikidata 側の呼び名（curation 名・ja/en ラベル）と
建物名を正規化して突き合わせ、**矛盾したら採らない**。

途中で実際に誤りを出した: 最初の実装で Wikidata 名の配列に
「前回の対応付けで入った建物名」を混ぜていたため、名前が矛盾していても自分自身と一致して
しまい、監査 120 件中 **6 件が誤採用**されていた（JR難波→OCAT、ホテルグランヴィア大阪→
サウスゲートビルディング、キッズプラザ大阪→関西テレビ放送 など、いずれも
「大きな建物の中にある施設」）。Wikidata 側の名前だけを使うよう直して 0 件になった。

---

## §7 coverage（大阪市 24 区）

| | 件数 |
|---|---:|
| Wikidata 写真候補（索引内） | 2,596 |
| うち写真あり | 1,792 |
| footprint 照合対象（座標あり） | 2,596 |
| **footprint の内側にあった** | **1,273** |
| **unique match（採用）** | **576**（VERY_HIGH 345 + HIGH 231） |
| ambiguous | 530 |
| unresolved | 1,490 |
| **hover 写真対応建物** | **5（35Z）→ 266（36F）→ 574（36A）** |

### 区別の対応数（24 区すべてに到達）

北 274 / 中央 174 / 天王寺 82 / 此花 51 / 西 42 / 阿倍野 33 / 福島 32 / 浪速 29 /
都島 24 / 東住吉 24 / 東淀川 22 / 平野 20 / 住之江 19 / 西成 18 / 港 17 / 生野 15 /
住吉 13 / 城東 13 / 大正 13 / 淀川 11 / 鶴見 11 / 東成 7 / 旭 6 / 西淀川 2

**名前が無い建物で採用できたのは 231 棟。** 35Z が名前一致しか使えず 5 棟だったのに対し、
polygon の内外を根拠にしたことで、名前の無い建物にも正しく結び付けられるようになった。

## §8 Commons geosearch の調査 — **採用しない**

build 時に `generator=geosearch` で引けることは確認した（グランフロント大阪から 500m で
50 件、全件ライセンスあり・全件 GPS 座標あり）。

しかし上位の結果は **メルセデス・ベンツの車の写真 3 枚**だった。Commons の座標は
「撮影者がいた場所」であって「写っている対象」ではないため、
**座標が建物の中にあっても、その建物の写真とは限らない**。
§8 の「単に建物から近い写真は採用禁止」に照らし、この経路は**調査のみで採用しない**。
採るならカテゴリ/タイトル/説明の照合が必須で、それは別途の作業。

## §9 索引の拡張

既存スキーマを保ったまま各 record へ追加:
`matchMethod`（= `footprint`）/ `matchConfidence` / `matchType` / `nameEvidence` /
`ambiguityReason` / `insideFootprint` / `insideFootprintCount` / `footprintCanonicalId` /
`footprintCandidates` / `wikidataCoordinate`（lat/lon/x/z）/ `photoScores` / `preferredFrom`。

`policy.matching` に判定方式、`policy.noDistanceFallback` に「距離だけでは決めない」を明記。

---

## §11 誤マッチ監査（120 件）

自動採用 574 件から等間隔で 120 件を抜き、独立した証拠で突き合わせた
（`tools/photos/audit-footprint-matches.mjs`）。

| | 件数 |
|---|---:|
| **correct** | **120** |
| **wrong building** | **0** |
| ambiguous | 0 |
| no match | 0 |
| **accuracy** | **100%** |

採用の根拠: 名前一致 76 / ランドマーク 1 / 幾何のみ 43。
36F（距離方式）との比較: 一致 42 / 相違 14 / 36F では結べなかったもの 64。

---

# 追加要件: 写真は外観全体が見える表示に

## §1/§2/§6 crop しない・歪ませない

- hover も click のメイン画像も **`object-fit: contain`**。`cover` はファイル内に 1 つも残っていない
- 幅と高さを同時に固定しない（`max-width` / `max-height` と `width:auto` / `height:auto`）
- **向きごとの規則で `width:100%` を使わない。** 最初これを入れたところ、高さ上限に当たったときに
  **箱の縦横比が元画像とずれた**（実測: 1.336 の画像が箱では 1.463）。中央寄せは figure 側に任せ、
  画像は幅も高さも auto にして解決した
- 2 枚目以降だけサムネイル扱い（メインは必ず全体表示）

## §3/§4 可変アスペクト比

読み込み後に `naturalWidth / naturalHeight` から向きを決め、figure に class を付ける。

| 判定 | 比 | hover の高さ上限 |
|---|---|---:|
| `is-panorama` | ≧ 2.4 | 130px |
| `is-landscape` | ≧ 1.15 | 190px |
| `is-square` | 0.87〜1.15 | 220px |
| `is-portrait` | ≦ 0.87 | 260px |

16:9 の固定枠には押し込んでいない（`aspect-ratio:16/9` はファイル内に無い）。

## §5 背景

余白は `#eef1f4`（地図 UI に合う淡いグレー）。黒帯にしない。

## §7/§8/§9 写真の選び方

タイトル・説明から「全景らしさ」に点を付けて並べ替える
（`tools/photos/lib/photo-preference.mjs`）。
外観 / facade / 全景 は加点、内部 / 看板 / 接写 / 夜景 / 工事中 / 図面 は減点、
極端な縦横比（3.2 超）も減点。
`data/photos/building-photo-manual.json` に `preferredImageTitle` か
`preferredPhotoIndex` があればそれを最優先（指定が見つからなければ点数順へ戻す）。
hover は先頭 1 枚、click は最大 3 枚（1 枚目が全景）。

## §10/§11 表示の実機 QA（16 標本）

超横長 / 横長 / 正方形 / 縦長 / 超縦長 に加え、あべのハルカス・通天閣・グランフロント大阪・
グラングリーン大阪・大阪中之島美術館・なんばパークスを実際に描いて測った。

| 確認項目 | 結果 |
|---|---|
| すべて `object-fit: contain` | OK（16/16） |
| 元の縦横比が保たれている（歪まない） | OK（16/16。箱の比と元画像の比の差 2% 以内） |
| カードからはみ出さない | OK（16/16） |
| ライセンス表示が隠れない | OK（16/16） |
| カードが画面外へ出ない | OK（16/16） |
| 向きの内訳 | 縦長 6 / 横長 5 / 正方形 3 / 超横長 2 |
| 画像の読み込み失敗 | 0 |
| **JS 例外** | **0** |

画: `display-01`〜`display-16`（band と判定した向きをファイル名に入れてある）。
**crop 発生件数 0。**

---

## §12 テスト

`tests/mission36a-footprint-photo-matching.test.js` — **29 件 / fail 0**
`tests/mission35z-building-photo-preview.test.js` — **14 件 / fail 0**
（判定語が VERY_HIGH / HIGH / AMBIGUOUS / UNRESOLVED へ変わったので、
「決められた値しか入らない」「hover には弱い根拠を出さない」という 35Z の意図はそのままに、
語彙だけ 36A のものへ合わせた）

`npm test` 全体は **2,266 pass / 10 fail**。この 10 件は
`exact-triangle-highlight` / `mission-36e-full-surface-highlight` / `max-plateau-lod` /
`mission08-building-edge` で、**36A 着手前の HEAD でも同じ 10 件が落ちる**ことを
（dev HTML と索引を HEAD へ戻して）確認済み。36A が増やした失敗は 0 件。
これらは 36B〜36F の作業由来で、本ミッションの担当範囲外のため触っていない。
（point-in-polygon / 穴 / MultiPolygon / 面積 / 投影 / VERY_HIGH・HIGH の条件 /
名前矛盾で不採用 / 重なりで AMBIGUOUS / building-part / 複合施設 / hover は HIGH 以上のみ /
距離 fallback が存在しない / 全景優先 / preferredPhoto と不在時の戻し / 向き判定 /
contain / 歪ませない / 可変高さ / 実寸から向きを決める / 索引スキーマ / ライセンス必須 /
監査 wrong=0 / 表示 QA / production・protected 未変更）

## 未解決事項

- **UNRESOLVED が 1,490 件**。内訳は「footprint の外」1,323 と「名前が矛盾」167。
  前者には bbox は大阪市内だが near タイルが無い場所（郊外・埋立地など）も含む。
- **AMBIGUOUS 154 件は未対応のまま**。駅・商業施設など 1 item = 複数棟のものは、
  §5 のとおり勝手に 1 棟へ割り当てていない。complex をランドマークカード側で扱う導線は未実装。
- **Commons geosearch は未採用**（§8 の理由）。
- 表示の QA はデスクトップ幅 1440x900 のみ。mobile 幅での確認は未実施。

## 追加要件のまとめ（表示）

| | 内容 |
|---|---|
| hover 画像 | `object-fit: contain`・幅高さとも auto・上限のみ・余白 `#eef1f4` |
| click メイン画像 | 同じく `contain`（2 枚目以降だけ小さいサムネイル扱い） |
| 可変アスペクト比 | `naturalWidth/naturalHeight` から panorama / landscape / square / portrait を判定し上限だけ変える |
| preferredPhoto | `preferredImageTitle` / `preferredPhotoIndex` が最優先。無ければ全景スコア順 |
| 全景が確認できた建物 | 実機 16 標本すべて（うち §11 の名指し 6 棟を含む） |
| **crop 発生件数** | **0** |
