# 大阪市24区化 進捗レポート

大阪市24区の地図基盤構築（第一目標）の作業ログ。新しいエントリを上に追記する。

---

## 2026-09-02 セッション6: P1-6 都市レイヤー展開（道路・河川・公園・鉄道）

ネットワーク取得はローカルPC作業のため、**取得ツール・共通タイル基盤・変換・validator・fixture・
テスト・RUNBOOK・HTML統合レイヤーまで実装**（推測データは作らない）。実取得は `MAP24_P1-6_RUNBOOK.md`。

### tile grid 仕様（`tools/lib/city-tile-grid.js`）
- 基準: `config/areas/osaka-city.json` bbox + projection。座標規約 **znorth-neg-v1**（projection原点不変）。
- tile 一辺 **2000m** → **13×12 = 156 タイル**（原点 tx=-9, tz=-10）。ローカル bbox x∈[-16770,6962] z∈[-18456,2138]。
- tile id `tile_<tx>_<tz>.json`（`floor(x/2000)`,`floor(z/2000)`。建物 dataset と同一形式・4レイヤー共有）。
- buffer 150m（取得時に外側拡張）。feature は**クリップせず bbox が重なる全タイルへ複製配置、load時に id で dedup**
  → tile 境界で地物が欠落しない。

### 実装ツール
| ツール | 役割 |
|---|---|
| `tools/download/city-tiles.js` | Overpass をタイル単位取得。retry/backoff/rate-limit（overpass.js委譲）/ **request cache**（`data/raw/osaka-city/_cache/`）/ **resume**（有効キャッシュは再取得しない）/ 全成功時 id dedup マージ。一括bbox取得はしない |
| `tools/build-city-layer-tiles.js` | 既存 `convert/{roads,parks,railways,waterways}.js` を流用（+z）→ **z 反転で znorth-neg-v1** → タイル化。河川は `convert/waterways.js`（`assembleMultipolygon`/`stitchWays`）で relation 連結・中州 holes 保持・**未連結 relation は描画しない**・巨大セグメント/自己交差 area は除外 |
| `tools/lib/city-layer-validator.js` + `tools/validate/city-layer-tiles.js` | 共通 validator。manifest/tile存在・source count整合・同一tile内id重複なし・finite・feature が tile bbox内・巨大セグメント（面：河川は厳しめ/公園は中央値倍率のみ）・自己交差（面）・coordinateConvention・**24区bbox coverage**・**既存3区 coverage**。河川は water geometry validator を併用 |
| `tools/fetch-water.js`（変更） | `--replace` 正式化 + merge 時の壊れ record フィルタ（`isBrokenWaterRecord`。P1-5B の続き） |

### HTML 統合（`public/osaka_3d_buildings.ward-ux-v1.html`）
**`CityTileLayer`（新規・独立IIFE。既存 RoadLayer/ParkLayer/WaterLayer/埋め込み OSM_* には一切触れない）**:
- `map-data/osaka-city/{roads,waterways,parks,railways}/` を Ward 中心タイル ±1 だけ progressive load
- 描画: 道路/鉄道 = LineSegments（正確な中心線。ribbon化は P1-7）、公園/水域面 = 平面フィル（holes対応）、
  水域線 = LineSegments、駅 = 小マーカー
- `coordinateConvention !== 'znorth-neg-v1'` の manifest はスキップ。**404 時は静かに no-op**（埋め込み3区レイヤーがそのまま動作）
- LRU（レイヤーあたり40タイル）で旧 Ward の不要 tile を dispose。feature id で dedup（二重描画なし）
- `camUpd()`（近景 cs.r<6000 のみ・内部 throttle 400ms）と `flyToWardCentroid()`（Ward切替で即開始）に配線
- `[LAYER-PERF] {layer, manifestMs, firstTileMs, firstRenderMs}` を console 出力
- `[WARD-DIAG]` overlay に `city layers` の loadedTiles / manifest 状態を追加
- **建物 tile とは独立に progressive**。全レイヤー完了を待たない。

### 変更ファイル
```
新規: tools/lib/city-tile-grid.js / tools/lib/city-layer-validator.js
新規: tools/download/city-tiles.js / tools/build-city-layer-tiles.js / tools/validate/city-layer-tiles.js
新規: tools/lib/__fixtures__/city-layers/{roads,parks,railways,waterways}-osm.json
新規: tests/city-layer-tiles.test.js (11) / MAP24_P1-6_RUNBOOK.md
変更: tools/fetch-water.js (--replace + 壊れrecordフィルタ)
変更: public/osaka_3d_buildings.ward-ux-v1.html (CityTileLayer + camUpd/switch配線 + WARD-DIAG拡張)
変更: package.json / .gitignore（都市レイヤー生成物・raw cache を除外） / MAP24_PROGRESS.md
```

### テスト結果
- `npm test`: **241 / 226 pass / 0 fail / 15 skip**（セッション5B の 230/215 から +11）
- `tests/city-layer-tiles.test.js` 11/11（grid・z反転・relation連結・未連結除外・中州holes・line/station分離・
  4レイヤー生成+validator PASS・巨大セグメント検出・buildTileQuery/mergeDedup・CityTileLayer配線）
- `ward-lifecycle` + `picking-visibility` + `superseded-load-cleanup` + `ward-mode-integration`: **22/22**
- html-regression（osaka_3d_buildings.html）: **15/15**、ward-ux-v1.html script 構文 OK
- `git diff --check` クリーン、`fullward-v3.html` 未変更

### 生成結果（fixture ベース。実データは RUNBOOK 実行後）
| layer | fixture feature | tile | 備考 |
|---|---|---|---|
| roads | 3 | 7 | 長い primary が5タイルへ複製配置（境界欠落なし） |
| parks | 2 | 2 | |
| railways | 4 (line2+station2) | 4 | line/station 分離 |
| waterways | 2 (river line+riverbank area) | 2 | 3 outer way(逆順含む)→1 area、中州 holes 1、未連結 relation 1件を除外 |

### 未解決事項 / ローカルPCで必要な取得コマンド
1. **実 Overpass 取得**（ローカルPC）:
   ```
   node tools/download/city-tiles.js --layer all --area osaka-city       # 156×4=624 req、resume対応
   node tools/build-city-layer-tiles.js --layer all --public --force
   node tools/validate/city-layer-tiles.js --area osaka-city             # ERROR 0 を確認
   ```
2. **実データでの検証**: 大和川・淀川・寝屋川で `no-oversized-area-segments` / `water:no-oversized-segments` PASS、
   tileSize 2000m の実ファイルサイズ（中心部で 500KB 超なら `--tile-size 1500` 再生成）。
3. **実機確認**（ブラウザ）: Ward切替で建物・道路・河川・公園・鉄道が独立して段階表示されるか、
   旧 Ward の city tile が LRU で解放されるか、`[LAYER-PERF]` / `[WARD-DIAG]` の値、二重描画なし。
4. CityTileLayer の道路は LineSegments（幅なし）。RoadLayer 相当の幅付き ribbon は P1-7。
5. 既存 3区の埋め込み RoadLayer/ParkLayer/WaterLayer と CityTileLayer が 3区で二重に出る可能性
   （Y差・renderOrder で緩和済みだが、実機で確認 → 必要なら 3区で埋め込み側を hide するトグルを P1-7 で）。

### 次工程へ進めるか
**データ基盤・変換・validator・HTML統合レイヤーはコード完成。実 Overpass 取得（ローカルPC）と実機確認を経て
P1-7（ribbon描画・3区埋め込みレイヤーとの整理・駅ラベル）へ。**

---

## 2026-09-01 セッション5B: P1-5B 実機確認で判明した4問題の修正

### A. 河川geometry
- **調査**: `ward-ux-v1.html` の `OSM_WATER` は「way/748921034」1件（小さな池）のみで、relation/18530061〜63 等の壊れデータは無い。
  実機で見えた河川崩れの主因は **P1-5 で追加した N03 行政区polygon を `WardAreaFillLayer` 等へ流し込んでいたこと**
  （1区=数百〜千点の巨大concaveポリゴンを町丁目タイル前提の塗りレイヤーへ入れると三角形分割が破綻し、
  シアン系の面が河川崩れに見える）と判断。
