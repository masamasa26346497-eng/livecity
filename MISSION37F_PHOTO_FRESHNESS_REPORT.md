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
- 撮影日は 588 件すべて未検証（unknown 552 / ファイル名の年のみ 36）。
- `RELOCATED` / `PHOTO_CAVEATS` はまだ 37D ページ内（住吉区のみ）。24 区向けのデータ化は次の作業。
- Vercel Preview の画面確認はしていません。
