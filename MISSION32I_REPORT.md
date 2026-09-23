# Mission 32I 完了報告 — ROAD V3: TRUE CARRIAGEWAY REFINEMENT

> **historical-invalidated-by-v2**（Mission 32P で追記）: このレポートの数値は V1 建物（平面直角座標 第7系由来・地図に対し 0.93° 回転）を前提にしている。Building∩DarkRoad（FIX13 479,511 / V2 176,180 / V3 74,798 m²）を V1 建物で測った。ROAD V3 の geometry 自体は有効。現在の値は `data/reports/v2-final-road-overlap.json` / `v2-final-water-overlap.json` / `v2-placement-policy.json` を参照。ファイルは記録として残す。


**最終判定: `ROAD_VISUAL_V3_SUCCESS`**

建物は完全 READ ONLY。Canonical Building / Canonical Road / projection / origin は一切変更していない。
**§30 に従い V3 を default へ昇格していない**（既定は `FIX13` のまま）。

---

## §1 の前提を実測で訂正した（設計の出発点）

§1 は「tran envelope が carriageway + sidewalk + road reserve を含むので道路面が広すぎる」としていたが、
**ROAD V2 の dark area は tran polygon ではなく GSI corridor quad**（tran へ clip 済み）だった。
梅田〜中之島で GSI ペア幅と OSM 由来の車道幅を突き合わせた実測:

| | median | p90 | p95 |
|---|---|---|---|
| GSI corridor 幅 (V2 が dark にしていた幅) | **19.89 m** | 36.07 m | 40.64 m |
| OSM 由来の車道幅 | **5.00 m** | 9.75 m | 13.00 m |
| 差 | **13.85 m** | 30.20 m | 34.74 m |

⇒ **残存する過大 dark の主因は tran ではなく「GSI corridor 幅 ≠ 車道幅」**。
GSI 道路縁（真幅道路）は道路区域の境界線なので、ペアリングすると歩道・路肩・（分離道路では両方向＋中央帯）を
含む全幅になる。V3 はこの corridor の**内側から車道帯だけを切り出す**方式にした。

---

## §2 Source hierarchy（実装）

| 優先 | source | V3 での役割 |
|---|---|---|
| 1 | GSI Road Edge paired corridor | corridor の**位置と向き**。V3 carriageway は必ずこの内側に収まる（外へは一切広げない） |
| 2 | OSM `width` / `lanes` | corridor 内の**どこが車道で何 m か** |
| 3 | OSM highway class 推定幅 | width も lanes も無い場合のみ。confidence を下げる |
| 4 | PLATEAU tran | **§8: MAXIMUM ROAD DOMAIN（safety envelope）としてのみ**。最終 clip 先 |

OSM が corridor 内に1本も無い区間（交差点内部など）は corridor 幅のまま残す＝§7「既存 GSI intersection
support を優先」＋ §24 continuity の保護。

### §3 GSI confidence
FIX18 / ROAD V2 と**同一基準を維持**: HIGH 101,326 / MEDIUM 41,974 / LOW 2,782。
dark carriageway へ使うのは HIGH/MEDIUM かつ `!widthSpike` のみ（accepted pairs 143,300）。

### §4 OSM 属性（実在するものだけ使用・実測）
`highway` 74,346 / `lanes` 9,314 / `oneway` 14,024 / `bridge` 2,345 / `layer` 2,684 / `tunnel` 349 /
`width` 115（うち採用可能 102）/ **`junction` 0 件＝この dataset に存在しないので使っていない**。

### §5 推定幅テーブルの provenance（全て report に出力）
- `LANE_WIDTH_M = 3.0` — **実測由来**。width と lanes を両方持つ way 35 件のうち複数車線のものは
  width/lanes が 3.0 に集中（`secondary lanes=2 → width 6.0` が最頻）。
- `CLASS_MIN_WIDTH_M` — **n≥10 の class は width タグ実測の中央値**
  （residential 38件→4.0 / unclassified 27件→3.0 / pedestrian 15件→4.0 / service 12件→2.5）。
  n<10 の class は標本不足のため lanes 中央値 × LANE_WIDTH_M（導出値であることを明記）。
- 外れ値除去: `width` の上限 30 m（primary に "40 m" の誤タグが4件あり除外）。
- confidence: `osmWidth`=high / `osmLanes`=medium / `osmClassInference`=low / `gsiCorridorOnly`=gsi。

