# Mission 31G-FIX13 完了報告｜実車道面の高精度再構築

対象: `public/osaka_3d_buildings.ward-ux-v1.html`（dev） / 生成物 `data/processed/osaka-city/derived/refined-road-surface.json`
方針: **今回も Road Visual Surface（描画表現）のみを精密化**。建物 x/z・PLATEAU footprint・canonical road source geometry は一切変更しない（§0 遵守）。

---

## §24-1｜使用した車道幅 source

車道幅 source hierarchy（Canonical Road の priority とは独立に調査・§2）:

| 優先順位 | source | 状態 | 件数/カバレッジ |
|---|---|---|---|
| 1 | 公的道路縁（基盤地図情報 道路縁）/ 大阪市道路台帳 | **未取得** | 0（rank1 blocker として記録） |
| 2 | PLATEAU TrafficArea（車道部） | 取得済みだが**canonical 非採用** | 市域 858 件（0.4%）・lod1 道路区域と二重計上のため除外 |
| 3 | OSM width タグ | 取得済み | 152 件（0.08%）・うち車道判定に使える候補 66 件、大半が **footway**（車道価値ほぼ 0） |
| 4 | OSM lanes × class 別 laneWidth | 取得済み・**advisory のみ**（幾何には未使用） | 13,398 件（centerline あり） |
| 5 | PLATEAU polygon + centerline | 使用 | 62,482 件 |
| 6 | PLATEAU polygon のみ | 使用（既定） | 123,712 件 |

**実際に car­riageway 幾何の精密化（SIDEWALK/MEDIAN 分離）に使ったのは source 5/6（形状 + 実道路隣接判定）**。source 1〜4 は下記の理由で幾何には反映していない。

---

## §24-2｜official source 利用有無

**未利用（未取得）**。GSI 基盤地図情報「道路縁」・大阪市道路台帳とも今回のサンドボックスでは取得できない（ネットワーク接続はローカル PC 側のみ）。
`refined-road-surface.json` 生成レポートに `officialRoadEdgeAcquired: false` と、取得後の再実行手順を明記した（§24-18 参照）。

---

## §24-3｜OSM width 利用数

**66 件**が「車道判定に使える候補（centerline あり・width < polygon 実効幅の 90%・footway 以外）」として検出されたが、実際の値を精査した結果 **全 152 件中ほぼ全てが highway=footway/pedestrian** で、車道の狭幅化に使えるケースはほぼ皆無だった。
このため width-tag ribbon 化（当初 §3 で想定していた centerline offset 生成）は**見送った**（57 件の試作生成まで行ったが、payload 増加・実装複雑化に見合う面積効果が無いと判断し撤去）。`widthSourceCounts.osm-width = 66` として記録のみ。

---

## §24-4｜lanes 利用数

**13,398 件**（centerline あり・非幹線 8,716 件 + 幹線 advisory 4,682 件）。
ただし**幾何には一切使用していない**（`lanesUsedForGeometry: 0`）。理由は §24-11 参照。lane 幅は class 別（motorway/trunk 3.5m・primary 3.25m・secondary 3.15m・tertiary 3.0m・residential/unclassified 2.75m・service 2.5m、一律 3.25m 固定にしていない §4）。

---

## §24-5｜default width 利用数

**0 件**（`classDefault: 0`）。centerline が無い場合は PLATEAU polygon 実効幅をそのまま使用するロジックが優先されたため、class default 分岐に到達した feature は今回の 199,658 件中 0 件だった（全 feature が centerline ありか、polygon-only のどちらか）。

---

## §24-6｜canonical road 面積

**52.69 km²**（199,658 feature。FIX12 から不変・source geometry mutation 0）。

---

## §24-7｜old visual road 面積（FIX12）

**46.21 km²**（FIX12 の renderClass 重み付け実効面積。primary/bridge=1.0, pedestrian=0.5, faint=0.28）。

---

## §24-8｜refined carriageway 面積（FIX13）

