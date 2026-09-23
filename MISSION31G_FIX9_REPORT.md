# Mission 31G-FIX9 報告 — Ward Mode 建物を一区全域固定表示に変更

結論: Ward Mode で一区を選択したら、その区の**全建物 tile をロードして pin し、
camera 移動 / zoom / rotate では hide も dispose もしない**仕様にした。

- GLOBAL 地図（roads / water / parks / rail / sea / ground）は大阪市全域のまま（§0/§18）
- City Mode は従来の LOD（FAR mass / MID major / NEAR detail）を維持（§8）
- placement policy（FIX6 SUPPRESS）/ usage color（FIX5）/ 区外建物を出さない（§17）を維持
- geometry / 建物数 / GLOBAL map 仕様は不変
- npm test 0 fail、validator PASS、production / protected 不変
- **実機の挙動は未確認**（このセッションはブラウザ不可）。§22/§23 の目視 QA が必要

---

## 1. 建物が消えていた直接原因

Ward Mode でも建物 tile を **camera-relevant** で選んでいた:

```
refresh() → tileRange('buildings', ...) で camera 周辺の tile 範囲を計算
          → near band: 内側 1300m = near tile / 外側 = far mass ring（FIX7）
          → wantSet = camera 周辺 tile のみ
          → camera 移動で wantSet が変わる
            → wantSet 外の building tile: e.group.visible = false（可視から外す）
            → drainStaleQueues(): wantSet 外の in-flight fetch を AbortController で abort
            → evictLRU(): 非可視 tile を byte-budget で dispose
```

→ 北区を選択して camera を北区の端へ動かすと、反対側の北区 tile が
「camera から遠い」判定で hide / abort / evict され、**同一区内の建物が一部消えていた**。

## 2. Ward Mode building load 方式（§2）

### precompute（新規）
`tools/build-ward-building-index.js`:
canonical building（615,617 棟・不変）+ attributes（wardId）+ placement policy を stream し、
各区が占有する 500m building tile 一覧と renderable 数を出す。

出力 `data/processed/osaka-city/derived/building-ward-index.json`（**14 KB**・1 回だけ fetch）:
```json
{ "wards": { "kita": {
    "buildingCount": 20566, "suppressCount": 178, "renderableCount": 20388,
    "tileCount": 54, "tiles": [[tx,tz], ...] }, ... } }
```

### runtime
Ward 選択時、`refresh()` は `wardIndex[wardId].tiles` の **全 tile を want に入れる**（camera を一切見ない）:

| 対象 | band | 常時 want か | pin |
|---|---|---|---|
| 区の全 tile | **mid**（tolM 6m・~43KB） | ✔ 常に want | ✔ `e.pinnedByWard = wardId` |
| camera 近傍（`WARD_NEAR_REACH_M = 1400`m）の区 tile | **near**（tolM 2m・~358KB） | camera 近傍のみ | ✘（非 pin・evictable） |

→ **区の全建物が常に mid representation で存在**し、camera 近傍だけ near 詳細を上乗せする。

## 3. pin 方式（§5/§19）

- `tileCache` の entry に `pinnedByWard`（wardId 文字列 or null）を追加。
- Ward Mode の mid ward tile が build されると `refresh()` が `e.pinnedByWard = wardId` にする。
- **`evictLRU()` は `pinnedByWard === lastWard` の entry を eviction 対象から除外**:
  ```js
  .filter(([, e]) => !e.group.visible && !(e.pinnedByWard && e.pinnedByWard === lastWard))
  ```
- pin されるのは **mid tile のみ**（区全域・最大 112 tile × 43KB ≈ **4.8MB**／区）。
  near tile は非 pin（camera 近傍のみ・byte-budget LRU で回収）→ memory は有界（§19）。
- build 後に raw tile JSON（`job.feats`）は解放（§20・既存）。

## 4. camera 移動時の挙動（§3/§22）

- 区の mid tile は毎 refresh で want に入る → `wantSet.has(key)` 常に true → `e.group.visible = true` 維持。
- `drainStaleQueues()` は wantSet 内の job を捨てない → 区 tile の fetch/build を abort しない。
- `evictLRU()` は pin tile を飛ばす → dispose しない。
- Three.js 標準 frustum culling（`o.frustumCulled = true`）による画面外描画省略は有効（§0 許可）。
- → **北 / 南 / 東 / 西 へ大きく動かしても、zoom in/out しても、rotate しても、同区建物は消えない。**

