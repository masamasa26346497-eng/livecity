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

> 事実区分: 追加実装は静的記述のみで、この環境ではブラウザ実行・計測ができていません。**以下の実測欄は未記入**です。

### (1) canonicalId クリック
- `scene.pick` → `picked.id`（`GeometryInstance.id` = tile JSON の `building.id`、実データで `bldg_<uuid>` 形式を確認）。
- 受理条件を `typeof string` かつ `/^bldg_/` に限定（診断用の赤枠 Entity 等を誤認しない）。
- 動的破棄で Primitive が destroy 済みの場合にハイライト復元が例外を出さないようガード追加。
- 実機クリック結果: 利用者報告「表示は確認済み」。クリックの canonicalId 取得は **要確認**（HUD 下部 / `__mission37b.lastPickedCanonicalId`）。

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
| all（住吉区全域） | 35,031 | 52 | 要実測 | 要実測 | 要実測 | 要実測 |
| Three.js 版（同中心） | 要実測 | - | 要実測 | 要実測 | - | 要実測 |

### (5) 3D Tiles 事前変換の結論（暫定・実測前）
- 実測が無いため**最終結論は出せません**。根拠のある範囲での見立て:
  - fixed 3×3（1万棟）で初期ロード約 10 s・約 31 FPS という報告値は、すでに JSON→Primitive 変換が主因で重い可能性を示す（変換時間と描画時間の内訳は `primitivesReadyMs` で分離可能）。
  - 住吉区全域はその約 3.3 倍の棟数。`mode=all` で線形以上に悪化するなら、事前変換が必要。
- 判断基準案: `mode=all` の初期ロード > 数十秒、または平均 FPS が 30 未満なら 3D Tiles（tile 単位 content、canonicalId を batch table）へ進む。
  dynamic が許容範囲（ロード各回数秒、FPS 維持）なら、まず動的ロード + 簡素化で足りる。上記基準値は提案であり、合意が必要。

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
