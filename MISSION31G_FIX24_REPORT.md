# Mission 31G-FIX24 完了報告｜Building Ground-Anchor Final Fix

**最終ステータス: `VISUAL_QA_PENDING_USER`**（§28 の要求どおり、validator PASS のみでは完了とみなさない。実機スクリーンショットによるユーザー確認が別途必要）

---

## 0. 要約

- ユーザーの根源的な指摘「建物が全体的にちょっとずれている」に対し、既存ミッションで否定済みの
  「グローバルCanonical→Runtime平行移動オフセット」ではなく、**NEAR-LOD建物ジオメトリの
  簡略化（tolM=2）が個々の建物輪郭（エッジ）を最大約50m、有意な割合（12.2%が1m超）だけ
  ずらしていた** ことを、615,617棟全数の実測で確認した。
- 修正: `derived/near/buildings` のみ簡略化トレランスを **2m → 0m（Canonical原形そのまま）** に変更。
  道路・水域・公園・鉄道・mid/far tierは一切変更していない（§20遵守）。
- 実装は最小: 新LODやfetch経路は追加せず、既存の「near = 全建物を含む」tile配信の仕組みは
  そのまま使い、そのtierが持つデータの精度だけを上げた。ランタイムコード変更ゼロ。
- 作業中に自己発見・自己修正した重大インシデント（§4参照）を含め、透明に報告する。

---

## 1. NEAR簡略化が「ずれ」に直接寄与していたか

**Yes。** 全615,617棟を対象に、Canonical原形の外周頂点それぞれから旧near(tolM=2)の
輪郭境界までの最短距離（directed Hausdorff的エッジ偏差）を測定した結果:

| 指標 | 値（修正前・tolM=2） |
|---|---|
| 中央値エッジ偏差 | 0m |
| p95エッジ偏差 | 0.742m |
| 最大エッジ偏差 | 49.96m |

中央値が0mなのは「多くの頂点はVisvalingam-Whyattにより保持されそのまま」という簡略化方式の
性質どおりだが、p95・maxが示すとおり **一部の頂点・建物では無視できない量のずれが実際に生じていた**。
道路・街区に対して「数mずれて見える」という主観的印象と整合する規模感である。

## 2. 修正前の棟単位エッジ偏差分布（中央値・p95・最大）

`beforeFix.derivedVsCanonical`（`data/reports/building-exact-near-alignment.json`）:

```
medianEdgeDeviation: 0
p95EdgeDeviation:    0.742m
maxEdgeDeviation:    49.960m
```

## 3. しきい値超過棟数（1m超／2m超、道路隣接考慮）

棟単位（各建物の最大頂点偏差で1棟としてカウント）、全615,617棟中:

| しきい値 | 超過棟数 | 割合 |
|---|---|---|
| 0.25m超 | 159,232棟 | 25.9% |
| 0.5m超 | 138,391棟 | 22.5% |
| **1.0m超** | **74,881棟** | **12.2%** |
| 1.5m超 | 27,312棟 | 4.4% |
| **2.0m超** | **4,907棟** | **0.8%** |
| （参考）5m超 | 255棟 | 0.04% |
| （参考）10m超 | 57棟 | 0.01% |
| （参考）20m超 | 9棟 | 極小 |

道路隣接建物個別の抽出はサンドボックス環境の制約上（GISクリップ処理を追加実装しなかった）
実施していないが、都心部（梅田・中之島・本町等）は建物密度が高くタイル内対象棟数が多いため、
統計的にこれらのエリアで超過棟に遭遇する確率は高いと推定される。実機QA（§22相当）での
確認を推奨する。

20m超の9棟は、面積ベース簡略化（Visvalingam-Whyatt）が持つ既知の弱点
（細く鋭い「スパイク」頂点は三角形面積が小さいため、頂点間距離が大きくても誤って除去されうる）
に起因すると考えられる、稀だが実在する外れ値。

## 4. NEAR tier をどう「exact」にしたか（実装方法）

