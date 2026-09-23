# Mission 31G 報告 — Canonical Runtime Cutover

結論: `ward-ux-v1.html` に **Canonical Runtime**（Derived データを描画へ接続するモジュール）を追加した。
**feature flag `window.__CANONICAL_RUNTIME__` は既定 OFF** で、OFF の間は一切の副作用がなく旧 render がそのまま。
ON にすると water / roads / buildings / parks / rail を Canonical Derived から描画する。
production / protected HTML 不変、旧 render コード温存、npm test 0 fail。

**重要**: ブラウザ実機での目視確認（大川・安治川・交差点・区スコープ等）はこのセッションでは実行できないため、
既定を OFF のままとした。ユーザーが実機で `__SET_CANONICAL_RUNTIME__(true)` により検証し、問題なければ
既定を true にする（1 行の変更）。問題時は `__SET_CANONICAL_RUNTIME__(false)` で即座に旧 render へ戻る（§1/§34）。

---

## 1. 変更ファイル

| ファイル | 変更 |
|---|---|
| `public/osaka_3d_buildings.ward-ux-v1.html` | **+427 行 / -1 行**。CanonicalRuntime モジュール（IIFE）+ loop への `CanonicalRuntime.update()` 1 行 + `pickHit` に canonical 建物 raycast 分岐。旧 render は全て温存。 |
| `tools/build-derived-public.js`（新規） | derived far/mid/near を `public/map-data/osaka-city/derived/` へ配置（runtime が fetch する） |
| `tools/validate/canonical-runtime-integration.js`（新規 §35） | 静的検証 validator |
| `tools/build-derived-geometry.js` | **ultra-near LOD を廃止**（near = 完全＋tolM 2m。ultra-near は near のほぼ複製で容量 2 倍・環境の OneDrive 同期で読取不能になったため） |
| `tools/validate/derived-geometry.js` / `tools/lib/canonical-runtime-adapter.js` | ultra-near 削除に追従 |
| `tests/canonical-runtime-cutover.test.js`（新規） | 10 件 |
| production `osaka_3d_buildings.html` / protected `fullward-v3.html` | **不変**（hash baseline 記録・validator で検証） |

## 2. Canonical Runtime architecture

```
window.__CANONICAL_RUNTIME__ (flag, 既定 false)
  ↓ CanonicalRuntime.update() … loop から毎フレーム（内部 280ms throttle）
  ↓ setEnabled(true): 旧 layer を hide（RoadLayer/RiverLayerV2/ParkLayer/BuildingTileLayer/
                      CityBuildingLOD/CityTileLayer の面レイヤー）→ CR group を scene.add
  ↓ refresh(): camera 距離 → LOD band（far>9000 / mid>3500 / near）
             camera target 周辺の tile 範囲を算出 → 必要 tile を fetch（1 refresh 最大 20 枚）
             → THREE mesh 生成（layer 別 group）→ 不要 tile は hide → LRU で dispose（上限 260 枚）
  ↓ Ward Mode: 建物は attributes.wardId でフィルタ（§11 選択区外を描かない）
             roads/parks は ward bbox でフィルタ / water は全域（河川は区境界のため）
  ↓ picking: pickHit → CanonicalRuntime.pickBuilding(ray) → 交点直下の footprint を特定
           → d オブジェクト合成 → 既存 showPropertyCard / updateLifeTab / flyTo をそのまま利用
```

- fetch 先: `public/map-data/osaka-city/derived/{far,mid,near}/<layer>/tile_<tx>_<tz>.json`（644 MB / 3,889 files）
- top manifest `derived/manifest.json` に `lodDistanceBands` / `perLayerLod`（startup で軽量 parse）
- 座標系 znorth-neg-v1 不変。projection 定数の再定義なし（validator で確認）

## 3. Water 切替結果（§3）

- 旧 RiverLayerV2（centerline + width ribbon）→ Canonical Derived Water（polygon-first）
- polygon-backed feature は polygon geometry を描画。polygon source が無い水路のみ ribbon fallback（31B のまま）
- LOD: far = 大河川/harbor/sea 22 / mid 164 / near 全 528
- 描画 style: 淡いシアン `0xbcdce6`（既存 model style の川色）、harbor は少し濃い `0x9fc4d2`

