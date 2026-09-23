# MISSION 33A — 地名・駅名・主要施設ラベル + 地図全体の配色改善

**判定: `CITY_LABELS_PALETTE_SUCCESS`**（validator PASS・error 0・warning 1）

- **変更したのは development の `public/osaka_3d_buildings.ward-ux-v1.html` のみ。** production / protected は一切触っていません（hash 一致で確認）。
- 建物 geometry・位置・投影・canonical V2・OSM fallback V2・ROAD V3 の生成ロジック・placement は**不変**。今回は「見た目」だけです。

---

## 1. 何を変えたか

### 1-1. ラベルデータ（既存データから導出。新規の外部取得なし）

| 種別 | 件数 | 出所 |
|---|---|---|
| 地名 | **697**（広域 60 / 中位 200 / 局所 437） | 既存の `data/raw/osm/osaka-latest.osm.pbf` の place ノード（大阪市は「◯丁目」粒度で 2,853 件）を**基準地名へ集約**（`tools/build-place-labels.js`） |
| 駅名 | **233 駅 → 174 クラスタ** | canonical `derived/rail-stations.json`（最寄駅表示と同じ実データ）。近接駅・同名駅の統合は Mission14 の `clusterStations` を再利用 |
| 主要施設 | **19** | canonical `landmarks/landmarks.json`（大阪城・あべのハルカス・通天閣・京セラドーム大阪・グランフロント大阪 など） |
| 区名 | **24** | N03 2026 の区界ポリゴンの**面積加重セントロイド**（`tools/build-map-label-anchors.js`） |
| 公園名 | **137**（広域 39） | canonical parks の名称付きポリゴン（12,000m² 以上。大阪城公園・鶴見緑地・長居公園・天王寺公園・淀川河川公園 など） |

地名の階層は**実データから導出**しています（ハードコードした地名リストは使っていません）。
スコア = 丁目数 + 同名駅の有無 + **周辺 600m の駅数**（＝都市の中心性）+ 広がり → 上位 60 を広域地名に。
結果として 梅田 / 中之島 / 難波 / 北浜 / 天神橋 / 日本橋 / 鶴橋 / 住吉 / 天満 などが広域ラベルになりました。

### 1-2. ラベル描画（新規 `CityLabelLayer`）

- **方式**: `THREE.Sprite + CanvasTexture`（駅ラベル Mission14 と同じ、実機で実績のある方式）。DOM は使いません。
- **遅延生成**: 画面に出ると決まったラベルだけ sprite を作り、テクスチャは「スタイル + 文字列」でキャッシュ。全件 sprite 化はしません。
- **優先順位**: ランドマーク > 区名 / 駅 > 地名 > 公園（1 本の優先度キューで解決。同順位は画面中心に近い順）。
- **衝突回避**: 画面座標（NDC）の矩形で重なりを判定し、低優先を落とす。さらに band 別の総数上限（遠 18 / 中 36 / 近 58）と画面 6×4 グリッドの 1 セル 3 件上限。
- **ズーム制御**: 遠景＝広域地名・主要駅・MAJOR ランドマーク・区名、中景＝中位地名・中位駅・大規模公園、近景＝局所地名・小駅・公園。
- **サイズ**: 画面ピクセル基準（カメラ距離から 1px の world 長さを求めて scale を決定）。引いても寄っても文字の大きさが一定で読めます。
- **更新**: 200ms スロットル + カメラ dirty 判定。render loop からは try/catch で隔離。

### 1-3. ラベルの見た目

- フォント: `Hiragino Sans / Noto Sans JP / Yu Gothic` 系の sans-serif。**文字サイズを階層化**（区名 18 / 地名 17・14・12 / 施設 15・13 / 駅 13.5・12・10.5 px）。
- 明るい地図なので、**昼は濃いインク + 白ハロー**、夜は**白文字 + 暗いハロー**に自動で切り替えます。
  （ご指示は「白系 + ハロー」でしたが、現在の地図地色が明るいため白文字は沈みます。読みやすさを優先し、夜間モードで白文字になる形にしました。）
- 主要施設だけ白のピル（角丸）+ 細い枠で少し強調。駅は控えめな丸ドットを**テクスチャ内に**描いており、sprite は増えません。
- 施設名の括弧補足（例「ノースゲートビルディング（大阪ステーションシティ）」）は地図上では冗長なので**表示時だけ**落とします（データ側の名称は不変）。

### 1-4. 配色（canonical runtime のパレット v2）

