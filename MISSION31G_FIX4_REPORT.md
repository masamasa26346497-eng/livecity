# Mission 31G-FIX4 報告 — 地図は大阪市全域、建物だけ選択地区

結論: Canonical Runtime の Render Scope を分離した。
**GLOBAL（roads / water / parks / rail）は大阪市全域を常時表示**（ward filter を撤廃、camera + LOD の tile
streaming だけで可視範囲を制御）。**SELECTION（buildings のみ）は選択中の区 or City Mode の city-wide**。
ward 切替時は建物 tile だけ差し替え、GLOBAL 地図は再 fetch しない（§5/§6）。

npm test 0 fail、validator PASS、production / protected 不変、31G-FIX3 の Legacy residual 停止も維持。

---

## 1. 修正前の原因

`CanonicalRuntime.wardScope()` が **選択区の bbox** を返し、`loadTile()` が
`roads` / `parks` の feature を `scope.bbox` で filter していた（`layer !== 'water'` の条件で roads/parks に
ward bbox クリップ）。さらに `refresh()` が ward 切替のたびに **全 layer の tile を dispose** し、
cache key に `wardKey` を含めていたため roads/water/parks/rail まで再 fetch されていた。
→ 選択区の bbox に地図全体が引っ張られ、隣接区の道路・河川・鉄道が画面の途中で切れていた。

## 2. GLOBAL layer 一覧（大阪市全域・ward filter なし）

| layer | scope | 可視範囲制御 |
|---|---|---|
| roads | GLOBAL | camera + LOD tile streaming のみ |
| water（河川・海） | GLOBAL | 同上 |
| parks | GLOBAL | 同上 |
| rail | GLOBAL | 同上 |
| ground / 行政界 / ラベル | GLOBAL（legacy 側で共存・31G-FIX3 で隠していない） | — |

コード: `const GLOBAL_LAYERS = new Set(['roads', 'water', 'parks', 'rail']);`

## 3. SELECTION layer 一覧（選択スコープ）

| layer | scope |
|---|---|
| buildings | 選択中の区（Ward Mode）／ city-wide（City Mode・区未選択） |

コード: `const SELECTION_LAYERS = new Set(['buildings']);`

## 4. Ward filter を外した箇所

| 箇所 | before | after |
|---|---|---|
| `wardScope()` | 選択区 bbox を返す → roads/parks を bbox クリップ | **削除**。`buildingWardId()`（buildings 用 wardId だけ）に置換 |
| `loadTile()` の feature filter | `if (buildings) wardId filter; else if (scope.bbox && layer!=='water') bbox filter` | `if (layer === 'buildings' && wardId) wardId filter;` のみ。他 layer は素通し |
| `refresh()` の ward 切替 | 全 tile dispose + cache key に wardKey | **buildings tile だけ dispose**。cache key は buildings のみ `@wardId` 付き、GLOBAL は ward 非依存 |
| `ensureManifest()` | ward-classification-polygons を fetch して bbox 化 | 不要になったので削除（top manifest のみ） |
| `tileRange()` | 全 layer 共通の reach | GLOBAL layer は reach を広め（画面端で切れないよう。§7/§10/§11） |

## 5. building filter 実装

```js
function buildingWardId() {
  if (CityModeManager.isActive()) return null;          // City Mode = city-wide
  return WardModeManager.currentWardId || null;         // Ward Mode = 選択区 / null=city-wide
}
// loadTile 内:
if (layer === 'buildings' && wardId) {
  feats = feats.filter((f) => (f.attributes && f.attributes.wardId) === wardId);
}
// cache key: buildings のみ wardId を含める
function tileKeyOf(layer, band, tx, tz) {
  const base = band + '/' + layer + '/' + tx + '_' + tz;
  return (layer === 'buildings') ? (base + '@' + (buildingWardId() || 'city')) : base;
}
```

`attributes.wardId` は canonical build 時に確定済み（31D）。区切替後は新しい wardId で別 cache entry になり、
旧区 entry は次の LRU / evict で dispose（§5）。

## 6. Ward 切替時の挙動（§5/§6）

北区 → 中央区:
1. `refresh()` が `buildingWardId()` の変化を検出
2. **`tileCache` から `e.layer === 'buildings'` の entry だけ dispose**（roads/water/parks/rail は残す）
3. `lastKey = ''` で streaming 再評価 → 中央区の building tile を `@chuo` key で load
4. GLOBAL layer の cache key は不変 → **manifest/tile を再 fetch しない**（既存 cache そのまま表示）

console: `[CanonicalRuntime] building scope → 中央区（GLOBAL 地図は維持）`

