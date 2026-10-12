# Mission 37F: 写真の「最新・正確」優先（監査と共通選定ロジック）

採択基準: **現実の建物に一致する合法な写真の中で、できるだけ新しいもの。** 新しいだけで別建物・移転前後が誤結合した写真は採用しない。

## 1. 監査（`node tools/mission37f-audit-photos.cjs` → `data/reports/mission37f-photo-audit/audit.json`）

対象: `public/map-data/osaka-city/derived/building-photo-index.json`（36L、生成 2026-09-28）の `byCanonicalId`（クリックで使われる表）。

| 項目 | 件数 |
|---|---|
| 建物エントリ（信頼度 VERY_HIGH 344 / HIGH 230） | 574 |
| 写真候補（全件 https サムネイル・ライセンス付き・不適格 0） | 588 |
| 複数候補を持つ建物 | 12（2 枚 10 / 3 枚 2） |
| **撮影日が索引に存在** | **0**（索引に撮影日・アップロード日の項目なし） |
| ファイル名に年のヒントあり（非検証） | 36 |
| 日付不明 (unknown) | 552 |
| 作者欄が定型句（Own work 等） / 作者欄なし | 4 / 10 |
| 解像度 320×200 未満 / 中 / 320×300 以上 | 15 / 423 / 150 |
| 同一ファイルが複数建物に紐付く | 0 |
| 移転疑義の候補（病院/旧/移転 + 2020年以降の年） | 2（阪和病院・阪和記念病院。ロック済み） |

ライセンス内訳: CC BY-SA 3.0 246 / CC BY-SA 4.0 185 / CC0 57 / CC BY 2.5 36 / Public domain 31 / CC BY 3.0 18 / CC BY 4.0 8 / CC BY-SA 2.0 3 / CC BY 2.0 2 / Attribution 1 / FAL 1。

**重要な事実:** 撮影日は 574 件のどれにも検証済みで存在しません。アップロード日も索引にありません（撮影日とみなしていません）。したがって「撮影日が新しい」を厳密に判定できる写真は現在 **0 件**で、ファイル名の年は順位付けの補助にだけ使います。

## 2. 共通の優先順位（`public/mission37f-photo-select.js`、区に依存しない）

1. **適格性（最優先）**: 信頼度が `policy.clickShows`、https サムネイル、ライセンスあり、呼び出し側が渡す移転除外ファイルでない。1 つでも欠けたら、新しくても採用しない。
2. **日付の根拠が新しいもの**: `verified`（検証済み日付表＋https の根拠 URL）> `filename`（ファイル名の年、非検証）> `unknown`。日付不明は「最新」扱いせず、日付ありの後ろ。
3. **同年月なら解像度**、それでも同じなら 36L の元の順序（score 順）。日付が不明どうしでは並べ替えず、元の順序を保つ。
- 画面に日付を出すのは `verified` だけ（現在は検証済み日付表が未整備のため、画面に撮影日は出ません）。
- 区固有のハードコードは無く、移転ルール（`RELOCATED` 表）は呼び出し側から `exclude` として渡す設計です。**今は 37D ページ内に住吉区分（2 件）を置いたままで、24 区展開時はデータファイルへ切り出す必要があります（未実施）。**

## 3. Before → After（ロジックを全 574 件へ適用、`reorderedByDate`）

先頭写真が変わる建物は **5 件**。うち住吉区は 0 件で、阪和 2 件は移転ロックにより After が打ち消されます。

| 建物 | Before（先頭） | After（先頭） | 備考 |
|---|---|---|---|
| 大阪くらしの今昔館 | Tenjimbashi6_on_Tenjimbashisuji-Mall.JPG | Osaka_Museum_of_Housing_and_Living_in_2013.jpg | 年はファイル名のみ（非検証） |
| なんばCITY本館 | Namba1.jpg | Nanba_CITY_2019,02.jpg | 同上 |
| 大阪松竹座 | Osaka_Shochikuza_2010.jpg | Shochikuza_2020-09.jpg | 同上 |
| 阪和病院 | Hanwa_hospital-01.jpg | ~~Hanwa_memorial_hospital_2023-12_2.jpg~~ → **採用しない** | 新病棟写真を旧 ID に付けない（`RELOCATED` で除外、テストで固定） |
| 阪和記念病院 | Hanwa_Memorial_Hospital.JPG | ~~…_2023-12_1.jpg~~ → **採用しない** | 同上 |

