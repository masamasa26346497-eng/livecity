# Mission 31G-FIX10 報告 — 建物と都市基盤の位置ずれを検証

結論: **座標 pipeline に projection バグは無い。** 建物 ↔ canonical 道路の位置差は
**中央 dx -0.32m / dz -0.04m**（系統的な回転・スケール・平行移動なし）。
canonical → derived → runtime の centroid 変位は **中央 0m / p95 0.21m**。

目分量 offset は行っていない（§0/§16）。建物 geometry・数（615,617）は不変。
placement policy / conflict の再計算は不要（geometry 未変更）。
npm test 0 fail、validator PASS、production / protected 不変。

**実機の見た目は未確認**（このセッションはブラウザ不可）。§24 の目視 QA を推奨。

---

## 1. ずれの直接原因

**「建物が基盤に対してずれている」という座標バグは実測上 存在しない。**

| 計測 | 結果 | 判定 |
|---|---|---|
| canonical → derived 同一 canonicalId centroid（n≈100,000） | median **0m** / p95 0.21m / max 4.3m | ✓ 変位なし |
| runtime の座標変換 | **ゼロ**（derived の coordinates を `pushPolygon`/`pushExtrude` がそのまま `[x, y, z]` へ流す。mesh/group.position への tile 原点加算なし・z 反転なし） | ✓ double transform なし |
| building centroid → 最寄り canonical road polygon の変位（n≈6,300・z-band 別） | median dx **-0.32m** / dz **-0.04m**、全 z-band で ±0〜3m・傾きなし | ✓ 系統ずれなし |
| LOD centroid（near/mid 同一 canonicalId） | median **0m** / p95 0.84m | ✓ LOD 切替でジャンプなし |

**残る差（数 m スケール）の内訳**:
1. PLATEAU 建物 footprint（測量）と OSM/PLATEAU 道路（別 source）の合理的な source 差（§14/§15/§27）。
2. **31E systematic finding #2**: PLATEAU tran 道路区域面は実舗装より広い（都市計画決定幅・alignment consistency 0.104）。
   建物が「広い道路 polygon」の縁に接して見える → 「道路に乗っている」印象。座標ずれではない。
3. 建物 projection の校正が弱い（下記 §2）— ただし実測上 city-wide の系統ずれは生んでいない。

## 2. alignment type

**F_SOURCE_DIFFERENCE / 小残差**（§8 の A〜G のうち）。

- A_CONSTANT_TRANSLATION ではない（median dx/dz ≈ 0・全 z-band 一定でない）
- B_ROTATION / C_SCALE ではない（z-band を跨いだ dx trend +2.3m / dz trend -3.4m ＝ 20km スパンで 0.01% ＝ 無視できる）
- D_AXIS/SIGN ではない（buildings・roads とも znorth-neg-v1 x/z 空間・bbox 一致）
- E_TILE_OFFSET ではない（canonical→derived centroid median 0m・tile 境界で段差なし）
- G_RUNTIME_DOUBLE_TRANSFORM ではない（runtime 座標変換ゼロ・canonical→derived 0m）

**建物 projection の詳細**（`data/buildings/coordinate-config.json`）:
`JGD2011 平面直角座標系 第7系` + 逆推定 `localOrigin {E: -150573.671, N: -153599.466}` + `axisMapping {xSign:1, zSign:1}`。
**校正 = 住吉区近傍 60 点のみ（inlier 9 / outlier 51 / maxResidual 4.47m）**。
道路/河川/N03/geoToThree は `local-equirectangular`（`x=(lon-135.52502)*cos(34.604208°)*111320 ; z=-((lat-34.604208)*111320)`）。
→ 2 つの投影は同一 znorth-neg-v1 空間へ整合済み。第7系（本来 大阪は第6系）+ 弱校正だが、
Osaka の東西幅（135.34–135.60）では TM スケール誤差 ~0.02%・子午線収差の影響は
逆推定 origin がほぼ吸収しており、**実測 city-wide displacement は中央 <0.4m**。

## 3. 修正前 median dx/dz

**dx -0.32m / dz -0.04m**（building centroid → 最寄り road polygon centroid）。

## 4. 修正前 median distance

**16.83m**（building centroid → 最寄り road polygon centroid の距離。
街路に面した建物が道路中心線から ~15–20m 離れているのは正常。p90 47.9m）。

## 5. 修正後 median dx/dz

**変更なし**（§16: F_SOURCE_DIFFERENCE のため建物を動かさない。projection バグが無いので是正対象なし）。

