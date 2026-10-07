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
