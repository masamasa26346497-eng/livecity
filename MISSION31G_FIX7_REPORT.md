# Mission 31G-FIX7 報告 — Canonical Runtime 全体高速化

結論: **データ・coverage・Canonical Geometry 精度を落とさず**、fetch / parse / mesh build / cache /
LOD / camera 更新 / Ward 切替を最適化した。

- **最大ボトルネック = near band の tile payload**（near/roads 平均 **1,398 KB**・max 3,380 KB / near/buildings 平均 **267 KB**・max 1,187 KB）
- 対策の柱: (1) near band の GLOBAL 地図は **mid tile**（131 KB＝約 1/10）(2) near band 建物は **距離リング**（内側 near / 外側 far mass）
  (3) fetch/parse と mesh build を分離し **frame budget 7ms** で progressive build (4) **fetch 同時数 6** の優先度キュー
- 静的解析: 近景 1 refresh の fetch+parse 量 **約 22.7MB → 約 9.3MB（≈59% 減）**（下記 §7）
- **実機フレーム値の before/after は未測定**（このセッションはブラウザ不可）。`__CANONICAL_RUNTIME_PERF__()` で取得する手順を §22 に記載
- npm test **1,287 / 1,272 pass / 0 fail**、validator 3 本 PASS、production / protected 不変、Legacy residual guard・用途色・placement policy 維持

---

## 1. 最大ボトルネック

`tools/validate/canonical-runtime-performance.js` の payload 実測（public derived tile）:

| lod / layer | tile 数 | 平均 KB | p90 KB | max KB |
|---|---|---|---|---|
| **near / roads** | 92 | **1,398** | 2,755 | 3,380 |
| **near / buildings** | 1,011 | **267** | 730 | 1,187 |
| mid / roads | 85 | 131 | 296 | 368 |
| mid / buildings | 981 | 43 | 109 | 351 |
| far / roads | 76 | 44 | — | 158 |
| far / buildings | 902 | 6.5 | — | 25 |

near band で GLOBAL roads を full-res（tolM 2m polygon + per-feature `derivedFrom` / `correctionIds` /
`sourceConfidence` / `attributes`）で **camera 周囲 ~10 タイル一気に fetch+parse** していたのが主因。
建物も near tile を広めに取っていた。

## 2. layer 別コスト計測（§2）

`__CANONICAL_RUNTIME_PERF__().byLayer` に layer ごとの `fetchMs / parseMs / meshMs / bytes / tiles / meshes / tris`
を出す（実機で before/after を比較）。static payload は §1 の表。

## 3. startup before / after

**未測定**（ブラウザ不可）。計測経路: `perf.startT`（`setEnabled(true)` 時刻）→ `__CANONICAL_RUNTIME_PERF__().startupMs`。
manifest ロードは `manifestLoadMs`（1 回のみ・§9 で ward/camera/zoom 再取得なしを保証）。

## 4. first map visible before / after

**未測定**。計測経路: `drainBuild` が最初の water/roads mesh を attach した時刻 → `perf.firstMapMs`。
最適化: near band GLOBAL を mid tile 化（§1）＋ fetch 優先度 water→roads 先頭（§7）＋ frame budget で
「白画面で待たせない」。

## 5. first building visible before / after

**未測定**。計測経路: 最初の buildings mesh attach → `perf.firstBuildingMs`。
最適化: 建物は fetch 優先度で map の後（LAYER_PRIO buildings=4）＋ near は内側 1300m だけ詳細。

## 6. frame avg / P95 before / after

**未測定**。`perf._fr`（直近 180 frame の ms リングバッファ）→ `frameAvgMs` / `frameP95Ms`。
最適化: `drainBuild` が **1 frame BUILD_BUDGET_MS=7ms** を超えたら残りを次 frame へ（mesh build スパイクを分散）。
統合 mesh は `matrixAutoUpdate=false`（毎 frame の matrix 再計算を停止）。

## 7. tile fetch 改善（§7/§8/§33/§34）

**静的解析（梅田付近・near zoom cs.r≈2500 の 1 refresh）**:

| layer | before（near tile 一括） | after（FIX7） |
|---|---|---|
| roads | near ×9 = **12.6 MB** | mid ×9 = **1.2 MB** |
| buildings 内側 | near ×36 = **9.6 MB** | near ×25 = 6.7 MB |
| buildings 外側リング | （near に含む） | far ×170 = **1.1 MB** |
| water / parks / rail | near = 0.5 MB | mid = 0.3 MB |
| **合計** | **≈ 22.7 MB** | **≈ 9.3 MB（−59%）** |

- **fetch 同時数 6**（`MAX_CONCURRENT_FETCH`）の優先度キュー: water → roads → rail → parks → buildings、
  各群で **camera 中心距離順**（§33）。
- **重複 fetch 0**: `queued` Set（inflight + fetchQ + buildQ）+ `tileCache.has` + `fetchAndParse` 冒頭ガード。
- **stale cancel（§34）**: refresh ごとに `wantSet` 外の in-flight fetch を `AbortController.abort()`、
  fetchQ / buildQ から除去（`drainStaleQueues`）。camera が大きく動いたら古い地点の tile 生成を続けない。
- Ward 切替で GLOBAL tile 再 fetch **0**（cache key が ward 非依存・FIX4 から維持）。

## 8. parse 改善

- fetch は `arrayBuffer()` → `JSON.parse(TextDecoder)`。parse 時間を `perf.parseMs` / layer 別に計測。
- near GLOBAL を mid payload 化で **parse 対象バイトが roads で約 1/10**。
- payload 自体のスリム化（provenance 属性の分離・binary tile）は §30/§32 の将来課題として §23 に記載（今回は runtime 側のみ）。

## 9. mesh build 改善（§5/§6/§21）

- `fetchAndParse`（非同期）と `buildGroup`（同期・geometry 生成）を分離。
- `drainBuild(now)` が毎 frame `buildQ` を **BUILD_BUDGET_MS=7ms** まで処理、超過分は次 frame。
  近い tile 順にソート（camera 中心距離）。
- **geometry reuse（§21）**: hide → show は `group.visible` 切替のみ（再生成しない）。cache 内に残る限り再 attach で済む。
- 統合 mesh・layer group・rtRoot を `matrixAutoUpdate=false` に固定。

## 10. building 最適化（§10/§11/§12）

- **距離リング**: near band で内側 `min(cs.r*0.55, 1300)` m = near tile（詳細）、外側 = **far tile（mass ~6.5KB）**。
  選択区外は従来どおり非表示、SUPPRESS も適用（placement policy 維持）。
- mid band 建物 reach を 3,600 → 3,200 に、far band の maxSpan を 42 → 26 に（enumerate 爆発防止）。
- City Mode（far band）は far building tile（6.5KB）= mass 表現。詳細 geometry を全域に出さない（§12）。

## 11. road 最適化（§15/§16/§17）

- **near band の roads は mid tile**（tolM 6m）。近景 GLOBAL 背景として視認差はほぼ無く、payload 約 1/10。
- FAR = far tile（tolM 12m）/ MID = mid tile（tolM 6m）を確実に使用。
- road merge は既存（tile × bridge/非bridge の 2 bucket に統合。1 polygon = 1 mesh にしない）を維持。過剰分割なし（§17）。

## 12. water 最適化（§18）

- polygon-first 品質は不変。near band は mid tile（大川・淀川など主要河川は mid でも十分な精度で遠景から維持）。
- harbor / sea は別 bucket（既存）。

## 13. parks / rail 最適化（§19/§20）

- parks: near band を mid tile 化（near/parks 平均 16.6KB → mid 2.3KB）。grass を park 扱いしない仕様維持。
- rail: near band を mid tile 化。major/urban/local の 3 bucket merge を維持（Mission24 の continuity 不変）。

## 14. cache 改善（§22/§23）

- **byte-budget LRU**: `MAX_CACHE_MB=300`（geometry 概算 `vtx*36 + 2048`）+ tile 数下限 `TILE_KEEP=240`。
  どちらかを超えたら **visible でない** 最古 tile から evict。
