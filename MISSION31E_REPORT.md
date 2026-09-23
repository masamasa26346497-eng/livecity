# Mission 31E 報告 — Canonical Geometry Conflict Resolution

結論: canonical layer 間の全 HIGH conflict（395 件）を分類し、
**EXPLAIN 118 / RECLASSIFY 23 / MANUAL_REVIEW 249（§17 に明示）→ 未分類 HIGH 0** に振り分けた。
geometry 補正は **1 件のみ**（安治川の港湾ベイスン分離・追跡可能・可逆）。
「overlap を 0 にする」ことは目的にしていない。CRITICAL 0。npm test fail 0。描画は不変。

---

## 1. pair 別 before / after（§21）

| pair | before 件数 | after 件数 | before unexplained HIGH | after 未分類 HIGH | EXPLAINED | RECLASSIFY | MANUAL_REVIEW |
|---|---|---|---|---|---|---|---|
| BUILDING_WATER | 142 | **144** | 47 | **0** | 6 (HIGH) + 全 MEDIUM | 0 | **42** |
| BUILDING_ROAD | 10,211 | 10,211 | 242→237※ | **0** | 112 (HIGH) + 8,784 MEDIUM | 0 | **125** |
| BUILDING_RAIL | 10,565 | 10,565 | 0 | **0** | 全件 | 0 | 0 |
| PARK_BUILDING | 1,082 | 1,082 | 110 | **0** | 5 (HIGH) + 362 MEDIUM | **23** | **82** |
| ROAD_WATER | 106 | **108** | 0（全 INFO） | 0 | 全 108 INFO | 0 | 0 |
| **合計** | 22,106 | 22,110 | 399→395 | **0** | 10,073 | 23 | **249** |

- ※ 31E で conflict audit の高架判定を PLATEAU `sectionType` / `elevated` qaFlag / OSM `layer>0` へ拡張し、
  BUILDING_ROAD unexplained HIGH が 242→237 に減（`building-over-elevated-road` として EXPLAIN）。
- BUILDING_WATER +2 / ROAD_WATER +2 は 安治川 補正で分離した harbor feature が近傍建物・道路と重なるため（正常。tracked）。
- **CRITICAL: before 0 / after 0**
- baseline snapshot: `data/reports/baselines/canonical-conflicts-31E-before.json` + `.md`

## 2. Building∩Water HIGH（48 件）の処理

全件 named river/canal + PLATEAU 施設建物（消防署・学校・大学・官公庁・事務所）。
overlapping building は footprint の 30〜90% が水域 polygon 内に入る一方、水域側の被覆率（frac）は 0.08〜0.31。
= 岸の建物前面が水域 polygon の陸側エッジに取り込まれている。

| 判定 | 件数 | cause | 理由 |
|---|---|---|---|
| EXPLAIN | 6 | `osm-water-boundary-imprecision` | frac < 0.15 の縁のかすり。OSM riverbank polygon（conf 0.90）の陸側エッジが PLATEAU footprint（conf 0.95）より粗いだけ。建物の水上実侵入ではない。 |
| MANUAL_REVIEW | 42 | `possible-osm-water-boundary-error` | frac ≥ 0.15。OSM 水域 polygon の陸側過剰包含か建物 footprint 誤りかを自動判別不能。**水域も建物も clip しない**（§0）。 |

MANUAL_REVIEW 42 件は此花区(5)・港区(4)・城東区(3) に集中。対象河川: 大川・寝屋川・道頓堀川・平野川・住吉川 等。
**推奨 evidence**: GSI 基盤地図情報 水涯線 / 公的河川区域データ取得 → 一括是正可能（31F 以降）。
confidence 差（建物 0.95 > 水 0.90）から「建物を削る」根拠は無い（§12: confidence だけで clip しない）。

## 3. Building∩Road HIGH（237 件）の処理

31C2 で PLATEAU tran 道路区域 = 法的区域界（車道＋歩道＋前面を含む道路敷地）と確定済み。
同一出典（PLATEAU building）がその区域界まで footprint を持つのは境界解釈差であって地図の矛盾ではない。

