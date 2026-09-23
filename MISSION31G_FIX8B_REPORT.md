# Mission 31G-FIX8B 報告 — 白飛び・低コントラストの根本原因を特定して修正

結論: 白飛びは **material の色付けではなく render / lighting stage** が原因だった。

- CR 建物 material の色は正しく付いている（`msBlend(base, white, whiten)` の**単一 blend**・二重適用なし・
  legacy ModelStyle は CR material を一切触っていない）
- **淡いパステル基色（輝度 ~0.85）× 総照度 ~2.4（hemi 1.02 + fill 0.30 + sun 1.08）→ チャンネル値が 1.0 を超え、
  ACES Filmic tone mapping がハイライトを脱色して白へ寄せていた**
- fog は近景に掛かっていない（無罪）

修正（すべて canonical 所有中・模型スタイル昼のみ・完全に可逆）:
1. **`CR_USAGE_COLOR` を中間トーンへ**（pale パステルを廃止）→ tone mapping のヘッドルームを確保
2. **canonical style profile**（`CR_STYLE = {exposure:0.86, hemi:0.60, sun:1.34, fill:0.20}`）で ambient を下げ directional を上げる
3. **drift 再適用**（起動後 `applyModelStyle` / `applyTimeOfDay` が白へ戻しても `update()` が検知して再適用）
4. `COL` palette（water/road/rail）を明度差 3 段以上に

mesh 数 / drawCall / tile 数は不変（`MeshLambertMaterial` のまま・outline mesh・個別ライト追加なし）。
npm test 0 fail、validator PASS、production / protected 不変。
**実機の見た目は未確認**（このセッションはブラウザ不可）。§19 で目視 QA が必要。

---

## 1. 白飛びの直接原因

`__CANONICAL_STYLE_DIAGNOSE__()` 相当の色経路解析（NEAR band）:

| category | 基色 (before) | 輝度 | afterWhiten | ×総照度 2.4 | 結果 |
|---|---|---|---|---|---|
| commercial | `#f2c9a0` (242,201,160) | 0.79 | (242,203,164) | (528,443,358) | **全チャンネル clip → 白** |
| office | `#9fc8ef` (159,200,239) | 0.78 | (163,202,239) | (356,441,522) | **全チャンネル clip → 白** |
| residential_low | `#f0d9a8` (240,217,168) | 0.85 | — | clip | **白** |

→ **ACES Filmic は clip 域の色を脱色（→白）する特性**があるため、明るい基色 + 強い照度で建物が真っ白になっていた。
FIX8 は基色を据え置き whiten と exposure だけ触ったので、この構造は残っていた。

## 2. 最終色までの経路監査（§2）

```
usageCategory → CR_USAGE_COLOR[cat]（基色）
  → crBuildingMaterial(cat, band): msBlend(基色, COL.white=0xeef0ec, CR_USAGE_WHITEN[band])  ← 単一 blend
  → THREE.MeshLambertMaterial({ color })                                                     ← lighting 対応
  → hemiLight(0.60) + fillLight(0.20) + sun(1.34)·NdotL  の Lambert 拡散
  → renderer.toneMapping = ACESFilmic, exposure 0.86
  → framebuffer（outputEncoding = Linear・r128 既定）
```

代表カテゴリの before → after（NEAR band）:

| category | 基色 before → after | afterWhiten (after) | shadow 面 (×0.8) | lit 面 (×1.87) |
|---|---|---|---|---|
| commercial | `#f2c9a0` → **`#d6a259`** | `#d9ab6b` | (174,137,86) 明確な琥珀 | (255,255,200) 暖色残る |
| office | `#9fc8ef` → **`#6d93c4`** | `#7c9ec8` | (99,126,161) 明確な青 | (232,255,255) 寒色残る |
| residential_low | `#f0d9a8` → **`#caa870`** | `#cdad7e` | (160,138,101) オーカー | 暖色残る |
| industrial | `#8fbcd6` → **`#8894a2`** | `#949faa` | ブルーグレー | グレー |
| school | `#efe3a8` → **`#b7bd68`** | `#bcc179` | カーキ緑 | 緑残る |

**afterWhiten でも輝度 0.55〜0.68 に収まり、lit 面でも 1 チャンネル以上が clip しない** → ACES が脱色しない。

## 3. 二重 white blend 有無（§3）

**なし。** 全文検索の結果:
- CR 建物色 = `crBuildingMaterial` の `msBlend` **1 回のみ**
- `msBuildingColor` / `MS_BUILDING_BLEND 0.92` / `presetWallColor` は **legacy 専用**（`BLDGS` / `bldgEdges` にのみ作用）で CR material には届かない
- `applyModelStyle()` は `wmRealC` 等の legacy キャッシュと `bldgEdges` を触るだけ。CR mesh（`CR_*` / `rtRoot` 配下・`crBuildingMats`）は対象外
- CR material は生成後に再 tint されない（`crBuildingMats` は色の再代入をしない）

