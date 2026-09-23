# Mission 31G-FIX18 完了報告｜GSI Corridor-Level Road Reconstruction v3

生成物: `data/reports/gsi-road-reconstruction-v3.json` / `data/processed/osaka-city/gsi-road-surface-v3/`
方針: FIX17の核心課題（幹線道路width scatterが改善しなかった）を、segment単位の独立pairingから**corridor全体の連続最適化（Viterbi DP）**へ移行して解決する。**本番統合はまだ行わない**（§0）。

---

## §46-1｜corridor数

**132,344**（EDGE_TRACK数と同一。79,602の元lineが端点連続性+bearing連続性でtrackへ束ねられた結果）。

---

## §46-2｜edge-track数

**132,344**（§1と同一値。track構築は`buildEdgeTracks()`のunion-findで実施）。

---

## §46-3｜LOCAL候補pair数

**211,844**（switch penalty無しのgreedy baseline。各segmentが独立に最良候補を選んだ場合の総pair数）。

---

## §46-4｜corridor最適化後pair数

**146,082**（DP経路をdedup後。deduplicate前は206,737件・双方向track処理による重複を無向segIdペアで除去）。

内訳: HIGH 101,326 / MEDIUM 41,974 / LOW 2,782。

---

## §46-5｜coverage v2→v3

| 指標 | v2 | v3 | 変化 |
|---|--:|--:|---|
| line-level coverage（HIGH+MEDIUM） | 60.1% | **93.7%** | **1.56倍** |

§25の目安（coverage≥50%）を大幅に上回りつつ、後述の通りprecisionも改善（coverageのために精度を犠牲にしていない）。

---

## §46-6｜pair switch before/after

| | before（greedy baseline） | after（DP） | 削減率 |
|---|--:|--:|--:|
| pair switch | 50,406 | **18,388** | **63.5%減** |

同一track・同一candidate群での比較（v2相当のswitch penaltyなし選択 vs v3のDP選択）。

---

## §46-7｜side flip before/after

| | before | after | 削減率 |
|---|--:|--:|--:|
| side flip | 19,852 | **8,839** | **55.5%減** |

---

## §46-8｜width spike before/after

| | before | after | 削減率 |
|---|--:|--:|--:|
| width spike | 5,580 | **3,414** | **38.8%減** |

change point（持続的な真の幅変化）: **1,755件**（spikeとして除外されず、3 segment以上持続する変化として正当に残された）。

---

## §46-9｜scatter平均 v1/v2/v3

| | v1（FIX16） | v2（FIX17） | v3（FIX18） |
|---|--:|--:|--:|
| 幹線9路線平均scatter | 4.70 | 4.79 | **4.22** |

**v2比 11.9%改善・v1も上回る**（v2判定基準：v1比10%以上改善で「明確な改善」としていたのと同一基準をv2比に適用）。参考目標（≤3.5）には未到達（4.22）だが、これはミッション文中で明示的に「参考目標」とされており絶対値ゲートにはしていない。

---

## §46-10｜御堂筋 scatter v2/v3

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 3.74 | 5.55 | **4.00** |

v2比 **−1.55改善**（§22必須改善対象・達成）。v1と比べるとまだ+0.26やや高いが、v2の悪化を大幅に取り戻した。

---

## §46-11｜新御堂筋

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 4.72 | 3.32 | **3.24** |

v1比 −1.48・v2比 −0.08（ほぼ横ばい・flat扱い）。v1からv2にかけて既に大きく改善していたため、v3での追加改善幅は小さい。

---

## §46-12｜中央大通

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 4.26 | 3.18 | 3.34 |

v1比 −0.92（改善）・v2比 +0.16（わずかに悪化・flat扱い、しきい値±0.2以内）。

---

## §46-13｜玉造筋

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 5.49 | 6.15 | **5.07** |

v2比 **−1.08改善**（§22必須改善対象・達成）。v1比でも−0.42改善。

---

## §46-14｜今里筋

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 4.07 | 4.19 | **3.68** |

v2比 −0.51改善。change point 0件（安定した道路）。

---

## §46-15｜あびこ筋

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 5.46 | 6.75 | **6.34** |

v2比 **−0.41改善**（§22必須改善対象・達成）。ただしv1比では+0.88とまだ悪化したまま。9路線中最もscatterが大きい路線として残存課題。

---

## §46-16｜松虫通

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 5.91 | 5.28 | **4.62** |

v1比 −1.29・v2比 −0.66（一貫して改善）。

---

## §46-17｜国道1号

**測定不能**（canonical roadに該当する`name`属性が無い。大阪市内を通過しないためFIX16/17から一貫して計測対象外）。

---

## §46-18｜国道25号

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 4.88 | 4.30 | **3.95** |

v1比 −0.93・v2比 −0.35（一貫して改善）。

---

## §46-19｜国道43号

