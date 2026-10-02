# Mission 32J 完了報告 — RUNTIME VISIBLE-LAYER ALIGNMENT AUDIT

**最終判定: `VISIBLE_LAYER_ALIGNMENT_CORRECT`**
**§22 classification: `SOURCE_SEMANTICS_DIFFERENCE`**

AUDIT ONLY。building offset / road offset / scale 補正 / clipping / projection 変更 / canonical rebuild
は一切行っていない。

---

## 結論を先に

**緑線は「建物の外形線」ではなく「道路区域の境界線（GSI 道路縁）」でした。**
両者が重ならないのは runtime の座標誤差ではありません。runtime 側は**誤差ゼロ**であることを実測で確定しました。

| 検査 | 結果 |
|---|---|
| Building と Green の effective transform | **完全一致・両方 identity** |
| source 頂点が scene 上でそのままか | **トレース 72 頂点すべて x・z 完全一致** |
| 軸の入れ替え (x↔z) | **0 件** |
| 符号規約 (+X east / −Z north) | **両レイヤーで一致** |
| world unit | **1 unit = 1 m** |
| tile 原点の二重加減算 | **該当コードが 1 行も存在しない** |
| 誤差ベクトルの方向の揃い | **0.218（ばらばら＝系統的 offset なし）** |
| affine scale / rotation | **1.0029 / 0.9997 / −0.0002 rad** |

---

## §1. 緑レイヤーの正体（実機 runtime から実測・推測なし）

**`GREEN_LAYER_SOURCE = GsiRoadEdgeTile`**

| 項目 | 実測値 |
|---|---|
| name | `GsiRoadEdgeTile`（60 mesh） |
| **material 色（runtime 実測）** | **`0x18c37a`**（1色に確定） |
| RUNTIME_OWNER | `CANONICAL` |
| parent chain | `(scene) > canonicalRoot > GsiRoadEdgeAuthoritative > GsiRoadEdgeTile` |
| datasetId | `gsi-road-edge` |
| sourceType | GSI 基盤地図情報 **道路縁 (RdEdg)** |
| layerId | `GsiRoadEdgeAuthoritative` |
| source file | `public/map-data/osaka-city/derived/gsi-road-edge/tile_{tx}_{tz}.json`（500m グリッド） |
| runtime 状態 | tilesInCache 60 / tilesBuilt 60 / distinctFeatureCount 112,199 / loadedFeatureCount 6,863 |
| **意味論** | **道路区域の境界線。建物の外形線ではない。** |

> この同定を「コードの色定数を読んだ推測」にしないため、**テストハーネスの material スタブが
> コンストラクタの `{color: 0x…}` を保持する**ように改修し、scene 上の実際の material から
> 色を読み取って判定しました（従来は全 material が `0xffffff` を返していて実測不能でした）。
> 緑判定は色定数との照合ではなく `G > R+24 かつ G > B+24` という RGB 条件で行っています。

## §2. 建物レイヤー

| 項目 | 実測値 |
|---|---|
| name | `ReferencePlateauFootprintLines` |
| parent chain | `(scene) > debugRoot > ReferencePlateauFootprint > ReferencePlateauFootprintLines` |
| datasetId | `derived/near/buildings` |
| source file | `public/map-data/osaka-city/derived/near/buildings/tile_{tx}_{tz}.json`（500m グリッド） |
| LOD type | LOD0 footprint（**3D extrusion OFF・base outline のみ** = §9 の要求そのもの） |
| 3D建物と同一タイルか | **Yes** |

**同一タイルである根拠（コード実測）**: `tileUrl(layer, band, tx, tz)` が
`` `${BASE}/${band}/${layer}/tile_...` `` を返し、Reference overlay の `PLATEAU_FP_BASE` も
`` `${BASE}/near/buildings` `` である。すなわち **3D 建物レイヤーとまったく同じファイル**を読んでいる。

