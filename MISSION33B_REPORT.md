# MISSION 33B — CITY LABELS + VIVID PALETTE PRODUCTION CUTOVER

**判定: `CITY_LABELS_PALETTE_PRODUCTION_SUCCESS`**（validator PASS・error 0・warning 0）

Mission 33A で確定した **地名・駅名・主要施設ラベル** と **明るい配色** を production へ正式反映しました。
新機能は追加していません。production は `node tools/build-production-html.js` で development から生成しています（dev との差分はビルドプロファイル 1 行のみ）。

---

## 1. production のラベル件数

| 種別 | 件数（データ） | 出所 |
|---|---|---|
| 地名 | **697**（広域 60 / 中位 200 / 局所 437） | `derived/place-labels.json` |
| 駅名 | **233 駅 → 174 クラスタ** | `derived/rail-stations.json`（Mission14 のクラスタリングを再利用） |
| 主要施設 | **19** | `landmarks/landmarks.json` |
| 区名 | **24** | `derived/map-label-anchors.json`（N03 2026 の面積加重セントロイド） |
| 公園名 | **137**（広域 39） | 同上（canonical parks の名称付きポリゴン） |

画面に出る件数（実測・1600×1000）:

| 地点 | 合計 | 施設 | 駅 | 地名 | 区 | 公園 |
|---|---|---|---|---|---|---|
| 梅田 | 31 | 5 | 2 | 16 | 1 | 7 |
| 本町 | 34 | 2 | 6 | 23 | 0 | 3 |
| 難波 | 32 | 3 | 7 | 20 | 1 | 1 |
| 天王寺 | 30 | 4 | 10 | 14 | 0 | 2 |
| 住吉 | 28 | 2 | 3 | 18 | 0 | 5 |
| 東淀川 | 1 | 0 | 0 | 0 | 1 | 0 |
| City Mode（大阪市全域） | 18 | 7 | 3 | 0 | 8 | 0 |

## 2. ラベルのカテゴリと優先順位

**ランドマーク > 区名 / 駅 > 地名 > 公園**（33A で確定した 1 本の優先度キュー。production で件数・しきい値は変えていません）。
band 別上限 far 18 / mid 36 / near 58、画面 6×4 グリッドで 1 セル 3 件まで、NDC 矩形で衝突判定、200ms スロットル — いずれも 33A と同一の値が production に入っていることを validator が検査しています。

## 3. ラベルの重なり

| 条件 | 重なり組数 | 完全重複（読めない） | 最小文字高 |
|---|---|---|---|
| 6 地点（近景） | **すべて 0** | 0 | 25px 以上 |
| City Mode（広域） | **0** | 0 | **25.5px**（中央値 27px・最大 28px） |

33A 時点で報告した「City Mode で 9 組の接触」は **原因を特定して解消**しました（下記 §16-1）。

## 4. 配色（33A と同一値）

| 要素 | 値 |
|---|---|
| 背景 | `0xf6f7f3` |
| 地表 | `0xebede6` |
| 水域 | `0x63bfe4` / 港湾 `0x55a9d0` |
| 公園・緑地 | `0x9bd589` / `0x8fcd7b` / `0xc9e7b6` |
| 道路 | `0x979ea9` |
| 鉄道 | `0x49546a` / `0x4f5f9e` / `0x69717f` |
| 建物の白寄せ | far 0.46 / mid 0.20 / near 0.06 |
| 建物の彩度・明度 | `CR_VIVID = { sat: 1.24, light: 1.03 }` |
| 露出・光量 | `CR_STYLE = { exposure: 0.93, hemi: 0.74, sun: 1.28, fill: 0.26 }` |

建物の用途色（`CR_USAGE_COLOR`）と material 分類は変更していません。

## 5. 7 地点 QA（production・実ブラウザ）

| 地点 | ラベル | 重なり | hover | クリック | card | 仮値 | residual |
|---|---|---|---|---|---|---|---|
| 梅田 / 本町 / 難波 / 天王寺 / 住吉 / 東淀川 | 上表のとおり | 0 | ○ | 狙った建物を選択 | 表示 | 0 | 0 |
| City Mode | 18 | 0 | — | — | — | — | 0 |

card の実例（梅田）: 「事務所 ／ 大阪市北区」高さ 24.3m・区 大阪市北区・最寄駅 大阪駅（直線距離 約90m）、仮値 0、町丁目セクション非表示。

## 6. City Mode QA

- ラベル 18 件（主要施設 7・駅 3・区 8）。重なり 0、文字高 25.5〜28px。
- 平均輝度 0.8083 → **0.8336**、平均彩度 0.0388 → **0.0545**。
- legacy residual 0。

## 7. 性能（production・各 30 秒）