- **修正**:
  - `ensureWardRings()` から N03 供給を撤去。N03 は `__n03WardPolyCache` / `getWardCameraTarget()` として
    **カメラ移動先・detectWardAt 専用**に限定。`WardBoundaryLayer` / `WardAreaFillLayer` / `WardLabelLayer` の
    初期化は `setTimeout(0)` に戻す（P1-5 の `__n03WardRingsReady.then` 待ちを撤回）。
  - `tools/fetch-water.js`: `--replace`（= `--no-merge`）を正式サポート。**merge時も壊れ record を温存しない**
    フィルタ（`isBrokenWaterRecord`: 巨大セグメント/自己交差/非有限を `analyzeRing` で判定）を追加。
  - **`tools/clean-embedded-water.js`（新規、`npm run data:clean:embedded-water`）**: ネットワーク無しで
    HTML 埋め込み `OSM_WATER` から壊れ area を除去（line は温存）。
  - `public/osaka_3d_buildings.html` に対して実行 → **`relation/18530061〜63` の 6 area record を除去**
    （暗黙閉合辺 4466〜5880m）。`npm run data:validate:water -- --html public/osaka_3d_buildings.html` → **RESULT: PASS / 巨大segment 0**。
- protected baseline `fullward-v3.html` は未変更。

### B. 地面/背景の表示範囲
- `GroundVisualLayer.computeBounds()` は埋め込み `BLDGS`（旧3区）+ `OSM_PARKS`/`OSM_PARKING`（旧3区）由来で、
  24区表示で地面が3区分しか無かった。
- **修正**: `config/areas/osaka-city.json` の bbox を既存 znorth-neg-v1 変換へ通した
  `OSAKA_CITY_GROUND_EXTENT = { minX:-16900, maxX:7100, minZ:-18600, maxZ:2300 }`（約24km×21km）を
  `computeBounds()` で union（projection原点・znorth-neg-v1 は不変。`SHOW_LEGACY_GROUND` の設定は変更せず）。
- カメラ: `cs.maxR` 9000 → **24000**（24区を1画面に収める）。`camUpd()` で
  `scene.fog.far`（`max(baseFar, cs.r*3.6)`）と `camera.far`（`max(14000, cs.r*1.6+16000)`）を距離連動で後退。
  → 遠景で背景面・地面が Fog / far clip で途切れない。近景は従来どおり。

### C / D. 建物ロード・区切替の速度
- **計測**: 既存 `switchWard` の timing オブジェクトに `manifestMs` / `firstRenderMs` を追加し、切替完了時に
  **`[WARD-PERF] {wardId, manifestMs, firstTileFetchMs, firstRenderMs, usableViewMs, visibleTileCount, buildingCount}`**
  を出力。
- **原因**: 既定 render mode が `full`（atomic commit = 全タイル READY まで待って一括表示）。
  24区の大きめ dataset（最大 生野区 46,212棟/50 tile）で待ち時間が体感の主因。
- **修正**:
  - 既定 render mode を **`stream`** へ（`window.__WARD_RENDER_MODE__` 既定 `'full'` → `'stream'`）。
    最初の可視 tile が届き次第、段階的に表示。`full` mode のロジック（atomic commit の順序）は**一切変更せず**、
    perf-hud のトグルで従来どおり使用可。
  - stream 分岐を修正: **新区の最初の tile 到着まで旧区を dispose しない**（`releaseOldWard()`。画面が空にならない。
    4秒来なければタイムアウト解放）。重複表示は作らない。
  - `showWardLoadingIndicator()` / `hideWardLoadingIndicator()`: 切替中のバナー表示。

### E. Ward切替時のカメラ位置
- `flyToWardCentroid()` を N03 の centroid/bbox（`WardModeManager.getWardCameraTarget()`、24区共通・
  HTMLへ座標ハードコードなし）優先へ。無い区（N03未ロード時）は従来の `WardLabelLayer.getCentroid` + 3区。
- Ward Selector のクリックは元から `switchWard()` 後に `flyToWardCentroid()` を呼ぶ。→ 区切替で必ず対象区へ移動。

### F. 実機確認用 diagnostic
- 画面左下に **`[WARD-DIAG]`** overlay（500ms更新、描画ループ無干渉）:
  `currentWard / visibleBuildings / buildingCount / loadedTiles(visible+hidden) / loadingTiles / disposedTiles /
  cachedTiles(hidden) / firstRenderMs / renderMode / peak loadedTiles・peak tileObjects`。
  → 10〜20回切替で **peak が単調増加しないこと**をこの1行で確認できる（メッシュ/タイルリーク検出）。

### 変更ファイル
```
変更: public/osaka_3d_buildings.ward-ux-v1.html
        N03供給撤去(ensureWardRings) / __n03WardPolyCache+getWardCameraTarget /
        3レイヤーinit setTimeout(0)復帰 / OSAKA_CITY_GROUND_EXTENT+computeBounds union /
        cs.maxR 24000 / updateFogForCameraDistance + camera.far動的 /
        render mode既定 stream / stream分岐: 旧区を最初tileまで保持 + [WARD-PERF] /
        loading indicator + [WARD-DIAG] overlay
変更: public/osaka_3d_buildings.html                (OSM_WATER 130→124、壊れ relation 6件除去。JSONリテラルのみ)
変更: tools/fetch-water.js                          (--replace + merge時の壊れrecordフィルタ)
新規: tools/clean-embedded-water.js
変更: tests/ward-lifecycle.test.js                  (buildSandbox を full mode 明示に)
変更: tests/ward-mode-integration.test.js           (P1-5B の N03 撤去に合わせて更新)
新規: tests/ward-ux-v1-p15b.test.js                 (11 tests)
変更: package.json / .gitignore(既出) / MAP24_PROGRESS.md
再生成: data/reports/water-geometry-validation.json
```

### テスト結果
- `npm test`: **230 tests / 215 pass / 0 fail / 15 skip**（セッション5の 219/204 から +11）
- `tests/ward-lifecycle.test.js` + `picking-visibility` + `superseded-load-cleanup`（ward-ux-v1対象）: **16/16**
  （full mode のテストは `buildSandbox` で `__WARD_RENDER_MODE__:'full'` を明示。full mode ロジックは未変更）
- `LIVECITY_HTML_PATH=public/osaka_3d_buildings.html node --test tests/html-regression.test.js`: **15/15**
- `tests/ward-ux-v1-p15b.test.js`: **11/11**（extent・camera・N03撤去・stream・WARD-PERF・WARD-DIAG・water cleaner・baseline）
- `node tools/validate/ward-mode-integration.js`: **RESULT: PASS**
- `node tools/validate/water-geometry.js --html public/osaka_3d_buildings.html`: **RESULT: PASS**
- `git diff --check` クリーン、`fullward-v3.html` 未変更

### 修正前後の firstRenderMs / Ward切替時間
**Claude Code 環境にブラウザが無いため計測できない。** 計測経路（`[WARD-PERF]` ログ・`[WARD-DIAG]` overlay）を
実装済み。ユーザーが `npm run preview` → ward-ux-v1.html で:
- 修正前相当: perf-hud で render mode を FULL に戻して各区切替 → `[WardModeManager] switch timing(full)` の loadMs
- 修正後: 既定（STREAM）で各区切替 → `[WARD-PERF]` の firstRenderMs
を比較してほしい（full の loadMs（全タイル）vs stream の firstRenderMs（最初の可視tile）で、体感の主目的である
「最初の建物が出るまで」が短縮されているはず）。

### 未解決 / 実機確認事項
1. **実機での視覚・速度確認が未実施**（ブラウザ無し）: 河川が正常に見えるか / 24区で背景・地面が途切れないか /
   Ward選択直後に loading 表示 → 最初の建物が段階的に早く出るか / 区切替で対象区へ移動するか /
   `[WARD-DIAG]` の peak が10〜20回切替で単調増加しないか。
2. stream mode 既定化は AUTODEV_RULES.md 5.1 の「FULL WARDモード（既定）」記述と食い違う。full mode の
   ロジック（atomic commit）は未変更・トグルで使用可だが、既定変更の是非はユーザー確認の余地あり。
3. `ward-ux-v1.html` の `OSM_ROADS`（467件）/`OSM_PARKS`（26件）は旧3区スコープのまま。24区の道路・公園・
   鉄道は P1-6（次工程）。
4. `public/osaka_3d_buildings.html` の水域は clean 済みだが、`ward-ux-v1.html` には元々ほぼ水域が無い
   （P1-6 で 24区の河川・水域を `--replace` 再生成 → validator 前提）。

### 次工程（道路・河川・公園・鉄道の24区展開）へ進めるか
**P1-5B の4問題はコード上対処済み。実機確認を経て P1-6 へ。**

---