## 4. fog 原因（§5）

**fog は原因ではない。**
模型昼の fog: `modelDayFogRange(cs.r)` → NEAR camera（cs.r < 3000）で `fog.near = 6000` / `fog.far = 18000`。
建物リーチは最大 1,300m（FIX7）→ `cs.r < fog.near` なので **建物に fog は掛からない**。
「近景まで霧がかって見える」のは fog veil ではなく **ambient wash（hemi 1.02 の均一照明）**。
`__CANONICAL_STYLE_DIAGNOSE__().fog.fogAtBuildings` で `none` と確認できる。

## 5. lighting 原因（§6）

**主因。** 模型昼のライト:

| light | before | after（CR 所有中） |
|---|---|---|
| hemiLight（半球＝擬似 ambient） | **1.02** | **0.60** |
| fillLight（暗部持ち上げ） | 0.30 | **0.20** |
| sun（DirectionalLight・面の陰影） | 1.08 | **1.34** |
| 総照度（lit 面 ≈ hemi+fill+sun·0.8） | ≈ 2.18 | ≈ 1.87 |
| shadow 面（hemi+fill） | ≈ 1.32 | ≈ 0.80 |

hemi を下げて **shadow 面が 1.32 → 0.80** になり、sun を上げて **lit/shadow の差が拡大** →
Lambert の NdotL 陰影がはっきり出る（§14 の「面方向が分かる立体感」）。
`sun.visible` は `shadowEnabled` 連動（既存仕様）。影 OFF でも sun 自体は方向光として効くよう既存の
`sun.visible = !nightMode && shadowEnabled` は変更していない（影 OFF 時は directional が消えるので、
その場合でも hemi 0.60 で用途色は視認可能）。

## 6. renderer 原因（§15）

- `toneMapping = ACESFilmicToneMapping` — clip 域を脱色する。今回は **基色を下げ + 照度を下げて clip 域に入らないようにする**方針
  （toneMapping そのものは legacy sky/fog と共有のため切り替えない）
- `toneMappingExposure` 1.05 → **0.86**（CR 所有中）
- `outputEncoding` は r128 既定（Linear）。legacy が同条件で作られているため変更しない
- `__CANONICAL_STYLE_DIAGNOSE__().renderer` で toneMapping / exposure / outputEncoding を確認できる

## 7. legacy ModelStyle 競合有無（§16/§17）

**競合なし**（§3 参照）。加えて **style ownership を正式化**:
`toggleOldLayers(true)` で `applyCanonicalExposure()` が exposure + hemi + sun + fill を CR 値に。
`applyModelStyle` / `applyTimeOfDay`（day/night 切替）がこれらを戻しても、`update()` の
**drift 検知**（`expDrift || hemiDrift || sunDrift`）が canonical 所有中・模型昼のみ再適用（§18）。
`toggleOldLayers(false)` / `fallbackToLegacy()` で `restoreLegacyExposure()` が
`__legacyStyle` に保存した元値（exposure/hemi/sun/fill）へ**完全復元**。

## 8. building 変更前後（§7 = §2 の表）

| | before | after |
|---|---|---|
| 基色パレット | pale パステル（輝度 ~0.85） | 中間トーン（輝度 ~0.55–0.68） |
| whiten | far .52 / mid .20 / near .05 | **far .55 / mid .30 / near .12** |
| material | MeshLambertMaterial | MeshLambertMaterial（不変） |
| 見え方 | ほぼ白 + わずかな色味 | 用途色が明確・side に陰影 |

## 9. road 変更前後（§11）

| | before | after |
|---|---|---|
| 色 | `msBlend(0x767c85, 0x8b9199, 0.5)` ≈ `#81868f` | **`#9096a0`**（medium gray） |
| vs 背景 `#f3f4f1`(0.95) / vs ground | やや薄い | **明確に一段濃い**（明度差 ≈ 0.35） |

## 10. water 変更前後（§12）

| | before | after |
|---|---|---|
| river | `#8fc6dc` | **`#6fb3d4`**（明確な cyan） |
| harbor | `#82b2c6` | **`#5f9bbb`** |
| opacity | 0.93 | **0.96**（ほぼ不透明） |

## 11. rail 変更前後（§13）

| | before | after |
|---|---|---|
| major | `#5b6472` | **`#515966`** |
| urban | `#64709e` | **`#586590`** |
| local | `#7c8490` | **`#6f7783`** |

道路 `#9096a0`（0.62）より濃く、黒くはしない。`LineSegments` 方式・merge は不変。

## 12. FAR / MID / NEAR の style 値（§11 / §9）

