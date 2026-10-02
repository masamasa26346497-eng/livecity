# Mission 31G-FIX6 報告 — 道路・河川上の建物表示を Canonical 基準で抑制

結論: **Building Placement Policy** を新設し、render visibility を precompute → runtime lookup で制御する。
**canonical / source geometry・building footprint・建物位置は一切変更していない**（§0/§9/§11）。
建物件数 615,617 は不変。抑制は「render で非表示」だけ。

- **Water**: footprint がほぼ完全に水面内（≥85%）の建物のみ SUPPRESS（4,549 棟 / 0.74%、うち 92% は ratio ~1.0）
- **Road**: 31E systematic finding #2（PLATEAU tran 道路区域面は実舗装より広い＝都市計画決定幅）を尊重し **auto-SUPPRESS しない**。97%+ 内包の 32,347 棟は REVIEW
- 31E の EXPLAIN / MANUAL_REVIEW 分類を再利用（§4）。推測だけで消さない
- npm test 0 fail、validator 2 本 PASS、production / protected 不変、Legacy residual guard 維持

---

## 1. placement policy 設計

新概念 `BuildingPlacementPolicy`（§1）。1 棟ごとに次のいずれかを付与:

| policy | 意味 | runtime |
|---|---|---|
| **DISPLAY** | 通常表示（既定） | 描画・pick 可 |
| **SUPPRESS** | 明確な水域侵入 | 描画しない・通常 pick 対象外（debug で確認可 §14） |
| **REVIEW** | 判断保留（証拠待ち） | **描画する**・pick 可・flag のみ |
| **EXEMPT** | 実在する立体交差・施設 | 描画する・pick 可 |

**パイプライン（§23/§24）**:
```
canonical buildings + canonical water + canonical roads + 31E conflict 分類
  → tools/build-building-placement-policy.js（footprint を 2m grid サンプルし overlap 比率を実測）
  → data/processed/osaka-city/derived/building-placement/tile_<tx>_<tz>.json   (tileSize 500)
  → tools/build-derived-public.js で public へ配置
  → runtime（CanonicalRuntime）は buildings tile と同じ tx/tz で lookup するだけ（毎フレーム intersection しない）
```
tile には非 DISPLAY（SUPPRESS/REVIEW/EXEMPT）のみ収録。DISPLAY は既定なので載せない → データ 16MB。

## 2. water suppress 条件（§2/§5/§6）

分布を先に算出（§5。footprint の水面内比率、615,617 棟）:

| waterRatio | 棟数 |
|---|---|
| 0（重なりなし） | 605,465 |
| <0.1 | 483 |
| 0.1–0.3 | 1,186 |
| 0.3–0.5 | 1,002 |
| 0.5–0.7 | 1,009 |
| 0.7–0.9 | 845 |
| **≥0.9** | **5,627** |

分布は明確に二峰性 — 建物は「ほぼ完全に水面内」か「ほぼ外」のどちらか。境界帯の建物は少ない。

**SUPPRESS 条件**（`building-major-overlap-with-water`）:
- `waterOverlapRatio ≥ 0.85`（footprint の 85% 以上が canonical 水面内）
- **かつ** `overlapAreaM2 ≥ 15`（数 m² の sliver は除外 §6）
- **かつ** 中州・島は除外（water polygon の hole を正しく処理。§7/§21）
- **かつ** waterClass が `harbor` でない（港湾構造物の可能性 → REVIEW）
- **かつ** semantic exempt（駅/橋/港湾/水門…）でない
- **かつ** 31E で EXPLAIN されていない・MANUAL_REVIEW でない

30–85% の部分重なり → **REVIEW**（OSM riverbank polygon は陸側を過剰包含しうる＝31E finding #1。推測で消さない §4/§6）。

## 3. road suppress 条件（§3）

**31E systematic finding #2 を尊重**: alignment consistency 0.104 の解析で「PLATEAU tran 道路区域面は
実舗装より広い（都市計画決定幅・道路敷地界）」と確定済み。よって **道路 polygon への部分的な重なりは
正常**（建物が道路に食い込んでいるのではなく、polygon が広い）。

- 30–97% の重なり → **DISPLAY / REVIEW**（`building-mostly-inside-road-area` 19,537 → REVIEW）
- 97%+ 内包（`building-almost-entirely-inside-road-area`）→ 暫定 SUPPRESS だが **総棟数の 1% を超えたら
  REVIEW へ一括降格**（§16）。実測 **32,347 棟が該当 → 全て REVIEW へ降格**
- → **road auto-SUPPRESS = 0**。道路上に「乗って見える」建物は REVIEW flag で追跡し、公的補正 source が
  得られた時点で geometry correction を検討（§9）。移動も一括非表示もしない（§0）