## 2026-09-01 セッション5: P1-5 大阪市24区 建物表示統合

### 開発対象HTML
`public/osaka_3d_buildings.ward-ux-v1.html`（Ward Mode の実装ファイル。AUTODEV_RULES.md 5.1 の監査対象）。
protected baseline `public/osaka_3d_buildings.fullward-v3.html` は**変更していない**（git clean 確認・回帰テストで保護）。

### 実装内容
1. **24区 servable dataset** — `tools/build-ward-building-datasets.js` に `--layout flat` を追加し、
   `public/map-data/osaka-city/buildings/` へ既存 ward-ux-v1 ローダ互換の flat 形式
   （`<datasetId>/manifest.json` + `<datasetId>/tile_x_z.json`、root manifest 3段）で生成。
   生成: `node tools/build-ward-building-datasets.js --layout flat --out public/map-data/osaka-city/buildings --force`
   （24区 / 1,096 tile / 574,112棟 / znorth-neg-v1 / 162MB → `.gitignore`）。
2. **ward-ux-v1.html（最小変更、+95/−43行）**
   - `BUILDING_TILE_CONFIG.basePath` / `rootManifest`: `__test__/ward-poc/buildings` → `map-data/osaka-city/buildings`
   - `WARD_DEFS`: 21区の `dataReady:false` → `true`（24区とも。datasetId/code/name は registry と一致・既存のまま）
   - `__n03WardRingsReady`: N03 区外周polygon（`map-data/osaka-city/boundaries/ward-classification-polygons.json`）を
     非同期ロードし `{wardId:[ring,...]}` へ変換して `ensureWardRings()` が21区分を補完（4秒timeout・失敗しても
     建物表示/区切替に影響なし）。`WardBoundaryLayer` / `WardAreaFillLayer` / `WardLabelLayer` の初期化 3か所を
     `setTimeout(...,0)` → `__n03WardRingsReady.then(...)` に変更（build時に24区分のring列が揃ってから走査）。
   - **ライフサイクル（WardModeManager / FullWardManager / switchWard / BuildingTileLayer の dispose/hide/revisit /
     generation guard / superseded / atomic commit / picking）は一切変更していない。**
   - **Ward Selector UI** は元から WARD_DEFS 駆動・検索/ドロップダウン式で24区対応済み（変更不要）。
3. **統合validator** — `tools/lib/ward-mode-integration-validator.js` + `tools/validate/ward-mode-integration.js`
   （`npm run data:validate:ward-mode-integration`）。24区 manifest/tile 存在・buildingCount整合・
   flat layout・znorth-neg-v1・HTML WARD_DEFS↔registry・全区dataReady:true・basePath・N03 polygon servable。
4. **unclassified 救済分類調査** — `tools/lib/footprint-ward-overlap.js` + `tools/study/unclassified-rescue.js`。下記。

### 24区 それぞれの表示確認結果（統合validator RESULT: PASS、`data/reports/ward-mode-integration-validation.json`）
```
[PASS] dataset:all-datasets-present          24区 dataset 存在
[PASS] dataset:building-id-unique            全区∪unclassified で一意（重複0）
[PASS] dataset:no-building-in-two-wards
[PASS] dataset:coords-finite / tile-bbox-consistent
[PASS] dataset:classified-plus-unclassified-equals-input  584,490 = 574,112 + 10,378 + 0
[PASS] dataset:known-3-wards-count-stable    +4.0% / +0.6% / +1.3%
[PASS] servable-path / flat-layout-servable  <datasetId>/tile_x_z.json・znorth-neg-v1
[PASS] html-ward-defs-24 / -match-registry / -all-dataReady / -have-datasets
[PASS] html-basePath                          map-data/osaka-city/buildings
[PASS] n03-ward-polygons-servable            24区 / znorth-neg-v1
RESULT: PASS
```
※ 実ブラウザでの 3D レンダリング・Ward切替・picking・dispose の動作確認は Claude Code 環境では不可。
   コード/データ/パス/形式の整合はすべて検証済み。ブラウザ確認手順は下記「実機確認事項」。

### buildingCount / tileCount（P1-4 と同一。N03 point-in-polygon 分類）
合計 **574,112棟 / 1,096 タイル**。上位: 生野46,212(50) / 平野44,434(83) / 東住吉38,489(59) /
住吉34,930(51) / 東淀川34,685(66) / 淀川34,289(62)。（全区表は セッション4エントリ）

### Ward切替テスト
- 静的: `tests/ward-mode-integration.test.js` で WARD_DEFS 24区・dataReady・basePath・レイヤー初期化順序を検証。
- ライフサイクル既存テスト `tests/ward-lifecycle.test.js` / `tests/superseded-load-cleanup.test.js` /
  `tests/picking-visibility.test.js` は **変更なしで全 pass**（switchWard/FullWardManager/dispose のロジック未変更のため）。
- 実ブラウザでの「3区→別区」「連続切替」「superseded」「hidden時picking除外」「dispose後残存mesh 0」は実機確認事項。

### 既存3区との差
セッション4と同一。住吉区 +4.0% / 東住吉区 +0.6% / 平野区 +1.3%（ward-poc が boundaryStraddle を除外していた差の範囲）。

### メモリ/性能上の問題
- 遅延ロードは既存の `BuildingTileLayer`（Ward単位 manifest → カメラ範囲の tile のみ fetch、`maxCachedHiddenTiles`
  による hidden tile LRU、`enableTileCulling`/`enableFrustumCulling`）をそのまま使用。24区全棟の一括ロードはしない。
- N03 polygon JSON は 1MB を1回だけ fetch（Ward Mode 前提のHTMLなので許容）。
- 初期ロード時間 / ward切替時間 / 同時保持tile数 / dispose後mesh数 / 長時間切替のメモリ増加は
  **実機計測が必要**（コード上の増加要因は入れていない）。

### unclassified 救済分類調査（`data/reports/unclassified-rescue-study.json`）
指令の優先順位 1.point-in-polygon → 2.footprint×Ward polygon 面積重複 → 3.unclassified で調査:
- 区外 unclassified 10,374棟（ambiguous 4 除く）に footprint bbox グリッドサンプリングで面積重複を計算。
- **救済可能（重なり率 ≥ 0.5）: わずか 12棟（0.12%）**。残り 10,362棟は footprint が**全体的に**全 Ward polygon の外。
- → これらは代表点だけでなく建物全体が N03 行政界の外（海岸線・河川縁・埋立地の縁で PLATEAU が
  公式境界を越えている）。**最近傍区スナップは不適切**（指令#5どおり禁止）。P1-5 表示では ward dataset へ
  混入させず `unclassified` として隔離（P1-4で生成済み）。全市表示では別レイヤー化が妥当（指令#5が許可）。
- `nearestWardId` / `nearestWardDistance` は診断情報としてのみ保持（救済判定には未使用）。

### 変更ファイル
```
新規: tools/lib/ward-mode-integration-validator.js / tools/validate/ward-mode-integration.js
新規: tools/lib/footprint-ward-overlap.js / tools/study/unclassified-rescue.js
新規: tests/ward-mode-integration.test.js (6) / tests/footprint-ward-overlap.test.js (4)
新規: data/reports/ward-mode-integration-validation.json / unclassified-rescue-study.json
新規(コミット): public/map-data/osaka-city/boundaries/ward-classification-polygons.json  (1MB、HTMLがfetch)
変更: public/osaka_3d_buildings.ward-ux-v1.html  (basePath / WARD_DEFS dataReady / __n03WardRingsReady。+95/−43)
変更: tools/build-ward-building-datasets.js       (--layout flat)
変更: tools/lib/ward-building-dataset-validator.js (flat/nested layout 両対応)
変更: tools/lib/point-in-polygon.js               (nearestWardDistance — セッション4で追加済のもの)
変更: package.json / .gitignore / MAP24_PROGRESS.md
生成(gitignore): public/map-data/osaka-city/buildings/  (flat, 162MB)
```

### テスト結果
- `npm test`: **219 tests / 204 pass / 0 fail / 15 skip**（セッション4の 209/194 から +10）
- `tests/ward-mode-integration.test.js` 6/6、`tests/footprint-ward-overlap.test.js` 4/4
- `LIVECITY_HTML_PATH=public/osaka_3d_buildings.html node --test tests/html-regression.test.js`: **15/15**
- ward-ux-v1.html の `<script>` 構文チェック OK（node --check）
- `git diff --check` クリーン、protected baseline `fullward-v3.html` 未変更（git clean）
- `node tools/validate/ward-mode-integration.js`: **RESULT: PASS**

