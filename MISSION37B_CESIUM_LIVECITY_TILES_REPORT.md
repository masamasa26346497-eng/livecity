# Mission 37B — CesiumJS × Live City 既存タイル POC レポート

> **重要（事実区分）**: 本レポートを作成した Claude Code 実行環境にはブラウザ・GPU・ネットワークがなく、
> また `node` スクリプトの実行も許可されていなかったため、**FPS・初期ロード時間・メモリは未計測**です。
> 下記「静的に確定している値」は既存 manifest から読み取った実値、「要実測」はブラウザで
> POC ページを開いて HUD / `window.__mission37b` から記入する欄です。推測値は記載していません。
> また POC ページ自体もこの環境では**ブラウザ実行による動作確認をしていません**（コード静的記述のみ）。

## 実装方式
- ページ: `public/mission37b-livecity-cesium-tiles.html`（単独ファイル。CesiumJS 1.121.1 を jsDelivr から読込）
- 方式: **ブラウザで既存 tile JSON を fetch → `GeometryInstance(PolygonGeometry 押し出し)` → 1 tile = 1 `Primitive`**
  （最短で表示できる方式。事前 3D Tiles 変換はしていない）
- 3D Tiles 化への足場: tile 単位 Primitive なので「1 tile = tileset の 1 content」に 1:1 対応でき、
  `id`（canonicalId）も instance 単位で保持している。
- 座標: `geoToThree()` の厳密な逆変換（CLAT=34.604208 / CLON=135.525020 / 111320 m/deg、北=-Z）。投影定数は変更していない。
- 不使用: Google Map Tiles API / Photorealistic 3D Tiles / Cesium ion。APIキー不要。
  背景は OSM ラスタ（キー不要。`?imagery=0` で無効化可）。
- 既存データは**コピーしておらず**、`public/map-data/osaka-city/buildings/osaka-sumiyoshi/` を直接参照。

## 使用エリア
- 住吉区（`osaka-sumiyoshi`）の最密 3×3 tile ブロック: `tx -6..-4, tz -3..-1`
  （ローカル x: -3000..-1500 m, z: -1500..0 m、tileSize 500m）
- URL パラメータ `?tx0=&tx1=&tz0=&tz1=&dataset=` で変更可能。
- カメラ初期位置固定: ブロック中心注視 / heading 0（北上）/ pitch -45° / range 1500 m。「カメラ初期位置に戻す」ボタン付き。

## 静的に確定している値（manifest の count 合計）
| 項目 | 値 |
|---|---|
| 使用建物数 | **10,546 棟** |
| タイル数 | **9** |
| Primitive 数（設計上） | 9（1 tile = 1 Primitive） |
| 参考: 住吉区全体 | 35,031 棟 / 52 tile |
| 参考: 大阪市全体 | 574,213 棟 / 1,097 tile |

## 要実測（ブラウザで記入）
| 項目 | 値 |
|---|---|
| 初期ロード時間 | 未計測（HUD「初期ロード時間」/ fetch・Primitive ready の内訳あり） |
| FPS（平均/最小/最大） | 未計測 |
| draw call 相当 | 未計測（Primitive 数 = 9 が opaque 描画コマンドの下限目安。実数は Cesium Inspector 等で確認） |
| JS heap | 未計測（Chrome のみ HUD に表示） |
| canonicalId クリック | 実装済み（`scene.pick` → `GeometryInstance.id` を HUD/console に表示、橙ハイライト）。**実機クリック確認は未実施** |

計測手順: Chrome でサーバ経由（例 `npx serve public` / `python3 -m http.server -d public`）で
`/mission37b-livecity-cesium-tiles.html` を開く。ready 後 `window.__mission37b` に全指標が入る。
同一カメラ・同一ブロック（Three.js 版は同じ中心 x=-2250, z=-750）で比較すること。

## メモリ上の注意（設計上の見立て・未検証）
- `releaseGeometryInstances:false`（ハイライトの色変更に属性参照が必要）のため、instance/頂点配列が JS 側に残る。
  大規模化する場合は `true` にしてハイライトを別 Primitive で行う必要がある。
- 全棟を押し出しメッシュとして常時 GPU に保持するため、市全域（57万棟）の一括ロードは不可。タイル単位の読込/破棄が必須。