## 4. exception 条件（§2/§3/§4）

| exempt 理由 | 件数 | 判定 |
|---|---|---|
| `road-grade-separated` | 5,605 | 重なる道路が bridge / tunnel / underground / elevated / layer≠0 / plateauStructure∈{elevated,bridge,tunnel,underpass} |
| `31e-explain`（EXEMPT 化） | 700 | 31E action=EXPLAIN かつ resolvedCause∈{building-over-road, covered-road, over-water-structure, station-building, bridge, centerline-offset, boundary-rounding-sliver, …} |
| `over-narrow-waterway` | 82 | waterClass∈{canal,drainage,ditch} かつ ratio<0.6（暗渠・水路上建築） |
| semantic-structure | 0 | usageLabel が 駅/橋/高架/港湾/水門/… に一致（PLATEAU building の用途ラベルには該当語が無く 0 件） |
| **EXEMPT 計** | **6,387** | |

31E `MANUAL_REVIEW`（可能性: OSM 水域境界誤り 等）→ **REVIEW 維持**（916 棟。§4「原則 DISPLAY 維持」）。
31E `EXPLAIN` で exempt 対象外の cause → **DISPLAY**（`31e-explain` 1,230 のうち EXEMPT 化しなかった分）。

## 5. water suppress 件数（§5/§16）

**4,549 棟**（`suppressWater` 4,510 + `suppressBoth` 39）= 総 615,617 棟の **0.74%**。

ratio 内訳: **~1.0 が 4,196 棟（92%）**、0.95–0.99 が 54、0.9–0.95 が 148、0.85–0.9 が 151。
→ 大半が「footprint 全体が水面 polygon の中」。境界誤差レベルではない。

ward 分布（上位）: 城東 816 / 西淀川 706 / 生野 351 / 大正 338 / 鶴見 336 / 東淀川 207 / 港 200 …
（小河川・水路が多い区に集中。平野川・神崎川・第二寝屋川沿い）

## 6. road suppress 件数（§16）

**0 棟**（§3 のとおり 31E finding #2 を尊重し REVIEW へ降格）。
`provisionalRoadSuppress` 32,347 → 全て `roadDowngraded` → REVIEW。

## 7. both 件数

**39 棟**（水域と道路の両方に大きく重なる。SUPPRESS。water 側条件で成立）。

## 8. exempt 件数

**6,387 棟**（内訳は §4 の表）。

## 9. manual review 件数

- 31E `MANUAL_REVIEW` 由来の REVIEW: **916 棟**
- REVIEW 合計: **55,440 棟**（水域 partial 2,819 + road 内包 52,621。うち 32,347 は road 97%+ 内包の降格分）

## 10. 大川（および 淀川 / 安治川 / 中之島）結果（§7/§20/§21）

- **中之島**（北区、堂島川と土佐堀川の間）: SUPPRESS **0 棟**。中之島は 2 河川に挟まれた陸地であり
  water polygon の内側ではない。北区の SUPPRESS 178 棟は全て z≈-9,500〜-12,400（淀川・神崎川沿いの北部）で、
  中之島（z≈0 付近）には無い。
- water polygon の **hole（中州・島）を正しく除外**する処理を実装（33 の water feature が hole を持つ）。
  hole 未処理版と比べて 783 棟少ない = 島の上の建物を誤抑制しなくなった。
- 大川・安治川・淀川本流沿い: ratio ~1.0（水面 polygon に完全内包）の建物のみ SUPPRESS。
  河岸に接するだけ・部分的に重なるだけの建物は DISPLAY / REVIEW で残す。

**⚠ 実機での目視確認が必要**（このセッションではブラウザ実行不可）。特に暗渠上の住宅街が
帯状に欠けていないか（§15）。欠けが出たら threshold を 0.95 へ上げるか culvert 検出を追加する。

## 11. 道路結果（§8/§22）

- 御堂筋・中央大通・新御堂筋・国道 25/43 号・阪神高速 沿いで、道路面に「乗って見える」建物 →
  **REVIEW（表示は維持）**。31E で「tran 道路区域面が実舗装より広い」と確定しているため、
  建物を消すのではなく flag する。
- 道路沿いに接するだけの建物は一切触らない（§22）。
- 高架下・トンネル上の建物 5,605 棟は EXEMPT（立体交差として正常）。

## 12. source geometry 不変確認（§0/§9/§11）

- `data/processed/osaka-city/canonical/buildings/manifest.json` の `featureCount` = **615,617**（不変）
- placement tool は `data/processed/osaka-city/derived/building-placement/` にのみ書き込み。
  `canonical/` 配下は read-only（validator が canonical/buildings 配下に placement 生成物が無いことを確認）