### source 使用実績
`osmWidth` 479 / `osmLanes` 88,219 / `osmClassInference` 334,981 / `gsi`(corridor のまま) 88,800 /
**`tranEnvelopeOnly` = 0**（tran を dark carriageway の source にした帯は1つも無い＝§8 遵守）。

---

## §6 自己交差・鋭角・交差点爆発の回避（構造的に）

centerline を外側へ offset して corridor を作り直す方式は**採らなかった**（それが自己交差と交差点爆発を生む）。
V3 は**既存 quad の内側で横断方向に線形補間して帯を切り出すだけ**なので、生成される帯は常に元 quad の
凸結合の内側にあり、自己交差も鋭角も原理的に発生しない。実測でも `nanCount = 0` / `degenerateCount = 0`。

**途中で見つけて直したバグ**: 横断位置を quad の**始端**の軸で測っていたため、斜行・湾曲する quad で
帯が数 m 横へずれていた。診断の結果「V2 にあって V3 に無い centerline の **83%** がこのずれ由来」と判明し、
**quad 中央**の横断軸で測るよう修正した（centerline 被覆 17.24% → 24.59% へ回復）。

---

## §15 最重要 KPI: Building ∩ DarkRoad

| | 面積 (6 fixture 合算) | 前段比 |
|---|---|---|
| FIX13 | 479,511 m² | — |
| ROAD V2 | 176,180 m² | −63.3% |
| **ROAD V3** | **74,798 m²** | **−57.5%（対 V2）／ −84.4%（対 FIX13）** |

dark 面積そのものも 438,050 m²（V2）→ 194,976 m²（V3）。

### サイト別（§19/§20/§21）

| site | FIX13 | V2 | **V3** | V2→V3 | centerline 被覆 V2→V3 |
|---|---|---|---|---|---|
| 梅田 | 98,602 | 22,943 | **11,029** | **−51.9%** | 18.92% → 19.04% |
| 中之島 | 69,494 | 23,902 | **9,609** | −59.8% | 23.47% → 21.84% |
| 本町 | 90,710 | 51,369 | **18,951** | −63.1% | 34.58% → 31.68% |
| 難波 | 102,725 | 41,137 | **17,110** | −58.4% | 26.34% → 26.64% |
| 天王寺 | 64,141 | 20,208 | **8,927** | −55.8% | 24.15% → 23.44% |
| **住吉(対照)** | 53,839 | 16,621 | **9,172** | **−44.8%** | 20.97% → **23.66%** |

**6 サイトすべてで改善し、1つも改悪していない**（§20 住吉・§21 中之島/本町/難波/天王寺）。

### §19 梅田重点 15 地点
駅（大阪駅・大阪梅田駅）/ 線路沿い 4 / 駅前交差点含む交差点 3 / 高架道路 2 / 大型施設 3 / 駅前広場 1。
合算 13,534 → **8,036 m²（−40.6%）**。内訳は **改善 10 / 悪化 4 / 同値 1**。

悪化した4地点（正直な開示）: 線路沿い(南) 0→600 / 交差点(西) 394→626 / 高架道路(阪神高速) 39→54 /
大阪駅前広場(南) 12→15 m²。
原因は V3 で resolved 判定を「envelope の被覆率」から「clip 後の帯面積 ≥5 m²」へ変えたこと。
幅 3 m の帯では比率基準だと広い tran（駅前広場状）にある正しい車道まで UNCERTAIN に落ちてしまうため
変更したもので、結果として V2 が何も塗らなかった場所に細い車道が出る。
なお 32H の結論に照らすと、これらは「実在する建物の下を実際に道路が通っている」場所である可能性が高いが、
**本ミッションではそれを検証していないため断定しない**。

---

## §16/§24 「細くしすぎ」の防止（同時評価）

overlap だけを追うと道路を消せば勝ててしまうので、**OSM 車道 centerline を 2 m 間隔でサンプルし、
dark に覆われている割合**を同時に測った（track 単位の指標は V2/V3 で同じ corridor 集合を使うため差が出ず、
V3 の評価に使えないことを実測で確認した上での代替）。

| | V2 | **V3** |
|---|---|---|
| centerline 被覆率 | 24.95% | **24.59%（V2 の 98.6%）** |
| gap 数 | 2,860 | 3,382 |
| gap 総延長 | 141,814 m | 142,500 m |

**dark 面積を 55% 減らしながら、道路の連続性は 98.6% 維持**している。これが「KPI のために細くした」のでは
ないことの証拠。合格基準は「V2 の 85% 未満なら FAIL」に設定した。

## §17 Width validation（class 別）

