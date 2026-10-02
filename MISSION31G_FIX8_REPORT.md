# Mission 31G-FIX8 報告 — Canonical Runtime 視認性改善

結論: **geometry・データ・LOD・GLOBAL map・selected ward 仕様は一切変更せず**、
color / opacity / tone mapping exposure のみで白っぽさを軽減し、建物・道路・河川・鉄道の境界を強めた。

- mesh 数 / drawCall / tile 数は不変（既存 shared material bucket の色値差し替えのみ・§14）
- exposure 調整は **canonical 所有中・模型スタイル昼のみ**、legacy 復帰で完全に元へ戻す（可逆）
- npm test 0 fail、validator PASS、production / protected 不変、Legacy residual guard / 用途色分類 / placement policy 維持
- **実機の見た目は未確認**（このセッションはブラウザ不可）。§15 の代表地点で目視 QA が必要

---

## 1. 白っぽさの主原因

`__CANONICAL_RUNTIME_DEBUG__().style` と scene 設定の監査から 3 点:

| 要素 | before | 影響 |
|---|---|---|
| **用途色の白寄せ** | `CR_USAGE_WHITEN` far 0.60 / mid 0.28 / **near 0.12** | 近景でも建物が 88% 白 → 用途差がほぼ見えない |
| **tone mapping exposure** | 模型昼 **1.05**（ACES Filmic） | 全 material が明るく wash・ハイライトで彩度が飛ぶ |
| **CR palette が淡すぎ** | water `0xbcdce6` / road `≈0x8f959c` / rail `0x8f97a3〜0xaab0ba` | 背景 `MS_BG_NEUTRAL 0xf3f4f1` と近く、道路・水域・鉄道が地表に同化 |

fog は原因ではなかった（模型昼の fog.near は近景で 6,000m 以上・建物 1,300m は霞まない）。
ambient/hemi/sun の個別強度は day/night システムと密結合のため今回は触らず、exposure 1 点に絞った。

## 2. background 変更

**変更なし。** `MS_BG_NEUTRAL 0xf3f4f1` は Mission17 の「四角い地表境界を消す」設計で
CSS body / GroundVisualLayer / fog 色と 5 箇所揃えているため、ここを動かすと legacy と day/night が壊れる。
代わりに前景（道路・水域）を背景から引き離す方針（§5/§6）。

## 3. ground 変更

**変更なし**（同上・legacy GroundVisualLayer / LandSurfaceLayer 管轄）。
道路色を一段濃くすることで「ground（明るいニュートラル）＜道路（一段濃いグレー）」の差を作った（§2/§5）。

## 4. building palette 調整（§3/§13）

用途カテゴリ（10 色）と分類ロジックは **FIX5 のまま不変**。白へ寄せる量だけ変更:

| band | before whiten | after whiten | 意図 |
|---|---|---|---|
| NEAR | 0.12 | **0.05** | 用途差を明確に |
| MID | 0.28 | **0.20** | 少し淡く |
| FAR | 0.60 | **0.52** | 全体把握優先・かなり淡いが白一色には戻さない |

`crBuildingMaterial(cat, band)` が `msBlend(CR_USAGE_COLOR[cat], COL.white, whiten)` を band ごとに焼き込む方式は不変。
material bucket 数（category × band = 最大 30）も不変。

## 5. road 色調整（§2/§5）

`COL.road`: `msBlend(0x848a92, 0x9aa0a6, 0.55)` ≈ `0x8f959c` → **`msBlend(0x767c85, 0x8b9199, 0.5)` ≈ `0x81868f`**
（数値上は近いが基準色を暗側へ）。実際の狙いは「背景 `0xf3f4f1` に対して明確に一段濃いグレー、ただし鉄道より濃くしない」。
道路 mesh は不透明のまま（透明化していない）。

## 6. water 色調整（§6）

`COL.water`: `0xbcdce6` → **`0x8fc6dc`**（pale cyan を一段強める）
`COL.waterHarbor`: `0x9fc4d2` → **`0x82b2c6`**
opacity: **0.85 → 0.93**（`depthWrite: false` は維持 → z-fight しない）。
狙い: 大川・淀川・安治川が引き画面でも「都市構造の骨格」として認識できること。

