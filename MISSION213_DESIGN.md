# Mission 213 設計(Phase 0/1)— 24区一体 階層LOD

状態: 設計 + Phase 1 の純粋関数試作のみ。**実測・実描画は未実施**(このサンドボックスはネットワーク/ブラウザ/PLATEAU実データなし)。
PR #61 (`feature/mission206-osaka24-cloud-direct`, `b56e979`) は読み取りのみ。push していない。

## 根本原因(PR #61 のコード読解による。実測ではない)
1. `tools/cloud/build-cloud-preview.mjs` が `index.json` に `lod0Wards: []` を出力 → 45G `lod0Sync()` が読むべき遠景LOD0が空。
2. 45F `allMode` は詳細最大2区・粗LOD最大8区。24区同時の「背景」が構造上存在しない。
3. 45G ビルダーは入力が旧45D attrs(PLATEAU2025ではない)で LOCAL 専用、出力は区ごと1GLB。
4. 初回表示が遅い要因(index.json/JS/Cesium/タイル逐次取得のどれが支配的か)は **未計測** → Phase 0 が先。

## 代替案比較
| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A | 既存 `lod0Wards` を区ごと24 tilesetで埋める | 変更最小・既存 `lod0Sync` を流用 | 24 tileset.json + 24 GLB 取得、区境界でセル二重化、viewer側で粗LOD上限8区の制約が残る |
| B(推奨) | `_city-lod0/tileset.json` 単一index + 共通グリッドの空間タイル(REPLACE) | 区境界で一意(二重化なし)、Cesium SSE/視錐台カリングに任せられる、リクエスト数が視野依存 | `index.json` に新フィールド、viewer に1 tileset 追加(要Cesium 1.121実機確認) |
| C | HLOD統合root(LOD0→LOD1→LOD2を1ツリー) | 置換管理が標準仕様に載る | 既存LOD1/LOD2 tilesetの再構築が必要、クリック/canonicalId維持リスク大。Phase 2 でB上にプロトタイプ比較 |

選定: **Phase 1 は B**(既存データを変更せず追加のみ・feature flag で即ロールバック可)。Phase 2 で C と既存viewer管理を実機比較。

## Phase 1 試作(このブランチ)
- `tools/lod0/city-lod0.cjs`: `aggregateCells`(決定的セル集約、100–250m)/ `mergeAndPartition`(都市共通グリッドで区境界合算+空間タイル化)/ `coverageReport`(24区、0件・欠落・元棟数不一致=失敗)/ `buildTilesetIndex`(REPLACE、`clickable:false`、`notRealBuildings:true`、`lod0_` ID)。座標系・GLB書出しは注入式(推測しない)。
- `tests/city-lod0.test.cjs`: 5件 pass。実行: `node --test tests/city-lod0.test.cjs`(`npm test` には未追加)。
- 入力契約: **LOD2化した棟を含む元LOD1全棟**(`lod1FullCounts` と照合)。旧45D資産は入力にしない。

## 未実装(次ステップ・担当/環境)
| 段階 | タスク | 実行環境 |
|---|---|---|
| 0 | `__lc212perf` + Playwright/CDP で A〜H を cold/warm × PC/低速4G 計測 | ネットワーク+Chrome(ローカル/CI) |
| 1a | `build-cloud-preview.mjs` のSINGLE pass中に各区の全LOD1棟(x,z,h)を `aggregateCells` へ流す配線 | PLATEAU実データ要 |
| 1b | タイルGLB書出し(37B `buildGlb` 再利用、注入)、`toRegion` 実装、`index.json` に `cityLod0` 追加 | 同上 |
| 1c | viewer: feature flag(例 `?lod0city=1`)で `_city-lod0` を常時背景に。既定OFFで PR#61 の挙動不変 | ブラウザ検証要 |
| 2 | REPLACE置換/先読み/foveated比較、LOD0とLOD1/2の二重描画防止 | 実機FPS計測要 |
| 3 | ハッシュ付きURL・圧縮・増分ビルド(Vercel Hobby枠遵守) | — |

## データ量見積(仮定。実測ではない)
615,234棟 / 200mセル → 市域約 225km² で最大約5,600セル、実際は市街地のみで数千セル。1セル=角柱12三角形としてGLB合計は概ね数MB台の見込み(要実測)。タイル分割 16×16セル(3.2km角)で視野内のみ取得。

## 受入基準との対応
画面検証(24区遠景/境界横断/クリック)・性能目標・Cesium 1.121互換は **未確認**。完了扱いにしない。