## 4. 大川 before / after（§4/§22）

- 旧: RiverLayerV2 ribbon（centerline × 推定幅）
- 新: `cg_water_river_x_water_8f1a2570d2d177` の OSM riverbank polygon（379,549 m²）を直接描画
- `__SET_CANONICAL_RUNTIME__(false/true)` で切替 → 目視比較可能
- **⚠ 実機目視確認は未実施**（このセッションでブラウザ実行不可）。ユーザー確認事項:
  川幅が旧表示より自然か / 建物との位置関係 / 川岸形状 / 橋との関係 / far/mid/near で消えないか

## 5. 安治川 結果（§5）

- 31E correction（港湾 basin 誤統合 2 part 分離）が canonical → derived → runtime へ伝搬
- 安治川本体（1,670,920 m²）＋ 分離 harbor 2 feature（waterClass=harbor で少し濃い色）
- derived feature の `correctionIds` に `corrected-31E:split-multipolygon-parts` を保持（validator で追跡確認）
- **⚠ 実機で河口・harbor・river の形が不自然に一体化していないか要確認**

## 6. Road 切替結果（§6）

- 旧: OSM centerline + ribbon（miter/隙間/団子）→ Canonical Derived Roads（PLATEAU tran polygon-first 99%）
- LOD: far = major 5,030 / mid = major+mid 17,239 / near = 全 199,658（local/alley 含む）
- polygon coverage feature 99.3% / 残り 0.7% のみ ribbon fallback（`sourceConfidence <= 0.8` で識別、debug で `fallbackCounts.roadRibbonSeen`）
- bridge feature は Y を 3.0m 上げて河川 polygon との Z-fighting 回避（§26）

## 7. 交差点 before / after（§7/§23）

- 31C2 で交差点の ribbon 多重重なりは polygon 化で 2,440m² → 0（データ側で実証済み）
- runtime では PLATEAU tran 道路区域 polygon をそのまま面描画 → 交差点は一体面
- 重点地点（御堂筋×中央大通 / 梅田 / 難波 / 天王寺 / 十三 / 阿倍野）は **実機目視確認が必要**

## 8. 道路表示 style（§8）

- road surface: `msBlend(0x848a92, 0x9aa0a6, 0.55)` ＝ 既存の light gray（模型スタイルの道路色寄せと同じ式）
- geometry と style は分離（derived は色を持たない。runtime が palette を当てる）

## 9. Buildings 切替結果（§9）

- Canonical Buildings（PLATEAU 574,112 + OSM fallback 41,505 = 615,617）を near LOD で全数、mid で 73,234、far で 17,776（major）
- footprint を `attributes.heightM` で押し出し（ExtrudeGeometry、DoubleSide）
- 色: `presetWallColor(attributes.usage)`（既存関数をそのまま利用 → 用途別クリスタルパレット → 模型白へブレンド）
- camera loading / LOD / tile cache は CanonicalRuntime 内に独自実装（既存 BuildingTileLayer とは別系統。旧は hide）

## 10. fallback 建物色 結果（§10）

- `attributes.source === 'osm-fallback'` または `usage == null && usageCategory in (null, other)` の建物 →
  `msBlend(白, 0xe6e9e5, 0.45)` の中立色（無色/灰色にしない）
- popup の用途表示は既存 `usageDisplayName(d)`（UN コード表 → usageLabel → normalizedUsage → 「建物（用途不明）」）を利用。
  **null / 'その他(null)' を UI に出さない**（既存ロジック）

## 11. Ward scope 結果（§11/§29）

- Ward Mode: 建物 derived feature を `attributes.wardId === WardModeManager.currentWardId` でフィルタ
- ward 切替時は全 tile を dispose して再ロード（wardId フィルタが変わるため。残留 object 0）
- roads/parks は ward bbox（`WardModeManager.getWardRings()` または `ward-classification-polygons.json` の bbox）でフィルタ
- City Mode / ward 未選択: 全域表示
- **以前ユーザーが指摘した「選択区外の建物が表示される」は wardId フィルタで構造的に発生しない**

## 12. Parks 結果（§12）

