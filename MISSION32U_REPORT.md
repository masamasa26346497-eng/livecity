# MISSION 32U — PRODUCTION CUTOVER

**判定: `PRODUCTION_CUTOVER_SUCCESS`**（validator PASS・error 0・warning 0）

- **昇格したもの:** development で確定した `public/osaka_3d_buildings.ward-ux-v1.html` を `public/osaka_3d_buildings.html`（production）へ。
- **protected:** `public/osaka_3d_buildings.fullward-v3.html` は**不変**（hash 一致）。
- **新機能は作っていません。** 変換はビルドプロファイル 1 行の差し替えだけです。

---

## cutover のやり方

`tools/build-production-html.js` が dev HTML を読み、**1 行だけ**を置換して production を書き出します。

```
- const LIVECITY_BUILD_PROFILE = 'development';
+ const LIVECITY_BUILD_PROFILE = 'production';
```

- 2 ファイルの差分は**この 1 行のみ**（19,134 行中 1 行。テストで検証）。
- production では `<html data-livecity-build="production">` が付き、開発用 overlay が CSS で隠れ、起動時 self-check が動きます。コードは残したままです（§16）。
- `node tools/build-production-html.js --check` で「production が dev の生成結果と一致するか」を検証できます（validator もこれを使用）。

---

## 完了報告（§29）

### 1. production building mode

`V2 CORRECTED + OSM V2`（内部表記 `V2_NEW_OSM` / `buildingsVersion = 'V2N'`）。起動時 self-check の実測値です。

### 2. 件数

**600,764**（PLATEAU 574,112 + OSM fallback V2 26,652）。runtime・canonical manifest とも一致。
placement は `v2-final`（DISPLAY 600,567 / SUPPRESS 1 / REVIEW 100 / EXEMPT 96）。

### 3. ROAD mode

`ROAD_V3`（`roadVisualMode` の実測値）。

### 4. raw GSI edge

`false`（OFF）。fetch も 0 件（下記 10）。

### 5. legacy residual

**0**。起動時・9 地点・河川 2 地点・City Mode・smoke のすべてで 0。
`[CanonicalRuntime] self-check: ok` が console に出ており、駐車場・墓地等の旧レイヤーが scene 直下に出ていないことを確認。

### 6. property data の方針

- 表示するのは **用途 / 高さ / 階数 / 底面積 / 区 / 最寄駅 / 建物 ID** のみ。
- 高さは実測の裏付け（`measuredHeight` / LOD 形状の標高差 / OSM の height・levels タグ）があるときだけ表示。`階数 × 3.0m` の換算値と変換時の既定値 3.0m は**表示しない**（§10）。
- 階数は PLATEAU `bldg:storeysAboveGround` の実値のみ。高さからの推定はせず、9999 センチネルは除外（§11）。
- 推定利回り / 想定賃料 / 自動メモ / 仮値の注記 / 未対応の町丁目セクションは production HTML に**存在しません**（コード・DOM とも）。
- hover の「建物属性」も同じ基準（根拠のある高さだけ「高さ / 底面→頂部」を出す）。

### 7. 最寄駅

canonical 駅データ **233 駅**（`map-data/osaka-city/derived/rail-stations.json`）と建物重心の world 距離で判定。**直線距離のみ**表示し、徒歩時間は出しません。駅データ範囲外（OSM 抽出の北端 34.74°より北など）は「—（この付近は駅データ未整備）」。

### 8. 検索範囲

旧 ±2,400m 判定は使っていません（`isInside3dDataArea`＝N03 24 区の coverage）。QA では「難波」検索で範囲外メッセージが出ず、目的地との距離 0m。

### 9. 開発用 UI の非表示

HTML 内の id を静的に洗い出した **開発用 UI 48 個**（V1/V2 切替・ROAD mode 切替・Map Audit・Reference Alignment・Building Alignment・100m ruler・Visible Alignment QA・Ground FP QA・GSI EDGE QA・OLD/SEMANTIC 比較・WARD-DIAG・status debug panel・GSI prototype トグル等）は production で**すべて非表示**（visible 0 件）。
画面に出ている固定 overlay は `lc-topbar` / `lc-panel`（レイヤー・表示設定）/ `lc-mapctl`（ズーム等）のみ。
通常 UI（検索・街を見る・都市を分析・区セレクタ・property card・facility card・tooltip・コンパス・レイヤーパネル）は全て存在します。