### 未解決事項 / registry dataReady
1. **registry.dataReady の 24区 true 更新（要ユーザー判断・指令#4）**: `config/wards/registry.json` は
   dataReady フィールドを持たない（設計上、生成物の有無で判定する分離方針）。dataReady 相当は
   ward-ux-v1.html の `WARD_DEFS[].dataReady` にあり、これは P1-5 で24区 true に更新済み。
   統合validator は PASS。**実ブラウザで24区の render/切替/dispose を確認できたら確定でよい**。
2. **実機確認が未実施**（Claude Code 環境にブラウザ無し）。下記手順。
3. WardBoundaryLayer 等3レイヤーは N03 fetch 完了後に1回だけ build。N03 が4秒以内に来ない/失敗した場合、
   21区の区境界線・ラベル・面発光・flyTo は出ない（建物表示・切替は正常）。`--no-merge` 相当の再試行はしていない。
4. セッション2〜3bの残課題（fetch-water `--no-merge`、official-boundaries-from-geojson.js の z）は据え置き。

### 実機確認事項（ユーザー、`npm run preview` → ward-ux-v1.html）
- 24区すべて Ward Selector から選択 → 建物が描画されるか（コンソール `[WARD-MANIFEST-READY] dataset=osaka-XXX`）
- 3区→別区、連続切替で: 重複表示なし / 旧区 mesh 残存なし / picking が旧区を拾わない / dispose 後 tile/mesh 0
- 長時間（10〜20回）切替でのメモリ増加、ward切替の体感時間、初期ロード時間
- N03区境界線/区名ラベル/面発光が24区で出るか（コンソール `[N03-WARD-RINGS] loaded 区数=24`）

### 次工程（道路・河川・公園・鉄道の24区展開）へ進めるか
**建物表示の統合は完了（コード/データ/検証）。実機確認を経て P1-6 へ。**
道路・河川は既に osaka_3d_buildings.html 側でセッション2の水域修正・validator が入っており、
24区展開には `config/areas/osaka-city.json` の tiling 設計（zoomLevels/tileSizeMeters）と
Overpass タイル取得の運用（ローカルPC）が前提。ward-ux-v1.html への都市レイヤー統合は P1-6 以降。

---

## 2026-09-01 セッション4: P1-4 大阪市24区 建物dataset / tile生成

### 実装内容
`ward-classification-polygons.json` と point-in-polygon 基盤で全584,490棟を24区へ分類し、
区別の建物 dataset / tile を生成した。

- **`tools/build-ward-building-datasets.js`**（`npm run data:build:ward-building-datasets`）:
  JSONL をストリームし、各建物の `representativePoint(fp)` を `classifyPointToWard` で24区へ判定。
  区別に tileSize=500 でタイル化し `data/processed/osaka-city/buildings/<wardId>/manifest.json` +
  `<wardId>/tiles/tile_<tx>_<tz>.json` を出力。root `manifest.json` + `unclassified/` も生成。
  `generateWardBuildingDatasets()` を export（テストから subprocess なしで呼べる）。
  出力先は data/processed/ または temp/ 配下に限定する安全ガードつき。building.ward は分類に不使用。
- **`tools/lib/point-in-polygon.js`**: `nearestWardDistance()` を追加（unclassified の原因分類用）。
- **`tools/lib/ward-building-dataset-validator.js`** + **`tools/validate/ward-building-datasets.js`**
  （`npm run data:validate:ward-building-datasets`）: 全区存在 / buildingId一意（全区∪unclassified）/
  同一建物が複数区に出ない / classified+unclassified+dup=入力全件 / finite / tile bbox整合
  （代表点が tile 座標と一致）/ manifest件数=tile実数 / 既存3区件数の変化。
- **`.gitignore`**: `data/processed/osaka-city/buildings/`（162MB・1,224ファイル）を除外。
  区別の件数・tileCount・bbox・unclassified内訳は `data/reports/building-dataset-generation.json`（コミット）に保持。

### 24区ごとの buildingCount / tileCount
| 区 | 棟 | tile | 区 | 棟 | tile |
|---|---|---|---|---|---|
| 生野区 | 46,212 | 50 | 阿倍野区 | 26,924 | 38 |
| 平野区 | 44,434 | 83 | 西淀川区 | 23,242 | 47 |
| 東住吉区 | 38,489 | 59 | 旭区 | 22,424 | 35 |
| 住吉区 | 34,930 | 51 | 鶴見区 | 22,068 | 46 |
| 東淀川区 | 34,685 | 66 | 東成区 | 21,976 | 29 |
| 淀川区 | 34,289 | 62 | 住之江区 | 21,608 | 67 |
| 城東区 | 32,447 | 48 | 中央区 | 18,279 | 52 |
| 西成区 | 29,204 | 40 | 北区 | 15,779 | 44 |
| 都島区 | 13,199 | 33 | 港区 | 15,489 | 34 |
| 此花区 | 13,437 | 58 | 天王寺区 | 14,244 | 30 |
| 西区 | 12,098 | 29 | 福島区 | 11,159 | 25 |
| 大正区 | 17,363 | 40 | 浪速区 | 10,133 | 30 |

合計: classified **574,112** 棟 / **1,096** タイル。代表点method: centroid 581,921 / interior-scanline 2,569 / bbox-center 0。

### unclassified 件数と割合・原因別
| 区分 | 件数 |
|---|---|
| **合計 unclassified** | **10,378（入力の 1.78%）** |
| ├ outside-all-wards | 10,374 |
| ├ ambiguous | 4 |
| └ invalid-footprint | 0 |

outside-all-wards の最近傍区境界までの距離: `<=25m` 2,286 / `<=100m` 4,831 / `<=500m` 3,257 / **`>500m` 0**。
→ **市外へ飛んだ建物・座標不良は 0**。すべて行政界から 500m 以内で、鶴見区(3,026)・旭区(2,397)・
東淀川区(1,103)・城東区(945)・平野区(890) 等、**淀川/寝屋川沿い・市の東端（守口市・大東市・東大阪市に接する縁）に集中**。
PLATEAU の建物範囲が N03 行政区ポリゴンをわずかに越えるケース。指令#6 どおり最近傍区へは割り当てず
`unclassified/` へ隔離（各建物に `nearestWardId` / `nearestWardDistance` を記録）。

### 既存3区との差
| 区 | 既存 ward-poc | N03 P1-4 | 差 |
|---|---|---|---|
| 住吉区 | 33,594 | 34,930 | +1,336 (+4.0%) |
| 東住吉区 | 38,266 | 38,489 | +223 (+0.6%) |
| 平野区 | 43,843 | 44,434 | +591 (+1.3%) |

- 既存 ward-poc は `build-ward-poc-data.cjs` が **boundaryStraddle / ambiguous を除外**したうえ、
  TOWN_POLYGONS(legacy)基準で分類したもの。P1-4 は全建物を N03 公式境界で1区へ確定するため増える方向。
- セッション3の vs-poc 比較（既存 ward-poc の建物を N03 で再判定 → 99.5〜99.8% が同一区）と整合。
- +4.0% の住吉区が最大。validator は ±5% を許容範囲としており **PASS**（超過時は warning、SUCCESS を妨げない設計）。

### validator 結果（実データ、`data/reports/ward-building-datasets-validation.json`）
```
[PASS] all-datasets-present            24区 dataset 存在
[PASS] no-registry-external-dataset
[PASS] building-id-unique              全区∪unclassified で一意、重複 0
[PASS] no-building-in-two-wards
[PASS] coords-finite
[PASS] tile-bbox-consistent            代表点と tile 座標が全件一致
[PASS] classified-plus-unclassified-equals-input   584,490 = 574,112 + 10,378 + 0（恒等式 true）
[PASS] input-total-matches-jsonl
[PASS] known-3-wards-count-stable      +4.0% / +0.6% / +1.3%（±5%以内）
RESULT: PASS
```

### 変更ファイル
```
新規: tools/build-ward-building-datasets.js
新規: tools/lib/ward-building-dataset-validator.js
新規: tools/validate/ward-building-datasets.js
新規: tests/ward-building-datasets.test.js          (8 tests)
新規: data/reports/building-dataset-generation.json / ward-building-datasets-validation.json
変更: tools/lib/point-in-polygon.js                 (nearestWardDistance 追加)
変更: .gitignore                                     (data/processed/osaka-city/buildings/ を除外)
変更: package.json                                   (test +1、data:build/validate:ward-building-datasets)
生成(gitignore): data/processed/osaka-city/buildings/  24区 manifest + 1,096 tile + unclassified（162MB）
```

