# Mission 31G-FIX3 報告 — Legacy Runtime 再出現を完全停止する

結論: Canonical Runtime 有効中に旧 render object が復活していた原因（**Render Ownership 不在** — 旧 layer の
`updateByCamera` / tile stream / ward switch / startup async load が hide 後に mesh を再生成していた）を
根本修正した。`window.__CANONICAL_OWNS_BASE__` を単一の所有権フラグとし、canonical 所有中は
5 base layer（buildings/roads/water/parks/rail）の legacy update 経路へ**一切入らない**構造にした。
毎フレーム再 hide は撤廃（§1）。self-check は「見つける → ERROR 記録」に変更（§16）。

npm test 1,224 pass / 0 fail、validator PASS、production/protected 不変。新機能追加なし。

---

## 1. legacy 312 件の layer 別内訳

self-check に `classifyLegacyResidual()` を追加（§2。Console 操作なしで runtime 自身が分類）。
scene を走査し「rtRoot 外 / 共存許可名（ground/sea/boundary/label/landmark/UI/tree）でない / 真に可視 /
頂点 > 300」の mesh を、親チェーン名・renderOrder・`userData.usage` で振り分ける:

| bucket | 判定 |
|---|---|
| `BuildingTileLayer` | `userData.usage` 付き mesh（建物壁/天井）または renderOrder ≥ 900 |
| `CityBuildingLOD` / `MajorBuildingLOD` | 親名に該当 |
| `RiverLayerV2` | 親名 or renderOrder 922/923 |
| `RoadLayer` / `ParkLayer` / `RailLayer` / `CityTileLayer` | 親名 |
| `unknown` | 上記外 |

**312 の主因は `BuildingTileLayer`**（住吉区の startup 建物タイル ≈ 50〜80 tile × 用途別 mesh 3〜6 = 200〜300 mesh）。
`__CANONICAL_RUNTIME_DEBUG__().legacyResidual` で実機の内訳を確認できる。

## 2. 復活していた直接原因

1. **startup race**: `initWardMode()` が住吉区の建物 tile を **async ロード開始** → その後 DOMContentLoaded で
   CanonicalRuntime が auto-init → `BuildingTileLayer.hide()` を呼ぶ。しかし `tile.hide()` は
   `state === 'loading'` の tile を**スキップ**する（`if (state !== 'loaded-*') return;`）。
   ロード完了時に `state='loaded-visible'` になり scene に出る。
2. **毎フレームの再生成**: render loop の `BuildingTileLayer.updateByCamera(camera)` +
   `WardModeManager.update()`（auto ward switch）が camera 移動のたびに tile を再表示。
3. **camUpd の tile stream**: `CityTileLayer.updateForTarget` / `CityBuildingLOD.setCameraDistance` が
   City Mode 系 mesh を復活。
4. **ward 切替**: `WardModeManager.switchWard()` が `BuildingTileLayer.enableDataset` + 全 tile load。
5. FIX2 の self-check は毎回 `toggleOldLayers(true)` を呼ぶだけ（＝毎フレーム再 hide の誤魔化し。§1 違反）。

## 3. 修正した render / update 箇所

**Render Ownership を一箇所（`CanonicalRuntime.toggleOldLayers`）で管理**（§5）:
`window.__CANONICAL_OWNS_BASE__ = !!hidden` を最初にセット。以下がこのフラグを参照:

| 箇所 | 修正 |
|---|---|
| render loop（§3） | `if (!window.__CANONICAL_OWNS_BASE__) { BuildingTileLayer.updateByCamera(camera); WardModeManager.update(); }` |
| camUpd（§10） | `const canonicalOwns = !!window.__CANONICAL_OWNS_BASE__;` → `CityTileLayer.setCameraDistance/updateForTarget` と `CityBuildingLOD.setCameraDistance` を `!canonicalOwns` ガード。<br>※ `RiverLayerV2` / `ParkLayer` / `BUILDING_EDGE_LOD` は `hide()` で group ごと scene から外れるためガード不要（residual を生まない） |
| `WardModeManager.switchWard`（§9） | 冒頭で `if (window.__CANONICAL_OWNS_BASE__) { currentWardId = wardId; return true; }`（legacy building を一切ロードせず、canonical が wardId フィルタで再描画） |
| `toggleOldLayers(true)` | ward 別 building dataset を `disposeDataset()` で破棄（loading 中 tile も含めて確実に消す。`buildingIndices` は残るので Legacy 復帰は fetch 無しの revisit 経路で再構築＝可逆）。embedded dataset も dispose |
| layer トグルパネル `apply()`（§4） | canonical 所有中は `['buildings','roads','waterways','sea','parks','railways']` を `CanonicalRuntime.setLayerVisible()` へルート（legacy `show()` を呼ばない） |
| `toggleOldLayers(false)`（§17） | 現 ACTIVE ward の building dataset を `enableDataset()` で再有効化 → legacy streamer resume |

**self-check（§16）**: `runSelfCheck()` を「見つける → ERROR 記録」に変更。
- `classifyLegacyResidual()` で内訳算出 → `selfCheck.residual`
- residual > 8 → `selfCheck.ok = false`、`phase = 'error'`、`reason = 'legacy residual N（BuildingTileLayer x, …）'`
- **毎フレーム再 hide しない**。startup race の後始末だけ `selfCheck.cleanupTried` ガードで **1 回のみ**実行
  （`BuildingTileLayer.hide()` + `disposeDataset` + `CityTileLayer.setLayerEnabled(false)`）→ 3 秒後に再確認
- ownership guard が効いているので、この 1 回で 0 になれば以後復活しない

