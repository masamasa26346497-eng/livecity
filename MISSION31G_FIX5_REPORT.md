# Mission 31G-FIX5 報告 — Canonical Buildings を用途別カラーへ戻す

結論: Canonical Runtime の建物を **usageCategory 別の淡色パレット**で描くようにした。
geometry・footprint・Ward scope・GLOBAL map・Legacy residual guard はいずれも不変。表示 style のみ変更。

npm test 0 fail、validator PASS、production / protected 不変。

---

## 1. 修正前の白表示原因

Canonical Runtime の buildings ブランチは色を次で決めていた:

```js
col = presetWallColor(a.usage);        // ← a.usage は PLATEAU 数値コード "402" 等
```

2 つの理由でほぼ白一色になっていた:

1. **`presetWallColor(a.usage)` が旧 `BLDG_PRESET_OF_USAGE` コード表を引く。**
   この表はこのプロジェクトの PLATEAU コードと不整合（例: 表では `431=運輸倉庫→industrial`
   だが実データの `431` は「専用住宅」）。一致しないコードは全て `other` へ落ちる。
2. **`presetWallColor` → `msBuildingColor` が `MS_BUILDING_BLEND = 0.92` で色を白へ 92% ブレンド。**
   用途色が解決できても最終的に「白＋8% の色味」になり、区別がつかない。

さらに `a.source === 'osm-fallback'` 判定は derived の実 source 値（`osm-building`）と一致せず、
generic な OSM 建物は `a.usage == null` 経路で灰白へ落ちていた。

## 2. 使用 palette

**既存 `PRESET_WALL_COLOR`（Mission クリスタル系パレット）の色値をそのまま再利用**（§4: 新色を作らない）。
白一色の原因は色相ではなくブレンド量だったため、パレットは据え置き、白寄せ量だけ弱めた。

| usageCategory | 色 (hex) | 系統 |
|---|---|---|
| residential_low | `0xf0d9a8` | アンバー／ゴールド |
| residential_mid | `0xa8dcea` | アクアマリン |
| commercial | `0xf2c9a0` | シトリン／琥珀 |
| office | `0x9fc8ef` | サファイアブルー |
| industrial | `0x8fbcd6` | スチールブルー |
| public | `0xb8c8e8` | アメジストブルー |
| school | `0xefe3a8` | レモンクォーツ |
| medical | `0xb0e4dc` | ミントグリーン |
| hotel | `0xe8c0c8` | ローズクォーツ |
| other | `0xcfd8dc` | クリアクォーツ（ニュートラル） |

> 注: §4 の「方向性」bullet（commercial=シアン / school=緑 / public=黄 / medical=ピンク /
> hotel=オレンジ）は既存 `PRESET_WALL_COLOR` の色相と食い違う。§4 最終文「新色を勝手に作るより
> 既存を優先」に従い、既存パレットを採用した。色相の入れ替えが必要なら次のミッションで対応可能。

### LOD 別の白寄せ量（§9・カテゴリは LOD で変えない）

```js
const CR_USAGE_WHITEN = { far: 0.60, mid: 0.28, near: 0.12 };
```

FAR は白へ 60% 寄せて遠景で騒がしくしない、MID 28%、NEAR 12% で用途差を明確化。
`msBlend(base, COL.white, whiten)` で band ごとに material を焼き込む。

## 3. usageCategory 別 material

```js
const crBuildingMats = new Map();                    // key = "<category>|<band>"
function crBuildingMaterial(cat, band) {
  // 未生成なら msBlend(CR_USAGE_COLOR[cat], COL.white, CR_USAGE_WHITEN[band]) の
  // MeshLambertMaterial を作り、userData.crShared = true を付けて Map へ保持
}
```

- **1 feature ごとに Material を new しない**（§7）。カテゴリ×band で共有（最大 10×3 = 30 個）。
- tile の buildings は `usageCategory` ごとに position を bucket 分けして 1 mesh に merge（§8）。
  1 tile あたり mesh 数 = そのタイルに出現するカテゴリ数（概ね 3〜7）。
- `disposeEntry` は `userData.crShared` 付き material を破棄しない（tile を跨いで再利用）。

## 4. PLATEAU 適用結果

- PLATEAU 建物（`source = plateau-building`）は canonical build 時に確定済みの
  `attributes.usageCategory`（`categoryFromLabel(usageLabel)` 由来）をそのまま palette キーに使用。
- 実データ標本（近景タイル 44,711 棟）で `usageCategory` の **null は 0 件**。
  分布例（中心部タイル群）: commercial / office / public / residential_low / industrial / school /
  medical / hotel / other が全て出現。
- 旧 `BLDG_PRESET_OF_USAGE` / `presetWallColor(a.usage)` への依存を撤去（コード表の不整合を回避）。

## 5. fallback 適用結果

- OSM fallback 建物（`source = osm-building`、標本で 3,914 / 44,711 棟）も
  **同じ `usageCategory` → 同じ palette**（§5）。source では一切分岐しない。
- `osm-building-fallback.js` の `resolveFallbackUsage` が既に
  `residential_low / commercial / … / other` の同じキー空間で category を埋めている
  → 灰色で浮かない。
- 旧 `msBlend(COL.white, 0xe6e9e5, 0.45)` の fallback 専用灰色分岐を削除。
- source の違いは `getDebug()` / `__LAST_BUILDING_PICK__` のデバッグ出力にのみ残す。

## 6. null usage 処理