### テスト結果
- `npm test`: **209 tests / 194 pass / 0 fail / 15 skip**（セッション3bの 201/186 から +8）。
- `tests/ward-building-datasets.test.js` 8/8（区外の隔離・距離内訳・重複ID・不正fp・dry-run・validator 各種）。
- `LIVECITY_HTML_PATH=... node --test tests/html-regression.test.js`: **15/15**。
- `git diff --check`: 問題なし。
- `data/processed/osaka-city/buildings/` は gitignore で除外され、コミット対象外（`git status --ignored` で `!!` 確認）。

### 未解決事項
1. **unclassified 10,374棟の P1-5 での扱い（要判断）**: 全件が行政界 500m 以内（>500m は 0）。
   (a) 最近傍区へスナップして表示 / (b) unclassified レイヤーとして別扱い / (c) 非表示。
   淀川・寝屋川沿いと市東端に集中しているため、河川縁・市境の帯の見た目に影響する。
2. **住吉区 +4.0%** は validator 許容内だが、他2区（+0.6% / +1.3%）より大きい。ward-poc が
   boundaryStraddle を除外していた差の範囲と推定されるが、P1-5 で目視確認の余地あり。
3. registry の dataReady は自動切替していない（指令#10）。24区すべて dataReady 候補。
4. 建物 dataset は 162MB で gitignore。CI/他環境では `npm run data:build:ward-building-datasets` で再生成が必要
   （入力 `temp/ward-poc-all-buildings.jsonl` も gitignore、ローカルにある前提）。
5. セッション2〜3の残課題（fetch-water `--no-merge`、`official-boundaries-from-geojson.js` の z、
   `public/osaka_3d_buildings.html` の未コミット OSM_WATER 変更）は据え置き。

### P1-5（24区表示統合）へ進めるか
**進める。** 24区すべての建物 dataset / tile（既存3区と同一の manifest・tile 形式、znorth-neg-v1、
buildingId 一意、恒等式成立）が生成され validator PASS。unclassified は隔離済みで原因も明確。
P1-5 は上記1（unclassified の表示方針）を決めれば、root manifest → 区別 manifest → tile の
3段構成をそのまま HTML 側の 24区ローダへ接続できる。registry の production 切替はユーザー判断。

---

## 2026-08-31 セッション3b: N03 z軸の恒久修正（USER_DECISION (a)）

### 実装内容
セッション3で発見した「N03取り込みの z 軸が znorth-neg-v1 と反転」を、USER_DECISION 2026-08-31 (a) に従い
**取り込みツール側で恒久修正**した。

- **`tools/lib/n03-boundaries.js`**: `ingestN03FeatureCollection` の projection 適用箇所で、
  `convertGeometryToRings`（geoToLocal 由来 = 北がz正）の結果に対し新しいヘルパ `toZNorthNeg`
  （`[x, z] → [x, -z]`）を適用。これで実座標と `coordinateConvention: "znorth-neg-v1"` が一致する。
  `tools/lib/projection.js` は**変更していない**（roads/parks/waterways/facilities/landuse 変換と共有のため）。
- **`data/raw/osaka-city/n03/N03-2026_27.geojson`**（実N03、gitignore下、2.95MB、基準日2026-01-01）を入力に、
  出典metadata（license / referenceDate 2026-01-01 / retrievedUrl / retrievedAt）を維持して
  `administrative-boundaries.json` を再生成。

### 再生成・再検証（すべて実データ）
| 項目 | 結果 |
|---|---|
| 1. `administrative-boundaries.json` | 再生成（全13,577行の z 座標が符号反転）。24区・znorth-neg-v1・出典完備 |
| 2. `ward-classification-polygons.json` | 再生成。`zAxisApplied: "as-is"`（auto検出で補正不要と判定）|
| 3. boundary validator | 全チェック **PASS**（`known-wards-stable` 含む） |
| 4. ward classification validator | 全チェック **PASS** |
| 5. 既存3区との比較 | 住吉99.82% / 東住吉98.52% / 平野99.50%、不一致 0.73%（**セッション3と完全一致**。判定 OK） |
| 6. `npm test` / HTML regression | **201 tests / 186 pass / 0 fail / 15 skip** ／ html-regression **15/15** |

- N03 centroid z（住吉 −377 / 東住吉 −1651 / 平野 −971）が TOWN_POLYGONS 参照（−283 / −1610 / −1120）と
  同符号・近い大きさに揃った。
- 建物分類の区外は 10,374棟（1.8%）でセッション3の自動補正時と同一 → 上流修正と自動補正が同じ出力を生む。

### build-ward-polygons.js の z-axis auto 補正
移行安全策・異常検出として残置。正常な再生成データでは `zAxisApplied: "as-is"` になることを
`tests/ward-polygons.test.js` で検証（合成データ＋実データの2ケース）。

### 変更ファイル（セッション3bぶん）
```
変更: tools/lib/n03-boundaries.js                (toZNorthNeg 追加、変換時に z negate)
変更: tests/n03-boundaries.test.js               (znorth-neg-v1 = 北ほど z 小 のテスト追加)
変更: tests/ward-polygons.test.js                (正常データで as-is / 実データ as-is のテスト追加)
変更: data/processed/osaka-city/boundaries/administrative-boundaries.json   (z 符号反転で再生成)
変更: data/processed/osaka-city/boundaries/ward-classification-polygons.json (再生成)
変更: data/reports/boundary-ingestion-validation.json / ward-classification-validation.json /
      building-ward-classification.json / ward-classification-vs-poc.json    (再生成)
変更: config/areas/osaka-city.json               (statusNote の z軸記述を「修正済み」に更新)
```

### 未解決事項（セッション3b時点）
- `tools/ingest/official-boundaries-from-geojson.js` も同じ `convertGeometryToRings` を使うが、
  こちらの出力は e-Stat 属性マスタ（geometry ほぼ null）で描画用途ではないため今回は未変更。
  将来 e-Stat の実ポリゴンを通す場合は同様の z negate が必要。
- 区外 10,374棟（1.8%）の P1-4 での扱い（最近傍区スナップ / 除外）は未決。
- `public/osaka_3d_buildings.html` の未コミット変更（ユーザーの OSM_WATER 再生成）と、
  `fetch-water.js --no-merge` 未対応（セッション2残課題）は据え置き。

### P1-4へ進める状態か
**進める。** z軸は取り込み時点で恒久的に znorth-neg-v1 に揃い、build-ward-polygons.js の補正は不要（as-is）。
P1-4 は `ward-classification-polygons.json` をそのまま使える。

---

## 2026-08-31 セッション3: P1-3 Ward polygon / 建物分類基盤

### 実装内容
N03行政区境界（`data/processed/osaka-city/boundaries/administrative-boundaries.json`、commit 94868ef）から
大阪市24区の point-in-polygon 判定基盤を実装した。

1. **Ward polygon生成** — `tools/lib/ward-polygons.js` + `tools/build-ward-polygons.js`
   （`npm run data:build:ward-polygons`）。N03取り込みが flat 化した `rings[]` を、巻き順に依存せず
   **包含関係（ネスト深さ）**で `{outer, holes}` へ再構成。飛び地・穴・穴の中の島に対応。
   出力: `data/processed/osaka-city/boundaries/ward-classification-polygons.json`
   （24区 / 此花区9・住之江区5・港区3・大正区2 polygon飛び地 / 東淀川区に hole 1 / znorth-neg-v1）。
2. **point-in-polygon** — `tools/lib/point-in-polygon.js`。`pointInRing`（既存 build-ward-poc-data.cjs と
   同一 even-odd）／`pointInPolygonWithHoles`／`pointInWard`（bbox即時棄却つき・飛び地対応）／
   `classifyPointToWard`（区境界の縫い目に乗った点は 4近傍多数決で片側へ寄せ、決着しなければ ambiguous）。
3. **建物代表点** — `tools/lib/building-representative-point.js`。面積重心 → 重心が凹形状で外に出たら
   z水平スキャンラインの最長内部区間の中点 → それも失敗なら bbox 中心（method を記録）。
   実データ 584,490 棟で centroid 581,921 / interior-scanline 2,569 / bbox-center 0。