| 条件 | FPS 平均 | FPS p5 | frame P95 | draw calls | triangles | JS heap | 表示ラベル |
|---|---|---|---|---|---|---|---|
| 梅田 | **52.2** | 29.9 | 33.4ms | 392 | 626,361 | 498MB | 21 |
| 難波 | **52.7** | 29.9 | 33.4ms | 281 | 806,333 | 555MB | 21 |
| 住吉 | **52.5** | 29.9 | 33.4ms | 302 | 863,660 | 514MB | 20 |
| City Mode | **34.4** | 29.8 | 33.6ms | 1,528 | 1,791,404 | 440MB | 18 |

33A の development 実測（梅田 41.2 FPS・同一マシン、ただし別プロセス稼働中）より高い値です。ラベルによる draw call の増加は 20 前後で、**大幅な悪化はありません**。City Mode の 34.4 FPS は広域の描画負荷（draw call 1,528・triangle 179 万）が主因で、ラベルは 18 sprite のみです。

## 8. before / after スクリーンショット（同一カメラ）

`data/reports/city-labels-production-qa/` に保存。

| 地点 | before（旧 production） | after（新 production） |
|---|---|---|
| 梅田 | `umeda-before.jpg` | `umeda-after.jpg` |
| 難波 | `namba-before.jpg` | `namba-after.jpg` |
| 住吉 | `sumiyoshi-before.jpg` | `sumiyoshi-after.jpg` |
| City Mode | `city-before.jpg` | `city-after.jpg` |

画面の実測値（WebGL canvas を読み出して算出）:

| 地点 | 平均輝度 before → after | 平均彩度 before → after | ラベル before → after |
|---|---|---|---|
| 梅田 | 0.6595 → **0.7061** | 0.1074 → **0.1369** | 0 → 31 |
| 難波 | 0.6849 → **0.7280** | 0.0898 → **0.1187** | 0 → 32 |
| 住吉 | 0.6941 → **0.7389** | 0.0985 → **0.1288** | 0 → 28 |
| City Mode | 0.8083 → **0.8336** | 0.0388 → **0.0545** | 0 → 18 |

## 9. クリック / hover の回帰

6 地点すべてで **hover ツールチップ表示 ○ / 狙った建物のクリック選択 ○ / property card 表示 ○**。
ラベルは `THREE.Sprite`（`depthTest:false`）で、建物ピッキングの raycast 対象（建物メッシュ配列）には入っていないため、ラベルの上をクリックしても建物が選ばれます。実測でも全地点で意図した建物 ID が選択されました。

## 10. 検索の回帰

「難波」検索 → 範囲外メッセージ **出ない**、目的地との距離 **0m**。

## 11. fetch 監査（起動〜全操作、36,198 リクエストを CDP Network で分類）

| 項目 | 件数 |
|---|---|
| V1 building tile / V1 placement | **0 / 0** |
| 旧 OSM fallback（derived-v2-corrected） | **0** |
| raw GSI road edge | **0** |
| V2 + NEW OSM building tile | 1,685 |
| ラベルデータ（place / anchors / stations / landmarks） | 6 |
| runtime カウンタ | `{V1: 0, V2: 0, V2N: 1,750, VISUAL: 0}` |

## 12. runtime configuration（production 起動時 self-check）

```
profile         : production
buildingMode    : V2_NEW_OSM        buildingCount : 600,764
placementVariant: v2-final
roadMode        : ROAD_V3           rawGsiEdge    : false
legacyResidual  : 0                 CityLabelLayer: ACTIVE（地名/駅/施設/区/公園）
```
開発用パネル（status / WARD-DIAG / perf-hud / FPS / residual）はすべて非表示、通常 UI（ヘッダー・検索・街を見る・都市を分析・区セレクタ・レイヤーパネル・property card）は表示。
レイヤーパネルの行: 建物 / 道路 / 河川 / 海 / 公園 / 鉄道 / **駅名 / 地名 / 施設名**。

**§13 トグル実測**（梅田・同一視点）:

| トグル | OFF にしたとき | ON に戻したとき |
|---|---|---|
| 地名 | 地名 16 → **0** | 16 |
| 駅名 | 駅 2 → **0** | 2 |
| 施設名 | 施設 5 → **0** | 5 |

## 13. Validator — `data/reports/city-labels-production-cutover-validation.json`

| 項目 | 値 |
|---|---|
| productionIsGeneratedFromDev / buildRecordMatches | true / true |
| labelRulesSame / productionPalette | true / true |
| productionLabelsActive / labelToggleWorks | true / true |
| labelSevereOverlaps / nearViewOverlaps / cityModeOverlaps | 0 / 0 / 0 |
| pickingRegression / searchRegression / fakeValuesInCard | false / false / 0 |
| buildingMode / buildingCount / roadMode / rawGsiEdge | V2_NEW_OSM / 600764 / ROAD_V3 / false |
| legacyResidual | 0 |
| v1ProductionFetch / oldOsmProductionFetch / rawGsiEdgeFetch | 0 / 0 / 0 |
| buildingGeometryMutation / roadV3Mutation / projectionMutation | 0 / 0 / 0 |
| protectedModified | false |