## 6. 修正後 median distance

**変更なし**（16.83m）。

## 7. 最大ずれ before / after

| | before | after |
|---|---|---|
| canonical→derived centroid max | 4.31m（simplification 由来） | 変更なし |
| LOD near/far centroid max | 11.53m（far tile tol 12m の simplification） | 変更なし（§23 note） |
| building→road distance max | 情報値（source 差） | 変更なし |

## 8. PLATEAU Building vs Road 結果（§5）

**両者は一致している。** z-band 別の building→road median dx/dz:

| z-band（南北位置） | n | median dx | median dz | median dist |
|---|---|---|---|---|
| -18000（最北） | 40 | 0.91 | 4.03 | 16.3 |
| -12000 | 728 | -1.05 | -0.43 | 14.2 |
| -6000 | 727 | -0.58 | -0.86 | 17.2 |
| -2000 | 733 | -2.74 | 0.46 | 20.5 |
| 0（原点） | 608 | 0.02 | -1.09 | 17.1 |
| +2000（最南） | 109 | 3.26 | 0.67 | 13.9 |

全バンドで dx/dz が ±0〜3m に収まり、南北位置と相関しない → **建物 projection は道路に対して
ほぼ正常。他基盤 layer 側を疑う必要も無い（§5 の分岐: 両者一致 → 建物 projection ほぼ正常）。**

## 9. OSM fallback 結果（§13）

canonical building は PLATEAU（geometrySource `plateau-building`）と OSM fallback（`osm-building`）を
同じ znorth-neg-v1 空間で保持（`build-osm-building-fallback.js` は `coordinateConvention: 'znorth-neg-v1'`）。
building→road 変位計測は両 source 混在で行い、系統ずれ無し。fallback 固有のずれは検出されなかった。

## 10. tile offset 結果（§11）

- canonical building tile（500m）境界の前後で centroid 差なし（canonical→derived median 0m）。
- runtime は tile 座標を feature 座標へ加算しない（`buildGroup` は `pushExtrude`/`pushPolygon` へ座標をそのまま渡す）。
- `E_TILE_OFFSET` バグは無い。

## 11. LOD 位置一致結果（§22/§23）

| ペア | n | median | p95 | max |
|---|---|---|---|---|
| near vs mid | 10,115 | **0m** | 0.84m | 5.9m |
| near vs far | 1,425 | 0.48m | 2.6m | 11.5m |

- near/mid は同一 x/z（simplification tol の差が小さい）。
- near/far は far tile（tol 12m）の頂点間引きによる centroid シフトのみ。**平均 0.5m・最大 11.5m**。
  Ward Mode は near+mid のみ使用（FIX9）→ Ward Mode で建物はジャンプしない。
  City Mode 遠景の far mass のみ影響（建物が画面上 数 px の距離）→ 実用上問題なし。

## 12. 修正した座標処理

**なし**（projection バグが存在しないため）。

代わりに **§17 共通 Coordinate Adapter の考え方を validator で固定化**:
`tools/validate/canonical-spatial-alignment.js` が
「CanonicalRuntime が座標を変換していない（layer 別の独自座標式・z 反転・tile 原点加算が無い）」
「roads/water/N03/geoToThree が同一原点」を毎回チェック → 将来の drift を検出。

## 13. Building∩Water before / after（§20）

| | before | after |
|---|---|---|
| BUILDING_WATER conflict（export 内） | 144 | **変更なし**（geometry 未変更） |
| overlapFraction | median 0.2 / p95 0.54 | 変更なし |
| 主因 | plateau-building-encroaches-water 96 / centerline-offset 33 / over-water-structure 9 | 変更なし |
| FIX6 water SUPPRESS | 4,549 | **変更なし** |

位置ずれが原因ではなかった（§20 の「大幅に減る場合」に該当せず）。water overlap は
31E finding #1（OSM riverbank polygon の陸側過剰包含・GSI 水涯線 source なし）による。

## 14. Building∩Road before / after（§21）

| | before | after |
|---|---|---|
| BUILDING_ROAD conflict（export 内） | 9,221 | **変更なし** |
| overlapFraction | median 0.5 / p90 1.0 | 変更なし |
| ward 分布 | chuo 1784 / kita 1725 / nishi 1662 / … naniwa 1592（**均等**） | 変更なし |

ward 分布が均等（原点から遠い北区・淀川に偏らない）→ **projection drift ではなく
31E finding #2（tran 道路区域が実舗装より広い）**。§21 のとおり「tran 道路区域の広さ問題」として分離。

