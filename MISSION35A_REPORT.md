# MISSION 35A — UMEDA INFERRED ROOF LOD2 PoC

**判定: `UMEDA_INFERRED_ROOF_POC_SUCCESS`**

先に結論を 4 行で:

- **梅田の LOD1 のみ 615 棟のうち、推定屋根を作れたのは 1 棟だけ**でした。残り 614 棟は LOD1 のままです。
- 理由は**パイプラインではなく証拠**です。**リポジトリ内に航空写真は 0 件**、OSM の `roof:shape` は梅田の ground truth 678 棟のうち **10 棟（1.5%）**しか覆わず、しかも梅田で支配的な**平屋根の細分（塔屋あり / 段差あり）を区別できません**（HIGH 4 件の exact 一致 **0/4**）。
- §6/§32 のとおり、**証拠が無い棟を LOD1 のまま残したこと自体が成功条件**です。「全部 LOD2 相当にする」ことはしていません。
- **実 PLATEAU LOD（LOD2 10,208 / LOD3 15）は 1 棟も変えていません**。footprint・canonicalId・projection の変更は 0。production / protected とも未変更、cutover もしていません。

> **§13 の品質目標（屋根タイプ正答率 85%）は満たせていません**（HIGH のみで exact 0%、family 100%）。これは隠すべきことではなく、**満たせないから生成しなかった**という設計どおりの結果です。`data/reports/umeda-inferred-roof-validation.json` の `qualityGate.met: false` に記録しています。

---

## 1. 何を対象にしたか（§3）

梅田（`x=-2668, z=-10942, r=700m`）の canonical 建物を全部数えて、**PLATEAU 実データで LOD1 しか無い棟だけ**を対象にしました。

| 区分 | 棟数 | 扱い |
|---|---|---|
| canonical PLATEAU 建物 | 1,292 | — |
| ├ 実 LOD2 / LOD3 を持つ | **677** | **対象外**（実物が優先 §23） |
| └ **LOD1 のみ** | **615** | **← PoC の対象** |
| OSM fallback | 381 | 対象外（§3） |
| LandmarkHD | 0 | 梅田には配置なし |

対象 615 棟はすべて PLATEAU の `measuredHeight` を持っています（`heightSources: {plateau: 615}`）。用途は office 327 / commercial 156 / public 63 / industrial 20 ほか。

## 2. 使える証拠を全部数えた（§4/§5）

§4 の優先順位は「航空写真 > PLATEAU 属性 > footprint > 高さ > 階数 > 用途」です。上から順に実在を確認しました。

| 証拠 | 実測 | 屋根形状を決められるか |
|---|---|---|
| **航空写真 / orthophoto** | **0 件** | — |
| GSI 基盤地図情報 建築物外周線（梅田） | 1,872 本（閉合 1,590） | **✗**（後述） |
| OSM 屋根タグ（大阪市全域 / 梅田） | 2,427 / **37** | △ 一部だけ |
| └ うち `roof:shape`（梅田） | **26**（flat 12 / gabled 9 / skillion 1 / dome 4 / round 1） | △ |
| └ うち `roof:orientation`（大阪市全域） | 488 | 勾配屋根の棟方向に必須（§18） |
| PLATEAU 属性（高さ・階数・用途） | 615 棟すべて | **✗**（§4 で禁止） |

### 2-1. 航空写真は 1 枚も無い

`data/` `public/` 配下の画像 224 件はすべて過去ミッションの QA スクリーンショットで、`data/reports/` 配下です。これらを除外して走査した結果、**航空写真・orthophoto は 0 件**でした。ネットワーク取得はこのサンドボックスでは不可です（過去ミッションと同じ制約）。

**§5 が「航空写真を第一の証拠にする」としている以上、この PoC は最初から主証拠を欠いた状態で走りました。** これが結果のすべてを説明します。

### 2-2. GSI 外周線には屋根タイプの情報が無い（実測）

「航空写真からトレースされた屋根の外縁」なので使えるかと思い、ground truth 678 棟に対して外周線の本数を測りました。

| 実 LOD2 の屋根タイプ | 平均外周線数 | 「2 本以上」の割合 |
|---|---|---|
| GABLE | 1.42 | 10.7% |
| MULTI_LEVEL_FLAT | 1.05 | 5.9% |
| FLAT | 0.99 | 6.0% |