**§8 再検証**: `refresh()` 内で camera 移動 / zoom / ward 切替を検出したら 0.7s 後に `runSelfCheck()` 再実行（throttle 1.5s）。

## 4〜8. residual タイミング（実機未計測）

このセッションでブラウザを実行できないため実数値は取れないが、機構上:

| タイミング | 期待 residual | 根拠 |
|---|---|---|
| Canonical ready 直後 | 0（or startup race 分を +3s cleanup で 0 へ） | hide + disposeDataset + ownership guard |
| +2 秒 | 0 | ownership guard が update 経路を塞ぐ |
| +5 秒 | 0 | 同上 + cleanup 済み |
| camera 移動後 | 0 | loop / camUpd の legacy update に入らない |
| zoom 後 | 0 | 同上 |
| ward 切替後（§9） | 0 | switchWard が legacy building をロードしない。canonical が wardId フィルタで差し替え |

status に `Legacy residual: 0`（緑）を常時表示。0 でなければ `[CANONICAL ERROR] Legacy residual: N` + 上位 3 layer の内訳。

## 9〜11. Canonical 側 mesh（維持）

`stats.canonicalMesh`（water/roads/buildings）は refresh のたびに実 mesh 数を再計測。ユーザー実機で
`W 4 / R 6 / B 149` が確認できている値は維持される（Canonical は一切止めていない。Legacy だけ停止）。

- Water canonical: `stats.canonicalMesh.water`（大川 = riverbank polygon のみ。旧 ribbon と重ならない §13）
- Road canonical: `stats.canonicalMesh.roads`（PLATEAU tran polygon のみ。旧 centerline ribbon と重ならない §14）
- Building canonical: `stats.canonicalMesh.buildings`（選択区外は wardId フィルタで 0 §15）

## 12. Legacy OFF/ON 復帰結果（§17）

`__SET_CANONICAL_RUNTIME__(false)` または画面ボタン「Legacy 表示」:
1. `toggleOldLayers(false)` → `__CANONICAL_OWNS_BASE__ = false`
2. loop / camUpd のガードが解除 → legacy updater **resume**
3. 現 ward の building dataset を `enableDataset()` → revisit 経路で再構築（fetch 無し・buildingIndices 保持）
4. RoadLayer/RiverLayerV2/ParkLayer は `.show()` で group を再 add

→ 停止は破壊ではない。Canonical: legacy updater suspended / Legacy: resumed。

## 13. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

新規チェック（全て true）:
`renderOwnership` / `loopLegacyStopped` / `camUpdLegacyStopped` / `switchWardGuarded` /
`selfCheckNoRehide`（runSelfCheck 内に `toggleOldLayers(true)` が無い）/ `residualClassified`
＋ FIX2 の 8 チェック ＋ 基本 5 チェック。

## 14. npm test

**1,239 tests / 1,224 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` を 20 → **26 件**（Render Ownership / loop・camUpd guard /
  switchWard guard / layer toggle guard / self-check の re-hide なし / status residual 表示 / §8 再検証）
- 既存 `tests/mission08-building-edge.test.js` / `mission12-park-lod.test.js` は camUpd の該当 legacy call を
  **ガードしない方針**にしたため無変更で PASS
- `tests/ward-ux-v1-p17b.test.js` の `CityBuildingLOD.setCameraDistance` assertion を
  `(!canonicalOwns && )?` を許容する正規表現へ更新（配線自体は維持）
- smoke 3/3 PASS
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` = **不変**（hash baseline 検証）

## 15. ユーザー実機確認手順（Console 操作なし）

1. `npx http-server public -p 8080`（または `python -m http.server 8080 -d public`）
2. ブラウザで `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html` を開く
3. **画面右下を見る**:
   - `Loading canonical…` → `[CANONICAL]`
   - **`Legacy residual: 0`（緑）** ← FIX3 の主目的。これが 0 なら旧 render は完全停止
   - `Canonical ready`
   - `W n / R n / B n`（canonical mesh 数）が出ている
4. カメラを動かす / zoom する / 区を切り替える（北区→中央区→住吉区→北区）
   → いずれの後も `Legacy residual: 0` のまま
5. 大川・御堂筋×中央大通で、**旧 ribbon と新 polygon が重ならず**、Canonical polygon だけが見える
6. もし `[CANONICAL ERROR] Legacy residual: N` が出たら、その下の layer 別内訳（例: `BuildingTileLayer:40`）と
   ともに報告

---

## 完了条件

- [x] Canonical Runtime 自動 ON（FIX2）
- [x] Canonical mesh 表示維持（W/R/B）
- [x] Render Ownership 単一フラグで legacy update 経路を停止（§3/§5/§10）
- [x] switchWard が canonical 所有中に legacy building をロードしない（§9）
- [x] ward 別 building dataset を dispose（startup race 対策）
- [x] layer トグルパネルが legacy show を呼ばない（§4）
- [x] self-check は per-frame 再 hide せず ERROR 記録 + layer 別内訳（§2/§16）
- [x] status に `Legacy residual: 0` / `[CANONICAL ERROR] N` + 内訳（§12）
- [x] camera移動 / zoom / ward切替後に residual 再検証（§8）
- [x] Legacy 表示ボタンで legacy updater resume（§17）
- [x] npm test 0 fail / validator PASS / smoke PASS
- [x] production / protected unchanged
- [ ] **実機で `Legacy residual: 0` を目視確認（ユーザー — このセッションでブラウザ実行不可）**

**このセッションではブラウザを実行できないため `Legacy residual` の実数値は未確認です。
機構上 0 になる設計にしましたが、実機で画面右下の `Legacy residual` を確認いただき、
0 でなければ内訳（layer 名 : 数）を報告してください。**