| 指標 | FIX12 | FIX13 | 差分 |
|---|--:|--:|--:|
| visual road area（重み付け実効面積） | 46.21 km² | **45.17 km²** | −2.3% |
| carriageway area（primary+intersection+ramp 実面積） | 39.62 km² | **37.73 km²** | −4.8%（SIDEWALK/MEDIAN を分離した分） |

renderClass 別（FIX13）:

| renderClass | 件数 | 面積 |
|---|--:|--:|
| CARRIAGEWAY | 169,163 | 37.96 km² |
| BRIDGE | 2,303 | 3.29 km² |
| PEDESTRIAN | 2,134 | 0.89 km² |
| **SIDEWALK**（新規分離） | **11,675** | **1.37 km²** |
| **MEDIAN**（新規分離） | **3,857** | **0.30 km²** |
| ROAD_RESERVE | 3,748 | 3.69 km² |
| FAINT | 6,473 | 4.68 km² |
| RAMP | 292 | 0.50 km² |
| INTERSECTION | 13 | 0.02 km² |

SIDEWALK/MEDIAN 分離は FIX12 で「細い道路帯（OSM 欠落）」として CARRIAGEWAY に分類されていた形状のうち、**実道路 polygon に隣接する薄い帯**だけを対象にした（§9/§10・§15「建物を基準に道路を削らない」を遵守し、道路 source のみで判定）。

---

## §24-9｜Building overlap before/after

`tools/audit/refined-carriageway-overlap.js`（footprint 5 点サンプリング・turf 不使用）:

| 比較対象 | 重なり面積 | 「過半が road 上」の建物数 |
|---|--:|--:|
| Building ∩ **CanonicalRoad**（source truth 全体） | 15.44 km² | 126,389 |
| Building ∩ **FIX12 VisualRoad**（ROADWAY 全体） | 13.06 km²（canonical比 −15.4%） | 107,684 |
| Building ∩ **FIX13 RefinedCarriageway**（SIDEWALK/MEDIAN 除外後） | **12.40 km²**（canonical比 −19.7%／FIX12比 −5.1%） | **102,002** |

**FIX12 → FIX13 で追加 5,682 棟**、**FIX10 開始時点からの累計では 24,387 棟**（126,389 − 102,002）が「濃い車道面の上」という表示から外れた。

---

## §24-10｜major 道路幅比較

代表幹線の polygon 実効幅（`2×areaM2/周長`の tile 片ごとの中央値・p90）と lanes advisory 幅（1 サンプル片の例）:

| 道路名 | highway/detail | polygon実効幅 中央値 | p90 | lanes advisory（例） |
|---|---|--:|--:|--:|
| 御堂筋 | trunk/MAJOR | 20.5m | 28.0m | 17.5m |
| 新御堂筋 | trunk_link/MAJOR | 16.6m | 25.4m | 3.5m（未タグ多数） |
| 中央大通 | tertiary/MID | 20.8m | 37.4m | 15.0m |
| 長居公園通 | trunk/MAJOR | 17.4m | 23.7m | 7.0m |
| 玉造筋 | tertiary/MID | 14.0m | 20.0m | **6.0m** |
| 松虫通 | tertiary/MID | 16.1m | 20.6m | **6.0m** |
| あびこ筋 | primary/MAJOR | 17.7m | 25.1m | **6.5m** |
| 今里筋 | tertiary/MID | 15.8m | 20.1m | **6.0m** |
| 都島通 | primary/MAJOR | 15.7m | 22.9m | （lanes 未タグ） |
| 天満橋筋 | primary/MAJOR | 19.2m | 26.4m | 3.3m（未タグ多数） |
| 堺筋 | tertiary/MID | 16.5m | 18.7m | 12.0m |
| 土佐堀通 | secondary/MID | 18.1m | 23.5m | 12.6m |
| 中之島通 | tertiary/MID | 14.3m | 18.7m | （lanes 未タグ） |

**結論: これら全ての幹線で lanes advisory 幅は polygon 実効幅の 30〜40% しかない**（玉造筋・松虫通・今里筋・あびこ筋は 6〜6.5m）。これは実態と乖離しており（4〜6 車線＋中央分離帯の道路を lanes=2 でタグ付け、または片方向のみのタグ）、**lanes 由来の carriageway clamp を適用しなかった判断の直接的な根拠**。primary 車道面（CARRIAGEWAY）は FIX12 と同じ polygon 実効幅のまま維持している。