4. **validator** — `tools/lib/ward-classification-validator.js` + `tools/validate/ward-classification.js`
   （`npm run data:validate:ward-classification`）。24区網羅／wardId重複／registry外／finite／ring正常／
   相互排他（各区の内部点→自区）／既存3区の内部点→自区／大阪市外点→どの区にも入らない、を検証。
   実データで **全チェック PASS**。
5. **既存3区との比較** — `tools/compare/ward-classification-vs-poc.js`。下記「比較結果」。
6. **次工程への出力** — `classify-buildings-by-ward.js --jsonl-out` で `{buildingId, wardId}` を出力でき、
   P1-4（区別 dataset/tile 生成）へそのまま渡せる。

### 【重要な発見】N03取り込みの z 軸が znorth-neg-v1 と反転している
- `tools/lib/n03-boundaries.js` は出力に `coordinateConvention: "znorth-neg-v1"` を付けるが、実際には
  `tools/lib/projection.js` の `geoToLocal`（`z = (lat-centerLat)*metersPerDegree`、**北 = z 正**）で変換しており、
  Live City本体の znorth-neg-v1（**北 = z 負**）と **z 符号が反転**している。x・原点は一致。
- 証拠: HTML埋め込み `TOWN_POLYGONS`（znorth-neg-v1）の実測centroidと N03 centroid の比較 —
  住吉区 z: TOWN −283 / N03 +377、東住吉区 z: −1610 / +1651、平野区 z: −1120 / +971（x はすべて ±200m 以内で一致）。
- 補正せず建物分類すると 584,490 棟中 **519,126 棟が「どの区にも属さない」**（南部の overlap 帯だけ分類できる）。
  z を反転すると **区外 10,374 棟（1.8%）**まで下がり全24区に建物が入る。
- **対応（今セッション）**: `tools/build-ward-polygons.js` が住吉区・東住吉区・平野区の実測centroidと
  突き合わせて z 反転を **自動検出**し（`--z-axis auto` 既定）、z を negate して znorth-neg-v1 に揃える。
  出力 metadata に `zAxisApplied: "negate"` と検出根拠を記録。`--z-axis as-is|negate` で明示指定も可。
- **恒久修正は要ユーザー判断（NEEDS_USER_DECISION）**: (a) `tools/lib/n03-boundaries.js` で projection 適用時に
  z を negate し、committed の `administrative-boundaries.json` を再生成する / (b) `tools/lib/projection.js` の
  `geoToLocal` 自体を znorth-neg-v1 化する（roads/parks/waterways/facilities/landuse 変換 全てに波及、
  現状それらの出力は HTML 未接続なので影響は限定的だが要精査）/ (c) 現状の build-ward-polygons.js の
  自動補正で運用を続ける。AUTODEV_RULES.md 4条（座標系はユーザー確認）に該当するため自動では選ばない。

### 24区polygon生成結果
```
24/24区 生成。飛び地: 此花区9 / 住之江区5 / 港区3 / 大正区2。hole: 東淀川区1。
z軸: auto検出で negate 適用（東住吉区・平野区で参照と符号反転を確認）。
validator: all-24-wards-present / no-duplicate / no-registry-external / coords-finite /
           rings-valid / wards-self-consistent / known-3-wards-classify /
           outside-city-unclassified すべて PASS。
```

### 既存3区との比較結果（`data/reports/ward-classification-vs-poc.json`）
既存 ward-poc dataset（TOWN_POLYGONS = legacy-unverified だが znorth-neg-v1 の座標リファレンス）の
建物を N03 point-in-polygon で再判定:

| 区 | 建物 | N03一致 | 不一致内訳 |
|---|---|---|---|
| 住吉区 | 33,594 | 33,535 (**99.82%**) | 東住吉22 / 阿倍野37 |
| 東住吉区 | 38,266 | 37,701 (**98.52%**) | 阿倍野179 / 平野208 / 生野91 / 住吉57 / 区外30 |
| 平野区 | 43,843 | 43,625 (**99.50%**) | 東住吉107 / 生野40 / 区外71 |
| 合計 | 115,703 | | **不一致 842 (0.73%)** → 判定 OK（境界帯の軽微な差のみ） |

- 不一致サンプルは 住吉/東住吉 の境界（x ≈ −225〜−237 の縦帯）に集中。TOWN_POLYGONS の legacy 頂点座標と
  N03 公式境界の差 = 帯状の境界付近のみ。**大規模不一致なし。**
- `building.ward` 属性は **584,490 棟すべてが "東住吉区"** という壊れたプレースホルダで、分類情報を持たない。
  P1-3指令どおり分類には一切使用していない（一致率は診断値としてのみ記録）。N03 point-in-polygon が authoritative。

### 変更ファイル
```
新規: tools/lib/point-in-polygon.js
新規: tools/lib/building-representative-point.js
新規: tools/lib/ward-polygons.js
新規: tools/lib/ward-classification-validator.js
新規: tools/build-ward-polygons.js
新規: tools/validate/ward-classification.js
新規: tools/classify-buildings-by-ward.js
新規: tools/compare/ward-classification-vs-poc.js
新規: tests/point-in-polygon.test.js              (10 tests)
新規: tests/ward-polygons.test.js                 (16 tests)
新規: tests/ward-classification-validator.test.js (10 tests)
新規: data/processed/osaka-city/boundaries/ward-classification-polygons.json  (生成物)
新規: data/reports/ward-classification-validation.json / building-ward-classification.json / ward-classification-vs-poc.json
変更: package.json  (test へ3ファイル追加、data:build:ward-polygons / data:validate:ward-classification / data:classify:buildings)
変更: config/areas/osaka-city.json  (BOM除去・LF化。矛盾していた statusNote を実態へ更新。status は production のまま。z軸注意を追記)
変更: tests/boundary-ingestion-validator.test.js  (area config 読込を BOM 許容に)
```

### テスト結果
- `npm test`: **198 tests / 183 pass / 0 fail / 15 skip**（セッション2の 167/152 から +31）。
- `tests/point-in-polygon.test.js` 10/10、`tests/ward-polygons.test.js` 16/16、
  `tests/ward-classification-validator.test.js` 10/10。
- `LIVECITY_HTML_PATH=public/osaka_3d_buildings.html node --test tests/html-regression.test.js`: **15/15 pass**。
- `git diff --check`: 問題なし（CRLF警告のみ）。
- 実データ: build-ward-polygons 24/24 OK、validate PASS、classify 恒等式成立、vs-poc 0.73% 不一致（OK判定）。

### 未解決事項
1. **N03 z軸反転の恒久修正（NEEDS_USER_DECISION）** — 上記(a)(b)(c)から選択が必要。
   現状は build-ward-polygons.js の自動補正で機能しているが、`administrative-boundaries.json` の
   `coordinateConvention: "znorth-neg-v1"` ラベルは厳密には不正確なまま。
2. `building.ward` 属性が全件 "東住吉区" の壊れたデータ。`temp/ward-poc-all-buildings.jsonl` を再生成する
   なら属性を正しく埋めるか、削除して N03 分類を正本にするのが望ましい。
3. 区外 10,374 棟（1.8%）— 海岸・河川縁で PLATEAU が行政界をわずかに越える建物と推定。P1-4 で
   「最近傍区へスナップ」するか「区外として除外」するかの方針決めが必要。
4. `public/osaka_3d_buildings.html` に未コミットの変更あり（ユーザー側の OSM_WATER 再生成と推定）。
   ただし `node tools/validate/water-geometry.js --html ...` は依然 `relation/18530061-63`（大和川河岸）を
   FAIL 検出する。原因: `tools/fetch-water.js` は既定で HTML埋め込みの OSM_WATER をマージし、
   `seen` セットで同一 id の relation を再取得スキップするため、旧い壊れた area レコードが残る。
   → 再生成時は `--no-merge` を付けるか、`relation/*` の旧レコードを事前に除去する必要がある（セッション2の残課題）。
   なお WaterLayer 側の `ringHasSpanningEdge` ガードにより、ブラウザ描画では巨大三角形は出ない。

### P1-4へ進める状態か
**進める。** 24区の Ward polygon（`ward-classification-polygons.json`）と point-in-polygon ライブラリ、
建物代表点、validator が揃い、既存3区との整合（99%+）も確認済み。
P1-4（残り21区の区別 dataset/tile 生成）は次を入力にできる:
`ward-classification-polygons.json` → `representativePoint(building.fp)` → `classifyPointToWard` →
`{buildingId → wardId}`（`classify-buildings-by-ward.js --jsonl-out` で出力可）→ `build-ward-poc-data.cjs` 相当の
tile 生成。ただし上記1（z軸）を恒久修正するか、P1-4 も build-ward-polygons.js 経由の補正済み polygon を使うことを前提にする。

