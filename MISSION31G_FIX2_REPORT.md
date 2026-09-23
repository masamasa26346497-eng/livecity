# Mission 31G-FIX2 報告 — Canonical Runtime 自動反映（Console 操作を不要にする）

結論: `ward-ux-v1.html` を開くだけで Canonical Runtime が**自動的に有効**になるようにした。
`__SET_CANONICAL_RUNTIME__(true)` などの Console 入力は不要。
初期化に致命的な失敗があればユーザー操作なしで legacy render へ自動 fallback（白画面にしない）。
画面右下に `[CANONICAL]` / `[LEGACY FALLBACK]` のステータスと `Legacy 表示 ⇔ Canonical 表示` の切替ボタンを追加。

production / protected HTML 不変、旧 render コード温存、npm test 0 fail、validator PASS。

---

## 1. Canonical Runtime の default 値

```js
// ward-ux-v1.html
if (typeof window.__CANONICAL_RUNTIME__ === 'undefined') window.__CANONICAL_RUNTIME__ = true;
```

**既定 ON**。明示的に `window.__CANONICAL_RUNTIME__ = false` が事前設定されている場合のみ尊重（開発者が旧 render を見たいとき）。

## 2. auto-init 箇所

モジュール末尾の IIFE `autoInitCanonicalRuntime()`:

```js
(function autoInitCanonicalRuntime() {
  function go() { try { CanonicalRuntime.init(); } catch (e) { window.__CANONICAL_RUNTIME__ = false; } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
})();
```

- `CanonicalRuntime.init()`: `window.__CANONICAL_RUNTIME__ !== false` なら `= true` にして `setEnabled(true)`。**冪等**
- `__SET_CANONICAL_RUNTIME__` は呼ばない（＝ユーザー入力なしで ON）
- さらに保険として render loop の `CanonicalRuntime.update()` も `flag && !enabled` で `setEnabled(true)` する
- startup log（§18）: `[CanonicalRuntime] init` → `manifests loaded` → `legacy hidden` → `ENABLED` → `self-check` → `READY`

## 3. legacy hide 処理（§3）

`setEnabled(true)` 内で `toggleOldLayers(true)`:

| 対象 | 処理 |
|---|---|
| RoadLayer / RiverLayerV2 / ParkLayer / BuildingTileLayer | `.hide()`（group visible=false・**破棄しない**） |
| CityBuildingLOD / MajorBuildingLOD | `.setVisible(false)` |
| CityTileLayer（roads / waterways / parks / railways） | `.setLayerEnabled(k, false)` |

- GroundVisualLayer / WaterSurfaceLayer（海）/ WardBoundaryLayer / LandSurfaceLayer / ラベル類は隠さない（canonical と共存）
- `setEnabled(false)` / fallback 時は同じ関数を `toggleOldLayers(false)` で呼び全復帰

## 4. fallback 処理（§4）

`fallbackToLegacy(reason)`:

```
enabled=false → __CANONICAL_RUNTIME__=false → rtRoot.visible=false → toggleOldLayers(false)
→ phase='fallback' → ステータス [LEGACY FALLBACK] + 理由表示
```

自動 fallback のトリガ:

| 失敗 | 検出箇所 |
|---|---|
| scene attach（THREE.Group 生成失敗） | `setEnabled` の try/catch → `fallbackToLegacy('scene attach 失敗: …')` |
| manifest fetch 失敗 / parse error | `ensureManifest().catch(e => fallbackToLegacy('manifest fetch 失敗: …'))` |
| tile fetch 失敗 | `loadTile` の catch で `stats.fetchErrors++`（個別 tile は致命的にしない） |
| self-check で canonical mesh 0 | phase='error'（ステータスに `[CANONICAL — CHECK] check: canonical mesh 0`） |

`update()` は fallback 後 `phase === 'fallback'` を見て再有効化ループに入らない（安定）。

## 5. status UI（§5/§6/§7）

画面右下（`#canonical-runtime-status`・目立ちすぎない小サイズ）:

```
[CANONICAL]                    ← 緑
LOD: MID　Tiles: 42
W 12 / R 34 / B 210            ← canonical mesh 数（water/roads/buildings）
Canonical ready                ← self-check OK
[ Legacy 表示 ]                ← §15 画面切替ボタン
```

状態別表示:
- `Loading canonical…`（黄）— 初期化中（§6: 5 秒以上でも「壊れた」と思わせない）
- `[CANONICAL]`（緑）— 正常
- `[CANONICAL — CHECK]`（橙）— self-check 警告
- `[LEGACY FALLBACK]`（赤）+ 失敗理由 — 自動 fallback 済み
- `[LEGACY]`（青）— ボタンで手動 legacy に切替中

DOM 生成は全て try/catch でガード（status UI が失敗しても描画は継続）。

## 6. water 自動切替（§8/§16）

- ページロード → auto-init → `derived/{far,mid,near}/water/` tile を camera 距離で自動ロード
- 大川: `cg_water_river_x_water_8f1a2570d2d177` の OSM riverbank polygon（面）を描画
- 旧 RiverLayerV2 ribbon は `toggleOldLayers(true)` で hide

## 7. road 自動切替（§9/§17）