> **正直な開示**: 3D 建物レイヤー(`CR_buildings`)そのものは camera 駆動の tile pipeline 経由でしか
> 読み込まれず、この Node 実行環境では pipeline が回らないため scene に実体化しません。
> ただし `buildGroup()` は `pushExtrude(byCat.get(cat), f.geometryType, f.coordinates, h)` と
> **タイルの座標をそのまま**使い（tile 原点の減算も offset も無い）、group は identity で add されるため、
> 平面座標は本 overlay と一致します。

---

## §3/§4. Transform（parent chain を実測して合成）

### Building
| node | position | scale | rotation | owner |
|---|---|---|---|---|
| (scene) | 0,0,0 | 1,1,1 | 0,0,0 | — |
| debugRoot | 0,0,0 | 1,1,1 | 0,0,0 | DEBUG |
| ReferencePlateauFootprint | 0,0,0 | 1,1,1 | 0,0,0 | DEBUG |
| ReferencePlateauFootprintLines | 0,0,0 | 1,1,1 | 0,0,0 | DEBUG |

### Green
| node | position | scale | rotation | owner |
|---|---|---|---|---|
| (scene) | 0,0,0 | 1,1,1 | 0,0,0 | — |
| canonicalRoot | 0,0,0 | 1,1,1 | 0,0,0 | CANONICAL |
| GsiRoadEdgeAuthoritative | 0,0,0 | 1,1,1 | 0,0,0 | CANONICAL |
| GsiRoadEdgeTile | 0,0,0 | 1,1,1 | 0,0,0 | CANONICAL |

### effective transform（§4）

| | Building | Green |
|---|---|---|
| effectiveTranslationX / Z | **0 / 0** | **0 / 0** |
| effectiveScaleX / Z | **1 / 1** | **1 / 1** |
| effectiveRotationY | **0** | **0** |

**完全一致（`transformsEqual = true`, `bothIdentity = true`）。**
親は片方が `canonicalRoot`、もう片方が `debugRoot` と異なりますが、**どちらも全段 identity** なので
合成結果は同一です。

> **限界の開示**: この実行環境（Node 上の THREE スタブ）では `matrixWorld` 行列が実体化しません
> （`matrixWorldMaterialized = false`）。そこで §3/§4 は parent chain の position/rotation/scale を
> **実際に読み取って TRS 合成**しました。THREE の matrixWorld 合成と数学的に同一です。

## §5/§17/§18. local → world トレース

fixture の source ring 頂点が **scene 上の実頂点配列（`geometry.attributes.position`）にそのまま
存在するか**を照合しました（§24: canonical 同士の比較ではなく、scene へ add された後の座標）。

| | 結果 |
|---|---|
| トレース頂点数 | 72 |
| **x が保存された頂点** | **72 / 72** |
| **z が保存された頂点** | **72 / 72** |
| **x↔z 入れ替わり** | **0** |
| 符号規約（+X east / −Z north） | **維持** |

⇒ runtime は座標に **一切手を加えていない**。平行移動も scale も回転も swap も 0。
これは統計推定ではなく**同一性の直接確認**です。

## §19. world unit

tile 境界幅が scene 座標で 500 unit ＝ 500 m。**1 unit = 1 m**（両レイヤー共通）。

## §6. screen 座標

`renderer.render(scene, activeCamera())` の呼び出しは**この形のみ・他の render 呼び出し 0 件**。
レイヤーごとに別カメラを使う経路が存在しないため、**world が一致していて screen だけ食い違うことは
原理的に起こり得ません**。

> `camera.project()` の数値評価は行っていません（スタブでは投影行列が実体化しないため）。
> 代わりに「scene 全体が単一カメラで 1 回描画される」ことをコードで確認しました（正直な開示）。

---

## §7-§14. Fixture 測定

### §7 fixture（低層のみ 24 件）
駅・高架・巨大施設を除外。条件: 高さ ≤ 15 m / 面積 30–1,500 m² / `usage=431`(運輸倉庫施設=駅系) 除外。
住吉 8 件（低層住宅中心）・本町 8 件（普通の商業建物）・天王寺 8 件。