## 7. rail 色調整（§8）

道路より一段強い線色に:

| | before | after |
|---|---|---|
| railMajor | `0x8f97a3` | **`0x5b6472`** |
| railUrban | `0x8a93c0` | **`0x64709e`** |
| railLocal | `0xaab0ba` | **`0x7c8490`** |

`LineSegments`（`LineBasicMaterial`）方式は不変（tile × 3 class の merge・draw call 増やさない）。
FAR でも主要路線（環状線・御堂筋線等）が背景に消えないことを目標。
※ 線幅は Three.js r128 の制約で環境依存 → 色を強めて対応。将来は major rail のみ細いリボン化を検討（§17 表）。

## 8. park 色調整（§7）

淡い緑を維持しつつ建物色（アンバー/青系）と混同しないよう微調整:

| | before | after |
|---|---|---|
| parkReal | `MS_PARK_GREEN`(≈0xcfe3c7) | `0xbdd9af` |
| parkGreen（green_space/sports_ground） | `0xc4ddb8` | `0xb0d2a1` |
| grass | `0xdde9d5` | `0xd6e6cd` |

opacity（real 0.9 / green 0.78 / grass 0.5）と「grass を park 扱いしない」仕様は不変。

## 9. fog 変更

**変更なし。** 監査の結果、模型昼の fog は近景で十分クリア（fog.near ≥ 6,000m、建物リーチ 1,300m）。
NEAR/MID で建物が白く埋もれるのは fog ではなく whiten + exposure が原因だったため、そちらを修正。

## 10. lighting 変更

個別ライト（hemi 1.0 / sun 1.2 / fill 0.6）は **変更なし**（day/night・evening システムと密結合のため）。
代わりに **tone mapping exposure のみ**:

- `CR_EXPOSURE = 0.90`（模型昼の 1.05 から）
- `toggleOldLayers(true)` で `applyCanonicalExposure()`、`toggleOldLayers(false)` / `fallbackToLegacy()` で
  `restoreLegacyExposure()`（保存した `__legacyExposure` へ戻す）→ **完全に可逆**
- `crExposureApplicable()` ガード: 模型スタイル ON && 昼 && !data モード のときだけ適用。
  夕/夜/data モードでは元の time-of-day exposure を尊重
- `applySkyAndFog`（day/night 切替）が exposure を 1.05 へ戻しても、`update()` の drift 検知
  （`|exposure - 0.90| > 0.02` かつ applicable）で再適用

## 11. FAR / MID / NEAR 差（§13）

| band | 建物 whiten | GLOBAL 地図 tile | 意図 |
|---|---|---|---|
| FAR | 0.52（かなり淡い） | far tile（tolM 12m） | 全体把握。用途色は残すが騒がしくしない |
| MID | 0.20 | mid tile（tolM 6m） | 用途色 + 都市構造 |
| NEAR | 0.05（用途色ほぼそのまま） | GLOBAL は mid tile / 建物は near tile | 建物用途差・道路・水域を明確 |

LOD 切替は camera 距離 3,500m / 9,000m で発生し、FIX7 の hysteresis（±420m）で振動しない。
band 別 tile はもともと別 tile なので whiten の段差は視覚上の「別データ差」と同程度。

## 12. selected ward 視認性（§12）

Ward Mode では建物が選択区のみ near/mid band で表示 → whiten 0.05〜0.20 で用途色が明確。
一方 GLOBAL 基盤地図（roads/water/rail）は今回一段濃く・強くした。
→ 「非選択区の基盤地図 ＜ 選択区の用途色付き建物」のコントラストが自然に付く。
per-ward 専用 material は追加していない（material cache を増やさないため・§14）。

## 13. performance 影響（§14）