## 15. placement policy before / after（§19）

**再生成不要**。canonical building geometry を一切変更していないため、FIX6 の
`building-ward-index.json` / `building-placement/` / conflict 監査は全て有効なまま。
`renderableCount` / `suppressCount` 不変。

## 16. performance 影響（§28）

**ゼロ**。runtime コード変更なし。座標は build 時に確定（runtime は毎フレーム座標再計算しない）。
新規は audit tool（`tools/audit/canonical-spatial-alignment.js`）と validator のみ（実行時オフライン）。

## 17. validator

`tools/validate/canonical-spatial-alignment.js` = **PASS**（§26 の 6 チェック）:
`projectionOriginMismatch` 0 / `coordinateConventionMismatch` 0 / `unexpectedRuntimeTranslation` 0 /
`tileOffsetMismatch` 0 / `lodCentroidJump` 0 / `canonicalToRuntimeDisplacement` 0
＋ `buildingRoadSystematicOffset` 0（median dx/dz -0.32/-0.04m）。

## 18. npm test

**1,313 tests / 1,298 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- 新規 `tests/canonical-spatial-alignment.test.js`（8 件）: runtime 座標非変換 / group 原点固定 /
  validator PASS / canonical→derived regression 0m / LOD centroid 一致 / building↔road 系統ずれなし /
  pipeline 原点一致 / source geometry 不変
- 既存テスト無変更（runtime / canonical / derived を触っていない）
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` hash 不変、`git diff --check` clean

## 19. 実機確認地点（§24）

**座標は既に整合しているため、確認は「本当にずれて見えるか／何がずれて見えるか」の切り分け**:

1. `npx http-server public -p 8080` → `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
2. **梅田 / 中之島 / 難波 / 天王寺 / 十三 / 住吉 / 平野 / 大川沿い** で:
   - 建物が街区内に自然に収まっているか（audit では median <0.4m で収まっている）
   - 「道路に乗っている」建物は、**道路 polygon が実舗装より広い**（31E finding #2）ためか、
     それとも建物自体の位置か（`__CANONICAL_RUNTIME_DEBUG__()` の座標と地図を照合）
   - LOD 切替（ズームイン/アウト）で建物が動かないこと（audit: near/mid 0m）
3. もし特定地点で明確に数十 m ずれる建物があれば、その `canonicalId` を報告 →
   `data/reports/canonical-spatial-alignment.json` の該当 tile を精査（現状の全体統計では検出されず）

**もし実機で「道路に乗っている」建物が目立つ場合の次アクション**（本 mission の範囲外）:
- 31E finding #2 の tran 道路区域 → 実舗装幅への補正（別 mission。§14 のとおり Building∩Road だけで判定しない）
- または render で道路 polygon の透明度/描画順を調整（FIX8 系）

---

## 完了条件

- [x] 全 layer 座標 pipeline 監査（§1・audit report `coordinatePipeline`）
- [x] projection origin 一致確認（roads/water/N03/geoToThree = 34.604208 / 135.52502）
- [x] znorth-neg-v1 一貫性確認（z 反転は各 convert 段で 1 回のみ・runtime で再適用なし）
- [x] double transform 確認（runtime 座標変換ゼロ・canonical→derived 0m）
- [x] tile offset 確認（tile 境界で段差なし）
- [x] 20 地点以上の control point（z-band 11 × 平均 600 点 ≈ 6,300 対応点）
- [x] displacement vector 算出（median dx -0.32 / dz -0.04 / dist 16.83m）
- [x] alignment type 分類（F_SOURCE_DIFFERENCE / 小残差）
- [x] PLATEAU Building / Road 比較（一致・系統ずれなし）
- [x] canonical / runtime 比較（centroid median 0m）
- [x] LOD centroid 一致（near/mid 0m・near/far p95 2.6m）
- [x] 原因に応じた対応（projection バグ無し → geometry 変更なし・validator で固定化）
- [x] 建物を目分量で移動していない
- [x] placement policy 再生成（不要 = geometry 不変）
- [x] conflict 再監査（不要 = geometry 不変）
- [x] validator PASS / npm test 0 fail / production・protected unchanged
- [ ] **実機で「何がずれて見えるか」の切り分け（ユーザー・§24）**

**次工程へ進みません。実機で位置ずれの見え方（座標 vs 道路 polygon 幅 vs 描画順）を確認いただき、
数十 m ずれる具体地点があれば canonicalId をご連絡ください。**