| band | 建物 whiten | 実効「白寄り度」（中間基色から） | GLOBAL 地図 tile |
|---|---|---|---|
| FAR | **0.55** | 全体把握・淡め（ただし用途色は残る） | far tile（tolM 12m） |
| MID | **0.30** | 用途色が認識できる | mid tile（tolM 6m） |
| NEAR | **0.12** | 用途色が明確（白くしすぎない） | GLOBAL=mid / 建物=near |

`near(0.12) < mid(0.30) < far(0.55)` 単調。LOD 切替は camera 3,500 / 9,000m + hysteresis ±420m（FIX7）。
基色が同一なので band 間の「色の急変」は「淡さの差」のみ（別 tile なので元々の LOD 差と同程度）。

## 13. performance 影響（§21）

- **mesh 数 / drawCall / tile 数 / vertex 数: 完全に不変**（color / opacity / light intensity / exposure は値の差し替え）
- 新規 material なし（共有 bucket が新色で生成されるだけ・個数同じ）
- `update()` に drift チェック（`Math.abs` 比較 3 回 + 稀に代入）— 実質ゼロコスト
- `__CANONICAL_STYLE_DIAGNOSE__()` は呼んだ時だけ動作（常時実行なし）
- outline / shadow map / 個別ライト追加なし → §14 の立体感は **directional shading のみ**で実現

## 14. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

FIX8B チェック（全て期待値）:
`contrastPaletteStronger` true / `buildingBaseMidtone` true（CR パレットから pale 廃止）/
`buildingWhitenReduced` true（.55/.30/.12）/ `nearWhitenBelowMid` true /
`canonicalStyleOwnership` true（CR_STYLE + hemi/sun 適用 + toggleOldLayers 連動）/
`legacyStyleDoesNotOverrideCanonical` true（restore で hemi/sun/fill/exposure 復元）/
`styleReassertOnDrift` true（§18）/ `styleDiagnoseAvailable` true（§4）/
`styleOnlyNoGeometryChange` true
＋ FIX2〜FIX8 の全チェック維持。perf validator も PASS（payload 不変）。

## 15. npm test

**1,295 tests / 1,280 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` を FIX8 5 件 → **FIX8B 8 件**に差し替え:
  基色の中間トーン化（pale 廃止・カテゴリ不変）/ FAR>MID>NEAR whiten / style profile 適用・可逆 /
  drift 再適用 / 白飛び診断 / lighting 対応 material / geometry・mesh 不変 / getDebug style
- `tests/mission07-building-white.test.js` / `mission09-building-ao.test.js` /
  `mission17-background-boundary.test.js` / `mission18-fog-lighting.test.js` 影響なし
  （legacy `MS_BUILDING_BLEND` / lights の**既定値**は不変。CR が実行時に一時的に下げ、legacy 復帰で戻す）
- smoke 3/3 PASS
- production / protected hash 不変、`git diff --check` clean

## 実機で何が明確に変わるか（§19 / §20）

代表地点（北区広域 / 梅田 / 大川 / 中之島 / 十三 / 住吉）で:

1. **建物用途色が分かる** — オフィス街（梅田）が青系、商業が琥珀、住宅街が暖色オーカーで区別できる
2. **道路が地表から分離** — `#9096a0` の medium gray が明るい地表（`#f3f4f1`）から明確に浮く
3. **河川が一目** — 大川・淀川が `#6fb3d4` の cyan で引き画面でも骨格として見える
4. **鉄道が道路と区別** — `#515966` の濃い線
5. **近景に白い fog veil がない** — ambient を hemi 1.02 → 0.60 に下げたため均一な白ワッシュが消える
6. **建物側面に立体感** — sun 1.08 → 1.34 で NdotL 陰影が出る（影 map なし）
7. 夜モードは暗いまま（CR profile を強制しない）、`__SET_CANONICAL_RUNTIME__(false)` で
   lighting・exposure が legacy 既定へ戻る
8. `window.__CANONICAL_STYLE_DIAGNOSE__()` の `conclusion` が
   「clip 域外。palette / exposure は適正レンジ」になっていること

---

## 完了基準（§20）

- [x] 白飛びの直接原因を特定（明るい基色 × 強照度 → ACES 脱色）
- [x] 二重 white blend の否定（単一 blend・legacy ModelStyle 非干渉を確認）
- [x] 建物用途色が明確に出る基色 + whiten（実機目視は §19）
- [x] 道路が地表から分離する色
- [x] 河川が一目で分かる cyan + opacity 0.96
- [x] 鉄道が道路と区別できる色
- [x] 近景 fog veil の除去（ambient 低減）
- [x] 建物側面の立体感（directional shading・outline なし）
- [x] canonical style ownership 正式化（drift 再適用・可逆）
- [x] Console 不要の白飛び診断
- [x] mesh / drawCall / tile 数 不変
- [x] npm test 0 fail / validator PASS
- [x] production / protected unchanged
- [ ] **実機スクリーンショットで §20 の 6 項目を確認（ユーザー）**

**次工程へ進みません。実機で白飛びが解消したか確認をお待ちします。**