住吉区の実表示 QA 5 施設は、変更前後で同一でした（下記 §4）。

## 4. 検証

- `node --test tests/mission37f-photo-select.test.cjs tests/mission37e-places-ui-kit.test.cjs tests/mission37d-sumiyoshi-mvp.test.cjs tests/mission37d-towns.test.cjs`: **58 件中 58 件 pass**（37F の新規 9 件を含む）。
- 実 Chrome（headless・ローカルサーバー）の写真 QA: 4/5 が実クリックで `displayed`（阪和病院・荘厳浄土寺・止止呂支比売命神社・東福寺）。阪和住吉総合病院は 37E と同じ理由（手前の建物に隠れる）で `not-clickable`。処理時間 約 179 秒。Google 通信 0、JS 例外 0。連続切替・解除で前の写真は残らない。
- 課金ガード QA: 全項目 true（Google 通信 0、`kitEnabled=false`）。
- **「写真が新しいほうへ切り替わる」画面サンプルの実クリック検証は 0 件**: 住吉区に先頭が変わる建物が無いためです。変わる 3 件（今昔館・なんばCITY・松竹座）は住吉区外で、住吉区の 3D Tiles に含まれないため検証していません（未検証）。

## 5. 候補が不足する場合（設計。コピー・取得は未実施）

- 索引は 36L が Wikidata / Commons から生成した静的 JSON で、実行時にネットへ問い合わせません（方針維持）。新しい写真の追加は、その生成工程の更新で行います。
- 撮影日の取得元: Commons の `imageinfo` / `extmetadata` の `DateTimeOriginal`（撮影日）。`DateTime` や `timestamp` はアップロード日なので使わない。
- 取得量の見積り: 対象は表示候補 588 ファイル。MediaWiki API は 1 リクエストで最大 50 タイトルまで取れるため、約 12 リクエストで足ります。匿名アクセスでも低頻度で足り、`User-Agent` を明示し、直列で `maxlag` に従う前提です。**今回はネットワーク実行をしていません。**
- 生成物: `photo-dates.json`（ファイル名 → `takenAt`、`evidenceUrl`、`verified`）。`dateInfo` はこの形式を受け取る実装・テスト済みです。
- 検証済み日付が付くと、画面に撮影年を出せるようになり、`filename` ヒントより優先されます。
- 追加候補（新しい別写真）の探索は、建物との一致（point-in-polygon、名称一致）を 36L と同じ基準で通した後に索引へ追加します。距離だけの照合はしません。

## 6. 範囲外・未解決

- Google Places UI Kit は `ENABLED=false` のまま。SDK、API キー、有料通信は追加していません。
- 阪和病院の新病棟 footprint は建物データに無く、2023年写真は旧 ID に付けません（37E のロックを維持）。
- 撮影日は第2段階で取得済み（§7）。verified 420 / unknown 168。
- `RELOCATED` / `PHOTO_CAVEATS` はまだ 37D ページ内（住吉区のみ）。24 区向けのデータ化は次の作業。
- Vercel Preview の画面確認はしていません。

## 7. 第2段階: Commons 撮影日の実取得（実施済み）

