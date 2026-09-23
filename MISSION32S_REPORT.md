# MISSION 32S — PRODUCTION DATA INTEGRITY CLEANUP

**判定: `PRODUCTION_DATA_INTEGRITY_READY`**（validator PASS・error 0・warning 1）

- **変更した表示ファイル:** development 用の `public/osaka_3d_buildings.ward-ux-v1.html` のみ。
- **変更していないもの:** Building V2 geometry / OSM fallback V2 / ROAD V3 / projection・origin / 区の割当 / placement policy / production HTML / protected HTML。
- **追加したデータ（既存ファイルは書き換えていない）:** `derived-v2-osmv2/building-facts/`（新 namespace・996 tile）。

---

## 完了報告（§16）

### 1. 仮の値がどこから来ていたか（§1/§11）

`buildPropertyData(d)` が **建物 ID の文字列ハッシュ**（`pseudoRand`）を乱数の種にして、位置とも実データとも無関係な値を作っていました。

| 表示 | 生成元 | 実データとの関係 |
|---|---|---|
| 推定階数 | `estimateFloors(dz) = Math.round(高さ / 3.2)` | なし（階高 3.2m は仮定） |
| 推定利回り | `yieldRate = (4.0 + r*3.2).toFixed(1)`（`r = pseudoRand(建物ID)`。コメントにも「4.0〜7.2%仮」と書かれていた） | なし（価格・費用データが存在しない） |
| 想定賃料（月） | `estimateRentPerTsubo(usage)`（用途別の仮単価表）× 坪数 ×（0.85 + r×0.3）を ±10〜15% の幅にした値 | なし（賃料データが存在しない） |
| メモ | 定型文 6 種の配列から `pseudoRand` で 1 つ選択 | なし |
| 「※ 表示価格は座標・規模から自動算出した仮の参考値です」 | 固定文言 | 上記を正当化するための注記 |
| 最寄駅・徒歩◯分 | 旧 3 区の 6 駅を直書き＋ハッシュ選択＋乱数の分数 | なし（**32R で実データ化済み**） |

全リポジトリ走査（`Math.random` / `pseudoRand` / 利回り / 賃料 / 推定階数 / メモ、`data/raw`・`node_modules` 除く）の結果は `data/reports/property-card-provenance.json`。