**どの屋根タイプでもほぼ 1 棟 1 本**で、段差や棟の情報は入っていません。GSI 外周線は屋根形状の証拠として**使えない**と結論しました。

### 2-3. 高さ・階数・用途からは決めない（§4）

対象 615 棟は全部が信頼できる高さを持っていますが、**高さ・階数・用途だけから屋根形状を決めることは §4 で明確に禁止**されています。実装でもその経路を作っていません。`tools/lib/umeda-roof-inference.js` の `inferRoof()` は、証拠が無ければ高さがいくつでも `UNKNOWN` を返します。テストで固定しています:

- 「35A §4 高さ・階数・用途だけでは屋根タイプを決めない」（6m / 31m / 120m のどれも UNKNOWN）
- 「35A §4 細長い footprint でも形の証拠が無ければ GABLE にしない」（縦横比 10 の footprint でも UNKNOWN）

## 3. 実 LOD2 678 棟を ground truth にした（§10/§11）

梅田の**実 PLATEAU LOD2 の屋根面から**屋根タイプを判定し、正解データを作りました。**実 LOD2 の geometry は推定側へ 1 バイトも渡していません**（§10）。推定へ渡したのは LOD1 の footprint・高さ・用途・OSM タグだけです。

| 屋根タイプ | 棟数 | 割合 |
|---|---|---|
| **FLAT_WITH_PENTHOUSE**（塔屋あり平屋根） | **280** | 41.3% |
| **FLAT** | **186** | 27.4% |
| **MULTI_LEVEL_FLAT**（段差あり平屋根） | **119** | 17.6% |
| GABLE | 31 | 4.6% |
| SHED | 26 | 3.8% |
| HIP | 25 | 3.7% |
| COMPLEX | 11 | 1.6% |
| 合計 | **678** | |

**梅田の屋根の 86.3% は平屋根系**で、その中の区別（そのまま平 / 塔屋がある / 段差がある）が本質的な課題だと分かりました。

分割は層化ランダム（屋根タイプ × 高さ帯 × 面積帯 = 67 層、seed 固定）で train 477 / validation 201（29.6%）です。同じ seed なら同じ分割になることをテストで固定しています。

## 4. 推定の精度を測った（§12/§13）→ **目標未達**

ground truth 678 棟に対し、「LOD1 + 手元の証拠」だけで推定させました。

| | 全 678 | validation 201 |
|---|---|---|
| 証拠あり（`osm-roof-shape`） | 10 | — |
| 証拠が形に届かない（`osm-roof-metrics-only`） | 6 | — |
| **証拠なし（`NO_ROOF_EVIDENCE`）** | **662** | — |
| 判定できた棟 | 16 | **3（coverage 1.49%）** |
| exact 正答率 | — | 33.3%（1/3） |

**HIGH 信頼度だけに絞った 4 件:**

| 正解 | 推定 | 件数 |
|---|---|---|
| MULTI_LEVEL_FLAT | FLAT | 2 |
| FLAT_WITH_PENTHOUSE | FLAT | 2 |

- **exact 正答率 0/4（0%）**
- family 正答率 4/4（100%）— 平屋根系であることは当てている

| §13 の目標 | 実測 | 判定 |
|---|---|---|
| 屋根タイプ正答率 ≥ 85% | **0%**（HIGH のみ） | **✗** |
| 棟方向の中央誤差 ≤ 10° | 測定不能（勾配屋根の HIGH が 0 件） | — |
| 屋根 footprint IoU 中央値 ≥ 0.85 | 測定不能 | — |

**原因ははっきりしています。** OSM の `roof:shape=flat` は「上から見て平らか」であって、**塔屋の有無も段差の有無も表現しません**。梅田の平屋根 585 棟のうち 2/3（塔屋 280 + 段差 119）はこの区別が要るのに、OSM タグでは原理的に届きません。§16/§17 が「塔屋・段差は航空写真で確認できる場合のみ」としているとおりです。

## 5. 生成結果（§14〜§21）