- runtime（CanonicalRuntime ブロック）に feature 座標の代入・`fs.` 呼び出し・build 呼び出しは無い（test で検証）
- road / water polygon は建物回避のための変形をしていない（placement は polygon を読むだけ）
- 建物位置の offset は無し（§9）

## 13. performance 影響（§23）

- **毎フレームの intersection 計算は無し**。placement は precompute（オフライン ~11 分）。
- runtime は buildings tile ロード時に `building-placement/tile_<tx>_<tz>.json` を **1 度だけ** fetch
  （`placementTiles` で guard）。manifest に載っていない tile は fetch すらしない（404 を出さない）。
- SUPPRESS 分 mesh 頂点が減る（微減）。draw call・material bucket は不変（FIX5 の共有 material）。
- **実機フレームタイムはユーザー QA で要確認**。

## 14. validator

**2 本とも PASS**:

`tools/validate/building-placement-policy.js`（新規 §25）:
`missingId` 0 / `invalidPolicy` 0 / `duplicateId` 0 / `unexplainedAutoSuppress` 0 /
`thresholdInconsistent` 0 / `explainBuildingWronglySuppressed` **0** /
`canonicalBuildingCountUnchanged` true / `productionUnchanged` true / `protectedUnchanged` true /
`suppressFraction` 0.00739（< 2%。0.5% 超で WARN） /
`publicPublished` true

`tools/validate/canonical-runtime-integration.js`（§26 regression）: 全チェック期待値。
FIX6 追加: `placementPolicyLookup` true / `placementSuppressExcludesMesh` true /
`placementDebugApi` true / `placementSourceGeometryUnchanged` true。

## 15. npm test

**1,272 tests / 1,257 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- 新規 `tests/building-placement-policy.test.js`（19 件）: hole 処理 / policy 判定 / 31E 尊重 /
  データ整合 / runtime 統合 / source 不変
- `tests/canonical-runtime-cutover.test.js` に FIX6 5 件追加（33 → 38）
- smoke 3/3 PASS（インライン script 例外なし）
- §26 regression: canonical-buildings / -water / -roads / -conflicts / -runtime-integration /
  map-detail-audit / map-completeness / performance-budget いずれも PASS
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` hash 不変
- `git diff --check` clean、placement データは `.gitignore` 済み（derived/ 配下）

## 16. 次の修正へ進めるか

**実機確認待ち。** ユーザー QA（§20/§27）:

1. `npx http-server public -p 8080` → `http://localhost:8080/osaka_3d_buildings.ward-ux-v1.html`
2. 画面右下: `抑制 水4549 道0（可視 N / review …）`
3. **大川 / 淀川 / 安治川**: 水面上に建物が乗っていない。河岸の建物は残っている
4. **中之島**: 建物が消えていない（市役所・中央公会堂・オフィス群）
5. **住宅街（城東・西淀川の平野川・神崎川沿い）**: 帯状の欠け（暗渠上住宅の誤抑制）が無いか
6. **御堂筋・中央大通**: 道路面の建物は残る（REVIEW）が、明らかな乗り上げが気になるか
7. `window.__PLACEMENT_DEBUG__()` で SUPPRESS サンプルを確認可能

完了条件:

- [x] BuildingPlacementPolicy 実装（DISPLAY/SUPPRESS/REVIEW/EXEMPT）
- [x] Water overlap 判定（分布ベース threshold 0.85）
- [x] Road overlap 判定（31E finding #2 尊重 → REVIEW、auto-SUPPRESS 0）
- [x] 31E conflict 分類再利用（EXPLAIN→EXEMPT/DISPLAY、MANUAL_REVIEW→REVIEW）
- [x] exception 処理（高架/トンネル/水門/暗渠/駅）
- [x] source geometry 不変（615,617 棟・footprint・位置すべて）
- [x] 建物位置を移動しない
- [x] suppression metadata 生成（canonicalId / policy / reason / overlapRatio / conflictId）
- [x] runtime 適用（precompute lookup・毎フレーム計算なし）
- [x] Ward Mode / City Mode 両方に適用（ward filter → placement filter の 2 段）
- [x] 中之島 hole 処理（誤抑制回避）
- [x] 大量誤 SUPPRESS なし（0.74%・§16 の 2% 未満）
- [x] performance regression なし（precompute + 1回 lookup）
- [x] validator PASS（2 本）/ npm test 0 fail
- [x] production / protected unchanged
- [ ] **実機で大川/中之島/住宅街/道路 QA（ユーザー）**

**次の項目には自動で進みません。実機確認の結果をお待ちします。**