| class | count | median | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|
| **CARRIAGEWAY** | 516,488 | **3.00** | 6.00 | 9.00 | 16.13 | **45.0** |
| PEDESTRIAN | 7,383 | 4.00 | 4.00 | 4.00 | 4.00 | 15.0 |
| MEDIAN | 123,176 | 7.14 | 18.09 | 26.55 | 31.23 | 150.1 |
| SHOULDER_MARGIN | 520,019 | 3.87 | 7.39 | 13.77 | 20.00 | 128.0 |
| BRIDGE | 64,599 | 6.00 | 6.00 | 8.12 | 9.00 | 24.0 |
| TUNNEL | 1,867 | 3.00 | 6.00 | 6.00 | 6.00 | 12.0 |
| （参考）V2 carriageway | 156,056 | **18.08** | — | 33.63 | 38.16 | 45.0 |

- carriageway の中央値 18.08 m → **3.00 m**。大阪の `unclassified`/`residential`/`service` の実幅がこの水準。
- **max 152.4 m の「車道」があったのを発見して除去した**: GSI pairing の上限（45 m）を超える局所 corridor は
  再構成アーティファクトなので、OSM の裏付けが無い限り dark にしない（1,136 quad を除外）。
- MEDIAN / SHOULDER_MARGIN の max が 100 m 超なのは同じ過大 corridor の残余だが、**これらは dark に入らない**。
- **SIDEWALK が 0 なのは正直な限界**: corridor 内で車道帯の外側に残る部分は歩道と路肩の両方を含み、
  両者を分ける source がこの環境に無いため区別せず SHOULDER_MARGIN にしている。独立した SIDEWALK class
  自体は既存 FIX13 の tran 分類（1,366,104 m²）として引き続き存在し、V3 は触っていない。

## §18 GSI / OSM consistency（全市 277,216 quad）

| | median | p90 | p95 |
|---|---|---|---|
| GSI corridor 幅 | 18.58 m | 37.55 m | 42.20 m |
| OSM 由来の車道幅 | 3.00 m | 9.75 m | 13.00 m |
| **差** | **15.58 m** | — | — |

この差が V3 が縮めた量そのもの。

## §22 Railway interaction

rail corridor（中心線 ±5 m 近似）のうち road として塗られた割合: **V2 0.1397 → V3 0.0893**（−36%）。
踏切・立体交差・並走道路により一定の重なりは正常に生じるため、重要なのは V3 が V2 より rail を
road として塗っていないことで、それは満たしている。

## §23 Bridge / deck

OSM で `bridge=yes` または `layer>0` の way に対応する帯は **BRIDGE** として分類し、**地上の dark
carriageway に含めない**（3,241,708 m²）。`tunnel=yes` / `layer<0` は **TUNNEL** として同様に除外（57,046 m²）。
3D 道路化は行っていない。

## §25 Area accounting

| | m² |
|---|---|
| tran envelope 総面積 | 52,687,133 |
| うち primary envelope | 38,475,359 |
| **V3 carriageway** | **7,380,338** |
| V3 margin | 14,134,825 |
| V3 uncertain | 16,960,196 |
| **reconciliation diff** | **0** |

V2 carriageway 13,556,252 m² → V3 7,380,338 m²（**−45.6%**）。
corridor 分解（clip 前の生の帯面積）: carriageway 23,007,349 / MEDIAN 17,107,671 /
SHOULDER_MARGIN 27,316,332 / BRIDGE 3,241,708 / PEDESTRIAN 213,430 / TUNNEL 57,046。

## §26 Performance

| | V2 | V3 |
|---|---|---|
| tile 数 | 92 | 92 |
| tile bytes | 237,738,864 | 263,238,033（**+10.7%**） |
| 描画ポリゴン数 | — | 516,488 |
| build 時間 | — | 46.7 s |

draw call / runtime memory はブラウザ実行が必要なため本環境では測れない。マテリアル構成は V2 と同一
バケット数なので draw call はポリゴン数ではなくバケット数で決まる。

---

## §13/§14 dev UI

Road Mode を **`[A:FIX13] [B:ROAD V2] [C:ROAD V3] [D:+LAND BLOCK] [DIFF] [DIFF V2→V3]`** に拡張。

- **§30: default は昇格していない**（`let roadVisualMode = 'FIX13';` のまま）。
- **§11 dark paint rule**: 濃い道路色（`COL.road`）を使うのは **CARRIAGEWAY のみ**。
  margin / uncertain は淡色のまま。validator で機械的に検証している。