| | 棟数 |
|---|---|
| 対象 | **615** |
| 証拠なし（`NO_ROOF_EVIDENCE`） | 599 |
| 証拠が形に届かない | 6 |
| `osm-roof-shape` あり | 10 |
| **実際に geometry を作った** | **1** |
| FLAT と判定 → LOD1 の上面のまま（§19） | 2 |
| MEDIUM のため生成せず（§9） | 2 |
| guard で reject | **0** |

推定した屋根タイプの内訳は UNKNOWN 609 / FLAT 4 / GABLE 1 / COMPLEX 1。信頼度は LOW 610 / HIGH 3 / MEDIUM 2 です。

### 5-1. 作った 1 棟

```
canonicalId              cg_bldg_bldg_06d445e4-816f-4666-be0a-3ac25a90f2b2
geometrySource           PLATEAU_LOD1        ← 土台は LOD1。実 LOD2 のコピーではない
representation           INFERRED_ROOF       ← PLATEAU_LOD2 とは別語
roofSource               OSM-roof-tags
roofInferenceMethod      osm-roof-shape+footprint-obb
roofInferenceConfidence  HIGH
roofType                 GABLE
generationVersion        35A.1
ridgeDeg                 111.9°   ← OSM roof:orientation から。長辺の決め打ちではない（§18）
totalHeightM  7.40   wallTopY 4.84   ridgeY 7.40   roofHeightM 2.56   slopeDeg 30
```

**全高 7.40m は canonical のまま**です。屋根を「載せた」のではなく、**壁を 4.84m まで下げて、その上に 2.56m の切妻を置いて合計を 7.40m に保って**います（§15）。

geometry は頂点 22 / 三角形 14（屋根 6 + 壁 8）。**LOD1 の箱を消す以上、壁もこちらで出します**（下の不具合 #4）。頂点の y は 0 / 4.84 / 7.40 の 3 値だけで、最高点は canonical の全高と完全に一致します。

### 5-2. 作らなかった理由の内訳（§6）

`decisions.json` に 615 棟すべての判断を残しています。例:

| canonicalId（抜粋） | roofType | confidence | 作らなかった理由 |
|---|---|---|---|
| `…e3dccd75…` | FLAT | HIGH | `FLAT_KEEPS_LOD1_TOP`（§19 平屋根は LOD1 の上面のままが正しい） |
| `…c2c59411…` | FLAT | MEDIUM | `CONFIDENCE_MEDIUM`（§9 通常表示は HIGH のみ） |
| 599 棟 | UNKNOWN | LOW | `CONFIDENCE_LOW` / `NO_ROOF_EVIDENCE`（§6） |

`__INFERRED_ROOF_INSPECT__(canonicalId)` はこの理由をそのまま返します。

### 5-3. geometry の拘束（§14/§15/§30）

`guardRoof()` が全頂点について次を確認し、1 つでも破れば**作らずに捨てます**。

- footprint の外へ出ていない（許容 0.01m）
- 0 ≤ y ≤ canonical の全高
- 屋根高が全高の 35% 以下、かつ 0.8〜12m、勾配 8〜60°

**今回 guard で捨てたものは 0 件**です（下の「自分の不具合」で直した後の値）。

## 6. 実ブラウザでの確認（§23/§24/§27/§28/§29/§31）

`tools/audit/umeda-inferred-roof-qa.js`（Edge headless / 実 GPU、`npm run preview`）。

| 確認項目 | 結果 |
|---|---|
| §24 推定屋根を出した棟の LOD1 の箱が消えているか | **OK**（真上からの ray でヒット 0） |
| §24 その棟をクリックして card が出るか | **OK** |
| §27 クリック診断が「推定」と返すか | **OK**（`inferred: true`） |
| JS 例外 | **0 件** |

### 6-1. 3 モード比較（同一カメラ）

| モード | 推定屋根 | 実 LOD2 | 建物総数 | スクリーンショット |
|---|---|---|---|---|
| LOD1 ONLY | 0 | 0 | 15,952 | `data/reports/umeda-inferred-roof/mode-lod1.jpg` |
| REAL MAX LOD | 0 | 1,070 | 15,952 | `…/mode-real.jpg` |
| **REAL + INFERRED** | **1** | 1,070 | 15,952 | `…/mode-real-inferred.jpg` |