| 分類 | 件数 | 扱い |
|---|---|---|
| 開発版 HTML | **8** | 内訳は「削除した経緯を説明するコメント」6 件と、公園の樹木配置用 `randomPointInPolygon` の `Math.random` 2 件（[ward-ux-v1.html:2594](public/osaka_3d_buildings.ward-ux-v1.html#L2594)）。**card の表示値を作る記述は 0 件** |
| production / protected HTML | 44 | 変更禁止のため触っていない（production 切替時に同じ掃除が必要） |
| 旧実験・backup の HTML コピー | 708 | スナップショットのため対象外 |
| ツール・テスト・レポート | 22 | 検出用の文字列・記録 |

### 2. どう直したか（§2〜§6/§10）

- **削除**: `pseudoRand` / `estimateFloors` / `estimateRentPerTsubo` / `fmtYen` / メモ配列 / 注記、および DOM（`#pc-floors` の旧・推定値枠、`#pc-yield`、`#pc-rent`、`#pc-memo`、`.pc-disclaimer`）。`buildPropertyData` は footprint から計算する底面積だけを返します。
- **「推定」ラベルで逃げない（§10）**: 根拠が無い項目は行ごと非表示にし、「0」「—」「データなし」も出しません。
- **高さ（§2/§3/§10）**: canonical には `heightM` しか残っておらず、**変換時の既定値 3.0m と実測値を画面で区別できません**でした。そこで生 CityGML（205 ファイル + ZIP 内 270 エントリ = 8.4GB、延べ 1,228,497 棟）を走査して建物ごとの `bldg:measuredHeight` / `bldg:storeysAboveGround` を取り出し、**高さの根拠**を確定しました（`tools/audit/plateau-height-provenance-scan.js`）。判定順は変換器（`tools/convert-plateau-buildings.js`）と同一です。

| heightBasis | 意味 | 棟数 | card 表示 |
|---|---|---|---|
| 1 | `measuredHeight`（実測） | 523,923 | **出す** |
| 2 | LOD 形状の標高差 | 17 | **出す** |
| 4 | OSM の `height` / `building:levels` タグ | 14,492 | **出す** |
| 3 | 階数 × 3.0m の換算 | 16,384 | 出さない（代わりに階数を出す） |
| 0 | 根拠なし（変換時の既定値 3.0m / OSM の class 既定値） | 45,948 | 出さない |

- **階数（§3）**: canonical に階数は 1 件もありません（`levels` 非 null = 0）。生 CityGML の `bldg:storeysAboveGround` の実値がある **466,818 棟（77.7%）** にだけ「階数」を出します（9999 等のセンチネル値は実データとして扱わない）。高さからの推定は行いません。
- **配信方法**: 既存の建物 tile・placement・geometry は**一切書き換えず**、新しい namespace `derived-v2-osmv2/building-facts/tile_x_z.json`（996 tile）を追加しました。ランタイムは **card を開いた／hover した建物の tile だけ**を遅延取得します（描画側の tile 取得経路は変更なし）。
- **hover の「建物属性」（§8）** にも同じ基準を適用しました（根拠のある高さのときだけ「高さ / 底面→頂部」を出す）。

### 3. production 候補の card に出る項目（§8/§9）

| 項目 | 出す条件 |
|---|---|
| 用途（バッジ・用途行） | 常に（canonical の `usageLabel`。100%） |
| 高さ | 実測の裏付けがあるとき（89.62%） |
| 階数 | PLATEAU の `storeysAboveGround` 実値があるとき（77.7%） |
| 底面積 | 常に（footprint から計算） |
| 区 | `wardId` があるとき（99.96%。区界の外 232 棟は行ごと非表示） |
| 最寄駅・直線距離 | 駅データ範囲内のとき（範囲外は「—（この付近は駅データ未整備）」） |
| 建物 ID | 開発用。production では `#pc-id` を隠せます（§9） |

開発用の debug 情報（canonicalId / source / LOD / geometrySource / 開発パネル / `window.__PROPERTY_CARD_DEBUG__`）は production 候補で削除・非表示にできます。

### 4. 各項目のデータ出所（§13）

`data/reports/property-card-provenance.json` に field / source / real か derived か / availability を出力しました。要点:

| 項目 | 出所 | 種別 | 充足率 |
|---|---|---|---|
| 用途 | canonical `usageLabel`・`usage`（PLATEAU `bldg:usage` コード / OSM `building` タグ） | real | 100% |
| 高さ | canonical `heightM` ＋ building-facts の heightBasis（生 CityGML の `measuredHeight` / LOD 形状 / OSM タグ） | real | 89.62% |
| 階数 | 生 CityGML `bldg:storeysAboveGround` | real | 77.7% |
| 底面積 | canonical geometry（footprint の面積計算） | real（幾何から計算） | 100% |
| 区 | canonical `wardId`（N03 2026 の区界判定） | real | 99.96% |
| 最寄駅・直線距離 | canonical 駅データ 233 駅と建物重心の world 距離 | derived（実データ間の距離計算） | 範囲内のみ |
| 建物 ID | canonical `canonicalId` | real | 100% |

### 5. 町丁目の扱い（§7）

canonical 建物は町丁目を持たず、町丁目統計は**旧 3 区の町丁目マスタにしか存在しません**。「町丁目データなし」と表示するのをやめ、`#pc-town-section` を **section ごと非表示**にしました（中の地価・人口・年齢・地域統計・生活タブも同時に隠れます）。区は N03 の実データなので表示します。

> 注記: この結果、canonical 建物を選んだときは地価・人口・年齢・地域統計・生活タブが出ません。これらを 24 区へ広げるには、町丁目境界と統計を大阪市全域へ拡張するデータ作業が別途必要です。

### 6. 6 地点の実ブラウザ確認（§12）

Edge headless（実 GPU）で各地点の建物をクリックし、card の**表示中テキストだけ**を収集して禁止語を照合しました（`data/reports/production-data-integrity-qa.json`、スクリーンショット `data/reports/production-data-integrity-qa/*.jpg`）。

| 地点 | 高さ | 階数 | 底面積 | 区 | 最寄駅 | 禁止語 |
|---|---|---|---|---|---|---|
| 梅田 | 24.3 m | （なし＝センチネル 9999） | 389.0 m² | 大阪市北区 | 大阪駅（直線距離 約90m） | 0 |
| 本町 | 47.9 m | 13 階 | 447.9 m² | 大阪市中央区 | 本町駅（直線距離 約180m） | 0 |
| 難波 | 9.1 m | （なし＝センチネル 9999） | 567.3 m² | 大阪市浪速区 | なんば駅（直線距離 約60m） | 0 |
| 天王寺 | 44.6 m | （なし＝センチネル 9999） | 1019.1 m² | 大阪市阿倍野区 | 天王寺駅（直線距離 約210m） | 0 |
| 住吉 | 6.3 m | 1 階 | 900.8 m² | 大阪市住吉区 | 住吉駅（直線距離 約280m） | 0 |
| 東淀川 | 29.9 m | 8 階 | 607.9 m² | 大阪市東淀川区 | —（この付近は駅データ未整備） | 0 |

- 禁止語は 推定階数 / 推定利回り / 利回り / 想定賃料 / 賃料 / 「／月」/ 定型メモ / 仮の参考値 / 町丁目データなし / データなし / 徒歩 / 推定。**6 地点とも 0 件**、町丁目 section は全地点で `display:none`。
- 高さの根拠が無い OSM fallback 建物も 3 棟クリックしました。梅田・天王寺の 2 棟（heightBasis=0）は**高さ行ごと消えている**ことを確認。本町では狙った建物の代わりに隣の OSM 建物（heightBasis=4＝OSM タグ由来）が選ばれたため高さが出ています（これは実データなので正しい表示）。この 1 件が validator の warning です。
- ブラウザ例外 0 件、legacy residual 0。

### 7. Validator — `data/reports/production-data-integrity-validation.json`

| 項目 | 値 |
|---|---|
| fakeYieldVisible / fakeRentVisible / fakeNoteVisible / fakeFloorCountVisible | false / false / false / false |
| unsupportedTownChomeVisible | false |
| propertyCardFieldsHaveRealSource | true |
| buildingV2Mutation / roadV3Mutation / projectionMutation / placementMutation | 0 / 0 / 0 / 0 |
| productionModified / protectedModified | false / false |

- 表示内容は canonical 属性・building-facts と 1 棟ずつ突き合わせています（高さ・階数・区・用途・hover の一致を `fieldChecks` に記録）。
- 32P / 32Q / 32R の validator も再実行し、いずれも PASS。

### 8. npm test

- `npm test`: **1,738 tests / pass 1,723 / fail 0 / skip 15**。追加は `tests/production-data-integrity.test.js`（9 件）。
- `npm test` に含まれない `lifestyle-tab` 系も実行: 38 件 / fail 0（skip 11 は「production HTML を旧候補パスに探す」既存の設計によるもので、今回の変更とは無関係）。

### 9. production / protected

**変更なし**（git status・validator の両方で確認）。production への反映は行っていません。

---

## 既知の制約（production 切替の判断材料）

1. **高さが出ない建物が 62,332 棟（10.4%）あります**（根拠なし 45,948 ＋ 階数換算 16,384）。これは仮値を出さないための意図的な非表示です。うち PLATEAU の 33,788 棟は元データに `measuredHeight` も階数も無く、変換時の既定値 3.0m が入っています。
2. **階数は PLATEAU のみ**。OSM 由来の 26,652 棟は canonical に階数が残っていないため出ません。
3. **facts tile は表示中の namespace のものだけ**を引きます。開発用の V1 / V2 + OLD OSM 表示には facts が無いため、その 2 モードでは高さ・階数が出ません（production 候補の V2 + NEW OSM では出ます）。
4. **hover の初回**は facts tile の取得が終わるまで高さ行が出ません（tile 取得後はマウスが動いた時点で表示、実ブラウザで確認済み）。
5. **町丁目に紐づくタブ**（地価・人口・年齢・地域統計・生活）は canonical 建物では出ません（上記 §5 の通り）。

## 生成物

| 種別 | パス |
|---|---|
| 追加データ | `data/processed/osaka-city/derived-v2-osmv2/building-facts/`、`public/map-data/osaka-city/derived-v2-osmv2/building-facts/`（各 996 tile）、`data/processed/osaka-city/canonical/plateau-height-facts.json` |
| ツール | `tools/audit/plateau-height-provenance-scan.js`、`tools/build-building-source-facts.js`、`tools/audit/property-card-provenance.js`、`tools/audit/production-data-integrity-qa.js`（`npm run preview` が必要）、`tools/validate/production-data-integrity.js` |
| レポート | `data/reports/plateau-height-provenance.json`、`building-source-facts.json`、`property-card-provenance.json`、`production-data-integrity-qa.json`、`production-data-integrity-validation.json`、`data/reports/production-data-integrity-qa/*.jpg` |
| テスト | `tests/production-data-integrity.test.js`（npm test に登録） |
| 変更 | `public/osaka_3d_buildings.ward-ux-v1.html` のみ |

production へはまだ反映していません。次の Mission で production cutover のみを行う想定です。

`READY_FOR_PRODUCTION_CUTOVER`
