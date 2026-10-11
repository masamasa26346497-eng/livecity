# Mission 37E — 住吉区 Places UI Kit 写真表示（課金ロック維持）

> **結論を先に**: 実装は **「明示的に無効」の状態で完成**。実ブラウザで Google のどのホストへも
> **リクエスト 0 件**（全 84 リクエスト中）であることを計測で確認した。
> **実写真の表示は未完了**。有効化には下の §6 のブロッカー解消とオーナーの再承認が必要。
> 100 円の実課金テストは**実施していない**。

## 0. 課金に関する実測と結論

| 項目 | 実測値 |
|---|---|
| ページ読み込み〜建物クリックまでの総リクエスト | 84 |
| うち Google 系ホスト（googleapis / google / gstatic 等） | **0** |
| 接続先ホスト | `cdn.jsdelivr.net`（Cesium）, `cyberjapandata.gsi.go.jp`（地理院タイル）, `localhost`（自前データ） |
| DOM 内の `gmp-place-*` 要素 | **0** |
| `createPlaceDetailsElement()` の呼び出し | **例外 `E_BILLING_LOCKED` で停止**（検証済み） |
| JS エラー | 0 |

計測スクリプト `tools/experiments/mission37e_billing_guard_qa.mjs`、
生データ `data/reports/mission37e-places-ui-kit/billing-guard-qa.json`（全リクエスト URL を記録）。

### なぜ「要素を作らせない」ところで止めたか

Google 公式ドキュメントに次の記述がある（2026-10-11 参照）:

> "Places UI Kit queries are billed per component instantiation, not based on the Places API data included in the response."

つまり **コンポーネントを 1 つ生成した時点で課金される**。「生成するがレスポンスを使わない」
「非表示にしておく」では課金を避けられない。したがって課金境界は *要素生成* に置き、
`ENABLED=false` の間は `createPlaceDetailsElement()` が必ず例外を投げる設計にした。
前バージョンは無効フラグがありながら要素を生成できてしまう作りだったので、ここを直した。

---

## 1. 公式ドキュメントで確認した実値（憶測なし）

参照日 2026-10-11。

| 項目 | 確認した値 | 出典 |
|---|---|---|
| 親要素 | `<gmp-place-details>` / `<gmp-place-details-compact>` | place-details |
| Place 指定 | `<gmp-place-details-place-request place="ChIJ…">` | place-details |
| 内容設定 | `<gmp-place-content-config>` | place-details |
| 写真 | `<gmp-place-media>` — 属性 `lightbox-preferred`(bool, 既定 false) / `preferred-size`(既定 null) | child-elements |
| 帰属表示 | `<gmp-place-attribution>` — 属性 `light-scheme-color`(既定 GRAY) / `dark-scheme-color`(既定 WHITE) | child-elements |
| ライブラリ | `places` | getting-started |
| ローダー | `v: "weekly"`（**alpha / beta チャンネルは不要**） | getting-started |
| SKU | **Places UI Kit Pro**（`42AB-1FB3-B56A`） | overview / pricing |
| 単価 | **$5.00 / 1,000 件**（0–100k 帯） | pricing |
| 無料枠 | **5,000 件 / 月** | pricing |
| 課金契機 | **コンポーネント生成ごと** | overview |

**修正点**: 旧 `mission37e-places-ui-kit.js` は `gmp-place-rating` / `gmp-place-opening-hours` /
`gmp-place-address` を含んでいた。写真表示に不要なので、公式に実在する要素のうち
**`gmp-place-media` と `gmp-place-attribution` の 2 つだけ**に絞った
（課金は生成回数なので件数は変わらないが、取得する情報は目的の範囲に留める）。
タグ名・属性名は上表の実値と一致することをテストで固定している。

### 非 Google 地図（Cesium）と並べて使えるか → **使える。ただし条件つき**

- UI Kit 紹介文: *"for the first time, you can use Places content on a non-Google map"*
- 表示ポリシー: *"Places API results displayed on a map must be shown on a Google Map, with proper attribution."*
- 同: *"When displaying Places API data without a Google Map, you must include the Google logo, adhering to the provided style guidelines."*
- 同: *"You must always credit the author when displaying photos or reviews."*