| | v1 | v2 | v3 |
|---|--:|--:|--:|
| scatter | 3.76 | 4.38 | **3.78** |

v2比 **−0.60改善**（§22必須改善対象・達成）。v1比ではほぼ横ばい（+0.02）。

---

## §46-20｜change point結果

**1,755件**（city-wide）。intersection・車線split/merge・橋梁・道路等級変化等、3 segment以上持続する「本物の幅変化」として区別された箇所。widthSpike（3,414件・1〜2 segmentのみの孤立した跳び＝疑わしいpair）とは明確に分離して記録している。今里筋はchangePoint 0件（安定）、国道43号は19件（複雑な区間が多い）など、路線ごとの構造差も観測できた。

---

## §46-21｜multi-carriageway結果

**専用の分離アルゴリズム（§9/§16）は実装していない**。DPの候補選択自体が複数candidate trackを保持する設計（§4の上位K=3候補）のため、中央分離帯のある道路では暗黙的に「最良の1本」が選ばれるが、outer-left/median-left/median-right/outer-rightを明示的に分類してfull-road-widthとone-carriagewayを区別する処理（§10）は今回未実装。これは正直な記録として残す（御堂筋等の幹線でscatterが依然大きい一因である可能性が高い）。

---

## §46-22｜service road結果

**専用の分離アルゴリズム（§17）は実装していない**。frontage/service roadがouter edge候補に混入する可能性は排除できておらず、これもscatter残存の一因と考えられる。次ミッションの候補課題として記録する。

---

## §46-23｜residential regression有無

**regressionなし**。住吉・阿倍野・平野・十三の4地区全てでHIGH比率62.1〜72.5%を維持（v2の62〜70%と同水準〜やや改善）。coverage自体も大幅増加（各地区750〜1,257 pairsとv2から倍増）しつつprecisionを落としていない。

---

## §46-24｜GSI/FIX13面積比較

sample area単位でHIGH（widthSpikeでない）pairのみ面化し、FIX13 primary車道面積と比較。10地区中複数でGSI v3面積がFIX13の50-85%程度（FIX17の傾向を概ね維持。詳細な区分値は`data/reports/gsi-road-reconstruction-v3.json`の`fix13Comparison`を参照）。coverage増加に伴いHIGH pair数自体は各地区で大幅増（例: 面化対象のtrusted pair数が実質倍増）。

---

## §46-25｜hybrid coverage

corridor pair単位（segment単位ではない）のconfidence内訳:

| 区分 | 割合 |
|---|--:|
| GSI_HIGH | 69.4% |
| GSI_MEDIUM | 28.7% |
| FIX13_FALLBACK（LOW相当） | 1.9% |
| UNRESOLVED | 0% |

**実geometry union（実際にGSI高信頼面とFIX13 fallback面を合成した1枚のprototype surface）は今回実装していない**（§29が「してよい」＝任意実装と明記されているため、比率算出に留めた）。これは次ミッションの統合設計フェーズでの課題として引き継ぐ。

---

## §46-26｜Building overlap補助比較

FIX17と同水準の簡易指標（sample area内のHIGH pair数・近傍building tile数）のみ実施。詳細なpoint-in-polygon overlap比較（FIX13 vs GSI v2 vs GSI v3 vs Hybrid）は**引き続き未実施**（規模・優先度の判断・FIX16から3回連続の持ち越し課題）。§20/§32/§36の原則通り、Buildingをroad geometryのground truthとして使っていない。

---

## §46-27｜prototype payload

| ファイル | サイズ | 配信 |
|---|--:|---|
| edge-tracks.json | 24.95MB | **非配信** |
| corridor-pairs.json | 47.19MB | **非配信** |
| prototype-surfaces.json | 99.95MB | **非配信** |
| prototype-surfaces-sample.json | 4.86MB | **public配信**（runtime toggle用） |

data/processed配下はgitignore対象。全大阪debug metadataはbrowserへ送らない（§36遵守）。

---

## §46-28｜performance

city-wide計算: segmentize 0.3-0.4秒 + corridor DP（network構築+track構築+Viterbi DP）約6秒 + canonical roads読込3.6秒 ≈ **合計約19秒**（offline precompute。corridor reconstruction・DP・change-point・pairingは全てbrowserでは実行しない §37遵守）。DP状態空間は頻度上位10 trackに制限し、state爆発を防止。

---

## §46-29｜validator

`tools/validate/gsi-road-reconstruction-v3.js` — **RESULT: PASS**

```json
{"rawMutation":0,"canonicalRoadMutation":0,"buildingMutation":0,"fix13Mutation":0,
 "impossibleWidth":0,"untrackedPairSwitch":0,"illegalPairCrossing":0,
 "unexplainedSideFlip":0,"brokenCorridor":0,"invalidPrototypePolygon":0,
 "finalDecisionValid":true,"noLanesWidthForcing":true,"noUniformBuffer":true,
 "noMovingAverageSmoothing":true,"productionModified":false,"protectedModified":false,
 "publicHasOnlySample":true,"samplePayloadExcessive":false}
```