```js
function crUsageCategory(a) {
  const c = a && a.usageCategory;
  return (typeof c === 'string' && CR_USAGE_COLOR[c]) ? c : 'other';   // null / undefined / 未知 → other
}
```

- 描画: null / 未知カテゴリは必ず `other` material（`nullUsageMaterial: 0` を validator が確認）。
- pick 結果 `d`: `usageCategory` は `crUsageCategory(a)`（非 null）、`normalizedUsage` は
  文字列でなければ `'unknown'` へ寄せる。`その他(null)` / raw code を UI に出さない。

## 7. popup 表示

`showPropertyCard(h.d)` → `usageDisplayName(d)`:
1. `UN[d.usage]`（このデータの正しい PLATEAU コード表: `431→専用住宅` 等）
2. `d.usageLabel`（canonical attributes）
3. `d.normalizedUsage`（`yes` 以外）
4. `建物（用途不明）`

`null` / `undefined` / `その他(null)` はどの分岐でも UI へ出ない。用途・高さ・底面→頂部（`z0`/`dz`）を表示。

## 8. mesh / drawCall 影響

| 指標 | before | after |
|---|---|---|
| building material | mesh ごとに new（tile 数 × 数個） | **カテゴリ×band で共有（最大 30 個）** |
| 1 tile の building mesh 数 | 色 bucket 数（≈ 3〜11） | usageCategory bucket 数（≈ 3〜7） |
| draw call | 上記と同等 | 同等（bucket 数はほぼ不変） |
| geometry / vertex / triangle | — | 不変（同じ押し出し） |

merge 方式・extrude ロジックは不変。draw call の異常増加なし（§8/§17）。
material インスタンス数はむしろ大幅減。**実機フレームタイムはユーザー QA で要確認**（下記 §13）。

## 9. Ward Mode

- 選択中 Ward の建物のみ、用途色付きで表示（`buildingWardId()` フィルタは不変）。
- 区外建物は引き続き非表示（`loadTile` の wardId filter 不変）。
- 用途色は Ward 切替後も維持（material は ward 非依存、band のみ依存）。

## 10. City Mode

- City Mode でも同じ palette / 同じ `crUsageCategory` ロジック（§10）。
- 遠景は `CR_USAGE_WHITEN.far = 0.60` で彩度を落とし派手になりすぎない。
- カテゴリを City/Ward で変えない。

## 11. legacy residual

- Render Ownership（`__CANONICAL_OWNS_BASE__`）ガードは一切触れていない。
- canonical 建物 mesh は `rtRoot` 配下 → `classifyLegacyResidual()` の residual にカウントされない。
- `Legacy residual: 0` 表示・self-check は不変。validator `legacyResidualGuard: true`。

## 12. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

FIX5 チェック（全て期待値）:
`buildingUsagePaletteEnabled` true / `whiteOnlyBuildings` **false** / `nullUsageMaterial` **0** /
`sharedMaterialBuckets` true / `fallbackUsesCanonicalPalette` true /
`wardScopeUnchanged` true / `globalMapUnchanged` true / `legacyResidualGuard` true
＋ 否定チェック: buildings ブランチに `presetWallColor(a.usage)` / `a.source === 'osm-fallback'` /
`msBlend(COL.white, 0xe6e9e5` が残っていないこと。
＋ FIX2/FIX3/FIX4 の全チェック維持。

## 13. npm test

**1,249 tests / 1,234 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` を 26 → **33 件**（FIX5 +7）:
  palette 10 カテゴリ定義 / `crUsageCategory` の null・未知→other / source 非分岐・白一色撤去 /
  共有 material bucket / LOD は白寄せ量のみ / pick の usageCategory・normalizedUsage 非 null /
  ward scope・GLOBAL・residual guard 不変。
- 「validator の全チェックが期待値」テストに FIX5 キーを追加。
- smoke 3/3 PASS（インライン script のモジュール評価で例外なし）。
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` 不変（hash baseline）。
- `git diff --check` clean。

## 14. 次の修正へ進めるか

**実機確認待ち。** このセッションではブラウザ実行不可のため、以下はユーザー QA:

1. `npx http-server public -p 8080` → `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
2. 画面右下ステータスに `用途: commercial N / office N / …`（可視建物の内訳）が出る
3. 代表地点（§16）で用途差が色で分かる:
   - **梅田 / 難波**: office・commercial（青・琥珀）が住宅と区別できる
   - **住宅街（住吉・平野）**: residential（アンバー系）中心
   - **工業地（此花・大正）**: industrial（スチールブルー）
   - **学校**: school（レモン）
4. fallback（OSM）建物が周辺 PLATEAU 建物と同じ色域で、灰色で浮かない
5. 建物クリック → popup に用途名（`null` / コードが出ない）、Ward 切替・City Mode で色維持
6. `Legacy residual: 0` 維持、frame time が FIX4 から大きく悪化していない

完了条件:

- [x] 白一色廃止 / 用途別 palette 復元（既存 PRESET_WALL_COLOR 再利用）
- [x] PLATEAU 色分類（usageCategory 主キー）
- [x] OSM fallback 色分類（同 palette・source 非分岐）
- [x] null usage 0 / other fallback あり
- [x] shared material（カテゴリ×band）
- [x] popup null なし
- [x] Ward scope 維持 / City Mode 維持 / Legacy residual guard 維持
- [x] npm test 0 fail / validator PASS
- [x] production / protected unchanged
- [ ] **実機で用途色の視認性・fallback・performance を目視確認（ユーザー）**

**次の項目には自動で進みません。実機確認の結果をお待ちします。**