## Three.js 版との比較（コードから言える範囲）
メリット
- カメラ・地球座標系・ズーム操作・ピッキング基盤が既製（独自 OrbitControls 不要）。
- Primitive バッチ + WebWorker でのジオメトリ生成により、メインスレッドの生成コストを下げられる余地がある。
- 3D Tiles への移行経路があり、距離ベース LOD/SSE 制御を標準機能に寄せられる。
デメリット
- 既存の Live City 固有機能（LOD、ハイライト、写真カード、ラベル、ward-mode 等）は未移植で、POC は建物押し出しのみ。
- 現状は独自タイルローダー（距離 LOD/破棄制御なし）。ブロック全体を一度に読む。
- Cesium ランタイム（サイズ未計測）を追加で読込む。
性能の優劣は**未計測のため断定しない**。

## 大阪全域への拡張で 3D Tiles に変換すべきか
計測前の暫定見解: 57万棟規模では、ブラウザ側 JSON→Primitive 変換のままだと読込/メモリが厳しい可能性が高く、
3D Tiles（タイル単位、`canonicalId` を feature table/batch table に格納）への事前変換が妥当と考える。
ただし最終判断は、本 POC の実測（ロード時間・FPS・heap）を踏まえて行うこと。

## 次段階（PR #24 追加分）— 比較・拡張検証

> 事実区分: 追加実装は静的記述のみで、この環境ではブラウザ実行・計測ができていません。実測欄は `mode=all` と fixed のみユーザー報告値で埋まり、dynamic は未取得です（下記「実測反映と結論」）。

### (1) canonicalId クリック
- `scene.pick` → `picked.id`（`GeometryInstance.id` = tile JSON の `building.id`、実データで `bldg_<uuid>` 形式を確認）。
- 受理条件を `typeof string` かつ `/^bldg_/` に限定（診断用の赤枠 Entity 等を誤認しない）。
- 動的破棄で Primitive が destroy 済みの場合にハイライト復元が例外を出さないようガード追加。
- 実機クリック結果: `?mode=all` で正常取得を確認（`bldg_1359ed60-60d5-47dc-863e-64d0f41635c0`、ユーザー報告）。

### (2) 計測（HUD）
- HUD に「10秒FPS計測」ボタンを追加。10 秒間の平均 FPS・p95/最大フレーム時間・heap を `__mission37b.measure` に保存。
- 既存の初期ロード（fetch/parse と Primitive ready の内訳）、建物数、Primitive 数、タイル数は HUD に表示。
- 参考: Vercel 実機の前回報告値 = 建物 10,546 / 9 tile / Primitive 9 / 初期ロード約 10.0 s / FPS 平均約 31.3（ユーザー提供値）。

### (3) 動的タイルロード/破棄（最小 POC）
- `?mode=dynamic&r=1`: 画面中心の地表点（取れなければカメラ直下）→ ローカル m → `floor(x/500), floor(z/500)` で注視 tile を決定。
  Chebyshev 距離 `r` 以内をロード、`r+1` 超を `primitives.remove`（destroy）で破棄（ヒステリシス 1）。
- 更新契機: `camera.moveEnd` と 2 秒周期。重複ロード防止（`pending` セット）、実行中は再入しない。
- ログ: `__mission37b.dynLog`（ロード tile 数・所要 ms・現在 tile/建物数）、`tilesLoadedTotal / tilesUnloadedTotal`。
- 制約: 破棄済み tile の JSON は再取得（HTTP キャッシュ依存）。空・水域などで注視点が地表に当たらない場合はカメラ直下を使う。

### (4) 住吉区全域
- `?mode=all`: manifest の全 52 tile / 35,031 棟を一括ロード。カメラは読込範囲から自動フィット。
- 計測手順: `?mode=all` を開く → ready 後に HUD の初期ロード時間、「10秒FPS計測」、`__mission37b` を記録。