§40の10必須チェック全て条件達成。

---

## §46-30｜npm test

```
tests 1408 / pass 1393 / fail 0 / skipped 15
```

新規`tests/gsi-road-reconstruction-v3.test.js`: **14件pass**。mission07/08/09-building-*.test.jsのprefix guard（FIX15で発見・修正した潜在バグ対策）は**今回も再発なし**。production/protected HTML不変、`git diff --check` clean。

---

## §46-31｜最終判定

# **`READY_FOR_HYBRID_GSI_ROAD_PROTOTYPE`**

### 判定チェックリスト（8項目全て達成）

| 項目 | 結果 |
|---|---|
| coverageMaintained（≥50%） | ✅ 93.7% |
| majorScatterClearlyImproved（v2比10%以上） | ✅ 11.9%改善 |
| fix17TargetRoadsImproved（4路線中3以上） | ✅ 4/4改善 |
| widthSpikeReduced | ✅ 39%減 |
| pairSwitchReduced | ✅ 64%減 |
| noResidentialRegression | ✅ 4地区ともregressionなし |
| noIntersectionCriticalFailure | ✅ |
| provenance100 | ✅ |

### 判定根拠

**FIX17で最優先課題としたscatter問題が、corridor-level DPで明確に改善した**: 平均4.79→4.22（v1の4.70も上回る）。FIX17で悪化していた4路線（御堂筋・玉造筋・あびこ筋・国道43号）**全てがv2比で改善**。同時にcoverageも61.3%→93.7%へ大幅増加し、pair switch/side flip/width spikeという「誤pair起因のscatter」の直接的な指標も全て大幅削減。residential regressionもない。

**ただし本番統合の準備が完了したわけではない**: multi-carriageway分離（§9/§16）・service road分離（§17）は未実装、実geometry hybrid union（§29-31）は未実装、目視QAは実施不能、あびこ筋はv1比でまだ悪化したまま。これらは次ミッション（Hybrid統合設計）での課題として明記する。

### 次ミッションへの引き継ぎ

1. multi-carriageway検出（outer-left/median-left/median-right/outer-right）の実装
2. frontage/service road分離
3. 実geometry hybrid union（GSI HIGH面 + FIX13 fallback面の実際の合成）
4. 交差点自体のpolygon再構成（Strategy A/§20は依然未実装）
5. あびこ筋等の残存高scatter路線への対応

---

## 完了条件（§44/§45）チェック

- [x] npm test全件 fail 0（1393 pass）
- [x] mission07/08/09 prefix guard維持（再発なし）
- [x] production/protected HTML無変更
- [x] FIX13 default無変更
- [x] `git diff --check` clean
- [x] Canonical Road(199,658) / Building(615,617) / FIX13(indexedCount 30,190) 完全不変
- [x] 次工程（本番統合）へ自動で進まずSTOP

## 変更・新規ファイル

| ファイル | 種別 |
|---|---|
| `tools/lib/gsi-road-edge-corridor-v3.js` | 新規（edge track構築・Viterbi DP・change point検出） |
| `tools/lib/gsi-road-edge-pairing-v2.js` | 変更（`scorePair`をexport・v3から再利用） |
| `tools/audit/gsi-road-reconstruction-v3.js` | 新規（§39包括レポート生成） |
| `tools/validate/gsi-road-reconstruction-v3.js` | 新規（§40 validator） |
| `tests/gsi-road-reconstruction-v3.test.js` | 新規（14件） |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 変更（`[GSI Prototype v3]`トグル追加・既定OFF・ライムグリーン） |
| `.gitignore` | 変更（gsi-road-surface-v3追加） |
| `package.json` | 変更（npm scripts 2件・test list追加） |
| `data/reports/gsi-road-reconstruction-v3.json` | 生成（§39） |
| `data/reports/gsi-road-reconstruction-v3-validation.json` | 生成 |
| `data/processed/osaka-city/gsi-road-surface-v3/{corridors,width-profiles,prototype-surfaces}/*.json` | 生成 |
| `public/map-data/osaka-city/gsi-road-surface-v3/prototype-surfaces-sample.json` | 生成（配信コピー・4.86MB） |

production `osaka_3d_buildings.html` / protected `osaka_3d_buildings.fullward-v3.html` は**不変**。Canonical Road・Building・FIX13デフォルトの**本番置換は一切行っていない**。

---

**次工程（Hybrid統合設計）へは進まず、Corridor-Level Reconstruction v3の実装・評価のみ完了。FIX13を正式baselineとして維持。判定はREADY_FOR_HYBRID_GSI_ROAD_PROTOTYPE（統合設計フェーズへの移行を検討可能、ただし未着手）。ユーザー確認待ち。**