## 7. City Mode 挙動（§4）

- `CityModeManager.isActive()` → `buildingWardId()` が `null` → 建物は **wardId filter なし = city-wide**
- GLOBAL 地図はそのまま（Ward Mode と同じ）
- Ward Mode ⇔ City Mode 切替は `buildingWardId()` の戻り値変化として refresh が検出 → building tile だけ差し替え（stale building 0）

## 8. global tile reload 削減（§6）

- ward 切替: GLOBAL layer（roads/water/parks/rail）の tile fetch = **0**（cache key が ward 非依存のため）
- Ward Mode ⇔ City Mode 切替: 同上 GLOBAL fetch 0
- camera 移動: GLOBAL layer は camera vicinity の未 cache tile のみ load（従来どおり）
- → 区を頻繁に切り替えるユースケースで大幅な fetch 削減

## 9. 実機確認結果

**⚠ このセッションではブラウザを実行できないため未確認。** 機構上の期待:

| 確認項目（§17/§18） | 期待 |
|---|---|
| 北区選択で北区外の道路が見える | ✓（roads GLOBAL・camera reach 内） |
| 北区選択で大川・淀川が見える | ✓（water GLOBAL） |
| 北区選択で周辺鉄道が見える | ✓（rail GLOBAL） |
| 北区選択で北区外の公園が見える | ✓（parks GLOBAL） |
| 北区選択で北区外の建物は非表示 | ✓（buildings wardId filter） |
| 道路 / 河川 / 鉄道が区境界で切れない | ✓（ward filter 撤廃・reach 広め） |
| 中央区へ切替で GLOBAL 再 fetch なし | ✓（cache key ward 非依存） |
| City Mode で city-wide 建物 | ✓（buildingWardId null） |

画面右下ステータスに `Map: GLOBAL　Bldg: 北区`（City Mode なら `Bldg: city-wide`）を表示（§13・Console 不要）。

## 10. legacy residual（§14）

31G-FIX3 の Render Ownership（`__CANONICAL_OWNS_BASE__` ガード）は不変。この修正で旧 layer を
再表示させる経路は追加していない。status の `Legacy residual: 0` 表示・self-check も維持。

## 11. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

FIX4 チェック（全て期待値）:
`globalMapLayers` true / `buildingSelectionScopeOnly` true /
`roadWardFilter` `waterWardFilter` `parkWardFilter` `railWardFilter` **false** /
`wardFilterRemoved` true（旧 `wardScope()` / `scope.bbox` フィルタが消えている）/
`wardSwitchDoesNotReloadGlobal` true / `buildingScopeDebug` true / `cityModeCityWide` true
＋ FIX2/FIX3 の全チェック維持。

## 12. npm test

**1,242 tests / 1,227 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` を 22 → **26 件**
  （§11 建物のみ wardId filter / §5・§6 ward 切替は buildings tile だけ破棄 / §13 Map・Building Scope 表示 /
  §4 City Mode = city-wide）
- 既存テスト無変更（`wardScope` を参照する mission テストは無かった）
- smoke 3/3 PASS
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` 不変（hash baseline 検証）
- `git diff --check` clean

## 13. ユーザー実機確認手順（Console 操作なし）

1. `npx http-server public -p 8080`
2. ブラウザで `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
3. 画面右下:
   - `Map: GLOBAL　Bldg: (区名 or city-wide)`
   - `Legacy residual: 0`
4. 区を選ぶ（例: 北区）→ カメラを引く:
   - **道路 / 河川（大川・淀川）/ 鉄道 / 公園が北区の外まで連続して見える**
   - **建物は北区の分だけ**（都島・福島・中央区の建物は出ない）
5. 中央区へ切替 → 地図（道路等）は一瞬もチラつかず維持、建物だけ中央区に変わる
6. City Mode に切替 → 建物が市全域に、地図はそのまま

---

## 完了条件

- [x] 地図基盤は大阪市全域（roads / water / parks / rail が GLOBAL）
- [x] buildings は選択区のみ / City Mode は city-wide
- [x] Ward 切替で GLOBAL の manifest/tile を再 fetch しない
- [x] 道路 / 河川 / 鉄道 / 公園を ward 境界で削らない（reach も広め）
- [x] 31G-FIX3 の legacy residual 0 を維持
- [x] npm test 0 fail / validator PASS / smoke PASS
- [x] production / protected unchanged
- [ ] **実機で「北区外の地図が見える / 北区外の建物は出ない / 区切替で地図が維持」を目視確認（ユーザー）**

**次の項目には自動で進みません。実機確認の結果をお待ちします。**