### 実測記入欄（要ブラウザ。同一端末・同一カメラで）
| 構成 | 建物 | tile | 初期ロード | 平均FPS | p95 frame | heap |
|---|---|---|---|---|---|---|
| fixed 3×3（既定） | 10,546 | 9 | 約10.0 s（ユーザー報告） | 約31.3（同） | 未計測 | 未計測 |
| dynamic r=1 | 要実測 | 最大9 | 要実測 | 要実測 | 要実測 | 要実測 |
| all（住吉区全域） | 35,031 | 52 | **14,013 ms**（fetch/parse 2,978 + Primitive ready 11,035） | **8.3**（10秒計測）/ HUD 1s平均 24.7（min 0.8 / max 31.9） | **93.3 ms** | **80.6 MB** |
| Three.js 版（同中心） | 要実測 | - | 要実測 | 要実測 | - | 要実測 |

### (5) 3D Tiles 事前変換の結論 → 下記「実測反映と結論」を参照

## 実測反映と結論（`?mode=all`、ユーザー実機計測）

> 事実区分: 下表はユーザーが Vercel Preview 実機で計測した値の転記です（Claude Code 環境では未再計測）。
> 端末・ブラウザ・GPU は未記録。dynamic モードの実測は**未取得**。

### 実測値（`?mode=all`）
| 項目 | 値 |
|---|---|
| status | ready |
| 描画建物数 / 読込 tile / Primitive | 35,031 / 52 / 52 |
| footprint 頂点数 | 201,015 |
| 初期ロード | 14,013 ms（fetch/parse 2,978 ms + Primitive ready 11,035 ms） |
| JS heap | 80.6 MB |
| HUD FPS（1s 平均） | 24.7（min 0.8 / max 31.9） |
| 10秒 FPS 計測 | 平均 8.3 fps / p95 frame 93.3 ms |
| canonicalId クリック | 正常。`bldg_1359ed60-60d5-47dc-863e-64d0f41635c0` を取得 |

### fixed 3×3 との比較（報告値同士）
| | fixed 3×3 | all |
|---|---|---|
| 建物 | 10,546 | 35,031（約3.3倍） |
| 初期ロード | 約10.0 s | 14.0 s（約1.4倍） |
| 平均FPS | 約31.3 | 8.3（10秒計測）/ 24.7（HUD） |

注意: fixed 側の FPS は 10 秒計測か HUD 値か不明で、all 側は 2 種ある。fixed の 10 秒計測・p95 は未取得のため、**厳密な倍率比較はできない**。

読み取れること:
- 初期ロードは棟数比（3.3倍）ほど悪化していない（1.4倍）。理由は未検証。
- 内訳の約 79%（11.0 s / 14.0 s）が Primitive ready（ブラウザ側ジオメトリ生成）で、fetch/parse（約 3.0 s）ではない。事前変換で削れるのはこの部分。
- 描画が重い。10 秒平均 8.3 fps、p95 93.3 ms、HUD の min 0.8 fps（長いフレーム）。heap 80.6 MB は問題になりにくく、ボトルネックは GPU/描画側の可能性があるが、GPU 側は未計測。

### (1) 住吉区全域の一括 Primitive 方式の評価
**実用性能未達**と評価する。
- 10 秒平均 8.3 fps / p95 93.3 ms は対話操作に耐えない（30 fps ≒ 33 ms）。HUD 値でも 24.7 fps で、min 0.8 fps のスパイクがある。
- 初期ロード 14 s のうち 11 s が、利用のたびに毎回発生するブラウザ側ジオメトリ生成。
- 住吉区（35,031 棟）でこの状態のため、大阪市全体（574,213 棟、約 16 倍）への外挿は不可。
- 先の判断基準案のうち FPS 基準（平均 30 未満）に該当。ロード時間は「数十秒」には至っていない。

### (2) dynamic mode と fixed mode の位置づけ
- **fixed（3×3）**: 表示・座標・クリックの正しさを確認する最小構成かつ比較ベースライン。約 1 万棟で約 31 FPS と余裕は小さく、製品経路ではない。
- **dynamic（`?mode=dynamic&r=1`）**: 描画対象を最大 9 tile（fixed 同等）に抑え、all の描画負荷を避ける**つなぎ**。実測は未取得で、tile ロードごとに主スレッドで Primitive 生成が走るためパン時に引っかかる懸念がある（未検証）。最終方式ではなく、3D Tiles PoC の「tile 選択ロジック」の予行と位置づける。
- **all**: 悪い側の基準として残し、改善後との比較対象にする。
- 推奨: dynamic で移動しながら「10秒FPS計測」と `dynLog` を 1 回取る（必須ではない）。