### 10. fetch 監査（§21）

起動から 9 地点・河川・smoke・性能計測までの全 24,971 リクエストを CDP の Network で記録して分類しました。

| 監査項目 | 件数 |
|---|---|
| V1 building tile（`/derived/*/buildings/`） | **0** |
| V1 placement / ward index | **0** |
| 旧 OSM fallback（`/derived-v2-corrected/`） | **0** |
| raw GSI road edge | **0** |
| V2 + NEW OSM building tile（`/derived-v2-osmv2/*/buildings/`） | **1,832** |
| building-facts（card / hover の lazy fetch） | 12 |

runtime 側のカウンタも `{V1: 0, V2: 0, V2N: 1,878, VISUAL: 0}` で一致。

### 11. 9 地点 QA（実ブラウザ・Edge headless／実 GPU）

各地点で建物を真上からクリックし、hover・card・区・最寄駅・禁止表示を確認（screenshot: `data/reports/production-cutover-qa/site-*.jpg`）。

| 地点 | 区 | 高さ | 階数 | 底面積 | 最寄駅 | 仮値表示 |
|---|---|---|---|---|---|---|
| 梅田 | 大阪市北区 | 24.3 m | （実データなし） | 389.0 m² | 大阪駅（直線距離 約90m） | 0 |
| 本町 | 大阪市中央区 | 47.9 m | 13 階 | 447.9 m² | 本町駅（約180m） | 0 |
| 難波 | 大阪市浪速区 | 9.1 m | （なし） | 567.3 m² | なんば駅（約60m） | 0 |
| 天王寺 | 大阪市阿倍野区 | 44.6 m | （なし） | 1019.1 m² | 天王寺駅（約210m） | 0 |
| 住吉 | 大阪市住吉区 | 6.3 m | 1 階 | 900.8 m² | 住吉駅（約280m） | 0 |
| 東淀川 | 大阪市東淀川区 | 29.9 m | 8 階 | 607.9 m² | —（この付近は駅データ未整備） | 0 |
| 鶴見 | 大阪市鶴見区 | 9.2 m | 2 階 | 845.7 m² | 横堤駅（約240m） | 0 |
| 旭 | 大阪市旭区 | 5.8 m | 2 階 | 549.0 m² | 千林大宮駅（約290m） | 0 |
| 東成 | 大阪市東成区 | 17.4 m | 5 階 | 1170.4 m² | 今里駅（約420m） | 0 |

- 9 地点とも hover 表示・狙った建物の選択・card 表示・residual 0。
- 禁止表示（推定利回り / 想定賃料 / 仮の参考値 / 町丁目データなし / 徒歩）は 0 件、町丁目セクションは全地点で非表示。
- 建物と地図（GSI ベース）の位置一致・二重建物なし・ROAD V3 の見え方は screenshot で確認しました。

### 12. 河川 QA

| 地点 | 確認内容 | screenshot |
|---|---|---|
| 大川（都島区付近） | 建物が水面へ侵入していない。橋・道路は自然 | `river-okawa.jpg` |
| 淀川（西淀川区付近） | 建物が堤防の内側で止まり、水面上に建物なし | `river-yodogawa.jpg` |

### 13. 性能（§22）

30 秒静止計測。まず cutover QA 本体（CDP の Network 記録あり）で測り、次に **Network 記録なし**で production / development を交互に 2 巡ずつ測り直しました（`data/reports/production-perf-recheck.json`）。

| 条件 | 梅田 FPS 平均 | 住吉 FPS 平均 | frame P95 | draw calls | triangles |
|---|---|---|---|---|---|
| **production（Network 記録なし・2 回）** | **52.2 / 53.7** | **52.9 / 54.1** | 33.4ms | 349 / 256 | 445,520 / 673,968 |
| development（同条件・2 回） | 50.3 / 50.9 | 51.5 / 51.9 | 33.4ms | 349 / 256 | 445,520 / 673,972 |
| 32P の dev 実測（参考） | 46.1 | 46.1 | 33.5ms | 375 / 302 | 630,571 / 881,172 |
| cutover QA 内の計測（Network 記録あり） | 30.3 | 30.0 | 50.2ms | 349 / 256 | 445,520 / 673,972 |