Mission 32 の production 系 validator（32P / 32Q / 32R / 32S / 32U）と 33A の validator も再実行し、**すべて PASS**。
（32 系の「production が変更されていないこと」の判定は、git の汚れではなく **最後に昇格したビルド成果物との一致**で見るように更新しました。cutover 後も再実行できます。）

## 14. npm test

- `npm test`: **1,766 tests / pass 1,751 / fail 0 / skip 15**（追加は `tests/city-labels-production-cutover.test.js` 8 件）。
- `npm test` 対象外の lifestyle-tab 系も **fail 0**。

## 15. protected の hash

| ファイル | before | after |
|---|---|---|
| `public/osaka_3d_buildings.fullward-v3.html` | `85ca253f…8b0176` | **`85ca253f…8b0176`（一致・不変）** |
| `public/osaka_3d_buildings.html`（production） | `f1ff3e77…43ed81` | `21561f27…25f6ba` |

## 16. 既知の制約・今回直したこと

### 16-1. 今回 development 側で直した 2 件（cutover の前提として必要だった）

1. **ラベルが古いカメラで配置されることがあった**: `place()` が `camera.matrixWorldInverse` の更新前に投影していたため、カメラを大きく動かした直後は「前の地点の視界」で判定され、スロットルでその結果が固定されていました（本町で 34 → 5 件に見える現象）。`camera.updateMatrixWorld()` を投影前に呼ぶよう修正。
2. **旧 StationLabelLayer が復活していた**: `rebuild()` が無条件に `scene.add(group)` していたため、駅タイルの件数が変わるたびに旧ラベルと駅ドットが画面に戻っていました（City Mode で 0.3px の点が 15 個＝「接触 9 組」の正体）。`allowShow` フラグを追加し、`show()` を呼ばない限り scene に入らない・`update()` も走らないようにしました（コードと debug API は §4 のとおり残しています）。

いずれも 33A の設計（件数・しきい値・デザイン）には手を入れていません。修正後に production を再生成し、最終 QA を取り直しています。

### 16-2. 残る制約（今回は対応しない）

1. **東淀川（大阪市北部）はラベルが区名のみ**。`osaka-latest.osm.pbf` が北緯 34.735° で切れており、place / station ノードが存在しません（§14 の方針どおり、無い場所に偽ラベルを作っていません）。
2. **「グラングリーン大阪」「うめきた公園」などの新しい施設は未登録**（`landmarks.json` は 19 件。§15 のとおり data-enrichment ミッションへ）。
3. **「京橋」「新大阪」は地名ラベルが無く、駅名としてのみ表示**（町丁目名として OSM に存在しないため）。
4. 河川名ラベル・夜間配色の追い込み・施設ラベルの建物頂部アンカーは未実装（§29 のとおり本ミッションでは進めません）。

## 17. ロールバック方法

production は git 管理下にあり、手動バックアップは作っていません。

```bash
git checkout -- public/osaka_3d_buildings.html   # cutover 前（HEAD）の版へ戻す
```

- HEAD の blob: `32b889fefaeb12f94148fdbbe9699ac15ddf1db2`（HEAD = `df5bff0`）
- 直前ビルドの hash は `data/reports/production-cutover-build.json` に記録（`previousProductionSha256`）
- 再度昇格する場合: `node tools/build-production-html.js`（`--check` で現物とビルド結果の一致だけを検証）

---

## 生成物

| 種別 | パス |
|---|---|
| QA | `tools/audit/city-labels-production-qa.js`（`--phase before/after`・`--only city|toggles`） |
| Validator | `tools/validate/city-labels-production-cutover.js` |
| レポート | `data/reports/city-labels-production-qa.json`、`city-labels-production-cutover-validation.json`、`data/reports/city-labels-production-qa/*.jpg` |
| テスト | `tests/city-labels-production-cutover.test.js`（npm test に登録） |
| 変更したファイル | `public/osaka_3d_buildings.html`（生成物）、`public/osaka_3d_buildings.ward-ux-v1.html`（上記 16-1 の 2 件の修正）、Mission 32 validator の production 判定 |

production は安定状態です。§29 に従い、北部 OSM 補完・河川名ラベル・ランドマーク追加・夜間 palette・施設頂部アンカーへは進まず、ここで停止します。

`CITY_LABELS_PALETTE_PRODUCTION_SUCCESS`
