# MISSION 32R — FINAL UI CLEANUP BEFORE PRODUCTION

**判定: `FINAL_UI_CLEANUP_SUCCESS`**（validator PASS・error 0・warning 0）

- **変更したファイル:** development 用の `public/osaka_3d_buildings.ward-ux-v1.html` のみ。
- **変更していないもの:** Building V2 / OSM fallback V2 / ROAD V3 / projection / origin / 区の割当 / placement policy / production / protected。

---

## 完了報告（§18）

### 1. パネルと card が競合していた原因

- 開発用 status パネル（`#canonical-runtime-status`）は `z-index 99997`、property card（`#prop-card`）は `99995`。パネルが後から前面に置かれた（31G-FIX19C）ため、card が隠れていました。
- 位置も重なっていました。パネルは画面右下に固定（`right:12px; bottom:12px`）で上へ伸び、card は右上（`right:20px; top:64px`・幅 280px）なので、右側で重なります。
- さらに card は `overflow:hidden` で最大高さの指定が無く、画面が低いと下側が切れて読めませんでした（1280×720 で確認）。

### 2. 修正方法（§2 の候補から A + C を採用）

**card を前面に出し（C）、card 表示中はパネルを card の左へ退避させる（A）** 方式にしました。パネルは消していません（§3）。

- `#prop-card` の `z-index` を 99998（パネルより上）に。
- card 表示中は `body.lc-prop-card-open` が付き、パネルを `right: 20px + 280px + 12px` へ退避。card を閉じると元の位置（right 12px）へ戻ります。
- card の状態は `MutationObserver` で監視しているので、どの経路（クリック / ✕ / 別建物の選択）でも同期します。
- card に `max-height: calc(100vh - topbar - 28px)` と縦スクロールを付け、低い画面でも全文を読めるようにしました。
- 狭い画面（768px 以下、card が下端シートになる）ではパネルを動かさず、薄く・操作を通すようにしています。

### 3. 6 地点の card 表示（実ブラウザ）

card の矩形内に格子状の点を取り、その点が card 自身に当たるか（他要素に覆われていないか）を `elementFromPoint` で確認しました。

| 地点 | 隠れていた点 | パネルとの重なり | 画面内に収まる | 最下部まで表示可 |
|---|---|---|---|---|
| 梅田 / 本町 / 難波 / 天王寺 / 住吉 / 東淀川 | **0 / 各 85 点** | **なし** | ○ | ○ |

- 画面サイズ 1600×1000 / 1280×720 / 700×900 のいずれでも、隠れた点 0・全文表示可でした。
- card を閉じるとパネルは元の位置に戻ります（`panelRight: 12`）。

### 4. 旧・最寄駅ロジックの原因

```js
const STATIONS = ['コスモスクエア駅','中ふ頭駅','大阪港駅','弁天町駅','朝潮橋駅','トレードセンター前駅'];
const station = STATIONS[Math.floor(r*STATIONS.length)];   // r = 建物 ID のハッシュ
const walkMin = 3 + Math.floor(r*15);                      // 徒歩 3〜17 分（乱数）
```

旧 3 区（南港）時代の 6 駅を直書きし、**建物 ID のハッシュで 1 駅を選び、徒歩分数も乱数**で作っていました。位置とはまったく無関係だったため、梅田でも「弁天町駅（徒歩12分）」と表示されていました。

### 5. 新しい最寄駅ロジック

- **データ:** `data/processed/osaka-city/canonical/rail/stations.json`（233 駅）と同一内容の公開ファイル `public/map-data/osaka-city/derived/rail-stations.json`。新規の外部取得はしていません（バイト一致を validator で確認）。
- **判定:** 建物 footprint の**面積重心**から各駅までの world 距離（m・znorth-neg-v1）を計算し、最小の駅を選びます。
- **表示:** 「大阪駅（直線距離 約90m）」のように**直線距離のみ**。徒歩時間は出しません（§8）。
- **データ範囲の扱い（§10 で必要になった追加）:** 駅データの元（OSM 抽出）は北緯 34.74° より北を含みません（`data/reports/osm-source-coverage.json` の `latCliff` の実測値）。そのため、
  - 建物が北端より北にある、または
  - 北端までの距離が最寄駅までの距離より短い（範囲外にもっと近い駅があり得る）
  場合は駅名を断定せず、**「—（この付近は駅データ未整備）」** と表示します。
- 駅データが未読込のときは「駅データ読み込み中…」と出し、読み込み後に同じ建物を表示中なら自動で書き直します。
- デバッグ用に `window.__NEAREST_STATION_DEBUG__()` を追加しました（データ源・件数・直近の判定内容・北端）。

### 6. 6 地点の駅 QA（実ブラウザ）

画面表示と、Node 側で独立に計算した最寄駅を突き合わせました。

| 地点 | card の表示 | 独立計算 |
|---|---|---|
| 梅田 | **大阪駅（直線距離 約90m）** | 大阪 / 90m |
| 本町 | **本町駅（直線距離 約180m）** | 本町 / 178m |
| 難波 | **なんば駅（直線距離 約60m）** | なんば / 56m |
| 天王寺 | **天王寺駅（直線距離 約210m）** | 天王寺 / 210m |
| 住吉 | **住吉駅（直線距離 約280m）** | 住吉 / 277m |
| 東淀川 | **—（この付近は駅データ未整備）** | 城北公園通 / 2,245m（北端の外にもっと近い駅があり得るため保留が正解） |