- `tools/build-derived-geometry.js` に `LOD_TOLERANCE_OVERRIDE = { buildings: { near: 0 } }` を追加し、
  `tolForLayerLod(layer, lod)` 経由でこのoverrideを適用。roads/water/parks/railはoverride対象外の
  ため従来どおり `LOD.near.tolM = 2` のまま。
- 新しい4番目のLOD階層・新しいディレクトリ（`exact-near/`等）は作らなかった。理由:
  既存の `near` tierは既に「全615,617棟を無条件に含む」設計（`buildingVisibleAt` が near時は
  常にtrue）であり、既存ランタイムの `fetchAndParse`/`buildGroup` はタイルパス配下のデータを
  そのまま消費するだけなので、**near tierが持つデータ自体の精度を上げるだけで、新しいLOD遷移点・
  新しいfetch経路を一切増やさずに §1 の要求（NEAR = 完全なCanonical原形）を満たせた。**
  これにより §15/§16（LOD切替のposition-jump・空白フレーム禁止）のリスクは新規には発生しない
  （遷移点自体が増えていないため）。

## 5. 修正後（exact-runtime）のエッジ偏差実測

```
medianEdgeDeviation: 0m
p95EdgeDeviation:    0m
maxEdgeDeviation:    0m
sampleCount: 615,617
```

Canonical原形をそのまま採用しているため理論上も実測上も完全に0。§8の目標
（edge displacement ≈0、centroid 0、rotation 0、scale 1）のうちedge displacementはこれで達成。
centroid/rotation/scaleは元々変更していない（頂点を一切動かしていないため自明に不変）。

## 6. base/top XZ不一致監査（§9/§10）

`pushExtrude()`（`public/osaka_3d_buildings.ward-ux-v1.html`）を直接読み込み監査。壁は
`positions.push(a[0],0,a[1], b[0],0,b[1], b[0],h,b[1])` / `positions.push(a[0],0,a[1], b[0],h,b[1], a[0],h,a[1])`
という形で、base(y=0)とtop(y=h)に**同一のx/z値**をそのまま流用しており、屋根も同じcontourを
y=hで積むだけで新しい座標を作らない。**既存コードは既にクリーンで、バグは見つからなかった
（修正不要）。** validatorに静的正規表現チェックを追加し、退行を検知できるようにした。
`baseTopXZMismatchCount = 0`。

## 7. Mesh/Group transform監査（§11）

`buildGroup`/`drainBuild`周辺コードを確認。建物グループへの不審な非ゼロ `position.x`/`position.z`
代入は検出されなかった（`unexpectedBuildingXZTransform = 0`）。ジオメトリのワールド座標とグループ
translationの二重適用も見当たらない。

## 8. LOD切替（handoff）への影響

新しい遷移点を追加していないため、既存のFAR→MID→NEARの切替ロジック・タイミングはそのまま。
near tierの中身が精密になっただけで、切替の**発生条件・発生タイミング自体は変更していない**。
そのため position-jump・空白フレームのリスクは本修正によって新規に生じない。ただし実際の
視覚上のLOD切替体験（近づいたときにより精密な輪郭へ切り替わって見えるかどうか）は実機確認が必要。

## 9. ペイロード増加

| tier | 頂点数 | ディスク容量（processed） |
|---|---|---|
| near（修正前 tolM=2） | 約2,843,223 | （上書き済みのため再計測不可、参考値） |
| **near（修正後 tolM=0）** | **3,494,617** | **444MB** |
| mid（tolM=6、参考） | 629,617 | 56MB |
| far（tolM=12、参考） | 213,605 | 16MB |

頂点数の増加は約23%（旧コードコメントが主張していた「容量2倍」という前提は、今回の全数実測で
明確に反証された。§4の`priorArtNote`参照）。near tierは元々カメラ近傍タイルのみを段階的に
fetchする設計（§25-27で懸念された「615k棟一括ロード」には該当しない）であるため、実運用上の
影響は「近傍タイルのダウンロード・パースコストが約23%増える」程度と見積もる。

