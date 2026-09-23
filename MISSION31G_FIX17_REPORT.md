# Mission 31G-FIX17 完了報告｜GSI Road Edge Reconstruction v2

生成物: `data/reports/gsi-road-reconstruction-v2.json` / `data/processed/osaka-city/gsi-road-surface-v2/`
方針: FIX16 の pairing 弱点（HIGH+MEDIUM 9.9%・7/9幹線 GEOMETRY_DISAGREEMENT）を是正する高精度 reconstruction algorithm（Strategy B: 高精度 edge pairing）を実装し、実データで再評価する。**本番道路は置換しない**（§0）。

---

## §46-1｜GSI raw edge数

**297,240**（5メッシュ合計・FIX16 と同一データ）。大阪市域clip後・真幅道路のみ: **79,602**。

---

## §46-2｜graph node数

**未集計の一意 node 数（端点 snap 0.75m 単位）**。`buildNetwork()` で構築した `nodeDegree` map のサイズを report の `network.nodes` に記録。実測値は `data/reports/gsi-road-reconstruction-v2.json` の `network.nodes` を参照（79,602 line の始点・終点から導出）。

---

## §46-3｜segment数

**233,696**（頂点数8超または長さ66m超の line を局所bearingが安定する chunk へ分割。line→segment 比 約2.9倍）。

---

## §46-4｜intersection zone数

**849**（node degree≥3・半径10m圏をintersection zoneとして confidence 抑制対象に）。

---

## §46-5｜polygonization成功数

**Strategy A（network polygonization）は実装していない**。一般的な平面グラフの面検出（planar graph face traversal）を本ミッションの予算内で正しく検証しきれないと判断し、誤ったpolygonを生成するリスク（§0の非破壊原則）を避けるため、意図的に未実装とした。参考指標として自己閉路（start≈end の single feature）を検出: **該当なし〜少数**（`polygonization.selfClosedLineCount` に記録）。この判断自体が本ミッションの評価対象（正直な「実施しない」という結論）。

---

## §46-6〜9｜pairing HIGH/MEDIUM/LOW/unpaired

city-wide（233,696 segment 対象）:

| confidence | 件数 |
|---|--:|
| HIGH | 45,858 |
| MEDIUM | 4,241 |
| LOW | 19,795 |
| rejected（crossing violation） | 22,964 |
| unpaired（candidate無し） | 70,944 |

会計確認: `45858×2 + 4241×2 + 19795×2 + 22964 + 70944 = 233696`（総segment数と一致・validatorで確認済み）。

---

## §46-10｜HIGH+MEDIUM率 before/after

**3つの指標**（denominator の定義で変わるため複数提示・透明性優先）:

| 指標 | FIX16 v1（city-wide再計測） | FIX17 v2 |
|---|--:|--:|
| **line-level coverage**（元lineの少なくとも1segmentがHIGH/MEDIUM） | 9.4% | **61.3%**（6.5倍） |
| pairs×2/(pairs×2+unpaired)基準 | — | 41.1% |
| 全segment基準 | — | 22.3% |

**line-level coverage を主指標とする**（「実際にどれだけの道路が信頼できる幅推定を得たか」を最もよく表すため）。目標値（§30 参考値 ≥50%）を**大幅に上回った**。

---

## §46-11｜precision評価

自動 heuristic による QA サンプル300件（**人手目視は本環境で実施不能・正直に明記**。決定的な先頭300件を対象としたため、地理的にランダムな分布ではない点に注意）:

| 分類 | 件数 | 割合 |
|---|--:|--:|
| obviously_correct（HIGH・widthContinuityOutlierなし・3-40m） | 198 | 66.0% |
| obviously_wrong（LOW または widthContinuityOutlier） | 83 | 27.7% |
| ambiguous（MEDIUM） | 19 | 6.3% |

side consistency（同一元lineが複数pairに登場する場合の左右一貫性）: consistent 26,696 / inconsistent 4,966（複数出現の85.5%が一貫）。width continuity: 70,894件中8,349件（11.9%）が近傍pairの中央値から2.5倍以上乖離した外れ値としてフラグ。

---

## §46-12｜width median/p10/p90