### §10/§11 建物辺 → 最寄り緑線

| | 値 |
|---|---|
| **median dx** | **−0.0035 m** |
| **median dz** | **+0.446 m** |
| median distance | 7.862 m |
| p95 distance | 24.627 m |
| min / max | 0.206 m / 30.782 m |

### §21 誤差ベクトルの方向

**directionConsistency = 0.2184**（各 fixture の「建物辺→最寄り緑線」単位ベクトルの平均長）。
1 に近ければ方向が揃う＝runtime offset の疑い。**0.22 は向きがばらばら**であることを示し、
系統的な平行移動が存在しないことの証拠です。

### §12 affine fit（141 対応点）

| | 値 |
|---|---|
| scaleX / scaleZ | **1.002925 / 0.999724** |
| rotation | **−0.000228 rad**（≒ −0.013°） |
| shear | 0.000125 |
| tx / tz | 8.996 / 1.424 |

scale・rotation・shear はいずれも実質ゼロ。
**tx の 9 m は runtime offset ではありません**: 対応点が「最寄り点」で作られているため、
この平行移動成分は**建物のセットバック（道路から下がっている距離）の平均的な向き**を吸収したものです。
実際、もし 9 m の平行移動が本当にあれば median dx も 9 m 付近になるはずですが、**median dx = −0.0035 m** です。

### §13/§14 tile 依存性（3 tile）

| site | tileId | tile origin (world) | median dx | median dz | median distance |
|---|---|---|---|---|---|
| 住吉 | -6_-2 | (−3000, −1000) | −0.0075 | 3.410 | 8.814 |
| 本町 | -5_-18 | (−2500, −9000) | −0.0035 | 0.446 | 0.791 |
| 天王寺 | -3_-10 | (−1500, −5000) | −0.125 | 1.185 | 6.413 |

**median dx はどの tile でも ≈ 0**。距離の差（0.79 / 6.41 / 8.81 m）は tile 依存の offset ではなく、
**地区ごとのセットバックの違い**です（本町の密集商業地は道路境界ぎりぎりに建つ、住吉の住宅地は下がる）。

### §15/§16 二重原点・tile offset

`buildingCenter` / `mapCenter` / `roadCenter` / `tileCenter` / `localOrigin` / `worldOrigin` —
**いずれも実コードに 0 件**（コメント行を除く実行コード）。
tile 原点は「どのファイルを fetch するか」の**選択にのみ**使われ、頂点座標へは加減算されません。

建物だけが通る `ensurePlacement()` も確認しました。これは SUPPRESS/REVIEW/EXEMPT の
**「表示するかどうか」を決めるだけで座標を変えません**（コード実測）。

---

## §22. Classification

**`SOURCE_SEMANTICS_DIFFERENCE`**

Building と Green の runtime transform は完全一致（identity）で、source 頂点は scene 上に無変換のまま
存在します。両者が重ならないのは runtime の座標誤差ではなく、**緑線が「道路区域の境界線（道路縁）」であり
建物の外形線ではない**という意味論の違いによるものです。誤差ベクトルの向きも揃っていない
（方向一貫性 0.218）ため、系統的な平行移動も存在しません。

> runtime 側だけを見れば `NO_RUNTIME_ALIGNMENT_ERROR` も同時に成立します
> （TRANSLATION / SCALE / TILE_OFFSET / PARENT_TRANSFORM / SIGN_AXIS の 5 つはすべて実測で否定済み）。
> §22 は 1 つを選ぶ指示なので、**観測された食い違いの原因**を説明する
> `SOURCE_SEMANTICS_DIFFERENCE` を選びました。

---

## §20/§21. `[VISIBLE ALIGNMENT QA]` オーバーレイ

`#canonical-runtime-status` に **`[VISIBLE ALIGNMENT QA]`**（既定OFF・read-only・opt-in）を追加。