| 判定 | 件数 | cause |
|---|---|---|
| EXPLAIN | 36 | `plateau-road-area-frontage-overlap`（road polygon の < 40% のみ重なる縁の frontage） |
| EXPLAIN | 76 | `plateau-wide-road-area-frontage-overlap`（御堂筋・谷町筋等 幅広歩道の幹線。最深建物でも区域内 < 50%） |
| MANUAL_REVIEW | 125 | `central-arterial-road-area-building-block-overlap` |

MEDIUM 8,784 件は `plateau-building-tran-road-boundary-overlap` として一括 EXPLAIN（同一出典間の系統的境界重なり・個別 review 不要）。

**MANUAL_REVIEW 125 件は 1 つの systematic finding**（`canonical-manual-review.json` の `systematicFindings`）:
- 中央区(18)・北区(9)・住之江区(9) の幹線（谷町筋・長堀通・上町筋・土佐堀通・あびこ筋）に集中
- 最深建物が road 区域内 ≥ 50%、frac ≥ 40%、1 区画あたり最大 27 棟が重なる
- 根本仮説: PLATEAU tran 道路区域が**都市計画決定幅**で描かれている／PLATEAU tran と bldg の**位置系に系統ずれ**
- **sectionType が市域 42.7% 不明のため、不明を高架と決め打ちしない（§8）**
- 推奨 evidence: 航空写真 + 当該 tran:Road の `uro:sectionType`/`uro:width` 精査 + 同一街区の bldg/tran 位置整合（グループで 1 結論）

## 4. Park∩Building HIGH（110 件）の処理

全件 `leisure=park` polygon。建物総面積 ÷ 公園面積（buildingShareOfPark）で判定。

| 判定 | 件数 | cause | 内容 |
|---|---|---|---|
| RECLASSIFY | 23 | `park-polygon-not-a-park` | share > 0.8（建物が公園面積の 80% 超）。実質「街区」であり公園ではない。 |
| MANUAL_REVIEW | 82 | `park-polygon-possibly-too-broad` | share 0.35〜0.8。OSM park polygon が隣接街区を巻き込む可能性。 |
| EXPLAIN | 5 | `park-facility` | share < 0.35。公園内施設。 |

MEDIUM 362 件は `park-facility-or-minor-overreach` として一括 EXPLAIN。

RECLASSIFY 23 件は **parks correction advisory** として出力:
`data/processed/osaka-city/canonical/corrections/parks/park-polygon-reclassify-advisory.json`
（`reviewStatus: ADVISORY_PENDING_31F` — canonical parks build（31F）が境界再導出 or confidence 引き下げで honor する）。
canonical parks レイヤーは未構築のため 31E では geometry 補正を適用しない。

## 5. Building∩Rail

**regression のみ**。before HIGH 0 / after HIGH 0 維持。
subway → `underground` / 大型建物 → `station-building` / その他 → `elevated-rail-or-alignment` の EXPLAINED を維持。
geometry correction は一切していない（§9）。

## 6. Road∩Water

**regression のみ**。before 106 / after 108（全件 INFO）。
+2 は 安治川 補正で分離した harbor feature を橋が渡るため（`bridge` として INFO）。
PLATEAU road polygon 化後に新規 unexplained overlap は発生していない
（Road∩Water は OSM centerline で計算・bridge/culvert/river-crossing で全件説明済み・clip なし）。

## 7. 大川 確認結果（§5）

- canonical water polygon: `cg_water_river_x_water_8f1a2570d2d177` / 379,549 m² / `osm-riverbank` / conf 0.90 / **31B の ribbon→riverbank polygon 化は維持**、31E で補正なし（`polygon-much-larger-than-ribbon` フラグ無し = 過大包含なし）
- 近傍 conflict 1,044 件（HIGH 43 / MANUAL_REVIEW 24）: BUILDING_ROAD 951（大半 frontage EXPLAIN）、BUILDING_WATER 21、PARK_BUILDING 72
- 水面内に残る建物: **1 件のみ MANUAL_REVIEW**（`BW_32f5f6c9d5b4594d` / 大川 / 97,664 m² / 小中学校が footprint の 87% 水域内）。
  他の中之島側河川（堂島川・土佐堀川）の建物は frac < 0.15 で `osm-water-boundary-imprecision` として EXPLAIN。