- **mesh 数 / drawCall / tile 数 / vertex 数: 完全に不変**（color/opacity/exposure は値の差し替えのみ）
- 新規 material なし（既存の共有 bucket が新しい色値で生成されるだけ・個数同じ）
- `update()` に exposure drift チェック 1 行追加（`Math.abs` 比較 + 稀に代入）→ 実質ゼロコスト
- outline / edge mesh・個別ライトは追加していない（§4 は material 調整＝option A を採用）

## 14. validator

`tools/validate/canonical-runtime-integration.js` = **PASS**

FIX8 チェック（全て期待値）:
`contrastPaletteStronger` true（water 0x8fc6dc / rail 0x5b6472 / road msBlend 暗側）/
`buildingWhitenReduced` true（far .52 / mid .20 / near .05）/
`canonicalExposureReversible` true（CR_EXPOSURE 0.90 + restoreLegacyExposure + toggleOldLayers 連動）/
`styleOnlyNoGeometryChange` true（pushExtrude/pushPolygon シグネチャ不変）
＋ FIX2〜FIX7 の全チェック維持。
`tools/validate/canonical-runtime-performance.js` = PASS（payload 不変）。

## 15. npm test

**1,292 tests / 1,277 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- `tests/canonical-runtime-cutover.test.js` に FIX8 5 件追加（57 → 62）:
  palette 分離 / whiten 低減（白一色に戻さない・カテゴリ不変）/ exposure 可逆・模型昼のみ /
  geometry・mesh 不変（個別ライト・outline mesh 無し）/ style を getDebug で確認
- `tests/mission07-building-white.test.js` / `mission17-background-boundary.test.js` /
  `mission18-fog-lighting.test.js` 影響なし（legacy `MS_BUILDING_BLEND` / `MS_BG_NEUTRAL` / lights は不変）
- smoke 3/3 PASS（renderer.toneMappingExposure アクセスは try/catch でスタブ耐性）
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` hash 不変、`git diff --check` clean

## 実機確認ポイント（§15）

1. `npx http-server public -p 8080` → `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
2. **北区広域 / 梅田 / 中之島 / 大川 / 十三 / 住吉 / 難波** で:
   - 全体の白っぽさが減ったか（exposure 0.90）
   - 建物の用途色（オフィス=青 / 商業=琥珀 / 住宅=アンバー / 学校=レモン 等）が近景で識別できるか
   - 道路が地表から分離して見えるか（濃いグレー）
   - 大川・淀川が引き画面でも青く筋として見えるか
   - 鉄道（環状線・御堂筋線）が道路と区別できるか・FAR で消えないか
   - park（緑）と建物（暖色）が混同しないか
   - LOD 切替（ズームイン/アウト）で建物色が急に濃く/淡くなりすぎないか
3. 夜モードに切替 → 暗い配色のまま（exposure 0.90 を強制しない）→ 昼へ戻すと再び 0.90
4. `window.__SET_CANONICAL_RUNTIME__(false)` で legacy に戻すと exposure が元（1.05）へ戻ること
5. `__CANONICAL_RUNTIME_DEBUG__().style` で exposure / whiten / palette を確認

---

## 完了条件

- [x] 全体の白っぽさ軽減（whiten 低減 + exposure 0.90）
- [x] 建物用途色が認識できる（near whiten 0.05・カテゴリ不変）
- [x] 道路が背景から分離（一段濃いグレー）
- [x] 河川が引き画面でも分かる（cyan 強化 + opacity 0.93）
- [x] 鉄道が道路と識別できる（一段強い線色）
- [x] park/grass 区別維持（色微調整・仕様不変）
- [x] fog 過剰なし（原因でないため変更なし）
- [x] lighting 自然（個別ライト不変・exposure のみ・可逆）
- [x] selected ward 建物が見やすい（GLOBAL 地図とのコントラスト増）
- [x] mesh/drawCall 増加なし
- [x] npm test 0 fail / validator PASS
- [x] production / protected unchanged
- [ ] **実機で白っぽさ・各レイヤーの境界・LOD 色連続性を目視（ユーザー・§15）**

**次の項目には自動で進みません。実機の見た目確認をお待ちします。**