- コマンド: `node tools/mission37f-fetch-photo-dates.cjs`（`--limit N` で小規模サンプル、`--offline` / `--fresh` あり）。Node の public GET で `commons.wikimedia.org/w/api.php` の `prop=imageinfo&iiprop=extmetadata|timestamp` のみ。50 件/リクエスト、1.5 秒間隔の直列、`maxlag=5`、429/503 と maxlag は指数バックオフ（最大 5 回）、20 秒タイムアウト、明示的 User-Agent、バッチごとにキャッシュ保存（`data/cache/mission37f-commons/`、gitignore）で中断再開。トークン不要・費用ゼロ（公開の読み取り API のみで、課金サービスは使っていない）。
- 実行結果: 20 件のサンプル → 588 件全件。12 リクエスト、失敗 0。
- 採用規則: `DateTimeOriginal` が ISO（YYYY[-MM[-DD]] [時刻]）のときだけ `verified:true`。アップロード timestamp、`DateTime`、ファイル名の年は使わない。未来日、1900 年未満、不正な月日時、アップロードより後の撮影日は拒否。
- 結果（`public/map-data/osaka-city/derived/photo-dates.json`）: **verified 420 / unknown 168**。精度の内訳は day 395、month 21、year 4。unknown の理由は、非 ISO 表記 156（"Taken on 26 December 2014" 等の英文）、DateTimeOriginal なし 12。英文の日付は、指示どおり自動変換せず原文を保持している。
- 画面: 検証済みのときだけ「撮影: YYYY年M月D日」を根拠 URL へのリンクで表示。それ以外は「撮影: 未確認」。順位は、検証済みの日付 > ファイル名の年 > 不明。ファイル名の年が、検証済みの日付に勝つことはない。
- 同じ建物で先頭が変わる件数: **7 / 574**（第1段階はファイル名ヒントで 5 件）。住吉区の建物は **0 件**。
  - 例: なんばCITY本館 `Namba1.jpg` → `Nanba_CITY_2019,02.jpg`（2019-02-22）、大阪くらしの今昔館 → `…_in_2013.jpg`（2013-01-12）、式内楯原神社 2016-11-06 → 2019-08-30。
  - **要確認**: 丼池繊維会館 → `愛國貯金銀行.png`（2025-01-19）、大阪梅田 → `Hankyu_Osaka-Umeda-STA_Premises.jpg` は、日付は新しいが被写体が同じ建物かを日付だけでは判断できない。索引が同一の建物に対応づけた候補なので順位付けの対象に入れているが、別建物の可能性は未確認。
- 住吉区の写真付き 10 建物のうち、撮影日が検証済みは 9 件（阪和記念病院のみ unknown）。阪和病院の `Hanwa_hospital-01.jpg` は 2020-07-19 で、既存の移転前注記と整合する。
- 阪和病院・阪和記念病院の旧 footprint には 2023 年の新病棟写真を付けない（除外が必須であることをテストで固定）。
- 実 Chrome QA（ローカル）: 5 施設中 4 件が実クリックで写真表示し、撮影日（2020/7/19、2017/10/8、2018/3/4、2008/7/30）が画面に出た。阪和住吉総合病院は前回と同じく、手前の建物に隠れてクリック不可（`not-clickable`）。Google 通信 0、JS 例外 0、連続切替で前の写真は残らない。

## 8. 第3段階（誤表示防止 → 日付精度 → 候補調査）

### 8.1 誤表示防止
- 前段で「被写体が未検証」とした2件を Commons の説明・カテゴリ・座標で調べた（`node tools/mission37f-inspect-commons.cjs <File...>`）。
  - **丼池繊維会館 / `愛國貯金銀行.png`**: カテゴリは `Dobuike Hall`（同建物）だが、**1929年の書籍図版のスキャン**（`PD-Japan-oldphoto`）。`DateTimeOriginal=2025-01-19` はスキャン日で撮影日ではない。
    → 新しい日付と誤認された原因はこれ。日付を不採用にし（`historic-scan-category`）、検証済み 2021-09-07 の `Dobuike_Hall.jpg` が先頭に戻る。
  - **大阪梅田 / `Hankyu_Osaka-Umeda-STA_Premises.jpg`**: 被写体は阪急大阪梅田駅の**ホーム全景**。撮影座標なし。建物の Wikidata は「梅田駅」（複数駅を含む名称）で、この footprint の外観写真と確定できない。→ **保留（hold）**。
- 同じ基準で見直した結果、**`Tenjimbashi6_on_Tenjimbashisuji-Mall.JPG`（大阪くらしの今昔館）も保留**: 被写体は商店街の通り（カテゴリ `Tenjinbashisuji Shopping Street`）。建物名カテゴリの `…in_2013.jpg` を優先する。
- 保留は `public/map-data/osaka-city/derived/photo-review.json` の `holds`（理由・根拠 URL 付き）。36L 索引は変更せず、画像情報は残す。37D ページが任意で読み込み、`rankPhotos` の除外に渡す。
- 汎用ガード: Commons のカテゴリが示す撮影年と `DateTimeOriginal` が食い違う、または古写真系カテゴリ（`PD-*oldphoto` 等）の場合は日付を採用しない。**この規則で新たに落ちたのは2件**（`愛國貯金銀行.png`、`BIC_CAMERA_Namba.JPG`＝カテゴリ年不一致）。
- 阪和病院・阪和記念病院の旧 footprint への2023年新病棟写真の除外は維持（テスト済み）。阪和住吉総合病院の重なりクリック不能も未解決のまま。