- 結論: 大川本体の polygon は健全。残る 1 件は OSM riverbank polygon の陸側エッジが桜宮側の学校敷地を取り込んでいる疑い → 水涯線データで確認。**建物は削らない**。

## 8. 安治川 確認結果（§6）＋ 実施した補正

31B の `polygon-much-larger-than-ribbon(要確認)` フラグを検証:
- 元 polygon: MultiPolygon 8 parts / 1,997,146 m²（centerline 長 ~3km に対し平均幅 ~490m ＝ 過大）
- **centerline topology 分析**: 8 parts のうち 6 parts は centerline 頂点を 2〜65 個内包（最近傍 0〜39m）。
  **part 4（171,225 m²・centerline 頂点 0/113・最近傍 521m）と part 7（155,002 m²・0/113・98m）は独立水域**
  （此花区・港区の港湾ベイスン／ドックが OSM riverbank relation に誤統合されていた）

### 補正（§13/§14/§15）

`data/processed/osaka-city/canonical/corrections/water/anjigawa-harbor-split.json`

| 項目 | 値 |
|---|---|
| operation | `split-multipolygon-parts`（§15 許可 operation） |
| sourceEvidence | centerline-topology（見た目でなく位相根拠） |
| originalGeometryHash | `sha1:44822d9f…`（§14 可逆性ガード。元 geometry が変わると適用拒否） |
| 結果 | 安治川 6 parts / **1,670,920 m²**（-326,227 m² / -16%）、`polygon-much-larger-than-ribbon` フラグ解消 |
| 分離先 | `cg_water_harbor_anjigawa_split_0/1`（waterClass=harbor / name=null / conf 0.72 / provenance に `correction/…` 記録） |
| 可逆性 | 補正ファイルを削除して `build-canonical-water.js` 再実行で完全に元へ戻る。raw source（waterways-osm.json）不変。 |

残り 10 features の `polygon-much-larger-than-ribbon` フラグ（尻無川・正蓮寺川・左門殿川・木津川運河・福町堀 等 港湾影響河川）は
**MANUAL_REVIEW 相当**として `canonical-water-major-rivers.json` に温存。安治川ほど明快な centerline 非交差 part が無く、
一括分離は harbor 区域データ取得後（31F 以降）。

## 9. 実施した geometry correction

**1 件のみ**（上記 安治川）。他は correction を行わず EXPLAIN / MANUAL_REVIEW / RECLASSIFY advisory とした。

- clip small artifact / remove sliver: **0 件**（§16 sliver tolerance で overlap < 40m² or frac < 0.02 は自動 EXPLAIN。geometry は触らない）
- 建物の water/road からの削除: **0 件**（§0 遵守）
- road polygon の変形: **0 件**（§0 遵守）

## 10. reclassify 内容

| 対象 | 件数 | 内容 | 適用時期 |
|---|---|---|---|
| leisure=park polygon | 23 | `park-polygon-not-a-park`（建物 share > 80%）→ canonical parks build で境界再導出 or confidence 引き下げ | 31F（advisory） |
| 安治川 分離 part | 2 | waterClass: river → harbor | 31E（適用済み） |

## 11. manual review 件数（§17）

**249 件** — `data/reports/canonical-manual-review.json`

| systematic finding | 件数 | 集中エリア | 根本仮説 |
|---|---|---|---|
| `central-arterial-road-area-building-block-overlap` | 125 | 中央区・北区の幹線 | tran が都市計画決定幅 or tran/bldg 位置系ずれ。同一街区でまとめて検証 |
| `park-polygon-possibly-too-broad` | 82 | 西淀川区・城東区・天王寺区 | OSM park polygon が隣接街区を巻き込む。31F canonical parks で境界再導出 |
| `possible-osm-water-boundary-error` | 42 | 此花区・港区・城東区 | OSM 水域 polygon の陸側エッジが実水涯線より内陸。GSI 水涯線で一括是正可能 |

各 item に location（lon/lat）・ward・landmark・featureIds・causeCandidate・recommendedEvidence を付与。
**無理に解消せず、evidence 取得後に判断する**（§17）。

## 12. correction provenance

- 補正レコード **2 件**（水 1・公園 advisory 1）すべてに `correctionId` / `targetLayer` / `operation` / `reason` /
  `sourceEvidence.kind` / `createdBy` / `createdAt` を保持