## 5. zoom 時の挙動（§9/§10）

- zoom out で `currentBand` が near → mid → far に変わっても、**区の mid tile は band に関係なく常に want**。
- zoom in で near band に戻ると camera 近傍 tile に near 詳細が乗る。
- 「遠いから建物が無くなる」は起きない（§9）。区全建物は最低 mid で必ず representation あり（§10・gap 0）。

## 6. far / near handoff（§11）

**new ready → old hide** の順を厳守（gap を作らない）:

- 通常時: mid tile が可視。
- camera が近づく → near tile を fetch queue へ。**mid はそのまま可視のまま**。
- near tile が build 完了 → `drainBuild` が **その瞬間に同座標の mid を hide**:
  ```js
  if (job.band === 'near') { const ms = tileCache.get('mid/buildings/'+tx+'_'+tz+'@'+w); if (ms) ms.group.visible = false; }
  ```
- camera が離れる → near key が want から外れる → generic 可視パスで near `visible = false`
  → 続く handoff パスで mid の near sibling が非可視 → **mid を再表示**（cache 済み・pin 済みなので即時・再 fetch 無し）。
- flicker / 空白 / 一瞬消える が起きない。

## 7. expected / loaded / represented 件数（§12）

`updateWardLoadStat()` が管理（`getDebug().wardBuildings` / status に表示）:

| 指標 | 意味 |
|---|---|
| `tilesExpected` | `wardIndex[ward].tileCount` |
| `tilesLoaded` | その区 tile のうち mid or near が build 済みの数 |
| `renderableExpected` | `renderableCount` = `buildingCount - suppressCount`（§15） |
| `renderableLoaded` | build 済み tile の `featureCount - suppressedInTile` 合計（`renderableExpected` で cap） |
| `ready` | `tilesLoaded >= tilesExpected` |

代表区（precompute 実測）:

| 区 | buildings | SUPPRESS | renderable | tiles |
|---|---|---|---|---|
| 北区 kita | 20,566 | 178 | **20,388** | 54 |
| 中央区 chuo | 18,931 | 117 | **18,814** | 52 |
| 住吉区 sumiyoshi | 35,119 | 2 | **35,117** | 51 |
| 平野区 hirano | 47,722 | 94 | **47,628** | 89 |
| 住之江区 suminoe（最大 tile） | 25,103 | 186 | **24,917** | 112 |

24 区合計 615,617 棟 / SUPPRESS 4,549。

## 8. Ward 切替（§6/§7/§23）

北区 → 中央区:
1. `refresh()` が `bWard !== lastWard` を検出
2. **旧区 building tile: `e.group.visible = false` + `e.pinnedByWard = null`**（unpin）→ 以後 LRU が背景で回収。
   一括 dispose しない → UI を止めない（§6）。旧区の未完了 build job は破棄。
3. 新区 tile 一覧を want へ → progressive load → build されたものから pin。
4. status: `Bldg 中央区: 12/52 tiles ~4,300 / 18,814 loading…` → 全 tile 完了で `Ward buildings ready`。

**同一区を再選択**（北区→中央区→北区・§7）: 北区 tile が cache に残っていれば
`cached.group.visible = true` で**即再表示**（再 fetch / 再 build 無し）。

## 9. cache / memory 対策（§19/§20）

- pin 対象 = mid tile のみ。最大 112 tile × 43KB ≈ 4.8MB／区。
- near tile（camera 近傍・~358KB）は非 pin → `MAX_CACHE_MB = 300` の byte-budget LRU で回収。
- GLOBAL 地図 tile（roads/water/parks/rail）+ 現区 pin + camera 近傍 near で常時 ~15–20MB 程度。無制限増加なし。
- build 後の raw JSON（`job.feats`）は null 代入で解放（§20）。entry が保持するのは
  geometry（BufferGeometry）+ `footprints`（picking index・popup 用属性）+ カウント。

## 10. performance 影響（§21）

- **load は background progressive**: 既存の `fetchQ`（同時 6・camera 中心距離順）+ `drainBuild`（1 frame BUILD_BUDGET_MS 7ms）を流用。区を選んでも UI は止まらない。
- **render loop で毎 frame 全建物を走査しない**: 可視判定は tile 単位（`e.group.visible`）。`updateWardLoadStat()` は refresh（200ms throttle）+ build 完了時のみ、区 tile 数（≤112）× 2 Map.get。
- mesh / drawCall: 区全域の mid tile が増える分だけ増加（1 tile = usageCategory 数分の merged mesh）。
  City Mode の far-mass よりは多いが、1 区分（数十 tile）に限定。frame budget が build を分散。