### 8.2 日付検証の精度改善
- 英文表記だけを厳格変換: `[Taken on ]D Month YYYY[, HH:MM[:SS]][ (according to Exif data)]`（英語月名の完全一致のみ）。変換後は既存と同じ検証（未来日・不正日・アップロード後を拒否）を通し、`parse:"english-dmy"` と原文 `raw` を保持。
- **拒否**: `(original upload date)` 付き（アップロード日の注記）、範囲 `(… to …)`、自由文、和文（`2024年1月19日` 等。英語以外は推測しない）、略称月名。
- 結果（`photo-dates.json`）: **verified 565 / unknown 23**（前回 420 / 168）。内訳: ISO 418、英文変換 147。unknown 23 = DateTimeOriginal なし 12、非対応表記 9（upload date 注記 5・和文 2・自由文 1・曖昧 1）、カテゴリ不一致/古写真 2。既存 ISO の420件は、カテゴリガードで落ちた2件（`愛國貯金銀行.png`は元々ISO 2025-01-19、`BIC_CAMERA_Namba.JPG`）を除き不変。
- **repo の不備を修正**: `public/map-data/osaka-city` は `.gitignore` 対象で、前段の `photo-dates.json` は実際には commit されていなかった（Preview では日付表が読めず「未確認」表示になる状態）。`git add -f` で追加（既存の索引と同じ扱い）。

### 8.3 候補探索（調査サンプル 16 建物、住吉区周辺 8 + 区外 8）
`node tools/mission37f-candidate-survey.cjs`（Commons `generator=search`、公開 GET のみ、1.5秒間隔、16リクエスト、画像は取得しない）。結果: `data/reports/mission37f-candidates/survey.json`。
- 索引にない別画像の候補 **126件**。自動採用条件（座標100m以内・名称一致・オープンライセンス・検証済み日付・現先頭より新しい）を**すべて満たしたものは0件**。
- 不採用理由（重複あり）: 座標なし 109 / 現先頭より古いか同日 51 / 名称が題名・説明にない 87 / 日付なし・非対応 38 / 座標が遠い 15 / 古写真スキャン 5。
- 座標がないことだけが理由の「人手確認候補」が14件（例: HEP FIVE → `HEP FIVE 20260223.jpg` 2026-02-23 CC BY 4.0、イオン喜連瓜破 → 2024-01-27 の複数枚、ABC-MART梅田ビル → 2020年）。**未採用**。被写体の確認ができるまで索引に入れない。
- 名称検索のノイズ例: 住吉警察署の検索で `Sumiyoshi PL in Osaka Prefecture.svg`（ロゴ、2026-06-01）が最新として出る。名称・日付だけでは採用できない実例。
- 設計: (1) Commons 検索で候補 → (2) 座標・名称・ライセンス・日付ゲート → (3) 通過分だけ `photo-review.json` に `adds` として人手承認後に取り込み（今回は未実装。`holds` と対）。24区展開では Wikidata の P373（Commons カテゴリ）起点の列挙が精度面で有利だが、Wikidata は今回の許可範囲外のため未使用。
- 現状では「新しい別画像を自動で追加」できる件数は **0**。現在の写真が古い建物（例: イオン喜連瓜破の先頭は 1997 年）は、人手確認候補から被写体確認して追加する運用になる。

### 8.4 検証
- `node --test`（37E・37D・37F の4ファイル）57件すべて pass。
- 表示の Before→After: `node tools/mission37f-ranking-diff.cjs`（先頭写真が変わる建物 574 中 3 件）。

## 9. 第4段階: 人手確認候補 14 件の調査と安全な新規採用（3 件）