### (3) 3D Tiles 事前変換へ進むべきか — **進む（Go）**
根拠（実測）:
1. 一括方式の描画性能が住吉区規模で未達（8.3 fps）。
2. ロード時間の約 79% が毎回のジオメトリ生成で、事前変換でオフラインに移せる。
3. 市全域には tile 単位の選択ロード/LOD が必須で、3D Tiles は SSE ベースの制御・キャッシュを標準提供する。

限定条件（未検証）:
- FPS が改善するかは、描画ボトルネックが頂点数・フラグメント負荷・picking 用 ID 描画のどれかが未特定のため保証できない。Primitive は 52 個でコマンド数は少ない。PoC で必ず検証する。
- 効果の主因は「描画範囲の削減」（LOD）になる見込み。

### (4) 次の最小 3D Tiles PoC 案
目的: 事前変換でロード時間と FPS がどれだけ改善するか、canonicalId クリックを維持できるかの検証。本番 HTML には入れない。

- **対象 tile 数**: 段階 1 は fixed と同一の 3×3 = 9 tile（10,546 棟）、段階 2 は all と同一の 52 tile（35,031 棟）。取得済みの実測と同条件で比較できる。
- **変換単位**: 既存 tile（500 m、1 JSON）= 3D Tiles の 1 content（glTF/GLB）。葉に各 tile、その上に 4×4 tile 程度の親を置く 2 階層。変換は `tools/` 配下の Node スクリプトで実装し、出力は PoC 専用パスに置く（既存 `public/map-data` は変更しない）。
  - 屋根の三角形分割＋側面の押し出し。座標は既存 `geoToThree()` の逆変換と同一定数でローカル→WGS84→ECEF。
  - `boundingVolume` は実建物範囲から計算（推測定数は使わない）。
- **canonicalId 保持方法**: glTF の `EXT_mesh_features`（feature ID）＋ `EXT_structural_metadata` の文字列プロパティ `canonicalId`。1 建物 = 1 feature。既存 `bldg_<uuid>` をそのまま格納し、採番・変更はしない（代替案: b3dm の batch table）。
- **クリック方法**: `scene.pick` → `Cesium3DTileFeature` → `getProperty('canonicalId')`。現行 POC と同じ `/^bldg_/` 検証・HUD 表示を再利用。ハイライトは `Cesium3DTileStyle` 条件式または feature の color。合格条件は、現行 POC と同じ建物で同じ canonicalId が取れること。
- **LOD / 破棄方針**:
  - 親子 2 階層＋`geometricError`。遠景は親 tile 側の簡略表現（候補: footprint の bbox 押し出し、小建物の除外）、近景のみ詳細。簡略化内容は PoC で比較。
  - 破棄は Cesium 標準のタイルキャッシュと SSE に任せ、自前の `primitives.remove` は使わない。
  - `maximumScreenSpaceError` を 8 / 16 / 32 で比較。
- **合格基準案（要合意）**: 52 tile 構成で 10 秒平均 FPS ≥ 30、p95 ≤ 50 ms、初回表示が現行 14 s 未満、canonicalId が現行と一致。
- **計測**: 既存 HUD / 「10秒FPS計測」を流用し、同一端末・同一視点で fixed / all / 3D Tiles を比較。
- **リスク**: 不正 footprint での三角形分割失敗、出力ファイルサイズ（未見積もり）、GPU 側が主因なら FPS が改善しない可能性。

## 変更ファイル
- 追加: `public/mission37b-livecity-cesium-tiles.html`
- 追加: `tools/mission37b-poc-stats.js`（読み取り専用の静的集計ツール。未実行）
- 追加: `tests/mission37b-cesium-poc.test.js`（静的ガード。未実行。`npm test` には未登録）
- 追加: 本レポート
- 変更なし: `public/osaka_3d_buildings.html` / `osaka_3d_buildings.fullward-v3.html` / Mission 36L 写真データ / canonicalId 体系

## 残課題
- ブラウザでの表示確認・実測（上表の記入）。
- 不正 footprint（自己交差等）で Primitive 生成が失敗しないかの確認。
- 距離 LOD / タイル破棄、3D Tiles 変換の PoC。
- 梅田エリアでの確認（本リポジトリには住吉区のタイルのみ存在）。