- Canonical Parks（parkClass 分類済み）
- `park / recreation_ground / garden / playground` → 緑 `MS_PARK_GREEN`（opacity 0.9）
- `green_space / sports_ground` → 薄緑（0.78）
- **`grass` → さらに薄い緑（opacity 0.5）**。park 色で自動表示しない（§12）
- LOD: far = 大型公園 33 / mid = 主要 230 / near = 全 2,954（grass 含む）

## 13. Rail 結果（§13）

- Canonical Rail（LineString）。Mission24 continuity 維持（同名路線断片保持）
- FAR = major 1,456 / MID = major+urban 1,870 / NEAR = 全 2,828（local 含む）
- 色: major `0x8f97a3` / urban（地下鉄）`0x8a93c0` / local `0xaab0ba`
- 駅は `rail-stations.json`（別 payload）。駅ラベルは既存 StationLabelLayer をそのまま（§17）

## 14. LOD / tile streaming（§14/§15/§16/§28）

- camera 距離 → band（far > 9000 / mid > 3500 / near）
- tile 範囲は camera target 周辺（buildings は 500m tile で reach 3,200m 上限、enumerate 爆発を span 42 で抑止）
- 1 refresh 最大 20 tile ロード（段階 load。startup で全 manifest 同期 parse しない §28）
- LRU cache 上限 260 tile（超過分は geometry/material dispose）
- ward/band/位置が変わらなければ refresh は即 return（camera dirty 相当）

## 15. feature picking（§17/§18/§19）

- `pickHit(e)` が canonical 有効時に `CanonicalRuntime.pickBuilding(ray)` を先に試行（旧 bMesh は hidden）
- raycast → 交点座標直下の footprint（tile ロード時に ring + attributes を保持）を point-in-polygon で特定
- 合成 `d`: `{ id: canonicalId, usage, normalizedUsage, usageCategory, usageLabel, h, z0:0, dz:h, fp, source, wardId, confidence, __canonical:true }`
- → 既存 `showPropertyCard` / `updateLifeTab` / `updateHighlight` / `flyTo` がそのまま動作（配線不変）
- water/road/park/rail の debug picking は未実装（§19 は将来。今回は building のみ）

## 16. OLD / NEW 切替方法（§21/§22/§23/§34）

ブラウザの devtools console で:

```js
__SET_CANONICAL_RUNTIME__(true)    // Canonical Derived 描画へ
__SET_CANONICAL_RUNTIME__(false)   // 旧 render へ即復帰
__CANONICAL_RUNTIME_DEBUG__()      // enabled / mode / lod / loadedTiles / visible*/vertices / drawCalls / memoryEstimate / fallbackCounts
__CANONICAL_RUNTIME_COMPARE__()    // 旧 __PERFORMANCE_DEBUG__() と canonical debug を並べて比較（§37）
```

- 切替時は旧 layer を `hide()`/`show()` で visible 切替のみ（破壊しない）→ 残留 object 0
- 旧 render コード（RiverLayerV2 / RoadLayer / ParkLayer / BuildingTileLayer / 旧 pickHit の bMesh raycast）は削除していない（validator で確認）

## 17. performance before / after（§27）

`__CANONICAL_RUNTIME_DEBUG__()` で計測できる項目: loadedTiles / visibleBuildings / visibleRoadFeatures /
visibleWaterFeatures / visibleParkFeatures / visibleRailFeatures / vertices / triangles / drawCalls / memoryEstimate。

derived データ量（`derived-geometry-build.json`）:

| LOD | featureCount | vertexCount | tiles（≒ drawCall 上限） |
|---|---|---|---|
| far | 24,317 | ~0.1M | 1,137 |
| mid | 92,737 | ~0.6M | 1,337 |
| near | 821,585 | ~3.8M | 1,400 |

- runtime は camera 周辺のみ load するため、実 draw call/vertex は上記の一部
- **⚠ 実 FPS/frame time の旧 vs 新比較は実機必須**（Mission25 baseline からの regression 許容範囲確認）

## 18. 実機確認地点（§31/§32）— 未実施・ユーザー依頼

梅田 / 中之島 / 大川 / 安治川 / 難波 / 天王寺 / 十三 / 阿倍野 / 住吉 / 東住吉 / 平野 / 夢洲 / 南港
＋ **東淀川区・淀川区**（§32: 31C2 で road geometry source missing 解消 → 道路が正常表示されること）