- 名称は実データのままです（「大阪」「なんば」など。末尾に「駅」が無いものだけ付けています）。
- 東淀川で 2.2km 先の駅を「最寄駅」と出すのは誤りなので、上記の範囲判定で保留にしました。

### 7. 「南港南」などの残存件数（before → after）

対象語は 南港南 / 弁天町駅 / 徒歩12分。data/raw・node_modules を除く全ファイル（50,120 件）を走査しました。

| 分類 | before | after |
|---|---|---|
| **開発版 HTML（UI）** | **3** | **0** |
| 開発版 HTML（コメント） | 1 | 0 |
| production / protected HTML（変更禁止） | 8 | 8 |
| 旧実験・staging・backup の HTML コピー | 128 | 128 |
| データ値（「南港南出口」「弁天町駅舎」など地名として正しい） | 8 | 8 |
| 公開データ（道路名） | 4 | 4 |
| 過去レポートの記録 | 17 | 17 |
| テスト・validator の検出用文字列 | 13 | 18 |
| 合計 | 182 | 183 |

- **開発版 HTML からは 0 件になりました。**
- 合計が 1 件増えたのは、今回追加したテストと validator の検出用文字列が 5 件増え、開発版の 4 件が消えたためです。
- production / protected は変更禁止のためそのままです。旧実験・backup の HTML コピー（`public/*.html` の各 wardtest / debug、`temp/`、`backup/`、`handoff/`、`livecity/`）はスナップショットなので触っていません。

### 8. 検索の文言（と範囲判定）

- **文言:** 「現在の3Dデータ提供範囲外です。方向のみ表示しています。」（特定エリア名を含みません）
- **範囲判定も直しました。** 以前は旧 3 区の範囲（原点から x ±2,400m / z ±550m）で判定していたため、**梅田・難波・天王寺・本町の検索がすべて「範囲外」扱い**になり、地点へ移動せず方向だけ向く動作でした。文言だけ変えると「梅田は提供範囲外」という誤った表示が残るので、判定を大阪市 24 区（N03 区界。区界が未読込のときは canonical 建物の bbox）に合わせました。
- 実ブラウザでの確認:

| 検索語 | 範囲外メッセージ | 移動先と地点の距離 |
|---|---|---|
| 梅田 / 難波 / 天王寺 / 本町 | 出ない | 0m（正しく移動） |
| QA 用の市外地点（神戸付近） | 出る（新しい文言） | — |

### 9. Validator — `data/reports/final-ui-cleanup-validation.json`

| 項目 | 値 |
|---|---|
| buildingV2Mutation / roadV3Mutation / projectionMutation | 0 / 0 / 0 |
| placementMutation（placement・区インデックス） | 0 |
| propertyCardVisibleAboveDevPanel | true |
| nearestStationUsesCanonicalStationData | true |
| nearestStationUsesWorldDistance | true |
| staleNankoMinamiSearchText | false |
| walkingTimeShown | false |
| productionModified / protectedModified | false / false |

32P・32Q の validator も再実行し、どちらも PASS でした（32Q にあった「南港南が残る」警告は解消）。

### 10. npm test

- `npm test`: **1,729 tests / pass 1,714 / fail 0 / skip 15**。追加は `tests/final-ui-cleanup.test.js`（7 件）。
- `npm test` に含まれない lifestyle-tab テストも実行し、fail 0 でした。

### 11. production / protected

**変更なし**（git status でも validator でも確認）。

---

## 回帰確認（§14・実ブラウザ）

| 項目 | 結果 |
|---|---|
| hover / クリック / 建物選択 | 6 地点とも狙った建物を選択・card 表示 |
| property card | 全文表示（上記 3） |
| 検索 | 上記 8 |
| V1 / V2 + OLD OSM / V2 + NEW OSM ボタン | 画面のボタンをクリックして切替・復帰。residual は常に 0 |
| 区切替 / City Mode | 北区へ切替・City Mode とも residual 0 |
| Map Audit / Reference Alignment | ON→OFF とも正常。終了後 residual 0 |
| 開発用 status パネル | 表示されたまま（`[CANONICAL OK]`） |
| ブラウザの例外 | 0 件 |

## 今回触っていない既知の表示（production 切替の判断材料）

- card の「推定階数 / 推定利回り / 想定賃料 / メモ」は、建物 ID から作る仮の値のままです（`buildPropertyData`。今回の 3 点に含まれないため変更していません）。
- 「町丁目データ」は canonical 建物では常に「データなし」です（旧 3 区の町丁目データにしか対応していないため）。

## 生成物

| 種別 | パス |
|---|---|
| レポート | `data/reports/final-ui-cleanup-qa.json`、`final-ui-cleanup-validation.json`、`stale-ui-text-scan-{before,after}.json`、`data/reports/final-ui-cleanup-qa/*.jpg` |
| ツール | `tools/audit/stale-ui-text-scan.js`、`tools/audit/final-ui-cleanup-qa.js`（`npm run preview` が必要）、`tools/validate/final-ui-cleanup.js` |
| テスト | `tests/final-ui-cleanup.test.js`（npm test に追加） |
| 変更 | `public/osaka_3d_buildings.ward-ux-v1.html` のみ |

production へはまだ反映していません。次の Mission で production cutover のみを行う想定です。

`READY_FOR_PRODUCTION_CUTOVER`