→ **右サイドパネルに写真を出すのは可**。ただし **Google ロゴの表示が必須**で、
**Cesium の地図上にピン等として Places の結果を描くのは不可**。
この 3 点はモジュールの `DISPLAY_POLICY` に原文つきで持たせ、ロゴ未実装を有効化ブロッカーに入れた。

---

## 2. 実データで判明した照合キーの誤り（Issue の記載と異なる）

Issue #26 には「照合キーは `cg_` + canonicalId」とあるが、**実データでは 1 件も当たらない**。

| キーの作り方 | 住吉区 9 タイル（表示建物 10,546 棟）での一致 |
|---|---|
| `cg_` + canonicalId（Issue 記載） | **0** |
| `cg_bldg_` + canonicalId（実測で正） | **271** |

索引キーは `cg_bldg_` + 建物 id（例 `cg_bldg_bldg_000a2259-…`、`cg_bldg_osm_…`）で、
`canonicalId` は建物 id そのもの（`bldg_…`）。接頭辞は `cg_bldg_` が正しい。
修正前の 37D の配線は `cg_` を使っていたため、**この機能は一度も照合できていなかった**。
正しいキーに直し、両方の件数をテストで固定した。

VERIFIED 索引そのものは健全（14,112 件すべて `ChIJ` 形式、不正値 0）。

---

## 3. 変更ファイル

| ファイル | 内容 |
|---|---|
| `public/mission37e-places-ui-kit.js` | **全面書き換え**。課金境界の明示、公式実値の保持、地区非依存の `PlacePhotoPanel`、見積もり API |
| `public/mission37d-sumiyoshi-mvp.html` | インラインの照合処理を共通モジュールへ委譲。モジュールを本体より前に読み込み（重複読み込みを解消） |
| `tests/mission37e-places-ui-kit.test.cjs` | **新規**。オフライン 25 件 |
| `tools/experiments/mission37e_billing_guard_qa.mjs` | **新規**。実ブラウザで全リクエストを記録する検証 |
| `data/reports/mission37e-places-ui-kit/` | **新規**。計測結果 JSON と画面写真 |
| 本レポート | 新規 |

**変更していないもの**: 本番 HTML 2 ファイル、37B / 37C のページ、Mission 36L 写真データ、
canonicalId 体系、Wikimedia 写真の挙動。

### 24 区への横展開

共通モジュールは**実行コードに地区固有の文字列を一切持たない**（テストで固定）。
区を増やすときにこのページ側で要るのは索引 URL の差し替えだけで、UI 改修は不要。

```js
new LiveCityPlacesUiKit37E.PlacePhotoPanel({
  indexUrl: '<区ごとの索引>.json',   // 唯一の地区差分
  container: document.getElementById('<描画先>'),
});
```

---

## 4. テスト結果

### オフライン Node テスト（Google 通信なし）— `node --test tests/mission37e-places-ui-kit.test.cjs`

**25 件 / 25 pass / 0 fail**。内訳:

- 課金ロック 4 件（要素生成が必ず例外 / SKU・単価・無料枠 / 100 件の見積もり / ポリシー原文）
- 通信経路 4 件（ローダー・エンドポイント不在 / API キー不在 / 同一オリジン強制 / 索引 1 本のみ）
- 照合キー 3 件（`cg_` は 0 件・`cg_bldg_` が正 / 二重接頭なし / 全件 ChIJ）
- 実データ照合 4 件（VERIFIED 建物 5 件 / 未照合 / 通信失敗 / HTTP エラー）
- 非同期競合 3 件（連続選択で最新が勝つ / 解除 / 解除後の遅延到着を捨てる）
- マークアップ 2 件（公式タグ・属性と一致 / 未文書化の属性を足していない）
- 既存機能 5 件（Wikimedia 経路 / canonicalId 経路 / 読み込み順 / 地区非依存 / 他ページ非汚染）

### 実ブラウザ検証 — `tools/experiments/mission37e_billing_guard_qa.mjs`

全項目 OK: Google リクエスト 0 / `ENABLED=false` / 配線済み / VERIFIED 建物で照合済み表示と
Place ID 保持 / 未照合で Place ID が消える / 連続選択で最新が残る / 解除で空 /
要素生成が `E_BILLING_LOCKED` で停止 / `gmp-*` 要素 0 / Wikimedia スロット健在 / JS エラー 0。