| 要素 | before | after | ねらい |
|---|---|---|---|
| 背景 | `0xf3f4f1` | **`0xf6f7f3`** | くすみを取り一段明るく（neutral は維持） |
| 地表 | `0xe6e8e3` | **`0xebede6`** | 建物・水域・緑が映える明るさ |
| 水域 | `0x6fb3d4` / 港 `0x5f9bbb` | **`0x63bfe4` / `0x55a9d0`** | 気持ちのよい青。河川が地図のアクセントに |
| 公園・緑地 | `0xa8cf98` / `0x9ac888` / `0xcbe0be` | **`0x9bd589` / `0x8fcd7b` / `0xc9e7b6`** | 灰色に埋もれない爽やかな緑 |
| 道路 | `0x9096a0` | **`0x979ea9`** | 背景に沈まず、建物より前に出ない |
| 鉄道 | `0x515966` / `0x586590` / `0x6f7783` | **`0x49546a` / `0x4f5f9e` / `0x69717f`** | 道路との区別を明確に |
| 建物の白寄せ | far .55 / mid .30 / near .12 | **far .46 / mid .20 / near .06** | 用途色が見える（LOD1 のまま） |
| 建物の彩度 | — | **`CR_VIVID = { sat: 1.24, light: 1.03 }`** | 色相は変えずに彩度 +24% / 明度 +3%（0.95 でクリップ＝白飛びしない） |
| 露出・光量 | exposure .86 / hemi .60 / sun 1.34 | **exposure .93 / hemi .74 / sun 1.28** | 全体を明るく。陰影（sun）は残す |

用途色（`CR_USAGE_COLOR`）そのものは変えていません。**色相＝用途の意味**は保ったまま、白寄せを減らし彩度を戻しています。

### 1-5. UI

- レイヤーパネルに **「地名」「施設名」** のトグルを追加（既定 ON）。既存の「駅名」トグルは新しいラベル層の駅名に配線し直しました。
- デバッグ用 `window.__CITY_LABEL_DEBUG__()` / `window.__CITY_LABEL_TOGGLE__(kind, on)` を追加（production ビルドでは開発用 UI と同様に隠れます）。
- カメラ挙動・クリック・property card は変更していません。

---

## 2. 変えていないこと

| 項目 | 状態 |
|---|---|
| 建物 geometry / 高さ / 位置 | **不変**（`pushExtrude(...)` と `h = Math.max(2, +a.heightM ‖ 6)` は原文のまま。validator が検査） |
| projection / origin | **不変**（`local-equirectangular` 34.604208 / 135.52502 / 111320） |
| canonical building V2・OSM fallback V2 | **不変**（600,764 棟。manifest の更新時刻も cutover 以降変化なし） |
| ROAD V3 の生成ロジック・出力 | **不変**（色だけ変更） |
| placement policy / ward index | **不変** |
| 建物 ID・紐付け | **不変** |
| production `osaka_3d_buildings.html` | **不変**（32U のビルド成果物と hash 一致） |
| protected `fullward-v3.html` | **不変**（baseline と hash 一致） |

---

## 3. 検証結果

### 3-1. Validator — `data/reports/city-labels-palette-validation.json`

| 項目 | 値 |
|---|---|
| labelDataReady（地名 697 / ランドマーク 19 / 駅 233） | true |
| labelImplementationOk（優先度・衝突・遅延生成・スロットル・トグル） | true |
| paletteChanged / geometryUntouched | true / true |
| labelsVisibleAtAllSites / labelOverlapPairs | true / **0** |
| paletteBrighter / paletteMoreVivid | true / true |
| buildingGeometryMutation / roadV3Mutation / projectionMutation | 0 / 0 / 0 |
| productionModified / protectedModified | false / false |

警告 1 件: 「東淀川は地名・駅の元データが無く、区名 / 公園名だけ」（後述）。

### 3-2. npm test

- `npm test`: **1,758 tests / pass 1,743 / fail 0 / skip 15**（追加は `tests/city-labels-palette.test.js` 11 件）。
- lifestyle-tab 系（npm test 対象外）も **fail 0**。
- 既存テストの更新（今回の変更に伴う必然）:
  - `mission12 / mission13 / mission18`: 背景色の期待値を `0xf3f4f1 → 0xf6f7f3`（「明るい neutral」という Mission17 の趣旨は維持）。
  - `mission14 / mission19`: 「駅名」トグルの配線先を `StationLabelLayer → CityLabelLayer` に更新。Mission14 のクラスタリング・スタイル・debug API は残っており、テストでも引き続き検査しています。

### 3-3. 実ブラウザ QA（Edge headless・実 GPU / `data/reports/city-label-palette-qa.json`）

before = production（33A 前）、after = development（33A 適用）。同じカメラ（r=900・見下ろし 53°）で比較。

| 地点 | ラベル（施設/駅/地名/区/公園） | 重なり | 平均輝度 | 平均彩度 | 色のある画素比 |
|---|---|---|---|---|---|
| 梅田 | 13（5/1/6/1/0） | 0 | 0.660 → **0.708** | 0.107 → **0.138** | 0.16 → **0.33** |
| 本町 | 34（2/4/25/0/3） | 0 | 0.661 → **0.708** | 0.095 → **0.125** | 0.09 → **0.30** |
| 難波 | 32（3/4/22/1/2） | 0 | 0.685 → **0.728** | 0.090 → **0.119** | 0.13 → **0.29** |
| 天王寺 | 30（4/11/13/0/2） | 0 | 0.690 → **0.734** | 0.087 → **0.116** | 0.18 → **0.28** |
| 住吉 | 28（2/3/18/0/5） | 0 | 0.694 → **0.739** | 0.099 → **0.129** | 0.25 → **0.33** |
| 東淀川 | 1（0/0/0/1/0） | 0 | 0.685 → **0.734** | 0.109 → **0.142** | 0.29 → **0.39** |
| 大阪市全域（City Mode） | 18（施設 7・駅 5・区 6） | — | 0.807 → **0.834** | — | — |