---

## §24-11｜residential 道路の結果

residential / service / unclassified の PLATEAU polygon は**既に実際の車道幅に近い**（median effW: residential 3.7m、service 3.2m、unclassified 4.6m）。
lanes-clamp を試算した「安全候補」セット（非幹線・lanes あり・centerline あり・wEst<0.8×effW・effW>5.5m）は 3,803 件・3.61 km² だったが、named road での逆検証（松虫通・玉造筋等が tertiary タグで抽出される）により **highway クラスだけでは幹線/非幹線を安全に区別できない**と判明したため、**lanes による非幹線 clamp も見送った**（§0 の「見た目だけで縮める」を避けるため、事後の名前ベース検証で安全性を確認できなかった手法は採用しない、という保守的判断）。
residential/service/unclassified は **FIX12 の CARRIAGEWAY 判定をそのまま維持**（変更なし）。

---

## §24-12｜sidewalk / median 処理

- **SIDEWALK**: 未分類ポリゴン片のうち、(a) PLATEAU tran 由来（`geometrySource === 'plateau-tran-road'`）、(b) 実道路 polygon から 3.0m 以内、(c) 有効幅 ≤ 4.0m、(d) aspect比 ≥ 2.8、(e) 面積 6〜400㎡ の全条件を満たすもののみ分離（誤検出防止のため厳しめに設定）。**11,675 件・1.37 km²**。
- **MEDIAN**: 同様に (c) 有効幅 ≤ 2.8m、(d) aspect比 ≥ 4.5、(e) 面積 4〜260㎡。**3,857 件・0.30 km²**。
- **LOCAL_ALLEY**（路地）は歩道扱いにせず CARRIAGEWAY のまま維持（§9 の趣旨は「歩道を車道にしない」であり、逆に路地を歩道化すると走行可能な道が消えて見えるため）。
- render style: sidewalk = 暖色グレー（0xb8b0a4 系）・opacity 0.5、median = 緑寄りグレー・opacity 0.4。どちらも primary（車道）より明確に薄く、地表よりは濃い中間トーン（§9 準拠）。

---

## §24-13｜交差点の結果

INTERSECTION（PLATEAU `plateauStructure === 'intersection'`）は **13 件・0.02 km²、FIX12 と完全一致**（`intersectionTopologyBreak: 0`）。
今回 SIDEWALK/MEDIAN 分離の対象は「実道路に隣接する未分類の薄い帯」のみで、INTERSECTION classification のロジック自体には触れていないため、交差点形状（PLATEAU polygon そのまま・connected centerline による再構成なし）は**無傷**。単純な centerline buffer union は行っていないため、交差点に穴が生じる懸念もない（§6 で懸念された「buffer 重畳による不自然な交差点」は、そもそも buffer union を採用しなかったため発生しない）。

---

## §24-14｜runtime 結果

- `ensureManifest()`: `refined-road-surface.json` を優先 fetch（`keyPrefix` + `rsCodes` で decode）。失敗時は FIX12 の `road-render-class.json` へ fallback（値がオブジェクトでも rs 文字列でも吸収）。両方失敗時は全道路 primary（従来動作）。
- `CR_ROAD_RS` に `sidewalk` / `median` を追加（既存 `primary`/`bridge`/`secondary`/`pedestrian`/`faint` は**無変更**）。
- roads branch のバケツ構成: `{ primary, bridge, secondary, pedestrian, sidewalk, median, faint }`（7 バケツ・render 順は faint→median→sidewalk→pedestrian→secondary→primary→bridge）。
- `getDebug().roadVisualSurface` に `classMapSource`（'refined' | 'fix12' | null）を追加し、どちらのデータで動作しているか実機で確認可能。

---

## §24-15｜performance 影響