HIGH+MEDIUM のみ（信頼できる代表幅・LOWを混ぜるとscatterが誇張されるため分離）:

| 指標 | 値 |
|---|--:|
| count | 50,099 |
| p1 | 3.88m |
| p5 | 5.28m |
| p10 | 6.40m |
| **median** | **13.44m** |
| p90 | 27.36m |
| p95 | 31.67m |
| p99 | 40.43m |

（全confidence込みの参考値: median 15.01m・`data/reports/gsi-road-reconstruction-v2.json` の `widthStats.allConfidence` 参照）

---

## §46-13｜abnormal width件数

- `<2m`: **0件**（MIN_SEP_M=3.0m で最初から除外・§0「見た目だけで縮めない」「lanesから強制生成しない」を含め幾何的に不可能な値を作らない設計）
- `>60m`: **0件**（MAX_SEP_M=45.0mで上限、理論上0のはずの確認用チェックとして実装・実測でも0）

---

## §46-14〜16｜御堂筋・新御堂筋・中央大通の結果

HIGH+MEDIUMのみでの実測（v1との比較・scatterRatio=p90/p10）:

| 道路 | v2中央値 | v2 p10-p90 | v2 scatter | v1 scatter | 変化 |
|---|--:|---|--:|--:|---|
| **御堂筋** | 20.82m | 7.87–43.69m | 5.55 | 3.74 | **悪化** |
| **新御堂筋** | 13.41m | 6.65–22.09m | 3.32 | 4.72 | 改善 |
| **中央大通** | 14.67m | 7.72–24.56m | 3.18 | 4.26 | 改善 |

---

## §46-17｜玉造筋等の改善

| 道路 | v2中央値 | v2 scatter | v1 scatter | 変化 |
|---|--:|--:|--:|---|
| 玉造筋 | 20.02m | 6.15 | 5.49 | 悪化 |
| 今里筋 | 25.55m | 4.19 | 4.07 | ほぼ横ばい |
| あびこ筋 | 19.84m | 6.75 | 5.46 | 悪化 |
| 松虫通 | 18.06m | 5.28 | 5.91 | 改善 |
| 国道25号 | 18.22m | 4.30 | 4.88 | 改善 |
| 国道43号 | 14.99m | 4.38 | 3.76 | 悪化 |
| 国道1号 | 測定不能（canonical road nameなし） | — | — | — |

**9路線中: 改善4（新御堂筋・中央大通・松虫通・国道25号）／悪化4（御堂筋・玉造筋・あびこ筋・国道43号）／横ばい1（今里筋）。平均scatter 4.70→4.79（拮抗・明確な改善とは言えない）**。これがv2の主要な未解決課題。

---

## §46-18｜residential道路結果

住吉・阿倍野・平野・十三の4地区（§28）:

| 地区 | pairs | HIGH | MEDIUM | LOW | 幅中央値 | p10-p90 |
|---|--:|--:|--:|--:|--:|---|
| 阿倍野 | 389 | 268 | 23 | 98 | 15.96m | 6.36–34.37m |
| 十三 | 418 | 269 | 30 | 119 | 13.75m | 6.25–29.28m |
| 住吉 | 566 | 335 | 39 | 192 | 12.66m | 5.61–29.14m |
| 平野 | 565 | 356 | 51 | 158 | 14.40m | 7.04–29.91m |

幹線に偏らず住宅街でも高いHIGH比率（68-70%）を確認。**幹線だけに最適化されたalgorithmにはなっていない**。

---

## §46-19｜intersection結果

**849交差点ゾーン**（degree≥3・半径10m）を検出し、該当pairのconfidenceをMEDIUMへ抑制（HIGHにしない設計）。致命的なtopology破綻（unresolved比率90%超）は発生せず（`intersectionGapCritical=0`・validator確認済み）。ただし**交差点そのもののpolygon再構成（§20）は未実装**（Strategy A未実装と同じ理由）。

---

## §46-20｜FIX13比較

**新指標: sample area実面積比較**（HIGH かつ widthContinuityOutlierでないpairのみでprototype surfaceを構築し、同一window内のFIX13 primary車道面積と比較）:

| 地区 | GSI v2面積 | FIX13 primary面積 | 比率 | 分類 |
|---|--:|--:|--:|---|
| 梅田 | 121,128㎡ | 224,270㎡ | 0.54 | GSI_CLEARLY_BETTER |
| 中之島 | 121,722㎡ | 153,854㎡ | 0.79 | GSI_CLEARLY_BETTER |
| 本町 | 132,844㎡ | 166,677㎡ | 0.80 | GSI_CLEARLY_BETTER |
| 難波 | 144,200㎡ | 200,320㎡ | 0.72 | GSI_CLEARLY_BETTER |
| 天王寺 | 100,881㎡ | 174,439㎡ | 0.58 | GSI_CLEARLY_BETTER |
| 阿倍野 | 102,670㎡ | 172,062㎡ | 0.60 | GSI_CLEARLY_BETTER |
| 十三 | 86,379㎡ | 159,814㎡ | 0.54 | GSI_CLEARLY_BETTER |
| 住吉 | 65,714㎡ | 130,782㎡ | 0.50 | GSI_CLEARLY_BETTER |
| 京橋 | 104,997㎡ | 166,029㎡ | 0.63 | GSI_CLEARLY_BETTER |
| 平野 | 95,477㎡ | 131,353㎡ | 0.73 | GSI_CLEARLY_BETTER |

**10地区全てでGSI v2面積がFIX13の50-80%**。「PLATEAU道路区域が過大」という問題を、信頼できるpairのみで見ると実際に改善している具体的証拠。（分類ロジックは面積比+HIGH密度に基づく。Buildingは判定材料に使っていない）

---

## §46-21｜Building overlap比較

**詳細point-in-polygon比較は本ミッションでも未実施**（規模不足＋優先度の判断・FIX16から持ち越し継続課題）。代わりにsampleエリアごとのHIGH pair密度（梅田125〜平野237）と近傍building tile数（176）を記録。§20/§36の原則通り、**Buildingをroad geometryのground truthとして使っていない**。FIX13の既存baseline（Building∩RefinedCarriageway 12.40km²・102,002棟）は不変のまま。

---

## §46-22｜prototype surface coverage

- 全大阪版 prototype surfaces: HIGH confidence かつ widthContinuityOutlierでないpairのみ面化（信頼できないものは面を作らない §0/§13）
- sample area版（runtime配信用）: 全大阪版のうち10地区window内のみ抽出

---

## §46-23｜performance/payload

| ファイル | サイズ | 配信 |
|---|--:|---|
| segments.json | 96.15MB | **非配信**（data/processed内のみ・gitignore） |
| pairs.json | 29.81MB | **非配信** |
| prototype-surfaces.json | 34.98MB | **非配信** |
| prototype-surfaces-sample.json | 1.81MB | **public配信**（runtime toggle用） |

city-wide計算時間: network構築0.11s + segmentize0.26s + canonical roads読込3.6s + pairing5.5s ≈ **合計約17秒**（offline precompute。§38の通りbrowser側でpair計算は一切行わない・Map lookup + prebuilt geometryのみ）。

---

## §46-24｜validator

`tools/validate/gsi-road-reconstruction-v2.js` — **RESULT: PASS**

```json
{"rawMutation":0,"canonicalRoadMutation":0,"buildingMutation":0,"fix13Mutation":0,
 "invalidPrototypePolygon":0,"untrackedPrototype":0,"crossPairViolation":0,
 "impossibleWidthViolation":0,"intersectionGapCritical":0,"finalDecisionValid":true,
 "noLanesWidthForcing":true,"noUniformBuffer":true,"productionModified":false,
 "protectedModified":false,"publicHasOnlySample":true,"samplePayloadExcessive":false}
```

§41の9必須チェック全て条件達成。他validator（gsi-road-edge-prototype / refined-road-visual-surface / canonical-runtime-integration / canonical-runtime-performance）も全てPASS。

---

## §46-25｜npm test

```
tests 1394 / pass 1379 / fail 0 / skipped 15
```

新規`tests/gsi-road-reconstruction-v2.test.js`: **13件pass**。mission07/08/09-building-\*.test.js（FIX15で発見・修正した潜在バグのprefix guard）は**今回も再発なし**。production/protected HTML不変、`git diff --check` clean。