§33 visual anomaly QA（building in water/road, missing river/road, polygon gap, giant triangle, flicker,
z-fighting, tile seam, wrong LOD switch, stale ward object）も実機確認が必要。

## 19. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

| check | 結果 |
|---|---|
| moduleWired（module / flag / setter / debug / loop / picking 配線） | true |
| oldRenderIntact（RiverLayerV2/RoadLayer/ParkLayer/BuildingTileLayer/旧 pickHit 温存） | true |
| productionUnchanged（hash baseline 一致） | true |
| protectedUnchanged | true |
| derivedPublicPresent（far/mid/near × 5 layer + rail-stations） | true |
| projection / znorth-neg-v1 のハードコード変更なし（CR ブロック内に projection 定数なし） | 確認 |

回帰 validator: canonical-water / canonical-geometry / canonical-parks / canonical-rail / canonical-conflicts /
derived-geometry = 全 PASS。

## 20. npm test

**1,226 tests / 1,211 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- 新規 `tests/canonical-runtime-cutover.test.js` 10 件（feature flag / module 配線 / §34 旧 render 温存 /
  §0 projection 不変 / §11 ward scope / §14 LOD+LRU / §20 debug API / validator PASS / derived public / prod・protected 混入なし）
- smoke `tests/ward-ux-v1-smoke.test.js` 3/3 PASS（モジュール評価停止なし・flag OFF で副作用なし）
- `git diff --check` clean

## 21. ユーザーがブラウザで確認する手順（§20/§39-20）

1. `public/osaka_3d_buildings.ward-ux-v1.html` をローカル HTTP サーバー経由で開く
   （`public/` を document root に。`map-data/osaka-city/derived/` が 644MB あることを確認）
2. devtools console で `__SET_CANONICAL_RUNTIME__(true)` を実行
3. 数秒待つ（tile が段階 load。`__CANONICAL_RUNTIME_DEBUG__()` で `loadedTiles` が増えるのを確認）
4. 確認:
   - **大川**（十三〜天満）へカメラを寄せ、川が polygon（面）で描かれ川幅が自然か
   - **安治川**（此花〜港区）で harbor と river が不自然に一体化していないか
   - 御堂筋×中央大通・梅田・難波の**交差点**が団子状に膨らまないか
   - **東淀川区・淀川区**を Ward Mode で選び、道路が表示されるか（31C2 で解消済み）
   - 区を切り替えて**選択区外の建物が残らない**か
   - 建物クリック → popup が出るか（用途・高さ・底面→頂部）
   - grass（芝生）が公園色で塗られていないか
5. `__CANONICAL_RUNTIME_COMPARE__()` で FPS/drawCalls を旧 render（`__SET_CANONICAL_RUNTIME__(false)`）と比較
6. 問題があれば `__SET_CANONICAL_RUNTIME__(false)` で即復帰し、内容を報告

## 22. 既定を true にする方法

実機確認で問題なければ、`ward-ux-v1.html` 冒頭付近の
`if (typeof window.__CANONICAL_RUNTIME__ === 'undefined') window.__CANONICAL_RUNTIME__ = false;`
を `= true;` に変える（1 行）。旧 render は残るので `false` でいつでも戻せる。

---

## 次工程へ進めるか

**データ・配線は完成**しているが、**ブラウザ実機での目視 QA（§4/§5/§7/§18/§31/§33）は未実施**。
このセッションではブラウザを実行できないため、既定 OFF のまま引き渡す。

- [x] feature flag / OLD-NEW 切替 / 旧 render fallback
- [x] Canonical Water/Roads/Buildings/Parks/Rail runtime（描画コード）
- [x] Derived LOD streaming / tile cache / LRU
- [x] feature picking（building）
- [x] fallback 建物色 / Ward scope（wardId フィルタ）
- [x] canonical-runtime validator PASS / npm test 0 fail / smoke PASS
- [x] production / protected unchanged
- [ ] **大川/安治川/交差点/東淀川・淀川/visual anomaly の実機目視 QA（ユーザー実施）**
- [ ] **performance 実測 regression 確認（ユーザー実施）**
- [ ] 既定 true 化（実機 QA 通過後）

**次工程には自動で進まない。ユーザーの実機確認と指示を待つ。**