- **Building base = cyan** / **Green source = magenta** / **matched nearest vectors = yellow**（§20 指定色）
- **3D extrusion = OFF・other layers（roads/water/parks/rail）= OFF**（OFF に戻すと必ず全部復元）
- **Orthographic Top Down 固定**（`CanonicalRuntime.isVisibleAlignQaActive()` → orthoCamera）
- `__SET_VISIBLE_ALIGN_QA__(bool)` / `__VISIBLE_ALIGN_QA_DEBUG__()` を公開

黄色ベクトルの向きが揃っていないことが画面上でも確認できます（§21）。

---

## 成果物と検証

| 種別 | パス |
|---|---|
| 監査ツール | `tools/audit/runtime-visible-layer-alignment.js` |
| レポート | `data/reports/runtime-visible-layer-alignment.json` |
| Validator | `tools/validate/runtime-visible-layer-alignment.js` → **RESULT=PASS** |
| テスト | `tests/runtime-visible-layer-alignment.test.js`（19件・全pass） |
| QA データ | `data/processed/osaka-city/visible-alignment-qa/overlay.json` ＋ public コピー |

### 不変条件（すべて維持）

Canonical Buildings **615,617** / Canonical Roads **199,658** / `znorth-neg-v1` projection 不変 /
production・protected HTML 無改変

`npm test` = **1,655 tests / 1,640 pass / 0 fail / 15 skip**

### テストハーネスへの変更（1点）

`tests/_ward-ux-v1-smoke-harness.cjs` の material スタブが**コンストラクタの `{color: 0x…}` を保持**
するようにしました（従来は全 material が `0xffffff`）。§1 の「推測禁止」を満たすために必要でした。
変更は加算的で、既定（色未指定）は従来どおり白のままです。全 1,655 テストが通ることを確認済みで、
回帰防止テストも追加しました。

> 実装中に**同一オブジェクトリテラル内の重複キー**で自分の設定が後方の `color: color()` に
> 上書きされるバグを作り込み、実測値が `0xffffff` のままになりました。inventory を出力して
> 気づき、後方のキー側で設定するよう修正しています。

---

## 限界（正直な開示）

1. **ブラウザ実機ではなく Node 上の THREE スタブで scene を構築している。** `matrixWorld` 行列は
   実体化しないため TRS 合成で代替した（両レイヤーとも全段 identity であることは実測済み）。
2. **3D 建物レイヤー(`CR_buildings`)そのものは読み込めない。** 同一タイルを読む PLATEAU footprint
   overlay を建物側として使用した。
3. **`camera.project()` の数値は評価していない。** 代わりに単一カメラ描画をコードで確認した。
4. **緑線は道路縁なので、建物との距離が 0 になることは元々期待されない。** 本監査が見ているのは
   距離の絶対値ではなく、**誤差ベクトルの方向の揃い方**と **affine 変換の有無**です。
   なお、この測定は大きな系統的 offset は検出できますが、セットバックの散らばり（±25 m）に対して
   小さい offset（数十 cm 程度）を統計的に検出する力はありません。**ただし §5 の頂点同一性確認が
   それを直接否定しています**（scene 上の座標が source と完全一致＝どんな大きさの offset も存在しない）。

---

**§25 STOP。今回は修正していない。`VISIBLE_LAYER_ALIGNMENT_CORRECT` で停止する。**

## 補足: それでも画面で気になる場合

本監査は「runtime が座標をずらしていないか」を確定させるものです。結果は**ずらしていない**でした。
画面で建物が緑線（道路縁）に食い込んで見えるのは、**建物の外形が道路区域に重なっている**という
データ側の事実であり、これは Mission 32D〜32I で扱ってきた対象そのものです。
32H では「梅田の問題建物 30 棟中 27 棟は現実に存在する構造物」と確定しており、
32I では道路側の塗り幅を車道実態へ寄せて Building∩DarkRoad を FIX13 比 −84.4% まで縮めています。