### 周辺テスト

`mission37d-sumiyoshi-mvp` / `mission37d-towns` / `mission37c-livecity-theme` / `mission37b-3dtiles`
= 45 件中 **44 pass / 1 fail**。失敗 1 件は後述の既存不具合で、**本ミッションの変更が原因ではない**
（当該テストが読むのは `building-photo-index.json` と建物タイルのみで、どちらも変更していない）。

---

## 5. 既存の不具合（報告のみ・未修正）

**37D の Wikimedia（36L）写真は、同じ接頭辞の誤りで住吉区では 1 枚も表示されていない。**

| キー | 36L 写真索引との一致（住吉区 9 タイル） |
|---|---|
| `cg_` + canonicalId（現在の 37D の実装） | **0** |
| `cg_bldg_` + canonicalId | **5** |

これが `tests/mission37d-sumiyoshi-mvp.test.cjs` の
「写真索引のキーは cg_ + 建物 id」が落ちている原因でもある。
1 行（`'cg_'` → `'cg_bldg_'`）で直るが、**Issue #26 の範囲外で、かつ
「既存の Wikimedia 写真は維持」との指示があるため本ミッションでは変更していない**
（「表示 0 枚」から「5 件表示」への挙動変更になるため）。修正してよいか指示をいただきたい。

もう 1 点、`tests/mission37b-cesium-poc.test.js` は `.js` 拡張子で `require()` を使っており、
`"type": "module"` の本リポジトリでは元から実行できない（37B レポートの「未実行」と整合）。
同じ理由で 37E の共通モジュールは CommonJS export を持たず、
テストは `node:vm` で読み込む形にしてある。

---

## 6. 有効化のためのチェックリスト（オーナー承認待ち）

`LiveCityPlacesUiKit37E.describeActivation(100)` が返す内容と同じ。

### 未解決ブロッカー（全部潰れるまで有効化しない）

1. **100 円で確実に止まる仕組みが未検証。** Google Cloud の予算アラートは*事後通知*であり、
   上限保証ではない。API キーの HTTP リファラ制限とフロント側の回数制限も、
   どちらも「超えたら止まる」保証にはならない。
2. **Google ロゴの表示が未実装**（非 Google 地図でのポリシー必須要件）。
3. **写真の作者クレジット表示が未実装・未確認。**
4. **API キーの保管・配信方法が未決定**（ソースに書かない）。
5. **オーナーの明示的な再承認が未取得。**

### 費用の見積もり（実値ベース。保証ではない）

| 計画イベント数 | 無料枠 | 課金対象 | 概算 |
|---|---|---|---|
| 100 件（提案されたテスト規模） | 5,000 件/月 | **0 件** | **$0.00** |
| 5,000 件 | 5,000 件/月 | 0 件 | $0.00 |
| 6,000 件 | 5,000 件/月 | 1,000 件 | $5.00（約 750 円） |

**注意**: 無料枠 5,000 件/月は Google 側の請求設定に依存する。
無料枠が適用されない契約形態では 100 件でも $0.50（約 75 円）が発生しうる。
また「1 クリック = 1 生成」なので、**クリックのたびに課金イベントが積み上がる**。
誤操作や再描画のループで一気に数千件に達する経路が無いことを、有効化前に必ず確認すること。

### 有効化の手順（承認後）

1. 上の 1〜5 を解消する。特に 1 は「どう止めるか」を文書で確定させる。
2. `public/mission37e-places-ui-kit.js` の `ENABLED` を `true` にする。
3. 公式ローダー（`v:'weekly'`、ライブラリ `places`）の読み込みを**明示的な操作の後にだけ**行う配線を追加する。
   自動ロードは入れない。
4. Google ロゴと作者クレジットの表示を実装する。
5. 少数（10 件程度）で動作を確認し、請求画面でイベント数を突き合わせてから件数を増やす。

---

## 7. 再現手順

```bash
# オフラインテスト（Google 通信なし）
node --test tests/mission37e-places-ui-kit.test.cjs

# 実ブラウザ検証（要 Edge/Chrome。別シェルで静的サーバを立ててから）
python -m http.server 8137 -d public
node tools/experiments/mission37e_billing_guard_qa.mjs
```