### 9.1 取り込み経路
- `photo-review.json` に `adds`（schema 2）を追加。`rankPhotos(entry, { adds })` が、`status:"approved-manual"`・対象 canonicalId 一致・撮影日(ISO)・https の根拠 URL/画像 URL・作者あり・ライセンスあり・保留/除外でない、を満たすものだけを候補に加える（満たさなければ無視）。区に依存しない共通処理。
- `node tools/mission37f-build-adds.cjs`: 承認リスト（人が画像を目視し根拠を記録したもの）について、Commons 公式 API（`iiurlwidth=330`）が返す thumbnail/原本/ページ URL・作者・ライセンス・DateTimeOriginal だけを使う。URL を文字列連結で作らない。Commons カテゴリの存在・日付とカテゴリ年の整合・オープンライセンスを再検証し、満たさなければ失敗する。画像ファイルは複製しない。

### 9.2 14 候補の調査（座標なしだけが不採用理由だったもの）
| 建物 | 候補 | 結果 |
|---|---|---|
| イオン喜連瓜破 | `ÆON KIREURIWARI SHOPPING CENTER.jpg`（2024-01-27, CC BY-SA 4.0） | **採用**。カテゴリ=建物名、説明が建物名、画像に AEON ロゴ付きの外観。現先頭は 1997 年撮影の `DIAMOND_CITY_Higashisumiyoshi.JPG`（別名称の施設） |
| イオン喜連瓜破 | 同日の別 2 枚(`ÆON Kireuriwari…`, `ÆON Kire-Uriwari…`)・駐車場 | 未採用(1 枚で十分。駐車場は外観でない) |
| イオン喜連瓜破 | 2012 年の 3 枚 | 未採用(2024 年より古い。自販機写真も含む) |
| HEP FIVE | `HEP FIVE on 26th March 2025.jpg`（2025-03-26, CC0） | **採用**。カテゴリ=HEP FIVE、説明が建物名、画像に HEP FIVE/HANKYU 看板と観覧車の外観 |
| HEP FIVE | `HEP FIVE 20260223.jpg`（2026-02-23, CC BY 4.0） | **未採用**。より新しいが、説明「観覧車が覗くHEP FIVE」で被写体の主眼が観覧車か建物か画像確認なしに決められず、2025 年版が外観を明瞭に写すため。次回追加の候補 |
| ABC-MART梅田ビル | `ABC-MART UMEDA Building.jpg`（2020-11-27, CC BY-SA 4.0） | **採用**。カテゴリ=建物名、説明が建物名、画像に ABC-MART 看板のある低層部とビル外観 |
| ABC-MART梅田ビル | `PRESTIA ATM…`(2015) | 未採用(ATM の屋内写真) |
| 住吉警察署 | `住吉警察署（旧庁舎）.jpg`(2018) | 未採用。説明は『1994年まで使用された旧庁舎』で現庁舎ではない |
| 住吉警察署 | `Sumiyoshi PL in Osaka Prefecture.svg`(2026) | 未採用(ロゴ) |
| 大阪松竹座 | `Osaka Shochikuza.jpg`(2021-03-18) | **未採用・要確認**。カテゴリ・説明は一致するが、画像の目視確認をしていない（残件） |

採用 3 / 未採用 11（うち要確認 2: HEP FIVE 2026・松竹座 2021）。座標がないことだけを理由にはせず、カテゴリ一致・説明・画像目視で判断した。

### 9.3 検証
- `node --test`（37E・37D・37F の 5 ファイル）62 件 pass（`tests/mission37f-photo-adds.test.cjs` 5 件を追加）。
- 実 Chrome(headless): `node tools/experiments/mission37e_run_local_qa.mjs tools/experiments/mission37f_adds_panel_qa.mjs` で、3 件とも実ページの `renderPhoto` が新写真を描画（`complete=true`, naturalWidth=330, 表示幅 220, 作者・ライセンス・Commons リンク・撮影日あり）。Google 通信 0・JS 例外 0。**これは QA フック(`?qa=1`・localhost 限定)で写真パネルだけを描いたもので、3D の実クリックではない**（3 件の建物は 9 tile の範囲外）。
- 既存の課金ガード QA は全項目 true。写真の実クリック QA は 5 施設中 4 件 displayed（阪和住吉総合病院のみ not-clickable、従来どおり）。Google 通信 0・JS 例外 0。
- 結果: `data/reports/mission37f-adds/adds-panel-qa.json` とスクリーンショット。