- **§14 DIFF V2→V3**: V2 only = **red** / V3 only = **blue** / common = **neutral**。
  V3 band は V2 と同じ GSI quad の内側にあるため、feature が V2 でも RESOLVED だったか（tile の `inV2`）で
  common / V3-only を判定している。**厳密なポリゴン差分ではなく feature 単位の近似**（runtime で boolean
  演算をしないため）であることを report に明記した。
  実績: V2 resolved 50,689 / V3 resolved 66,182（うち V2 と共通 47,500・V3 で新規 18,682）。
- `__ROAD_V3_DEBUG__()` を公開。

### §12 について（重要な不整合の報告）

§12 は「RAW GSI edge は通常表示では**引き続き** hidden」としていたが、**実際にはこの HTML では
Mission 22 以降 `gsiEdgeEnabled` の既定は ON** であり、前提が現状と異なっていた。
他ミッションが意図して設定した既定を黙って書き換えるのは避け、**32F が確立した「派生道路表示中だけ
隠して、抜けたら元に戻す」方式を ROAD V3 / DIFF V2→V3 へ拡張**した。既定値そのものは変更していない。

---

## §28 Validator / テスト

`tools/validate/road-visual-v3.js` → **RESULT = PASS**

| check | 値 |
|---|---|
| buildingMutation / canonicalRoadMutation / projectionMutation | **0 / 0 / 0** |
| refinedMutation | 0 |
| **tranUsedAsDarkCarriagewaySource** | **false** |
| **tranUsedAsSafetyEnvelope** | **true** |
| **buildingUsedForRoadGeneration** | **false** |
| roadV3Exists / widthSanityMeasured / continuityMeasured | true / true / true |
| defaultNotPromoted / hasV3Mode / darkOnlyForCarriageway / notOverThinned | すべて true |
| productionModified / protectedModified | false / false |
| Canonical Buildings / Roads | **615,617 / 199,658** |

- `tests/road-visual-v3.test.js`（18件）全 pass
- `npm test` = **1,636 tests / 1,621 pass / 0 fail / 15 skip**
- 既存2テスト（32E/32F）が Road Mode のボタン配列リテラルを直接検証していたため、**守っている性質
  （既定 FIX13・LAND_BLOCK 統合）は保ったまま**新しい配列へ更新した。ガードは弱めていない。

### 成果物

| 種別 | パス |
|---|---|
| ビルダー | `tools/build-road-visual-v3.js` |
| データ | `data/processed/osaka-city/derived/road-visual-v3/`（92 tile） |
| 配信 | `public/map-data/osaka-city/derived/road-visual-v3/`（92 tile） |
| レポート | `data/reports/road-visual-v3.json` |
| Validator | `tools/validate/road-visual-v3.js` |
| テスト | `tests/road-visual-v3.test.js` |

---

## §29 成功条件の判定

| 条件 | 結果 |
|---|---|
| Building∩DarkRoad が V2 よりさらに改善 | ✅ −57.5% |
| road continuity を維持 | ✅ centerline 被覆 V2 の 98.6% |
| road widths が現実的 | ✅ median 3.0 m / p95 16.1 m / max 45 m |
| 梅田で明確な visual improvement | ✅ −51.9%（15 地点合算 −40.6%） |
| 住吉を改悪しない | ✅ −44.8% |
| 建物は完全不変 | ✅ 615,617 / mutation 0 |

---

## 限界（正直な開示）

1. **`width` タグは 115 件（0.15%）しか無い。** 実際の幅の大半は `lanes`（12.5%）か class 推定（65%）由来で、
   個々の道路の実幅ではない。confidence を high/medium/low で区別して記録している。
2. **`junction` タグはこの dataset に存在しない**ため、§7 の「OSM junction topology で補完」は
   タグベースでは実施していない。交差点は GSI corridor をそのまま使う（既存 intersection support 優先）方式。
3. **歩道と路肩を分離できない**（§17 参照）。
4. **DIFF V2→V3 の common/V3-only 判定は feature 単位の近似**で、厳密なポリゴン差分ではない。
5. **draw call / runtime memory は測れていない**（ブラウザ実行が必要）。
6. **実機 visual QA は未実施。** §30 に従い V3 を default へ昇格していないので、`[C:ROAD V3]` と
   `[DIFF V2→V3]` で目視確認をお願いしたい。
7. 梅田 15 地点のうち 4 地点で局所的に overlap が増えた（上記 §19 参照）。

---

**§30 STOP。`ROAD_VISUAL_V3_SUCCESS` で停止する。ユーザー visual QA 前に V3 を default へ昇格しない。**