- `derived/*/roads/` tile を自動ロード（PLATEAU tran polygon-first 99%）
- 旧 RoadLayer ribbon + CityTileLayer roads は hide（同時表示されない）

## 8. building 自動切替（§10/§11）

- `derived/*/buildings/` を自動ロード（heightM で押し出し・用途色 `presetWallColor`）
- **Ward Mode: `attributes.wardId === WardModeManager.currentWardId` でフィルタ**（選択区外を描かない）
- ward 切替時は全 tile dispose → 再ロード（残留 object 0）
- 旧 BuildingTileLayer / CityBuildingLOD は hide

parks / rail も同様に auto（§11）。grass は薄い緑（park 色にしない）。

## 9. 大川の見た目差（§16）

- **Canonical（既定）**: OSM riverbank polygon（面）— 川幅は実測水域界、川岸が polygon
- **Legacy（右下ボタンで切替）**: RiverLayerV2 の centerline × 推定幅 ribbon
- 差が明確に見えるはず。**⚠ 実機ブラウザでの目視確認は未実施**（このセッションでブラウザ実行不可）

## 10. 道路交差点の見た目差（§17）

- **Canonical**: PLATEAU tran 道路区域 polygon（交差点は一体面）
- **Legacy**: centerline ribbon（交差点で帯が重なり団子状、miter、隙間）
- 御堂筋×中央大通 / 梅田 / 難波 等で差が見えるはず。**⚠ 実機目視確認は未実施**

## 11. validator（§19）

`tools/validate/canonical-runtime-integration.js` = **PASS**

| check | 結果 |
|---|---|
| defaultOn（既定 true） | true |
| autoInit（autoInitCanonicalRuntime + CanonicalRuntime.init()） | true |
| legacyAutoHide（toggleOldLayers(true)） | true |
| autoFallback（fallbackToLegacy + manifest catch） | true |
| statusUI（`#canonical-runtime-status` + `[CANONICAL]`） | true |
| screenToggle（トグルボタン click ハンドラ） | true |
| selfCheck（runSelfCheck） | true |
| manualConsoleNotRequired（旧 既定 false パターンが無い） | true |
| moduleWired / oldRenderIntact / productionUnchanged / protectedUnchanged / derivedPublicPresent | true |

回帰: canonical-water / canonical-geometry / canonical-parks / canonical-rail / canonical-conflicts /
derived-geometry validator = 全 PASS。

## 12. npm test

**1,231 tests / 1,216 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` を 15 → **20 件**に拡張
  （既定 ON / auto-init / 自動 fallback / status UI + トグル / self-check / validator FIX2 チェック）
- smoke `tests/ward-ux-v1-smoke.test.js` 3/3 PASS
  （モジュール評価停止なし・DOM/THREE/fetch が無い環境でも fallback して継続）
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` = **不変**（hash baseline 検証）
- `git diff --check` clean

## 13. ユーザーが行う実機確認手順

**「URL を開くだけ」**（Console 操作なし）:

1. `public/` を document root にしてローカル HTTP サーバーを起動
   （例: `npx http-server public -p 8080` / `python -m http.server 8080 -d public`）
   ※ `public/map-data/osaka-city/derived/` が 644MB あることを確認
2. ブラウザで `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html` を開く
3. **画面を見る**:
   - 数秒で画面右下に `Loading canonical…` → `[CANONICAL]` `Canonical ready` と出る
   - 大川（十三〜天満）へカメラを寄せると、川が polygon（面）で描かれている
   - 御堂筋×中央大通の交差点が団子状に膨らまない
   - 東淀川区・淀川区を選んでも道路が表示される（31C2 で解消済み）
   - 区を切り替えて選択区外の建物が残らない
   - 建物クリック → popup（用途・高さ・底面→頂部）
4. **旧表示と比較したいとき**: 画面右下の `Legacy 表示` ボタンをクリック（Console 不要）
5. 万一おかしいとき: 画面右下が `[LEGACY FALLBACK]` になっていれば自動で旧 render に戻っている。
   理由がステータスに出るので、それを報告

---

## 完了条件

- [x] ページを開くだけで Canonical Runtime ON（auto-init）
- [x] Console 操作不要
- [x] status に CANONICAL 表示 + Loading 表示 + LOD/Tiles/mesh 数
- [x] water / roads / buildings / parks / rail 自動表示
- [x] legacy 自動非表示（toggleOldLayers）
- [x] fatal error 時だけ legacy fallback（白画面にしない）
- [x] 画面トグルボタンで Canonical ⇔ Legacy 切替（§15）
- [x] 起動 self-check（canonical mesh > 0 / legacy 残存検出）
- [x] npm test 0 fail / validator PASS / smoke PASS
- [x] production / protected unchanged
- [ ] **大川・交差点・区スコープの実機目視 QA（ユーザー実施 — このセッションでブラウザ実行不可）**

**このセッションではブラウザを実行できないため、実機での見た目確認（§16/§17 の大川・道路差、visual anomaly）は
ユーザーにお願いします。データ・配線・自動化は完成しており、URL を開けば Canonical 描画が自動で立ち上がります。
問題があれば画面右下のステータス（fallback 理由）とともに報告してください。**