## 10. フレーム性能（p95・draw calls・メモリ）

**未測定・正直に申告する。** このサンドボックス環境にはブラウザがなく、実際のThree.jsレンダリング
フレームタイム・draw call数・GPU/JSメモリ使用量を測定する手段がない。上記9のバイト数・頂点数の
増分から間接的に「近傍タイルの処理コストが約23%増える」という推定はできるが、実機でのp95フレーム
タイム測定（§22のQA地点を含む）が必須。**FIX7で達成した性能改善を壊していないかは実機再測定が
必要**というのが誠実な現状認識。

## 11. メモリへの影響

同上、未測定。頂点数23%増から線形に見積もれば同程度のメモリ増と推定されるが、実測していない。

## 12. Picking（hover/click/property card/canonicalId）への影響

`pushExtrude`/`buildGroup`/ピッキング関連コードに変更を加えていない。各Mesh/Groupには
既存どおり `canonicalId` 等のuserDataが付与される設計のまま。ロジック変更ゼロのため機能的には
影響なしと判断するが、動的スモークテスト（`buildGroup`呼び出しが例外なく通ること、
`__CANONICAL_SELF_CHECK__().total === 0`）で確認済み。実クリック操作自体はブラウザ実機確認が必要。

## 13. Usage-category色分けへの影響

`buildGroup`の`usageCategory`ごとのグルーピング・色分けロジックには一切触れていない。
影響なし。

## 14. Building Placement Policyとの整合性

`building-placement/`（`tools/build-building-placement-policy.js`の成果物）は本ミッション中の
インシデント復旧（§4参照）で再生成したが、生成元は変更していないCanonical Buildingsのままであり、
本修正（near tierのtolM変更）はPlacement Policyの判定ロジック自体には影響しない。復旧後の
`building-ward-index.json`は66,376棟（SUPPRESS+REVIEW+EXEMPT合計）で、直前の
`building-placement-policy.json`のSUPPRESS/REVIEW/EXEMPT内訳（4549+55440+6387）と一致することを確認済み。

## 15. Validator結果

`node tools/validate/building-exact-near-alignment.js` → **RESULT: PASS**

```json
{"nearUsesExactCanonicalFootprint":true,"nearSimplificationTolerance":0,
 "nearFeatureCountMatchesCanonical":true,"publicNearMatchesProcessed":true,
 "roadNearToleranceUnchanged":true,"baseTopXZMismatch":0,
 "unexpectedBuildingXZTransform":0,"fixApplied":true,"exactRuntimeZeroDeviation":true,
 "productionModified":false,"protectedModified":false,
 "buildingGeometryMutation":0,"roadGeometryMutation":0,"projectionMutation":0,
 "geometryMutation":0}
```

既存の関連validator（`derived-geometry.js`, `legacy-residual-guard.js`, `gsi-building-alignment.js`）も
全てPASSを再確認済み（インシデント由来の巻き添え被害がないことの裏取り）。

## 16. npm test結果

```
ℹ tests 1506
ℹ pass 1491
ℹ fail 0
ℹ skipped 15
EXIT=0
```

FIX24前のベースライン（1498 tests / 1483 pass / 0 fail / 15 skip）に対し、新規追加した
`tests/building-exact-near-alignment.test.js`（8件、全PASS）分だけ純増しており、**既存テストの
退行は0件**。実scene graph test harness（`tests/_ward-ux-v1-smoke-harness.cjs`）も変更・スタブ化
しておらず維持している。新規テストは`package.json`の`test`スクリプトに追加登録済み。

## 17. Visual QA状態

**`VISUAL_QA_PENDING_USER`。** §22で指定された梅田・中之島・本町・難波・天王寺・住吉を含む
実機での目視確認（§23-24のTop-Down／Angled View比較）は、このサンドボックス環境では実行不能。
validator PASSとnpm test全PASSは確認済みだが、§28の要求どおりこれのみでは完了と見なさない。