---

## 2026-08-31 セッション2: 河川geometry修正（OSM multipolygon連結）

### 実行したタスク
`tools/fetch-water.js` / `tools/convert/waterways.js` を調査し、OSM multipolygon relation の
outer member way を端点一致で連結して閉リングを構成するよう修正した。

### 調査結果（確定した原因）
- 旧 `tools/fetch-water.js` は relation の outer member way を **1本ずつ独立した閉ポリゴン**として
  `THREE.ShapeUtils.triangulateShape` に渡していた。member way は単独では閉じていないため、
  三角形分割時に**終点→始点をむすぶ暗黙の閉合辺**が生成される。
- 埋め込み済み `OSM_WATER` を実測したところ、`relation/18530061`〜`18530063`（大和川河岸）が
  それぞれ複数の `area` レコードに分裂し、各レコードの暗黙閉合辺が **4466m / 4879m / 5843m** と
  地物全体（約2km幅の河岸）を横断していた。これが「川面を横切る巨大三角形」の正体。
- `tools/validate/water-geometry.js --html public/osaka_3d_buildings.html` で現行ビルドを検証すると
  この6レコードが `no-oversized-segments` FAIL として検出される（`data/reports/water-geometry-validation.json`）。

### 修正内容
- **`tools/lib/osm-multipolygon.js`（新規）**: `stitchWays()` / `assembleMultipolygon()`。
  - outer/inner を role で分け、端点一致で way を連結（逆順wayも吸収）。
  - 連結しても閉じないリング片は `unclosed` として返す（黙って三角形分割しない）。
  - inner ring（中州）を保持し、内包する outer へ point-in-polygon で割り当てる。
- **`tools/lib/geometry-anomaly.js`（新規）**: `analyzeRing()`。巨大セグメント（中央値×20 かつ >800m、
  または bbox対角比指定時はその比）・自己交差（O(n²)）・非有限・退化・**暗黙閉合辺**を検出。
  `tools/lib/boundary-ingestion-validator.js` の重複ロジックをここへ集約（挙動は不変、テスト14件green）。
- **`tools/lib/water-geometry-validator.js` / `tools/validate/water-geometry.js`（新規）**: OSM_WATER形式
  （JSON または HTML埋め込み）の幾何異常検証CLI。`npm run data:validate:water`。
- **`tools/fetch-water.js`（変更）**: `--overpass` の relation 分岐を `assembleMultipolygon` ベースへ。
  面レコードに `holes` を追加。未連結フラグメントは `stats.skippedUnclosed` に計上し警告出力、描画に出さない。
  クエリに `relation["waterway"="riverbank"]` を追加。way / line の既存挙動は不変。
- **`tools/convert/waterways.js`（変更）**: relation 分岐を追加（同じ共通libを使用）。`convertWaterwaysWithReport()`
  で `unclosed` も返す。既存の way→line / 閉way→area の出力契約（`{type,name,p}`）は維持し `kind`/`holes` を追加。
- **`public/osaka_3d_buildings.html` WaterLayer（変更）**:
  - `appendArea` が `holes`（中州）を `triangulateShape` へ渡すよう対応。
  - `ringHasSpanningEdge()` ガードを追加。地物を横断する巨大な辺（暗黙閉合辺含む）を持つリングは
    三角形分割せずスキップ。これにより**データ再生成前の現行ビルドでも大和川の巨大三角形が描画されなくなる**。
  - protected baseline `osaka_3d_buildings.fullward-v3.html` は変更していない。
- **`tools/lib/area.js`（変更）**: `loadAreaConfig` が UTF-8 BOM 付き area config も読めるよう先頭BOM除去
  （下記「未解決/注意」参照）。

### 変更ファイル一覧
```
新規: tools/lib/osm-multipolygon.js
新規: tools/lib/geometry-anomaly.js
新規: tools/lib/water-geometry-validator.js
新規: tools/validate/water-geometry.js
新規: tools/lib/__fixtures__/water/overpass-water-sample.json
新規: tests/osm-multipolygon.test.js         (8 tests)
新規: tests/water-geometry.test.js           (7 tests)
新規: data/reports/water-geometry-validation.json  (現行ビルドの検出結果=6件FAIL、修正前の記録)
変更: tools/fetch-water.js
変更: tools/convert/waterways.js
変更: tools/lib/boundary-ingestion-validator.js  (共通libへ委譲。挙動不変)
変更: public/osaka_3d_buildings.html            (WaterLayer のみ)
変更: tools/lib/area.js                          (BOM許容)
変更: package.json                               (test へ2ファイル追加、data:validate:water 追加)
```

### テスト結果
- `npm test`: **167 tests / 152 pass / 0 fail / 15 skip**（セッション1の 152/137 から +15）。
- `tests/osm-multipolygon.test.js` 8/8、`tests/water-geometry.test.js` 7/7。
- `LIVECITY_HTML_PATH=public/osaka_3d_buildings.html node --test tests/html-regression.test.js`: **15/15 pass**
  （WaterLayer変更後も RoadLayer/ParkLayer/BLDGS/LabelLayer/行政区境界の重複・消失なし、JS構文OK）。
- 「大和川の巨大三角形が消えることの確認」: fixture（大和川を模した細長い河岸relation、outer 3本＋
  逆順1本＋中州1本）を新パイプラインに通すと `validateWaterGeometry` が `oversizedSegments: 0` で PASS。
  旧挙動を再現した3点レコード（暗黙閉合辺≒2km）は `no-oversized-segments` FAIL として検出される。
- `git diff --check`: 空白・改行問題なし（CRLF警告のみ。既存ファイルと同じ扱い）。

### 未解決 / 注意
1. **git index.lock**: 作業中 `.git/index.lock` が別プロセス（ユーザー側のgit / OneDrive）に掴まれており、
   Claude Code 側から git 操作ができなかった。今回のセッション2の変更はコミットしていない（未ステージ）。
2. **worktree から2ファイルが消えている**: `data/processed/osaka-city/boundaries/administrative-boundaries.json`
   と `data/reports/boundary-ingestion-validation.json`（どちらもコミット `94868ef` に含まれる）が
   作業ツリーから欠落し `deleted` 表示になっている。Claude は削除していない（OneDrive同期ずれか
   index.lock の影響と推定）。**コミットしないこと。`git restore <この2ファイル>` で復元できる**。
   参考: HEAD版の administrative-boundaries.json を検証したところ、24区・znorth-neg-v1変換済み・
   出典metadata完備で `tools/validate/boundary-ingestion.js` は全項目 PASS（P1-2の実データ検証は完了）。
3. **`config/areas/osaka-city.json` の BOM**: ユーザーがエディタで status を production へ変更した際に
   UTF-8 BOM 付き＋CRLF で保存され、`JSON.parse` が落ちるようになっていた。BOMなし・LF で書き直し、
   併せて `loadAreaConfig` に BOM 除去を追加した。**このファイルは BOMなし・LF で保存すること**。
   なお status は `staged` に戻した（BOM修正で書き直しが必要だったため）。コミット `94868ef` は
   `production` にしていたので、実データ検証が済んでいる以上 production へ戻して良い（1語変更）。
4. **`tools/convert/index.js` は `unclosed` を surface しない**: `convertWaterways()` は後方互換のため
   items のみ返す。オーケストレータで未連結relationを警告したい場合は `convertWaterwaysWithReport()` へ
   切り替える小改修が必要（今回スコープ外）。
5. 河川ライン（大和川など複数wayに分割された長い川の中心線）の way 連結は未実装。断片化・隙間は
   残る可能性があるが、「巨大三角形」は area 側の問題であり本修正で解消。line stitching は別タスク。
6. 実 `OSM_WATER` の再生成（`node tools/fetch-water.js --overpass ...`）はネットワーク必須のためローカルPC作業。

### 次に進むべき作業
- **A（ユーザー、ローカルPC）**: `git restore` で欠落2ファイルを復元 → セッション2の変更をレビュー・コミット →
  `node tools/fetch-water.js --overpass --coordinate-config data/buildings/coordinate-config.json --html public/osaka_3d_buildings.html`
  で `OSM_WATER` を再生成 → `npm run data:validate:water -- --html public/osaka_3d_buildings.html` が PASS することを確認 →
  ブラウザ（`npm run preview`）で大和川周辺の巨大三角形が消えていること、中州が抜けていることを目視確認。