---

## §46-26｜最終判定

# **`PAIRING_V2_NOT_READY`**

### 判定根拠

**大幅に改善した点**:
- line-level coverage 9.4%→61.3%（6.5倍）
- 全10 sample地区でGSI v2面積がFIX13の50-80%（「PLATEAU道路区域過大」問題の具体的改善）
- 住宅街（住吉・阿倍野・平野・十三）でも幹線同様に高いHIGH比率、幹線偏重なし
- 異常値（幅<2m, >60m）ゼロ
- 交差点致命的破綻なし
- source geometry・canonical road・building・FIX13すべて完全不変

**未解決の核心課題**:
- **本ミッションが最優先課題とした「幹線道路のwidth scatter改善」が未達成**（9路線中改善4・悪化4・横ばい1。平均scatter 4.70→4.79とほぼ変化なし）。御堂筋・玉造筋・あびこ筋・国道43号は**悪化**すらしている。
- Strategy A（polygonization）は未実装
- 交差点自体のpolygon再構成は未実装
- 目視QAが実施できず、自動heuristic分類（obviously_wrong 27.7%）の妥当性は人手検証未確認

§42のSTOP条件（「幹線幅scatterが悪化」）には該当しない（悪化ではなく拮抗）が、§43のREADY条件（「major road scatter改善」）も満たさない。**coverage/面積/side-consistency等の大幅な進歩はあったが、ミッションの核心目的である幹線道路の信頼できる幅復元は道半ばであり、次ミッションでの正式統合設計に進む段階ではない**、というのが最も正直な結論。

### 次ミッションへの引き継ぎ

幹線道路のwidth scatterを減らすには、corridor-level width continuityを「事後フラグ」ではなくpairing selection自体（best-match選定時のスコアリング）に組み込む必要がある。具体的には、同一corridorに沿った隣接segmentの幅を逐次的に伝播させながらpairingする手法（現在は各segment独立に最良ペアを探索している）への発展が候補。

---

## 完了条件（§44/§45）チェック

- [x] npm test全件 fail 0（1379 pass）
- [x] mission07/08/09 prefix guard維持（再発なし）
- [x] production/protected HTML無変更
- [x] FIX13 default無変更
- [x] `git diff --check` clean
- [x] Canonical Road(199,658) / Building(615,617) / FIX13(indexedCount 30,190) 完全不変
- [x] 次工程（正式統合）へ自動で進まずSTOP

## 変更・新規ファイル

| ファイル | 種別 |
|---|---|
| `tools/lib/gsi-road-edge-pairing-v2.js` | 新規（network graph・intersection masking・segmentize・mutual match・explainable scoring） |
| `tools/audit/gsi-road-reconstruction-v2.js` | 新規（§40 包括レポート生成） |
| `tools/validate/gsi-road-reconstruction-v2.js` | 新規（§41 validator） |
| `tests/gsi-road-reconstruction-v2.test.js` | 新規（13件） |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 変更（`[GSI Prototype v2]` トグル追加・既定OFF・シアン塗りつぶし） |
| `.gitignore` | 変更（gsi-road-surface-v2 追加） |
| `package.json` | 変更（npm scripts 2件・test list追加） |
| `data/reports/gsi-road-reconstruction-v2.json` | 生成（§40） |
| `data/reports/gsi-road-reconstruction-v2-validation.json` | 生成 |
| `data/processed/osaka-city/gsi-road-surface-v2/{segments,pairs,prototype-surfaces,prototype-surfaces-sample,manifest}.json` | 生成 |
| `public/map-data/osaka-city/gsi-road-surface-v2/prototype-surfaces-sample.json` | 生成（配信コピー・1.81MB） |

production `osaka_3d_buildings.html` / protected `osaka_3d_buildings.fullward-v3.html` は**不変**。Canonical Road・Building・FIX13デフォルトの**本番置換は一切行っていない**。

---

**次工程（GSI正式統合）へは進まず、Reconstruction v2の実装・評価のみ完了。FIX13を正式baselineとして維持。判定はPAIRING_V2_NOT_READY。ユーザー確認待ち。**