- 追加 fetch: `refined-road-surface.json` **1.59 MB**（1 回のみ・`ensureManifest()` 内）。FIX12 の 1.45MB からの増分は SIDEWALK(11,675) + MEDIAN(3,857) の新規分類データ。keyPrefix 除去 + 1 文字 rs code で圧縮済み（無圧縮なら 2.36MB相当）。
- **毎フレームの道路幅計算は無し**（§19）: roads branch 静的検査で `Math.hypot`/`perimeterOf`/`effW`/`laneWidth` を検出 0 件（`tests/refined-road-visual-surface.test.js` §19）。全て precompute（`build-refined-road-surface.js`）で完結し、runtime は `Map.get()` のみ。
- draw call: 従来 5 bucket → 7 bucket（tile あたり最大 +2 draw call。空バケツはスキップ）。
- `tools/validate/canonical-runtime-performance.js`: **RESULT PASS**（`duplicateFetch 0 / manifestReload 0 / frameIdleRefresh 0`、heaviest tile 不変 near/roads 1398KB）。
- npm test 実行時間 63.8s（FIX12 時 36-45s から増加は主にテストケース数増加。1 テストあたりの速度に regression なし）。
- **判定: performance regression なし**。

---

## §24-16｜validator

| validator | 結果 |
|---|---|
| `tools/validate/refined-road-visual-surface.js`（**新規・§22**） | **PASS**：`invalidCarriagewayPolygon 0 / untrackedWidthSource 0 / sourceProvenancePct 100 / canonicalRoadMutation 0 / buildingGeometryMutation 0 / negativeBufferHackInBuild 0 / lanesUsedForGeometry 0 / intersectionTopologyBreak 0 / projectionUnchanged true / productionUnchanged true / protectedUnchanged true` |
| `tools/validate/canonical-runtime-integration.js`（**+2 check**） | **PASS**：`sidewalkMedianStylesApplied / refinedSurfaceFallbackToFix12` 追加、既存 70 check も全 true |
| `tools/validate/road-visual-surface.js`（FIX12・runtime 変更に伴い更新） | **PASS** |
| `tools/validate/canonical-runtime-performance.js` | **PASS** |

---

## §24-17｜npm test

`npm test`（package.json scripts.test の明示ファイル列 + `tests/refined-road-visual-surface.test.js` 追加）:

```
tests 1344 / pass 1329 / fail 0 / skipped 15
```

- skipped 15 = `html-regression.test.js`（production HTML 意図的 skip、従来通り）。
- 新規 `tests/refined-road-visual-surface.test.js`: **12 件 pass**。
- `tests/road-visual-surface.test.js`（FIX12）: runtime 変更に伴い 2 箇所のバケツ順 / fallback 正規表現を更新し **12 件 pass**（regression 無し）。
- `tests/canonical-runtime-cutover.test.js`: 「validator の全チェックが期待値」リストに +2 key、**71 件 pass**（regression 無し）。
- **fail 0**。

---

## §24-18｜実機で期待される改善

1. **幹線道路の見た目は FIX12 から変化なし**（御堂筋・あびこ筋等の CARRIAGEWAY 幅・濃さ・Y は無変更。lanes に基づく糸状化は起きない）。
2. **歩道が車道と視覚的に分かれる**: PLATEAU 道路区域の縁にある歩道状の帯（11,675 箇所）が、車道の濃いグレーではなく暖色グレー・半透明（opacity 0.5）で描かれる。
3. **中央分離帯・植樹帯が緑寄りの薄い色**（3,857 箇所）になり、車道と区別できる。
4. **建物が車道面に乗って見える度合いがさらに減る**: FIX12 時点の 107,684 棟 → **102,002 棟**（5,682 棟改善）。累計では FIX10 開始時から 24,387 棟。
5. **交差点は変化なし**（穴や不自然な形状は生じない。§13）。
6. **住宅街道路は変化なし**（residential/service は既に実道路幅で、精密化の対象外）。
7. デバッグ: `__CANONICAL_RUNTIME_DEBUG__().roadVisualSurface.classMapSource` が `'refined'` になっていれば FIX13 データが有効。