- **実機フレームタイムは §22 で要測定**（`__CANONICAL_RUNTIME_PERF__()`）。

## 11. placement policy 維持（§15）

- `renderableExpected = buildingCount - suppressCount`（SUPPRESS は最初から表示対象外）。
- tile build 時の SUPPRESS スキップ（FIX6 `buildGroup`）は不変。EXEMPT / DISPLAY / REVIEW は表示。
- `ensurePlacement(tx, tz)` は mid / near / far どの band の building tile でも呼ばれる（不変）。

## 12. usage color 維持（§16）

- `CR_USAGE_COLOR`（FIX8B 中間トーン）/ `crBuildingMaterial(cat, band)` は不変。
- mid tile（区全域）も `crBuildingMaterial(cat, 'mid')` で用途色付き（whiten 0.30）。
- near tile は `'near'`（whiten 0.12）。band で「淡さ」だけ変わる（カテゴリ不変）。

## 13. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

FIX9 チェック（全て期待値）:
`wardBuildingsPinned` true / `cameraDoesNotUnloadSelectedWard` true / `wardFullCoverage` true /
`lodRepresentationGap` **0** / `wardSwitchUnpinsPrevious` true / `cityModeUnchanged` true /
`wardIndexLoadedOnce` true
＋ FIX2〜FIX8B の全チェック維持。`canonical-runtime-performance.js` も PASS。

## 14. npm test

**1,305 tests / 1,290 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` に FIX9 11 件追加（71 → 82）:
  区全 tile を want / camera で消さない / progressive / ward 切替 unpin+pin / 同区 cache 即再表示 /
  遠距離 representation + handoff / expected-loaded-represented + status / City Mode 従来 LOD /
  placement・usage color・selection scope・GLOBAL map 維持 / cache-memory / building-ward-index データ整合
- 既存テスト（FIX4/FIX7 の ward 切替）を「hide+unpin」へ更新
- smoke 3/3 PASS
- production / protected hash 不変、`git diff --check` clean、ward-index は `.gitignore`（derived/ 配下）

## 15. 実機確認方法（§22/§23/§26）

1. `npx http-server public -p 8080` → `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
2. **北区を選択** → 右下 `Bldg 北区: N/54 tiles … loading…` → 数秒で `Ward buildings ready`
3. **camera を北へ / 南へ / 東へ / 西へ大きく移動** → 北区の建物が一切消えないこと
4. **zoom in / zoom out** → 消えないこと（遠くは簡略、近くは詳細）
5. **rotate** → 消えないこと
6. **中央区へ切替** → 北区建物が消え、中央区全建物 + GLOBAL 地図が揃う。stale building 0
7. **北区へ戻す** → cache に残っていれば即再表示
8. **City Mode** → 従来どおり（全域 mass / 主要 / 詳細の LOD）
9. `window.__CANONICAL_RUNTIME_DEBUG__().wardBuildings` で expected / loaded / ready を確認

---

## 完了条件

- [x] Ward Mode で一区全 building tile をロード（ward-index の全 tile を want）
- [x] camera 移動で消えない（mid 常時 want + pin）
- [x] zoom で消えない（band 非依存で mid 保持）
- [x] rotate で消えない（frustum culling のみ）
- [x] selected ward 全域固定（pin・LRU 除外）
- [x] 遠距離も representation あり（mid が必ず存在・gap 0）
- [x] LOD gap 0（new ready → old hide）
- [x] progressive load（既存 fetchQ / frame budget 流用）
- [x] UI freeze なし（同期一括生成しない）
- [x] Ward 切替のみ scope 変更（旧区 unpin / 新区 pin）
- [x] City Mode は従来仕様（wardTiles 分岐前に continue しない）
- [x] usage color 維持 / placement policy 維持 / GLOBAL map 維持
- [x] npm test 0 fail / validator PASS / production・protected unchanged
- [ ] **実機で camera 移動・zoom・rotate・区切替を目視（ユーザー・§22/§23）**

**次工程へ進みません。Ward Mode 一区全建物固定表示の実機確認をお待ちします。**