実 LOD2 の数が 3 モードで動いていないこと（0 → 1,070 → 1,070）が、**推定が実物を侵食していない**ことの実測です。

### 6-2. 性能（20 秒計測 / 梅田中心 r=700）

| モード | 平均 FPS | 下位 5% | frame p95 | 三角形 | draw call |
|---|---|---|---|---|---|
| LOD1 ONLY | 59.7 | 59.2 | 16.9ms | 348,686 | 229 |
| REAL MAX LOD | 52.3 | 29.9 | 33.5ms | 378,036 | 227 |
| **REAL + INFERRED** | **52.2** | 29.9 | 33.5ms | 378,040 | 228 |

**推定屋根による性能劣化はありません**（1 棟 14 三角形なので当然です）。

### 6-3. 見た目

俯瞰 10 地点は `data/reports/umeda-inferred-roof/visual-*.jpg` ですが、**7m の棟は俯瞰では点にしかなりません**。形が見える距離（r=55m / 俯角 38°）で、同一カメラから 2 方位 × 3 状態を撮りました。

| 状態 | 方位 A | 方位 B |
|---|---|---|
| LOD1 ONLY（平らな箱） | `closeup-lod1-th035.jpg` | `closeup-lod1-th12.jpg` |
| REAL + INFERRED（通常色） | `closeup-inferred-th035.jpg` | `closeup-inferred-th12.jpg` |
| REAL + INFERRED（QA 色） | `closeup-qa-th035.jpg` | `closeup-qa-th12.jpg` |

方位 B の 3 枚を並べると、**同じ footprint・同じ全高のまま、平らな上面が切妻に変わっている**ことが直接見えます。壁は地面に接しており、浮いていません。

§26 の QA 色（実 LOD3 金 / 実 LOD2 青 / 推定 HIGH 緑 / 推定 MEDIUM 橙 / LOD1 灰）は **dev の `QA色` ボタンのときだけ**です。通常表示では推定屋根も LOD1 と同じ用途色で、**色で「推定です」と主張しません**（§1 は「LOD2 と偽らない」であって「目立たせる」ではないため）。

## 7. 実 LOD・canonical を壊していないことの確認（§35）

`tools/validate/umeda-inferred-roof.js` → `data/reports/umeda-inferred-roof-validation.json`

| 項目 | 結果 |
|---|---|
| `realLodUnmodified` | **true**（LOD2 10,208 / LOD3 15 / 計 10,223 のまま） |
| `fabricatedPlateauLod2` | **false**（推定の棟は高 LOD データセットに 1 件も無い） |
| `inferredRoofClearlySeparated` | **true**（別 namespace・別表示名・provenance 完備） |
| `canonicalIdMutation` | **0**（canonical 600,764 のまま） |
| `footprintMutation` | **0**（推定側の footprint は canonical と 0.01m 以内で一致） |
| `projectionMutation` | **0**（`local-equirectangular` / 34.604208 / 135.52502 / 111320） |
| `highConfidenceOnlyForNormalDisplay` | **true** |
| `productionModified` | **false** |
| `protectedModified` | **false** |
| 屋根が footprint の外へ出た頂点 | **0** |
| 全高を超えた頂点 | **0** |

## 8. 「実物」と「推定」を絶対に混同しないための作り（§1/§22）

| 区分 | 表示名 | 置き場所 |
|---|---|---|
| REAL | `PLATEAU_LOD3` / `PLATEAU_LOD2` | `map-data/.../building-lod-high/` |
| **ESTIMATED** | **`INFERRED_ROOF`** | **`map-data/.../derived-umeda-inferred-roof/`** |
| BASE | `PLATEAU_LOD1` / `OSM_FALLBACK` | canonical タイル |

- manifest に `warning: "これは推定であり、PLATEAU の実 LOD2 ではない。UI で LOD2 と称してはならない（§1）。"` を入れています。
- `__INFERRED_ROOF_INSPECT__()` は実物をクリックすれば `PLATEAU_LOD2` / `PLATEAU_LOD3`、推定なら `INFERRED_ROOF` と**必ず言い分けます**。
- **UI に「LOD2」と出す経路はありません。**
- 全 8 項目の provenance（canonicalId / geometrySource / roofSource / roofSourceDate / roofInferenceMethod / roofInferenceConfidence / roofType / generationVersion）をテストで固定しています。

