# 大阪市24区化 進捗レポート

大阪市24区の地図基盤構築（第一目標）の作業ログ。新しいエントリを上に追記する。

---

## 2026-09-09 セッション6BG: ブランドロゴ差し替え（左上テキストロゴ → 正式 Live City ロゴ）

トップバー左上の仮テキストロゴ（`<span class="lc-dot">Live City <small>大阪</small>`）を、
ユーザー提供の正式ロゴへ差し替え。**対象は `ward-ux-v1.html` のみ**（production / protected は不変）。

- **マスター**: `public/assets/logo/livecity-logo-source.png`（2172×724 / 8bit RGBA / **元から背景透過**）
- **生成ツール（新規 `tools/build-logo-assets.js`・`npm run assets:logo`）**:
  ImageMagick / sharp / PIL がこの環境に無いため、**Node 組み込み zlib のみ**で PNG デコード/エンコードを実装
  （`convert` は Windows の FAT 変換ツールで ImageMagick ではなかった）。依存追加なし。
  - trim → エンブレム／ワードマーク境界を全透明の縦帯から自動検出（gap x729-766）
  - タグライン "SEE MORE LIFE" を**低彩度グレーとして画素単位で検出・除去**
    （矩形一括消去はせず "City" の y ディセンダ〔ネイビー〕を保持。除去 3,664px / bbox x859-1624,y443-481）
  - dark 版は**ワードマーク領域の低輝度画素のみ白へ寄せる**（エンブレムの配色は不変＝ブランド忠実性）
  - 縮小は面積平均（box filter）。拡大はしない（519px → 120px）
- **生成アセット**（すべて透過・縦横比維持）:
  | file | size | 用途 |
  |---|---|---|
  | `livecity-logo-horizontal.png` | 431×120 (3.592) | PC トップバー（文字付き横長） |
  | `livecity-logo-horizontal-dark.png` | 431×120 | 暗背景用（将来のダーク UI 用フック） |
  | `livecity-logo-icon.png` | 169×120 (1.408) | 狭幅（≤430px）用エンブレム |
- **HTML/CSS（`ward-ux-v1.html`）**:
  - `<div id="lc-brand">` → **`<a id="lc-brand" href="./osaka_3d_buildings.ward-ux-v1.html">`**（ホーム導線）
    `aria-label="Live City ホーム"` / `<img alt="Live City">`
  - `<picture>` + `source media="(max-width:430px)"` で狭幅はアイコン版へ自動切替
  - `height:30px; width:auto; object-fit:contain`（PC）/ `24px`（≤768px）でつぶれ・引き伸ばしを禁止
  - クリック領域 40px（PC）/ **44px（モバイル・タップ最小サイズ）**、hover/active の背景フィードバック
  - `body.lc-dark #lc-brand img{content:url(...-dark.png)}` をフックとして用意
    （**Top Bar は常に `rgba(255,255,255,0.94)` の白系固定**で `prefers-color-scheme` も night テーマも
    UI シェルに無いため、OS ダークモードでの自動切替は行わない＝白ロゴが白バーに乗る事故を回避）
  - 未使用になった `.lc-dot` CSS を除去
- **検証**: ライト版@30px は明背景で完全可読／暗背景ではネイビーが消失することを描画確認し
  ダーク版の必要性を実証。@60px でぼやけ無し。トップバー実寸（900×56 / 720×50 / 400×50）で
  検索窓との収まりを確認。
- **回帰**: `mission19-ui` 14/14 PASS / `ui-layout` validator PASS / smoke PASS /
  `git diff --check` clean / production・protected HTML 差分なし。
  `npm test` **1190 / pass 1175 / skip 15 / fail 0**（`--test-concurrency=4`）。
  ※ 既定並列度では runtime テストが**メモリ競合で不安定**（15→3 失敗と変動）。
  並列度を落とすと安定して 0 fail。ロゴ変更とは無関係の既存の実行環境問題。
- **新規/変更**: `tools/build-logo-assets.js`（新規）/ `public/assets/logo/*`（マスター + 生成3点）/
  `public/osaka_3d_buildings.ward-ux-v1.html` / `package.json`（`assets:logo`）/
  `data/reports/logo-assets-build.json` / `MAP24_PROGRESS.md`。

---

## 2026-09-09 セッション6BF: Mission 31C2 — PLATEAU tran:Road 取得 ＋ Canonical Roads Polygon 化（**STOP: tran 未取得**）

canonical roads を「OSM centerline + 幅推定 ribbon」から「PLATEAU tran:Road 道路区域 polygon」へ移行する
ミッション。**このサンドボックスはネットワーク不可**のため PLATEAU tran GML を取得できず、
**§30 STOP 条件により polygon 化は保留**。**取得・変換・polygon-first build の pipeline は全て整備完了**。
canonical roads は 31D baseline（42,547 feature・全 ribbon fallback・polygon 0）のまま不変。
production / protected / ward-ux-v1 描画 / projection / znorth-neg-v1 / Mission26 road LOD 意味 / 既存 building fetch 不変。

- **§1 baseline 保存**: canonical road 42,547 / polygon 0 / ribbon 42,547 / default-width 36,051 /
  polygonCoverageRatio 0.0 / Building∩Road 4,476（HIGH 478）/ Road∩Water 106 / confidence mean 0.665。

- **§2/§3 tran download pipeline（`tools/fetch-plateau.js` へ `--layer bldg|tran` 追加）**:
  - `--layer tran` で `data/plateau-sources.json` の `tranPattern` を使い tran GML を取得。
  - **`--layer` 既定 = bldg ＝ 従来と完全に同一挙動**（`layerKind = args.layer==='tran' ? 'tran' : 'bldg'`。
    `layerPatterns = layerKind==='tran' ? tranPatterns : bldgPatterns`）。既存 building fetch 影響なし
    （fetch-plateau --help 正常・回帰 test 追加）。
  - npm script `data:fetch:plateau-tran`。

- **§5-§8 CityGML tran parser（新規 `tools/convert-plateau-tran.js`）**:
  - `--inspect`: GML 構造ダンプ（srsName / tran 要素 / function・usage codelist / sample posList）
    → CRS・semantics を確定してから `--convert`（§5/§30）。
  - `--convert`: `tran:Road` / `tran:TrafficArea` / `tran:AuxiliaryTrafficArea` の polygon を抽出、
    `tran:function` / `tran:usage` code → **roadway / sidewalk / median / bikeway** に分類（§7。雑に union しない。
    **canonical roads = roadway のみ**、歩道は pedestrianSurface として分離保持）、
    EPSG:6697 lat/lon → **znorth-neg-v1**（`x=(lon-135.52502)*cos(34.604208°)*111320, z=-((lat-34.604208)*111320)`）。
  - polygon 品質検査（§8）: self-intersection / zero-area / giant / non-finite / bbox-violation → invalid は不採用。
  - 出力: `data/processed/osaka-city/canonical/roads-tran/polygons.json`（gitignore）。
  - **現状 RESULT NO-DATA**（tran GML 無し。STOP・エラーではない）。純ロジックは合成 GML fixture で test（9 件）。

- **§9-§14 polygon-first build（`tools/build-canonical-roads.js` 拡張）**:
  - `roads-tran/polygons.json` があれば読み、各 OSM road の centerline を tran roadSurface polygon 群と空間 match
    （`centerlineInsideRatio` → **STRONG ≥0.85 / MEDIUM ≥0.5 / WEAK ≥0.25 / UNMATCHED**。§10）。
  - **STRONG / MEDIUM → geometry を polygon へ置換**（`geometrySource: 'plateau-tran-road'`、
    OSM は `attributeSources: ['osm-road-centerline']`、`centerlineRef` + `osmMatchQuality` 保持。§12）。
    geometry confidence（0.90–0.93）と match confidence（qaFlags）を分離（§12/§24）。
  - **WEAK 以下 / polygon 無し → 既存 ribbon fallback 維持**（§18・§11 source priority）。
  - **tran 無し = 全 feature が現状の ribbon（挙動変化ゼロ）**。
  - §23 coverage 指標を追加: `polygonCoverageRatioByFeature` / `ByLength` / `ByArea` + `tranMatch{STRONG,MEDIUM,WEAK,UNMATCHED}`。
    **現状 全て 0**（tran 未取得）。

- **§20/§21/§28 監査・validator**:
  - 新規 `tools/audit/plateau-tran-acquisition-status.js` → `data/reports/plateau-tran-acquisition-status.json`
    （**RESULT STOP**。取得状況 / §30 STOP 条件 / 代替 source / nextAction を記録）。
  - `tools/validate/canonical-roads.js` に §28 追加: geometrySource は osm-road-centerline / plateau-tran-road
    のみ許容 / plateau-tran-road feature は centerlineRef + osmMatchQuality(STRONG|MEDIUM) 必須 /
    polygon-first violation 0（canonicalId ユニークで構造的担保）/ `byOsmMatchQuality`。RESULT **PASS**。

- **§27 Runbook（新規 `MISSION31C2_RUNBOOK.md`）**: ローカル PC での取得 → inspect → convert →
  coverage 確認 → polygon-first re-build → conflict 比較 の全手順。§30 STOP 条件。

- **§29 regression**: canonical-roads / canonical-water / canonical-buildings / canonical-geometry /
  road-density / road-network / building-density / map-detail-audit / map-completeness /
  performance-budget / ward-mode-integration / live-city-mode **全 PASS**。
  `npm test` **1190 / pass 1175 / skip 15 / fail 0**（新規 `tests/plateau-tran-convert.test.js` 9 件）。
  smoke PASS / `git diff --check` clean / production・protected・ward-ux-v1 HTML 差分なし。
  **Building∩Road / Road∩Water は roads 不変のため 31D と同値**（before = after）。

- **新規/変更**: `tools/convert-plateau-tran.js`（新規）/ `tools/audit/plateau-tran-acquisition-status.js`（新規）/
  `tools/fetch-plateau.js`（`--layer` 追加）/ `tools/build-canonical-roads.js`（polygon-first 拡張）/
  `tools/validate/canonical-roads.js`（§28 拡張）/ `tests/plateau-tran-convert.test.js`（新規）/
  `MISSION31C2_RUNBOOK.md`（新規）/ `package.json` / `.gitignore`（roads-tran/・data/raw/plateau/ 追加）/
  `MAP24_PROGRESS.md` / `CANONICAL_GEOMETRY_DESIGN.md` /
  `data/reports/{plateau-tran-conversion, plateau-tran-acquisition-status, canonical-road-build,
  canonical-road-validation, canonical-conflicts}`。

### ★ 結論
**PLATEAU tran データが未取得のため canonical roads polygon 化は保留（§30 STOP）。**
pipeline は完成しており、ユーザーがローカル PC で `MISSION31C2_RUNBOOK.md` を実行すれば polygon 化できる。

---

## 2026-09-09 セッション6BE: Mission 31D — Canonical Buildings 正式化 ＋ Road Polygon Source 取得準備

31A設計 / 31B water / 31C roads に続き **building geometry を canonical layer 化**。並行して
31C で未取得だった **road polygon source の取得・import 基盤を整備**（実データ取得と polygon 化は 31C2）。
BuildingTileLayer / CityBuildingLOD の描画は不変。projection / znorth-neg-v1 不変。
PLATEAU 建物を OSM で上書きしない・conflict 解消のため建物を削らない（§0）。
production / protected / ward-ux-v1 HTML 変更なし。

### Part 1: Canonical Buildings

- **§1-§4 build（新規 `tools/build-canonical-buildings.js`。`--max-old-space-size=4096`）**
  → `data/processed/osaka-city/canonical/buildings/`（manifest + tile ×996 + `attributes/` tile ×996。
  約 570MB・**gitignore** 追加・再生成 `npm run data:build:canonical-buildings`）:
  - **canonical total 615,617**（**PLATEAU 574,112**（baseline 一致）+ **OSM fallback 41,505**）。
    polygonCoverageRatio = **1.0**（全 feature が PLATEAU/OSM footprint polygon）。
  - PLATEAU footprint は **render 用簡略化せず原形状**を使用（`invalid footprint 0 除外`。area<0.3m² / 自己交差 / 非有限）。
  - **§11 count 差分の説明**: PLATEAU unclassified 10,378 棟（区外/ambiguous）は canonical から**除外**
    （§0 保守的判断。`--include-unclassified` で追加可）。OSM fallback −2 = §4 PLATEAU duplicate 除外。
  - **§4 duplicate suppression**: fallback 41,507 を PLATEAU footprint index（`isDuplicateOfPlateau` IoU 0.30 /
    centroid-in-polygon）と照合 → **PLATEAU duplicate 2 棟を除外**（Mission29 で既に dedup 済み・
    `duplicatesRejected 3,923`。2 棟だけ漏れていた）。**canonical duplicate 0 / duplicateCanonicalId 0**。
  - **§5 geometry / attributes 分離**: canonical geometry feature は `attributes: {}`（空）。
    属性は `attributes/tile_*.json` に `canonicalId → { source, wardId, usage, normalizedUsage, usageCategory,
    usageLabel, heightM, heightSource, levels, confidence, fallbackReason }`。canonical geometry に表示色なし。
  - **§6 height**: attribute 扱い（`heightM` / `heightSource`）。footprint geometry は高さ非依存。
    byHeightSource: plateau 574,112 / osm-height 22,755 / osm-levels 1,800 / generic-default 13,626 / class-default 3,324。
  - **§7 usage normalization**: `normalizedUsage` 非 null 100%（**その他(null) = 0**）。PLATEAU の用途コードは
    本プロジェクト独自マッピング（411=店舗等 等）のため `usage` コード / `usageLabel` は verbatim 保持し、
    `usageCategory` はラベルのキーワードから導出（§0: 用途の意味は変更しない）。
  - **§8 ward assignment**: `building.ward` 不使用。PLATEAU = N03 分類済み dataset（`osaka-<ward>`）/
    fallback = centroid-in-ward（`b.wardId`）。**wardNull 0 / wardInvalid 0**。
  - **§9 town-ready**: canonicalId + centroid + tile で town polygon へ後から spatial join 可能な構造。

- **§17 validator（新規 `tools/validate/canonical-buildings.js`。tile を stream）** → RESULT **PASS**
  （schemaErr 0 / invalidFp 0 / bboxInvalid 0 / centroidInvalid 0 / areaInvalid 0 / provMissing 0 /
  confInvalid 0 / sourceIdsEmpty 0 / **normalizedUsageNull 0** / **wardInvalid 0** /
  **plateauPriorityViolation 0**（PLATEAU は全て confidence 0.95）/ attributes tile 1:1 / tile consistency PASS）。

- **§18 canonical-geometry validator を 3 layer 統合へ拡張**（`tools/validate/canonical-geometry.js`）:
  water（全 feature）+ roads（manifest + sample tile）+ buildings（manifest + sample tile）。
  layer 横断 canonicalId 重複チェック。**658,690 feature / RESULT PASS**。

- **§13-§16 conflict 再監査（`tools/audit/canonical-conflicts.js` を 5 ペアへ拡張）**
  → `data/reports/canonical-conflicts.json`:
  | ペア | conflicts | 内訳 |
  |---|---|---|
  | Building∩Water | **142**（31B/31C baseline 維持。geometry 不変） | plateau-encroaches 95 / centerline-offset ほか。HIGH 47 |
  | Building∩Road | **4,476**（31C baseline 維持） | plateau-encroaches-road 3,849（ribbon 幅推定ずれ）/ building-over-road 469（高架下）/ covered-road 34。HIGH 478 |
  | Road∩Water | **106** 全 INFO | bridge 92 / river-crossing 13 / culvert 1 |
  | **Building∩Rail（§15 新規）** | **10,565** | subway=**underground 4,071**（EXPLAINED）/ station-building 349 / elevated-rail-or-alignment 6,140（日本の都市鉄道は高架・地平が大半で線路脇/高架下の建物は正常。OSM に高架タグ無し→ EXPLAINED）/ centerline-offset。HIGH 0 |
  | **Park∩Building（§16 新規）** | **1,082** | park-facility 398（EXPLAINED）/ building-in-park 472 / park-polygon-may-be-misclassified 187（landuse=grass 区画。§16 で ERROR 化しない）/ boundary-rounding 25。HIGH（leisure_park の大面積貫入）110 |
  - bySeverity: INFO 11,952 / MEDIUM 3,784 / HIGH 635。**§10 building geometry は一切削っていない**（31E 対象）。
  - LAND_SEA のみ canonical land 未構築で pending。

- **§25 preview**: `data/reports/canonical-building-preview.geojson`（代表地点 梅田/中之島/難波/天王寺/住吉/十三/夢洲
  周辺 4,000 feature・CRS84・properties[canonicalId / spot / source / geometrySource / confidence /
  usageCategory / usageLabel / heightM / wardId]。PLATEAU / fallback 識別可）。

### Part 2: Road Polygon Source 取得準備（§19-§23）

- **`data/plateau-sources.json` に `tranPattern` 追加**（`(^|/)[^/]*tran[^/]*\.gml$`）。`tools/fetch-plateau.js`
  は `gmlPatterns/bldgPatterns` のみ読むため**既存 building pipeline に影響なし**（fetch-plateau --help 正常）。

- **§20-§22 新規 `tools/audit/road-polygon-source-acquisition.js`** → `data/reports/road-polygon-source-acquisition.json`:
  | priority | source | geometry | availability | 推奨アクション |
  |---|---|---|---|---|
  | **A** | PLATEAU tran:Road（CityGML tran LOD1 TrafficArea polygon・EPSG:6697・大阪市全域・PLATEAU ライセンス） | **polygon（交差点の一体面あり）** | not-acquired | ローカルで `fetch-plateau --list` で tran リソース確認 → `convert-plateau-tran.js` 新規 → build-canonical-roads を polygon-first へ |
  | **B** | GSI 基盤地図情報「道路縁」(RdEdg) | **line（縁）→ pairing 要（§21: 直接 polygon 扱いしない）** | not-acquired | tran が取れない場合の次善。左右縁 pairing は 31C2 の課題 |
  | C | 大阪市 道路台帳附図 / 道路区域 | polygon or line | not-acquired（一部開示請求） | priority A/B の補完 |
  | D | OSM area:highway | polygon | 0 件（31C 確認済み） | 歩行者空間の補助のみ |
  - **31D 時点で polygon source は全て未取得** → canonical roads は 31D 後も全 ribbon fallback のまま
    （§0: 架空の道路区域は生成しない）。実取得と polygon 化は **31C2（別段階）**。

### §26 regression / 検証

- 新規 validator `canonical-buildings` **PASS** / `canonical-geometry`（3 layer 統合）**PASS**
- 回帰: canonical-water / canonical-roads / building-density / building-coverage / building-visual-gaps /
  major-building-lod / map-detail-audit / map-completeness / performance-budget / ward-mode-integration /
  live-city-mode **全 PASS**
- `npm test` **1181 / pass 1166 / skip 15 / fail 0**（新規 `tests/canonical-buildings.test.js` 12 件 +
  `tests/canonical-geometry.test.js` / `tests/canonical-roads.test.js` の pending-pair 更新）
- smoke PASS / `git diff --check` clean / production・protected・ward-ux-v1 HTML 差分なし

### 新規/変更ファイル
`tools/build-canonical-buildings.js`（新規）/ `tools/validate/canonical-buildings.js`（新規）/
`tools/audit/road-polygon-source-acquisition.js`（新規）/ `tools/validate/canonical-geometry.js`（3 layer 拡張）/
`tools/audit/canonical-conflicts.js`（Building∩Rail + Park∩Building 拡張）/
`tests/canonical-buildings.test.js`（新規）/ `tests/canonical-geometry.test.js` / `tests/canonical-roads.test.js` /
`data/plateau-sources.json`（tranPattern 追加）/ `package.json` / `.gitignore`（canonical/buildings/ 追加）/
`MAP24_PROGRESS.md` / `CANONICAL_GEOMETRY_DESIGN.md` /
`data/reports/{canonical-building-build, canonical-building-validation, canonical-building-preview.geojson,
canonical-geometry-validation, canonical-conflicts, road-polygon-source-acquisition}`。

---

## 2026-09-09 セッション6BD: Mission 31C — Canonical Roads 正式化（ribbon fallback）

canonical water（31B）に続き道路も canonical 化。**道路区域 polygon を正式形状にする方針だが、
polygon source（公的道路区域 / PLATEAU tran:Road / OSM area:highway）が 1 件も取得できていない**ため、
31C の canonical roads は**全 feature が OSM centerline + 幅推定の ribbon fallback**（§18。架空の道路区域は生成しない §0）。
RoadLayer / CityTileLayer の描画は不変。projection / znorth-neg-v1 / Mission26 road LOD 意味も不変。
production / protected / ward-ux-v1 HTML 変更なし。

- **§1/§2/§3 source inventory（`tools/audit/canonical-road-sources.js` を §2 PLATEAU tran 監査へ拡張）**
  → `data/reports/canonical-road-source-comparison.json`:
  - **現 OSM centerline: 42,565 本 / 5,287km / area geometry 無し**（raw OSM に `area:highway` = 0 件）
  - **PLATEAU tran:Road: repo 内に 0 件**。`tools/fetch-plateau.js` は `bldgPattern` のみ（建物 GML）。
    tran GML は取得対象外。→ §2 status `not-acquired（sourceMissing）`
  - 公的道路区域候補（未取得・ローカル取得候補）: GSI 基盤地図情報「道路縁」(RdEdg)〔priority 1〕/
    大阪市 道路台帳附図 GIS〔priority 1〕/ PLATEAU tran〔priority 2〕/ 大阪府・市オープンデータ〔priority 2〕
  - **結論: polygon source ゼロ → canonical roads は全 ribbon fallback。31D で tranPattern 追加 +
    fetch-plateau.js 拡張 か GSI 道路縁ローカル取得で polygon source を確保する**。

- **§4/§5/§18 build（新規 `tools/build-canonical-roads.js`）** → `data/processed/osaka-city/canonical/roads/`
  （manifest + tile ×87。full precision。**gitignore 対象**・再生成: `node tools/build-canonical-roads.js`）:
  - road tile（`p` centerline + highway/lanes/width/bridge/tunnel/layer/oneway/service）から
    `resolveRoadWidth`（width タグ → lanes×3.25 → クラス既定）+ `buildRoadRibbon` で ribbon polygon 生成。
  - geometry: 単一 Polygon（left+reversed right）。自己交差時は区間ごとの四角 MultiPolygon（461 件）。
  - **42,547 feature**。width 内訳: **width タグ 78 / lanes 6,436 / class-default 36,051**。
    LOD: major 2,177 / mid 4,746 / local 35,624。bridge 1,252 / tunnel 222 / underground 259。
  - confidence: width タグ 0.80 / lanes 0.75 / class-default 0.65 → **平均 0.665**。
  - **§5 centerlineRef 保持**（name / highway / lanes / bridge / tunnel / oneway / LOD 分類用）
    + `centerlineInsideRatio` / `mean|maxCenterlineToRoadAreaDistance`。
  - **§10 attributes**（name / highway / lodClass / lanes / width / surface / bridge / tunnel / underground /
    layer / oneway / service / tracktype / access）を geometry から分離。
  - rejected: zero-area 18、他 0。schema error 0。

- **§7/§19 intersection QA（`canonical-road-intersection-qa.json`）**:
  polygon source が無いため交差点は centerline ribbon の重ね合わせ。ribbon 自己交差 461 件。
  **交差点の一体面・団子状膨張・鋭角 miter は 31C では未解決**（公的道路区域 / PLATEAU tran が必要）。
  polygonCoverageRatio = **0**（全 ribbon fallback）。

- **§8/§22 major road QA（`canonical-road-major.json`）**:
  | 道路 | feat | ribbon area m² | centerline m | 幅 m | conf | bridge |
  |---|---|---|---|---|---|---|
  | 阪神高速 | 222 | 1,016,363 | 148,500 | 6.2 | 0.75 | 197 |
  | 中央大通 | 75 | 285,574 | 25,647 | 10.5 | 0.75 | 14 |
  | 国道43号 | 95 | 149,541 | 20,715 | 7.7 | 0.75 | 40 |
  | 国道25号 | 71 | 124,452 | 10,700 | 12.3 | 0.75 | 0 |
  | 御堂筋 | 74 | 125,022 | 13,050※ | 11.4 | 0.75 | 26 |
  | 新御堂筋 | 34 | 72,552 | 9,604 | 6.7 | 0.75 | 23 |
  | 長居公園通 | 23 | 56,053 | 8,230 | 7.1 | 0.75 | 1 |
  | 国道1号 | 16 | 33,025 | 4,960 | 6.9 | 0.75 | 1 |（border road。京阪国道 alias）
  ※御堂筋は「御堂筋 / 新御堂筋」両方に部分マッチ。polygon 比較は polygon source 取得後（31D 以降）。

- **§11/§12/§13/§21 conflict 監査（`tools/audit/canonical-conflicts.js` を Building∩Road 対応へ拡張）**
  → `data/reports/canonical-conflicts.json`:
  - **Building∩Road: 4,476 conflicts**（canonical roads **major/mid tier のみ** 6,832 feature を検査。
    local は幅が細く OSM alignment ノイズが支配的なため除外）。
  - byCause: **plateau-building-encroaches-road 3,849** / building-over-road 469（高架下＝正常・§13）/
    covered-road 34（地下道路の上＝正常）/ centerline-offset 151 / station-building 5。
  - bySeverity: MEDIUM 3,422 / HIGH 525（うち **Building∩Road 478**）/ INFO 777。
  - byRoadClass: tertiary 3,057 / primary 512 / trunk 401 / motorway_link 254 / …
  - **主因は ribbon 幅推定（class-default）が実道路幅とずれ、centerline も OSM 誤差 3–5m あるため
    隣接建物を薄く貫くこと**。＝ polygon source が必要という 31C の結論を定量的に裏付け。
  - Building∩Water 142（31B と同じ）/ Road∩Water 106（bridge 92 EXPLAINED）。
  - **§10 building geometry は削っていない**（31E で扱う）。
  - BUILDING_RAIL / PARK_BUILDING / LAND_SEA は canonical rail/park/land 未構築で pending。

- **§20 validator（新規 `tools/validate/canonical-roads.js`）** → RESULT **PASS**
  （schema 0 / invalid polygon 0 / bbox violation 0 / provenance 100% / confidence 100% /
  sourceIds 100% / centerline mismatch 0% / **core major road missing 0**（国道1号は border road＝WARN）/
  tile consistency PASS / RoadLayer render 不変）。

- **§23 preview**: `data/reports/canonical-road-preview.geojson`（major LOD のみ 2,177 feature・CRS84・
  Polygon/MultiPolygon + properties[canonicalId/name/highway/lodClass/geometrySource/confidence/widthM/bridge/tunnel]）。

- **§24 regression**: canonical-roads / canonical-water / canonical-geometry / road-density / road-network /
  map-detail-audit / map-completeness / performance-budget / river-ribbon / waterway-density / building-density
  **すべて PASS**。`npm test` **1170 / pass 1155 / skip 15 / fail 0**（新規 `tests/canonical-roads.test.js` 15 件 +
  `tests/canonical-geometry.test.js` の BUILDING_ROAD 対応更新）。smoke PASS / `git diff --check` clean /
  production・protected・ward-ux-v1 HTML 差分なし。

- **新規/変更**: `tools/build-canonical-roads.js`（新規）/ `tools/validate/canonical-roads.js`（新規）/
  `tools/audit/canonical-road-sources.js`（§2 PLATEAU tran 監査へ拡張）/
  `tools/audit/canonical-conflicts.js`（Building∩Road 拡張・byRoadClass）/ `tests/canonical-roads.test.js`（新規）/
  `tests/canonical-geometry.test.js` / `package.json` / `.gitignore`（canonical/roads/ 追加）/ `MAP24_PROGRESS.md` /
  `CANONICAL_GEOMETRY_DESIGN.md` / `data/reports/{canonical-road-build, canonical-road-validation,
  canonical-road-major, canonical-road-intersection-qa, canonical-road-source-comparison,
  canonical-road-preview.geojson, canonical-conflicts}`。

---

## 2026-09-09 セッション6BC: Mission 31B — Canonical Water 正式化（polygon-first）

31A で確立した Canonical Geometry schema を water layer に適用。「centerline + 幅推定 ribbon」から
「実際の水域 polygon を正式形状として採用」へ移行。**RiverLayerV2 / rivers.json / water-surface は不変**
（読み取りのみ）。projection / znorth-neg-v1 不変。production / protected / ward-ux-v1 HTML 変更なし
（31G まで render は切替えない）。

- **§1 water source inventory（新規 `tools/audit/canonical-road-sources.js` 相当の water 版）**
  → `data/reports/canonical-water-source-inventory.json`:
  - 使用 source: raw OSM `data/raw/osaka-city/waterways-osm.json`（way 1,256 + relation 52・full geometry）
    + rivers.json（centerline / widthProfile / ribbon fallback）。
  - 公的候補（未取得・ローカル取得候補）: GSI 基盤地図情報 水涯線(WL)（priority 1）/ 国土数値情報 W05 河川区域
    （priority 1）/ PLATEAU luse（priority 2）/ 大阪市・府オープンデータ（priority 2）。

- **§2/§3 polygon-first を build へ適用（`tools/build-canonical-water.js` 全面書き換え）**:
  - raw OSM を znorth-neg-v1 へ投影し、relation multipolygon（`assembleMultipolygon`）+ standalone
    closed water way を polygon 化。品質検査（自己交差 / zero area / giant / giant-edge / city bbox /
    hole 妥当性）で invalid を除外（**rejected: giant-edge 1 / zero-area 1、他 0**）。
  - **§4 polygon merge**: rivers.json を正規化名グループ化し、グループの centerline が貫く water=river
    polygon を「まとめて」1 MultiPolygon へ統合（分割 polygon の統合。§4「無理に 1 polygon へ溶かさない」
    ＝ MultiPolygon 保持）。同一河川に polygon feature と ribbon feature が併存しない構造。
  - polygon source が無い水路のみ RiverLayerV2 ribbon を fallback（geometry は「区間ごとの四角形の
    MultiPolygon」＝ concatenated ring 自己交差を回避）。

- **§5/§6/§19 大川 + 主要河川（`data/reports/canonical-water-major-rivers.json`）**:
  | 河川 | polygon? | geometrySource | canonical m² | ribbon m² | 比 | conf | clInside |
  |---|---|---|---|---|---|---|---|
  | 大川 | ✅ | osm-riverbank | 379,549 | 339,910 | **1.12** | 0.90 | 0.92 |
  | 淀川 | ✅ | osm-riverbank+centerline | 8,718,834 | 6,416,905 | 1.36 | 0.90 | 1.0 |
  | 大和川 | ✅ | 〃 | 2,276,707 | 1,746,637 | 1.30 | 0.90 | 1.0 |
  | 神崎川 | ✅ | 〃 | 1,658,701 | 913,027 | 1.82 | 0.90 | 1.0 |
  | 木津川 | ✅ | 〃 | 1,832,488 | 1,254,959 | 1.46 | 0.90 | 1.0 |
  | 安治川 | ✅ | osm-riverbank | ~2,000,000 | 522,812 | **3.8**（`polygon-much-larger-than-ribbon` qaFlag） | 0.90 | 1.0 |
  | 寝屋川 | ✅ | 〃 | 420,292 | 378,524 | 1.11 | 0.90 | 0.97 |
  | 道頓堀川 | ✅ | 〃 | 152,502 | 119,157 | 1.28 | 0.90 | 1.0 |
  | 堂島川 | ✅ | 〃 | 258,985 | 250,577 | 1.03 | 0.90 | 0.94 |
  | 土佐堀川 | ✅ | osm-riverbank（同名 claim） | ~165,000 | 178,261 | 0.93 | 0.80 | — |
  - **大川: ribbon → riverbank polygon（confidence 0.78 → 0.90）**。canonical area は ribbon より 12% 広い。
    centerlineRef（centerlineInsideRatio 0.92 / 距離指標）+ widthProfile（measured-strong 87.9m）を保持。

- **§7 polygon quality / §8 centerline 整合**: 各 feature に `centerlineRef.{centerlineInsideRatio,
  meanCenterlineToWaterDistance, maxCenterlineToWaterDistance}`。insideRatio < 0.6 → qaFlag
  `centerline-partly/mostly-outside-polygon`（7+6+2 件）。

- **§9/§21 conflict 再監査（`tools/audit/canonical-conflicts.js` を Road∩Water 対応へ拡張）**
  → `data/reports/canonical-conflicts.json`:
  - **Building∩Water: 142 件（31A 250 → −43%）／ HIGH 47（31A 105 → −55%）**。
    polygon geometry が ribbon より正確なため conflict が減少。
    byCause: plateau-building-encroaches-water 95 / centerline-offset 33 / over-water-structure 9 / …
  - **Road∩Water: 106 件（新規・§21）**。全件 INFO（§11「単純 overlap を ERROR にしない」）。
    bridge 92 / river-crossing 13（OSM 橋タグ欠落・qaFlag）/ culvert 1。
  - bySource: plateau-building 130 / osm-building 12 / osm-road-centerline 106。
  - byConfidence: water≥0.85 → 147 / 0.7–0.85 → 31 / <0.7 → 70。
  - **§10 building geometry は削っていない**（Building∩Water は 31E で扱う）。

- **§12 sea/harbor 分離**: `waterClass` を river/canal/stream/pond/lake/reservoir/drainage/harbor/sea/water
  に正規化。harbor 2 / 河川と混在なし。大阪湾（water-surface ラスタ）は canonical water に含めない。

- **§13-16 schema / provenance / style / LOD**: 全 feature が provenance（geometrySource /
  attributeSources / confidence / sourceIds / generatedAt）+ confidence（平均 **0.837** / 0.65–0.90）。
  canonical に色・LOD なし。

- **§15/§17 tile prototype**: `data/processed/osaka-city/canonical/water/manifest.json` + `tile_*.json`
  （tileSize 2000・112 tile・**simplify なし**。LOD simplify は 31F derived band）。

- **§20 preview**: `data/reports/canonical-water-preview.geojson`（CRS84・526 feature・Polygon/MultiPolygon
  + properties[canonicalId/name/waterClass/geometrySource/confidence/areaM2/qaFlags]）。外部 GIS で確認可。

- **§18 water source coverage**: 526 feature ＝ polygon **393（75%）** / ribbon fallback 133（うち
  default-width 100）。byGeometrySource: osm-water-polygon 311 / osm-riverbank 82 / osm-waterway-centerline 133。

- **§17 validator（新規 `tools/validate/canonical-water.js`）** → RESULT **PASS**
  （schema 0 / invalid polygon 0 / bbox violation 0 / provenance 100% / confidence 100% /
  polygon-first 違反 0 / major river missing 0 / centerline mismatch 0（qaFlag 記録済みは warn）/ tile 整合 PASS）。

- **§22 regression**: canonical-geometry / river-ribbon / river-network / waterway-density / building-density /
  building-coverage / map-completeness / map-detail-audit / ward-mode-integration / live-city-mode /
  performance-budget / fallback-building **すべて PASS**。
  `npm test` **1156 / pass 1141 / skip 15 / fail 0**（新規 `tests/canonical-water.test.js` 13 件 +
  `tests/canonical-geometry.test.js` の ROAD_WATER 対応更新）。smoke PASS / `git diff --check` clean /
  production・protected・ward-ux-v1 HTML 差分なし。

- **新規/変更**: `tools/build-canonical-water.js`（全面書換）/ `tools/validate/canonical-water.js`（新規）/
  `tools/audit/canonical-conflicts.js`（Road∩Water 拡張）/ `tests/canonical-water.test.js`（新規）/
  `tests/canonical-geometry.test.js` / `package.json` / `MAP24_PROGRESS.md` /
  `data/processed/osaka-city/canonical/{water.json, water/*}` /
  `data/reports/{canonical-water-build, canonical-water-validation, canonical-water-source-inventory,
  canonical-water-major-rivers, canonical-water-preview.geojson, canonical-conflicts, okawa-canonical-water-audit}`。

---

## 2026-09-09 セッション6BB: Mission 31A — Canonical Urban Geometry 基盤設計

複数ソース（PLATEAU建物 / OSM道路・河川・公園・鉄道 / N03）を「重ねて表示」する現方式の構造的齟齬
（建物が河川へ食い込む・河川幅ずれ・道路と建物の重なり・境界数m級ズレ）を解消するため、
`Source → Canonical Geometry → Attributes → LOD/Tile → Style` の 2 段目を設計。
**既存描画は一切置換しない**。production / protected HTML 変更なし。projection / znorth-neg-v1 変更なし。
Mission 1〜30 の描画・validator・test 不変。**設計 + schema + prototype まで**。

- **§1-8 schema（新規 `tools/lib/canonical-geometry-schema.js`）**:
  - `CANONICAL_LAYERS` = land / buildings / roads / water / parks / rail / administrative
  - `SOURCE_REGISTRY`（14 source。各 `geometryRole` / `attributeRole` / license / 精度）
  - `SOURCE_PRIORITY`（layer 別。**各 layer 末尾は必ず「source missing は生成しない」**）
    - buildings: PLATEAU(0.95) → OSM fallback(0.82) → 生成しない
    - water: 公的水域 → OSM riverbank(0.90) → OSM water polygon(0.88) → OSM centerline+幅(0.65–0.78) → 生成しない
    - roads: 公的道路区域 → PLATEAU tran → OSM centerline+width → OSM area:highway → 生成しない
  - `makeProvenance` / `makeCanonicalFeature` / `validateCanonicalFeature`（provenance 必須。confidence 0..1 必須。
    sourceIds 必須。canonical feature は色・材質・LOD を持てない）
  - `CONFIDENCE`（10 段）/ `CONFLICT_PAIRS`（6 ペア）/ `CONFLICT_EXPLANATIONS`（bridge / station /
    over-water-structure / osm-building-drawn-on-water / centerline-offset 等）/ `classifyConflictSeverity`
    （EXPLAINED=INFO / 小=LOW / 説明不能な大面積相互貫入=HIGH）
  - `LAYER_PRECEDENCE_POLICY`（固定順位を使わず confidence + 実形状 QA。roads–buildings / rail–buildings
    は排他 clip 禁止＝高架・建物内通路・駅ビル）
  - `CANONICAL_OUTPUT`（`data/processed/osaka-city/canonical/`。manifest+tile。全量巨大 JSON にしない）
  - `DERIVED_OUTPUT`（LOD は canonical の外。`derived/{far,mid,near,ultra-near}`）
  - `STYLE_SEPARATION`（色は style layer。canonical は知らない）

- **§10/§11 water prototype（新規 `tools/build-canonical-water.js`）** → `data/processed/osaka-city/canonical/water.json`:
  - **587 feature**（ribbon 225 = `osm-waterway-centerline` / area polygon 362 = `osm-riverbank` 110 +
    `osm-water-polygon` 252）。confidence 平均 0.819。schema error 0。
  - RiverLayerV2 / rivers.json は**読み取りのみ**。`polygon-source-available` 44（31B で geometry を polygon 化）。

- **§11 大川監査（新規 `tools/audit/okawa-canonical-water.js`）** → `data/reports/okawa-canonical-water-audit.json`:
  - current ribbon 339,910 m²（幅 measured-strong 87.9m）／ OSM riverbank polygon source **3 枚 421,669 m²
    （ribbon 比 1.24）** ＝実河道はさらに 24% 広い。
  - **建物 overlap: 水面の 29.0%**（PLATEAU 6,142 cells / OSM fallback 17 @ 4m grid）／ road overlap 3.0%。
  - migration: 31B で geometry を osm-riverbank polygon へ差し替え、confidence 0.78 → 0.90。

- **§12 road source 比較（新規 `tools/audit/canonical-road-sources.js`）** → `canonical-road-source-comparison.json`:
  - 公的道路区域 polygon(rank1, 未取得) / PLATEAU tran:Road 面(rank2, 未取得) /
    OSM centerline+width(rank3, **42,565 本 5,287km 実測**) / OSM area:highway(rank4, 補助)。
  - 現 OSM は area geometry を持たない＝幅推定のたびにズレる。31C で公的 / PLATEAU tran 取得判断。

- **§18 validator（新規 `tools/validate/canonical-geometry.js`）** → RESULT **PASS**
  （water 587 feat / schemaErr 0 / dupId 0 / schema 自己整合 PASS / production・protected 不変）。

- **§19 conflict audit（新規 `tools/audit/canonical-conflicts.js`）** → `canonical-conflicts.json`:
  - Building∩Water のみ実計算（他 5 ペアは canonical roads/buildings 未構築で pending）。
  - conflict 250 / `{ HIGH:105, MEDIUM:77, INFO(EXPLAINED):68 }` /
    cause `{ plateau-building-encroaches-water:176, centerline-offset:52, over-water-structure:13, ... }`。
  - **HIGH 105 の主因は canonical water が現状 ribbon（centerline 左右オフセット）であること**。
    31B で riverbank polygon geometry へ差し替えれば大幅減の見込み。**31A では解消しない**（監査で意味付けまで）。

- **§21 設計ドキュメント（新規 `CANONICAL_GEOMETRY_DESIGN.md`）**: なぜ canonical / アーキ図 /
  layer 別 source priority / provenance schema / confidence / conflict QA / update strategy / migration plan。

- **§22 migration plan**: 31A(設計) → 31B(canonical water) → 31C(roads) → 31D(buildings) →
  31E(conflicts) → 31F(map 統合) → 31G(既存 render 切替)。各段階で既存描画を壊さないことを保証。

- **検証**: 新規 `tests/canonical-geometry.test.js`（14 件）。`npm test` **1144 / pass 1129 / skip 15 / fail 0**。
  smoke PASS / `git diff --check` clean / 既存 validator 全 PASS
  （river-network / waterway-density / building-density / map-completeness / map-detail-audit /
  ward-mode-integration / live-city-mode / performance-budget / fallback-building）。
  production・protected HTML 差分なし（このミッションは HTML を一切触らない）。

- **新規ファイル**: `tools/lib/canonical-geometry-schema.js` / `tools/build-canonical-water.js` /
  `tools/audit/okawa-canonical-water.js` / `tools/audit/canonical-road-sources.js` /
  `tools/audit/canonical-conflicts.js` / `tools/validate/canonical-geometry.js` /
  `tests/canonical-geometry.test.js` / `CANONICAL_GEOMETRY_DESIGN.md` /
  `data/processed/osaka-city/canonical/water.json` / 各 `data/reports/canonical-*.json` /
  `data/reports/okawa-canonical-water-audit.json`。変更: `package.json` / `MAP24_PROGRESS.md`。

---

## 2026-09-09 セッション6BA: 追加修正タスク — fallback建物の色未適用 & 選択範囲外建物の残留表示

OSM fallback 建物（PLATEAU 欠落補完 41,507 棟）の 2 つの問題を修正。
projection / znorth-neg-v1 変更なし。**ward-ux-v1.html + tools のみ**、production / protected HTML 変更なし。
既存の BuildingTileLayer / CityBuildingLOD / MajorBuildingLOD の構造維持。1建物=1mesh 化なし。

- **§1-A 色未適用の原因**: `toFallbackRecord` は `usage`（OSM タグ値）を持つが、generic `building=yes`
  は `usage:null`（31,842 棟＝76%）。CityBuildingLOD は fallback を PLATEAU LOD と同じ単一白 material
  で描くだけで用途色に一切乗らず、近景で PLATEAU 詳細建物の横に「灰色ベタ塗りのブロック」が浮いていた。
  popup も `その他(null)` / `（コード:null）` を生表示。
- **§1-B 範囲外表示の原因**: fallback は市全域 1 dataset を CityBuildingLOD が単一擬似区
  `'osm-fallback'` として丸ごとロード。区スコープが一切効かず、Ward Mode で選択区の外の fallback 建物
  （港湾部・北部など全 24 区分）が距離を引くと出ていた。PLATEAU LOD も 24 区常時ロードで同様。

- **§2 色の修正（`osm-building-fallback.js` / `build-osm-building-fallback.js` / HTML）**:
  - `resolveFallbackUsage(buildingTag)` を新設。戻り値は全フィールド非 null:
    `usage`（既存互換・generic は null）/ `normalizedUsage`（'yes' 含む・非 null）/
    `category`（HTML プリセットキー: residential_low/mid・commercial・office・industrial・school・
    medical・hotel・public・**other**）/ `usageLabel`（日本語・"null" にしない）。
  - `FALLBACK_USAGE_CATEGORY`（OSM タグ→カテゴリ）+ `BUILDING_CATEGORY_LABEL` + `DEFAULT_BUILDING_CATEGORY='other'`。
  - `toFallbackRecord(..., wardId)` に `normalizedUsage` / `usageCategory` / `usageLabel` / `wardId` を追加。
  - HTML CityBuildingLOD: `fallbackTint(category)` を新設。用途色を **82% 白へ寄せた薄い用途色**
    （`msBlend`）を頂点カラー tint（`b.__lodTint`）として乗せる。`appendBuilding` は `T = b.__lodTint || ONE3`
    で PLATEAU LOD は tint 無し＝**従来と完全に同一**の grey shading。
  - popup: `usageDisplayName(d)` / `usageCodeSuffix(d)` ヘルパで `d.usage==null` を安全に整形
    （UN コード → usageLabel → normalizedUsage → 「建物（用途不明）」）。`その他(null)` を出さない。

- **§3 区スコープの修正（HTML CityBuildingLOD）**:
  - `loadWard('osm-fallback', ...)` を **区ごとに分割** → wardState キー `'osm-fallback:<wardId>'`。
    wardId 無しは `'osm-fallback:_unknown'`。`FALLBACK_KEY_PREFIX = 'osm-fallback:'`。
  - `applyBand()` に区スコープを追加:
    - **City Mode**: 従来どおり 24 区 + fallback 全体を band（far/mid/near）制御。**挙動不変**。
    - **Ward Mode**（`currentWardId` 確定時）: 非選択区の PLATEAU LOD・fallback を **非表示**。
      選択区の fallback（欠落補完）は距離に依らず表示（BuildingTileLayer に fallback は無いため）。
  - `getStats` を `wid.startsWith(FALLBACK_KEY_PREFIX)` 集計へ（`osmFallbackStatus/Triangles` 互換維持）。
  - `bandVisibility` / `setCameraDistance` は Mission27/01 の regex どおり **一切変更なし**。

- **§4 境界建物の所属ルール**: **footprint centroid が入る区**に所属（build 側で必須化。emitted は
  centroid-in-ward 前提のため全件 centroid ベース・`missingWardId=0`）。footprint が隣区へまたぐ建物
  137 棟も centroid の区で確定。監査で centroid 再判定と 100% 一致（`centroidMismatch=0`）。

- **§5 デバッグ API**: `window.__FALLBACK_BUILDING_DEBUG__()`（selectedWard / visibleFallbackBuildings /
  visiblePlateauBuildings / outOfWardVisibleCount / fallbackByWard / scope / suspiciousBuckets）。
  `window.__LAST_BUILDING_PICK__`（クリック建物の source / wardId / datasetId / usage / normalizedUsage /
  usageCategory / confidence / heightSource / tileId）。

- **§6/§7 検証**:
  - 新規 `tools/audit/fallback-building-color.js` → `data/reports/fallback-building-color-audit.json`
    （41,507 棟・issues 0・default(other) 31,959・colored 9,548・htmlChecks 全 true）**PASS**
  - 新規 `tools/audit/fallback-building-ward-scope.js` → `fallback-building-ward-scope-audit.json`
    （missingWardId 0 / invalidWardId 0 / centroidMismatch 0 / straddle 137）**PASS**
  - 新規 `tools/validate/fallback-building.js` → `fallback-building-validation.json` **PASS**
  - building-density / building-coverage / building-visual-gaps / major-building-lod /
    ward-mode-integration / live-city-mode / map-completeness / map-detail-audit / performance-budget
    すべて **PASS**（β1 完成候補・unexplained 0 維持）
  - 新規 `tests/fallback-building.test.js`（13 件）+ `tests/mission27-major-building-lod.test.js` の
    return regex を getFallbackDebug 追加に対応。`npm test` **1130 / pass 1115 / skip 15 / fail 0**。
  - smoke PASS / `git diff --check` clean / production・protected HTML 差分なし。
  - byCategory: other 31,959 / residential_low 5,912 / residential_mid 1,754 / industrial 1,003 /
    commercial 451 / public 198 / office 137 / school 46 / hotel 36 / medical 11。

- **変更ファイル**: `tools/lib/osm-building-fallback.js` / `tools/build-osm-building-fallback.js` /
  `tools/audit/fallback-building-color.js`（新規）/ `tools/audit/fallback-building-ward-scope.js`（新規）/
  `tools/validate/fallback-building.js`（新規）/ `public/osaka_3d_buildings.ward-ux-v1.html` /
  `tests/fallback-building.test.js`（新規）/ `tests/mission27-major-building-lod.test.js` / `package.json` /
  `public/map-data/osaka-city/buildings/osaka-osm-fallback/*`（再生成・gitignore 対象）。

---

## 2026-09-09 セッション6AZ: 追加修正タスク — 大川の実幅補正（強実測 named river の過剰 shrink 解消）

大川（中之島の北側、旧淀川本流）が実河道 ~88m に対し **8.4m** で描画されていた問題を修正。
projection / znorth-neg-v1 / production / protected HTML 変更なし。**修正は build データ（tools/）のみ**、
ward-ux-v1.html は触っていない。他の主要 7 河川の geometry は完全不変。

- **§1 現象確認（新規 `tools/audit/okawa-width.js` → `data/reports/okawa-width-audit.json`）**:
  大川 = OSM `way/82729504`（1セグ・centerline 3,866m）。waterways タイルの riverbank polygon **10枚**が
  河道に一致、横断実測 9 サンプルで **min 80.5 / median 87.9 / max 107.9m**。
  にもかかわらず描画は **median 8.4m** ＝ medium tier の 70m 上限 → 建物干渉回避で scale 0.12 まで縮小。
  原因: 大川は major 7 河川リストに無く medium 扱い。medium は「riverbank 実測が十分でも」70m 上限＋
  建物 footprint と重なると shrink される。大川の場合 footprint との重なりは
  「建物を水面に描いた OSM 誤り」か「centerline が河道中心からずれ」で、河川を細くしても解決しない。

- **§2/§3 一般化ロジック（`tools/build-river-layer.js`）** — 大川専用ハードコードなし:
  `isStrongWideMeasured(wres)` = `method === 'measured'` かつ `matchedRiverbanks >= 6`（`STRONG_RB_MIN`）
  かつ実測幅 `>= 45m`（`STRONG_MEASURED_MIN_W`）。
  - 強実測 medium は幅上限を **70m → 110m**（`STRONG_MEDIUM_MAX_W`、`widthMethod = 'measured-strong'`）。
  - 強実測 medium は **建物干渉 shrink の対象外**（major 7 河川と同じ扱い。`conflictSegs` から除外）。
  - 該当: 大川（8.4→87.9m）。堂島川・土佐堀川も measured-strong 判定になるが実測幅どおりで変化なし
    （堂島川 ~66m / 土佐堀川 ~52m）。東横堀川・三十間堀川・平野川・城北川など狭い運河は閾値未満で不変。

- **§4 smoothing**: 上限 clamp 以外の平滑化パラメータ（25m/100m 絶対 clamp・1.3x/100m 比 clamp・
  forward-backward pass）は変更なし。神崎川・木津川で急変・くびれが再発しないことを回帰テストで確認。

- **§2 `tools/lib/river-width.js`**: `resolveRiverWidth` の measured 返り値に `samples[]`（横断実測値）を追加
  （audit で raw サンプル分布を出せるように）。計算ロジック自体は不変。

- **§8 validator/test**:
  - `tools/validate/river-network.js`: 再チェック時の medium 幅上限を `widthMethod === 'measured-strong'` なら
    120m に緩和（build と整合。micro に `{min:1, max:10}` の widthLimits も明示）。
  - 新規 `tests/okawa-width.test.js`（9 件）: 幅計測 純ロジック / 一般化ロジックのソース検査（大川名で分岐して
    いないこと）/ 大川 regression（median >= 60m・measured-strong・conflict keep）/ 主要 7 河川 median 不変 /
    堂島川・土佐堀川 非劣化 / 東横堀川が細いまま（過補正なし）/ production・protected HTML 未混入。
  - 新規 npm script `data:audit:okawa-width`。`package.json` の `test` にも追加。

- **§6/§7 結果**:
  - river-ribbon validator **PASS** / river-network validator **PASS** / waterway-density validator **PASS**
  - 全 validator（road-density / road-network / building-density / performance-budget / park-lod / rail-lod /
    city-layer-tiles / live-city-mode / ward-mode-integration / land-coverage / building-coverage /
    building-visual-gaps / major-building-lod / map-completeness / map-detail）**PASS**、
    map-completeness β1 完成候補 / map-detail unexplained 0 維持。
  - `npm test` **1117 / pass 1102 / skip 15 / fail 0**。smoke harness OK。`git diff --check` clean。
  - 主要 7 河川 width median 不変（淀川 400 / 大和川 110 / 神崎川 127 / 安治川 67 / 木津川 173 /
    寝屋川 60 / 道頓堀川 42、いずれも err 0）。

---

## 2026-09-09 セッション6AY: 見た目改善31ミッション — Mission31 大阪市北部 OSM道路 SOURCE_MISSING（ツール整備・ソース再取得はユーザー環境）

Mission30 で残った唯一の source 欠落＝東淀川区・淀川区北部の道路（現 PBF が lat≈34.735 で切れている）の
**解消ツール一式**を整備。**ソース PBF の再取得はネットワークが必要なためユーザー環境で実施**
（`MISSION31_RUNBOOK.md` に手順）。架空道路は生成しない（§0）。projection / production / protected HTML 変更なし
（Mission31 は HTML を一切触らない）。

- **§1 現 PBF 範囲を正式監査（新規 `tools/audit/osm-source-coverage.js`）**:
  `data/raw/osm/osaka-latest.osm.pbf` を 2-pass stream し、**road way に属する node だけの bbox** と
  緯度ヒストグラムを算出（PBF 未変更なら前回結果を再利用・`--rescan` で強制）。
  結果（`data/reports/osm-source-coverage.json`）:
  - road-way-node bbox: **S 34.547 / N 34.7545 / W 135.274 / E 135.700**
  - road node 緯度ヒストグラム: lat 34.73 に 20,634 点 → **lat 34.74 に 352 点（cliff ratio 58.6）**
  - ways 1,256,862 / relations 7,351 / nodes 5,909,958 / road-way-node 325,789
  → **現 PBF の道路は実質 lat≈34.74 で切れていることを確認**。

- **§2 必要 bbox を N03 から自動算出（新規 `tools/lib/osm-source-coverage.js`）**:
  `n03Bbox(wards)` が ward polygon（znorth-neg-v1）→ WGS84 外接矩形を算出（手入力の固定値を使わない）。
  - N03 大阪市 24区 bbox: **S 34.586154 / N 34.768849 / W 135.343508 / E 135.599350**
  - `expandBboxKm(bbox, 3)` で +3km margin → 必要 bbox: **S 34.559205 / N 34.795798 / W 135.310767 / E 135.632091**
  - **北側の不足: 約 4.6km**（東淀川区の北 ~78% / 淀川区の北 ~25%）

- **§4 source coverage validator（新規 `tools/validate/osm-source-coverage.js`）= import 前ゲート**:
  road-way-node bbox が required bbox を 4辺すべてで包含 & cliff が required.north を下回らないこと。
  → **現状 RESULT FAIL**（north 側 4.6km 不足 + lat≈34.74 の cliff）。remediation runbook を出力。
  **これが Mission31 で唯一「ユーザー環境の実施待ち」の項目**。標準 validator スイート・npm test には含めない
  （ソース拡張までは意図的に FAIL）。

- **§10 SOURCE_MISSING の data 駆動化（確認 + 精緻化）**:
  Mission26 の設計で既に data 駆動（`road-network.js` `auditRoadDensity` が
  `sourceMissingCells / landCells >= 0.08` で `sparseWards` を算出。hardcode ward リストなし）。
  test で「コードに `higashiyodogawa` を SOURCE_MISSING と直結する固定リストが無い」ことを保証。

- **§18 SOURCE_MISSING vs SOURCE_SPARSE の区別（`road-network.js` 拡張）**:
  `auditRoadDensity` に `sourceCliffZ`（osm-source-coverage の cliff 緯度を znorth-neg-v1 へ変換）を渡すと、
  `sparseWards` を 2 種へ分割:
  - **`sourceMissingWards`**: 区の最北端が cliff より北 & sourceMissingCells ≥ 15% → **PBF 拡張で解消可能**
  - **`sourceSparseWards`**: 範囲内だが OSM 未整備 → OSM 実データ投入待ち
  現状: `sourceMissingWards = [yodogawa, higashiyodogawa]` / `sourceSparseWards = []`
  （両区とも「OSM に道路が無い」のではなく「PBF が切れている」と判定）。
  `map-completeness.js` の roadStatus は `SOURCE-MISSING` / `SOURCE-SPARSE` を区別（`SOURCE-SPARSE` を新設）。
  `map-detail-audit.js` の sourceMissing 各項目に `kind: 'SOURCE_MISSING' | 'SOURCE_SPARSE'`。

- **§5-9 再 import 手順の runbook（新規 `MISSION31_RUNBOOK.md`）**:
  PBF 取得（Geofabrik kansai / BBBike / osmium extract）→ `osm-source-coverage` で PASS 確認 →
  `osm-pbf-city.js --input` で roads 再 import（Mission26 の highway class 全維持）→ 他レイヤー before/after 比較
  （§6 副作用チェック・10%超減少で STOP）→ tile 再生成 → 監査再実行（SOURCE_MISSING は自動で再評価）。

- **現状の数値（ソース拡張前）**:
  - 東淀川区 road cell coverage **10%**（変化なし。PBF 切れが原因）
  - 淀川区 road cell coverage **57%**（変化なし）
  - road feature **42,565**（変化なし。Mission26 baseline 維持）
  - road sourceMissing wards **2**（東淀川・淀川。ソース拡張後に 0 目標）
  - `map-completeness` overallScore **100** / `map-detail-audit` **PASS** / CRITICAL 0 / HIGH 0 / unexplained 0（維持）

- **テスト（新規 `tests/osm-source-coverage.test.js` 5 + `tests/mission31-source-coverage.test.js` 9）**:
  純ロジック（xzToLatLon / n03Bbox / expandBboxKm / coverageContains / detectLatCliff）+
  実データ整合 + hardcode なし保証 + runbook 内容。
  `npm test` **1108 tests / 1093 pass / 0 fail / 15 skip**。smoke OK。
  標準 validators 19 本すべて PASS。`git diff --check` clean。**production / protected HTML 不変**（HTML 変更なし）。

- **実機確認**: ソース拡張前は 東淀川（淡路・上新庄・井高野）・淀川区北部（新大阪・西中島）で道路が薄いまま
  （期待どおりの SOURCE_MISSING）。runbook 実施後に同地点で道路網が連続することを確認。

- **維持**: Mission21-30 の全成果 / projection・znorth-neg-v1・N03 boundary / road classification / LOD 閾値 /
  Mission25 性能基盤。

- **新規 npm script**: `data:audit:osm-source-coverage` / `data:validate:osm-source-coverage`。

- **Mission31 の完了状態**: ツール・validator・runbook・data 駆動化・SOURCE_MISSING/SPARSE 区別は完成。
  **「東淀川区・淀川区 roads: SOURCE_MISSING → PASS」はユーザー環境での PBF 再取得後に自動達成される**。
  Mission32 へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-09 セッション6AX: 見た目改善30ミッション — Mission30 大阪市全域 細部欠落総合監査

Mission26-29（道路・河川・建物・水系の高密度化）を経た基礎地図を 100m グリッドで最終 QA。
新機能は追加せず、「道路・建物・河川・公園・鉄道・陸地に不自然な欠落が残っていないか」を機械的に洗い出す。

- **監査基盤（新規 `tools/lib/map-detail-audit.js` / `tools/audit/map-detail-audit.js`）**:
  Mission24 の `map-completeness` 監査（anomaly A/B/C/F・100m グリッド・22 代表地点）を土台に、
  - **anomaly D**（known surface waterway あり / rendered water 0）→ `waterway-density.json` の
    `missingSurfaceWater` を参照 = **0**
  - **anomaly E**（rail network 断裂）→ `map-completeness` の主要 21 路線 lineCheck + rail-lod validator = **0**
  - **anomaly G**（park source あり / rendered 0）→ 主要 9 公園 parkCheck + park-lod validator = **0**
    （Mission24 の PARK anomaly 1 件は type G へ改称。靱公園の別名分割＝表示は正常・LOW）
  - **anomaly H**（周囲は密なのに当該 cell だけ完全空白）→ A 型 anomaly のうち OSM 建物密度 ≥800 棟/km²
    かつ非説明のもの = **0**（Mission21C で解消済み）
  を加えた。

- **§5 cause taxonomy**: `normalizeCause` で Mission24 の自由文 note を 13 種
  （SOURCE_MISSING / PORT / INDUSTRIAL / PARK / RIVERBANK / RAIL_YARD / COAST / BOUNDARY /
  OSM_SPARSE / PLATEAU_MISSING / UNDERGROUND / ROUNDING / UNKNOWN）へ正規化。
  61 anomaly の内訳: **INDUSTRIAL 35 / PORT 11 / OSM_SPARSE 9 / ROUNDING 4 / PARK 1 / COAST 1**。
  UNKNOWN / PLATEAU_MISSING（＝未説明）は **0**。

- **§1-4 監査結果**: 100m グリッド **land cell 22,627**。anomaly 総数 **61**（A 48 / B 11 / F 1 / G 1）。
  **CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 14 / INFO 47 / unexplained 0**。overallScore **100**。
  全 61 anomaly が LOW/INFO かつ §5 cause 付き（港湾・工業・USJ・埋立地・OSM sparse 区・ラスタ端の丸め）。

- **§6 24区スコア**: `consolidateWardScores` で map-completeness の byWard に Mission30 anomaly を重ねて再構成。
  **24区すべて overallCompleteness 100 / CRITICAL 0 / HIGH 0**。各区に buildingCoverage / roadCoverage /
  waterCoverage / parkCoverage / railCoverage / explainedCount / statuses を出力。

- **§7 代表地点 QA（24点）**: Mission24 の 22 点 + **淡路 / 十三** を追加。
  **21 PASS / 3 EXPLAINED（夢洲・淡路・十三）/ 0 FAIL**。
  淡路・十三は 東淀川区・淀川区の SOURCE_MISSING（PBF 北端 lat≈34.735）で道路が無い＝EXPLAINED、
  建物は PLATEAU で正常。

- **§8-12 layer QA（Mission26-29 再監査。全 PASS）**:
  - **land**: land-coverage validator PASS / unexplained missing 0
  - **roads**（§8）: tileBoundaryBreaks 0 / duplicate 0 / unsupported highway 0 /
    NEAR local coverage 100% / **東淀川区・淀川区 = SOURCE_MISSING で正しく説明**
  - **buildings**（§9）: duplicate 0 / invalid geometry 0 / unexplained gap cluster 0 /
    sparse mismatch residual 0 / cell coverage 88.7% / fallback source id 全件
  - **waterways**（§10）: missingSurfaceWater 0 / underground skip 59 / building overlap 予算内 /
    major 7 河川 regression 維持 / micro 水路 LOD（≤1500m のみ）
  - **parks**（§11）: 主要 9 公園すべて rendered / park-lod validator error 0
  - **rail**（§12）: 主要 21 路線すべて found / railClass 修正（named 2,245）維持 / rail-lod validator error 0
  - **sea**: illegal land overlap 0

- **§13 performance regression**: `performance-budget-validation.json` PASS。
  markStaticMesh / render loop hot path clean / Mission25 基盤維持。**Mission30 は監査コード（tools/*）のみで
  runtime へ大量 anomaly 配列を載せない**（`__MAP_DETAIL_AUDIT_DEBUG__` は summary 中心）→ 描画性能悪化なし。

- **§14/§15 runtime debug（HTML 追加は 1 関数のみ）**: `window.__MAP_DETAIL_AUDIT_DEBUG__()` を追加。
  reportPath / gridSizeM / runtime{runtimeMissing, wardsReady, layers} / performance{fps,frameMs,drawCalls,…} を返す
  summary API。anomaly 配列は常時ロードしない（`__MAP_COMPLETENESS_DEBUG__` / `__PERFORMANCE_DEBUG__` を
  薄く集約するだけ）。`runtimeMissing = 0` 維持。既存 debug API は無改変。

- **§16 レポート（新規 `data/reports/map-detail-audit.json`）**: overallScore / criticalCount / highCount /
  mediumCount / anomalySummary{bySeverity,byType,byCause} / layerScores / layerQa / wardScores(24) /
  representativeQa(24) / sourceMissing / performanceRegression / knownLimitations / RESULT / verdict。

- **§17 validator（新規 `tools/validate/map-detail-audit.js`）**: CRITICAL 0 / HIGH 0 / unexplained 0 /
  MEDIUM 0（or 全件説明可能）/ 全 layer QA pass / building duplicate・invalid 0 / runtimeMissing 0 /
  全 anomaly に taxonomy cause / representative FAIL 0 / performance regression なし /
  __MAP_DETAIL_AUDIT_DEBUG__ が summary のみ / map completeness 100 / production・protected 無変更
  → **RESULT PASS**。

- **§18 最小修正**: 監査で CRITICAL/HIGH/unexplained は検出されず、**HTML/データの修正は不要**でした
  （`__MAP_DETAIL_AUDIT_DEBUG__` の追加のみ・監査ツールは tools/ 配下）。

- **テスト（新規 `tests/map-detail-audit.test.js` 6 + `tests/mission30-map-detail-audit.test.js` 13）**:
  `npm test` **1094 tests / 1079 pass / 0 fail / 15 skip**。smoke OK。
  validators 19 本すべて PASS。`git diff --check` clean。**production / protected HTML 不変**。

- **実機確認**: `__MAP_DETAIL_AUDIT_DEBUG__()` で runtimeMissing 0 / performance を確認。
  代表 24 地点をズームして道路・建物・河川・公園・鉄道が期待どおり表示されること。
  港湾・工業・USJ・埋立地の大区画に不自然な密度の建物を置いていないこと。淡路・十三は道路 SOURCE_MISSING。

- **維持**: Mission21-29 の全成果 / projection・znorth-neg-v1・N03 boundary / LOD 閾値の意味 /
  major RiverLayerV2 geometry / road・building classification。

- **新規 npm script**: `data:audit:map-detail` / `data:validate:map-detail`。

- **verdict: 「大阪市基礎地図 細部欠落監査 クリア（β1 完成）」**。次工程へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-08 セッション6AW: 見た目改善29ミッション — Mission29 大阪市 建物網羅性の最終強化

Mission21B/21C の OSM building fallback 基盤を精緻化。**PLATEAU 574,112 棟は破壊・置換しない**（§0）。
「建物が存在しない土地は無理に埋めない」（§18）を守りつつ、fallback の品質・高さ・出所情報を強化する。

- **§2 OSM building 再監査 + タグフィルタ**: `data/raw/osm/osaka-latest.osm.pbf` の全 building way を再走査。
  **roof / construction / ruins / proposed / demolished / razed / abandoned を fallback 対象外**へ明示分類
  （`isFallbackEligibleBuilding` / `BUILDING_EXCLUDE_TAGS`）。→ 対象 building way 1,035,077 → **1,030,838**。
  各建物に `usage`（building タグ値）を保持。byUsage: yes 31,842 / detached 3,280 / house 2,598 /
  apartments 1,084 / industrial 696 / residential 669 / warehouse 286 / commercial 236 / office 137 …

- **§9 footprint quality**: `isValidFootprint`（頂点数 / 面積 / 非有限 / 自己交差）+ `ringSelfIntersects` を追加。
  → 自己交差 **8 棟**を新規除外 / too-small 9,691 / too-big 3 / badFootprint 0。emitted 内の invalid geometry = **0**。

- **§10 建物高さ per-class default**: `BUILDING_CLASS_DEFAULT_HEIGHT`（house 8 / apartments 12 / commercial 11 /
  industrial 9 / warehouse 8 / office 14 / school 10 / hospital 14 / hotel 16 …。極端値は 60m clamp）。
  優先順位: **OSM height → building:levels×3.2m → class default → generic(6m)**。
  → heightSource: osm-height 22,757 / osm-levels 1,800 / **class-default 3,324（新規・realistic 高さ）** /
  generic-default 13,626（`building=yes` は class 情報なし＝控えめ 6m 維持）。
  class-default も実測ではないため `heightUnknown: true` のまま（Mission10 高さ階級には入れない・renderHeight のみ現実化）。

- **§11 source confidence**: fallback レコードに `confidence`（osm-height 0.92 / osm-levels 0.78 /
  class-default 0.55 / generic 0.40）+ `heightSource` + `usage` を付与。**confidence mean 0.714**
  （high≥0.8: 22,757 / mid: 5,124 / low<0.5: 13,626）。root manifest に `osmFallback.confidenceMean` を追記。

- **§3/§4 duplicate suppression**: 従来どおり centroid-in-polygon / bbox IoU（build 0.22 / validator 0.30。
  近接距離では判定しない）。→ **duplicate rejected 3,923**（fallback 候補が減った分 4,081 → 3,923）。
  emitted の id 重複 0 / tile 境界重複 0（build 側で旧 tile を削除してから書き直すよう修正）。

- **§5/§6/§7 gap audit**: 既存 `tools/audit/building-coverage.js`（100m grid + sparse-mismatch + cause 分類 A〜I）
  を再実行。building cell coverage **77.8%（fallback 前）→ 88.7%（fallback 後）**。
  suspected gap cell **1,979 → 376**。gap cluster **73 → 29**（cause I: 港湾/工業/緑地/河川敷 16、区界/海岸線/河川縁ノイズ 13）。
  **unexplained gap cluster = 0**。sparse-mismatch residual 0 / missed 0（`building-visual-gap-reconciliation.json`）。

- **§14 港湾・工業地帯の誤検知なし**: 此花区 cov 59.6%（USJ/桜島/岸壁）/ 西淀川区 78.7%（中島工業地帯）/
  住之江区 83.8%（咲洲/南港/平林貯木場）は road/land context + osmDensity で cause I 判定済み → 誤って「欠落」にしない。

- **§18 source missing は捏造しない**: 残 29 gap cluster は全て PLATEAU も OSM も建物 0 の cell で構成。
  航空写真からの推測建物生成は行わない。

- **§12/§13 LOD 統合（HTML 変更なし・既存配線を validator で確認）**:
  FAR = CityBuildingLOD（fallback dataset も `loadWard('osm-fallback', ...)` でロード済み）/
  MID = major building のみ（Mission27 `isMajorBuilding` は fallback にも適用。height≥30 OR area≥3000 OR landmark）/
  NEAR = BuildingTileLayer detailed（fallback dataset 判定 `b.source === 'osm-fallback'` あり）。
  fallback 専用の per-building mesh は生成しない（tile 単位 merged / shared material / markStaticMesh / frustum culling）。
  major building 選定 17,797 棟は Mission27 から不変（除外した ~900 棟・class-default ≤20m は major 閾値未満）。

- **§19 validator（新規 `tools/validate/building-density.js`）**: duplicate 0 / tile 境界重複 0 /
  invalid geometry 0 / giant footprint 0 / 大阪市外 0 / source(osm way id) 全件あり /
  confidence schema 妥当（0..1・heightSource ∈ 4種）/ roof等混入 0 / 24区 breakdown /
  unexplained gap 0 / sparse residual 0 / LOD 統合維持 / map completeness 100 / production・protected 無変更
  → **RESULT PASS**。

- **§15/§16 指標**: `building-density-validation.json` に fallbackBuildings / heightSourceCount / byWard(24) /
  plateauBuildings / totalRenderable / gapClusters / unexplainedGapClusters / buildingCellCoverage /
  counts{dupId,tileDup,invalidGeom,giant,outside,noSource,noConfidence,excludedUsage}。
  `osm-building-fallback.json` に byUsage / confidence{mean,buckets} / footprintQuality。

- **数値 before → after**:
  - PLATEAU **574,112**（不変）
  - OSM fallback **42,402 → 41,507**（−895: roof/construction/ruins 除外 + 自己交差 8 + footprint 厳格化）
  - renderable total **616,514 → 615,619**（−895）
  - building cell coverage after-fallback **88.8% → 88.7%**（invalid 除外分の −0.1）
  - suspected gap cell **375 → 376** / gap cluster **27 → 29**（境界シフト。全て explained）
  - duplicate suppressed **4,081 → 3,923**
  - invalid building **self-intersect 8 / too-small 9,691 / too-big 3** を除外（emitted 内 invalid 0）
  - sourceMissing = 残 29 gap cluster（PLATEAU/OSM 両方なし＝実際に建物がほぼ無い土地）

- **性能（§20）**: fallback −895 棟。triangle は壁=footprint辺×2・屋根=fan で高さ非依存＝ほぼ不変。
  drawCall は tile-merged 構造・CityBuildingLOD 1 mesh/区・BuildingTileLayer 用途別 merged で不変。
  Mission25 の markStaticMesh / dirty flag / frustum culling / LRU 維持。

- **テスト（新規 `tests/building-density.test.js` 6 + `tests/mission29-building-density.test.js` 10、
  既存 `tests/building-coverage.test.js` を per-class 高さ / confidence へ追従）**:
  `npm test` **1075 tests / 1060 pass / 0 fail / 15 skip**。smoke OK。
  validators 19 本すべて PASS。`git diff --check` clean。**production / protected HTML 不変**。
  map completeness **overallScore 100 / CRITICAL 0 / HIGH 0** 維持。

- **実機確認（§17）**: 梅田・中之島・本町・難波・天王寺・阿倍野・京橋・鶴橋・十三・東淀川・平野・住吉・西成 で
  住宅街の細かい建物が PLATEAU + fallback で埋まっていること。此花・USJ・舞洲・夢洲・咲洲・南港 で
  大区画（港湾・USJ・物流）に不自然な密度の建物を勝手に置いていないこと。fallback 建物の高さが
  用途に応じて自然（倉庫・工場は低め、事務所・マンションは高め）であること。

- **維持**: Mission21B/21C 建物補完基盤 / Mission25 markStaticMesh / Mission27 主要建物LOD /
  Mission28 水系 / Mission24 完成度 / projection・znorth-neg-v1・N03 boundary。

- **新規 npm script**: `data:validate:building-density`。

- Mission30 へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-08 セッション6AV: 見た目改善28ミッション — Mission28 小河川・運河・水路の高密度化

Mission22 の major/medium/minor 3 階級に **MICRO 階級**（drain / ditch / ごく小さい無名 stream）を追加し、
超近景（<=1500m）のみ表示する。既存主要7河川の見た目・geometry は変更しない。

- **現収録状況監査（§1）**: raw waterway line（Mission22 の import filter `river|canal|stream|drain|ditch`）
  = **284 feature**（surface 225 / underground 59）。tag別 surface/underground/named 内訳:
  river 159（surface 133 / underground 26 / named 128）/ stream 75（58 / 17 / 19）/ canal 13（13 / 0 / 7）/
  drain 25（13 / 12 / 1）/ ditch 12（8 / 4 / 0）。生 OSM には culvert 244・layer<0 259 と大量の暗渠がある。

- **MICRO 階級（`tools/lib/river-network.js` `classifyRiverTier` 拡張）**:
  無名の drain / ditch、または無名で短い（groupLen < 300m）・細い（widthHint < 6m）stream → **micro**。
  **名前付きの用水路（〜井路 / 〜水路）・canal は minor 以上へ残す**（従来 NEAR 表示を維持）。
  `TIER_ORDER = [major, medium, minor, micro]`。→ **52 feature が minor から micro へ移動**。

- **幅（§3、`tools/lib/river-width.js` `conservativeMicroWidth`）**: `MICRO_WIDTH_LIMITS { min:1, max:8 }`。
  default drain 2.5m / ditch 1.5m / stream 4m。width タグがあれば micro 上限で clamp。
  → **小水路を太くしない**（micro の最大幅 8.0m）。

- **建物干渉（§4/§11）**: micro も干渉チェック対象へ追加。micro は「まず縮小」を常に有効化し
  （scales 1.0→0.7→0.5→0.35→0.22、edge 許容 0.40 / center 許容 0.35）、縁が建物に多少触れても残す。
  suppress は centerline が明確に建物内の時のみ。→ micro: shrink 1 / suppress 7。
  全体: 干渉検出（修正前）91 → keep 120 / shrink 40（medium 35 / micro 1）/ suppress 34（minor 27 / micro 7）。
  **建物 overlap（回避後 edgeInFrac > 0.30）= 31 feature**（橋・護岸一体等の現実的重なり。§11 で EXPLAINED）。

- **地下水路除外（§5）**: `surface:false`（tunnel / culvert / covered / layer<0）は地表描画しない。
  **underground skip 59 line**（149 cell）。橋下通過の短い区間で河川全体を消すことはしない（既存ロジック維持）。

- **LOD（§8、RiverLayerV2 in HTML）**: `MICRO_HIDE_DISTANCE_M = 1500`（`MICRO_FADE_START_M = 1000`）追加。
  既存の `MINOR_HIDE_DISTANCE_M = 4500` / `MEDIUM_HIDE_DISTANCE_M = 9000` は**不変**。
  | band | camera 距離 | 表示クラス |
  |---|---|---|
  | FAR | `> 9000m` | MAJOR |
  | MID | `4500〜9000m` | + MEDIUM |
  | NEAR | `1500〜4500m` | + MINOR |
  | ULTRA_NEAR | `<= 1500m` | + MICRO |
  micro は 1 merged mesh（区別ではなく tier 別。1水路=1mesh 禁止）。shore は major/medium のみ（micro に岸線を足さない）。
  `markStaticMesh(microMesh)`（Mission25 最適化維持）。

- **ribbon（§9）**: micro は major river と同じ miter/densify を使わない。`buildRiverRibbonTapered` の
  micro opts = `maxSeg 25`（densify 間隔を詰める）/ `maxMiterRatio 1.6`（miter clamp を厳しく）＝細い帯で角の spike を出さない。

- **water completeness 監査（§12、`tools/audit/waterway-density.js` 新規・`data/reports/waterway-density.json`）**:
  100m グリッドで OSM surface waterway line（3x3 窓で rendered 照合）を比較。
  **known surface 1,713 cell → rendered 1,615（94.3%）／ missingSurfaceWater = 0**。
  内訳: underground cell 149 / 建物干渉 suppress で説明済み 98 / 市域外（隣接市へ続く区間）235。
  **OSM に存在する surface waterway が理由なく消えている cell = 0**（§14: 推測生成なし）。

- **displayed waterway 数 before → after**: **190 → 191**（±0 相当）。tier 内訳: major 31 / medium 76 /
  minor 39（was ~118 のうち 27 suppress + 52 が micro へ）/ **micro 45**（52 中 7 suppress）。
  triangles **8,172**（micro 690 = 全体の 8%）。RiverLayerV2 draw call は最大 5（major/medium/minor/micro/shore）。

- **major river 品質維持（§0）**: 淀川 median 400m / 大和川 109.8 / 神崎川 127.2 / 安治川 66.7 / 木津川 173.2 /
  寝屋川 60 / 道頓堀川 42.5 — Mission04/22 と**完全に同一**。geometry・width・seg 数・triangle 数すべて不変。error 0。

- **debug（§15）**: `__RIVER_NETWORK_DEBUG__()` 拡張 — `byClass` / `byWaterway` / `visibleByLod`（band ごとの
  実表示クラス）/ `micro` / `microTriangles` / `shrunk` / `overlapCount` / `minorWaterSuppressedCount` /
  `minorWaterShrunkCount` / `undergroundSkipped`。個別河川名クエリは従来どおり。

- **validator（新規 `tools/validate/waterway-density.js`、§17）**: unsupported waterway 0 / invalid geometry 0 /
  giant triangle（non-major）0 / duplicate id 0 / bbox violation 0 / underground surface-render 0 /
  surface water unexplained missing 0 / micro 最大幅 <= 8m / building overlap 予算内（表示の 20%）/
  major 7 河川 median width が Mission04 基準 ±25% / HTML micro 配線 / MINOR・MEDIUM LOD 距離不変 /
  production・protected 無混入 → **RESULT PASS**。

- **テスト（新規 `tests/waterway-density.test.js` 6 + `tests/mission28-waterway-density.test.js` 16、
  既存 Mission22/04-B/river-layer-v2 を 4 階級へ追従）**:
  `npm test` **1059 tests / 1044 pass / 0 fail / 15 skip**。smoke OK。
  validators 18 本すべて PASS。`git diff --check` clean（CRLF 警告のみ）。**production / protected HTML 不変**。
  map-completeness **overallScore 100 / CRITICAL 0 / HIGH 0** 維持。

- **実機確認（§13）**: 1500m 以下へズームして **東住吉区・平野区の小河川、大正区・港区・此花区・住之江区・
  西区・西淀川区の運河、住宅街の drain/ditch** が細い水色線として自然に現れること（太い帯にならないこと）。
  1500〜4500m で micro が消え minor（名前付き用水路・小河川）だけになること。
  代表河川（淀川 / 大和川 / 神崎川 / 木津川 / 安治川 / 寝屋川 / 道頓堀川 / 大阪港 / 各区運河）は従来どおり。

- **source missing（§14）**: なし（missingSurfaceWater 0）。生 OSM の暗渠区間（culvert 244）は地表描画対象外で正当。
  市域北部（東淀川区・淀川区）の水路も railways/waterways は PBF 収録範囲内のため道路のような欠落は無い。

- **維持**: Mission22 河川ネットワーク基盤 / Mission04 major river geometry / Mission04-B 建物干渉回避 /
  Mission25 markStaticMesh / Mission06 WaterSurfaceLayer / Mission21 LandSurfaceLayer / projection・znorth-neg-v1。

- **新規 npm script**: `data:audit:waterway-density` / `data:validate:waterway-density`。

- Mission29 へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-08 セッション6AU: 見た目改善27ミッション — Mission27 中景用・主要建物LODの新設

遠景 CityBuildingLOD（密度mesh）と近景 BuildingTileLayer（詳細建物）の間に、「中景では主要建物・高層建物
だけを簡易ブロックで表示する」中間LODを追加。密度mesh→詳細建物の突然の切替を減らす。

- **実装方式（最小リスク）**: 新規レイヤーを足さず、`CityBuildingLOD` の区別統合meshを
  **minor / major の 2 バケット**へ分割。既存の押し出し・共有material・`markStaticMesh`・landmark 抑制を
  そのまま流用。区あたり最大 2 mesh（従来 1）。

- **建物選定基準（§2、`tools/lib/major-building-lod.js` 新規・実データ分布監査）**:
  `height >= 30m` OR `footprintArea >= 3000m²` OR `landmark`。
  → **616,514 棟中 17,797 棟（2.89%）を major に選定**。基準別: height≥30 が 17,011 / area≥3000 が 1,134 /
  landmark 1（ほぼ全 landmark は高さ・面積で既に選定済み）。
  感度: height≥25→21,100 / ≥35→10,548 / ≥45→3,437。area≥2000→2,186 / ≥5000→489。
  区別（多い順）: 中央 4,204 / 北 2,198 / 西 1,613 / 浪速 1,217 / 天王寺 1,035 ＝ CBD スカイラインの分布。

- **FAR / MID / NEAR 表示ルール（§1/§6）**:
  | band | camera 距離 | minor（全建物密度） | major（主要ブロック） | BuildingTileLayer 詳細 |
  |---|---|---|---|---|
  | FAR | `> 9000m` | 表示 | 表示 | ring 外＝ほぼ無し |
  | MID | `4000〜9000m` | **非表示** | **表示**（都市の輪郭） | 中心 ~2.5km patch |
  | NEAR | `<= 4000m` | 非表示 | **非表示** | 表示 |
  band 境界 9000m は道路・河川・鉄道・公園と統一。近景境界 4000m は既存 `HIDE_NEAR_M` と一致。

- **overlap 防止（§6）**: minor は FAR のみ、major は FAR+MID → **同じ建物を CityBuildingLOD 内で二重描画
  しない**（1棟は minor / major のどちらか一方）。NEAR で両バケット非表示 → BuildingTileLayer へ handoff。
  3 レイヤー同時表示は band 排他で構造的に発生しない。
  残留する軽微な重なり: MID で BuildingTileLayer の中心 patch（~2.5km）内では major ブロックと詳細建物が
  同一 footprint・同一高さで共存（座標一致のため z-fighting ほぼ無し・両方白）。§6 が想定する許容範囲。

- **landmark 二重表示防止（§8）**: `appendBuilding` の `LandmarkLayer.isSuppressedBuilding(b.id)` early-return を
  維持 → 実 3D モデルがある landmark は minor / major どちらの mesh にも入らない。

- **形状（§3）**: footprint + height の簡易 extrude（壁 + 屋根のみ）。屋根形状・窓・edge・picking・shadow なし。
  `mesh.raycast = () => {}` で明示的に picking 対象外。頂点カラーの接地暗化のみ（Mission09/10/11 の係数を流用）。

- **性能（§10）**: minor / major とも `markStaticMesh`（matrixAutoUpdate=false）+ 共有 material 1個。
  `applyBand()` は `setCameraDistance` / `setVisible` / `loadWard` からのみ呼ばれ、**render loop からは呼ばれない**
  （per-frame の全建物走査なし）。major mesh の推定三角形 ≈ 28.5 万（大阪市全域。従来の minor 密度mesh は数百万）。
  MID では minor（大区画の三角形）を描かない分 draw call・triangle が**減る**。

- **debug（§9、新規）**: `window.__MAJOR_BUILDING_LOD_DEBUG__()` —
  band / cameraDistance / thresholdHeight / thresholdArea / selectedBuildings / majorBuildings / minorBuildings /
  visibleBuildings / meshes / triangles / majorTriangles / minorTriangles / wardsReady。
  `CityBuildingLOD.getStats()` は互換キー（wardsStarted/wardsReady/osmFallbackStatus/osmFallbackTriangles/triangles）
  を維持し、band / minorTriangles / majorTriangles / minor|majorBuildings を追加。

- **validator（新規 `tools/validate/major-building-lod.js`、§12）**: 選定率 0.5〜10% / band 排他ルール /
  landmark 抑制ガード / material 共有 / static matrix / raycast 無効 / applyBand が per-frame でない /
  getStats 互換キー / 既存 debug API・projection / Mission24 完成度 PASS / production・protected 無混入
  → **RESULT PASS**。

- **テスト（新規 `tests/major-building-lod.test.js` 6 + `tests/mission27-major-building-lod.test.js` 10、
  既存 mission01/10/11 を Mission27 の構造変更に追従）**:
  `npm test` **1042 tests / 1027 pass / 0 fail / 15 skip**。smoke OK。
  validators 17 本すべて PASS（major-building-lod / road-density / road-network / map-completeness /
  performance-budget / building-visual-gaps / building-coverage / river-network / water-surface / park-lod /
  rail-lod / city-layer-tiles / ui-layout / live-city-mode / ward-mode-integration / ward-building-datasets /
  land-coverage）。`git diff --check` clean（CRLF 警告のみ）。**production / protected HTML 不変**。

- **実機確認（§11）**: City Mode から梅田・中之島・本町・難波・天王寺・阿倍野・京橋・大阪城周辺へズームし、
  9000〜4000m の中景で「主要建物だけが都市の輪郭として立ち、一般建物の密度meshが消えている」こと。
  9000m 境界で遠景の一般建物が一段抜ける pop は仕様どおり（§11「主要建物だけ」）。
  4000m 以下で BuildingTileLayer の詳細へ handoff。

- **維持**: 遠景 CityBuildingLOD（FAR で minor+major）/ 近景 BuildingTileLayer（Mission01 handoff）/
  Mission25 パフォーマンス基盤 / Mission09-11 建物スタイル係数 / Mission24 完成度 / Mission26 道路 /
  projection・znorth-neg-v1。

- **新規 npm script**: `data:audit:major-building-lod` / `data:validate:major-building-lod`。

- Mission28 へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-08 セッション6AT: 見た目改善26ミッション — Mission26 大阪市道路網の完全高密度化

生活道路・細街路・サービス道路・路地・農道まで欠落なく取得・表示することに集中。

- **最重要の発見（§1/§15）**: `data/raw/osm/osaka-latest.osm.pbf` は **バウンディングボックス抽出で北端が
  lat≈34.735 で切れている**（PBF 全ノードの lat ヒストグラムで確認: lat 34.73 に 318,562 点 → lat 34.74 に
  1,410 点の断崖。max lat 35.12 は境界をまたぐ way の spillover）。railways(maxLat 34.769)・
  waterways(34.770) は同領域を収録しているので、道路だけの取りこぼしではなく **PBF extract の bbox 設定の問題**。
  影響: **東淀川区 陸域の約78%（1039/1332 cell）・淀川区 約25%（319/1281）・旭区 約9%（58/633）に
  生 OSM 道路データが存在しない**。Mission24 で「東淀川区 OSM thin＝EXPLAINED」としていたのは不正確で、
  正しくは **SOURCE-MISSING**（抽出範囲外）。§17 に従い架空道路は生成しない。
  → **ユーザー対応が必要**: 北端 lat≥34.78 で `osmium extract` し直す（または大阪府全域 PBF を使う）→
  `npm run data:import:osm-pbf` → `npm run data:build:city-layer-tiles -- --layer roads --area osaka-city --public --force`。

- **追加対応した highway class**:
  - **track（農道・管理道路）**: import filter + `ELIGIBLE_HIGHWAY` に追加。`access` が
    private/no/forestry/agricultural/customers/permit なら除外。width default 3m、detail `LOCAL_TRACK`、
    tier local（NEAR のみ表示）。PBF に 191 way（うち市内 bbox 84）→ 配信 16。
  - **living_street**: 既に対応済みだが detail `LOCAL_LIVING`・width 4.5 を再確認。**OSM 大阪には 2 way しか
    存在しない**（日本では living_street タグがほぼ使われない）＝パイプラインの問題ではない。

- **service subtype の保持（§4/§7）**: `classifyRoad` が `serviceType` を返す。`service=alley`（路地）は
  detail `LOCAL_ALLEY`・width 3m（class-default の service 3.5 より控えめ。width タグがあれば優先）・
  `ultraLocal:true`。tile feature に `service`/`surface`/`tracktype`/`layer`/`ultraLocal` を保持。
  **alley は既に完全収録・NEAR で表示済み**（配信 LOCAL_ALLEY 4,132・生データ 12,920 way）。

- **道路数 before → after**: 配信 feature **42,549 → 42,565**（+16 = track）。
  byClass major 2,177 / mid 4,746 / local 35,642。raw highway ways 74,262 → 74,346（+84 track）。
  byDetail: LOCAL_RESIDENTIAL 10,883 / LOCAL_UNCLASSIFIED 15,668 / LOCAL_ALLEY 4,132（新規細分）/
  LOCAL_SERVICE 3,749 / LOCAL_TRACK 16 / PEDESTRIAN 1,193 / MAJOR 2,177 / MID 4,746。

- **道路密度監査（§14、`auditRoadDensity` 新規・`data/reports/road-network-coverage.json` の density ブロック）**:
  100m グリッド × 3x3 窓（街区内部ノイズ除去）で「建物≥3・周囲 300m に道路なし」cell を抽出し原因分類。
  - road cell coverage **79.4%**（市全体）。building-road mismatch **1,182 cell**。
  - 内訳: **sourceMissing 670**（PBF 抽出範囲外）/ **sourceSparseWard 477**（東淀川区・淀川区の
    OSM 収録が partial な区。sparseWards 判定）/ **unexplained 35**（港湾・工業・USJ の大区画。
    此花/住之江/大正/西淀川。0.15% of land cells）。
  - maxBuildingToRoadDistance 600m（unexplained のみ）。新指標: `localRoadCellCoverage` /
    `buildingRoadMismatchCells` / `unexplainedRoadGapCells` / `maxBuildingToRoadDistanceM` / `sparseWards`。

- **24区 road coverage before → after**: 抽出範囲内の区は変化なし（既に完全）。SOURCE-MISSING の 2 区は
  抽出データが増えないため改善なし: 東淀川区 cellCov 10%（srcMissing 670）/ 淀川区 58%（srcMissing 213）。
  住之江区は 73%（港湾・咲洲＝cause I、SOURCE-MISSING ではない）。

- **tile 境界 continuity（§9）**: `tileBoundaryBreaks = 0` 維持（line feature は tile クリップせず丸ごと複製）。
  sourceNearMissGaps 2,263（OSM way が交差点未スナップ＝元データ由来。tile 起因ではない）。

- **map-completeness 監査の更新**: 東淀川区・淀川区の `roadStatus` を `EXPLAINED` → **`SOURCE-MISSING`**。
  knownLimitations に PBF 抽出 bbox の問題と再抽出手順を明記。**overallScore 100 / CRITICAL 0 / HIGH 0 維持**。

- **§16 他ソース候補調査（コード変更なし・レポートのみ）**:
  - **国土地理院 基盤地図情報（道路縁・道路中心線）**: 全国 coverage・高精度・公共測量成果（出典表示で利用可）。
    XML(JPGIS)。→ 東淀川区の欠落解消に最有力。要ライセンス確認と JPGIS パーサ。
  - **国土数値情報 N01 (鉄道) / 道路密度・幾何なし**、**N02 (道路) は 2011 で更新停止**。緊急輸送道路等の
    主題図はあるが細街路網は無し。→ 生活道路には不適。
  - **大阪市 オープンデータ（ODポータル）**: 道路台帳・道路区域。PDF/GIS 混在、全域の中心線 GeoJSON は未整備。
  - **PLATEAU 交通モデル（tran:Road）**: 大阪市は LOD1 の道路面あり。中心線ではなく面。OSM と重複整合が必要。
  - 推奨: まず **PBF を正しい bbox で再抽出**（コスト最小・即効）。それでも不足する農地・工業縁は
    基盤地図情報の中心線を将来 Mission で補完ソースとして検討（§16 の「明確に必要かつ安全な場合のみ」）。

- **validator（新規 `tools/validate/road-density.js`、§18）**: 24区 byWard / NEAR local coverage ≥99% /
  tileBoundaryBreaks 0 / 重複 id・不正 geometry・巨大セグメント・source id 欠落・未対応 highway class・
  大阪市外 feature = 0 / unexplained road gap 予算内 / track・alley 取り込み / HTML 配線 /
  production・protected 無混入 → **RESULT PASS**。

- **テスト（新規 `tests/road-density.test.js` 11 + road-network.test.js に Mission26 分追加）**:
  `npm test` **1026 tests / 1011 pass / 0 fail / 15 skip**。smoke OK。
  validators 16 本すべて PASS（road-density / road-network / map-completeness / performance-budget /
  building-visual-gaps / building-coverage / river-network / water-surface / park-lod / rail-lod /
  city-layer-tiles / ui-layout / live-city-mode / ward-mode-integration / ward-building-datasets / land-coverage）。
  `git diff --check` clean（CRLF 警告のみ）。**production / protected HTML 不変**。

- **性能（§20）**: 道路 +16 feature のみ。tier/tile merged mesh 構造・LOD（FAR=major / MID=+mid / NEAR=all）・
  Mission25 の `markStaticMesh` は不変。alley/track は local tier で NEAR のみ＝City Mode FAR で描画されない。

- **維持**: Road LOD（Mission02）/ ribbon（Mission03）/ access フィルタ（Mission23）/ Mission24 完成度 /
  Mission25 パフォーマンス基盤 / projection・znorth-neg-v1。

- **新規 npm script**: `data:validate:road-density`。

- Mission27 へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-08 セッション6AS: 見た目改善25ミッション — Mission25 大阪市全域描画のパフォーマンス最適化

データ追加・見た目変更ではなく「大阪市全域を軽く安定して動かす」ことに集中する監査＋最適化ミッション。
projection / znorth-neg-v1 / N03 boundary / 各種 classification / RiverLayerV2 geometry / LOD 判定基準は変更禁止。
protected(`fullward-v3.html`) / production(`osaka_3d_buildings.html`) 変更禁止。対象は ward-ux-v1.html + tools/lib + tests。

- **監査結果（既に最適化済みだった点）**: render loop（`(function loop(){…})()`）は camUpd を毎フレーム呼ばず、
  LOD 更新はカメラ変化時のみ。`CityTileLayer.applyCityLOD` は `lastCityLodKey` の dirty-flag guard 付き。
  `BuildingTileLayer.updateByCamera` 500ms / `WardModeManager.update` 200ms / `StationLabelLayer` 180ms throttle。
  全メッシュ生成時に `computeBoundingSphere()` + `frustumCulled` 設定済み。CityBuildingLOD は共有 material。
  → 毎フレームの全 feature 走査・geometry 生成・console 出力・DOM query は無し（validator で静的確認）。

- **最適化1: 静的メッシュのマトリクス固定（`markStaticMesh()`、14 箇所）**:
  原点アンカーの統合ジオメトリ（生成後 position/rotation/scale 不変。visible / material.opacity のみ変わる）へ
  `updateMatrix()` を1回 → `matrixAutoUpdate = false`。毎フレームの `Matrix4.compose()`（quaternion→行列 + scale + translate）が
  省ける。適用: **BuildingTileLayer 壁/天井/エッジ**（建物 mesh の主経路。1タイル×用途ごとに1 mesh）/
  CityBuildingLOD 区別統合 mesh / CityTileLayer の road/rail/water/park タイル mesh（最大 ~170 tile/層）/
  RiverLayerV2 major/medium/minor/shore / LandSurfaceLayer / ParkLayer / WaterSurfaceLayer。
  行列は単位のまま＝**見た目は完全に不変**。raycast（建物ピック）は `matrixWorld` = 単位で不変のため影響なし
  （`tests/mission25-performance.test.js` の runtime で既存 debug API と併せて確認）。

- **最適化2: FPS/frameMs 計測（常時ON・軽量）**: `__PERF_FRAME__` + `__perfFrameTick__()` を loop 先頭へ。
  実フレーム間隔の指数移動平均（立ち上がり 0.2 → 定常 0.06）。タブ非アクティブ復帰の外れ値（>2000ms）は無視。
  既存の HUD FPS カウンタ（`fc`/`lt`、once/sec）には一切触れていない。

- **性能デバッグ API（新規・§2/§14/§20）**: `window.__PERFORMANCE_DEBUG__()` —
  mode / fps / frameMs / renderer.info（drawCalls・triangles・geometries・textures・programs）/
  scene traversal（type別 object 数・`staticMatrixMeshes`・`visibleMeshes`・`approxVisibleTriangles`）/
  layers（buildings/roads/parks/railways/rivers の band・loadedTiles・visible mesh）/ memory。
  `window.__PERFORMANCE_BASELINE__()` — Mission24 `performanceBaseline` と同キーの最小スキーマ（JSON 保存・比較用）。
  既存 debug API（`__MAP_COMPLETENESS_DEBUG__` / `__RAIL_LOD_DEBUG__` 等）は薄く集約するだけで無改変。

- **duplicate render**: `HIDE_NEAR_M = 4000`（Mission01）維持 → CityBuildingLOD 軽量 mesh と BuildingTileLayer 実体が
  同時表示されない。道路 LOD（FAR=major / MID=+mid / NEAR=all, Mission02）・rail railClass 優先（Mission24）維持。

- **今回見送り（品質優先・§25「数字のために品質を落とさない」）**: CityTileLayer の tile 別 material 共有は、
  `clearRecMeshes` の `material.dispose()`（LRU 破棄パス）に共有ガードを足す必要があり、リスク対効果から見送り。
  material 数は既に「タイル×tier」で、tier opacity は距離バンドの大域関数のため描画は正しい。監査項目として記録。

- **validator（新規 `tools/validate/performance-budget.js`）**: markStaticMesh 定義 + 7 レイヤー適用 /
  __PERF_FRAME__・__perfFrameTick__ の loop 配線 / __PERFORMANCE_DEBUG__・__PERFORMANCE_BASELINE__ 公開 /
  render loop hot path に console・JSON.parse・geometry生成・querySelector 無し / LOD dirty-flag 維持 /
  HIDE_NEAR_M=4000 / 既存 debug API・projection 維持 / **Mission24 完成度 overallScore 100・CRITICAL 0・HIGH 0 維持** /
  production・protected 無混入 → **RESULT PASS**。

- **テスト（新規）**: `tests/performance-budget.test.js`（純ロジック 7: メトリクス比較・baseline schema・
  render loop hot path 検出・markStaticMesh 適用検出）＋ `tests/mission25-performance.test.js`
  （HTML 配線・hot path・LOD/duplicate build 回帰・既存レイヤー回帰・protected/production・runtime 12）。
  `npm test` **1014 tests / 999 pass / 0 fail / 15 skip**。smoke OK。
  validators 15 本（performance-budget / map-completeness / building-visual-gaps / building-coverage /
  road-network / river-network / water-surface / park-lod / rail-lod / city-layer-tiles / ui-layout /
  live-city-mode / ward-mode-integration / ward-building-datasets / land-coverage）すべて **PASS**。
  `git diff --check` clean（CRLF 警告のみ）。**production / protected HTML 不変**（`git status` 空）。

- **実機で確認すべき項目**（サンドボックスに GPU/ブラウザが無く絶対値は測れないため、ユーザー PC で
  `__PERFORMANCE_BASELINE__()` を Mission24 と Mission25 で取得し比較）:
  City Mode 大阪市全域初期カメラ / 梅田・難波ズーム / 南部 pan / Ward Mode 北区 / Ward 連続切替（北→東住吉→住吉→北）で
  drawCalls・triangles・geometries・fps・frameMs、Ward 切替 10 回後の geometries/textures が単調増加しないこと。

- **新規 npm script**: `data:validate:performance-budget`。

- Mission26 へは自動で進まない。ユーザー確認を待つ。

---

## 2026-09-08 セッション6AR: 見た目改善20ミッション — Mission24 大阪市24区 基礎地図総合完成度監査

7 基礎レイヤー（LAND / BUILDINGS / ROADS / RIVERS / SEA / PARKS / RAILWAYS）を 24 区横断で総合監査し、
「大阪市のどこへ移動しても地図として明らかに欠けている場所がない」状態かを判定する AUDIT ミッション。
**新機能は追加しない**。監査中に CRITICAL / HIGH を発見した場合のみ最小修正。

- **監査手法（`tools/lib/map-completeness.js` / `tools/audit/map-completeness.js` 新規）**:
  N03 24 区陸域を 100m グリッド化し、各セルで 7 レイヤーの presence を横断評価。
  anomaly 種別 A（陸+建物0+道路0 かつ open space でない）/ B（建物密+道路0）/ C（OSM密+render疎の残差）/
  F（陸∩海の不正 overlap）。open space = 公園 / 河川リボン(polygon) / 鉄道ヤード / 海岸1セルバッファ /
  river>20 / rail>20。severity は面積・セル数で CRITICAL/HIGH/MEDIUM/LOW/INFO へ段階化。

- **結果**: **overallScore 100 / CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 15 / INFO 49**。
  byLayer 全 7 レイヤー score 100。byWard 24 区すべて FAIL ステータスなし（EXPLAINED は許容）。
  representative area 22 点中 **PASS 21 / EXPLAINED 1（夢洲＝N03 未収録埋立地・コア部のみ補完）**。
  → **判定「大阪市基礎地図 β1 完成候補」**。
  anomaly 内訳: A 50（LOW 9 / INFO 41）・B 12（LOW 4 / INFO 8）・F 1（LOW＝ラスタ端 1 セル）・
  PARK 1（LOW＝靱公園、OSM 上は別名分割で正式名一致せず geometry は存在）。全件 explained（cause 付き）。

- **最小修正（§9 rail、HIGH 相当の発見）**: OSM で本線が橋・分岐・踏切ごとに短い way へ分割され、
  長さ < 60m の断片が LOCAL 扱い → City Mode FAR で JR 環状線・私鉄本線が点線状に欠落。
  - `tools/convert/railways.js`: line feature に `name`（`name:ja` 優先）を保持（従来は破棄していた）。
  - `tools/lib/rail-lod.js`: `reclassifyRailNetwork()` 追加。路線名を持つ rail way は major、
    名無しでも両端が major rail 端点に接続する短断片は major へ救済。
  - `tools/build-city-layer-tiles.js`: `railClass` を tile feature へ付与。
  - HTML（ward-ux-v1）: `buildRailMeshes` / `getRailLodDebug` が `f.railClass || classifyRail(...)` を優先。
  - 結果: rail 断片の local **958 → 108**、named **0 → 2,245**、byClass major 2,306 / urban 414 / local 108。
    主要 21 路線（JR 8・メトロ 8・私鉄 5）すべて名前で存在確認（愛称→正式名解決込み：JR京都線/神戸線
    →東海道本線、学研都市線→片町線）。

- **既知の限界（knownLimitations）**: 東淀川区・淀川区の生活道路 cell coverage が低いのは OSM の
  当該区データが系統的に薄いため（区あたり feature 数が突出して少ない）。道路の非 OSM ソースが無く
  EXPLAINED 扱い。幹線・鉄道・建物・河川は正常。／ PLATEAU LOD1（LOD2/3 は別フェーズ）／
  orthophoto QA は将来。

- **HTML（対象 = ward-ux-v1.html のみ）**: `window.__MAP_COMPLETENESS_DEBUG__()` 追加。
  runtime（cityMode / wardsReady / buildingTiles / osmFallback / roadTiles / river / land / sea /
  parks / rail）+ performanceBaseline（drawCalls / triangles / textures / geometries / programs）+
  runtimeMissing + visibleAnomalies を返す。静的スコアは `data/reports/map-completeness-audit.json` を参照。
  3D geometry / tile loader / camera / projection は一切変更なし（rail は分類ラベルのみ）。

- **validator（§16、`tools/validate/map-completeness.js` 新規）**: criticalCount=0 / highCount=0 /
  land unexplained missing=0 / building unexplained visual gap=0・sparse mismatch residual=0・
  duplicate fallback=0 / road tile boundary break=0・eligible local coverage 100% / river unexplained gap=0 /
  illegal sea overlap=0 / 主要公園 missing=0 / 主要鉄道 missing=0 / 既存 layer validator 全 PASS /
  HTML 配線・既存レイヤーキーワード / protected・production 無混入 → **RESULT PASS**。

- **テスト（§17）**: 新規 `tests/map-completeness.test.js`（純ロジック 9：anomaly A/F・open space 除外・
  clusterCells・severity・layerScore・reclassifyRailNetwork 断片救済・classifyRail 互換）＋
  `tests/mission24-map-completeness.test.js`（audit 構造・byLayer/byWard・verdict・parkCheck・
  lineCheck・rail タイル名/railClass・HTML 配線・既存回帰・protected/production・runtime 15）。
  既存 `tests/mission13-rail-lod.test.js` を「rail に名前が付く前提」へ更新。
  `npm test` **995 tests / 980 pass / 0 fail / 15 skip**。smoke OK。
  validators: map-completeness / building-visual-gaps / building-coverage / road-network / river-network /
  water-surface / land-coverage / park-lod / rail-lod / city-layer-tiles / ui-layout / live-city-mode /
  ward-mode-integration / ward-building-datasets すべて **PASS**。
  `git diff --check` clean（CRLF 警告のみ）。**production / protected HTML 不変**（`git status` 空）。

- **canonical baseline（Mission24 時点）**: PLATEAU 建物 574,112 + OSM fallback 42,402 = renderable 616,514 /
  道路 42,290 feature（eligible local coverage 100% / tileBoundaryBreak 0）/ 河川 surface 190 表示・
  underground 59 skip / SEA 不正陸重複 0 / 公園 2,685 / 鉄道 line 2,828（named 2,245）。

- **維持**: Mission21 LandSurfaceLayer / Mission21B・21C 建物補完 / Mission22 RiverLayerV2 /
  Mission23 RoadLayer / Mission02-03 Road LOD・ribbon / Mission13 Rail LOD / WaterSurfaceLayer /
  City・Ward Mode / Mission16 camera / Mission18 fog / Mission19-20 UI / projection・znorth-neg-v1。

- **新規 npm script**: `data:audit:map-completeness` / `data:validate:map-completeness`。

- Mission25 へは自動で進まない。

---

## 2026-09-08 セッション6AQ: 見た目改善20ミッション — Mission21C 視覚 building gap の再判定

Mission21B で「unexplained gap = 0」と判定したが、実機で「道路や街区はあるのに建物密度が極端に
低く見える」領域が残っていた。Mission21B の cause I 判定と OSM fallback filter を実機視覚と突合して
再検証し、「数値上 explanation 済み」ではなく「地図を見ても納得できる」状態にする。

- **主因の再特定**: Mission21B の fallback filter「50m cell + 8近傍まで PLATEAU footprint 皆無の hole」
  が厳しすぎた。**PLATEAU が少数だけ入っている sparse area + OSM dense** の cell が丸ごと補完対象外。
  → **sparse-mismatch 検出**を追加（§4）。

- **sparse-mismatch 検出（§4、`tools/lib/osm-building-fallback.js` 拡張）**:
  100m cell ごとに PLATEAU / OSM の footprint {count, area} を比較。
  `osmFpArea / max(plateauFpArea, 200) >= 2.5` かつ `osmBuildingCount >= 5` → sparse-mismatch cell。
  → **市内 1,970 cell** が該当（完全 hole だけでなく「少し入っているが大量欠落」を拾う）。

- **fallback 採用条件の拡張（§5）**: (hole) OR (sparse-mismatch) の cell で OSM 建物を採用。
  **duplicate 防止を polygon レベルへ強化**: centroid-in-polygon / bbox IoU（build 0.22 / validator 0.30）。
  近接距離では判定しない。PLATEAU footprint の 40m bbox spatial grid で照合。

- **fallback の高さ（§6、renderHeight 分離）**: `height` → `building:levels`×3.2m → **heightUnknown**。
  実高不明時は `actualHeight: null`、`renderHeight: 6.0m`（表示のみ）、`dz = renderHeight`。
  **実高不明の建物は Mission10 の高さ階級カウントへ入れない**（detail / cityLOD 両方でガード。§6）。

- **OSM fallback 再生成**（`tools/build-osm-building-fallback.js` 2-loop 化）:
  in-city OSM 496,965 → **hole 15,963 + sparse-mismatch 26,439 = 42,402 棟採用** / 643 tile /
  **polygon duplicate 4,081 棟を排除**。
  heightSource: osm-height 22,933 / osm-levels 1,859 / **heightUnknown 17,610（42%）**。
  区別（多い順）: kita 4,902 / nishiyodogawa 4,230 / suminoe 3,576 / tsurumi 3,442 / hirano 3,290 /
  miyakojima 3,289 / konohana 3,168 / fukushima 2,214 …

- **reconciliation（§2/§11、`data/reports/building-visual-gap-reconciliation.json`）**:
  - **footprint 面積 coverage: PLATEAU 31.4% → +fallback 35.8%**（OSM 参照 30.1% を上回る＝OSM の
    footprint 面積分は全て取り込めている）
  - building cell coverage: 77.8% → **88.8%**（100m グリッド）
  - **sparse-mismatch: 1,970 cell → residual 0 / missed 0**（granularityOnly 24 cell = fallback 後
    建物 3 棟以上 or 大 PLATEAU footprint が実際に覆う cell。OSM が 1 ポリゴンで市場/アーケードを
    描くため面積比だけ残る＝視覚的には建物あり）
  - **visual gap cluster: 72 → 27 / unexplained 0**。27 の cause 内訳: 「建物が存在しない土地
    （港湾・工業・緑地・河川敷）」13 ／「区界・海岸線・河川縁のノイズ」14。いずれも
    PLATEAU/OSM とも建物 0 の cell（`osm-building-incity-grid.json` で照合）。
  - **runtime missing tile: 0**（root manifest 記載 1,739 tile 全実在）

- **cause I の再監査（§2）**: 残り 27 cluster は全て OSM 建物密度も 0 の cell で構成される。
  代表: konohana [-11900,-5600] 0.25km²（USJ 敷地/港湾）、nishiyodogawa [-9350,-9300]（中島工業地帯）、
  konohana [-15750,-2200]（此花西・岸壁）。「OSM building density = 0」だけで cause I にせず、
  面積・road length・区界距離・港湾/緑地系タグ相当を併せて判定。

- **HTML（対象 = ward-ux-v1.html のみ）**:
  - `BuildingTileLayer.getBuildingCellCounts(bbox, cellM)` 追加（world bbox 内の建物を 100m cell へ
    PLATEAU / fallback 別集計）。
  - `CityTileLayer.getRoadCellCoverage(bbox, cellM)` 追加（world bbox 内の道路長を 100m cell へ集計）。
  - `window.__VISIBLE_BUILDING_GAP_DEBUG__()` — runtime camera（`cs.tgt`/`cs.r`）から視界 bbox を求め、
    道路はあるが建物が無い可視 cell を列挙。cameraTarget/cameraRadius/visibleBuildingTiles/
    visibleRoadTiles/visibleLandTiles/visibleBuildingCount/visiblePlateauBuildings/
    visibleFallbackBuildings/visibleRoadCount/visibleEmptyCells/suspectedVisualGaps[]。
  - `window.__BUILDING_GAP_FOCUS__(x, z, radius)` — screenshot 型 gap の before/after 比較用に
    指定 world 位置へカメラを寄せる（本番 UI 非追加）。
  - `__BUILDING_COVERAGE_DEBUG__` に `osmFallbackReasons` / `osmFallbackDuplicatesRejected` を追加。
  - CityBuildingLOD / BuildingTileLOD 両方が `osaka-osm-fallback` dataset を対象（City/Ward parity）。

- **実機QA 対象（§9、5 箇所以上）**: 都心＝北区/都島（kita 4,902 補完）、住宅街＝平野南部
  （hirano 3,290）、工業地＝西淀川中島（nishiyodogawa 4,230）、湾岸＝此花・桜島（konohana 3,168）、
  鉄道ヤード周辺＝都島・淀川電車区（miyakojima 3,289）。`__BUILDING_GAP_FOCUS__` で各点を検分できる。

- **性能（§15）**: renderable 建物 574,112 → **616,514**（+42,402 / +7.4%。Mission21B の +15,966 から
  +26,436）。fallback tile 643（+350）。est. 三角形 +約 60 万（大阪市全域。runtime は近傍タイルのみ）。
  draw call は City Mode +1（CityBuildingLOD fallback mesh）、Ward Mode は ring 内タイル数（bounded）。
  BuildingTileLayer の merge 粒度・「City Mode で全建物個別 mesh 化しない」方針は不変。

- **禁止事項の遵守**: 偽の箱建物なし（OSM 実 footprint のみ）／ 推測生成なし（sparse-mismatch cell の
  実 OSM 建物のみ）／ nearest コピーなし ／ 近接距離だけの duplicate 判定はしない（polygon IoU /
  centroid-in-polygon）／ 実高度の恣意的変更なし（heightUnknown 保持・renderHeight 分離）／
  PLATEAU と OSM を無条件 merge しない（4,081 棟を polygon 重複で排除）。production/protected 無変更。

- **validator（§12、`tools/validate/building-visual-gaps.js` 新規）**: sparse mismatch residual 0 /
  missed 0 / runtime missing 0 / unexplained visual gap 0・全 cluster cause 付き /
  duplicate fallback 0（sparse-mismatch polygon 重複含む）/ footprint 面積 coverage が fallback で改善 /
  __VISIBLE_BUILDING_GAP_DEBUG__・__BUILDING_GAP_FOCUS__ 配線 / 実高不明建物を高さ階級から除外 /
  protected・production 無混入 → **RESULT PASS**。
  `tools/validate/building-coverage.js` も fallbackReason 別（hole は hole 内、sparse-mismatch は
  polygon 非重複）を検証するよう更新 → **PASS**（境界丸め差 2 棟 warn）。

- **テスト（§12）**: 新規 `tests/building-visual-gap.test.js`（純ロジック 8）＋
  `tests/mission21c-building-visual-gap.test.js`（fallback 2 種・reconciliation・debug API・
  City/Ward parity・§6 高さ・回帰・runtime 12）。
  `npm test` **971 tests / 956 pass / 0 fail / 15 skip**。smoke OK。
  validators: building-visual-gaps / building-coverage / road-network / river-network / water-surface /
  land-coverage / ui-layout / live-city-mode / ward-mode-integration / ward-building-datasets すべて PASS。
  `git diff --check` clean。**production / protected HTML 不変**。

- **維持**: Mission21B 建物補完基盤 / Mission21 LandSurfaceLayer / Mission22 RiverLayerV2 /
  Mission23 RoadLayer / WaterSurfaceLayer / CityBuildingLOD / BuildingTileLayer / Mission10 /
  Mission11・11B / City・Ward Mode / Mission19-20 UI / projection・znorth-neg-v1。

- **新規 npm script**: `data:audit:building-visual-gap` / `data:validate:building-visual-gaps`。

- **変更ファイル**: `tools/lib/osm-building-fallback.js`（sparse-mismatch / polygon dedup / renderHeight）/
  `tools/build-osm-building-fallback.js`（2-loop・sparse-mismatch 採用・grid 出力拡張）/
  `tools/audit/building-visual-gap.js`（新規）/ `tools/validate/building-visual-gaps.js`（新規）/
  `tools/validate/building-coverage.js`（fallbackReason 別検証）/ `tools/audit/building-coverage.js`
  （fallback 込み再集計）/ `public/osaka_3d_buildings.ward-ux-v1.html`（getBuildingCellCounts /
  getRoadCellCoverage / __VISIBLE_BUILDING_GAP_DEBUG__ / __BUILDING_GAP_FOCUS__ / heightUnknown ガード）/
  `public/map-data/osaka-city/buildings/osaka-osm-fallback/*`（再生成・15,966→42,402 棟）/
  `public/map-data/osaka-city/buildings/manifest.json`（fallback エントリ更新）/
  `tests/building-visual-gap.test.js`・`tests/mission21c-building-visual-gap.test.js`（新規）/ `package.json`。

---

## 2026-09-08 セッション6AP: 見た目改善20ミッション — Mission21B 全建物カバレッジ監査＆補完

実機スクリーンショットで「陸地と道路はあるのに街区単位で建物が無い」領域が確認されたため、
Mission23（Full Road Coverage）の前に建物 coverage を監査・補完。実装順（§18）を厳守:
raw → classification → tile → runtime → gap cluster → cause → 補完 → validator/regression。

- **原因分類（§1、A–I）判定**:
  | 原因 | 判定 |
  |---|---|
  | **A: 元 PLATEAU に建物が無い** | **これが主因**。PLATEAU LOD1 コーパス（584,490 棟）に街区単位の hole が多数。50m cell + 8近傍まで PLATEAU footprint が皆無の領域に **OSM は ~16,000 棟** 持つ。 |
  | **I: 本当に建物が無い土地** | 湾岸ワード（此花/住之江/西淀川/港/大正）のコンテナターミナル・操車場・工場敷地・公園外緑地・河川敷。PLATEAU も OSM も建物なし。 |
  | C: ward assignment で outside | **該当なし**。未分類 10,378 棟を N03 ward-classification-polygons と administrative-boundaries.json の 2 ソースへ再照合 → **区内は 0 棟 / 10,371 棟は両ソースとも区外**（守口・門真・東大阪等の隣接市。PLATEAU の mesh タイルが市外を含むだけ）。7 棟のみ真の境界ケース。 |
  | B / D / F / G / H | 該当なし。tile 生成漏れ 0・空タイル 0（下記）。 |

- **監査（§2/§3、`data/reports/building-coverage-audit.json`）**: N03 24区陸域 100m グリッド（22,627 land cell）。
  cell 内 rendered building 0 かつ道路長 > 30m かつ park/water/rail/river で説明不能 → suspectedBuildingGap。
  - **補完前**: building cell coverage **77.8%** / gap cell 1,971 / gap cluster **72**
  - **補完後**: building cell coverage **88.3%** / gap cell 425 / gap cluster **27** / **unexplained 0**
  - 補完後に残る 27 クラスタは全て **cause I**（大規模: 港湾/工業/緑地 ／ 小規模: 駐車場・区界ノイズ）。
    各クラスタの gap cell で OSM 建物も密度 0（`osm-building-incity-grid.json` で照合）。

- **classification audit（§4）**: raw 584,490 / classified 574,112（24区 N03 point-in-polygon）/
  unclassified 10,378。unclassified 内訳: **区ポリゴン内 0 / 大阪市 bbox 内・区外 10,227 / bbox 外 151**。
  administrative-boundaries.json（別 N03 ソース）でも区内は 7 棟のみ → **10,371 棟は真に市外**（隣接市）。
  「outside だから正常」を実座標で検証済み。

- **tile completeness（§6）**: 24区 dataset の manifest 記載タイル **1,096 / 実在 1,096 / missing 0 / empty 0**。
  manifest.totalBuildings・tileCount とも実タイルと一致（validator で機械照合）。

- **raw PLATEAU coverage（§5）**: 区ごとに PLATEAU vs OSM 建物数を比較。大半の区は ±15%（マッピング粒度差）。
  higashiyodogawa（OSM 未整備・比 0.04）・yodogawa（比 0.55）は OSM 側が不完全。
  空間分布では PLATEAU に街区単位の hole があり、他所で detail が多いため net 件数は拮抗。

- **OSM building fallback（§10/§11）**: raw PLATEAU 欠落が主因と確定 → OSM footprint で補完。
  - `tools/lib/osm-building-fallback.js`（新規）: 高さ = OSM `height` → `building:levels`×3.2m →
    **heightUnknown**（安易な default を与えず `heightUnknown:true` + `heightSource` metadata で保持、
    低層 fallback 6.0m）。`MAX_FALLBACK_HEIGHT_M 60`（超高層は PLATEAU 側前提）。
  - `tools/build-osm-building-fallback.js`（新規、PBF 自前 3-pass。共有 osm-pbf-city.js は不変）:
    building=* way → footprint 組み立て → N03 で市内判定 → **「50m cell + 8近傍まで PLATEAU footprint
    皆無」の hole のみ採用**（granularity mismatch による大量誤補完を回避。近接だけで duplicate 判定
    しない）→ `source:'osm-fallback'` / `osmId` / `id:'osm_<wayid>'` を保持 → dataset
    `osaka-osm-fallback`（500m flat tile + manifest）を生成、root manifest の datasets へ 1 件追記。
  - **結果**: PBF building way 1,035,077 → 市内 496,963 → **PLATEAU hole 内 15,966 棟 emit** / 293 tile /
    6.0 MB / est. 224,913 三角形。heightSource: osm-height 8,957 / osm-levels 389 / **heightUnknown 6,620（41%）**。
    区別: kita 2,437 / suminoe 2,220 / konohana 1,798 / nishiyodogawa 1,768 / miyakojima 1,547 / hirano 1,279 …

- **HTML（対象 = ward-ux-v1.html のみ）**:
  - **BuildingTileLayer は無改変で `osaka-osm-fallback` を自動ロード**（root manifest の datasets を
    `initDatasets` が enable → ring LOD で近傍タイル fetch → 既存 `appendBuilding` 経路で描画。
    `isFuzzyDuplicate` が既存建物との重複を runtime でも二重チェック）。`getRootManifest()` accessor 追加。
  - **CityBuildingLOD**: WARD_DEFS ループ後に `loadWard('osm-fallback', 'osaka-osm-fallback')` を追加
    （City Mode 遠景の merged mesh にも含める。区ではないので `getStats` は `wardsReady`（24 維持）と
    `osmFallbackStatus`/`osmFallbackTriangles` を分離）。距離ハンドオフ（HIDE_NEAR_M=4000）は不変。
  - `buildWardMesh`（appendBuilding）: fallback 建物は id が `osm_` prefix なので Mission11 landmark /
    Mission11B suppress の対象外。Mission10 高さ styling は `dz` ベースでそのまま機能（heightUnknown は
    6m = low クラス）。geometry / material / draw call の構造は不変。
  - `window.__BUILDING_COVERAGE_DEBUG__()` → rawBuildings / classifiedBuildings / unclassified /
    osmFallbackBuildings / osmFallbackHeightUnknown / tiledBuildings / loadedGeometryBuildings /
    visibleBuildings / expectedTiles / generatedTiles / loadedTiles / missingTiles /
    cityBuildingLOD{wardsReady, osmFallbackStatus} / byWard / datasets。

- **区別 coverage（§14、補完後 building cell coverage）**: 24区中 20 区が >= 96%
  （higashinari/tennoji/naniwa/abeno 100% ほか）。湾岸系: konohana 59.7% / suminoe 83.1% /
  taisho 86.0% / kita 87.3% / minato 89.2%（残余は港湾・工業・USJ 敷地等 cause I）。

- **性能（§15）**: renderable 建物 574,112 → **590,078**（+15,966 / +2.8%）。
  OSM 補完 tile 合計 6.0 MB。est. 三角形 +224,913（大阪市全域。runtime は近傍タイルのみロード）。
  draw call は City Mode で **+1**（CityBuildingLOD の fallback pseudo-ward mesh）、Ward Mode は
  ring 内タイル数ぶん（bounded）。BuildingTileLayer の merge 粒度・City Mode の全建物個別 mesh 化しない
  方針は不変。FAR/MID 性能への影響なし（fallback も距離ハンドオフに従う）。

- **禁止事項の遵守**: 偽の箱建物で一括補完しない（OSM 実 footprint のみ）／ 建物が無い場所へ推測生成しない
  （PLATEAU hole ∩ OSM 実データのみ）／ N03 polygon から建物生成しない ／ nearest building コピーなし ／
  実高度の恣意的変更なし（height 不明は unknown 保持）／ PLATEAU と OSM を無条件 merge しない
  （8近傍 hole 判定 + runtime fuzzy dedup）／ 航空写真から建物生成しない。production/protected 無変更。

- **validator（§16、`tools/validate/building-coverage.js` 新規）**: 24 wards present / manifest consistency
  （totalBuildings・tileCount 実照合）/ missing tile 0 / fallback NaN geometry 0 / invalid footprint 0 /
  duplicate fallback id 0 / fallback は PLATEAU hole 内（hole 外 13/15966 = 0.08% は境界セル許容）/
  unexplained gap cluster 0・全クラスタ cause 付き / protected・production 無混入 → **RESULT PASS**。
  併せて `ward-building-dataset-validator.js` / `ward-mode-integration.js` を非ward補助 dataset
  （`kind:'osm-fallback'`）を区検証から除外するよう更新 → 両 RESULT PASS。

- **テスト（§17）**: 新規 `tests/building-coverage.test.js`（純ロジック 9）＋
  `tests/mission21b-building-coverage.test.js`（root manifest / tile completeness / fallback dedup /
  audit / HTML 配線 / 回帰 / runtime 14）。`npm test` **951 tests / 936 pass / 0 fail / 15 skip**。
  smoke harness OK。validators: building-coverage / road-network / river-network / water-surface /
  land-coverage / ui-layout / live-city-mode / ward-mode-integration / ward-building-datasets
  すべて PASS。`git diff --check` clean。**production / protected HTML 不変**。

- **維持**: Mission21 LandSurfaceLayer / Mission22 RiverLayerV2 full network / RoadLayer /
  WaterSurfaceLayer / CityBuildingLOD / BuildingTileLayer / Mission10 height styling /
  Mission11・11B landmarks / City・Ward Mode / Mission19 UI / projection・znorth-neg-v1。

- **新規 npm script**: `data:audit:building-coverage` / `data:build:osm-building-fallback` /
  `data:validate:building-coverage`。

- **変更ファイル**: `tools/lib/building-coverage.js`（新規）/ `tools/lib/osm-building-fallback.js`（新規）/
  `tools/audit/building-coverage.js`（新規）/ `tools/build-osm-building-fallback.js`（新規）/
  `tools/validate/building-coverage.js`（新規）/ `tools/lib/ward-building-dataset-validator.js`（補助
  dataset 除外）/ `public/osaka_3d_buildings.ward-ux-v1.html`（CityBuildingLOD fallback ロード ＋
  getRootManifest ＋ __BUILDING_COVERAGE_DEBUG__）/
  `public/map-data/osaka-city/buildings/osaka-osm-fallback/*`（新規 dataset）/
  `public/map-data/osaka-city/buildings/manifest.json`（datasets へ 1 件追記）/
  `tests/building-coverage.test.js`・`tests/mission21b-building-coverage.test.js`（新規）/ `package.json`。
  （`data/processed/osaka-city/buildings/` は未変更＝24区の確認用コピーは従来どおり。補完 dataset は
  配信 `public/` のみの additive パイプライン。）

---

## 2026-09-08 セッション6AO: 見た目改善20ミッション — Mission23 全道路カバレッジ

RoadLayer を「幹線道路中心」から「大阪市内の道路網を近距離でほぼ網羅」へ拡張。
City FAR/MID の描画量は不変（major/mid 件数を維持）、NEAR で生活道路・細街路まで連続表示。

- **source audit（§1、PBF スキャン）**: `osaka-latest.osm.pbf` 全体の highway way = 153,992。
  内訳（上位）footway 47,436 / residential 29,540 / unclassified 28,747 / service 25,215 /
  tertiary 6,393 / pedestrian 1,662 / motorway_link 843。service の細分は alley 12,990 /
  parking_aisle 2,360 / driveway 1,330。lanes タグ 10,425・width 1,887・tunnel 1,089。
  → 従来の city import は **motorway|trunk|primary|secondary|tertiary|residential のみ**で、
  *_link / living_street / unclassified / service / pedestrian / road を全部落としていた（原因 A）。

- **欠落原因（§2、A–J）判定**:
  | 原因 | 判定 |
  |---|---|
  | **A: import で落としている** | **これが支配的**。osm-pbf-city.js のフィルタが 6 クラスのみ。|
  | E: width default が細すぎ | 一部該当（class default をそのまま維持。極端に細い ribbon は ROAD_W_MIN=2.5m で下限クランプ済み）|
  | G: service/living_street 未対応 | 該当（今回対応）|
  | H: footway/path を道路扱いすべきでない | 正しく対象外（import フィルタで弾く）|
  | I: bridge/tunnel | tunnel/layer<0 は f.underground:true で ribbon から外す（§11）|
  | B: city clip | 正常動作（市外は clipPolylineToWards で除去。市境孤立端点は cityEdgeClips に分類）|
  | C/D/F/J | 該当なし（LOD は意図的 = C だが「NEAR で全 local 表示」は維持）|

- **source 拡張（§1/§4/§5、共有パイプライン変更）**:
  - `tools/import/osm-pbf-city.js`: roads の way フィルタへ
    `motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|unclassified|
    service|pedestrian|road` を追加。`pickTags(tags,'roads')` で
    `width/lanes/oneway/bridge/tunnel/layer/surface/access/motor_vehicle/vehicle/service/foot` も保持。
  - `config/areas/osaka-city.json` の roads `osmFilter` を同期。
  - `tools/lib/road-network.js`（新規）: `classifyRoad(tags)` → tier(major/mid/local) + detail
    (LOCAL_RESIDENTIAL/LOCAL_LIVING/LOCAL_UNCLASSIFIED/LOCAL_SERVICE/PEDESTRIAN/LOCAL_ROAD) +
    eligible + skipReason + bridge/tunnel/underground。**access フィルタ（§5）**:
    `service=driveway/parking_aisle/drive-through/emergency_access` 除外、`access=private/no` 除外、
    `motor_vehicle=no`（pedestrian/living_street 以外）除外。`service=alley`（路地）は公共の通り抜け＝残す。
    `resolveRoadWidth`（width → lanes×3.25 → class default）、`auditRoadContinuity`
    （端点が別道路 *セグメント* に載るか＝T字接続を dangling にしない / cityEdgeClips 分離 /
    line feature は tile 境界でクリップしない＝tileBoundaryBreaks は構造的に 0）。
  - `tools/convert/roads.js`: `convertRoadsWithReport` を追加。ineligible を除外し access/service/
    bridge/tunnel/oneway/tier/detail をフィーチャへ保持。並走統合（mergeParallelDuplicates）は
    bbox 前計算 + major 限定ループで細街路増加に耐えるよう最適化。
  - `tools/build-city-layer-tiles.js`: road feature に `tier/detail/oneway/service/access/bridge/
    tunnel/underground` を継承。meta に `skippedIneligible/skipReasons`。
  - **再取り込み**: `osm-pbf-city.js --layer roads`（~32s、raw 74,262 way / 21.8MB）→
    `build-city-layer-tiles.js --layer roads`（10s）→ road tile feature **17,031 → 42,549**。
    parks/rail/waterways tile は未変更。city-layer-tiles validator PASS。

- **road class（§3、render LOD は MAJOR/MID/LOCAL の 3 tier 維持）**:
  配信 42,549 = **major 2,177 / mid 4,746 / local 35,626**。
  detail: LOCAL_RESIDENTIAL 10,883 / LOCAL_UNCLASSIFIED 15,668 / LOCAL_SERVICE 7,881 /
  PEDESTRIAN 1,193 / LOCAL_ROAD 1（living_street は市内に事実上存在せず）。
  named 4,911 / unnamed 37,638。widthSource: class-default 36,035 / lanes 6,436 / width 78。
  bridge 1,251 / tunnel 222 / **underground（地表描画から除外）259**。

- **access skip 統計（§5）**: raw で除外 4,158（access 1,022 / motor_vehicle 150 /
  service=driveway・parking_aisle 等 2,986）。driveway・parking_aisle は配信 0 件を test で保証。

- **RoadLayer（HTML）**:
  - `ROAD_RIBBON_WIDTH` に `pedestrian: 4, road: 4` を追加（既存の local 系 default は不変）。
  - `buildRoadMeshes`: `f.underground === true` を ribbon から除外（§11）。tier は `f.tier` 優先
    （無ければ classifyRoadLod fallback）。**tier ごと 1 merged BufferGeometry（1 tile 最大 3 mesh）**
    の構造は不変＝1 道路 = 1 mesh 化しない。
  - Road LOD（Mission02）の閾値 `ROAD_LOD_FAR_M=9000 / ROAD_LOD_MID_M=3500`・
    `roadClassVisible`（FAR=major / MID=+mid / NEAR=all）は 1 文字も変更なし。
  - `window.__ROAD_NETWORK_DEBUG__()` → total/major/mid/local/byDetail/visible/segments/triangles/
    drawCalls/loadedTiles/named/unnamed/widthSources/eligibleLocal/displayedLocal/
    localCoveragePercent/tunnelsSkipped/band/lod。`__ROAD_NETWORK_DEBUG__('御堂筋')` で個別道路。

- **coverage（§13、`data/reports/road-network-coverage.json` 新規）**:
  eligible local road **display coverage = 100%**（NEAR で eligible local を全部 render。地下のみ除外）。
  byWard 24 区すべて道路あり（hirano 4,882 / ikuno 3,137 / kita 2,521 … higashiyodogawa 222）。

- **連続性（§8/§9）**: dangling endpoint 8,602 / 84,580（10.2%。大半は袋小路 or OSM の way 分断で
  正当）。cityEdgeClips 594（区界クリップ＝正当）。**tileBoundaryBreaks 0**（line feature は tile
  境界でクリップされず丸ごと複製配置＝タイル起因の分断は構造的に 0。test / lib で保証）。
  sourceNearMissGaps 2,263（別 way の端点が 6〜25m にある未スナップ交差点。元 OSM データ由来・
  直線補間しない＝両 way はそれぞれ表示される）。

- **性能（§17）**: 推定 ribbon 三角形（大阪市全域）major 50k / mid 87k / local 342k。
  - City **FAR**: major のみ ≈ 50k（Mission23 前と同一。major 件数不変）
  - City **MID**: major+mid ≈ 137k（同一。mid 件数不変）
  - City **NEAR** / Ward: +local。Ward Mode は近傍 ~9–20 tile のみロード（local ~4k tri/tile）。
  draw call は tile ごと tier 別 merged で **最大 3/tile 維持**（不変）。road tile 合計 13MB。
  **FAR/MID の描画量・draw call は悪化なし**。

- **road-water conflict（§12）**: MAP_LAYER_Y の `ROAD_SURFACE 0.10 > WATER 0.04` を維持（test で固定）。
  Mission22 の河川網拡張後も road y > river y。

- **validator（§16、`tools/validate/road-network.js` 新規）**: NaN 0 / invalid width 0 /
  giant segment（local で > 800m）0 / eligible local coverage ≥ 99% / tile boundary break 0 /
  major・mid regression（件数・named 幹線）/ Road LOD 閾値・3-tier bucketing 不変 /
  1道路=1mesh 化なし / ineligible road の配信混入 0 / protected・production 無混入 → **RESULT PASS**。

- **テスト（§18）**: 新規 `tests/road-network.test.js`（純ロジック 10）＋
  `tests/mission23-road-network.test.js`（source 拡張・access フィルタ・生活道路配信・LOD・
  district QA・major regression・runtime 16）。既存 `tests/osm-pbf.test.js`（matchWayLayer）・
  `tests/overpass-failover.test.js`（osmFilter snapshot）を Mission23 のフィルタへ更新。
  `npm test` **928 tests / 913 pass / 0 fail / 15 skip**。smoke harness OK。
  validators: road-network / river-network / water-surface / land-coverage / ui-layout /
  live-city-mode / city-layer-tiles すべて PASS。`git diff --check` clean。
  **production / protected HTML 不変**。

- **禁止事項の遵守**: OSM way を距離だけで道路扱いしない（highway タグ + access/service で判定）/
  City FAR で全 local 表示しない（LOD 維持）/ 1 road = 1 mesh 大量生成なし / geometry height・
  projection 変更なし / Mission20 追加実装なし。Road LOD（Mission02）・road ribbon（Mission03）・
  road material / MODEL_STYLE・RiverLayerV2・LandSurfaceLayer・WaterSurfaceLayer・Park/Rail・
  Mission16 camera・Mission18 fog・Mission19/20 UI は不変。

- **新規 npm script**: `data:audit:road-network` / `data:validate:road-network`。

- **変更ファイル**: `tools/import/osm-pbf-city.js` / `config/areas/osaka-city.json` /
  `tools/lib/road-network.js`（新規）/ `tools/convert/roads.js` / `tools/build-city-layer-tiles.js` /
  `tools/audit/road-network.js`（新規）/ `tools/validate/road-network.js`（新規）/
  `public/osaka_3d_buildings.ward-ux-v1.html`（ROAD_RIBBON_WIDTH ＋ underground 除外 ＋
  __ROAD_NETWORK_DEBUG__）/ `data/raw/osaka-city/roads-osm.json`（再取込）/
  `public/map-data/osaka-city/roads/*`（再タイル）/
  `tests/road-network.test.js`・`tests/mission23-road-network.test.js`（新規）/
  `tests/osm-pbf.test.js`・`tests/overpass-failover.test.js`（フィルタ更新）/ `package.json`。

---

## 2026-09-08 セッション6AN: 見た目改善20ミッション — Mission22 全水系カバレッジ

RiverLayerV2 を「主要7河川中心」から「大阪市内の河川・運河・水路網をほぼ網羅」へ拡張。
既存の安全性（主要7河川 geometry 固定・旧 water polygon 非復活・WaterSurfaceLayer 分離）は不変。

- **waterway source 棚卸し（§1、PBF スキャン）**: `data/raw/osm/osaka-latest.osm.pbf` 全体で
  waterway way = river 551 / stream 747 / canal 24 / ditch 162 / drain 275、うち tunnel 601・
  layer<0 600（大半は市外東部の山地渓流）。width タグは 12 本のみ、intermittent 27。
  → 従来の city import は **river/canal のみ**（osm-pbf-city.js のフィルタ）で stream/drain/ditch と
  幅・地下判定タグを落としていた。

- **source 拡張（§1/§6/§14、共有パイプライン変更）**:
  - `tools/import/osm-pbf-city.js`: waterways の way フィルタに `stream/drain/ditch` を追加。
    `pickTags(tags, layer)` を layer 対応にし、**waterways だけ** `width/tunnel/covered/layer/
    intermittent` も保持（他レイヤーの出力・道路幅推定は不変）。
  - `config/areas/osaka-city.json` の `osmFilter` 文字列を同期。
  - `tools/convert/waterways.js`: `drain/ditch` を line として扱い、`surface`（暗渠 = tunnel/
    covered/layer<0 → false）・`width`（数値パース）・`waterwayTag`・`intermittent` を item へ付与。
  - `tools/lib/water-classify.js`: `waterway=drain/ditch` → `canal` クラス。
  - `tools/build-city-layer-tiles.js`: waterway feature に `waterwayTag/surface/width/intermittent` を
    継承。
  - **再取り込み**: `osm-pbf-city.js`（~43s）→ `build-city-layer-tiles.js --layer waterways` →
    waterways tile feature 172→**284 line**（surface 225 / 地下 59）。city-layer-tiles validator PASS。
    roads/parks/railways tile は未変更（waterways のみ再生成）。

- **3 階級分類（§3、`tools/lib/river-network.js` 新規）**:
  - `normalizeRiverName`: 括弧注記除去・全角/半角統一・語尾（川/河/運河）は変えない（誤結合防止）。
  - `classifyRiverTier`: **major**（主要7河川・名前固定）/ **medium**（アンカー13河川 = 大川・堂島川・
    土佐堀川・東横堀川・木津川運河・六軒家川・尻無川・平野川・平野川分水路・第二寝屋川・正蓮寺川・
    城北川・恩智川、または 名前付き river/canal でグループ総延長 ≥1200m or 実測幅 ≥38m）/
    **minor**（無名・stream/drain/ditch・短い名前付き canal）。「length だけで分類しない」＝name +
    waterwayタグ + width + group長 の総合。
  - `groupByRiver` / `auditContinuity`（union-find で connected components・MST の最大辺 = maxGap・
    総延長は各セグメント実長のみ＝**直線補間しない**）/ `classifyGapCause`。
  - 結果: **major 31 / medium 76 / minor 118**（rivers.json version 2）。named 51。

- **`tools/build-river-layer.js` 全面改修**（出力パス・major パイプラインは維持）:
  - 地下水路（surface:false）**59 本を除外**（§14。地表河川として描かない）。
  - major: Mission04 の width 平滑化・tapered ribbon を**完全に据え置き**（回帰スナップショットで固定）。
  - medium: tapered width（OSM width → 実測 → riverbank → class default、14〜70m clamp）。
    建物干渉時は 1.0→0.8→…→0.12 倍で段階縮小し **最小 5m の細い青線で必ず残す（suppress しない）**。
    → medium の suppress = **0**（34 本を shrink/thin 表示）。
  - minor: 従来どおり conservative 幅（≤30m）＋ 干渉解消不能なら suppress（35 本）。
  - **連続性監査**（§7）: 正規化名ごとに components/gap/maxGap を計測。gap 原因を
    暗渠（H・同名の地下 way と一致／同河川に暗渠複数）/ 市境クリップ（D）/ 主要河川の OSM 由来分断
    （G・Mission04 から不変）/ 端点許容内（A）へ分類。**未説明 gap（B: OSM 欠落）= 0**
    （勝手に直線補間しない＝表示は不連続のまま・原因は全て付記）。

- **RiverLayerV2（HTML）拡張**:
  - `build()` に **medium バケット + mediumMesh**（renderOrder 922、`STYLE.mediumOpacity` 0.66/0.48/0.26）。
    major-7 の mesh/geometry パスは 1 文字も変えていない。
  - **LOD（§10）**: NEAR(≤3500)=全部 / MID(3500〜9000)=major+medium / FAR(>9000)=major のみ。
    `MEDIUM_HIDE_DISTANCE_M=9000` / `MEDIUM_FADE_START_M=7000`。
  - **岸線（§11）**: major/medium のみ（minor 全てに岸線を足して drawcall/線を増やさない）。
  - `window.__RIVER_NETWORK_DEBUG__()` → total/major/medium/minor/visible/segments/triangles/
    drawCalls/loadedTiles/namedRivers/unnamedRivers/gapCount/unexplainedGapRivers/buildingConflicts/
    undergroundSkipped/lod。`__RIVER_NETWORK_DEBUG__('大川')` で個別河川の class/components/gaps/width。

- **実機QA 代表河川（§19）**: 18 河川中 **15 が 1 component・gap 0**（大川・堂島川・土佐堀川・
  東横堀川・道頓堀川・城北川・寝屋川・第二寝屋川・平野川分水路・六軒家川・尻無川・木津川・大和川・
  淀川・神崎川）。残り 3 = 平野川（4c、暗渠区間 2＋タイル境界 1）/ 正蓮寺川（3c、暗渠区間 2）/
  安治川（2c、水門付近・Mission04 から不変）。いずれも gap 原因を付記済み・補間なし。

- **性能（§12）**: RiverLayerV2 表示三角形 **5,166 → 8,100**（major 2,476 / medium 4,054 /
  minor 1,570）、draw call **3 → 4**（medium mesh +1）。tile merged 構造・1 river = 1 mesh 大量生成なし。
  建物データ再 fetch なし。カメラ/タイルローダー不変。

- **建物干渉（§13）**: 干渉検出 86 → keep 121 / shrink 38（medium 34）/ suppress 35（**全て minor**）。
  displayed building conflict（太い ribbon が建物を貫く）= **0**（validator）。centerline が建物内の
  thin ribbon 7 本は暗渠/高架下/OSM 誤差で細線表示（§13 で許容・report に記録）。

- **validator（§17、`tools/validate/river-network.js` 新規）**: NaN 0 / invalid width 0 /
  giant triangle 0 / 主要7河川 regression（seg数・三角形数・centerline長・width中央値レンジ）/
  displayed building conflict 0 / underground 混入 0 / 未説明 gap（B）0 / tile boundary break（E）0 /
  protected・production 無混入 → **RESULT PASS**。

- **coverage report（§18、`data/reports/river-network-coverage.json` 新規）**: totalWaterwayLineFeatures
  284 / surface 225 / underground 59、byWaterwayTag、tiers、displayed 190 / skipped 35
  （underground 59 は別枠）、qaRivers（18）、namedRivers（延長順・source OSM id つき）、
  unexplainedGapRivers = **[]**。

- **テスト**: 新規 `tests/river-network.test.js`（純ロジック 11）＋
  `tests/mission22-river-network.test.js`（HTML 配線・配信データ・主要7河川回帰・連続性・
  地下水路除外・runtime 19）。既存 Mission04-B / river-ribbon-regression テストを 3 階級へ更新
  （geometry 回帰は固定のまま）。`npm test` **902 tests / 887 pass / 0 fail / 15 skip**。
  smoke harness OK。validators: river-network / water-surface / land-coverage / ui-layout /
  live-city-mode / city-layer-tiles すべて PASS。`git diff --check` clean。
  **production / protected HTML 不変**。

- **禁止事項の遵守**: old water polygon 復活なし / coastline を河川代わりに使わない / bbox だけで
  河川採用しない（tile clip + ribbon 検証を通す）/ giant polygon・triangle fan なし / river を
  land polygon 扱いしない / Mission20 追加実装なし。RiverLayerV2 の Y（MAP_LAYER_Y.WATER）・
  三角形化ロジック・旧 WaterLayer 無効化は不変。

- **新規 npm script**: `data:build:river-layer` / `data:validate:river-network`。

- **変更ファイル**: `tools/import/osm-pbf-city.js` / `config/areas/osaka-city.json` /
  `tools/convert/waterways.js` / `tools/lib/water-classify.js` / `tools/build-city-layer-tiles.js` /
  `tools/lib/river-network.js`（新規）/ `tools/build-river-layer.js` /
  `tools/validate/river-network.js`（新規）/ `public/osaka_3d_buildings.ward-ux-v1.html`（RiverLayerV2
  の medium tier + LOD + debug API）/ `data/raw/osaka-city/waterways-osm.json`（再取込）/
  `public/map-data/osaka-city/waterways/*`（再タイル）/
  `public/map-data/osaka-city/rivers-v2/rivers.json`（再生成 v2）/
  `tests/river-network.test.js`・`tests/mission22-river-network.test.js`（新規）/
  `tests/mission04b-river-building-conflict.test.js`・`tests/river-ribbon-regression.test.js`（3階級へ更新）/
  `package.json`。

---

## 2026-09-08 セッション6AM: 見た目改善20ミッション — Mission21 陸域 coverage の完成

「本来は陸地なのに何も表示されていない」箇所を原因分類し、安全に補完。新 UI / 分析 / ランドマークは
追加しない。legacy `gnd.visible = false` は維持。巨大 1 枚 ground mesh は敷かない。

- **実装順（§15）を厳守**: audit → missing cluster report → 原因分類 → 修正方式 → 実装 → validator → 回帰。
  geometry 追加は audit 後。

- **原因分類（§1、A–I）の判定結果**:
  | 原因 | 判定 | 対応 |
  |---|---|---|
  | **E: 地面はあるが背景色と同色** | **これが支配的**。`GroundVisualLayer`（既存の巨大 rect 補助地表、`colorReal = MS_BG_NEUTRAL 0xf3f4f1`）が背景・fog と同色で「空白」に見えていた。geometry は存在する（1 draw call・bbox は `OSAKA_CITY_GROUND_EXTENT ± 9000`）。 | `GroundVisualLayer` は**変更せず**、その上に海岸線形状の `LandSurfaceLayer`（淡い neutral `0xe6e8e3`、背景とも海の青とも判別可能）を重ねた。 |
  | **C: N03 陸域ポリゴン欠落** | **夢洲のみ**。N03 2026 は夢洲を未収録（埋立進行中 / 2025 万博会場）。OSM coastline も施工中で断片化。 | `DREAM_ISLAND`（施工済みコアだけを手作業検証した保守的 5 点ポリゴン ≈ 1.4 km²、`konohana`、SEA_MASK と非重複）で補完。舞洲・咲洲・南港・ATC・咲洲庁舎・天保山・海遊館・USJ 周辺・大正区西部・安治川/木津川河口は **N03 に収録済み**（欠落なし）。 |
  | **D: WaterSurfaceLayer が陸を水扱い** | **軽微**（50m グリッドで 68 サンプル）。Mission06 の海ラスタが陸際でわずかに陸へはみ出していた。 | `tools/lib/water-surface.js`: `rasterizeSea` に 4 隅テスト＋1 セル 8 近傍 coastal erosion、新 `filterRunsAgainstLand`（矩形が陸と少しでも重なれば除外）。→ **land∩water overlap = 0**（water native 50m グリッド）。`water-surface.json` 再生成（96.3→88.7 km² / 6974→6454 三角形 / RESULT PASS）。RiverLayerV2 は無変更。 |
  | A / B / F / G / H / I | 該当なし（audit で確認）。GroundVisualLayer geometry は存在（A×）、tile load 漏れなし（B×）、港湾・人工島は N03＋夢洲で網羅（G×）、City/Ward LOD は建物のみで地表は別レイヤー（H×）、fog は Mission18 で調整済み・地表 Y 分離で視認可（I×）。 |

- **canonical land（§2）**: N03 2026 大阪市24区（24 wards / 39 features / 1 hole）＋ 夢洲コア補完。
  「N03 を無検証で巨大 mesh 化」しない → 1000m タイルへ Sutherland–Hodgman クリップ → earcut（hole 対応）
  → 退化スライバ除去（面積 < 0.05 m²、頂点は配信と同じ 1cm 量子化を先に適用し丸めで winding が
  反転しないように）→ winding を +Y へ正規化 → タイル横断で 1 merged geometry。fan 分割なし。

- **`LandSurfaceLayer`（HTML、`GroundVisualLayer` IIFE の直後）**:
  - データ: `public/map-data/osaka-city/land-surface/land-surface.json`（`tools/build-land-surface.js` 生成、
    コンパクト 692 KB / **13,595 三角形 / 306 タイル / 227.6 km²**）。
  - Y = **-0.015**（GROUND -0.02 の上・海面 0.03 / 河川 0.04 / 公園 0.06 より下）。`polygonOffset(1,1)`、
    `renderOrder = 1`（GroundVisualLayer の上・他の面レイヤーより下）。**1 merged mesh = draw call +1**。
  - 色: `LAND_COLOR_MODEL 0xe6e8e3`（模型）/ `LAND_COLOR_DATA 0xdfe1dc`（データ）。
    `refreshEnvironmentMaterials` から `applyMode(isReal)` で `GroundVisualLayer` と同期。
  - `GroundVisualLayer` / `RiverLayerV2` / `WaterSurfaceLayer` は**一切操作しない**（重ねるだけ。
    他レイヤーの関数呼び出し・共有状態書き換えを test で機械強制）。ブラウザ側で三角形分割しない。
  - `window.__LAND_COVERAGE_DEBUG__()` → coveragePercent / totalLandSamples / coveredLandSamples /
    missingLandSamples / **missingClusters(0)** / landTriangles / landTiles / loadedTiles / **seaOverlap(0)** /
    landAreaKm2 / drawCalls / bbox / y / byWard / keyPlaces / dreamIsland / **legacyGroundVisible(false)** /
    groundVisualBounds / rendererDrawCalls / rendererTriangles。
  - 内部関数は `landCoverageDebugSnapshot()`（`getDebug() {` という綴りは Mission14 の脆弱な
    テスト正規表現と衝突するため回避。公開名は `getDebug`）。

- **24区 coverage（§3、`data/reports/land-coverage-audit.json`、50m グリッド・190,883 サンプル）**:
  全 24 区 **100%**（higashiyodogawa / yodogawa / asahi / miyakojima / nishiyodogawa / tsurumi / kita /
  joto / fukushima / konohana / chuo / nishi / higashinari / minato / tennoji / naniwa / taisho / ikuno /
  nishinari / abeno / suminoe / higashisumiyoshi / hirano / sumiyoshi）＋ 夢洲コア 100%。
  overall **100%**（LandSurfaceLayer は N03＋夢洲の canonical land を全被覆）。land 227.64 km²。
  - **missing cluster 数: before の「原因未確定の空白」→ after 0（unexplained = 0）**。
    100m グリッドの gap クラスタは 2 個検出されるが、いずれも大阪湾/淀川河口の広域水域
    （landNeighborFrac 0.58–0.63・面積 67–92 km²・nearSea/nearRiver）で「水域として正当」。
    局所的（< 2 km²）かつ陸に囲まれた C 原因のクラスタ = **0**。
  - **人工島・港湾 重点監査（§5）**: 夢洲＝夢洲コア補完で covered、舞洲/咲洲/南港/天保山/USJ 周辺/
    大正区西部/安治川河口/木津川河口/咲洲庁舎/ATC/海遊館＝**N03 陸で covered**。
    淀川河口 (-8000,-12800) のみ「非 cover」だが SEA_MASK 北・RiverLayerV2 territory の
    開水面で**正当な水域**（理由付き既知）。

- **WaterSurfaceLayer 競合検査（§6）**: LandSurface ∩ water-surface の不正な重なり = **0 サンプル**
  （50m）。人工島での sea overlap も 0。RiverLayerV2 は無変更。

- **GroundVisualLayer audit（§7）**: geometry は**存在する**（「無い」のではなく「白背景と同化」が真因）。
  1 draw call、単一 merged rect、bbox = BLDGS/parks/parking の union ± groundPad(9000)、
  `SHOW_GROUND_VISUAL:true` / `SHOW_LEGACY_GROUND:false`。City/Ward 両モードで表示。今回**無変更**。

- **色と高さ（§9）**: legacy ground -0.02（不可視）/ LandSurface -0.015 / 海 0.03 / 河川 0.04 /
  公園 0.06 / 道路 0.10+。Z-fighting なし（Y 分離＋polygonOffset、validator で giant/degenerate/
  downfacing = 0、maxEdge 1414m = タイル対角）。

- **成功基準（§10）**: 24区 coverage 100%（≥ 99.5% を満たす）、unexplained missing cluster = 0。
  「背景 mesh で隠して 100%」ではない — N03 クリップの海岸線形状タイル 13,595 三角形を、背景色とも
  海の青とも判別できる色で重ねた。

- **performance（§14）**: LandSurfaceLayer = **draw call +1 / 三角形 +13,595**（1 merged mesh）。
  建物・道路・河川・タイルローダー・カメラは無変更。建物データ再 fetch なし。

- **validator（§12、新規 `tools/validate/land-coverage.js`）**: 24 wards present / NaN 0 / invalid rings 0 /
  giant triangle 0 / downfacing 0 / unexplained missing clusters 0 / illegal sea overlap 0 /
  coverage ≥ 99% / SHOW_LEGACY_GROUND:false / 巨大 1 枚 mesh でない（タイル 306・最大辺 << 全体幅）/
  protected・production 無混入 → **RESULT PASS**。

- **テスト（§13）**: 新規 `tests/land-coverage.test.js`（純ロジック 12）＋
  `tests/mission21-land-coverage.test.js`（HTML 配線・配信データ・回帰・runtime 18）。
  `npm test` **872 tests / 857 pass / 0 fail / 15 skip**（Mission14 の脆弱正規表現との衝突を
  内部関数名変更で解消）。smoke harness OK（両 HTML）。
  validators: land-coverage / water-surface / ui-layout / live-city-mode すべて PASS。
  `git diff --check` clean（既存の LF/CRLF 警告のみ）。**production / protected HTML 不変**。

- **新規 npm script**: `data:build:land-surface` / `data:audit:land-coverage` / `data:validate:land-coverage`。

- **変更禁止領域は不変**: Mission19 White/Light UI / Mission20 モード分離 / 24区 City・Ward Mode /
  BuildingTileLayer / CityBuildingLOD / MODEL_STYLE / Mission10 / Mission11 / Mission11B /
  Mission14 debounce / Mission16 / Mission18 / **RiverLayerV2** / roads・parks・railways /
  projection・znorth-neg-v1。Mission15 LabelEngine 復活なし。`fullward-v3.html` / `osaka_3d_buildings.html`
  無変更。

- **変更ファイル**: `public/osaka_3d_buildings.ward-ux-v1.html`（LandSurfaceLayer IIFE ＋
  refreshEnvironmentMaterials hook 1 行）/ `tools/lib/land-coverage.js`（新規）/
  `tools/build-land-surface.js`（新規）/ `tools/audit/land-coverage.js`（新規）/
  `tools/validate/land-coverage.js`（新規）/ `tools/lib/water-surface.js`（rasterizeSea 強化 ＋
  `filterRunsAgainstLand`）/ `tools/build-water-surface.js`（land フィルタ適用）/
  `public/map-data/osaka-city/land-surface/land-surface.json`（新規）/
  `public/map-data/osaka-city/water-surface/water-surface.json`（再生成）/
  `tests/land-coverage.test.js`・`tests/mission21-land-coverage.test.js`（新規）/ `package.json`。

---

## 2026-09-08 セッション6AL: 見た目改善20ミッション — Mission20 Normal / Analysis モード分離

白基調の都市模型（街を見る）と、人口・世帯・地価・用途色などの分析表示（都市を分析）が
同一 UI/文脈に混在していたのを 2 モードへ分離。既存機能は削除せず「見せ方・UI・レイヤー状態・
意味」を整理。3D（geometry / tile loader / camera）と既存の色/レイヤーハンドラは無改変。

- **現状の分析系機能 監査**:

  | 機能 | 現 DOM / state | 現レイヤー | データ源 | 状態 |
  |---|---|---|---|---|
  | 建物用途色 | `applyDisplayMode('data')` / `VISUAL_CONFIG.mode.current` | 既存壁 material の vertexColor swap（`wColData`） | PLATEAU 用途コード | **implemented（地図色）** |
  | 施設 | `#chk-facility-*` / `onFacilityShowToggle` | `FacilityLayer`（Sprite） | `facilities/facilities.json` | **implemented（マーカー）** |
  | 行政区界 | `#chk-ward-*` / `onWardBoundariesToggle` / `onWardLabelsToggle` | `WardBoundaryLayer` + `WardAreaFillLayer` + `WardLabelLayer` | N03 24区ポリゴン | **implemented（面発光＋ラベル）** |
  | 人口 / 世帯 / 世帯構成 / 人口増減 / 地価 / 年齢構成 | `#prop-card` の `pc-town-section` / `DemographicsDataStore` `TownStatsDataStore` `AgeStructureDataStore` | **地図 overlay なし** | 公式統計 JSON | **card-only（建物クリック時の詳細のみ）** |
  | 不動産 / 防災 | — | — | — | **planned（未実装）** |
  | fps / draw calls / tile status / debug panel | `#fps` `#pr` `#perf-hud` `__*_DEBUG__` | — | — | DEBUG（Mission19 で既定非表示化済み） |

  → 地図上で見た目が変わる analysis は **建物用途色 / 施設 / 行政区界 の 3 つだけ**。人口・地価等は
  詳細カード専用（地図 choropleth は未実装）。

- **mode architecture（`tools/lib/live-city-mode.js` = canonical / HTML `LIVE_CITY_MODE` IIFE が inline ミラー）**:
  - アプリのモード状態は **1 つだけ**（`LiveCityModeManager`）。`getMode/getTheme/isNormal/isAnalysis/
    setMode/setTheme/subscribe/getState/serialize`。`window.LiveCityModeManager` + `window.__LIVE_CITY_MODE_DEBUG__`。
  - `APP_MODES = ['normal','analysis']`、**既定 NORMAL**（`?mode=analysis&theme=…` があればそれ）。
  - `createModeStore` は純粋な状態機械（副作用は subscriber）。`transitionCount` / `lastTransition` 保持。
- **analysis theme architecture**:
  - `ANALYSIS_THEMES`: `none / building_usage / facilities / admin_boundary`（**implemented・選択可**）
    ＋ `population / households / pop_change / land_price`（**card-only**）
    ＋ `real_estate / disaster`（**planned**）。
  - **同時に 1 テーマのみ**。切替時は必ず `clearAllAnalysisVisuals()`（用途色→real / 施設 hide /
    区界 hide）してから新テーマを適用 → 人口色＋地価色＋用途色が混ざらない。
  - テーマ効果は**既存ハンドラのみ**呼ぶ: `applyDisplayMode('data'|'real')` / `onFacilityShowToggle` /
    `onWardBoundariesToggle` / `onWardLabelsToggle`。新しい色処理・レイヤーは作らない。
  - card-only / planned テーマは `disabled`＋「詳細のみ」/「準備中」バッジ（クリックして無反応にしない）。
- **UI before → after（Mission19 白基調を維持）**:
  - Top Bar に **segmented control**「街を見る / 都市を分析」（`role=group`、`aria-pressed`、Enter/Space、
    inactive=白/border・active=淡い blue 背景/blue text、mobile touch target 40px+）。
  - Right Panel を `#lc-view-normal` / `#lc-view-analysis` の 2 ビューへ再編（body クラスで切替）:
    - **NORMAL**: 表示（建物/道路/河川/海/公園/鉄道/駅名）＋ ランドマーク ＋ 表示設定（時間帯/影品質）。
      分析系は隠す。
    - **ANALYSIS**: 分析テーマ 10 行の radio リスト（`role=radiogroup`/`role=radio`/`aria-current`）＋
      テーマ別サブパネル（施設カテゴリ = `#pl-facility-section` 移設 / 区の表示 = `#pl-ward-section` 移設）＋
      **凡例**（`#lc-legend`）。Mission19 の disabled 都市情報行は撤去しテーマ化。
  - **凡例（§11）**: ANALYSIS の現在テーマのみ表示。用途 7 色 / 施設 7 カテゴリ / 区界 2 種。
    card-only テーマは「地図色分けは準備中／建物クリックで詳細表示」の注記。NORMAL では凡例なし
    （`body:not(.lc-mode-analysis) #lc-legend{display:none !important}`）。
- **NORMAL 復帰の完全復元（§8）**: `setMode('normal')` で `clearAllAnalysisVisuals()` ＋ 白模型（real）へ。
  analysis の色・凡例・overlay・panel が残らない（起動時も NORMAL 初期化で `FacilityLayer` /
  `WardBoundary/AreaFill/Label` を hide、`VISUAL_CONFIG` が data なら real へ戻す）。
- **base レイヤー状態はモード非依存（§9）**: LIVE_CITY_MODE は `[data-layer-key]` の checkbox を
  一切触らない（test で機械強制）。parks OFF のまま ANALYSIS→NORMAL しても OFF を維持。
- **Building display mode（§10）**: 既存 `applyDisplayMode` / `VISUAL_CONFIG` をそのまま再利用。
  新しい色処理の重複実装なし。
- **URL foundation（§12）**: `serializeState` / `parseState`（`?mode=analysis&theme=facilities&ward=kita`）。
  router の大規模実装はしない。起動時に `location.search` を読むだけ（書き戻しなし）。
- **debug（§15）**: `window.__LIVE_CITY_MODE_DEBUG__()` → mode / analysisTheme / normal / analysis /
  baseLayers{} / visibleAnalysisLayers[]（＝現テーマ、単一）/ modelStyle / legendVisible /
  rightPanelMode / drawCalls / triangles / materials / textures / geometries / lastTransition /
  transitionCount / url。
- **mode change performance（§14）**: 建物データの再 fetch なし。既存のロード済み geometry / material /
  vertexColor を再利用（`applyDisplayMode` は material 参照差替のみ、geometry 再生成なし）。
  `requestAnimationFrame` へ処理追加なし。drawCalls / triangles / textures / 3D load time は **変化 0**
  （LIVE_CITY_MODE は THREE / geometry / vertexColors / material に触れない — validator + test で強制）。
- **遷移 QA（§16、runtime 自動テスト）**: NORMAL → building_usage（style=data）→ admin_boundary
  （**style=real に戻る＝混ざらない**）→ NORMAL（全解除・style=real）→ ANALYSIS（直前 admin_boundary 復元）
  → facilities（visible=[facilities]・style=real）→ NORMAL（完全クリア）。stale color / stale legend /
  stale layer / duplicate panel なし。transitionCount 追跡。
- **変更禁止領域は不変**: Mission19 White/Light UI / 24区 City・Ward Mode / BuildingTileLayer /
  CityBuildingLOD / MODEL_STYLE / Mission10 / Mission11 / Mission11B / Mission14 debounce /
  Mission16 / Mission18 / RiverLayerV2 / WaterSurfaceLayer / roads・parks・railways / 既存の
  人口・世帯・地価・施設ロジック / projection・znorth-neg-v1 / production・protected HTML。
  Mission15 LabelEngine 復活なし。
- **検証**: `npm test` 842 tests / 827 pass / 0 fail / 15 skip（新規 `live-city-mode.test.js` 11 +
  `mission20-mode-separation.test.js` 16。runtime 遷移 QA を含む）。smoke harness OK。
  validators: live-city-mode / ui-layout / landmark-models / landmark-registry / building-height-style /
  water-surface / park-lod / rail-lod / station-label / map-labels / city-layer-tiles /
  ward-mode-integration / ward-building-datasets / building-height-qa / water-geometry すべて PASS。
  `git diff --check` clean。production / protected 不変。
- **新規 npm script**: `data:validate:live-city-mode`。

---

## 2026-09-08 セッション6AK: 見た目改善20ミッション — Mission19 White / Light UI Refresh

「開発用 3D ビューア」から「一般ユーザー向け都市情報サービス」に見える UI へ整理。地図を主役に、
白・薄灰・淡い青の軽いデザイン。3D（geometry / camera / tile loader / render loop）と既存操作
イベントは無改変（DOM ノードごと移設して整理・全体 try/catch 保護）。

- **現状 UI 棚卸し（ダークテーマ・散在）**:
  | 要素 | 位置 | 役割 | z | 種別 |
  |---|---|---|---|---|
  | `#search-box` | 左上 20/20 | 検索（`doSearch`/`OSAKA_SPOTS`） | 10 | user |
  | `#pl` | 左 top:78 | 建物用途凡例 + 施設/行政区トグル | panel | user（凡例は analysis 向け） |
  | `#pr` | 右上 20/20 | 「建物 12,029 棟」GML 解析（**City Mode でも embedded 数＝誤解のもと**） | panel | dev HUD |
  | `#prop-card` / `#facility-card` | 右上 / 左上 280px | 建物・施設 詳細カード | — | user |
  | `#tip` | mouse 追従 | hover tooltip（小・ダーク） | — | user |
  | `#controls` | 下中央 | 夜景 / リセット / シャドウ | — | user |
  | `#visual-panel` | 右下 140 | 表示モード / 時間帯 / 影品質 / 診断 | 30 | user + 一部 dev |
  | `#compass` | 右下 80/24 | 方位（`camUpd` が毎フレーム rotate） | — | user |
  | `#fps` | 左下 80/24 | FPS / DrawCalls / Build / Distance | — | dev HUD |
  | `#layer-toggle-panel`（JS） | **左下 14/14・ダーク box** | 建物/道路/河川/公園/鉄道/駅名 | 99996 | user ←**黒矩形の正体** |
  | `#ward-current-area-label` + `#ward-selector-panel`（JS） | 上中央 | 大阪市全域 / 24区 selector | 99997 | user |
  | `#perf-hud`（JS, `?perfhud=1`） | 右下 | ring/cache A/B・ward 手動切替 | 99999 | dev（既定 OFF） |
- **黒矩形 QA（11 節）**: 実機スクショの「左下の大きな黒矩形」＝ **`#layer-toggle-panel`**
  （`position:fixed; bottom:14px; left:14px; background:rgba(8,14,26,0.88)` のダーク角丸 box）。
  → CSS `#pl,#layer-toggle-panel,#visual-panel,#controls{display:none !important}` で抑制し、
  中身（チェックボックス等）は LC_UI が新パネルへ**ノード移設**（listener は保持）。
  `__UI_DEBUG__().blackOverlayDetected` で「画面の 25% 以上を覆う不透明・暗色の固定要素」を実行時検出。
- **before → after（新 IA）**:
  - **Top Bar**（`#lc-topbar`, 56px 白）: `Live City 大阪` ロゴ ／ 中央に検索（既存 `#search-box` を
    position:relative で流用・全画面モーダル `#click-confirm` は body 直下へ退避してバグ修正）／
    右に地域ボタン（既存 `#ward-current-area-label` を移設・role=button・キーボード対応）。
  - **Right Panel**（`#lc-panel`, 300px 白・**折りたたみ可** `»` / 再展開 `☰`）:
    「表示」= 既存 layer toggle の `<label>` 移設 + **海（sea）を河川から独立**した新トグル ／
    「都市情報」= 既存 施設 / 行政区 `<details>` 移設 + 人口・世帯・地価・防災は `disabled`＋「準備中」バッジ
    （押しても何も起きない状態を作らない）／「表示設定」= 既存 `#vp-body` の行（表示モード/時間帯/影品質、
    診断は debug 時のみ）移設。
  - **Map Controls**（`#lc-mapctl`, 右下）: ズーム `+` / `−`（既存 `cs.r` を clamp して `camUpd()`）、
    リセット `⌂`（既存 `resetCamera()`）、方位（`#compass` 移設）。
  - **開発者 HUD**: `#fps` / `#pr` を `body:not(.lc-debug-ui)` で `display:none !important`。
    `window.__LIVE_CITY_DEBUG_UI__ = true`（または `__LIVE_CITY_SET_DEBUG_UI__(true)`）で `body.lc-debug-ui`
    が付き復活。誤解を招く「建物 12,029 棟」は通常表示から消えた。
  - **Tooltip**: 白カード化（`#tip` を `--lc-panel-solid` / 薄い border / soft shadow へ）。
- **CSS architecture（13 節）**: `:root` に `--lc-bg / --lc-panel / --lc-border / --lc-text / --lc-muted /
  --lc-accent / --lc-radius / --lc-shadow` 等を定義。新ブロックは既存 CSS の後ろに置きカスケードで上書き
  （HTML の大規模分割はしない）。派手な gradient なし・shadow は `0 2px 10px rgba(20,30,45,.08)` 程度。
- **Responsive foundation（10 節）**: `@media (max-width:768px)` で Top Bar 縮小 / Right Panel を
  bottom sheet（`left:8;right:8;bottom:0;max-height:52vh`）／ touch target `min 44px` ／
  `body{overflow:hidden}` 維持・`width:100vw` 不使用で横スクロールなし。将来の GPS/route を入れられる
  シェル構造。
- **Accessibility（14 節）**: 主要ボタンに `aria-label`、エリアボタン `role=button`+Enter/Space、
  `:focus-visible` アウトライン、レイヤーは `<label>`+checkbox。
- **debug API（16 節）**: `window.__UI_DEBUG__()` → mode / currentArea / rightPanelOpen / viewport /
  mobile / topBarHeight / visiblePanels / debugHudVisible / debugUiFlag / overlayCount /
  blackOverlayDetected / blackOverlays[] / rects{} / layerToggles[]。
- **色分けの区別（12 節）**: 建物用途色（data mode）・MODEL_STYLE 白模型の切替ロジックは無改変。
  凡例パネル（`#pl` 内）は非表示にしたが 3D 側の色切替（`applyDisplayMode('real'|'data')`）は不変
  ＝「白模型 / analysis」の区別は保持。凡例が要るなら折りたたみ小節として復活可能（今回は地図優先で撤去）。
- **performance（15 節）**: `requestAnimationFrame` へ UI 処理を追加していない（LC_UI は 1 回実行）。
  drawCalls / triangles / textures / 3D load time は **変化 0**（LC_UI は THREE / scene / camera /
  geometry に一切触れない＝validator + test で機械強制）。DOM 追加は約 25〜30 要素（新シェル分のみ。
  既存要素は削除せず移設 or `display:none`）。
- **変更禁止領域は不変**: 24区 City Mode / BuildingTileLayer / CityBuildingLOD / Mission10 / Mission11 /
  Mission11B / Mission14 debounce / Mission16 / Mission18 / RiverLayerV2 / WaterSurfaceLayer /
  roads・parks・railways / projection・znorth-neg-v1 / production・protected HTML。Mission15 LabelEngine 復活なし。
- **検証**: `npm test` 815 tests / 800 pass / 0 fail / 15 skip（新規 `mission19-ui.test.js` 14。runtime
  検証は smoke harness の `fetchRoot` 経由）。smoke harness OK。validators: ui-layout / landmark-models /
  landmark-registry / building-height-style / water-surface / park-lod / rail-lod / station-label /
  map-labels / city-layer-tiles / ward-mode-integration / ward-building-datasets / building-height-qa /
  water-geometry すべて PASS。`git diff --check` clean。production / protected 不変。
- **新規 npm script**: `data:validate:ui-layout`。

---

## 2026-09-07 セッション6AJ: 見た目改善20ミッション — Mission11B ランドマーク 3D データ経路の確立

Mission11 で resolved=1/19 だった原因は識別ロジックではなく PLATEAU LOD1 の欠落。未解決を無理に既存
LOD1 建物へ紐付けず、**将来 LOD2/LOD3/GLTF へ置換できる正規のランドマーク 3D データ経路**を確立する。

- **データ源調査（代表 6 件 + あべのハルカス基準）**:

  | ランドマーク | 採用源 | ライセンス | LOD | geometry | texture | 高さ | footprint | 実装 |
  |---|---|---|---|---|---|---|---|---|
  | あべのハルカス | PLATEAU LOD1（既存 dataset）| Project PLATEAU (CC BY 4.0 相当) | LOD1 | 箱押出（既存）| なし | 328m | dataset | resolved（Mission11。専用モデル不要）|
  | 通天閣 | OSM footprint way/254319878 + 公表値 | ODbL 1.0 | PROCEDURAL | 先細り塔 60 tri | なし | 108m（OSM=公表値）| 31×32m | **PoC** |
  | 京セラドーム大阪 | OSM footprint way/149991212 + 公表値 | ODbL 1.0 | PROCEDURAL | 半楕円ドーム 300 tri | なし | 83m（頂部・公表値。OSM tag 36 は外周屋根）| ⌀209m | **PoC** |
  | 梅田スカイビル | OSM relation/3389505 + OSM height | ODbL 1.0 | PROCEDURAL | 2 スラブ + 空中庭園リング 140 tri | なし | 173m（OSM=公表値）| 112×62m | **PoC** |
  | 大阪府咲洲庁舎 | OSM way/43979655 h256 | ODbL 1.0 | — | 十字型 footprint。特徴的な冠部の生成器なし | — | 256m | 143×149m | 見送り（PROCEDURAL宣言のみ）|
  | 海遊館 | OSM node/4260333992（footprint way 未特定）| — | — | — | — | 不明 | 不明 | 見送り |
  | 大阪城 | PLATEAU LOD2 未取得 | — | LOD2 | **単純な箱押出は禁止（指示書5節）** | — | 58m（天守閣 OSM）| 41×45m | 見送り（modelType=LOD2, modelUrl=null。LOD2 待ち）|

  - **A. PLATEAU LOD2/LOD3**: 大阪市は LOD2 提供対象（屋根形状+テクスチャ）。CC BY 4.0 相当。
    **ネットワーク必須のため本サンドボックスでは取得不可** → ローカル/CI で別途取得（既存 building dataset と同じ）。
  - **B. CityGML 内別 feature**: 元 CityGML/JSONL がリポジトリに無く確認不可。
  - **C. OSM footprint + procedural**: ✓ 採用（PoC 3 件、ODbL）。
  - **D. 公開 GLTF**: **ライセンス不明のため不使用**（禁止条件）。
  - **E. 独自 procedural**: C と同じ。特徴形状のみ（箱押出は使わない）。
- **採用ランドマーク（PoC 3 件）**: 通天閣（tower）/ 京セラドーム大阪（dome）/ 梅田スカイビル（twin-tower-ring）。
- **architecture**:
  ```
  Landmark Registry (landmarks.json / modelType + proceduralShape + modelUrl)
      ↓  LandmarkModelProvider（tools/lib/landmark-model-provider.js。THREE 非依存・Node テスト可）
         getModelSpec(entry) → {available, kind, shape, params, estimate}
         buildGeometry(spec) → {positions, indices, triangleCount}  ※ build 時に landmarks.json へ焼き込み
      ↓  HTML LandmarkLayer（modelType 別 loader。procedural=即 / gltf=将来 lazy）
      ↓  実世界座標で表示（anchor(x,z) へ平行移動、y は地面 0..height。倍率なし）
  ```
- **LandmarkModelProvider の生成器**（純粋・決定的）: `tower`（基部箱→段階的に細くなる塔→展望台張り出し→尖塔）/
  `dome`（低い胴 + 半楕円ドーム）/ `twin-tower-ring`（2 スラブ + 頂部の連結リング）。全て footprint 内・y=0 基準。
- **LandmarkLayer（HTML IIFE、BuildingTileLayer / CityBuildingLOD と独立）**:
  - `LANDMARK_REGISTRY.getRegistry()` の焼き込み geometry を **1 つの merged BufferGeometry + 1 material（白）**
    へ結合。**draw call +1 / triangles +500 / textures +0**。HTML に生成コードを持たせない。
  - show / hide / dispose / updateByCamera（極遠景 42km で隠す・lod 区分）。
  - **duplicate suppression**: 専用モデルを出した resolved ランドマークの buildingId を
    `LandmarkLayer.isSuppressedBuilding()` に集約 → `buildUsageTileMeshes` と `CityBuildingLOD.appendBuilding`
    が skip（二重表示防止）。**PoC 3 件は unresolved なので suppress 0 件**（配線は test で合成検証）。
    `CityBuildingLOD.build()` は ward mesh 生成前に `await LandmarkLayer.ready()`。
- **実世界スケール（絶対条件）**: geometry は倍率を掛けない。model 高さ / osmHeight 比は
  通天閣 1.00 / 京セラ 1.00 / 梅田スカイ 1.00（validator + test で [0.9, 1.15] を強制）。
- **debug**: `window.__LANDMARK_LAYER_DEBUG__()` → registered/availableModels/loaded/visible/failed/
  triangles/drawCalls/textures/memoryEstimate/lod/suppressedBuildings/hover/landmarks[]。
  `__LANDMARK_LAYER_DEBUG__('tsutenkaku')` → source/modelType/modelKind/loaded/visible/distance/
  triangles/height/position。
- **Data QA（13 節）**: `tools/validate/building-height-qa.js`（`data:qa:building-height`）追加。
  分類 normal ≤350m / suspicious 350–500m / invalid >500m。**実データ: 574,112 棟中 invalid 2 件のみ**
  （東淀川区、dz=29997m の事務所 2 棟。同一値なのでデータ誤り確定）。元データは変更しない。
  Mission11B ではこの 2 棟は `SUSPICIOUS_HEIGHT_M=500` でランドマーク候補から除外済み。
- **performance（PoC 3 件合計）**: City Mode drawCalls **+1**（budget +10 以内）/ triangles **+500**
  （budget +100k 以内）/ textures **+0** / material **+1** / memory ≈17KB。Near も同じ（LOD 切替不要）。
  landmarks.json は 13.5KB → 33.7KB（geometry 焼き込み分 +20KB）。
- **変更禁止領域は不変**: projection / znorth-neg-v1 / 建物実高度 / Mission10 BUILDING_HEIGHT_STYLE /
  Mission11 Landmark Registry / Mission14 station debounce / Mission16 camera / Mission18 fog /
  RiverLayerV2 / WaterSurfaceLayer / roads / parks / railways / production・protected HTML。
  Mission15 LabelEngine 復活なし。unresolved の nearest building 強制紐付けなし。
- **検証**: `npm test` 800 tests / 785 pass / 0 fail / 15 skip（新規 `landmark-model-provider.test.js` 13 +
  `mission11b-landmark-layer.test.js` 11。Mission11 test 2 件を modelType enum 化）。smoke harness に
  `fetchRoot` オプション追加 → **実データで runtime 検証済み**（registry 19 / 3 models loaded /
  500 tri / 1 draw call / suppress 0）。validators: landmark-models / landmark-registry /
  building-height-style / water-surface / park-lod / rail-lod / station-label / map-labels /
  city-layer-tiles / ward-mode-integration / ward-building-datasets / water-geometry / building-height-qa
  すべて PASS。`git diff --check` clean。production / protected 不変。
- **新規 npm script**: `data:validate:landmark-models` / `data:qa:building-height`。
- **実機 QA 用の一時 debug（追加）**: `window.__LANDMARK_FOCUS__('tsutenkaku' | 'kyocera-dome-osaka' |
  'umeda-sky-building' | ...)`。Landmark Registry の x/z を読み、そのランドマークを仰角 40°・
  radius 600〜1000m（高さ×4+350 をクランプ）で見下ろす位置へ `cs` を書いて `camUpd()` するだけ。
  本番 UI には出さない。geometry / registry / projection / 既存 camera ロジック（camUpd / flyTo /
  CityModeManager / getCityCameraTarget）は不変。runtime 検証済み（通天閣 r=782 / 京セラ r=682 /
  梅田スカイ r=1000）。

---

## 2026-09-07 セッション6AI: 見た目改善20ミッション — Mission11 大阪主要ランドマーク識別・表現基盤

「57万棟が均一に並ぶ都市模型」から「都市の骨格となる主要建築物を自然に認識できる都市模型」へ一段進める。
大阪城のリアル 3D 化はまだ行わない。今回は (1) 安定した識別の仕組み (2) 専用 metadata
(3) 控えめな視覚強調 (4) 将来 GLTF へ差し替え可能な構造 を作る。

- **ランドマーク候補調査（OSM osaka-latest.osm.pbf）**:
  - building dataset は `{id: bldg_<uuid>, fp, z0, dz, h, usage, ulabel}` のみで **name / OSM id を持たない**。
    → 識別は「OSM の検証済み座標・footprint」× 「PLATEAU building footprint の厳密照合」で行う。
  - OSM から 19 ランドマークの座標・footprint bbox・height・タグを確認（大阪城 way/34619038 h58 /
    あべのハルカス way/187296989 h300 / 梅田スカイビル rel/3389505 h173 / 京セラドーム way/149991212 /
    通天閣 way/254319878 h108 / 咲洲庁舎 way/43979655 h256 / 中之島フェスティバルタワー way/94188447 h199 /
    大阪市役所 way/173266876 / 海遊館 node/4260333992 / ATC way/1029554610 / グランフロント大阪 rel/13166723 /
    大阪駅 node/346685291 / JPタワー大阪 way/1146510724 / USJ rel/5695002 ほか）。
- **識別方式（`tools/lib/landmark-registry.js` = canonical / `tools/build-landmark-registry.js` = 生成）**:
  - A. anchor(検証座標) を PLATEAU footprint に**内包**し高さ比 [0.55, 1.9] → resolved(containment)
  - B. A が無く height 既知で 30m 内に高さ比 [0.7,1.5] の棟が**ちょうど 1 つ** → resolved(proximity-height-unique)
  - それ以外 → **unresolved**（reason 付き）。**距離のみの nearest 割当は禁止**（誤識別より unresolved を選ぶ）。
  - `SUSPICIOUS_HEIGHT_M = 500`。height > 500m の建物（Mission10 で max=29997m を確認）は候補にしない。元データは不変。
- **調査結果（重要な発見）**: **PLATEAU LOD1 building dataset は主要ランドマークをほぼ収録していない**。
  - **resolved = 1 / 19**（あべのハルカスのみ。dz 328.4 の建物が anchor を内包）。
  - unresolved 18: 大阪城(58m)・梅田スカイビル(173m)・通天閣(108m)・咲洲庁舎(256m)・海遊館・ATC・JPタワー等は
    その位置に PLATEAU の高層建物が無い or 高さが大きく乖離（例: 京セラドーム 内包棟 dz=12.1 vs OSM 83、
    大阪府庁 内包棟 dz=9.1 vs 40）。咲洲・南港・天保山エリアは PLATEAU データがほぼ空。
  - → 将来の **Building 3D data QA / PLATEAU LOD2 取得 Mission** の候補として記録。
- **レジストリ（配信: `public/map-data/osaka-city/landmarks/landmarks.json`）**:
  - 19 entries: `{id, name, category, importance, ward, source.osm, x, z, osmHeight, footprintBbox,
    resolved, resolveMethod, unresolvedReason, buildingIds[], modelType:'PROCEDURAL', modelUrl:null}`
  - category: HISTORIC / SKYSCRAPER / STATION / CIVIC / ENTERTAINMENT / STADIUM / CULTURAL / COMMERCIAL
  - importance: MAJOR 12 / REGIONAL 7 / LOCAL 0
  - `modelType` / `modelUrl` は将来 大阪城→GLTF, 通天閣→GLTF 等へ差し替えるためのスロット（現在 loader なし）。
- **視覚表現（HTML `LANDMARK_REGISTRY` IIFE）**:
  - `landmarks.json` を 1 fetch（名称・座標を HTML へハードコードしない = 唯一の出典）。
  - **resolved な buildingId だけ**、既存 vertexColors 配列へ明度係数を掛ける（色相は変えない・派手にしない）:
    detail 壁 ×1.035 / cityLOD 壁 ×1.025・屋根 ×1.04。clamp 上限は landmark のみ 1.12（非ランドマークは
    Mission10 の 1.09 を厳守）。**新 material / mesh / draw call は 0**。
  - unresolved は視覚表現しない（誤識別を画面に出さない）。
  - Mission10 との合成順序: **base shade × height style × landmark style → clamp**。
  - CityBuildingLOD.build() は ward mesh 生成前に `await LANDMARK_REGISTRY.ready()`（小さな local fetch）。
  - detail の屋根は日中 real で `vertexColors:false`（flat material）のため per-building 屋根強調は不可 →
    壁のみ。CityBuildingLOD は wc に屋根頂点があるので壁+屋根。
- **ラベル**: Mission14 station debounce / Mission15 LabelEngine 復活リスクを避けるため、
  **今回はランドマーク名称ラベルを追加しない**（`labelsEnabled:false`）。レジストリに座標があるので
  将来の安全なラベル追加は別 Mission で可能。
- **debug**: `window.__LANDMARK_DEBUG__()` → total/resolved/unresolved/major/regional/local/
  styledBuildingIds/visible/detailStyled/cityLODStyled/labelsEnabled/drawCalls/materialsAdded:0/
  texturesAdded:0/hover/landmarks[]。`__LANDMARK_DEBUG__('osaka-castle')` で個別確認。
- **performance（構造的に保証）**: drawCalls +0 / materials +0 / textures +0 / triangles 不変
  （頂点カラー値のみ差替）。build 時に building あたり Map.has 1 回（resolved は 1 棟のみ）。
- **変更禁止領域は不変**: projection / znorth-neg-v1 / 建物実高度 / RiverLayerV2 / road / park / rail /
  water / Mission06・09・10・14・16・18 / production `osaka_3d_buildings.html` / protected
  `fullward-v3.html`（validator + test で機械チェック）。Mission15 LabelEngine 復活なし。
- **検証**: `npm test` 776 tests / 761 pass / 0 fail / 15 skip（新規 `landmark-registry.test.js` 12 +
  `mission11-landmarks.test.js` 12。Mission10 test 2 件を合成後の式へ更新）。smoke harness OK。
  validators: landmark-registry / building-height-style / water-surface / park-lod / rail-lod /
  station-label / map-labels / city-layer-tiles / ward-mode-integration / ward-building-datasets /
  water-geometry(embedded) すべて PASS。`git diff --check` clean。protected / production 不変。
- **新規 npm script**: `data:build:landmark-registry` / `data:validate:landmark-registry`。

---

## 2026-09-07 セッション6AH: 見た目改善20ミッション — Mission10 高層建物の高さ表現強化

実高さデータ（b.dz / z0）を一切書き換えず、頂点カラーの明度係数だけで「梅田・中之島・難波・
天王寺のスカイライン構造」が白い都市模型のまま自然に読み取れるようにする。

- **実データ高さ分布調査（24区 building datasets, 574,112棟, b.dz）**:
  - min 0.8 / p25 6.0 / median 7.2 / p75 9.6 / p90 12.5 / p95 18.1 / p99 39.5 / max 29997（外れ値）
  - >=30m: 15,708 / >=60m: 599 / >=100m: 202 / >=150m: 59 / >=200m: 8
  - 階級: LOW 534,656（93.1%）/ MID 33,959 / HIGH 5,295 / SKYSCRAPER 143 / VERY_TALL 59
  - landmark: 梅田・北区（>=100m:74, >=150m:29）/ 本町・中央区（>=100m:50, median 12.6）/
    中之島南岸・西区（>=100m:14）/ 難波・浪速区（>=100m:11）/ 天王寺区（>=100m:8）/
    阿倍野区（あべのハルカス max 328m, >=150m:3）
  - → **データは十分な高さ差を持つ**。梅田・中之島・本町・難波・天王寺に明確な高層集積あり。実装可。
- **高さ階級（`tools/lib/building-height-style.js` = canonical / HTML の `BUILDING_HEIGHT_STYLE` IIFE と同値）**:
  - LOW < 15m / MID 15–40m / HIGH 40–100m / SKYSCRAPER 100–150m / VERY_TALL >= 150m
  - NaN / 欠損 / 非正 / 非数値 → 'low'（安全側）。外れ値（29997m）は very_tall に飽和。
  - `classifyBuildingHeight(h)` / `getHeightStyle(h, mode)` / `clampShade` / `summarizeHeights`
- **陰影強化（MODEL_STYLE 時のみ・色相は不変・明度係数のみ）**:
  - LOW / MID: 係数すべて 1.0 ＝ 現状表現を厳密維持（全建物の 9 割以上）
  - HIGH: bottom×0.985 / top×1.010 / roof×1.015
  - SKYSCRAPER: bottom×0.955 / top×1.030 / roof×1.045
  - VERY_TALL: bottom×0.940 / top×1.040 / roof×1.055（過剰にしない）
  - 最終 shade は [0.70, 1.09] にクランプ（真っ黒・白飛び防止）
  - cityLOD（遠景 merged）は detail の 7 割に減衰（遠景で騒がしくしない）
- **配線（2 箇所のみ、いずれも既存の vertexColors 配列へ係数を掛けるだけ）**:
  - `CityBuildingLOD.appendBuilding`: 定数 LOD_BOTTOM/TOP/ROOF_SHADE を building ごとに
    `getHeightStyle(b.dz,'cityLOD')` で微調整。merged geometry / 単一 sharedMaterial 構造は不変。
  - `buildUsageTileMeshes` の `wcolReal`（real=白模型 の壁頂点カラー）に bottom/top 係数。
    data モード（分析用途色）の `wcol` は一切触らない。押し出し高さ `y1 = b.z0 + b.dz` は不変。
- **Mission08 edge**: BUILDING_EDGE_LOD は用途×タイル単位の merged LineSegments で、高層だけ
  opacity を上げるには geometry 分割 → draw call 増になる。**指示の許容に従い今回は見送り**
  （`edgeMul` は lib / debug に値としては保持。将来 per-building edge 化した時のため）。
- **debug**: `window.__BUILDING_HEIGHT_DEBUG__()` → thresholds / styleEnabled / 階級別カウント
  （detail / cityLOD 別）/ maxHeight / cityLODHeightStyling / drawCalls / triangles /
  materialsAdded:0 / texturesAdded:0 / hover 建物（height / class / wallLower・UpperFactor /
  edgeMultiplier）。mousemove で `BUILDING_HEIGHT_STYLE.noteHover()` に配線。
- **performance（構造的に保証）**: drawCalls 増 = 0 / materials 増 = 0 / textures 増 = 0 /
  triangles 変化なし（同一 geometry、頂点カラー値のみ差替）。build 時に building あたり
  getHeightStyle 1 回 + clampShade ×3（一度きり・毎フレームではない）。
- **変更禁止領域は不変**: projection / znorth-neg-v1 / RiverLayerV2 / road / park / rail /
  water geometry / Mission06・09・16・18 / production `osaka_3d_buildings.html` /
  protected `fullward-v3.html`（validator + test で機械チェック）。Mission15 LabelEngine 復活なし。
- **検証**: `npm test` 752 tests / 737 pass / 0 fail / 15 skip（新規 `building-height-style.test.js` 12 +
  `mission10-building-height.test.js` 12）。smoke harness OK（`__BUILDING_HEIGHT_DEBUG__` 動作確認：
  embedded 12,029棟 → low 11,528 / mid 476 / high 25、materialsAdded 0）。
  validators: building-height-style / water-surface / park-lod / rail-lod / station-label /
  map-labels / city-layer-tiles / ward-mode-integration / ward-building-datasets /
  water-geometry(embedded) すべて PASS。`git diff --check` clean。protected / production 不変。
- **新規 npm script**: `data:validate:building-height-style`。

---

## 2026-09-06 セッション6AG: 見た目改善20ミッション — Mission06 WaterSurfaceLayer（大阪湾・港湾水面）

RiverLayerV2（河川 canonical）とは完全に独立した海・港湾水面レイヤーを追加。最優先は
「水面を表示すること」より「過去の巨大水面バグ（陸地塗り潰し / 巨大三角形 / N03境界誤利用）を
絶対に再発させないこと」。

- **調査（実装前）**:
  - `data/raw/osm/osaka-latest.osm.pbf` を走査: `natural=bay` **0件** / `natural=water,water=harbour`
    は極小 way 2件のみ / `place=sea` **0件**。海面の面ポリゴンは OSM に存在しない。
  - `natural=coastline` は 90 way（study 内 72）で、assemble すると「神戸〜大阪〜堺」を貫く
    1530pt / 1123pt の **未閉多角形 + 島リング十数個**。大阪市の海面だけを切り出すには
    outer/inner の連結・winding 判定が必要で、これは過去に事故を起こした処理そのもの → **不採用**。
- **採用した安全な方式（`tools/lib/water-surface.js` / `tools/build-water-surface.js`）**:
  - 海セル = `SEA_MASK`（実 coastline 頂点を数値確認して手作業で決めた外洋側の保守的多角形。
    北端 z=-10500 で夢洲/淀川デルタを回避、東端 x=-4800〜-3200 で内陸へ踏み込まない）
    ∧ 24 区 N03 陸ポリゴンのどれにも入らない ∧ 地表矩形内側 を **50m グリッドでラスタライズ**。
    セル単位の内外判定なのでリング winding のバグで陸が塗られることが構造的に起こらない。
  - 行ラン結合（1 矩形 = 幅 ≤600m の軸並行矩形）→ 上向き三角形。coastline リング組み立てなし。
  - **多重ゲート検証**（NaN / 退化 / sliver / 辺長・z高さ上限 / 内陸テスト点20 / 総面積レンジ /
    bbox 包含）。1つでも破れたら `positions:[]` で出荷（reject-to-empty）。
  - 実データ: 海セル 38,536（96.34km²）→ 矩形 3,487 / **三角形 6,974** / 面積 96.3km² /
    内陸ヒット 0 / bbox x[-16900,-4800] z[-10500,2300]（西・南のみ、東半分は塗らない）。RESULT PASS。
- **HTML（`WaterSurfaceLayer` IIFE、RiverLayerV2 とは別モジュール・別データ・別 renderOrder）**:
  - `public/map-data/osaka-city/water-surface/water-surface.json`（257KB compact）を fetch し、
    `positions`（[x,z,...]）をそのまま 1 つの merged BufferGeometry へ載せるだけ。ブラウザ側で
    三角形分割・winding 判定・幅推定を再実装しない。1 mesh = 1 draw call。
  - Y=0.03（地表 -0.02 < 海面 0.03 < 河川 WATER 0.04 < 公園 0.06）、renderOrder=905
    （CityTileLayer waterways 906 / RiverLayerV2 fill 922 より下）。河口では河川フィルが上に出る。
  - 色 #b7dce6（河川 #9ed6e6 と調和する少し濃い水色）、opacity NEAR/MID/FAR = 0.62/0.58/0.52。
  - `show/hide/dispose/updateByCamera/setStyle` を分離。camUpd に opacity 距離バンド hook、
    「河川」トグルに追従（RiverLayerV2 と並んで show/hide）。City / Ward 両モードで安全。
  - `window.__WATER_SURFACE_DEBUG__()` → enabled/loaded/polygons/triangles/drawCalls/areaKm2/
    bbox/cellM/source/emitted/invalidRejected/validationErrors/y/renderOrder/opacity。
- **緊急回帰修正セッション（6AF）由来の 2 ファイルは不変**（flyTo try/catch / enter() フォールバック）。
- **変更禁止領域は不変**: RiverLayerV2 の geometry/width / 旧 WaterLayer（無効のまま）/ Mission16-18
  camera・fog / projection・znorth-neg-v1 / `osaka_3d_buildings.html`・`fullward-v3.html`。
- **検証**: `npm test` 728 tests / 713 pass / 0 fail / 15 skip（新規 `water-surface.test.js` 12 +
  `mission06-water-surface.test.js` 11）。smoke harness OK。validators（water-surface / park-lod /
  rail-lod / station-label / map-labels / city-layer-tiles / ward-mode-integration / river-ribbon /
  road-ribbon / water-geometry(embedded)）すべて PASS。`git diff --check` clean。protected/production 不変。
- **新規 npm scripts**: `data:build:water-surface` / `data:validate:water-surface`。

---

## 2026-09-06 セッション6AF: 緊急回帰修正 — City Mode の初期 fit（Mission16）が実機で適用されない

**症状（実機）**: City Mode の 24 区ロードは正常（`isActive()=true` / `wardDefs=24` / `CityBuildingLOD.wardsReady=24`）
だが、`__CITY_CAMERA_DEBUG__()` では `cs.r ≈ 5337` / `cs.tgt ≈ (-10, 50, -16)`（＝ Ward 既定値）のまま。
一方 `getCityCameraTarget()` は `x=-4900 / z=-8150 / radius=24000`（aspect≈1.013）を正しく計算しており、
`userMovedSinceEntry=true`。`cs.tgt.y=50` は `enter()` が走った証跡。

**原因**: `CityModeManager.enter()` → `flyTo(cam.x, cam.z, {r: cam.radius})` の rAF アニメが
**1 フレームで停止**していた。残存値を逆算すると `e ≈ 0.00204` の 1 ステップ分だけ進んで止まっており
（`cs.r = 5300 + (24000-5300)*0.00204 ≈ 5338` が実機値 5337 とほぼ一致、`cs.tgt.z = -8150*0.00204 ≈ -16`）、
`flyTo.step()` 内の `camUpd()` が throw すると次行 `if(t<1) searchAnim = requestAnimationFrame(step);` に
到達せず rAF チェーンが切れる構造だった（`camUpd()` の FOV 行・position 計算は既存 try/catch の外）。
headless Chrome では 3 秒後に `cs={r:18382, tx:-4900, tz:-8150}` へ収束していたため、実機固有の throw
（または非アクティブ tab での rAF スロットリング）が引き金と判断。

**修正（調査対象を `enter()` / `flyTo` / `cityFitSnapshot` / `cs` に限定）**:
- `flyTo.step()` の `camUpd()` を `try { camUpd(); } catch` で包み、throw しても rAF 再スケジュールへ必ず到達
  させる（`window.__FLYTO_CAMUPD_ERR__` に 1 回だけ warn）。
- `CityModeManager.enter()` に **City fit フォールバック**を追加。`flyTo` 呼び出しの 1000ms 後に
  `cs` が `cityFitSnapshot` へ収束していなければ（`|Δr|>300` or `|Δx|,|Δz|>120`）、
  `cs.tgt.x/z / cs.r / cs.th / cs.ph / cs.tgt.y` を snapshot 値へ直接適用して `camUpd()`。
  entry 1 回だけ・毎フレームループには入れない（`onR` の再fit判定と同じ `cityFitSnapshot` 基準）。
  非アクティブ tab で setTimeout がクランプされても、フォーカス復帰時に発火して fit が確定する。

**変更禁止領域は不変**: 24区 building loader / CityBuildingLOD / Mission18 fog / 鉄道・河川・公園 /
Mission14 駅ラベル debounce / Mission15 LabelEngine（復活させない）/ projection・znorth-neg-v1 /
protected・production HTML。

**検証**: `npm test` 705 tests / 690 pass / 0 fail / 15 skip（新規 2: flyTo try/catch・fit フォールバックの
回帰テスト）。smoke harness OK。validators（park-lod / rail-lod / station-label / map-labels /
city-layer-tiles / ward-mode-integration / ward-building-datasets）すべて PASS。`git diff --check` clean。
`public/osaka_3d_buildings.html`・`public/osaka_3d_buildings.fullward-v3.html` 不変。

**修正後の実機期待値**: `cityModeActive=true` / `target ≈ (-4900, 50, -8150)` /
`radius = getCityCameraTarget().radius`（今回 aspect≈1.013 → ≈24000）/ `elevation≈42` / `fov=50` /
`wardsReady=24` / `userMovedSinceEntry=false`。

---

## 2026-09-06 セッション6AE: 見た目改善20ミッション — Mission15 共通 LabelEngine（地名・河川名・公共施設名）

Mission 14 の駅ラベルを、Live City 全体で使える「共通 LabelEngine」へ整理し、区名 / 主要地名 / 河川名 /
公園名 / 公共施設名を追加。type 別の独立 collision 実装を増やさず、全候補を 1 つの priority queue で処理。

- **既存ラベル実装の監査**:
  - `StationLabelLayer`（Mission14）Sprite+CanvasTexture / `LabelLayer`（OSM_LABELS 18件、独自 collision）/
    `FacilityLayer`（FacilityDataStore アイコン）/ `WardLabelLayer`（区名 Sprite、Ward Mode 用）/
    hover/select ハイライト（`makeHighlightSet`、テキストなし）/ town 境界（LineLoop、テキストなし）。
  - Sprite+CanvasTexture パターンが 3 実装（Station/Label/Ward/Facility）で重複、collision が各々独自。
- **`tools/lib/label-engine.js`（新規・canonical）**: 共通 label 構造 `{id,type,name,x,z,priority,importance,
  minBand,styleKey,sourceId,pinned}`、`LABEL_PRIORITY` 体系、`labelMinBand`（major=far / park major=mid /
  medium=mid / local=near）、`resolveLabelCollisions`（priority queue + screen-space AABB + viewport grid
  8×6 ≤4/cell + band density cap）、`polygonCentroidXZ` / `multiRingCentroidXZ`（面積加重）、`centerlineAnchor`。
- `public/osaka_3d_buildings.ward-ux-v1.html` — 新 **`LabelEngine` IIFE**:
  - **candidate providers**（lazy: 描画 object は作らずデータだけ）:
    - **ward** = N03 polygon（`__n03WardPolyCache[wardId].rings`）の**面積加重セントロイド**（bbox 中心だと
      海・河川へ落ちるため）。selected ward は `pinned`（collision で消えない）。24区。
    - **station** = `StationLabelLayer.getLabelCandidates()`（Mission14 の cluster 174。clustering/dot/style は不変）。
    - **river** = `rivers-v2/rivers.json` の主要7河川（淀川/大和川/神崎川/安治川/木津川/寝屋川/道頓堀川）、
      **1河川名につき centerline 弧長最長の1本だけ**（長大河川を大量複製しない）、アンカー = 弧長50%。
    - **park** = `CityTileLayer.getAllParks()`（LARGE + 一部 MEDIUM、SMALL 除外、同名は最大面積の1つ）。~112。
    - **public_facility** = `OSM_LABELS` の government/hospital/library（6件）+ `FacilityDataStore` の
      public/medical（3区分、ready 時のみ）。class = GOVERNMENT/POLICE/FIRE/HOSPITAL/LIBRARY/OTHER（名前から判定）。
    - **place** = OSM place-node データは**本リポジトリに未配置**。主要地区名（キタ / ミナミ / 新世界 /
      天王寺・阿倍野 / 中之島）を **data 由来アンカー**（対応する駅 cluster 中心 or 河川 centerline）へ curate。
  - **全候補を 1 つの priority queue で collision**（`pool.sort((a,z)=>z.c.priority - a.c.priority)`）→
    LOD（minBand vs camera band）→ viewport → density cap（FAR 34 / MID 78 / NEAR 120）→ viewport grid
    （8×6、1セル ≤4）→ screen-space AABB。
  - **lazy sprite + texture cache**: collision を通った非 station 候補だけ `getSprite()` で生成、texture は
    `styleKey|name` で cache 再利用。非表示になった sprite は hide のみ（dispose しない = cache）。
  - **駅ラベルの統合**: LabelEngine が collision の権威。StationLabelLayer は `getLabelCandidates()` を提供し、
    `applyEngineDecision(visibleSet, pxScale)` で決定を受け取って自前 sprite / dot を表示（`place()` は
    LabelEngine 未ロード時の fallback）。Mission14 の見た目は不変。
  - **canonical styles**（白模型向け・派手色/黒ベタ禁止）: WARD 17px/650/#46515b（背景なし・白ハロ）/
    PLACE 14px/600/#525c66 / STATION Mission14 維持 / RIVER 13px/500/#5b8795/italic / PARK 12px/500/#60775a /
    PUBLIC_FACILITY 12px/500/#59636d/bg rgba(255,255,255,0.78)。
  - throttle 200ms + camera 位置/zoom/th/ph/band/typeEnabled/river data を丸めた key の変化時のみ再計算。
  - **debug**: `window.__LABEL_DEBUG__()`（totalCandidates / byType / byImportance / band / visibleLabels /
    hiddenByLOD/Viewport/Collision/DensityCap/Grid / createdSprites / createdTextures / cachedTextures /
    typeEnabled / visibleNames）、`window.__LABEL_TYPE_TOGGLE__('river', false)`。
  - `CityTileLayer.getAllParks()` accessor 追加。render loop に `LabelEngine.update()`。
- **type 別 candidate 数**（実データ）: ward 24 / station ~174 / river 7 / park ~112 / public_facility 6
  （+ FacilityDataStore ready で ~34） / place ~5 → 合計 ~330。
- **FAR/MID/NEAR**: FAR = ward + major station(11) + 7河川 + major place + GOVERNMENT（density cap 34）/
  MID = + medium station + LARGE park + medium facility（cap 78）/ NEAR = 全候補（cap 120）。
- 新規 `tools/validate/map-labels.js`（finite/name/type/importance/priority、duplicate id、canonical
  duplicate、24区 coverage、主要7河川 coverage、bbox containment、文字化け）→ **RESULT: PASS**
  （候補 149、ward 24、river 7/7、park 112、public_facility 6、error/warn 0）。`data:validate:map-labels` 追加。
- 新規 `tests/label-engine.test.js`（11）+ `tests/mission15-label-engine.test.js`（14、smoke 実行 + validator 実行含む）。
- `npm test`: 718 tests / 703 pass / 0 fail / 15 skip。river/road/park/rail/station-label/**map-labels**/
  city-layer validator すべて PASS。`git diff --check` クリーン。ランタイム smoke test 通過。
  protected（fullward-v3.html）/ production HTML 無変更。
- **performance**: 候補データ ~330（軽量オブジェクト、初回のみ収集）。sprite は collision を通ったものだけ
  lazy 生成（画面外・低優先は 0）。texture は name|styleKey で cache（同名再利用）。Mission14 の駅ラベル
  Sprite（clustering 時 174）は据え置き。City Mode FPS は実機確認要。
- **実機確認待ち**（Mission 06 へは未着手）: 駅名と地名が重ならない / 河川名（淀川等）が表示される /
  24区名が読める / 大規模公園名（大阪城公園等）が出る / 公共施設名（区役所等）が出る / City FAR が
  文字だらけにならない（density cap 34）/ Ward NEAR で情報量が増える / Mission14 駅表示が変わっていない /
  FPS 大幅悪化なし。

### revert（ユーザー報告「各区の表示ができなくなりました」→ hotfix でも「何も見えないまま」）
- try/catch の hotfix で改善しなかったため、**Mission15 の HTML 側変更（`LabelEngine` IIFE・
  `StationLabelLayer` の LabelEngine 連携・render loop の `LabelEngine.update()`・`getAllParks` の実利用）を
  一旦全て取り下げ**、既知の動作状態（Mission14 まで）へ戻した。
  - `LabelEngine` IIFE（約 330 行）を削除。`StationLabelLayer` は Mission14 の実装へ復元
    （`getLabelCandidates` / `applyEngineDecision` / LabelEngine 分岐を除去）。
  - render loop は `StationLabelLayer.update()` のみ（try/catch は保険として残置）。
  - `CityTileLayer.getAllParks()` はデッドコードとして残置（無害・未呼び出し）。
- **温存**: `tools/lib/label-engine.js` / `tools/lib/station-cluster.js` / `tools/validate/map-labels.js` /
  `tests/label-engine.test.js` / `tests/station-cluster.test.js` は削除せず、共通 LabelEngine の再挑戦に備える。
  `tests/mission15-label-engine.test.js` は package.json の test から外した。
- **追加の予防**: Mission14 `StationLabelLayer.rebuild()` は progressive tile load 中に station 数が
  変わるたび 174 個の CanvasTexture を作り直しており、GPU テクスチャの大量チャーンで
  WebGL コンテキストロス（画面真っ白）を招きうる。→ **station 数が安定してから（変化停止後 1.6s ＆
  前回 rebuild から 3s 以上）1 回だけ rebuild する debounce** を追加。
- `npm test`: 703 tests / 688 pass / 0 fail / 15 skip。全 validator PASS。smoke test 通過。protected/production 無変更。

### 「24区 City Mode が表示できない」の調査（ユーザー報告）
- **Mission15 rollback の diff を全監査**: `CityModeManager`（enter/exit/isActive）・`CityBuildingLOD`
  （build/setCameraDistance/getStats/HIDE_NEAR_M=4000/merged geometry/共有 material/影なし/edge なし/
  picking なし）・`getCityCameraTarget`（Mission16 aspect-aware fit）・`CITY_CAMERA_PRESET`・
  `coverCityBbox`・「大阪市全域」selector 行（`cityRow` → `CityModeManager.enter()`）・24区 dataset の
  `enableDataset` ループ・`__n03WardPolyCache`（24区 boundary）は **すべて無傷**。rollback は
  `StationLabelLayer` の LabelEngine 連携除去と `LabelEngine` IIFE 削除のみで、City Mode コードには
  一切触れていない（grep で City Mode 関連 50 箇所すべて健在）。
- **「約12,029棟」の正体**: FPS HUD の「建物: N棟」は `BLDGS.length`（embedded の mixed-ward legacy
  データセット = 12,029棟）を**常時・全モードで**表示している定数。City Mode の remote tile や
  CityBuildingLOD のロード状況は反映しない。→ 「12,029棟」表示は City Mode 不具合の証拠にならない。
- **診断 API 追加**: `window.__CITY_MODE_DEBUG__()` → `{cityModeActive, currentWardId, wardDefsCount,
  wardPolyCacheCount, cameraRadius, embeddedBuildingCount, cityBuildingLOD:{wardsStarted,wardsReady,triangles},
  enabledBuildingDatasets, buildingTileLayer:getStats(), cityTileLayer:getStats(), rendererDrawCalls}`。
  「大阪市全域」選択後にこれを実行すれば、24区 dataset enable / CityBuildingLOD の wardsReady / tile
  ロード状況を数値で確認できる。
- 変更: `public/osaka_3d_buildings.ward-ux-v1.html`（`__CITY_MODE_DEBUG__` 追加のみ）。
  `npm test` 703/688 pass/0 fail、全 validator PASS、git diff --check クリーン、protected/production 無変更。
- **PowerShell 診断スクリプト `tools/debug/check-city-mode.ps1`**（新規）: Chrome/Edge を
  `--remote-debugging-port` で起動（or 既存を再利用）→ CDP `/json/list` でタブ取得 →
  `System.Net.WebSockets.ClientWebSocket`（.NET Framework 標準・外部 package 不要）で `Runtime.evaluate` →
  `__CITY_MODE_DEBUG__()` を評価して JSON + 要点サマリを表示。`-EnterCityMode` で `CityModeManager.enter()`
  を先に実行、`-Watch N` で定期再取得、`-StartServer` で python の簡易サーバ起動。UTF-8 BOM 付きで
  Windows PowerShell 5.1 対応。headless Chrome で end-to-end 動作確認済み
  （`cityModeActive:true` / cityTileLayer loadedTiles 228 / buildingTileLayer 307 / drawCalls 1762 を取得）。
  → **City Mode は実際に機能している**（描画も 24区レイヤーロードも進行）ことを headless で確認。

---

## 2026-09-06 セッション6AD: 見た目改善20ミッション — Mission14 主要駅ラベルを LOD 付きで表示

Mission 13 で保持した station node 233件（全件 name 付き）を使い、駅名を LOD + screen-space collision 付きで
表示。「どこを見ているか分かる 3D 地図」へ。233件全部を常時出さない。

- **監査（station 233 / rail line 2828）**:
  - distinct name 186、**同一 name で複数 node が 39 件**（なんば×4、天王寺/本町/鶴橋/今里/森ノ宮/京橋×3 等）。
  - NN 距離: min 9m / p25 136m / median 291m。100m 以内のペア 32、120m 以内 41。
  - operator は全件無し（Mission 13 で既知）。railway 属性も station node には無し（{id,name,x,z} のみ）。
  - 梅田エリア（大阪/梅田/東梅田/西梅田/北新地）は互いに 220〜400m で、単純近接では 1 つにならない。
- **clustering 方式**（`tools/lib/station-cluster.js` = canonical、HTML へ inline）:
  1. 近接 single-linkage クラスタリング（radius **130m**）
  2. **主要ターミナル別名グループ**（`大阪・梅田` / `なんば` / `天王寺` / `新今宮` / `新大阪` / `京橋` / `鶴橋` /
     `大阪上本町` / `淀屋橋` / `本町` / `心斎橋` / `西九条` の 12 canonical）を **groupMergeM 900m** 以内で統合
  3. **同一 canonical label** のクラスタを **sameNameMergeM 420m** 以内で統合（platform node が離れた単一駅）
  → **raw 233 → cluster 174**。
- **importance 分類方式**（会社名ハードコードに依存せず）:
  - **MAJOR** = 主要ターミナルグループに属する（override）。← データだけでは判定困難なため
  - **MEDIUM** = 地上 rail + 地下鉄の乗換 OR 周辺 rail way ≥ 8 OR 周辺 subway way ≥ 10 OR cluster member ≥ 3
  - **LOCAL** = それ以外（孤立小駅・地下鉄単独駅）
- **MAJOR/MEDIUM/LOCAL 件数**: **MAJOR 11 / MEDIUM 82 / LOCAL 81**（合計 174）。
  MAJOR = 大阪・梅田 / なんば / 天王寺 / 新今宮 / 京橋 / 鶴橋 / 大阪上本町 / 淀屋橋 / 本町 / 心斎橋 / 西九条
  （新大阪は tile bbox 外で station node なし）。
- **FAR/MID/NEAR**（band は道路・鉄道・公園と同じ 9000/3500）:
  - **FAR** (>9000m) = MAJOR のみ（表示上限 `STATION_LABEL_FAR_MAX = 26`、実際 11）
  - **MID** (3500–9000m) = MAJOR + MEDIUM（pool 93、collision 後 ~30–70 表示想定）
  - **NEAR** (<=3500m) = ALL（pool 174、viewport + collision で必要分のみ）
- `public/osaka_3d_buildings.ward-ux-v1.html` — 新 **`StationLabelLayer` IIFE**:
  - 描画: 既存 `LabelLayer` と同じ **THREE.Sprite + CanvasTexture、初回生成し以後は visible/scale のみ更新**。
    ラベルは Sprite（常にカメラを向く）、`fog: false`（霧で文字を薄くしない）、`renderOrder 1002`。
  - **駅記号 dot**: 白丸 + gray border、tier で 3 テクスチャ共有（大量生成しない）。サイズ major 5 / medium 3.6 / local 3。
  - **canonical style**（白模型向け・黒ベタ禁止）: MAJOR `15px/600/#3f4852` bg `rgba(255,255,255,0.90)` /
    MEDIUM `12px/500/#4f5963` bg 0.84 / LOCAL `10.5px/500/#5a636d` bg 0.80。border `rgba(120,130,140,0.2–0.3)`。
  - **collision**: priority（MAJOR > MEDIUM > LOCAL → 中心に近い順）でソート、**screen-space NDC bbox**
    重なり判定で低優先を hide（MAJOR は点だけ残す）。FAR は MAJOR 上限も適用。
  - **毎フレーム全件計算しない**: `THROTTLE_MS 180` + camera 位置/zoom/th/ph/band を丸めた key の変化時のみ再配置。
  - **screen-space label**（一定 pixel サイズ、遠景で極端に小さくならない。`pxScale = clamp(620/cs.r, 0.55, 1.35)`）。
  - station Y **0.5**（rail 0.17 より上、3D y は高くしすぎない）、label anchor +22。
  - 遅延 tile で station が増えたら `rebuild()`。`cluster id` / `memberIds` を保持（将来の hover/click 発展用）。
  - CityTileLayer: `getAllStations()` / `getAllRailLines()` accessor 追加。旧 '+' station マーカーは
    `window.__RAIL_STATION_MARKERS__ === true` の時のみ（station feature data は `rec.allFeats` に保持）。
  - 「駅名」レイヤートグル → `StationLabelLayer.setVisible(on)` に配線。
  - **debug**: `window.__STATION_LABEL_DEBUG__()`（stationCount/clusterCount/major・medium・localCount/
    cameraBand/visibleLabels/hiddenByCollision/hiddenByLOD/sampleVisibleNames/farMax）、
    `window.__STATION_LABEL_FORCE__('NEAR'|'MID'|'FAR')`、`window.__STATION_COLLISION_DEBUG__` フラグ。
- **地下鉄の扱い**: 単独 subway 駅（昭和町・心斎橋の一部 node 等）は group 無し → LOCAL/MEDIUM → **FAR で非表示**。
  主要地下鉄ターミナル（本町・心斎橋・淀屋橋・大阪上本町）は override で MAJOR。→ FAR で地下鉄駅だらけにならない。
- **collision 方式**: NDC 上の label bbox 概算（font size × pxScale × aspect）で AABB 重なり判定。
  確定済みと重なる候補は hide。priority 同順は中心距離で決定。
- **station marker 方式**: 白丸 + neutral gray border の小 Sprite（tier で 3 テクスチャ共有）。MAJOR のみ若干大きい。
- 新規 `tools/validate/station-label.js`（station finite / name non-empty / cluster coverage / classification
  coverage / duplicate canonical label / FAR upper bound / priority 単調性 / encoding / bbox containment）
  → **RESULT: PASS**（cluster 174、MAJOR 11、非有限 0・空 name 0・encoding 不正 0、重複 label 4 =
  全て既知の別駅同名（中津/野田/今里/平野、WARN）、bboxViolations 0）。`data:validate:station-label` を追加。
- 新規 `tests/station-cluster.test.js`（10）+ `tests/mission14-station-label.test.js`（14、実データ検証含む）。
- `npm test`: 692 tests / 677 pass / 0 fail / 15 skip。river/road/park/rail/station-label/city-layer validator
  すべて PASS。`git diff --check` クリーン。ランタイム smoke test 通過。protected / production HTML 無変更。
- **performance**: sprite 348個（dot 174 + label 174）+ CanvasTexture 174（label、各 ~200×48px）+ dot テクスチャ 3。
  全て初回に一度だけ生成。update は throttle 180ms + camera dirty 判定で、静止時はゼロコスト。
  City Mode FPS への影響は実機確認要（`renderer.info` / DevTools）。
- **実機確認待ち**（Mission 15 へは未着手）: City FAR で主要駅（大阪/梅田/なんば/天王寺 等）だけ見える /
  ラベルが重ならない / MID で中規模駅が増える / NEAR で地域駅も見える / 地下鉄駅だらけにならない /
  白模型・道路・鉄道を隠しすぎない / station point と label が対応 / スクロール・ズームでラベルが暴れない /
  FPS 大幅悪化なし。

---

## 2026-09-06 セッション6AC: 見た目改善20ミッション — Mission13 鉄道を道路と明確に分ける

鉄道を「道路と似た灰色の線」から、独立した交通レイヤーとして整理。道路と一目で区別でき、City Mode
遠景でも主要鉄道骨格が読める。駅ラベルは Mission 14 へ（データは保持）。geometry は不変。

- **監査（実データ `public/map-data/osaka-city/railways`、75 tile）**:
  - **line feature 2828 件**（id 重複排除後。tile 内重複 526 件スキップ）、**station node 233 件（全件 name 付き）**。
  - line feature は **`{id, kind:'line', railway, p}` のみ**。**name / operator / usage / service / bridge / layer は無し**
    → クラス分類は `railway` tag + way 長のみで行う。
  - `railway` tag 内訳: **rail 2349 / subway 414 / light_rail 65**（tram/monorail/construction/disused/abandoned は 0）。
  - rail の way 長: median 102m、<60m が ~900 本（渡り線・側線・ヤード）。
  - station: `{id, kind:'station', name, p:[[x,z]]}`。operator なし。bbox X[-12323,6239] Z[-14112,2115]。文字化けなし。
  - 旧実装: `STYLE.railways = { y:0.14, color:0x8f96a0 }`、`lineMesh` で 1 tile 1 mesh、`railLineVisible()` = 常時 true
    （距離LODなし）。道路 line 色 `0x9aa1a8`(161) とほぼ同じ濃さで区別が弱かった。
- **クラス方式**（会社名ハードコードなし、OSM tag + 長さの汎用分類）:
  - **URBAN** = `railway=subway`（地下鉄）
  - **LOCAL** = `railway=light_rail` + `railway=rail` で way 長 < 60m（側線・渡り線）
  - **MAJOR** = `railway=rail` で way 長 ≥ 60m（JR・大手私鉄の本線骨格）
  - `construction/proposed/disused/abandoned/razed/dismantled` は除外（canonical 表示しない）
- **各 class 件数**: **MAJOR 1456 / URBAN 414 / LOCAL 958**（合計 2828、excluded 0）。
- `tools/lib/rail-lod.js`（新規・canonical）: `classifyRail` / `railIncluded` / `railLodBand`（**道路・公園と同じ
  FAR>9000 / MID 3500–9000 / NEAR<=3500**）/ `railClassVisible`（FAR=MAJOR / MID=MAJOR+URBAN / NEAR=ALL）/
  `RAIL_TIER_OPACITY` / `railTierOpacity` / `RAIL_COLORS` / `polylineLengthXZ` / `maxSegmentLengthXZ` /
  `countByRailClass`。`tools/lib/city-mode.js` は旧 `railLineVisible` を廃止し re-export。
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **`buildRailMeshes`**: rail line を MAJOR/URBAN/LOCAL の **tier 別 LineSegments へ統合**（1 tile 最大 3 mesh、
    tier ごとに僅かな y 差で Z-fighting 回避、renderOrder 936）。道路 ribbon 化はせず軽量な線表現のまま。
  - `applyLodToOneMesh` の rail line 分岐で `railClassVisible` による可視 + `railTierOpacity` による band 別 opacity。
  - **`RAIL_COLORS = { major:#8f969d, urban:#a0a6ac, local:#adb2b7 }`**（道路 light gray より少し濃い
    medium neutral gray、黒すぎない。地下鉄は少し明るく主張を抑える）。
  - `STYLE.railways.y` **0.14 → 0.17**（道路 0.13 より明確に上）、`renderOrder` 936（park 930 より上、
    station 938 より下、建物より下）。
  - **地下鉄（URBAN）を弱く**: opacity near 0.5 / mid 0.4（MAJOR は 0.82/0.72/0.6）、**FAR では非表示**。
  - **station データは保持**（`stationMesh` そのまま、距離LODで NEAR のみ表示）。
  - **高架・橋**: 実データに `bridge/layer/embankment` tag は無いため 3D 高架化なし。y=0.17 + renderOrder で
    道路・河川の下に埋もれないことを保証。
  - **debug**: `window.__RAIL_LOD_DEBUG__()`（cameraDistance/band/forced/visibleMajor/Urban/Local/Subway/
    major/urban/local FeatureCount/loadedTiles/visibleFeatures/drawCallsEstimate/opacity/colors/thresholds）、
    `window.__RAIL_LOD_FORCE__('NEAR'|'MID'|'FAR')`、`window.__STATION_DEBUG__()`（stationCount/namedStationCount/
    sampleNames/bbox/operatorCounts — Mission 14 準備）。
- **FAR / MID / NEAR 表示件数**: FAR = **1456**（MAJOR）/ MID = **1870**（MAJOR+URBAN）/ NEAR = **2828**（ALL）。
- **mesh / drawCall**: 1 tile あたり最大 3 LineSegments（major/urban/local）+ station 1（近景のみ）。
  従来 1 → 3（tile 単位）。**1 way = 1 mesh ではない**。City FAR では urban/local mesh が `visible=false`。
- **station node**: 233 件、**全件 name 付き**、operator なし。bbox X[-12323,6239] Z[-14112,2115]。
- 新規 `tools/validate/rail-lod.js`（finite coords・feature count・dup id・classification coverage・
  railway tag coverage・bbox containment・absurdly long segment・giant geometry・station finite・name encoding）。
  → **RESULT: PASS**（MAJOR 1456 / URBAN 414 / LOCAL 958、giantGeom 0、bboxViolations 0、maxSegment 1023m、
  station 233 全件 name 付き・文字化け 0、`data:validate:rail-lod` を package.json へ）。
- 新規 `tests/rail-lod.test.js`（8）+ `tests/mission13-rail-lod.test.js`（14、実データ検証含む）。
  stale 化した `tests/city-mode-p17.test.js` / `tests/ward-ux-v1-p17.test.js` を更新。
- `npm test`: 668 tests / 653 pass / 0 fail / 15 skip。river/road/park/rail/city-layer validator すべて PASS。
  `git diff --check` クリーン。ランタイム smoke test 通過。protected（fullward-v3.html）/ production HTML 無変更。
- **実機確認待ち**（Mission 14 へは未着手）: 道路と鉄道を一目で区別できる / City FAR で主要鉄道骨格が見える /
  MID で地下鉄が加わる / NEAR でローカル線も見える / subway が強すぎない / 黒い蜘蛛の巣にならない /
  rail が道路の下に埋もれない / JR環状線・御堂筋線相当が読める。

---

## 2026-09-06 セッション6AB: 見た目改善20ミッション — Mission12 公園・緑地の LOD 整理

「緑の塗りつぶしノイズ」を、都市模型の中で自然な緑地構造として見えるよう整理。大規模公園は City Mode
遠景でも都市骨格として認識でき、街区公園は遠景で消してノイズを減らす。geometry / 三角形分割は不変。

- **監査（実データ `public/map-data/osaka-city/parks`、80 tile）**:
  - **公園 area feature 2685 件（id 重複排除後）、総面積 10.69 km²**。line-kind / 無geometry は 0。
  - 面積分布: ≥1M m² 1（大阪城公園 109.9ha）/ 300k–1M 2（鶴見緑地 93.5ha・長居公園 76.4ha）/
    100k–300k 10 / 50k–100k 9 / 20k–50k 50 / 10k–20k 61 / 5k–10k 161 / 2k–5k 328 / **<2k m² 2063**（77%＝点状ノイズ源）。
  - 旧実装: CityTileLayer 公園は `PARK_BIG_AREA_M2 = 20000`（2ha）の big/small 2 段階、small は距離
    `<= 4000m`。big（72件）は City Mode 遠景でも全表示。band が道路LOD（9000/3500）と不一致。
    埋め込み ParkLayer（3区・11公園）は距離LODなしの単一 mesh、色は濃いオリーブ `0x6f9a52`。
    CityTileLayer 公園色 `0x7bb36a`（彩度高め）、opacity 0.5。
- **面積3分類しきい値**（実データ監査で決定）:
  - **LARGE ≥ 100,000 m² → 13 件**（大阪城公園・花博記念公園鶴見緑地・長居公園・天王寺公園・南港中央公園・
    万博記念公園鶴見緑地・大阪南港野鳥園・住之江公園・八幡屋公園・淀川河川公園 毛馬/赤川/西中島・千島公園）
  - **MEDIUM 10,000–100,000 m² → 120 件**
  - **SMALL < 10,000 m² → 2552 件**
- `tools/lib/park-lod.js`（新規・canonical）: `classifyParkArea` / `parkLodBand`（**道路LODと同じ FAR>9000 /
  MID 3500–9000 / NEAR<=3500**）/ `parkClassVisible`（FAR=large / MID=large+medium / NEAR=all）/
  `PARK_TIER_OPACITY` / `parkTierOpacity` / `ringAreaXZ` / `polygonAreaWithHoles` / `countByParkClass`。
- `tools/lib/city-mode.js`: 旧 `PARK_BIG_AREA_M2` / `parkTierOf` / `PARK_SMALL_MAX_M` / `parkTierVisible` を
  廃止し park-lod.js から re-export。
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **`MS_PARK_GREEN = 0xcfe3c7`**（淡い soft green。緑優勢で河川シアン `#9ed6e6`（青優勢）と明確に区別・彩度控えめ）。
  - **CityTileLayer 公園**: `buildParkMeshes` を large/medium/small の **3 バケット → tier ごと 1 統合 mesh**
    （1 tile 最大 3 fill mesh、renderOrder 930）。`applyLodToOneMesh` の公園分岐で `parkClassVisible` による
    可視 + `parkTierOpacity` による band 別 opacity（large: near 0.80 / mid 0.62 / far 0.46、medium: near 0.78 /
    mid 0.58、small: near 0.75）。`STYLE.parks.color` を MODEL_STYLE 時 `MS_PARK_GREEN` へ。
    `parkLodForce`（`__PARK_LOD_FORCE__` 用）。
  - **埋め込み ParkLayer（3区）**: 単一 `parkMesh` を廃止し tier 別 `parkMeshes{large,medium,small}` へ分割。
    ローカルに park-lod ロジックを持ち（レイヤー独立性）、`updateByCamera(cs.r)` で tier 別可視 + opacity、
    縁取りは近景のみ。色は `MODEL_STYLE.on ? MS_PARK_GREEN : 従来`。camUpd から毎フレーム呼ぶ。
  - **layer order 維持**: water y=0.04/0.05 < park y=0.07 < road y=0.13。road ribbon が公園を覆わない。
  - **debug**: `window.__PARK_LOD_DEBUG__()` → `{cameraDistance, band, forced, visibleLarge/Medium/Small,
    large/medium/smallFeatureCount, loadedTiles, visibleFeatures, drawCallsEstimate, opacity, thresholds}`。
    `window.__PARK_LOD_FORCE__('NEAR'|'MID'|'FAR')`（null で距離依存へ戻す）。
- **表示件数**: FAR = **13**（LARGE のみ）/ MID = **133**（LARGE+MEDIUM）/ NEAR = **2685**（ALL）。
- **mesh / drawCall**: CityTileLayer 公園は tier 統合で 1 tile あたり最大 3 fill mesh（従来 2 → +1）。
  埋め込み ParkLayer は 3 fill + 1 edge（従来 1+1 → +2、対象は 3区 11 公園のみ）。**1 park = 1 mesh ではない**。
  City Mode FAR では small/medium mesh が `visible=false` → 実描画 feature 数・draw call が明確に減る。
- 新規 `tools/validate/park-lod.js`（area finite/>0・分類 coverage・id 重複・triangle maxEdge/maxArea・
  bbox containment・giant geometry）。`data:validate:park-lod` を package.json へ。
  → **RESULT: PASS**（LARGE 13 / MEDIUM 120 / SMALL 2552、giantGeom 0、bboxViolations 0、未分類 0。
  warn 1 件＝長居公園の検証用 fan 分割三角形が大きい。実描画は earcut で問題なし）。
- 新規 `tests/park-lod.test.js`（10）+ `tests/mission12-park-lod.test.js`（14、実データ検証含む）。
  stale 化した `tests/city-mode-p17.test.js` / `tests/ward-ux-v1-p17.test.js` / `tests/mission02-road-lod.test.js` を更新。
- `npm test`: 646 tests / 631 pass / 0 fail / 15 skip。river/road/city-layer/park validator すべて PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。ランタイム smoke test 通過。
- **実機確認待ち**（Mission 13 へは未着手）: City Mode 遠景で小公園の点状ノイズが消える / 大阪城公園・長居公園・
  鶴見緑地が遠景でも都市骨格として見える / MID で中規模公園が加わる / Ward 近景で街区公園も表示 /
  淡い緑が河川シアン・道路グレーと区別できる / 道路が公園の上に読める / polygon 破綻なし / FPS 悪化なし。

---

## 2026-09-06 セッション6AA: 見た目改善20ミッション — Mission16 City Mode 初期カメラの最適化

「大阪市全域」選択時の初期カメラを、GIS 俯瞰視点ではなく「3D都市模型として最も見栄えがよく、
大阪市全体の構造が一目で把握できる斜め上視点」へ。aspect-aware fit で 1920×1080 固定に依存しない。

- **監査（変更前）**:
  - `camera` = `PerspectiveCamera(60, aspect, 1, 14000)`。`camera.far` は camUpd で `max(14000, cs.r*1.6+16000)`。
  - City Mode camera: `getCityCameraTarget()` = `{center, radius: diag(31824)*0.5 ≈ 15912}`（maxR 24000 でクランプ）。
  - **`overheadFactor(cs.r)` が `cs.r >= 8000` で 1 を返し `effPh ≈ 0.08`（≈仰角 85°、ほぼ真上）**
    → City Mode は常に GIS 俯瞰。cs.ph（π/4）は無視されていた。
  - `CityModeManager.enter()` は `flyTo(center, {r})`（900ms ease-out）のみ。cs.th/ph/tgt.y は触らない。
  - resize `onR()`: `renderer.setSize` + `camera.aspect` 更新のみ（City fit の再計算なし）。
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **`CITY_CAMERA_PRESET` 新設**（値を1箇所へ集約）: `elevationDeg 42 / azimuthDeg 0（北向き維持）/
    fov 50 / marginFactor 1.10 / targetYOffset 50 / headroomM 800 / minRadius 6000 / maxRadius 24000`。
    `WARD_FOV = 60` を定数化、`PerspectiveCamera(WARD_FOV, ...)`。
  - **camUpd**: `cityActive = CityModeManager.isActive()`。City 中は `ov = 0`（overheadFactor 無効化 →
    preset elevation の斜め上視点を維持）、`camera.fov = CITY_CAMERA_PRESET.fov`（change-only、Ward 復帰で
    自動的に WARD_FOV へ）。
  - **`getCityCameraTarget()` を aspect-aware fit へ**: `fitDistanceX = (width/2)/tan(halfH)`（東西、
    azimuth=0 で foreshorten なし）、`fitDistanceY = ((height/2)*sin(elev) + headroom)/tan(halfV)`
    （南北 depth を仰角で foreshorten + 建物高さ）、`radius = max(X, Y) * margin`、cs.minR/maxR でクランプ。
    旧 `diag*0.5` はコメントとして残置（参考）。canonical: `tools/lib/city-mode.js`（`opts.aspect` 指定時）。
  - **`CityModeManager.enter()`**: `cs.th`（azimuth）/`cs.ph`（= 90 − elevation の polar角）/`cs.tgt.y` を
    preset へ設定してから `flyTo`。`cityFitSnapshot = {r,tx,tz,th,ph}` を記録（resize 再fit の安全判定用）。
  - **`CityModeManager.exit()`**: `cs.ph = π/4` / `cs.th = 0` / `cs.tgt.y = 8` へ戻す（preset を Ward へ
    漏らさない）。`cityFitSnapshot = null`。FOV は camUpd が自動で WARD_FOV へ。
  - **resize `onR()`**: City Mode かつ `cityFitSnapshot` と現在の cs が一致（＝ユーザー未操作）のときだけ
    `getCityCameraTarget()` を再計算して再fit。操作済みなら初期視点へ強制復帰させない。
  - **debug**: `window.__CITY_CAMERA_DEBUG__()`（position/target/radius/elevationDeg/azimuthDeg/fov/aspect/
    cityBBox/cityWidth/cityDepth/fitDistanceX/Y/fitDistance/margin/fogNear/fogFar/userMovedSinceEntry）、
    `window.__CITY_CAMERA_PREVIEW__('NW'|'N'|'SW'|'SE'|number, [elevationDeg])`（azimuth/elevation 比較用、
    canonical 決定後も残す）。
- `tools/lib/city-mode.js`（canonical）: `CITY_CAMERA_PRESET` export、`cityCameraTarget` に aspect-aware
  分岐追加（`opts.aspect` 未指定なら従来 `diag*radiusFactor` のまま＝既存テスト不変）。
- **aspect-aware fit 結果**:
  | 画面 | aspect | radius | fitX | fitY |
  |---|---|---|---|---|
  | 1920×1080 | 1.778 | **18382** | 14475 | 16711（縦 fit が binding） |
  | 1440×900 | 1.600 | 18382 | 16084 | 16711 |
  | 2560×1440 | 1.778 | 18382 | 14475 | 16711 |
  | 390×844（portrait） | 0.462 | **24000（クランプ）** | 55691 | 16711 |
  - landscape: 大阪市が縦 ~82% / 横 ~79% を占有（目標 75〜90%）。
  - portrait: 縦（南北）は fitY 16711 < 24000 で必ず収まる（北部・南部が切れない）。横（東西 24km）は
    溢れるが Mission §19 の許容範囲。
- **Mission18 fog との整合**: 初期 radius 18382 → `modelDayFogRange` は DIST_FAR 16000 でクランプ →
  near 12000 / far 40000。市中央（camera 距離 ≈ 18382）は fog factor ≈ 0.23（鮮明）、市境（北端 ≈ 27000）
  ≈ 0.54（軽く fade）、南端 ≈ clear。fog 値は変更なし。
- **clip plane**: `camera.far` は r=18382 で ≈ 45411、r=24000 で ≈ 54400。City geometry の最大 camera 距離
  （≈ 27000〜35000）を覆う。Z precision を悪化させる過剰拡大なし（式は変更なし）。
- CityBuildingLOD / RiverLayerV2 / road ribbon / road LOD / projection・znorth-neg-v1 は不変。
  新 mesh / material / render pass なし。bbox fit は entry と（未操作時の）resize のみ、毎フレーム再計算なし。
- 新規 `tests/mission16-city-camera.test.js`（25テスト、全 pass）。`package.json` へ登録。
  既存 `tests/city-mode-p17.test.js` / `tests/ward-ux-v1-p17.test.js` / `tests/camera-north-up.test.js` は
  後方互換のため無変更で pass。

### バグ修正（ユーザー報告「何も表示されません」）
- **原因**: `camUpd()` に追加した `const cityActive = (typeof CityModeManager !== 'undefined') && ...` が
  **TDZ ReferenceError** を投げていた（`CityModeManager` は約2300行後方の `const`。`typeof` でも
  未初期化バインディングは throw する）。`camUpd()` はモジュール評価時（初期化）に呼ばれるため、
  スクリプト全体が停止 → 3D シーンが一切描画されず、Mission17 で白くした body 背景（#f3f4f1）だけが見える状態。
- **修正**: 前方に `let cityModeActive = false;` フラグを新設。`CityModeManager.enter/exit` が同期し、
  `camUpd` / `onR` はこのフラグを参照（`typeof CityModeManager` を使わない）。
- **再発防止**: 新規 `tests/ward-ux-v1-smoke.test.js` + `tests/_ward-ux-v1-smoke-harness.cjs`。
  DOM/THREE をスタブ化してインライン `<script>` を **実際に vm で実行** し、モジュール評価時に例外停止
  しないことを検証（regex / `node --check` では検出できないクラス）。fullward-v3.html も対象。
- `npm test`: 625 tests / 610 pass / 0 fail / 15 skip。
- `npm test`: 622 tests / 607 pass / 0 fail / 15 skip。river/road/city-layer validator すべて PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。
- **実機確認待ち**（次 Mission へは未着手）: City Mode で大阪市全体が画面 ~75〜90% / 斜め上視点で建物側面が
  読める / 淀川・大和川が都市骨格として見える / 梅田・難波・天王寺の位置関係が分かり重ならない /
  高層部の高さが感じられる / landscape・portrait 対応 / LOD 境界がリング状に見えない / progressive load 中に
  camera が揺れない / Ward Mode 切替が壊れていない。**azimuth は北向き(0)を canonical としたが、
  `__CITY_CAMERA_PREVIEW__('NW')` 等で NW/SW も比較し、より「3D模型」に見える方向があれば教えてほしい**。

---

## 2026-09-06 セッション6Z: 見た目改善20ミッション — Mission18 Fog / Lighting を白模型向けに最適化

fog を「天候表現」ではなく「都市模型の空気遠近」として再設計。遠景が白く潰れず・濃霧で消えすぎず、
白建物の立体感を維持しつつ City Mode で都市全体が模型として読める状態へ。今回 fog 色と lighting は変えない。

- **監査（変更前）**:
  - `scene.fog = THREE.Fog`（linear）。`applySkyAndFog` 模型・昼: `near = max(L.fogNear 2200, 3200)=3200` /
    `far = max(L.fogFar 6000, 9000)=9000`、直後に `updateFogForCameraDistance()`。
  - `updateFogForCameraDistance` は **raw `L.fogFar`(6000) から** `far = max(6000, cs.r * 3.6)` を計算し、
    `near = min(2200, far*0.35)`。→ near は常に 2200 に張り付き、**far は cs.r に比例して無制限に後退**
    （Ward 既定 cs.r=5300→far 19080 / City 全景 cs.r≈15900→far 57240 / 最大 cs.r=24000→far 86400）。
  - City 全景 camera radius ≈ `diag(OSAKA_CITY_GROUND_EXTENT 24000×20900)*0.5 ≈ 15900`（maxR 24000 でクランプ）。
    Ward 既定 `cs.r=5300`、近景ズームで ~60〜1000。
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **`MODEL_FOG` 定数 + `modelDayFogRange(cameraDist)` 新設**（MODEL_STYLE + day + 非data 専用）:
    - `DIST_NEAR 3000 / DIST_FAR 16000` へ camera 距離を clamp
    - `smoothstep` で `near: MIN_NEAR 6000 → MAX_NEAR 12000` / `far: MIN_FAR 18000 → MAX_FAR 40000` を連続補間
    - **fog.far は MAX_FAR 40000 で頭打ち**（`cs.r*3.6` 無制限後退を廃止）
    - **fog.near は MIN_NEAR 6000 下限**（Ward 近景がすぐ霞まない）
  - `updateFogForCameraDistance` を分岐化: `isModelDayFog()` 真 → `modelDayFogRange(cs.r)`、
    偽（evening/night / legacy / data）→ **従来式そのまま**（`max(baseFar, cs.r*3.6)` / `min(baseNear, far*0.35)`）。
  - `applySkyAndFog` の模型・昼 fog near/far も `modelDayFogRange` シードへ（直後 updateFog が上書き。
    非模型は `L.fogNear/Far * fogScale` のまま）。
  - **fog 色は変更なし**（Mission17 の `MS_BG_NEUTRAL #f3f4f1` を維持）。
  - **lighting は変更なし**（Mission09 の hemi 1.02 / sun 1.08 / fill 0.30、sun ≥ hemi を維持）。
    fog と lighting の役割を分離（fog=空気遠近 / lighting=立体感、camera 依存の light 暴走なし）。
  - **debug**: `window.__FOG_LIGHT_DEBUG__()` → `{cameraDistance, fogNear, fogFar, fogColor, fogMode,
    modelFog, sunIntensity, hemiIntensity, fillIntensity, sunGteHemi, sunCastShadow, modelStyle, timeMode}`。
- **新しい fog distance mapping（模型・昼）**:
  | camera 距離 | fog.near | fog.far | 用途 |
  |---|---|---|---|
  | ≤ 3000 | 6000 | 18000 | Ward 近景（クリア） |
  | 5300（Ward既定） | ~6500 | ~19800 | Ward 標準 |
  | 8000 | ~7980 | ~25260 | Ward〜MID |
  | 13000 | ~11190 | ~37030 | MID〜City |
  | 15900（City全景） | ~12000 | ~40000 | City Mode |
  | 24000（最大ズームアウト） | 12000 | 40000 | far 上限で一定 |
- post-processing / SSAO / volumetric / FogExp2 なし。新 render pass なし。既存 `THREE.Fog` のみ。
  drawCalls / triangles / geometry 増加ゼロ。
- 新規 `tests/mission18-fog-lighting.test.js`（17テスト、全 pass。MODEL_FOG/helper を純粋関数として抽出し
  clamp・上限・連続性・City/Ward 距離を検証）。`package.json` へ登録。
- `npm test`: 600 tests / 585 pass / 0 fail / 15 skip。river/road/city-layer validator すべて PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。
- **実機確認待ち**（Mission 16 へは未着手）: Ward Mode 近景が霞まない / City Mode 遠景が自然に背景へ溶ける /
  fog.far が無制限後退しない / 白建物が白飛びしない / Mission09 陰影が残る / 淀川・大和川・主要道路骨格が
  遠景でも読める / データ端が目立たない / evening・night を壊していない / 梅田・難波・天王寺の高層部が霧で消えない。

---

## 2026-09-06 セッション6Y: 見た目改善20ミッション — Mission17 Ground・背景の四角い境界を消す

地表/背景に「四角い板・矩形の描画範囲」が見え、都市模型が有限ステージ上に置かれて見える問題を解消。
背景・地表・fog の色を統一し、地図データの端が見えても矩形境界として認識されない状態を目指す。
新 mesh は追加せず、色/fog 色の変更のみ。

- **四角い境界の原因（監査結果）**:
  1. `applySkyAndFog` 模型・昼の `skyHex=0xc4ccd2`（青みグレー、やや暗い）/ `fogHex=0xc8ced3` と、
     `GroundVisualLayer` の地表色 `msBlend(0xd4d2ca, 0xc8ced3, 0.55)`≈`#cdd0cf`（明るめ warm gray）が
     **別色**。City Mode 全景で GroundVisualLayer の有限タイルスラブ（extent = データ bbox ∪
     `OSAKA_CITY_GROUND_EXTENT` + `groundPad 9000`）の矩形外周が背景から浮いて見える。
  2. `updateFogForCameraDistance` が遠景で fog.far をカメラ距離依存で大きく後退させるため、
     スラブ外周が fog で溶けきらず輪郭が残る。
  3. CSS `html,body{background:#0d1117}`（ほぼ黒）が canvas 外周・リサイズ時に覗く別色。
  4. 旧 `gnd`（2500×1500 単色 Plane）は `SHOW_LEGACY_GROUND=false` で既に非表示（＝原因ではない）。
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **`MS_BG_NEUTRAL = 0xf3f4f1`** を新設（明るい neutral。建物白 `#eef0ec` よりわずかに明るく純白でない
    ＝白建物が背景へ溶けない）。次の 5 箇所をこの色へ統一:
    - CSS `html,body` background `#0d1117` → `#f3f4f1`
    - `renderer.setClearColor(...)` 初期値 → `MS_BG_NEUTRAL`
    - `scene.background` 初期値 → `MS_BG_NEUTRAL`
    - `scene.fog` 初期色 → `MS_BG_NEUTRAL`
    - `applySkyAndFog` 模型・昼: `skyHex` / `fogHex` とも → `MS_BG_NEUTRAL`（**fog色 = 背景色**、
      遠景データが背景へ自然にフェード。fog 距離は変更せず Mission18 へ）
  - **GroundVisualLayer(model)**: `applyModelStyle` の `GROUND_VISUAL_STYLE.colorReal` を
    `msBlend(0xd4d2ca, 0xc8ced3, 0.55)` → `MS_BG_NEUTRAL`（背景/fog と同一）。タイル微小明度差
    (`tileTint` 0.97〜1.02) と受け影は残るため近景で無地平面にはならない。`_crOrig` 退避で legacy 復元可。
  - **旧 `gnd` は `visible=false` を維持**（`SHOW_LEGACY_GROUND=false`、Mesh/geometry は削除せず保持）。
    影受けは GroundVisualLayer(`receiveShadow=true`) が担当。影用に巨大 plane を追加しない。
  - **debug**: `window.__BACKGROUND_DEBUG__()` → `{canonicalNeutral, sceneBackground, rendererClearColor,
    fogColor, fogNear, fogFar, bodyBackground, legacyGround:{visible,showFlag}, groundVisualLayer:{shown,colorReal,bounds}}`。
  - legacy（MODEL_STYLE=false / 昼以外）は従来の `L.skyColor` / `L.fogColor` / `_crOrig` のまま。
  - 新 mesh 0・PlaneGeometry は gnd の 1 個のみ・GridHelper 等なし。GroundVisualLayer は 1 Draw Call 維持。
- 色階層（通常表示）: 背景 `#f3f4f1` > 建物白 `#eef0ec` > 道路グレー `0xb8bdc3〜` / 河川シアン `0x9ed6e6` /
  公園グリーン（別系統）。
- 新規 `tests/mission17-background-boundary.test.js`（15テスト、全 pass）。stale 化した
  `tests/ward-ux-v1-p16h.test.js`（skyHex/fogHex/地表色）と `tests/ward-ux-v1-p17b.test.js`（地表色）を更新。
  `package.json` test へ登録。
- `npm test`: 583 tests / 568 pass / 0 fail / 15 skip。river/road/city-layer validator すべて PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。
- **実機確認待ち**（Mission 18 へは未着手）: City Mode 全景で東西南北に矩形の地表境界が出ない /
  大阪市が背景の中に自然に浮かぶ / Ward Mode 近景でも四角い plane 感なし / 白建物が背景に埋もれない /
  道路・河川・公園の外周が不自然に切り抜かれない / Mission09 陰影・Mission08 edge LOD・Mission07 白模型維持。

---

## 2026-09-06 セッション6X: 見た目改善20ミッション — Mission07 建物のさらなる白模型化

通常表示（MODEL_STYLE=true）の建物用途色をさらに抑え「ほぼ白〜薄灰の都市模型」に統一。
遠景で用途色がノイズにならず、白い建物群として一体化して見えることが最重要目標。
用途色そのもの（PRESET_WALL_COLOR / UST / UST_REAL）は削除せず、分析/legacy で復活。

- **監査結果**: MODEL_STYLE=true の壁色は `presetWallColor` = `msBuildingColor` = 用途色を
  `#eef0ec` へ **82%** ブレンド（用途色 18% 残）。屋根は `presetRoofColor` = `msRoofColor` =
  `#f6f7f3` へ 88%。材質は `wmReal`(model) = `MeshPhongMaterial` shininess 6 / specular 0x161616 /
  **emissive なし**、`tmReal`(model) = `MeshLambertMaterial` 単色。CityBuildingLOD は
  `LOD_COLOR = MS_BUILDING_WHITE`（既に壁白と同色）。data モードは `wm()`/`gs()` で用途色を使用。
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **白寄せ率を強化**: `MS_BUILDING_BLEND = 0.92`（壁、用途色 8% 残）/ `MS_ROOF_BLEND = 0.93`（屋根）。
    `msBuildingColor` / `msRoofColor` は定数参照へ。住宅/事務所/工場等の差は通常表示ではほぼ判別不能、
    ごく僅かな色温度差のみ残る（用途間の最大チャンネル差 ≤16）。
  - **roof/wall 差は維持**: 白ターゲットが `#eef0ec` vs `#f6f7f3`（差 8/255）+ Mission09 の頂点シェード
    （屋根 1.03）で roof > wall。
  - **emissive / 光沢**: 変更なし（既に emissive なし・shininess 6・matte）。プラスチック/ガラス光沢なし。
  - **CityBuildingLOD**: `LOD_COLOR` は `MS_BUILDING_WHITE` のまま＝白模型に統一済み。
    shared material 1個 / edge無 / shadow無 / picking無 を維持（変更なし）。
  - **debug**: `window.__BUILDING_COLOR_DEBUG__()` → `{modelStyle, wallWhite, roofWhite, wallBlend,
    roofBlend, cityLodColor, samples:[{preset, usageColor, wall, roof, wallSat, roofSat}]}`。
    `window.__MODEL_STYLE__` を切替えて `applyModelStyle()` 後に呼ぶと ON/OFF を同一視点比較できる。
  - geometry / 新 mesh / material 数は不変。`applyModelStyle` の cache 破棄（`wmRealC` 他 7 cache）で
    往復しても色が混ざらない。
- `tools/lib/model-style.js`（canonical lib）: `modelBuildingColor` 既定 0.82→**0.92**、
  `MODEL_ROOF_WHITE = 0xf6f7f3` + `modelRoofColor(amount=0.93)` 追加（HTML inline と一致）。
- 4色構成（通常表示）: BUILDING = off-white `#eef0ec` / ROAD = neutral gray `0xb8bdc3〜0xd0d3d6` /
  RIVER = light cyan-blue `0x9ed6e6` / PARK = soft green。遠景でも別系統。
- 新規 `tests/mission07-building-white.test.js`（17テスト、全 pass）。stale 化した
  `tests/ward-ux-v1-p16h.test.js`(blend率) と `tests/mission09-building-ao.test.js`(msRoofColor定数化) を更新。
  `package.json` test へ登録。
- `npm test`: 568 tests / 553 pass / 0 fail / 15 skip（1st run で demographics-pipeline-isolation が
  OneDrive/AV の rename race で EPERM → 単独再実行で 3/3 pass。コード起因ではない既知の事象）。
  river/road/city-layer validator すべて PASS。`git diff --check` クリーン。
  protected（fullward-v3.html）/ production HTML 無変更。
- **実機確認待ち**（次 Mission へは未着手）: 通常表示で建物がほぼ白〜薄灰 / 遠景で用途色ノイズなし /
  白い建物群として都市が一体化 / roof/wall 差維持 / Mission09 陰影・Mission08 edge LOD 維持 /
  CityBuildingLOD も白模型 / emissive 感なし / プラスチック光沢なし / 道路・河川・公園と色分離 /
  `window.__MODEL_STYLE__=false; applyModelStyle()` で用途色復活 / drawCalls 増加なし。

---

## 2026-09-06 セッション6W: 見た目改善20ミッション — Mission08 建物エッジの弱化

「線で建物を読ませる」のをやめ、Mission09 の陰影・接地暗化で形状を認識させる都市模型表現へ寄せる。
建物 geometry・高さ・用途色・AO・lighting は不変。対象は MODEL_STYLE=true 時の `bldgEdges` のみ。

- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **監査結果**: 建物エッジは `buildUsageTileMeshes` が用途×タイル単位で生成する統合
    `LineSegments`（`bldgEdges[]`）。材質は `em(usage)` がキャッシュした `LineBasicMaterial`。
    MODEL_STYLE時は従来 `color 0x8a9096 / opacity 0.28` の一律グレー。距離LODは無かった。
    CityBuildingLOD はエッジ無し。hover/select/ward/town の各ハイライトは `makeHighlightSet` 等の
    別実装（`renderOrder` 997-999、opacity 0.95）でエッジとは完全独立。
  - **新 `BUILDING_EDGE_LOD` モジュール**（`bldgEdges` 宣言直後に定義）:
    `EDGE_COLOR = 0xa0a6ac`（白模型向け light neutral gray。黒/濃灰にしない）。
    距離バンド `NEAR ≤2400m / MID ≤5600m / FAR` で opacity `{near:0.16, mid:0.08, far:0.0}`。
    FAR は `visible=false`（白いエッジノイズと LineSegments の Draw Call を消す）。
    band 変化時のみ全 `bldgEdges` を走査（毎フレーム再代入なし）。`syncNew()` で遅延ロード
    タイルの新規エッジを現バンドへ即時同期。`reset()` で再適用を強制。
  - **`em()` MODEL_STYLE ブランチ**: `BUILDING_EDGE_LOD.EDGE_COLOR` / `OP.near` を参照（単一ソース化）。
    legacy（用途色/分析モード）ブランチ（壁色寄せブレンド）は不変。
  - **`camUpd`**: `RiverLayerV2.updateByCamera` の直後に `BUILDING_EDGE_LOD.apply(cs.r)`。
  - **legacy 切替時の後始末**: `apply()` は `!MODEL_STYLE.on` かつ以前バンドを触っていれば
    全エッジ `visible=true` に戻して手を引く（用途色モードのエッジが消えたままにならない）。
  - **外観強調モード（`toggleEmphasis`）との非干渉**: 強調中は `apply()` が即 return。
    解除時に `reset()+apply(cs.r)` で距離バンドへ復帰。
  - **`applyModelStyle`**: エッジ材質差し替え後に `reset()+apply()` で距離バンド再適用。
  - **高さ非依存**: 高層ビルの立体感は Mission09 の側面陰影に任せ、edge opacity は増やさない。
  - **CityBuildingLOD 不変**: 遠景 LOD へエジは一切追加しない。
  - **debug**: `window.__BUILDING_EDGE_DEBUG__()` → `{distance, edgeBand, opacity, visible,
    edgeObjectCount, modelStyle, color, bands, op}`。
- 新規 `tests/mission08-building-edge.test.js`（19テスト、全 pass）。`package.json` test へ登録。
- `npm test`: 552 tests / 537 pass / 0 fail / 15 skip。river/road/city-layer validator すべて PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。
- **実機確認待ち**（Mission 07 へは未着手）: 白建物が線画に見えない / 近景で最低限の輪郭 /
  中景でエッジがかなり弱い / City Mode 遠景でエッジノイズ消失 / 陰影だけで立体感維持 /
  hover・select 強調は明確 / FPS 悪化なし（`renderer.info` で LineSegments Draw Call 減を確認）。

---

## 2026-09-06 セッション6V: 見た目改善20ミッション — Mission09 建物の接地影・AO表現

白模型でも高さ・接地感が伝わるよう建物陰影を改善。重shader/常時リアルタイムAO は導入しない。
建物用途色・河川色は不変。geometry/topology 不変。

- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - **接地暗化強化**: `groundContactDarken` の `minDarken` 0.82→0.76、グラデ区間 下から30%→24%
    （壁の下端が「地面に置かれている」影。黒くはしない）。壁頂点カラー（`wcol`/`wcolReal`）へ反映。
  - **roof/wall 明度差**: 新 `MS_ROOF_WHITE = 0xf6f7f3` + `msRoofColor()`。MODEL_STYLE時のみ
    `presetRoofColor` が壁(`MS_BUILDING_WHITE 0xeef0ec`)よりごく僅かに明るい白へ寄る（差 max 10/255）。
    legacy では `usageHex` そのまま返す＝色不変。Lambert屋根なので高さによる色ムラは出ない。
  - **model-day ライト再調整**: hemi 1.35→1.02（均一化を抑制）、sun 0.85→1.08（側面の明暗差）、
    fill 0.35→0.30（暗部を持ち上げ黒くしない）。sun.position は不変（影の向き維持）。
  - **CityBuildingLOD**: `MeshLambertMaterial` に `vertexColors:true` + 頂点接地暗化
    （壁下端0.80 / 上端1.0 / 屋根1.03）。影・UV・picking は無しのまま＝軽量方針維持・Draw Call不変。
  - **City Mode遠景の影抑制**: `camUpd` で `cs.r>8000` のとき `sun.castShadow=false`（shadow map
    描画負荷を削減。方向光 `sun` 自体は消さない）。近景復帰で影も復帰。`shadowEnabled=false`
    や夜モードではこのゲートは無効。
- Mission 08（edge弱化）でエッジを薄くしても陰影だけで形状が読めることを目標に設計。
- `npm test`: 533 tests / 518 pass / 0 fail / 15 skip。river/road/city-layer validator すべて PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。

---

## 2026-09-06 セッション6U: 見た目改善20ミッション — Mission05 河川カラー・岸線の最終調整

RiverLayerV2 の見た目のみ最終調整。**geometry/width/centerline/smoothing/topology は Mission04 で
確定・不変**（`git` タイムスタンプで rivers.json / river-ribbon.js 未変更を確認）。HTML のみ変更。

- `public/osaka_3d_buildings.ward-ux-v1.html` の RiverLayerV2:
  - `DEFAULT_STYLE` を再構成: `fillColor: 0x9ed6e6`（淡い water cyan-blue）、`shoreColor: 0x6fafc4`。
  - opacity を **NEAR/MID/FAR の3バンド × major/minor/shore** で整理（指示書2・3節）:
    - major: NEAR 0.72 / MID 0.55 / FAR 0.40（City Mode遠景でも水系が読み取れる）
    - minor: NEAR 0.62 / MID 0.44 / FAR 0.20（4500m超で非表示・Mission04-B維持）
    - 岸線: NEAR 0.50 / MID 0.40 / FAR 0.28（輪郭を軽く締める程度）
    - 距離アンカー NEAR<=2500 / MID=6000 / FAR>=14000m、間は `band3()` で線形補間。
  - `updateByCamera` を 2点lerp → band3 ベースへ。`FADE_NEAR_M/FADE_FAR_M` 削除（dead code）。
  - `setStyle` を `fillColor`（旧 `color` も互換受け）+ 3バンド opacity キー対応に。opacity は
    material 直書きをやめ `updateByCamera` で band 再計算（`getConflictDebug` はそのまま）。
  - material は MeshBasicMaterial / FrontSide / depthWrite=false / transparent（重shader無し）維持。
  - **MAP_LAYER_Y.WATER=0.04・renderOrder・geometry は不変**。
- 色は Mission03 の道路グレー（#b8bdc3〜#d0d3d6）・公園緑（0x7bb36a）と色相で明確に区別（cyan-blue）。
- `npm test`: 524 tests / 509 pass / 0 fail / 15 skip。river validator PASS（error=0, warn=6・
  Mission04-B と完全一致＝geometry不変の裏付け）。city-layer validator PASS。
  `git diff --check` クリーン。protected（fullward-v3.html）/ production HTML 無変更。

---

## 2026-09-06 セッション6T: 見た目改善20ミッション — Mission04-B 小河川の建物干渉解消

「建物が川の中に立って見える」問題を解消。RiverLayerV2 を major/minor に分け、minor には
保守的な幅ルール + 建物 footprint 干渉回避（幅縮小 → suppress）を適用。

- **新規** `tools/lib/river-building-conflict.js`: `buildFootprintGrid`（建物footprintの格子索引）/
  `assessRibbonConflict`（centerline/縁が建物内にある割合を評価）/ `resolveMinorConflict`
  （100→85→70→55%（named riverは40%まで）と段階縮小、それでも駄目なら suppress）。
- `tools/lib/river-width.js`: `conservativeMinorWidth`（minor: river16 / canal8 / drain4m、
  clamp 3〜30m）+ `MINOR_WIDTH_LIMITS`。
- `tools/lib/river-ribbon-validator.js`: `validateRiverRibbons` が riverClass=minor に minor 幅上下限を適用。
- `tools/build-river-layer.js`: major/minor 分類 → minor は conservative 幅 → 近傍建物 tile のみ
  読み込み（bbox+60m、490 tile / footprint 246,076）→ `resolveMinorConflict` → shrink/suppress。
  rivers.json に `riverClass` / `suppressed` / `conflictAction` / `conflictWidthScale` /
  `conflictEdgeInFrac` / `conflictCenterInFrac` を追加。`[RIVER-CONFLICT]` ログ。
- `tools/validate/river-ribbon.js`: Mission04-B セクション追加（major が suppress されていないか、
  表示中 minor に干渉が残っていないか、major が消えすぎていないか）。
- `public/osaka_3d_buildings.ward-ux-v1.html`: `build()` が `suppressed` river をスキップ。
  `riverClass` 優先の major/minor 分類。minor LOD 抑制強化（`MINOR_HIDE_DISTANCE_M` 6000→4500、
  中景 3500m から急速 fade）。`RiverLayerV2.getConflictDebug()` + `[RIVER-CONFLICT]` console。
  **色・opacity・y位置は不変**（Mission05で調整）。
- **結果**: minor 141本のうち 干渉検出 64 → keep 89 / shrink 6 / suppress 46。
  表示中 minor の建物干渉 = **0件**。major 31 セグメントは全て維持（品質不変）。
  堂島川・土佐堀川・木津川運河は thin 表示で残存、大川・東横堀川（阪神高速直下の暗渠的区間）は suppress。
- `npm test`: 523 tests / 508 pass / 0 fail / 15 skip。river validator PASS（error=0, warn=6）。
  city-layer validator PASS。`git diff --check` クリーン。protected 無変更。

---

## 2026-09-06 セッション6S: 見た目改善20ミッション — Mission04 河川幅の平滑化

RiverLayerV2の川幅変化を滑らかに。source・描画方式・色・opacity・y位置は不変（geometry/widthのみ）。

- **新規** `tools/lib/river-width-smooth.js`: `orderRiverSegments`（端点一致でOSM way分割を流路順に連結）/
  `rejectWidthOutliers`（流路順の幅列から単発スパイクを近傍中央値へ寄せる。河口への単調拡幅は保持）。
- `tools/lib/river-ribbon.js`: `offsetCenterline` が幅を配列（頂点単位）でも受けられるように。
  新規 `buildVertexWidths`（弧長で線形補間 + 絶対量25m/100m・比率1.3x/100m の2種rate clamp、前後2パス）と
  `buildRiverRibbonTapered`（raw→clean→densify→width interpolate→offset の順。指示書8節）。
- `tools/lib/river-ribbon-validator.js`: `widths` 配列の checks を追加（隣接頂点間の幅比 >2.5倍=ERROR、
  >1.6倍=WARN。指示書11節の「2〜3倍級瞬間jump」を検出）。
- `tools/build-river-layer.js`: 同名河川をグループ化 → 流路順 → outlier除去 → セグメント両端幅を
  隣接の平均でブレンド → tapered ribbon 生成。rivers.json に頂点単位 `widths` と
  min/median/max/p95 幅・`maxWidthDeltaPer100m` を追加。
- **主要7河川の平滑化結果**:
  - 神崎川: raw [224.8,219.6,123.6,**43**,91.5] → 43mピンチを 107.5 へ補正（最小幅 43→91.5m）
  - 木津川: raw [**61.4**,164.9,288.3] → 上流の過小値を 113 へ、河口288mは保持
  - 大和川: raw [208.4,138.2,108.7,86.4,94,103.8] → 6セグメント連結、河口208mは保持、maxΔ 2.7/100m
  - 淀川: 全区間 default 400m（riverbank疎で実測不可、元から一定）
- HTML（RiverLayerV2）は left/right をそのまま描画するため**変更なし**。色・opacity・y位置不変（テストで固定）。
- `npm test`: 503 tests / 488 pass / 0 fail / 15 skip。river-ribbon validator PASS（error=0, warn=6）。
  city-layer validator PASS。`git diff --check` クリーン。protected 無変更。

---

## 2026-09-06 セッション6R: 見た目改善20ミッション — Mission03 道路ribbon（幅付き面表示）

道路を「線」から「薄いグレーの道路面」へ。Mission02のLOD（FAR/MID/NEAR × major/mid/local）は維持。

- **新規** `tools/lib/road-ribbon.js`（canonical）: `classifyRoadWidth`/`clampRoadWidth`/`computeRoadWidth`
  （width tag → lanes×3.25m → highway class default）/ `buildRoadRibbon`（miter clamp/densifyは
  river-ribbon.jsを再利用）/ `validateRoadRibbon`。既定幅: motorway17 / trunk14 / primary12 /
  secondary9.5 / tertiary7.5 / residential5.5 / service3.5m（clamp 2.5〜28m）。
- `tools/lib/river-ribbon-validator.js`: `validateRiverRibbon` に `opts.widthLimits` /
  `opts.selfCrossingSeverity` を追加（道路は幅上限28m・self-crossingはWARN扱い＝ランプ/鋭角が多く
  局所オーバーラップは避けられないため。巨大三角形は maxTriangleEdge チェックで別途ERROR判定）。
- **新規** `tools/validate/road-ribbon.js`（CLI）: 全17,031道路のribbonを生成・検証し、主要道路
  （阪神高速・御堂筋・中央大通・国道43号等）を name/sourceId で audit。→ **RESULT: PASS**
  （error=0 / warn=26（全て良性のtight-corner self-crossing）/ maxTriangleEdge=45m / bboxViolations=0）。
- `tools/convert/roads.js` + `tools/build-city-layer-tiles.js`: 道路feature に name/source(way id)/
  width/lanes を保持（現行OSM抽出には width/lanes タグは0件のため実運用は class-default）。
  roads tile 再生成（feature 17,031 / tile 82、id安定）。city-layer validator PASS。
- `public/osaka_3d_buildings.ward-ux-v1.html`: `buildRoadMeshes()` を ribbon(THREE.Mesh)方式へ
  置換。tier(major/mid/local)ごとに1 merged BufferGeometry（1 tile 最大3 mesh、1道路=1mesh禁止）。
  色 major #b8bdc3 / mid #c4c8cc / local #d0d3d6（白模型グレー階調）。tier間 y差 0/0.004/0.008 で
  coplanar z-fight回避。旧LineSegmentsは `window.__ROAD_LINE_DEBUG__=true` 時のみ。
  新規 `CityTileLayer.getRoadRibbonDebug()`。
- 三角形数（全tile想定）: FAR(major)≈40,364 / MID≈127,472 / NEAR(all)≈227,448。drawCall数は
  Mission02から不変（tier別3 mesh/tile）。
- `npm test`: 488 tests / 473 pass / 0 fail / 15 skip。`git diff --check` クリーン。
  `fullward-v3.html`（元から独自の appendRoadRibbon を持つ・無変更）/ production HTML 無変更。

---

## 2026-09-05 セッション6Q: 見た目改善20ミッション — Mission02 遠景道路LOD

道路のhighway分類を3段階（MAJOR/MID/LOCAL）へ再設計し、City Mode遠景の細街路ノイズを削減。

- **新規** `tools/lib/road-lod.js`（canonical）: `classifyRoadLod`/`roadLodBand`/`roadClassVisible`/
  `countByRoadLodClass`。MAJOR=motorway系、MID=secondary/tertiary系、LOCAL=residential等・不明。
  FAR(>9000m)=MAJORのみ / MID(3500〜9000m)=MAJOR+MID / NEAR(<=3500m)=全道路。
- `tools/lib/city-mode.js`: 旧2段階(major/secondary常時+local近距離のみ)の重複実装を削除し、
  road-lod.jsをre-export。
- `public/osaka_3d_buildings.ward-ux-v1.html`: `buildRoadMeshes()`をmajor/mid/localの3mesh方式へ
  更新（1tileにつき最大3 mesh、変更なし）。`applyCityLOD`のband変化検出keyは既存のまま
  （9000/3500の境界値が偶然一致していたため変更不要）。新規 `CityTileLayer.getRoadLodDebug()`。
- 実データ（17,031道路feature）: major=1,378 / mid=4,700 / local=10,953。
  FAR可視=1,378(8.1%)、MID可視=6,078(35.7%)。
- `npm test`: 470 tests / 455 pass / 0 fail / 15 skip。city-layer validator PASS。
  `git diff --check` クリーン。`fullward-v3.html`/production HTML無変更。

---

## 2026-09-05 セッション6P: 見た目改善20ミッション — Mission01 City建物LOD（監査+補強）

「見た目改善20ミッション総合指令」の Mission01（City Mode用軽量building LOD）に着手。
基本実装は P1-7B（`CityBuildingLOD`）で完了済みだったため、今回は完了条件に対する監査と、
見つかった1件のギャップの補強を行った。

- **監査結果**: picking無し・edge無し・shadow無し・共有material・merged BufferGeometry・
  574,112棟一括ロード無し（24区progressive）はすべて実装済みと確認。
- **補強**: `HIDE_NEAR_M`（CityBuildingLOD→BuildingTileLayer実体表示への切替距離）を
  `3000m→4000m`へ引き上げ。`BUILDING_TILE_CONFIG.midRing=5`のring判定が正方形（Chebyshev距離）
  であるため対角方向には`5×500×√2≈3536m`まで実体タイルが表示され続けており、旧`3000m`だと
  対角方向でCityBuildingLODと実体建物が理論上同時に見えるduplicate窓が生じ得た。ring最大到達
  距離に安全マージンを乗せて解消。
- 新規 `tests/mission01-city-building-lod.test.js`（6件）: picking無し・merged geometry・
  progressive load・duplicate window無し（ring最大到達距離との数式比較）・handoff条件を検証。
- `npm test`: 452 tests / 437 pass / 0 fail / 15 skip。`git diff --check` クリーン。
  `fullward-v3.html`/production HTML無変更。

---

## 2026-09-05 セッション6O: RiverLayerV2 カラー調整（geometry/width不変）

実機で河川が薄すぎて見えづらいとのフィードバックを受け、`RiverLayerV2`の**material設定のみ**を
調整。centerline+width算出・ribbon offset生成・validatorロジックはこのセッションで一切変更していない
（`tools/lib/river-width.js` / `tools/lib/river-ribbon.js` / `tools/lib/river-ribbon-validator.js` /
`tools/build-river-layer.js` / `data/processed・public/map-data/osaka-city/rivers-v2/rivers.json`
はいずれも無変更。`git diff --stat`で確認済み）。

### 変更内容
- fill色: `0xb9dce8` → **`0x9ed6e6`**（より明るく、白建物・グレー道路と明確に区別できる淡い水色）
- fill opacity: major `0.42→0.72` / minor `0.36→0.65`（「ほぼ見えない」状態を解消。0.65〜0.80域）
- 岸線色: `0x6fa8bf` → **`0x6fafc4`**、opacity `0.35→0.52`（0.45〜0.60域。輪郭を軽く締める程度）
- 遠景(City Mode far) opacity: `0.3→0.42`（0.35〜0.50域を維持。大阪市全体を見た時に水系が一目で
  分かるよう、遠景でも完全に透明にはしない）
- **新規** `RiverLayerV2.setStyle(overrides)` / `getStyle()` / `getDefaultStyle()`: 実機で
  color/opacityを調整できるデバッグAPI。既存material（majorMesh/minorMesh/shoreMesh）の
  `color`/`opacity`のみを直接書き換え、geometryの再生成は一切行わない（軽量・即時反映）。
- y位置（`MAP_LAYER_Y.WATER = 0.04`）は変更なし。ground(-0.02) < water(0.04) < park(0.06) <
  road(0.10〜) の順序は元から維持されていたため、調整不要と確認。

### テスト・検証
- `tests/river-layer-v2.test.js`に新規5件追加（style値・岸線色・farOpacity・y位置/geometry
  不変・setStyle API）、既存の色/opacity値を検証していたテストを新値へ更新。
- `npm test`: **442 tests / 427 pass / 0 fail / 15 skip**。
- `node tools/validate/river-ribbon.js`: **RESULT: PASS**（error=0, warn=6。前回と完全に同一
  ＝geometry/width値が本当に不変であることの副次的な確認にもなっている）。
- `git diff --check`: クリーン。`fullward-v3.html`/production HTML無変更。

### 最終値
| 項目 | 値 |
|---|---|
| fill color | `#9ed6e6` |
| shoreline color | `#6fafc4` |
| fill opacity (major/minor) | 0.72 / 0.65 |
| shoreline opacity | 0.52 |
| far opacity (City Mode遠景) | fill 0.42 / shoreline 0.3 |
| y位置 | `MAP_LAYER_Y.WATER = 0.04`（変更なし） |

---

## 2026-09-05 セッション6N: 主要7河川の実機承認 → 全河川（canal含む）へ拡張

ユーザーが実機で主要7河川の描写を確認・承認。「次にcanal/small riverを追加してよいか」への
回答として承認が得られたため、`RiverLayerV2`の既定`nameFilter`を`STAGE1_DEFAULT_NAMES`（主要
7河川のみ）から`null`（全172河川、canal・小河川含む）へ変更した。

### 変更点
- `let nameFilter = null;`（旧: `STAGE1_DEFAULT_NAMES`）。`dispose()`後の再initも同じ既定。
- `STAGE1_DEFAULT_NAMES`定数は削除（`MAJOR_RIVER_NAMES`のみ残し、tier分類とデバッグ用
  `setNameFilter([...MAJOR_RIVER_NAMES])`の両方で利用）。
- これにより従来から実装済みだった minor tier の距離LOD（`MINOR_HIDE_DISTANCE_M=6000m`超で
  非表示、opacity減衰）が初めて実際に働く状態になった（主要7河川のみの間は全riverがmajor
  tier相当で常時表示だったため、このLODコードパス自体は今回まで実質未発火だった）。
- `tests/river-layer-v2.test.js`: 「既定nameFilterはnull」を検証するテストへ更新。

### 実測（全172河川表示時）
- major tier: 48 segments / 3,132 triangles（幅80m以上 or 主要7河川名）
- minor tier: 124 segments / 4,650 triangles（canal・小河川。City Mode遠景で距離LOD対象）
- 合計 triangles=7,782 / shoreline segments=7,782（1本のLineSegmentsへ統合）
- 描画: 3 Draw Call（major fill 1 + minor fill 1 + 岸線 1）
- validator: `node tools/validate/river-ribbon.js` → **RESULT: PASS**（error=0, warn=6, cityBboxViolations=0。warnは全て前回同様の「source node間隔が疎」で新規の問題ではない）

### テスト・検証
- `npm test`: **438 tests / 423 pass / 0 fail / 15 skip**。
- `git diff --check`: クリーン。`fullward-v3.html`/production HTML無変更。

### 残課題
- minor tier（canal・小河川）124本の見た目はまだ実機で個別確認されていない。距離LODで
  City Mode遠景では自動的に隠れる設計だが、Ward Mode近景での見た目（岸線の主張度合い・
  細い運河が多数重なって見える箇所が無いか等）は次の実機確認で確認をお願いしたい。

---

## 2026-09-05 セッション6M: 河川再導入（RiverLayerV2・主要7河川のみ第一段階）

前回セッション6L（河川完全再構築）で作った`CleanWaterLayer`を土台に、指示に沿って
`RiverLayerV2`へリネームし、**表示は主要7河川のみ**に絞った状態を正式な既定にした。
建物・道路・公園・鉄道の表示や白い模型デザインには一切手を触れていない。

### 1. リネーム: CleanWaterLayer → RiverLayerV2
`public/osaka_3d_buildings.ward-ux-v1.html`内の全参照（21箇所）を機械的に置換。
旧WaterLayer/CityTileLayer waterwaysとは引き続き完全独立、`WATER_LAYER_ENABLED=false`は不変。

### 2. 第一段階: 主要7河川のみ表示
`nameFilter`の既定値を`null`（全172河川）から`STAGE1_DEFAULT_NAMES`
（=`MAJOR_RIVER_NAMES`: 淀川/大和川/神崎川/安治川/木津川/寝屋川/道頓堀川）へ変更。
`dispose()`後の再initも同じ既定へ戻る。将来canal/small riverを追加する際は
`RiverLayerV2.setNameFilter(null)`で全河川へ拡張できる（データは既にrivers.jsonに全172本
入っている。HTML側の表示フィルタだけの変更で拡張可能）。河川名はOSMデータ由来の`name`
プロパティで選択しており、座標や形状をHTMLへハードコードしていない。

### 3〜5. centerline+ribbon方式・幅決定（変更なし、セッション6Lから継続）
`tools/lib/river-width.js` / `tools/lib/river-ribbon.js`のロジックは維持。今回追加した
検証強化:
- **新規** `maxTriangleEdge`（三角形の最長辺、m単位）を`buildRiverRibbon()`が報告するように。
- **新規** `rawMaxSegment`/`centerlineLength`（densify前の生centerlineの隣接点間隔・全長）を報告。
- validator（`tools/lib/river-ribbon-validator.js`）に3チェックを追加:
  - `maxTriangleEdge > 2000m` → ERROR（数km級の横飛び＝生成後のribbon geometry自体の破綻）
  - `rawMaxSegment > 5000m` → ERROR / `> 800m` → WARN（source node間隔の疎密。淀川の一部区間
    等、実データで多数発生する正常な疎さはWARNに留め、非現実的な単一区間ジャンプのみERROR）
  - 幅方向ベクトル（left[i]-right[i]）の隣接反転 → ERROR（self crossingの重大破綻）
- **新規** `validateCityBboxContainment(rivers, cityBbox, marginM)`: 各riverのribbon bboxが
  大阪市24区の外接矩形+500mに収まっているかを検証（指示書8節）。実データで**全172河川が
  violation 0**（大阪市外への飛び出しなし。centerline source自体が既にward-polygonでクリップ
  済み(P1-7B `polyline-ward-clip.js`)なため、ribbon offset後も市外へ出ていないことを最終確認）。
- 再検証結果: **rivers=172 / error=0 / warn=6**（すべて「source node間隔が疎」の目視確認レベル）。
  `node tools/validate/river-ribbon.js` → **RESULT: PASS**（cityBboxViolations=0）。
- HTML側`RiverLayerV2.build()`にも防御を追加: `r.validationErrors`が1件でもあるriverは
  描画対象から除外する（サーバ側で0件確認済みだが、二重の安全策として）。

### 6. 岸線（新規）
ribbonのleft/right端をそのまま`THREE.LineSegments`（1本のマージ済みgeometry、1 Draw Call追加）
として描画。色`0x6fa8bf`（本体`0xb9dce8`より少し濃い水色）、opacity 0.35（遠景でさらに減衰）。
本体fillのY(`MAP_LAYER_Y.WATER`)よりわずかに高いY(`+0.005`)でZ-fighting回避。

### 7. LOD
City Mode遠景でも主要7河川は常時表示（`nameFilter`が既定でmajorのみのため、事実上つねに
「majorだけ」の状態。今回のstage1では追加のcanal非表示LODは実質発火しない設計のまま）。
遠景でopacityを`majorOpacity(0.42) → farOpacity(0.3)`へ滑らかに下げる（消えはしない）。

### 9. 実測レポート（主要7河川。`data/reports/river-layer-generation.json`）
| 河川 | segment | centerlineLen(m) | width(median/min/max, m) | triangleCount | maxTriangleEdge(m) | error | warn |
|---|---|---|---|---|---|---|---|
| 淀川 | 4 | 16042 | 400/400/400 | 604 | 412 | 0 | 1 |
| 大和川 | 6 | 13218 | 108.7/86.4/208.4 | 528 | 217 | 0 | 1 |
| 神崎川 | 5 | 6692 | 123.6/43.0/224.8 | 258 | 236 | 0 | 1 |
| 安治川 | 2 | 6702 | 200/66.7/200 | 244 | 212 | 0 | 0 |
| 木津川 | 3 | 6963 | 164.9/61.4/288.3 | 336 | 295 | 0 | 0 |
| 寝屋川 | 8 | 6915 | 60/33.1/60 | 386 | 84 | 0 | 0 |
| 道頓堀川 | 3 | 2805 | 40/40/43.5 | 120 | 74 | 0 | 0 |

第一段階（主要7河川のみ）で実際にRiverLayerV2がbuildするのは31 segments・**triangles=2,476**・
岸線segment=2,476（1本のLineSegmentsへ統合）。2 Draw Call（fill 1 + 岸線 1）。

### 10. 一段ずつ有効化（STEP1〜5、実機確認手順）
```js
RiverLayerV2.setNameFilter(['淀川']);                                          // STEP1
RiverLayerV2.setNameFilter(['淀川', '大和川']);                                // STEP2
RiverLayerV2.setNameFilter(['淀川', '大和川', '神崎川']);                       // STEP3
RiverLayerV2.setNameFilter(['淀川', '大和川', '神崎川', '安治川', '木津川']);    // STEP4
RiverLayerV2.setNameFilter(null); // 全172河川（canal含む）。または元の既定(主要7河川)に
                                   // 戻すだけなら setNameFilter(['淀川','大和川','神崎川','安治川','木津川','寝屋川','道頓堀川'])
```
**既定状態（何もconsole操作しない場合）は既に主要7河川がすべて表示される**（完了条件の
チェックリストが「7河川すべて同時に自然に見える」ことを求めているため）。STEPコマンドは
問題があった場合の切り分け・段階的デバッグ用。

### テスト・検証
- 更新: `tests/river-ribbon.test.js`（+2: maxTriangleEdge/centerlineLength/rawMaxSegment）、
  `tests/river-ribbon-validator.test.js`（+4: maxTriangleEdge/rawMaxSegment(WARN・ERROR)/
  self-crossing/validateCityBboxContainment）、`tests/river-ribbon-regression.test.js`
  （WARN許容へ緩和・ERROR 0は継続必須）。
- リネーム: `tests/clean-water-layer.test.js` → **新規** `tests/river-layer-v2.test.js`
  （RiverLayerV2の名称・第一段階フィルタ・岸線・style値・validationErrors除外を検証）。
- `npm test`: **437 tests / 422 pass / 0 fail / 15 skip**。
- `node tools/validate/river-ribbon.js`: **RESULT: PASS**（error=0, warn=6, cityBboxViolations=0）。
- `git diff --check`: クリーン。`fullward-v3.html`/production HTML無変更。

### 8. 次にcanal/small riverを追加してよいか
**まだ追加しないことを推奨**します。まず主要7河川の見た目（自然さ・白い模型との調和・岸線の
主張度合い）を実機で確認・承認してから、`RiverLayerV2.setNameFilter(null)`で全河川へ拡張する
判断をしてください。データ自体は既にrivers.jsonに全172河川分（canal含む）入っているため、
承認後はHTML側のnameFilter既定値変更のみで拡張できます（再生成・再検証は不要）。

---

## 2026-09-04 セッション6L: 河川レイヤー完全再構築（centerline+width ribbon方式）

これまで複数回（P1-6E〜G）修正してきた河川描画（OSM area polygon をそのまま塗る方式）を
部分修正するのをやめ、**旧描画をcanonical表示から完全に外し、centerline+width ribbon方式で
ゼロから作り直した**。

### 1. 旧河川描画の無効化
- 新フラグ `let WATER_LAYER_ENABLED = false;`（既定false）を追加。
- `WaterLayer.show()`（埋め込み3区の面polygon直接塗り。旧実装）は、この関数内部で
  `WATER_LAYER_ENABLED` を見て何もしないよう変更（呼び出し側は変更不要）。
- `CityTileLayer` の `renderTileMeshes()` の `layer==='waterways'` 分岐（`buildWaterMeshes`による
  area polygon 直接fill）も同フラグでガードし、mesh を1つも生成しないようにした。
- どちらも**コード・データは削除していない**（`git diff --check`と`fullward-v3.html`保護テストで
  誤って消していないことを確認）。デバッグ時のみ `window.WATER_LAYER_ENABLED = true;` 等で復活可能。

### 2. 新レイヤー: `CleanWaterLayer`（独立モジュール）
- `public/osaka_3d_buildings.ward-ux-v1.html` に新規追加。旧`WaterLayer`/`CityTileLayer`の
  ロジックを一切再利用しない完全独立IIFE。
- 公開API: `init / load / show / hide / dispose / updateByCamera`（+ 実機確認用の
  `setNameFilter` / `getStats` / `isVisible`。指示書2節の「最低限」に対する補助のみ）。
- データ: `public/map-data/osaka-city/rivers-v2/rivers.json`
  （`node tools/build-river-layer.js` 生成。coordinateConvention不一致は読み込み拒否）。

### 3. 河川sourceの限定（指示書3節）
- 対象タグ: `waterway=river/canal/riverbank`, `water=river` のみ（既存`classifyWater()`の
  `waterClass` が `'river'|'canal'` の line feature をcenterlineとして採用）。
- pond/lake/reservoir/harbour/stream/natural=water分類不明は**今回のスコープ外**（旧レイヤー側の
  対象のまま。現状は旧レイヤー自体が非表示なのでこれらも一時的に非表示）。
- centerline source: `public/map-data/osaka-city/waterways/tile_*.json`（既存パイプライン
  出力。24区line-clip適用済み）から `kind==='line' && waterClass∈{river,canal}` を feature id で
  重複排除して取得（同一featureが複数tileに複製されているため）。172本（重複排除後）。

### 4〜5. centerline+width ribbon方式（面polygonの最小化）
- **新規** `tools/lib/river-ribbon.js`: `offsetCenterline()` が各頂点の左右offset点を算出。
  鋭角の折れ曲がりはmiter長を `maxMiterRatio=2.5` でclamp（bevelの厳密実装はせず、clampで
  spikeを防止。指示書5節で許容されている方式）。事前に `densifyPolylineXZ(maxSeg=60m)` で
  長い直線区間を分割し、巨大三角形が生まれないようにする。
  `triangulateRibbon()` が quad→2三角形化し `maxTriangleArea` を計測。
- riverbank polygon（waterway=riverbank等）は**幅推定にのみ使用し、直接mesh化しない**
  （指示書8節。`tools/build-river-layer.js` で `riverbanks` 配列として保持するが、
  `CleanWaterLayer` は `r.p`（area polygon本体）を一切参照しない＝テストで保護）。

### 6. 川幅の決定（指示書6節）
- **新規** `tools/lib/river-width.js`: 優先順位 `width タグ`（現行パイプラインはtagを
  tile出力に保持していないため未使用）→ `riverbank polygonからの実測（median）` →
  `waterway種別/主要河川名によるdefault`。
- 実測は centerline 上の複数サンプル点で局所接線に垂直な断面を測る。**重要な事故と修正**:
  初期実装は「左右で別々のriverbank polygonから最近傍のhitを拾う」方式だったため、合流部で
  隣接する無関係な広いpolygonの遠い辺を誤って合算し、寝屋川の一部区間で `width=500m`
  （上限clamp）まで暴走した。`pointInRingXZ` によるcontainment判定で「サンプル点を内包する
  同一polygon」からのみ左右を測るよう修正し、加えて中央値からの外れ値を1回trimする防御を
  追加（`tests/river-width.test.js` に実データ相当の回帰テストを追加）。
- `MIN_RIVER_WIDTH_M=6` / `MAX_RIVER_WIDTH_M=500` でclamp。

### 7. 主要7河川の実測結果（`data/reports/river-layer-generation.json`）
| 河川 | segment数 | 幅(median/min/max, m) | 方式 |
|---|---|---|---|
| 淀川 | 4 | 400 / 400 / 400 | default（該当区間にriverbank polygonが疎で実測不能。安全側でdefault） |
| 大和川 | 6 | 108.7 / 86.4 / 208.4 | measured |
| 神崎川 | 5 | 123.6 / 43.0 / 224.8 | measured |
| 安治川 | 2 | 200 / 66.7 / 200 | measured, default |
| 木津川 | 3 | 164.9 / 61.4 / 288.3 | measured |
| 寝屋川 | 8 | 60 / 33.1 / 60 | default, measured |
| 道頓堀川 | 3 | 40 / 40 / 43.5 | measured, default |

### 8〜9. ribbon triangle数・material
- 172河川centerline全体で **triangleCount = 7,782**（ERROR 0 / WARN 0）。
- material: `THREE.MeshBasicMaterial`（色 `0xaed8e4` 淡い水色、`transparent:true`、
  `opacity 0.2〜0.4`、`side: THREE.FrontSide`、`depthWrite:false`）。major/minor tierで
  BufferGeometryを1本ずつに統合＝**2 Draw Call**（172河川分すべて）。

### 10. 遠景LOD（指示書10節）
- major判定: `width>=80m` **または** 指示書7節の7河川名（道頓堀川・寝屋川は実測幅が
  80m未満のため、名称による「常時表示」指定を追加。幅だけで判定すると指示書が明示的に
  禁じている「消えすぎ」が発生するため）。
- minor（canal・小河川）は camera距離 `6000m` 超で非表示。major/minorともopacityは
  距離3000m→12000mで漸減（`STYLE.majorOpacity→STYLE.farOpacity` 等の滑らかなlerp。
  段差のあるband切替ではない）。

### 11. 新validator（指示書11節）
- **新規** `tools/lib/river-ribbon-validator.js`: finite座標 / width finite・>0・上限内 /
  centerline最大辺長 / 巨大三角形なし（`maxTriangleArea<=30000m²`） / ribbon bboxが
  centerline長+widthに対して異常に大きくない / centerlineから異常に離れたoffset頂点なし、を検証。
  ERRORは描画停止級の欠陥、WARNは目視確認対象という区別（既存`water-semantic-validator`と
  同じ設計思想）。
- CLI: `tools/validate/river-ribbon.js` → `node tools/validate/river-ribbon.js` で実行、
  `data/reports/river-ribbon-validation.json` に保存。**RESULT: PASS**（error=0, warn=0）。

### 12. 実データregression
- **新規** `tests/river-ribbon-regression.test.js`: fixture化はせず、実際に生成された
  `public/map-data/osaka-city/rivers-v2/rivers.json` に対して直接検証。淀川・大和川・神崎川の
  全segmentが `ok:true` かつ validator ERROR/WARN 0、widthが許容範囲内であることを確認。

### 13. 実機確認の順番（STEP1〜6）
`CleanWaterLayer.setNameFilter()` で再フェッチ無しにcenterline名でフィルタできる（指示書13節向けに追加）。
```js
// STEP1: 河川完全非表示
CleanWaterLayer.hide();
// STEP2: 淀川だけ
CleanWaterLayer.show(); CleanWaterLayer.setNameFilter(['淀川']);
// STEP3: 大和川追加
CleanWaterLayer.setNameFilter(['淀川', '大和川']);
// STEP4: 神崎川追加
CleanWaterLayer.setNameFilter(['淀川', '大和川', '神崎川']);
// STEP5: 全river追加（canal除く主要河川はデータ上すでに区別されないため実質STEP6と同じ）
// STEP6: 全河川（canal含む）
CleanWaterLayer.setNameFilter(null);
```

### 14. 旧water dataは削除していない
`WaterLayer`・`CityTileLayer` waterways ロジック・`data/processed/osaka-city/waterways/`・
`public/map-data/osaka-city/waterways/` はすべて温存（canonical表示から外しただけ）。

### テスト・検証
- 新規: `tests/river-width.test.js`(11) / `tests/river-ribbon.test.js`(9) /
  `tests/river-ribbon-validator.test.js`(8) / `tests/river-ribbon-regression.test.js`(3) /
  `tests/clean-water-layer.test.js`(11)。全て `package.json` の `test` script へ登録済み。
- `npm test`: **428 tests / 413 pass / 0 fail / 15 skip**。
- `node tools/validate/river-ribbon.js`: **RESULT: PASS**（7河川すべて `[PASS]`）。
- `git diff --check`: クリーン。`fullward-v3.html`/production HTML は無変更。

### 既知の残課題・今後の判断
- 淀川の一部segmentはriverbank polygonが疎でcenterline実測に至らずdefault(400m)を使用。
  実際の川幅（場所によっては600m超）より狭い可能性があるため、実機で「淀川が細すぎないか」を
  確認してほしい。細すぎる場合はdefault値の調整、またはriverbank polygon探索のbufferM拡大で対応可能。
- pond/lake/reservoir/harbour/streamは今回のスコープ外＝現状すべて非表示（旧レイヤー停止の
  副作用）。河川の見た目が確認できた後、別レイヤーとして戻す作業が必要（指示書3節の想定通り）。
- 旧河川コード（`WaterLayer`本体・`CityTileLayer`のarea-fillロジック）の削除は、
  **実機でCleanWaterLayerの見た目が確認・承認されるまで行わない**（指示書14節・15節の方針通り）。
  承認後、別セッションで削除を提案する。
- FPS・実際のスクリーンショット確認はブラウザでの実機確認が必要（このサンドボックスでは
  描画結果を直接視認できない）。

---

## 2026-09-04 セッション6K: P1-7B City Mode 最終整形

セッション6J（P1-7）実機確認後の指摘5点（市外道路の混入・建物が中心部だけに集中・Ground extentの
四角い境界が見える・大河川が遠景でまだ強い・全体として「大阪市だけの綺麗な白模型」に見えない）への対応。

### 1. 大阪市外feature混入（道路が主要因）
- **新規** `tools/lib/polyline-ward-clip.js`: `clipPolylineToWards(points, wardIndex, bufferM=150)`。
  既存の feature 単位 bbox-vs-ward-polygon フィルタ（P1-6F）は「1点でも区に触れれば全長を残す」
  all-or-nothing だったため、区境をわずかに掠めるだけの長い道路/鉄道線が隣接市（豊中・守口・東大阪・堺等）
  へ延びる区間ごと表示されていた。頂点単位で inside/outside を判定し、連続する inside run へ分割する
  **真の線分クリップ**へ置き換え（`tests/polyline-ward-clip.test.js` 7件）。
- `tools/build-city-layer-tiles.js`: `kind==='line'` の feature にこのクリップを適用。面(area)・駅(station)は
  既存の fraction ベースフィルタを維持（変更なし）。
- 実データ再生成結果: roads 18,767→**17,031** features / 103→**82** tiles（`clippedLineFeatures=221`）。
  waterways/railways も同様にクリップ件数を記録（`data/reports/city-layer-tiles-generation.json`）。
  validator は `node tools/validate/city-layer-tiles.js --area osaka-city` → **PASS**
  （`--force`再生成直後の1回のみ transient な tile-parse失敗が発生したが、再実行2回で連続PASS。
  各"壊れた"tileを個別に`JSON.parse`しても正常parse済み。Windowsのファイルflush/AVスキャンの
  タイミング起因と判断、コード側の問題ではない）。

### 2. 建物density: 道路が全域・建物が中心部だけの不整合
- **新規** `CityBuildingLOD`（`public/osaka_3d_buildings.ward-ux-v1.html` のみ。dev target限定）:
  24区分の建物 manifest+tile を `BuildingTileLayer` と**同一のURL形状・JSONフィールド**
  （`manifest.tiles:[{tx,tz}]` / `tile.buildings:[{id,fp,z0,dz,usage}]`）で読み、区ごとに
  壁(押し出し)+屋根(fan)のみ（底面・エッジ・UV・頂点カラー・buildingIndexは省略）を1つの
  `BufferGeometry`へマージ、共有`MeshLambertMaterial`(白 `0xeef0ec`)1個・影なしで描画（区=1 Draw Call）。
  `CityModeManager.enter()` から `build()`（24区を1区ずつ progressive load。同時多発fetch回避のため
  6tile/バッチ・90ms間隔）。`camUpd()` から毎フレーム `setCameraDistance(cs.r)` を呼び、
  `HIDE_NEAR_M=3000` 未満では非表示にして既存 `BuildingTileLayer` の実体表示（ring判定・詳細
  マテリアル・ピッキング・影つき）へ handoff する。layer-toggle「建物」にも連動。

### 3. Ground extentの四角い境界が斜めの巨大面として見える
- `GroundVisualLayer.computeBounds()` のみを変更（`OSAKA_CITY_GROUND_EXTENT`定数自体は
  camera/tile grid 側と共有のため不変）: `GROUND_VISUAL_STYLE.groundPad=9000` を追加し、
  表示範囲を extent よりさらに9000m外側まで拡張（案B）。
- あわせて model style 時の `GROUND_VISUAL_STYLE.colorReal` を `0xd4d2ca` →
  `msBlend(0xd4d2ca, 0xc8ced3, 0.55)`（fog/sky の modelDay 色 `0xc8ced3` 寄り）へブレンドし、
  遠景での地表外周と背景の境目を目立たなくした（案C。地表を24区ポリゴン形状にする案Aは
  水域三角形分割の教訓（P1-6F/G）を踏まえリスクが高いため不採用）。

### 4. 大河川の遠景がまだ強い
- `tools/lib/water-render-lod.js` / HTML `waterLod()` の両方に、`family!=='harbour' && !=='basin'`
  かつ `d>9000`（City Mode の camera 距離域）でさらに `shorelineOpacity` を `d:9000→20000` で
  現在値→`0.12` まで滅衰させる追加カーブを実装（basin/harbourは対象外）。
  `tests/water-render-p16g.test.js` に該当テストを追加。

### 5. 道路 LOD 再編（骨格として主張しすぎない）
- `tools/lib/city-mode.js` / HTML: road tier を `major/mid/local` → **`major/secondary/local`** へ
  再定義。`major`(motorway/trunk/primary)=常時濃色、`secondary`(secondary)=常時だが薄色
  （`msBlend(base, 0xffffff, 0.45)`）、`local`(tertiary+residential+不明)=距離≤3500mのみ。

### 6. カメラフレーミング（70〜85%を占める）
- `cityCameraTarget()`（pure lib）/ `getCityCameraTarget()`（HTML）の `radiusFactor` を
  Ward用と共通の `0.62` → **`0.5`** へ変更（ハードコード座標なし。extent由来のdiagに対する係数のみ変更）。

### テスト
- 新規/更新: `tests/polyline-ward-clip.test.js`（7）、`tests/city-mode-p17.test.js`（road tier再定義・
  radiusFactor=0.5 用に更新）、`tests/ward-ux-v1-p17.test.js`（road tier正規表現更新）、
  `tests/ward-ux-v1-p17b.test.js`（新規・Ground extent + CityBuildingLOD 配線検証）、
  `tests/ward-ux-v1-p16h.test.js`（地表色ブレンド式の更新）、`tests/water-render-p16g.test.js`
  （遠景滅衰カーブ追加）。全て `package.json` の `test` script へ追加登録。
- `npm test`: **386 tests / 371 pass / 0 fail / 15 skip**。
- `git diff --check`: クリーン（改行コード警告のみ）。`public/osaka_3d_buildings.fullward-v3.html` /
  production `osaka_3d_buildings.html` は無変更（テストで保護）。

### 既知の残課題
- 面(area)・駅(station)の除外は引き続き fraction ベース（bbox的な overlap 判定）であり、線のような
  真のクリップではない。四角い切断エッジが必要になるケースは今のところ確認されていない。
- FPS・実機スクリーンショットでの最終見た目確認はブラウザでの確認が必要（このサンドボックスでは
  描画結果を直接視認できない）。
- `CityBuildingLOD` は24区を直列ロードするため、24区分の manifest+tile 取得が完了するまで一部区の
  建物密度が薄いまま表示される時間帯がある（progressive load の性質上、意図した挙動）。

---

## 2026-09-04 セッション6J: P1-7 City Mode（大阪市24区全域表示）

Ward Mode に加え、「大阪市全体を一望し、道路・河川・公園・鉄道が24区全域で連続して見える」City Mode を追加。

### 追加ファイル
- `tools/lib/city-mode.js`（新規・純粋・Node テスト済み）: `cityCameraTarget` / `roadTierOf` / `roadTierVisible` /
  `parkTierOf` / `parkTierVisible` / `railLineVisible` / `stationVisible` / `batchProgressive` / `sortTilesByCenterDistance`。
- `tests/city-mode-p17.test.js`（8）/ `tests/ward-ux-v1-p17.test.js`（15）。

### `public/osaka_3d_buildings.ward-ux-v1.html`（dev target のみ・fullward-v3/production 不変）
- **`getCityCameraTarget()`**: `OSAKA_CITY_GROUND_EXTENT`（P1-5B で算出済みの24区地表範囲）から
  center/width/height/diag/radius をハードコードなしで算出。
- **`CityTileLayer.coverCityBbox()`**: 156 tile を手書きせず、各レイヤーの **manifest.tileSet をそのまま使用**。
  中心タイルからの距離でソート（中心→外）し `loadTilesProgressively()`（10件/バッチ・70ms間隔の
  `setTimeout` チェーン）で段階ロード。156 tile 同期一括ロードはしない。
- **道路 LOD**: `buildRoadMeshes()` が highway 種別で major(motorway/trunk/primary) / mid(secondary/tertiary) /
  local(residential 等) の3 mesh に分離。`roadTierVisible`: major=常時 / mid=距離≤9000m / local=距離≤3500m。
- **公園 LOD**: `buildParkMeshes()` が面積 2ha 基準で big/small に分離（三角形分割は既存 `areaMesh()` を再利用）。
  big=常時 / small=距離≤4000m。
- **鉄道 LOD**: 路線(rail/subway/light_rail)は骨格として常時表示。駅は距離≤5000m のみ表示。
- **LOD 統合**: `applyWaterLOD` を `applyCityLOD`/`applyLodToOneMesh` へ一般化し、水域・道路tier・公園tier・
  駅を同じ「band 変化時のみ全走査」の仕組みで扱う（`lastCityLodKey` による変化検出）。
- **`CityModeManager`**: `enter()` — `WardModeManager.clearActiveWard()`（単一区ACTIVE前提を解除。
  `update()` の境界自動切替は `currentWardId===null` で早期returnするため City Mode 中は働かない）→
  **Option A**: 24区すべての建物 dataset を enable（実際に fetch されるのは既存の ring 判定により
  camera 近傍 tile のみ。574,112棟の一括ロードにはならない）→ camera を `getCityCameraTarget()` の位置へ →
  `CityTileLayer.coverCityBbox()`。`exit(nextWardId)` — 対象区以外の dataset を **disable のみ**
  （dispose しない。BuildingTileLayer の既存 LRU に委ねる = 古い tile を壊さない）。
- **`MAX_TILES_PER_LAYER`**: 64 → **170**（大阪市全域を1レイヤーあたり最大156 tile 保持しても
  LRU 退避しない。tile JSON は小さいためメモリ上問題ない）。
- **duplicate feature 防止**: 既存の module 全体で共有する `seenFeatureIds`（Ward/City で分離していない）を
  そのまま利用。City Mode 専用の dedup ロジックは追加していない（追加不要）。
- **`[CITY-PERF]`**: `firstRoadMs`/`firstWaterMs`/`firstParkMs`/`firstRailMs`（`markCityStart()` からの初到着まで）/
  `loadedXxxTiles`（`getStats()`）/ `drawCalls`/`geometries`/`triangles`（`renderer.info`）を、
  4レイヤーすべて到着 or 15秒タイムアウトで出力。
- **layer UI**: 建物/道路/河川/公園/鉄道/駅名 の6チェックボックス（新規パネル）。
  `CityTileLayer.setLayerEnabled(layer, on)` + 埋め込み3区レイヤー（RoadLayer/ParkLayer/WaterLayer/
  BuildingTileLayer）の show/hide。
- **UI**: エリア選択パネルへ「大阪市全域」行を追加（区一覧より上、独立行）。選択で `CityModeManager.enter()`。
  区行クリック時は City Mode 中なら先に `CityModeManager.exit(def.id)` を呼んでから通常の `switchWard`。
  ラベル/行ハイライトも City Mode 対応。

### tile coverage（実データ・`node tools/build-city-layer-tiles.js --layer all --public --force` 後）
grid: 13×12=**156 tile**（tileSize 2000m）。24区外フィルタ後:

| layer | feature | tile | tile entries |
|---|---|---|---|
| roads | 18,767 | **103** | 20,718 |
| parks | 2,685 | **80** | 2,818 |
| railways | 3,187（24区外フィルタ後。フィルタ前 line 3223 / station 271） | **91** | 3,799 |
| waterways | 562 | **95** | 838 |

`node tools/validate/city-layer-tiles.js`: **RESULT: PASS**（water semantic ERROR 0 / WARN 26）。

### テスト
- `tests/city-mode-p17.test.js`（8）: cityCameraTarget（extentから算出・maxRクランプ）/ roadTier分類としきい値 /
  parkTier / railLineVisible / stationVisible / batchProgressive（156→16バッチ）/ 中心優先ソート。
- `tests/ward-ux-v1-p17.test.js`（15）: city bbox→tile集合がmanifest由来 / progressive load配線 /
  camera target配線 / road・park・rail LOD配線 / **City↔Ward lifecycle**（enter/exit・clearActiveWard・
  enableDataset全24・exit時disable）/ 重複防止（seenFeatureIds単一定義）/ LRU上限156以上 /
  [CITY-PERF]フィールド / layer UI 6項目 / City Mode UI行 / **fullward-v3不変** / JS構文。
- `npm test`: **373 / 358 pass / 0 fail / 15 skip**（+23）。city-layer validator PASS。
  `git diff --check` クリーン。production・fullward-v3 HTML 不変。

### 実機で確認（ブラウザ・タイミング/FPS/DrawCallsは要ローカル）
1. 「大阪市全域」選択 → 数秒以内に主要道路・河川・鉄道が見え始め、その後外側へ広がるか（156 tile 完了を待たないか）
2. 遠景で細街路・小規模公園・駅ラベルが非表示、近づくと段階的に現れるか
3. 大阪市全体表示で河川が巨大な青い板に戻っていないか（P1-6G/H の LOD・model style を維持）
4. City→Ward→City→別Wardを繰り返しても古い tile が壊れない・重複描画されない・メモリが増え続けないか
5. `[CITY-PERF]` ログの firstRoadMs 等が「数秒以内」の目標を満たすか、drawCalls/triangles が実用範囲か

---

## 2026-09-04 セッション6I: P1-6H 「クリアな都市模型」表現（白い建物 / 淡い川 / 整然とした道路・台座）

参照画像（白い建物・薄い水色の川・整理された都市模型）へ寄せる見た目の作り直し。
**正式な既定表示**: `window.__MODEL_STYLE__` を未設定なら `true` に明示初期化し、`initVisualSystem()` が
`applyModelStyle()` を自動実行する → **ページを開くだけで模型表示**。適用時に `[MODEL-STYLE] applied: model` を
console 出力。legacy 表示は debug 用として残す（`window.__MODEL_STYLE__ = false; applyModelStyle();`）。

### `tools/lib/model-style.js`（新規・純粋・Node テスト済み）
`blendHexToward` / `modelBuildingColor`（用途色 → 暖色オフホワイト 0.82 ブレンド）/
`modelWaterFillOpacity`（距離で滑らかに減衰する低 opacity）/ `modelShorelineOpacity` /
`MODEL_WATER_COLOR`（淡いシアン）/ `MODEL_ROAD_COLOR` / `MODEL_GROUND_COLOR` / `MODEL_SKY_COLOR`。

### `public/osaka_3d_buildings.ward-ux-v1.html`（dev target のみ・fullward-v3/production 不変）
- **建物**: `presetWallColor`/`presetRoofColor`/`gsReal` が用途色（クリスタル系の鮮やか
  パレット amber/aqua/sapphire…）を **暖色オフホワイト（#e0〜#ef）へ 82% ブレンド**。用途の色相は
  ごく僅かだけ残る。`wmReal`/`tmReal` は **発光・強ハイライトなしのマット**（shininess 6・emissive なし）。
  `wmRealNear`/`wmRealMid` も低 shininess。エッジ線は用途色の輪郭をやめ **控えめなグレー（0x8a9096 / opacity 0.28）**。
  接地暗化（疑似 AO の頂点カラー）は既存のまま維持 → 「白い模型に柔らかい影」。
- **河川**: 淡いシアン（linear 0xbcdce6 / basin 0xb2d6e2 / harbour 0x9fc4d2）。`waterLod` を
  **距離で滑らかに減衰する曲線**へ（帯・板を作らない）: 河川 near 0.30 → 6200m で 0、巨大河川 near 0.20 → 5200m で 0。
  池・湖は距離があっても残す（0.34→0.14）。港湾は最初から極薄（0.10→0.04）。岸線は控えめ（遠景で fill が
  消える分だけ僅かに強める）。y=0.04・renderOrder 906（道路 930・建物より下 → 都市を覆わない）。
- **道路**: RoadLayer の `colorReal` を明るいグレー（0x9aa0a6 へ 55% ブレンド → #74〜#90）。
  `CityTileLayer` roads を 0x9aa1a8 の整然としたグレー線。地表（GroundVisualLayer）を **明るい中立グレー 0xd4d2ca**（模型台座）。
- **背景・ライト（昼・模型 ON 時）**: 背景/Fog を落ち着いた明るいブルーグレー（0xc4ccd2 / 0xc8ced3、Fog 遠め）。
  hemi 光を強め（1.35）・sun を弱め（0.85）・fill を弱め（0.35）で **影を柔らかく全体をフラットに**。exposure 1.05。
- `applyModelStyle()` … 建物マテリアルキャッシュ破棄 → 道路/地表色の寄せ → 環境・時間帯の再同期。
  init で1回・console から再実行で切替。

### 河川異常
- P1-6F の 24区外フィルタ（猪原川 rel/16551409 等 238 件除外）・P1-6F の source 追跡・semantic validator は維持。
- 巨大な破綻水面は無し（bbox diag > 7000m の area feature 0 件、semantic ERROR 0）。
- P1-6H は「見た目」の変更のみ（データ再生成なし。waterways tile は P1-6G の waterClass 付きを継続使用）。

### テスト
- `tests/model-style-p16h.test.js`（8）: blend / 白寄せ（明度↑・彩度↓）/ 水 opacity 曲線（近 0.28 / 遠 0 / giant 早期減衰 /
  basin 残存 / harbour 極薄）/ mode 切替 / 岸線曲線 / 淡いシアン色。
- `tests/ward-ux-v1-p16h.test.js`（8）: MODEL_STYLE 既定 ON / applyModelStyle 配線 / 建物白寄せ・マット /
  水パレット・減衰カーブ / 道路・地表色 / 背景・ライト / fullward-v3 不変 / JS 構文。
- `npm test`: **350 / 335 pass / 0 fail / 15 skip**（+16）。city-layer validator PASS / water semantic ERROR 0 /
  `git diff --check` クリーン。production・fullward-v3 HTML 不変。

### 実機で確認（ブラウザ・スクリーンショット / FPS は要ローカル）
1. 建物が白〜薄灰のクリーンな模型に見えるか（用途の色分けが弱まっているか）
2. 淀川・大和川・神崎川が淡い水色で、板・帯に見えないか。池・湖は塗りが残るか。港湾は控えめか
3. 道路が整然としたグレー線、地表が明るい台座、背景が落ち着いているか
4. 水面が道路・建物を覆っていないか
5. `window.__MODEL_STYLE__ = false; applyModelStyle();` で従来表現に戻して比較（スクリーンショット）
6. FPS 悪化なし（マテリアル差し替えのみ・新規 geometry なし）

---

## 2026-09-03 セッション6H: P1-6G 河川描画を「ベタ塗り」から「岸線 + 距離LOD」へ

P1-6F で source geometry・市外除外は完了したが、実機で淀川・大和川・神崎川・安治川が依然
「巨大な水色の板／帯」に見える（全 water area を opacity 0.5 の平面フィルで塗っていたため、
ward 視点で数百の半透明青面が重なり都市を覆う）。cross-section 実測で大和川は 165〜1102m 幅
＝ポリゴンは正しい（誇張ではない）。表現方式の問題。

### 水域分類（`tools/lib/water-classify.js` 新規）
`classifyWater(tags)` → river / canal / stream / lake / pond / reservoir / harbour / water。
`waterRenderFamily(cls, bboxDiag)` → **linear**（河川・運河・不明大面：岸線主体）/ **basin**（池・湖・
貯水池：面フィル主体）/ **harbour**（港湾・海：背景寄り）。実データ: area river 110 / water 93 /
canal 13 / pond 66 / reservoir 77 / lake 1 / harbour 2。

### 距離 LOD（`tools/lib/water-render-lod.js` 新規）
| band | 距離 | linear 河川 | 巨大河川(bboxDiag>2500m) | basin 池湖 | harbour |
|---|---|---|---|---|---|
| far | >6000m | 岸線のみ（fill 0） | 岸線のみ | fill 0.22 | fill 0.06 |
| mid | 3000〜6000m | 岸線 + fill 0.16 | **岸線のみ（fill 0）** | fill 0.28 | fill 0.06 |
| near | <3000m | 岸線 + fill 0.30 | 岸線 + fill 0.20 | fill 0.34 + 岸線 | fill 0.10 |

ward 選択時の camera 距離（区の diag×0.62 ≈ 3〜5km）は **mid** → 河川は岸線主体、巨大河川はフィル無し。

### `public/osaka_3d_buildings.ward-ux-v1.html`（dev target のみ・fullward-v3/production 不変）
- **`buildWaterMeshes()`**: water area を「岸線 LineSegments」＋「ファミリ別フィル mesh
  （linear / linearGiant / basin / harbour）」に分解。各 mesh は `userData.water.{role,family,giant}`。
- **`applyWaterLOD(distance)`**: band 変化時のみ全 water mesh の `visible` / `material.opacity` を更新（軽量）。
  `CityTileLayer.setCameraDistance(cs.r)` を `camUpd` から毎フレーム呼ぶ（band 未変化なら即 return）。
- **`window.__WATER_STYLE_MODE__`** = `'legacy'`（旧ベタ塗り 0.5）/ `'shoreline'`（岸線のみ）/ `'lod'`（既定）。
  `CityTileLayer.setWaterStyleMode(mode)` で切替 → 同一視点で比較可能。
- 水面高さ `WATER_FILL_Y=0.04`（地表直上、道路 0.13・公園 0.07 より下 → 都市を覆わない）、
  岸線 `0.055`。fill renderOrder 906 / 岸線 923（道路 930 より下）。material は彩度を落とした
  slate-blue、`FrontSide` / `depthWrite:false` 維持。`MeshBasicMaterial` のまま（重い shader 不使用）。
- 中州（hole）も岸線として描画。港湾（harbour）は岸線なし・ごく薄いフィルのみ。
- `[WATER-DRAW-DEBUG]` に `waterClass` / `family` / `giant` / `styleMode` を追加。
- 旧 `areaMesh` の水域専用デバッグは撤去し `[AREA-DRAW-DEBUG]`（`window.__AREA_DRAW_DEBUG__`）へ。

### 主要河川の扱い（directive #11）
- **淀川 rel/18534445・大和川本流 rel/18534444**: area ポリゴンは `analyzeRing` の巨大セグメント検出で
  既に除外済み（`oversizedDropped: 32`）→ 中心線のみ描画（P1-6G の対象外だが板にはならない）。
- **大和川西端 rel/18530063**（57〜1102m 幅）/ **大和川 rel/18530062**（165〜548m 幅）/ **安治川 way/147544811**
  （1.47km²）: すべて bboxDiag > 2500m → **giant** → far/mid で岸線のみ、near のみ薄フィル。
- **神崎川 rel/8421377**（中州 inner×2）: linear、bboxDiag 2880m → giant 相当。岸線 + 中州岸線で形状表示。
- 道頓堀川・木津川・城北川・東横堀川: linear、非 giant → 通常 LOD（far 岸線 / mid 薄 / near 通常）。

### テスト
- `tests/water-render-p16g.test.js`（11）: classifyWater / family / band / LOD 各帯 / giant suppression /
  basin 常時表示 / harbour / style mode / shoreline 生成（hole 含む）/ 実データ regression。
- `tests/ward-ux-v1-p16g.test.js`（10）: buildWaterMeshes 配線 / LOD 配線 / giant / style mode /
  水面 y・renderOrder が都市より下 / WATER-DRAW-DEBUG / fullward-v3 不変 / JS 構文。
- `npm test`: **334 / 319 pass / 0 fail / 15 skip**（+19）。city-layer validator PASS / water semantic ERROR 0 /
  `git diff --check` クリーン。production・fullward-v3 HTML 不変。

### 実機で必ず確認（ブラウザ）
1. ward 選択（mid 距離）で淀川・大和川・神崎川・安治川が**岸線の対で認識でき、青い板が消えている**か。
2. 市全体表示（far）で岸線のみ、街に寄る（near）で水面が自然に見えるか。
3. `CityTileLayer.setWaterStyleMode('legacy')` ⇔ `'lod'` を同一視点で切替えて比較（スクリーンショット）。
4. 池・湖（basin）は距離によらずフィルが残るか。港湾は控えめか。
5. 水面が道路・建物の上に被らないか（renderOrder / y）。FPS 悪化なし（band 変化時のみ再走査）。

---

## 2026-09-03 セッション6G: P1-6F 巨大河川ポリゴンの SOURCE geometry 調査・根本修正

P1-6E 後も実機で巨大な水色ポリゴン（左上へ数km伸びる楔形 / 画面下部の太い帯）が残存。

### 調査（vendored earcut = tools/lib/earcut.js で source を全解析）
- 水域 area **481件（way 429 + relation polygon 52）すべて triArea/polyArea ≈ 1.000**。earcut に不具合なし。
- relation の member way stitching: **暗黙 closure 0件・独立 outer の誤連結 0件・自己交差 0件**。
  複数 outer way は OSM 仕様どおり端点共有で1本の周に連結されており正しい。
- **真の原因**: `tools/import/osm-pbf-city.js` の feature フィルタが「24区 bbox（外接矩形）と交差するか」
  だけを見ていた。24区 bbox は夢洲・舞洲・咲洲や南北端を含み極めて大きく、**尼崎市側の猪名川・
  神崎川ポリゴンが矩形の隅をかすめるだけで通過**していた。
  実測: `relation/16551409`（7.8km・「左上の楔形」）= 24区ポリゴン内のサンプル点 **0/103**。
  `relation/18530060` / `way/1334652438` も 0/N。

### 修正
- **`tools/lib/feature-ward-overlap.js`（新規）**: `ward-classification-polygons.json`（znorth-neg-v1）で
  feature の点列が「区ポリゴン内 or 境界から 500m 以内」に入るかを判定。
- **`tools/build-city-layer-tiles.js`**: 全レイヤーで「24区と重ならない feature」を除外
  （roads 28523→18767 / parks 3393→2685 / railways 3494→3187 / **waterways 800→562**、計 11009 件除外）。
  巨大 area で fraction<0.25 かつ bboxDiag>3500m のものも除外（猪名川河口デルタ等）。
  `--force` で旧 tile を削除してから再生成（stale tile を残さない）。
- **SOURCE 追跡**: `tools/lib/osm-multipolygon.js` の `stitchWays` / `assembleMultipolygon` が
  member way id を追跡（`ringWayIds` / `polygons[].memberWayIds`）。inner→outer は representative point
  （重心が凹で外れる場合はスキャンライン内点）で最小内包 outer へ割当。`tools/convert/waterways.js` は
  feature へ `source:{type, id, name, memberWayIds, relationOuterWayCount, relationOuterRingCount}` を付与。
  tile feature にも `source:{type,id,name,memberWayIds}` を伝播（feature id は幾何ハッシュのまま不変）。
- **`tools/lib/water-semantic-validator.js`（新規）**: outer 最大辺>1000m / 最大辺÷中央値辺>20 → WARN、
  退化・非有限 → ERROR、relation の outerWayCount≥3→1ring かつ巨大bbox → WARN（誤連結の疑い）。
  `validate/city-layer-tiles.js` に統合（実データ: **ERROR 0 / WARN 26**、いずれも OSM 側の疎ノード）。
- **`tools/audit/water-source.js`（新規）**: 水域 feature を OSM way/relation まで遡り、bbox・area・
  最大辺・member way・24区 overlap を top20 で出力 → `data/reports/water-source-audit.json`。
- **`public/osaka_3d_buildings.ward-ux-v1.html`（dev target のみ）**:
  - `[WATER-DRAW-DEBUG]` に `sourceType` / `sourceId` / `sourceName` を追加。
  - `pfValidate` しきい値緩和（dominant 0.7→0.85、centroid-outside は割合ベース）で細く蛇行する
    実河川を誤拒否しない。
  - **LRU dedup 不具合の修正**: `renderTileMeshes` / `reconcileLayer` / `rec.ownedIds` / `rec.allFeats`。
    複数 tile にまたがる大きな feature が「所有 tile の LRU 破棄」で永久に消えていた問題を、
    破棄時に所有 id を dedup Set から外し、生きている tile で描き直すことで解消。
  - material（FrontSide / opacity 0.5 / depthWrite:false）は維持（P1-6E。河川修正の本体ではない）。

### 異常 feature 3件（directive #8）
| normalized id | source OSM | relation member 構造 | 壊れ方 | 対処 |
|---|---|---|---|---|
| `water_c300d13a0becc1` | **relation/16551409** | 3 outer way (1217959832 / 1217959829 / 982204929) → 1 ring、inner 0 | 壊れていない（有効な閉ポリゴン）。**24区外**（猪名川、尼崎市）。7.8km×2km | ward filter で除外 |
| （旧 top）`relation/8445877` | 7 outer way → 1 ring | 同上。24区 overlap 12%。5.2km | analyzeRing 巨大辺 ＋ ward filter で除外 |
| `water_9affcb5dd679f2` | **relation/18530063** | 3 outer way (46039404 / 984873894 / 1490469648) → 1 ring | 壊れていない。**大和川西端**（住之江/住吉、60/60 が区内）。実在の 5km 河道。maxEdge 1430m（OSM の疎ノード）→ semantic validator が WARN | 保持（正しいデータ）。WARN で可視化 |

implicit closure: **全 water relation で 0 件**（stitchWays は座標一致でのみ連結、未連結は unclosed へ隔離）。
複数 outer: **1本へ連結していない**（独立 outer は別ポリゴン。member way は共有端点で正しく連結）。

### 再生成後（実データ）
- waterways: featureCount **800 → 562**、tile 119 → 95。bbox diag > 7000m の area feature **0件**（旧 8065m は除外）。
- `city-layer-tiles.js` RESULT: **PASS**（water geometry PASS / water semantic ERROR 0）。
- `npm test`: **315 / 300 pass / 0 fail / 15 skip**（+12）。`git diff --check` クリーン。production・fullward-v3 不変。

### テスト
- `tests/polygon-fill.test.js`（11、earcut ベンダリング後）、`tests/water-source-p16f.test.js`（8）:
  stitchWays の member way id / **独立 outer を連結しない** / convert の source metadata / **rel 16551409 の
  ward overlap 0 → 除外** / 大和川は保持 / semantic validator / densify（頂点位置不変）/ 実データ regression。
- `tests/ward-ux-v1-p16f.test.js`（5）: WATER-DRAW-DEBUG に sourceId / LRU dedup 修正の配線 / しきい値 / fullward-v3 不変。

### 実機で再確認する項目（ブラウザ）
1. `window.__WATER_DRAW_DEBUG__=true` で `[WATER-DRAW-DEBUG]` を確認 — `ok:false` の feature が無いか、
   巨大 feature の `sourceType`/`sourceId` を報告。
2. 左上（北西）の 7.8km 楔形が消えたか（rel 16551409 除外）。
3. 淀川・大和川・神崎川が実河道幅で、branch が自然につながるか。中州（神崎川 rel 8421377 の inner×2）保持。
4. 20回連続で区切替 → 大きな河川 feature が消えないか（reconcileLayer）、mesh リーク無いか。

---

## 2026-09-03 セッション6F: P1-6E 実機描画修正（河川巨大面ガード / 建物・都市レイヤーの表示範囲整合）

PBF 実データを実ブラウザ表示 → validator は PASS だが「巨大な水色polygon/帯が画面を横断」「建物は Ward の
一部だけ・道路等は広範囲」。

### 巨大水面の診断（earcut 自体は正常だった）
`tools/lib/earcut.js`（mapbox/earcut v2.2.4 をベンダリング。THREE r128 の ShapeUtils.triangulateShape と同一）で
実 tile の水域 area フィーチャ 450 件を分割 → **triArea/polyArea = 1.000（全件）**。earcut に不具合は無い。
巨大に見えていたのは:
- `water_c300d13a0becc1`（名称なし・神崎川系）306頂点 / bbox **1982×7818m** / 面積 1.49km² … 実在の大河川ポリゴン
- `water_9affcb5dd679f2` 59頂点 / 5238×2748m、`water_54adc0e743493c` 76頂点 / 4806×1425m … 同上
これらを **DoubleSide・opacity 0.85 の平面フィル**で塗っていたため、数km級の不透明シートが画面を覆っていた。
加えて `areaMesh` は入力リングの重複頂点・巻き方向・outer 外 hole を正規化せず、分割結果も一切検証していなかった
ため、将来の壊れた assemble 結果（自己交差・退化）がそのまま巨大メッシュになる状態だった。

### 修正
- **`tools/lib/earcut.js`（新規・ベンダリング）** … Node テストと HTML で同一の三角形分割結果を得るため。
- **`tools/lib/polygon-fill.js`（新規・純粋）** … `cleanRingXZ`（重複/非有限除去）/ `ensureWindingXZ`（outer→CCW,
  hole→CW）/ `prepareFill`（outer 外 hole を破棄）/ `validateFillXZ`（triArea/polyArea 比・1枚支配率・
  三角形重心の outer 内 & hole 外）/ `buildFillPositions`。**line フィーチャは面フィルへ流さない**ガード。
  実機の大河川は「拒否されない・area 比 ≈ 1」を regression テスト（`tools/lib/__fixtures__/water-fill/offenders.json`）。
- **`tools/lib/ward-tile-coverage.js`（新規・純粋）** … `tilesCoveringBboxXZ`（bbox → tile、中心→外の順、cap）。
- **`public/osaka_3d_buildings.ward-ux-v1.html`（dev target のみ。fullward-v3 / production は不変）**:
  - `CityTileLayer.areaMesh` … pfPrepare + THREE.ShapeUtils.triangulateShape + pfValidate。NG は描画拒否し
    `[WATER-DRAW-DEBUG]`（featureId / outerPointCount / holeCount / bbox / triangleCount / areaRatio / maxTriEdge /
    tileId / ok / reason）を出力。material を **FrontSide・opacity 0.5・depthWrite:false・polygonOffset** へ。
    `MAX_AREA_FEATURE_DIAG=12000` を超える面は assemble 異常として描画しない（H の防御ガード。実データは最大 8065）。
  - 表示範囲整合 … `wardTilesForBboxXZ`（共通）＋ `BuildingTileLayer.loadDatasetBbox(datasetId, bbox)` ＋
    `CityTileLayer.coverBbox(bbox)`。`getWardCameraTarget` が **bbox も返す**ようにし、`switchWard`(stream) と
    `flyToWardCentroid` から両レイヤーへ「区の bbox 全域」を中心→外の順で段階ロード。
    `CityTileLayer.MAX_TILES_PER_LAYER` 40→64（区1つ分の tile を LRU 退避させない）。
  - `[BUILDING-DRAW-DEBUG]` … `loadDatasetBbox` の要求/発行 tile 数、`BuildingTileLayer.getDrawDebug()`
    （currentWard / cameraX,Z / enabledDatasets / loadedTiles / visibleTiles / visibleBuildings）。
    `window.__WATER_DRAW_DEBUG__` / `window.__BUILDING_DRAW_DEBUG__` でゲート。

### テスト
- `tests/polygon-fill.test.js`（11）: cleanRing / winding / prepareFill / 凹リバーバンク / 細長い河川 /
  multipolygon+hole 重心 / bowtie 拒否 / line 除外 / 退化拒否 / **実機大河川 regression（拒否されない）**。
- `tests/ward-tile-coverage.test.js`（6）: bbox 網羅 / 中心→外 / cap / buffer / 不正入力 / 実データ各区。
- `tests/ward-ux-v1-p16e.test.js`（8）: areaMesh ガード / water material / DRAW-DEBUG / bbox カバー配線 /
  MAX_TILES / レイヤー定義不変 / **fullward-v3 不変** / インライン `<script>` の JS 構文チェック。
- `npm test`: **303 / 288 pass / 0 fail / 15 skip**。`git diff --check` クリーン。production・fullward-v3 HTML 不変。

### 実機で再確認する項目（ブラウザ）
1. `window.__WATER_DRAW_DEBUG__=true` で `[WATER-DRAW-DEBUG]` を見て、`ok:false` の feature が無いか（あれば id と reason）。
2. 大河川（神崎川・大和川・淀川）が半透明の水面として見え、画面全体を覆う不透明シートが消えたか。
3. 区を選択 → `BuildingTileLayer.getDrawDebug()` の `visibleTiles` が区 bbox 相当まで増えるか、
   建物と道路/公園/水域の表示範囲が概ね揃うか（`[BUILDING-DRAW-DEBUG]` の requestedTiles/issued）。
4. 20回連続で区を切り替えて mesh/geometry リークが無いか（renderer.info）。
5. 修正前後の firstRenderMs / Ward 切替時間（`[WARD-PERF]` `[LAYER-PERF]`）。

---

## 2026-09-02 セッション6E: P1-6D PBF parser 実接続修正（readable-stream v2 は for await 不可）

ローカル PC で実 PBF import を実行 → `TypeError: stream is not async iterable`。

### 原因
`osm-pbf-parser` が `pipe` で返すのは `stream-combiner2` → **`readable-stream@2`** ベースのストリームで、
`Symbol.asyncIterator` を持たない。`for await (const x of stream)` が不可。

### 修正（`tools/lib/osm-pbf-stream.js` のみ。import 側 IF は不変）
- **`objectStreamToPrimitives(parsed, source, start)`（新規 export）**: `'data'`/`'end'`/`'close'`/`'error'` を
  手動購読し、backpressure（`queue >= 64` で `pause()`、`<= 16` で `resume()`）付きで async generator へ橋渡し。
  - チャンクが「要素配列」でも「単一 object」でも安全に展開（`Array.isArray` 判定）
  - `parsed` / `source` どちらの `'error'` も generator 側へ throw
  - 正常終了・例外・early return いずれでも listener 除去 + stream destroy
  - listener 装着 **後** に `source.pipe(parser)`（`'data'` 取りこぼし防止）
- `loadParser()`: dynamic import 時の `mod.default` 剥がしを堅牢化（CommonJS default export）。
- osm-pbf-parser 実測で確認: 1 チャンク = 要素配列 / way は `refs`（delta 復号済み）/ relation member は
  `{type, id, role}`（`ref` ではなく `id`）→ `normalizePrimitive` は `m.ref ?? m.id` で吸収済み。

### `tools/import/osm-pbf-city.js`: `--smoke` / `--smoke-limit` 追加
抽出せず PBF を1回流し、node/way/relation が読めるか確認して exit。全 import の前の疎通確認用。

### テスト（`tests/osm-pbf.test.js` 11 → 18、`tests/helpers/osm-pbf-fixture.js` 新規）
- adapter: 配列チャンク展開 / 単一 object 展開 / parser error propagation / source error propagation /
  空ストリーム正常終了 / 400 バッチ backpressure で hang しない
- **実 parser end-to-end**: `osm-pbf-parser` 同梱 .proto で合成 `.osm.pbf`（dense nodes + ways +
  riverbank relation）を組み立て、`pbfPrimitiveStream` で読んで `importOsmPbfCity` → `convertLayer` まで通す。
  パッケージ未インストール時は自動 skip（`hasOsmPbfParser()`）。
- `npm test`: **278 / 263 pass / 0 fail / 15 skip**。`git diff --check` クリーン、`fullward-v3.html` 未変更。

### ローカル PC で再実行するコマンド（`data/raw/osm/osaka-latest.osm.pbf` = 49,693,967 bytes）
```bash
npm install    # osm-pbf-parser（済んでいれば不要）

# 1) 疎通確認（node/way/relation が読めるか。全ブロック解凍のため数十秒〜）
node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-latest.osm.pbf --area osaka-city --smoke

# 2) 抽出（3-pass。roads だけで試すなら --layer roads）
node tools/import/osm-pbf-city.js --input data/raw/osm/osaka-latest.osm.pbf --area osaka-city --layer all

# 3) タイル化 → 検証（P1-6 と共通）
node tools/build-city-layer-tiles.js --layer all --area osaka-city --public --force
node tools/validate/city-layer-tiles.js --area osaka-city
```

---

## 2026-09-02 セッション6D: P1-6B 公開 Overpass 一括取得を廃止し OSM PBF ローカル import へ

624リクエスト規模の公開 Overpass 依存（overpass-api.de: network failure/504、kumi.systems: 502 が継続）を
**本番の都市一括生成として採用しない**と決定。大阪周辺の OSM extract（.osm.pbf）を一度取得し、ローカルで
roads / waterways / parks / railways / stations を抽出して既存パイプラインへ渡す方式へ移行。

### 採用 PBF parser / 依存
- **`osm-pbf-parser`（npm、pure JS・stream）** を `dependencies` に追加（`^2.3.0`）。このリポジトリ初の実行時依存。
- **`tools/lib/osm-pbf-stream.js`（新規）**: parser の唯一の利用箇所。依存は **動的 import で遅延読み込み**するため、
  パッケージ未インストールでも他モジュールの読み込み・`npm test` に影響しない。`normalizePrimitive()` で
  osm-pbf-parser の item 形状の揺れ（id が string、refs/nodes、lat/latitude）を吸収。
- CLAUDE.md の「外部パッケージ依存ゼロ」記述を更新。

### `tools/import/osm-pbf-city.js`（新規）
`.osm.pbf ─▶ data/raw/osaka-city/<layer>-osm.json ─▶ (既存) build-city-layer-tiles.js ─▶ public/map-data/`
- 抽出 / relation 組み立て / 幾何解決 / bbox 判定は**すべて純粋関数**（osm-pbf-parser 非依存）。
- PBF を **3-pass ストリーム**: relations（対象 relation・member way id 収集）→ ways（レイヤー該当 way ＋
  relation member way の node 参照収集）→ nodes（必要 node 座標 ＋ station node）。メモリは使用地物ぶんに有界。
- タグ判定は `config/areas/osaka-city.json` の `osmFilter` と一致（Overpass 版とスキーマ互換）。
- relation multipolygon は member way 解決後 `osm-multipolygon.js` の assemble（P1-6 と同一）。outer way 単独面化なし・
  inner holes 保持・未連結 relation 除外。
- 大阪市 bbox + `--buffer`（既定 1000m）外の feature は除外。station は point feature として `railways` へ。
- 出力は Overpass `out geom` 互換 → `build-city-layer-tiles.js` 以降は生成元を問わず完全に同一。
- レポート `data/reports/osm-pbf-import.json`（PBF size / pass別 parse time / peak RSS / feature数）。`--help` 実装。
- `npm run data:import:osm-pbf`。

### Overpass 版の位置付け
`tools/download/city-tiles.js` / `overpass-failover.js` は**削除しない**。小規模差分・特定タイル検証・緊急取得用。

### テスト（`tests/osm-pbf.test.js` 新規・11件、実ネットワーク&パッケージ不要）
合成 OSM primitive ストリームを注入し、roads 抽出 / bbox 除外（東京の道路・名古屋の駅）/ riverbank relation の
outer 連結＋中州 holes（build 後に area+hole）/ park・rail line・station 分離 / 重複防止 / `--layer` 単体 /
`normalizePrimitive` の揺れ吸収 / 純粋ヘルパ / **end-to-end（import → build-city-layer-tiles → validateCityLayer が
error なし）** / `--help`。

- `npm test`: **271 / 256 pass / 0 fail / 15 skip**（+11）。html-regression 15/15、`git diff --check` クリーン、
  `fullward-v3.html` 未変更。
- 実 PBF での取得数・tile 数・性能はローカル PC 実行後に報告（RUNBOOK「A. OSM PBF ローカル import」）。

---

## 2026-09-02 セッション6C: P1-6 Overpass 実取得失敗の原因調査

実機で道路tileが大量失敗（overpass-api.de: network fetch failed / kumi.systems: HTTP 500 / 連続150回以上）。
**failover を増やす前に query を検証**した結果、**query 自体は正常**（失敗はサーバー/ネットワーク側）。診断手段を追加。

### tile -1_-5 の実クエリ（`--print-query` で検証、ネットワーク不要）
```
local bounds (znorth-neg-v1): {minX:-2000, maxX:0, minZ:-10000, maxZ:-8000}
WGS84 bbox: south 34.6747254 / west 135.5015553 / north 34.6953866 / east 135.5266571  ← order OK・大阪市域内
query (163 bytes):
  [out:json][timeout:90];
  (
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"](34.6747254,135.5015553,34.6953866,135.5266571);
  );
  out geom;
```
recursive expansion `(._;>;)` なし・`out geom;` のみ・163 bytes。**znorth-neg-v1 の local 値を bbox へ渡していない**
（inverse projection で WGS84 へ変換済み）。全156タイルの bbox が finite・正順・大阪市周辺・巨大でないことをテスト。

### 追加した診断・安全機構（`tools/download/city-tiles.js` + `tools/lib/overpass-failover.js`）
| # | 内容 |
|---|---|
| `--print-query` / `--dry-run` | ネットワークなしで tile / WGS84 bbox / bbox順序 / query全文 / bytes / filters / recursive expansion / out mode を表示して exit 0 |
| `--smoke` | 全タイル前に「未取得の先頭1タイルだけ」取得。成功しなければ全取得へ進まない |
| `--abort-after <n>`（既定5） | 連続 n タイル失敗 かつ 成功 0 件で **全156タイルを回さず中断**（`[abort]`。サーバー障害中に churn しない） |
| `[error-body]` ログ | HTTP 4xx/5xx / JSON parse 失敗時に Overpass 応答の先頭〜1000字を出力（rate limit / IP block / runtime error の理由が読める）。body は1回だけ読む実装 |
| HTTP timeout 分離 | HTTP(AbortController) timeout = QL `[timeout:N]` + 30s。`[fetch]` ログに両方表示。AbortController が先に切れない |
| request body | `application/x-www-form-urlencoded` + `data=`（raw text/plain より広く互換）。`Accept: application/json` + 説明的 User-Agent |
| failure counter | `consecutiveFailures` は成功で 0 reset（既存）。tile 失敗と endpoint health を分離（downloadLayer の `consecutiveFail` は tile 単位） |

### テスト（`tests/overpass-failover.test.js` +8 = 19、実ネットワーク不使用）
local→WGS84 bbox 順序 / 全156タイル finite・大阪周辺・非巨大 / local値を bbox に渡していない / roads query snapshot /
HTTP timeout > QL timeout / HTTP 500 body logging / `--smoke` 1タイル / `--abort-after` 中断。

- `npm test`: **260 / 245 pass / 0 fail / 15 skip**。html-regression 15/15、`git diff --check` クリーン、`fullward-v3.html` 未変更。

RUNBOOK に診断フロー（§0 取得前診断・§1 smoke → abort）を追記。

---

## 2026-09-02 セッション6B: P1-6 Overpass 取得安定化（複数 endpoint failover）

実データ取得で `overpass.kumi.systems` が HTTP 500/502/timeout を繰り返したため、取得の堅牢化。

- **`tools/lib/overpass-failover.js`（新規）**: `createOverpassClient({ endpoints, fetchImpl, ... })`。
  - endpoint 配列管理（既定 `overpass-api.de` + `overpass.kumi.systems`）。
  - **429/500/502/503/504/timeout/network では同一 endpoint で粘らず即別 endpoint へ**（1周＝各endpoint 1試行、
    全滅で指数バックオフしてもう1周、最大4周）。4xx は failover せず即エラー。
  - endpoint health: 連続失敗数で並べ替え、**連続3回失敗で 60〜180秒 cooldown**（健全 endpoint 優先）。
  - 429 `Retry-After` 尊重。request 間隔（グローバル 1.2s / 同一endpoint 2.5s）。
  - `fetchImpl` / `sleepImpl` / `now` 注入可能 → 実ネットワーク無しでテスト。
- **`tools/download/city-tiles.js`（変更）**:
  - `--endpoint <url>`（複数可）、`--help` / `-h`（**usage 表示して即 exit 0、ネットワークアクセスなし**。従来は
    取得処理が始まっていた）。
  - `createOverpassClient` を使用。ログを `[fetch]/[failover]/[retry]/[cooldown]/[cache]/[done]/[summary]`
    （cached / downloaded / failed / endpointFailures）に整理。
  - `tools/lib/overpass.js`（他レイヤーの `download/index.js` が使用）は変更していない。
  - cache/resume は不変: **有効な cache がある tile は絶対に再取得しない。失敗 tile のみ resume**。
- **`tests/overpass-failover.test.js`（新規、11）**: A 502→B成功 / A timeout→B成功 / 429 Retry-After /
  全endpoint失敗→throw / cooldown 60〜180秒 / 健全endpoint優先 / 4xx即エラー / cache済みは fetch しない /
  resume（失敗tileのみ）/ --help はネットワーク無し / buildTileQuery。
- `npm test`: **252 / 237 pass / 0 fail / 15 skip**。html-regression 15/15、`git diff --check` クリーン、
  `fullward-v3.html` 未変更。

RUNBOOK に `--endpoint` / failover / `--help` を追記。

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