- 適用済み補正（安治川）は `originalGeometryHash` を持ち、`canonical-water-build.json` の `corrections31E.applied` に記録
  （untracked correction 0）
- 派生 feature（split-off harbor 2 件）は `source.geometrySource` / `source.sourceIds`（`correction/corr_water_anjigawa_harbor_split` を含む）/
  `source.notes` を保持（provenance missing 0）
- **可逆**: 補正ファイル削除 → 再 build で元 geometry（hash 一致）に復帰。raw source は build が読むだけで書き込まない。

## 13. validator

`tools/validate/canonical-conflicts.js` = **PASS**

| check | 値 |
|---|---|
| CRITICAL | 0 |
| 分類後の未分類 HIGH | **0**（395 件すべてに action。MANUAL_REVIEW 249 は §17 に全件掲載） |
| MANUAL_REVIEW HIGH の manual-review.json 欠落 | 0 |
| invalid correction | 0 |
| untracked correction | 0 |
| provenance missing | 0 |
| destructive source edit | 0（補正対象外の water feature の geometry hash は baseline と完全一致・raw JSON 健全） |
| water correction 適用エラー | 0 |

回帰 validator（§23）: canonical-geometry / canonical-water / canonical-roads / canonical-buildings /
map-detail-audit / map-completeness / building-density / road-density / waterway-density / performance-budget
= **全て PASS**（canonical-roads/buildings は 31E で補正なし・再 build 不要のため validator のみ）。

## 14. npm test

**1,203 tests / 1,188 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- 新規 `tests/canonical-conflict-resolution.test.js` 9 件（補正の可逆性・hash ガード・全 HIGH に action・AUTO_DELETE 不使用・validator PASS・review GeoJSON・render 不変・Rail regression）
- 既存 `tests/canonical-buildings.test.js` の「Building∩Water baseline 142」assertion を、31E の tracked correction（+1〜2）を許容するよう更新
- smoke: `tests/ward-ux-v1-smoke.test.js` 3/3 PASS（production/protected baseline 含む評価停止なし）

## 15. GeoJSON 確認方法

`data/reports/canonical-conflicts-review.geojson`（CRS84 / Point / HIGH 全件 + MEDIUM 400 サンプル + INFO サンプル）

- QGIS 等で読み込み、`severity`（HIGH/MEDIUM/INFO）または `action`（EXPLAIN/RECLASSIFY/MANUAL_REVIEW）でカテゴリ分類表示
- `cause` でさらに絞り込み（例: `possible-osm-water-boundary-error` だけ表示 → 此花区・港区に集中が見える）
- `pairType` / `ward` / `landmark` / `featureA` / `featureB` / `overlapArea` / `confidenceA` / `confidenceB` を属性表示
- 代表地点別サマリは `data/reports/canonical-conflict-representative-qa.json`（大川・安治川・梅田・中之島・難波・天王寺・大阪城・十三・阿倍野・住吉・夢洲・南港 の 12 地点）

## 16. 31F へ進めるか

**進める条件は満たしている**:
- [x] 全 HIGH 分類完了（未分類 0）
- [x] correction provenance 100% / reversible
- [x] manual review list 生成（249 件・3 systematic findings）
- [x] review GeoJSON 生成
- [x] CRITICAL 0 / unexplained HIGH 原則 0（MANUAL_REVIEW は §17 明示）
- [x] validators PASS / npm test fail 0 / smoke PASS
- [x] production / protected / ward-ux-v1 render 不変

**31F へ引き継ぐ宿題**:
1. `possible-osm-water-boundary-error` 42 件 → GSI 基盤地図情報 水涯線 or 公的河川区域データで一括是正
2. `central-arterial-road-area-building-block-overlap` 125 件 → PLATEAU tran `sectionType`/`width` 精査で高架 or 位置系ずれを切り分け
3. `park-polygon-possibly-too-broad` 82 件 + RECLASSIFY 23 件 → canonical parks build で境界再導出
4. 安治川以外の 港湾影響河川 10 features → harbor 区域データ取得後に split 検討

---

**31F には自動で進まない。ユーザー確認を待つ。**