## 9. 自分の不具合を 3 件見つけて直しました

| # | 症状 | 原因 | 是正 |
|---|---|---|---|
| 1 | 梅田の GSI 外周線が **0 本**と報告された | 読み取りで `ln.coordinates` を見ていた。実際の形は `ln.geometry.coordinates` | 正しく読み直し → **1,872 本**。結論（屋根タイプの証拠にならない）は変わらず |
| 2 | 唯一の GABLE 候補が `roof-outside-footprint` で guard に弾かれた | 棟の端点を OBB の端に置いていた。非凸な footprint では建物の外になる | `clampInside()` で端点を中心方向へ寄せ、0.2m 以上内側に入るまで詰める。入らない場合は `ridge-cannot-fit-inside-footprint` として**作らない** |
| 3 | **推定屋根を出しても LOD1 の箱が消えなかった**（二重表示） | タイル再構築に `invalidateLandmarkHdTiles()` を使っていた。この関数は**HD ランドマークが 0 件だと何もせず返る**。梅田は 0 件 | 推定屋根がある 500m タイルを自前で集め、`invalidateBuildingTiles()` を呼ぶよう変更。実ブラウザで `lod1StillDrawn: false` を確認 |
| 4 | **#3 を直したら、今度は屋根だけが宙に浮いた** | `buildSlopedRoof()` は屋根面しか作らない（軒と棟だけ）。LOD1 の箱を消した以上、壁 0→軒 も自前で出す必要があった | `buildWalls()` / `mergeGeometry()` を追加し、footprint をそのまま立ち上げた壁を同じ geometry に入れる。壁にも guard を通す |

**#3 も #4 も、実ブラウザで近接して見なければ見つかりませんでした。** #3 は抑制カウンタ（`suppressed: 1`）が正しく増えていたためコード上は正常に見え、#4 は俯瞰スクリーンショット（200〜700m）では 7m の棟が点にしかならず気付けませんでした。そのために `tools/audit/umeda-inferred-roof-closeup.js` を足しました。

また、既存テスト 2 件が `html.slice(s, s + 2600)` という**固定バイト幅**で buildings branch を切っており、35A の 6 行を足したことで窓の外に出て落ちました。窓を広げるのではなく「次の `} else if (layer ===` まで」で切るよう直し、意図（SUPPRESS は mesh にも pick にも入れない 等）はそのまま保っています。

## 10. テスト

`tests/umeda-inferred-roof.test.js`（41 件、`npm test` に登録済み）。

- §4 高さ・階数・用途・細長さから屋根形状を決めない
- §6 証拠なし → `NO_ROOF_EVIDENCE` で `UNKNOWN`
- §18 `roof:shape=gabled` でも `roof:orientation` が無ければ `UNKNOWN`
- §9 footprint 一致 IoU による HIGH / MEDIUM / LOW
- §21 COMPLEX は自動生成しない
- §14/§15/§30 footprint の外へ出ない / 全高を超えない / 非凸 footprint で作れないなら作らない
- §24 壁が地面から軒まで入っている（屋根だけを宙に浮かせない）
- §10/§11 実 LOD2 からの分類、層化分割の再現性
- §23 判定順（実 LOD が先、推定が後）
- §24 `invalidateBuildingTiles` を使っている（`invalidateLandmarkHdTiles` に頼らない）
- §33 production に推定屋根が入っていない

**`npm test`: 1,955 tests / fail 0。**

## 11. この PoC で分かった「次に何を取れば進むか」

§5 のとおり航空写真が主証拠ですが、今はそれがありません。**具体的に何を取れば良いか**を書きます。

| 必要なもの | 具体的に | なぜ必要か |
|---|---|---|
| **① 正射画像（オルソ）** | 地理院タイル `seamlessphoto`（ズーム 18、解像度 ≈0.6m/px）または大阪市の航空写真オルソ | 屋根の外縁・棟の向き・塔屋の有無を見るための最低線 |
| **② 高解像度オルソ** | 0.1〜0.25m/px | **塔屋（280 棟）と段差（119 棟）の判別に必須**。0.6m/px では 3m 角の塔屋が 5px しかなく判別できない |
| **③ 撮影日** | 画像ごとのメタデータ | `roofSourceDate` を埋めるため（今は `null`） |
| ④（あれば）DSM / 点群 | 航空レーザ測量の DSM | 段差の高さを直接測れる。①②より強い証拠 |