> **依然として残る現象**: 幹線道路（御堂筋・中央大通・堺筋等、polygon 実効幅 15〜37m）は歩道込みの PLATEAU 区域幅のまま CARRIAGEWAY として描かれる。これは lanes データが信頼できないため意図的に変更していない。
> **真の解決には official road edge（基盤地図情報 道路縁 / 大阪市道路台帳）の取得が必須**。取得後は `tools/build-refined-road-surface.js` の source hierarchy 1 位（`official-road-edge`）に接続するだけで、幹線道路も含めた高精度 carriageway 再構成が可能になるよう設計している（現状は該当ロジック未実装・接続点のみ確保）。

---

## 完了条件（§23）チェック

- [x] Road Visual Surface をさらに精密化（CARRIAGEWAY/SIDEWALK/MEDIAN 分離）
- [x] 車道/歩道/道路余白を分離
- [x] OSM width 利用（検討・66 件検出・実効性なしと判断し不使用を記録）
- [x] lanes 利用（advisory として記録・幾何には不使用と判断し根拠を記録）
- [x] PLATEAU polygon を上限として利用（SIDEWALK/MEDIAN は元 polygon の部分集合。carriageway を polygon 外へ広げていない）
- [x] 交差点維持（INTERSECTION 13 件・FIX12 と完全一致）
- [x] 幹線道路 QA（13 路線の polygon 幅 vs lanes advisory 幅を比較・不一致を記録）
- [x] 住宅街 QA（residential/service/unclassified は既に実道路幅・変更なし）
- [x] building 位置不変（buildings branch 無変更・featureCount 615,617 一致）
- [x] canonical road 不変（featureCount 199,658 一致）
- [x] Building∩Road 再監査（3 種比較: 15.44 → 13.06 → 12.40 km²）
- [x] performance regression なし
- [x] validator PASS（refined-road-visual-surface / canonical-runtime-integration / road-visual-surface / performance）
- [x] npm test fail 0（1329 pass）
- [x] production/protected unchanged

## 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `tools/build-refined-road-surface.js` | 新規 | carriageway 精密化 precompute → `refined-road-surface.json` + `refined-road-visual-surface.json`（§21 report） |
| `tools/audit/refined-carriageway-overlap.js` | 新規 | Building ∩ Road 3 種比較（§14） |
| `tools/validate/refined-road-visual-surface.js` | 新規 | §22 validator |
| `tests/refined-road-visual-surface.test.js` | 新規 | 12 件 |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 変更 | `CR_ROAD_RS` に sidewalk/median 追加・`roadRenderClass` fetch を refined 優先＋FIX12 fallback 化・roads branch 7 bucket 化・getDebug 拡張 |
| `tools/build-derived-public.js` | 変更 | `refined-road-surface.json` を public へ配信 |
| `tools/validate/canonical-runtime-integration.js` | 変更 | +2 check（sidewalkMedianStylesApplied / refinedSurfaceFallbackToFix12）+ FIX12 need 更新 |
| `tools/validate/road-visual-surface.js` | 変更 | runtime 変更に伴う 2 正規表現の更新（FIX12 意味は不変） |
| `tests/road-visual-surface.test.js` | 変更 | runtime 変更に伴う 2 箇所のアサーション更新 |
| `tests/canonical-runtime-cutover.test.js` | 変更 | validator 全 check key list に +2 |
| `package.json` | 変更 | scripts.test に `tests/refined-road-visual-surface.test.js` |
| `data/processed/osaka-city/derived/refined-road-surface.json` | 生成 | classMap 30,190 件 / 1.59MB |
| `public/map-data/osaka-city/derived/refined-road-surface.json` | 生成 | 配信コピー |
| `data/reports/refined-road-visual-surface.json` | 生成 | §21 report |
| `data/reports/refined-carriageway-overlap.json` | 生成 | §14 3 種比較監査 |
| `data/reports/refined-road-visual-surface-validation.json` | 生成 | validator 結果 |

production `osaka_3d_buildings.html` / protected `osaka_3d_buildings.fullward-v3.html` は **不変**（hash baseline 一致、`git diff --check` clean）。

---

**次工程へは進まず、Road Visual Surface 精密化のみ完了。ユーザー確認待ち。**