- production と development は**同一シーン**（draw calls・triangles が一致）で、FPS も同等〜わずかに production が上。**cutover による性能悪化はありません。**
- QA 本体の計測が 30 FPS 台なのは、CDP で全リクエストを記録している（＋別プロセスが同時に走っていた）ためで、条件を揃えた測り直しでは 52〜54 FPS でした。計測条件の差であり production の問題ではありません。
- JS heap 310〜430MB、計測中の読み込み中タイル 0〜1。

### 14. Validator — `data/reports/production-cutover-validation.json`

| 項目 | 値 |
|---|---|
| productionDefaultBuildingMode | **V2_NEW_OSM** |
| productionBuildingCount | **600764** |
| productionRoadMode / productionRawGsiEdge | **ROAD_V3** / **false** |
| productionUsesBuildingFacts | **true** |
| productionFakeYield / FakeRent / FakeNote / FakeFloors | false / false / false / false |
| productionLegacyResidual | **0** |
| productionDevPanelsVisible | **false**（開発用 id 48 個すべて非表示） |
| v1ProductionFetch / oldOsmProductionFetch / rawGsiEdgeFetch | **0 / 0 / 0** |
| protectedModified | **false** |
| productionIsGeneratedFromDev | true（`--check` で一致） |

### 15. npm test

- `npm test`: **1,746 tests / pass 1,731 / fail 0 / skip 15**（追加は `tests/production-cutover.test.js` 8 件）。
- `npm test` に含まれない lifestyle-tab 系: 38 件 / fail 0（skip 11 は既存の探索パス都合）。
- **テスト更新（cutover に伴う必然の変更）:** 「production に本ミッションの変更が混入していない」という守り方をしていた **53 ファイル**を、**protected のみを守る**形に変更しました。production の中身は今回の validator / `tests/production-cutover.test.js` が検証します。あわせて 9 つの mission テストは「production は promoted build（Mission NN を含む）」という逆向きの検査に変え、cutover 前の版へ戻っていないことを守ります。
- 参考: `tests/mission15-label-engine.test.js` の 12 件は **今回とは無関係の既存の失敗**（dev HTML に `LabelEngine` 実装が無い）。このファイルは `npm test` の対象外です。

### 16. protected の hash

| ファイル | before | after |
|---|---|---|
| `public/osaka_3d_buildings.fullward-v3.html` | `85ca253f…8b0176` | **`85ca253f…8b0176`（一致）** |
| `public/osaka_3d_buildings.html`（production） | `91613556…6e4d3c` | `f1ff3e77…43ed81`（promoted build） |

`data/reports/baselines/prod-protected-hashes.json` を更新し、`prodBeforeCutover32U` に cutover 前の hash と git blob を残しました。

### 17. ロールバック方法（§24）

production は git 管理下にあり、手動バックアップは作っていません。

```bash
git checkout -- public/osaka_3d_buildings.html     # HEAD（cutover 前）へ戻す
```

- cutover 前の blob: `32b889fefaeb12f94148fdbbe9699ac15ddf1db2`（HEAD = `df5bff0`、最終更新コミット `57a10e5`）
- 再度 cutover する場合: `node tools/build-production-html.js`

---

## §25 に従い、今回やっていないこと

V1 データ・旧レポート・OneDrive の競合コピー・deprecated ID は**一切削除していません**。cutover のみです。

## 生成物

| 種別 | パス |
|---|---|
| ビルド | `tools/build-production-html.js`（`--check` 付き）、`data/reports/production-cutover-build.json` |
| QA | `tools/audit/production-cutover-qa.js`、`tools/audit/production-ui-visibility.js`、`tools/audit/production-perf-recheck.js`（いずれも `npm run preview` が必要） |
| レポート | `data/reports/production-cutover-qa.json`、`production-ui-visibility.json`、`production-perf-recheck.json`、`production-cutover-validation.json`、`data/reports/production-cutover-qa/*.jpg` |
| Validator | `tools/validate/production-cutover.js` |
| テスト | `tests/production-cutover.test.js`（npm test に追加）＋ 既存 62 ファイルのガード更新 |
| 変更したファイル | `public/osaka_3d_buildings.html`（生成）、`public/osaka_3d_buildings.ward-ux-v1.html`（ビルドプロファイル・production 用 CSS・self-check を追加） |

`PRODUCTION_CUTOVER_SUCCESS`

production は安定した状態です。§31 に従い、V1 データセット削除・デバッグ基盤の撤去・過去レポートの整理へは進まず、ここで停止します。