**取得順の推奨: ② → ③ → ④。** ① だけでは平屋根の細分に届かず、今回と同じ結果（family は当たるが exact は当たらない）になります。

なお、取得はこのサンドボックスからはできません。ローカル PC / GitHub Actions 側での実行をお願いします。

## 12. 成果物

**新規ツール**

| ファイル | 役割 |
|---|---|
| `tools/audit/umeda-roof-evidence.js` | 証拠の棚卸し（航空写真・GSI・OSM タグ・PLATEAU 属性） |
| `tools/audit/umeda-roof-groundtruth.js` | 実 LOD2 678 棟から正解データ、層化分割 |
| `tools/lib/umeda-roof-inference.js` | 推定の純粋関数（`inferRoof` / `evaluate`） |
| `tools/audit/umeda-roof-evaluate.js` | 精度測定 |
| `tools/build-umeda-inferred-roof.js` | 生成（guard 付き） |
| `tools/audit/umeda-inferred-roof-qa.js` | 実ブラウザ QA |
| `tools/audit/umeda-inferred-roof-closeup.js` | 近接ショット |
| `tools/validate/umeda-inferred-roof.js` | §35 の検証 |
| `tests/umeda-inferred-roof.test.js` | 41 件 |

**データ**

- `data/processed/osaka-city/derived-umeda-inferred-roof/` と `public/map-data/osaka-city/derived-umeda-inferred-roof/`
  （`inferred-roofs.json` / `decisions.json` / `manifest.json`）

**レポート**

- `data/reports/umeda-roof-evidence.json`
- `data/reports/umeda-roof-groundtruth.json`
- `data/reports/umeda-roof-evaluation.json`
- `data/reports/umeda-inferred-roof-build.json`
- `data/reports/umeda-inferred-roof-qa.json`
- `data/reports/umeda-inferred-roof-closeup.json`
- `data/reports/umeda-inferred-roof-validation.json`
- スクリーンショット `data/reports/umeda-inferred-roof/`

**dev ランタイム**（`public/osaka_3d_buildings.ward-ux-v1.html` のみ）

- `InferredRoofLayer`（`canonicalRoot` 配下）
- `[INFERRED ROOF]` / `QA色` ボタン
- `window.__UMEDA_ROOF_MODE__('lod1' | 'real' | 'real+inferred')`
- `window.__INFERRED_ROOF_INSPECT__(canonicalId)`

## 13. やらなかったこと（§25/§26/§33/§37）

- **production へ cutover していません。** `public/osaka_3d_buildings.html` の SHA-256 は、最後に承認されたビルドの記録（`data/reports/production-cutover-build.json`）と**一致**しています（`21561f27acd37bef…`）。`git status` に出る差分は 32U の承認済み cutover 由来で、35A では 1 バイトも触っていません。
- `public/osaka_3d_buildings.fullward-v3.html`（protected）も未変更（`git status` 差分なし）。
- production HTML に `INFERRED_ROOF` / `derived-umeda-inferred-roof` の文字列は 1 つも入っていません（テストで固定）。
- **堂島 / 中之島 / 本町 / 難波 / 新大阪 / 大阪 24 区へ展開していません**（§37）。
- 実 LOD2 の geometry を推定へコピーしていません（§10）。
- AI に 3D geometry を作らせていません。AI は使っていません（§8 の許可範囲は屋根タイプ分類のみで、今回は OSM タグと footprint の決定的処理だけで完結）。
- 建物の位置・footprint・高さ・canonicalId を変えていません。

---

**次の指示をお待ちします。**

判断が必要なのは「**高解像度オルソを取りに行くか**」です。取れれば塔屋 280 棟・段差 119 棟という梅田で最も多い形に手が届きます。取らずに今の証拠のまま範囲だけ広げても、他の区でも同じ結果（ほとんど `NO_ROOF_EVIDENCE`）になります。