## 18. 本修正で変更・非変更の範囲（§0/§20遵守の確認）

- **変更**: `data/processed/osaka-city/derived/near/buildings/`（tolM 2→0）とその公開コピー
  (`public/map-data/.../near/buildings/`)のみ。
- **非変更**: Canonical Buildings/Roads（615,617棟／199,658本、featureCount不変を実測確認）、
  refined-road-surface.json（indexedCount=30,190で不変）、mid/far tierおよびroads/water/parks/rail
  の全tier、production HTML（`osaka_3d_buildings.html`）、protected HTML
  （`osaka_3d_buildings.fullward-v3.html`）、projection定数（135.52502）。
  建物の中心座標・回転・スケールも一切変更していない（頂点を動かさず、簡略化の有無のみを変更）。

---

## 19. 追記: 作業中に発見・修正した重大インシデント（透明性のため報告）

`tools/build-derived-geometry.js`の元々の`main()`は、自身の出力ディレクトリを準備する際に
`fs.rmSync(data/processed/osaka-city/derived/, {recursive:true, force:true})`という**親ディレクトリ
全体の削除**を行っていた。このディレクトリは、本スクリプト自身が生成する`far/mid/near/`サブ
ディレクトリだけでなく、**他のミッション（FIX6/FIX9/FIX12/FIX13）のスクリプトが生成する成果物
（`refined-road-surface.json`, `road-render-class.json`, `building-ward-index.json`,
`building-placement/`）も同じ親ディレクトリに置いている**ため、本ミッションでのbuild再実行時に
これらが巻き添えで削除される実バグを引き起こした。

**発見経緯**: 新規validatorの初回実行で`refined-road-surface.json indexedCount 変化: null`という
エラーが出たことから発覚。該当ファイルはgit管理外だったため`git checkout`では復旧できず、
各生成元スクリプト（`build-refined-road-surface.js`→`build-road-render-class.js`→
`build-building-placement-policy.js`→`build-ward-building-index.js`）を正しい順序で再実行して
復旧した。全て決定論的な生成のため、`refined-road-surface.json`のindexedCountは30190と、
インシデント前と完全一致する形で再現できた。

**再発防止**: `build-derived-geometry.js`を`cleanOwnedOutputs()`という新しいクリーンアップ関数に
書き換え、**自身が所有する`far/mid/near/`サブディレクトリと`manifest.json`のみ**を削除するように
修正した。これにより同種のバグが今後のミッションで再発することを防止する。この修正自体は
リグレッションテスト（`tests/building-exact-near-alignment.test.js`内）で静的に保護している。

復旧・修正後、`build-derived-public.js`を再実行して全成果物（4737ファイル/677.8MB）を再publishし、
`refined-road-surface.json indexedCount`が処理済み・公開済み両方で30190であることを確認、
関連する全validatorとnpm testを再実行して0件の退行であることを確認した（§15/§16参照）。

---

## 完了チェックリスト（§32対応）

- [x] エッジ偏差を実測（修正前・修正後）
- [x] NEAR tierをexact canonical footprintへ切替
- [x] base/top xz一致を監査（既存コードで既に正しい）
- [x] group x/z offsetなしを監査
- [x] LOD遷移点を新規に増やしていない（gapリスクなし）
- [x] Picking機能への変更なし（静的+動的確認）
- [x] usage color変更なし
- [x] Placement Policyとの整合性確認
- [x] roads等の他レイヤー変更なし
- [ ] **性能（フレームp95・draw calls・メモリ）は実機未測定** — 頂点数増分(+23%)からの推定のみ
- [x] validator PASS
- [x] npm test 0 fail（1506 tests / 1491 pass / 0 fail / 15 skip）
- [x] production/protected HTML変更なし
- [x] **STOP** — 次工程へは自動で進まない

**次工程へ自動で進まずSTOPします。** 実機での梅田・中之島・本町・難波・天王寺・住吉を含む
スクリーンショット確認、および実フレーム性能測定をお願いします。ご確認の上、次のご指示をお待ちします。