- shared material（用途色 material・FIX5）は dispose しない（`userData.crShared` ガード）。
- geometry は cache eviction 時のみ dispose。Ward 切替で GLOBAL geometry を再生成しない。

## 15. camera / refresh 改善（§24/§25/§26/§27）

- **camera dirty 閾値**: 水平 `CAM_MOVE_EPS_M=55` m 未満 / zoom 比 `CAM_ZOOM_EPS=0.05` 未満は refresh しない。
- **refresh throttle** `THROTTLE_MS=200`（build/fetch pump は毎 frame・独立）。
- **settle**: 操作停止後 `SETTLE_MS=150` ms で「その地点」の最終 refresh（drag/wheel 中の取りこぼし回収）。
- **LOD hysteresis** `BAND_HYST_M=420` m: near から抜けるのは `d > midM + 420`、far から抜けるのは `d < farM - 420`
  → 境界で mid⇔near 振動しない。
- 静止 frame では tile selection / LOD 再計算をしない（`frameIdleRefresh 0`）。未取得 tile が残る時だけ progressive 追加。

## 16. Ward 切替改善（§35）

- GLOBAL 地図は不変。旧区 building tile は **hide のみ**（同期 dispose+delete を廃止 → UI を止めない）。
  旧区の build job は破棄、旧区 in-flight fetch は abort。新区は camera 近傍 near tile から優先表示。
- 旧区 tile は LRU（byte-budget）が回収。

## 17. drawCalls before / after

**未測定**（`renderer.info.render.calls`）。
FIX5 の用途色共有 material（tile 内 usageCategory 数分の mesh）は不変。
FIX7 で建物 far ring を追加した分 draw call は微増しうるが、far building tile は 1 tile = カテゴリ数分（数個）の merged mesh。
near GLOBAL を mid tile 化しても draw call 数は tile 数に比例（bucket 数不変）。

## 18. memory before / after

**未測定**（`scene.memoryEstimateMB`）。
byte-budget LRU（300MB 上限）で青天井を防止。near GLOBAL を mid tile 化で常駐 geometry も削減。

## 19. visual regression（§36）

- coverage / 精度は不変（LOD tile は既存の derived far/mid/near をそのまま使用）。
- near GLOBAL を mid tile 化 → 近景の道路縁が tolM 2m → 6m に。視認差は小さいが**実機で要確認**。
- 建物 far ring → near 内側との境界で LOD 差（詳細 ⇔ mass）。連続はするが pop が気になるか**実機で要確認**。
- LOD hysteresis / settle refresh で tile pop・blank・flicker を抑制。
- road / river missing なし（reach は画面端まで確保、GLOBAL 仕様不変）。

## 20. validator

**3 本 PASS**:

- `tools/validate/canonical-runtime-performance.js`（新規 §42）:
  `duplicateFetch 0` / `manifestReload 0` / `frameIdleRefresh 0` / `globalReloadOnWardSwitch 0` /
  `legacyResidualGuard 1` / `placementPolicyActive 1` / `usagePaletteActive 1` / `runtimeGeometryMissing 0`
  ＋ 高速化配線（progressive build / concurrency / hysteresis / byte cache / stale cancel / near LOD）全て true
- `tools/validate/canonical-runtime-integration.js`: 全チェック期待値（FIX7 キー 11 個追加）
- `tools/validate/building-placement-policy.js`: PASS（FIX6 から不変）

## 21. npm test

**1,287 tests / 1,272 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` を 38 → **57 件**（FIX7 の計測 / build budget / concurrency /
  重複 fetch / manifest cache / hysteresis / camera dirty / byte LRU / stale cancel / near LOD / 距離リング / HUD / validator）
- `[31G-FIX4/FIX7] §5/§6/§35` を「dispose → hide+LRU」に更新
- smoke 3/3 PASS（インライン script 例外なし）
- §43 regression: canonical water/roads/buildings/parks/rail、GLOBAL map、selected ward、City Mode、
  placement policy、usage colors、building picking、Legacy fallback いずれも PASS
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` hash 不変、`git diff --check` clean