- **6 地点すべてで明るさ・彩度が上がりました。** 画素の測定は WebGL canvas を実際に読み出した値です。
- 実際に出たラベル例: 梅田 / グランフロント大阪 / 梅田スカイビル / JPタワー大阪、難波 / 道頓堀 / 西心斎橋 / なんば駅 / 日本橋駅 / 浪速公園、住吉 / 粉浜 / 住吉大社駅 / 帝塚山中、天王寺 / あべのハルカス / 通天閣 / 新今宮駅。
- **ラベル同士の重なりは全 6 地点で 0 組**（画面座標の矩形を実測して独立に数えたもの）。
- ブラウザ例外 0 件、legacy residual 0。

スクリーンショット: `data/reports/city-label-palette-qa/{umeda,honmachi,namba,tennoji,sumiyoshi,higashiyodogawa}-{before,after}.jpg` と `city-{before,after}.jpg`。

### 3-4. 性能

| 条件 | FPS 平均 | frame P95 | draw calls | triangles |
|---|---|---|---|---|
| before（ラベルなし） | 42.9 | 33.5ms | 380 | 626,337 |
| after（ラベルあり） | **41.2** | 33.6ms | 401 | 626,385 |

draw call の増加は +21（表示中のラベル sprite 分）、triangles はほぼ同じ。**体感で重くなるレベルの低下はありません**（-1.7 FPS、frame P95 は同等）。

---

## 4. 正直な申告

1. **東淀川（大阪市北部）はラベルがほとんど出ません。** 区名「東淀川区」だけです。原因は元データで、`osaka-latest.osm.pbf` が**北緯 34.735° 付近で切れており**、その北側には place ノードも駅ノードも存在しません（既知の制約。淀川区・旭区北部も同様）。
   → 改善案: 北側まで含む OSM 抽出を取り直す、または国土地理院の地名データを別系統で取り込む。
2. **「京橋」「新大阪」などの地名ラベルはありません。** これらは町丁目名として OSM に無く、駅名（京橋駅・新大阪駅）としてのみ表示されます。
3. **「グラングリーン大阪」「うめきた公園」は未収録**です（`landmarks.json` は 19 件。新しい再開発施設が入っていません）。中之島公園・大阪城公園は公園ラベルとして出ます。
4. **旧 `StationLabelLayer` は表示しない形にしました。** `CityTileLayer` の駅タイル依存で、区を移動しても初期区の 12 駅のままリビルドされず、実機では駅名がほぼ出ていませんでした（production でも 0 件だったことを確認済み）。コード・クラスタリング・debug API はそのまま残しています。
5. **City Mode の広域表示ではラベル同士が近接することがあります**（重なり 9 組を検出。多くは区名の大きな枠と小さな施設ラベルの接触で、実画面では読み取れる範囲です）。近景の 6 地点は 0 組です。
6. **Mission15 の共通 LabelEngine（河川名などを含む設計）は今回も未実装**です（過去に実機不具合で revert された経緯があるため、既存の駅ラベル実装には手を入れず層を足す方式にしました）。`tests/mission15-label-engine.test.js` の失敗は 33A 以前からの既存状態で、`npm test` の対象外です。
7. 今後の改善候補: 河川名ラベル（rivers-v2 に名称あり）、ラベルのフェードイン/アウト、施設ラベルの建物頂部へのアンカー、夜間配色の追い込み、北部データの補完。

---

## 5. 生成物

| 種別 | パス |
|---|---|
| ラベルデータ | `public/map-data/osaka-city/derived/place-labels.json`（+ `data/processed/...`）、`derived/map-label-anchors.json` |
| ツール | `tools/build-place-labels.js`、`tools/build-map-label-anchors.js`、`tools/audit/city-label-palette-qa.js`（`npm run preview` が必要） |
| Validator | `tools/validate/city-labels-palette.js` |
| レポート | `data/reports/place-labels.json`、`map-label-anchors.json`、`city-label-palette-qa.json`、`city-labels-palette-validation.json`、`data/reports/city-label-palette-qa/*.jpg` |
| テスト | `tests/city-labels-palette.test.js`（npm test に登録） |
| 変更したファイル | `public/osaka_3d_buildings.ward-ux-v1.html`（development のみ） |

production へはまだ上げていません。実機で見ていただき、問題なければ次のミッションで production cutover（`node tools/build-production-html.js`）を行う想定です。

`CITY_LABELS_PALETTE_SUCCESS`