- **B（次セッション）**: 河川ライン（waterway=river/canal の複数way）の端点連結。同 `tools/lib/osm-multipolygon.js`
  の `stitchWays` を line 用に流用できる。
- **C（次セッション）**: P1-3 — N03 24区ポリゴンから point-in-polygon 用 Ward polygon を生成するパイプライン設計。

---

## 2026-08-31 セッション1: N03エリア基盤 + 境界validator（P1-1/P1-2の一部）

### 実行したタスク
1. リポジトリ現状の全面調査（24区基盤の進捗、道路・河川geometryの乱れの原因）
2. `config/areas/osaka-city.json` の新設（24区共通エリア定義）
3. P1-2 境界取り込みvalidator（`tools/validate/boundary-ingestion.js` + lib + テスト）の実装
4. 実N03 24区データ（`temp/n03-validation/osaka-city-wards.json`）に対する検証実行
5. `MAP24_P1_RUNBOOK.md`（ローカルPCでの再取り込み・検証手順）作成

### 調査結果

**24区基盤（想定より進捗あり）**
- `config/wards/registry.json` は24区すべてを保持済み。
- `temp/n03-validation/osaka-city-wards.json`（本日更新、gitignore下）に、実N03 2026大阪府データから
  抽出済みの24区分の生 MultiPolygon（WGS84）が存在。`missingWards: []`。9ポリゴン(此花区: 夢洲/舞洲)、
  5ポリゴン(住之江区: 咲洲)など飛び地も正しく統合されている。
- ただし metadata の `license` / `referenceDate` / `retrievedUrl` が **null**（出典未記録）。
- まだ無いもの: `config/areas/osaka-city.json`（→本セッションで作成）、znorth-neg-v1 変換済み出力、
  P1-2 validator（→本セッションで作成）、21区の point-in-polygon 用ポリゴン。

**河川geometryの乱れ（原因特定）** — ※本セッションでは未修正。次セッション対象。
- `tools/fetch-water.js` に2つのバグ:
  1. 河川ライン（大和川など長い川）が複数OSM wayに分かれているのに連結せず、way単位で独立リボン化
     → 断片化・隙間。
  2. 河岸エリア（`relation/18530061-63` 等の multipolygon）の outer メンバー way を1本ずつ独立した
     「閉リング」として `triangulateShape` に渡している。実際は複数 member way を順に連結して1リングを
     作る必要がある。未連結の部分 way を閉ポリゴン扱いするため、**川を横断する最大1431mの巨大三角形**が
     生成される。inner ring（中州）も欠落。
- 実データ: `public/osaka_3d_buildings.html` 埋め込みの OSM_WATER 130件中 **12件が300m超の内部ジャンプ**。
- これが「川の輪郭の崩れ / line・polygonの乱れ / 他地物との不自然な重なり」の正体。

**道路geometryの乱れ（軽微）**
- OSM_ROADS 7047本 / 36518点中、500m超のセグメントジャンプは **1件のみ**。
- `tools/convert/roads.js` の `mergeParallelDuplicates`（並走上下線の統合）は機能している。
- 優先度は河川より低い。way単位の未連結は存在するが視覚的実害は小さい。

**ドキュメントと実コードの乖離（記録のみ、修正せず）**
- CLAUDE.md は「roads.json / waterways.json は存在しない」「HTMLは3800行」と記載しているが、実際は
  `osaka_3d_buildings.html`（6917行）に `OSM_ROADS` / `OSM_WATER` / `OSM_PARKS` が直接埋め込まれている。
  AUTODEV_RULES.md 1条により、ドキュメントの自動書き換えはせず記録に留める。ユーザー判断で更新のこと。

### 修正内容（新規追加のみ。既存ファイルの変更は package.json の test スクリプトのみ）

- **`config/areas/osaka-city.json`（新規）**
  - projection: osaka-sumiyoshi と数値完全一致（centerLat 34.604208 / centerLon 135.52502 /
    metersPerDegree 111320）。既存3区の建物座標は一切変化しない。
  - bbox: 実N03 24区ポリゴンの外接矩形（S34.586154/W135.343508/N34.768849/E135.599350）を外側へ丸めた
    S34.585/W135.342/N34.770/E135.601。
  - `status: "staged"`（production未確定。N03の出典記録付き再取り込み + validator通過で production へ）。
  - 都市レイヤーは tiling 前提（`tiling.enabled: false` + 注記）。24区展開は未着手であることを明記。
  - demographics.targetWards に24区名を列挙。
- **`tools/lib/boundary-ingestion-validator.js`（新規）**: `validateBoundaryIngestion()` / `evaluateRing()`。
  例外を投げず構造化結果を返す。自己交差は O(n²) セグメント交差スキャン、未連結multipolygonは
  「同一リング内の中央値セグメント長の20倍かつ800m超」ヒューリスティックで検出。
- **`tools/validate/boundary-ingestion.js`（新規）**: CLI ラッパ。`--input` / `--area` / `--report`。
  error重大度の失敗があれば exit 1。
- **`tests/boundary-ingestion-validator.test.js`（新規）**: 14テスト。
- **`package.json`（変更）**: test スクリプトへ `tests/n03-boundaries.test.js` と
  `tests/boundary-ingestion-validator.test.js` を追加（n03テストは従来 npm test 対象外だった）。
  `data:validate:boundaries` スクリプトを追加。
- **`MAP24_P1_RUNBOOK.md`（新規）**、**`MAP24_PROGRESS.md`（新規、本ファイル）**

### 変更ファイル一覧
```
新規: config/areas/osaka-city.json
新規: tools/lib/boundary-ingestion-validator.js
新規: tools/validate/boundary-ingestion.js
新規: tests/boundary-ingestion-validator.test.js
新規: MAP24_P1_RUNBOOK.md
新規: MAP24_PROGRESS.md
変更: package.json (test スクリプト + data:validate:boundaries)
```

### テスト結果
- `npm test`: **152 tests / 137 pass / 0 fail / 15 skip**（従来 116/101/0/15 から +36 tests。
  15 skip は従来どおり html-regression.test.js が標準候補パスに HTML が無いため）。
- `node --test tests/n03-boundaries.test.js`: 22 pass / 0 fail。
- `node --test tests/boundary-ingestion-validator.test.js`: 14 pass / 0 fail。
- 実データ検証: `node tools/validate/boundary-ingestion.js --input temp/n03-validation/osaka-city-wards.json --area osaka-city`
  → `provenance-recorded` の WARN 以外すべて PASS。自己交差・巨大セグメントなし。**RESULT: PASS**。
- `git diff --check`: 問題なし。作業ツリーは既存3区・protected HTML・production データを一切変更していない。

### 未解決事項
1. **実N03の出典付き再取り込み**（ユーザー選択済み: 「出典を記録して再取り込みしてから」）。
   `temp/n03-validation/osaka-city-wards.json` は license/referenceDate/retrievedUrl が空。
   `MAP24_P1_RUNBOOK.md` の手順でローカルPCから再実行が必要（元N03 GeoJSONの入手にネットワーク必要）。
2. `config/areas/osaka-city.json` は `status: "staged"`。上記1と validator 通過まで production 化しない。
3. **河川geometryの乱れ**（`tools/fetch-water.js` の multipolygon リング未連結・way未連結）は原因特定のみ。
   修正はネットワーク再取得を伴うため次セッション + ローカルPC作業。
4. 21区の point-in-polygon 用ポリゴン（Ward classification 用）は未生成（P1-3）。
5. 24区の都市レイヤー（道路・公園・鉄道・水域）タイル化は未着手（P1-3、`tiling` 設計が必要）。

### 次に進むべき作業
- **A（ユーザー、ローカルPC）**: `MAP24_P1_RUNBOOK.md` P1-1 手順で N03 を出典付き再取り込み →
  `tools/validate/boundary-ingestion.js` で検証 → PASS なら `config/areas/osaka-city.json` の
  `status` を production へ、`data/processed/osaka-city/boundaries/administrative-boundaries.json` をコミット。
- **B（次セッション）**: `tools/fetch-water.js` / `tools/convert/waterways.js` の multipolygon リング組み立て
  修正（outer メンバー way の連結、inner ring 保持）+ 未連結セグメント検出 validator + fixture テスト。
  実データ再取得はローカルPC。
- **C（次セッション）**: P1-3 — N03 24区ポリゴンから point-in-polygon 用 Ward polygon を生成する
  パイプライン設計（`tools/build-ward-poc-data.cjs` との接続、building.ward属性を正本にしない）。