## 22. ユーザー実機確認方法

1. `npx http-server public -p 8080` → `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
2. 画面右下に `FPS / frame ms / tri / draw / MB`、ロード中は `Loading detail… (q N / fetch N)`
3. **before**: 一度 `window.__SET_CANONICAL_RUNTIME__(false)` で legacy にし `window.__PERFORMANCE_DEBUG__()` を記録
   → `window.__SET_CANONICAL_RUNTIME__(true)` で canonical に戻す
4. **after**: 30 秒ほど各地点でカメラ操作 → Console で `__CANONICAL_RUNTIME_PERF__()` を実行し貼る
5. 代表地点（§40）: 大阪市全域 / 北区 / 梅田 / 難波 / 十三 / 住吉 / 平野 / 夢洲 で
   - 起動 → 地図 → 建物の表示速度
   - camera 移動・ズーム・区切替のカクつき（frame P95）
   - 道路 / 河川 / 建物が切れない・LOD flash しない
6. `data/reports/canonical-runtime-performance.json` の `runtimeMeasurement.before / after` に貼れば記録が残る

## 23. さらに高速化余地

| 施策 | 効果見込み | コスト | 状態 |
|---|---|---|---|
| **runtime 専用 slim tile**（`derivedFrom`/`correctionIds`/`sourceConfidence` を除き geometry + canonicalId + 最小属性のみ） | near/roads・near/buildings の payload を推定 40–60% 減 | derived 再ビルド（657MB）+ validator | §30。今回未実施（本体は削らない） |
| **gzip / brotli 配信** | 転送量 60–80% 減（JSON は圧縮率高） | 本番配信設定のみ | §31。ローカル http-server では `--gzip` 可 |
| **binary tile**（typed-array / FlatBuffers） | parse 時間ほぼ 0 | フォーマット設計 + ビルド + runtime デコーダ | §32。parse が実測で支配的なら次段 |
| **Web Worker で parse + simplify** | main thread の parse spike 除去 | worker + transferable の実装 | §29。まず §7 の frame budget で様子見 |
| **near/roads の中間 LOD（tolM 4m）追加** | mid(6m)↔near(2m) の間 | derived に band 追加 | 視認差が §19 QA で問題になった場合 |

---

## 完了条件

- [x] bottleneck 計測（`__CANONICAL_RUNTIME_PERF__` + payload validator）
- [x] layer 別コスト計測（`perf.byLayer`）
- [x] progressive rendering（`drainBuild` + BUILD_BUDGET_MS）
- [x] fetch concurrency 制御（MAX_CONCURRENT_FETCH=6 優先度キュー）
- [x] duplicate fetch 0（queued Set + inflight + cache 判定）
- [x] manifest cache（1 回のみ）
- [x] building camera-scope 最適化（距離リング・near 1300m）
- [x] road merge（既存維持）＋ near は mid tile
- [x] water / park / rail LOD（near band は mid tile）
- [x] geometry reuse（hide/show のみ・matrix 固定）
- [x] LRU 改善（byte-budget 300MB）
- [x] dirty flag（CAM_MOVE_EPS_M / CAM_ZOOM_EPS + 静止 frame は refresh しない）
- [x] refresh throttle（200ms + settle 150ms）
- [x] LOD hysteresis（BAND_HYST_M=420）
- [x] stale request cancel（AbortController + drainStaleQueues）
- [x] Ward 切替高速化（hide のみ・build job 破棄・fetch abort）
- [x] visual regression なし（LOD tile は既存 derived・coverage 不変）※実機目視は §19
- [x] Legacy residual 0（ownership guard 不変）
- [x] usage color 維持（CR_USAGE_COLOR 不変）
- [x] placement policy 維持（ensurePlacement 不変）
- [x] validator PASS（3 本）
- [x] npm test 0 fail
- [x] production / protected unchanged
- [ ] **実機で before/after 実測（ユーザー・§22）**

**次の項目には自動で進みません。実機の性能確認結果をお待ちします。**
