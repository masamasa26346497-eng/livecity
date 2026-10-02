# Mission 31C2 報告 — PLATEAU tran:Road 取得 ＋ Canonical Roads Polygon 化

結論: **polygon-first へ移行完了**。canonical roads 199,658 feature のうち 198,266（99.3%）が
PLATEAU の実測道路区域面になった。31C で「polygon source が 1 件も無い」として保留していた
交差点の団子状膨張・OSM 欠測 3 区の道路 SOURCE_MISSING が、いずれも実データで解消した。

描画は一切変更していない（§0）。canonical は `data/processed/osaka-city/canonical/roads/` に閉じている。

---

## 1. baseline（31C/31D 時点）と現在

| 指標 | before (31C) | after (31C2) |
|---|---|---|
| canonical road feature | 42,547 | **199,658** |
| polygon geometry | 0 | **198,266** |
| ribbon fallback | 42,547 | **1,392** |
| polygon 被覆率（feature） | 0.0 | **0.993** |
| polygon 被覆率（延長） | 0.0 | **0.9941** |
| polygon 被覆率（面積） | 0.0 | **0.9891** |
| confidence 平均 | 0.665 | **0.917** |
| 幅を class 既定値で推定した feature | 36,051 | **1,323** |
| geometry SOURCE_MISSING の区 | 3（東淀川・淀川・旭） | **0** |
| schema error | 0 | 0 |

## 2. 取得（§3）

このサンドボックスはネットワーク不可のため、ローカルの配布 ZIP から展開した。

- 出典: PLATEAU 27100 大阪市 2025 年度 CityGML（`27100_osaka-shi_city_2025_citygml_1_op.zip`, 1.58GB）
- ライセンス: **CC BY 4.0**（出典: 国土交通省 Project PLATEAU）
- 展開: `udx/tran/*_tran_6697_op.gml` **288 file / 495.5MB** ＋ codelists 295 件
- 記録: `data/raw/plateau/osaka-city/tran/source-metadata.json`（出典 / 年度 / 市コード / ZIP 名 / 展開日時 / CRS / ライセンス）
- ツール: `tools/extract-plateau-tran.js`（`tools/lib/zip-reader.js` は ZIP64 対応の中央ディレクトリ読取。ZIP 全体を展開しない）

## 3. 実データ schema（§5・推測を排して実測）

サンプル 1 枚だけで判断すると誤るため、288 file 全件を走査した。

```
tran:Road [gml:id]                                     199,162
 ├ tran:function        → Road_function.xml            行政種別（面種別ではない）
 ├ uro:sectionType      → RoadStructureAttribute_...   構造区分
 ├ tran:lod1MultiSurface                               199,162（全 Road にある）★
 └ tran:trafficArea / auxiliaryTrafficArea (lod3)      888（0.4%）
```

- `srsName = EPSG/0/6697`、`srsDimension="3"`、posList は **lat lon alt**
- `gml:interior`（穴）1,263 件 → Polygon 単位で exterior/interior を対応させる実装にした
- **当初の想定は外れた**: 事前に書いていた converter は `tran:TrafficArea` による車道/歩道細分と
  `1000=roadway/1020=sidewalk` という code 表を前提にしていたが、実データでは
  TrafficArea は 0.4% しか無く、code 表も配布同梱 codelist と全く違った。converter は全面的に書き直した。

### 確定した codelist（配布 ZIP 同梱が正本）

- `Road_function`: 1 高速自動車国道 / 2 一般国道 / 3 都道府県道 / 4 市町村道 / 10–15 建基法42・43条 / 9000 未調査 / 9010 対象外 / **9020 不明**
  - 市域分布: 9020 が 194,135（97.5%）、3 が 2,918、2 が 1,371、1 が 738
- `RoadStructureAttribute_sectionType`: 1 土工/通常 / 2 高架橋 / 3 橋梁 / 4 交差部 / 5 アンダーパス / 6 トンネル / 7 橋・高架 / 9 不明
  - 市域分布: 1 が 112,323、**9（不明）が 85,703**、7 が 1,031、6 が 90、4 が 14、3 が 1

## 4. §7 道路面の定義（この配布での確定事項）

canonical road geometry = **`tran:Road` の `lod1MultiSurface`（道路区域＝車道＋歩道を含む道路敷地）**。

- 全 Road に一様に存在し被覆が揃うため、これを唯一の polygon source とした。
- TrafficArea(lod3) は**採用しない**。同じ Road の内側を細分した別 LOD なので、lod1 と併せて出すと
  同一面を二重計上する（§14）。件数のみ記録した。
- **トンネル区間（sectionType 6, 90 件）は地表の道路面ではない**ため `surfaceKind='subsurface'` として
  canonical から除外した。高架は除外せず、地表面と区別できる属性を付けて残す。

## 5. 変換結果（§8）

`data/processed/osaka-city/canonical/roads-tran/polygons.json`（122MB, gitignore）

- 198,626 polygon（roadSurface 198,536 / subsurface 90）
- 除外: zero-area 369 / self-intersection 167 → **invalid 率 0.269%**
- 行政種別内訳: 不明 193,622 / 都道府県道 2,908 / 一般国道 1,364 / 高速自動車国道 732

## 6. §30 STOP 条件の判定 — 全項目 PASS

`data/reports/plateau-tran-coverage.json` = **READY-FOR-POLYGON-FIRST**

| check | しきい値 | 実測 | |
|---|---|---|---|
| geometry CRS を確定できるか | — | EPSG:6697 → znorth-neg-v1 | PASS |
| 別位置系との不整合が無いか | 市域 extent と交差 | bbox (-13908, -18579)–(6952, 2208) | PASS |
| 市全域を十分カバーするか | 24 区 | **24/24 区** | PASS |
| 〃（格子被覆） | ≥ 0.55 | **0.9951** | PASS |
| polygon invalid 率 | ≤ 0.05 | **0.0027** | PASS |
| OSM との位置差 | 中央値 ≤ 8m | **0m**（p90 も 0m） | PASS |
| OSM 対応なしの割合 | ≤ 0.35 | **0.006** | PASS |

OSM centerline のサンプル点の **94.0% が tran polygon の内側**に落ちる。年度・位置系の不整合は無い。

## 7. Canonical 化の構造（§11/§13/§14）

**polygon 起点の 3 パス構成**にした。ここが今回いちばん重要な設計判断。

- pass A — centerline ごとに tran polygon を空間 match し、`polygon → 通っている centerline 群` の索引を作る
- pass B — **polygon 起点で 1 枚 = 1 feature**。属性は対応 centerline から join
- pass C — polygon で表現されなかった centerline のみ ribbon fallback

最初は road 起点（centerline がその線の通る polygon 群をまとめて採用）で実装したが、
交差点や並行道路の面を複数の道路が同時に採用して道路面積が水増しされ、
Building∩Road の計数まで狂うことが判明したため反転させた。
この方針は `POLYGON_ADOPTION_POLICY` として設計正本（`canonical-geometry-schema.js`）に記録した。

- canonicalId は PLATEAU `gml:id` 由来 → 再生成しても不変（§13）
- 無制限 union をしない（§14）。source polygon をつなぎ合わせて 1 枚にすることはしない

### §24 confidence の再設計

geometry の出所は 3 段階とも同一の公的実測面。差は「OSM centerline による独立検証がどれだけ効いたか」。

- `PLATEAU_ROAD_POLYGON_VERIFIED` 0.95 — match STRONG（72,144 feature）
- `PLATEAU_ROAD_POLYGON_PARTIAL` 0.92 — match MEDIUM（2,410 feature）
- `PLATEAU_ROAD_POLYGON_UNVERIFIED` 0.90 — 対応 centerline なし（123,712 feature）

## 8. §15 交差点 before / after

同一地点・同一 centerline から ribbon を作り直して比較（`canonical-road-intersection-compare.js`）。
半径 120m を 1m 格子で走査し、道路面が 2 枚以上重なった面積を数える。

| 交差点 | before 重複 | after 重複 |
|---|---|---|
| 梅田新道（御堂筋×国道2号） | 362 m² | **0 m²** |
| 本町（御堂筋×中央大通） | 198 m² | **0 m²** |
| 難波（御堂筋×千日前通） | 401 m² | **0 m²** |
| 天王寺（あべの筋×国道25号） | 674 m² | **0 m²** |
| 森ノ宮（中央大通×玉造筋） | 489 m² | **0 m²** |
| 西九条（此花通×国道43号） | 31 m² | **0 m²** |
| 長居（長居公園通×あびこ筋） | 174 m² | **0 m²** |
| 十三（十三筋×新御堂筋） | 111 m² | **0 m²** |
| **合計** | **2,440 m²** | **0 m²** |

ribbon 特有の「同一路面の多重帯」は 8 地点すべてで消えた。

## 9. §16 主要道路 QA

8 路線すべてが実測の道路区域面になった。31C で feature 0 だった国道1号も 106 feature を得た。

| 路線 | feature | うち polygon | polygon 面積 |
|---|---|---|---|
| 御堂筋 | 165 | 164 | 284,913 m² |
| 新御堂筋 | 77 | 77 | 126,363 m² |
| 中央大通 | 220 | 220 | 579,229 m² |
| 長居公園通 | 143 | 143 | 151,320 m² |
| 国道1号 | 106 | 106 | 81,011 m² |
| 国道25号 | 235 | 235 | 257,139 m² |
| 国道43号 | 192 | 192 | 360,576 m² |
| 阪神高速 | 1,173 | 1,162 | 2,363,504 m² |

## 10. §17 高架・橋梁・トンネル

`data/reports/canonical-road-structure.json` = **PASS**

- トンネル 90 件は convert 段階で地表面から除外済み。canonical 内のトンネル道路面は **0**
- 高架 1,015 / 交差部 14 / 橋梁 1 を `plateauStructure` と qaFlags で地表面と区別できる状態にした
- 阪神高速 1,173 feature のうち 877 を高架/橋梁と識別（PLATEAU sectionType または OSM bridge/layer）

**限界（推測で埋めない）**: 高架路線名を持つ 309 feature は PLATEAU sectionType が「不明」かつ
OSM にも bridge/layer タグが無く、地上ランプ・側道の可能性があるため高架と断定しない。
canonical 全体の **42.7% が sectionType 不明**であることが根本原因。

## 11. §18 Building∩Road / §19 Road∩Water

| | before (31D) | after (31C2) |
|---|---|---|
| BUILDING_ROAD 件数 | 4,476 | 10,211 |
| うち unexplained HIGH | 478 | **242**（−49%） |
| ROAD_WATER | 106（全 INFO） | **106（全 INFO）** |

件数が増えたのは、検査対象（major/mid tier）の道路 feature が 16,653 まで増え、かつ道路区域が
推定幅の帯から歩道を含む実面積に変わったため。同じ土地をより正確に表現した結果として
接触が増えている。**品質指標である unexplained HIGH は 478 → 242 と半減**した。

- 阪神高速の上の建物は `roadLayer=3 / bridge=true` から `building-over-road` として INFO 判定され、
  §17 の構造属性が conflict 判定まで正しく効いている
- 最大の HIGH は「市道南北線」（道路区域 26,451m² の 68.5% を 500 棟の PLATEAU 建物が覆う）。
  PLATEAU 建物と PLATEAU 道路区域という**同一出典どうしの不一致**であり、OSM 位置ずれではない。
  道路区域は舗装縁ではなく法的な区域界なので、区域内に建物が建ちうる。31E 以降の検討対象
- Road∩Water は 106 件で不変、全件 bridge/river-crossing/culvert として説明済み（clip していない）

## 12. §20/§21 区別 SOURCE_MISSING の再評価

`data/reports/canonical-road-ward-sources.json` = **GEOMETRY-COMPLETE**

geometry と attributes の source を分けて評価した。これが §21 の核心。

| 区 | geometry | polygon 数 | OSM 属性率 | attributes |
|---|---|---|---|---|
| 東淀川区 | **PASS (PLATEAU tran)** | 12,687 | 0.038 | MOSTLY_MISSING |
| 淀川区 | **PASS (PLATEAU tran)** | 11,859 | 0.305 | PARTIAL |
| 旭区 | **PASS (PLATEAU tran)** | 6,844 | 0.476 | PARTIAL |

- **geometry が SOURCE_MISSING の区はゼロになった**（24/24 区で道路区域面を取得）
- 原因の切り分け: `osaka-latest.osm.pbf` が lat≈34.735 で bbox clip されており、
  北部 3 区に OSM 道路が存在しない。これは取り込みバグではなく source 側の範囲制約
- 属性が無い feature は名称・車線数を捏造せず `attributes-source-missing` を立てた（§0）

## 13. §28 validator 拡張

`data/reports/canonical-road-validation.json` = **PASS**

`plateau-tran-road` feature を 2 系統に分けて検査するようにした。

- OSM 対応あり → `centerlineRef` と `osmMatchQuality`(STRONG/MEDIUM) が必須
- OSM 対応なし → `attributes-source-missing` + `osm-match=none` の明示が必須。加えて
  **centerlineRef を持たないこと / OSM 属性(name, highway)を持たないこと / PLATEAU 属性を持つこと**を検査
  （属性の捏造を validator で機械的に弾く）

全 check が 0: schemaErr / invalidPoly / bboxViolation / provMissing / confInvalid / sourceIdsEmpty /
unknownGeometrySource / plateauNoCenterlineRef / plateauNoMatchQuality / centerlineMismatch / majorMissing

## 14. §29 回帰

- `tests/canonical-roads.test.js` の 6 テストは 31C 当時の「polygon coverage 0 / 全 ribbon」を
  固定していたため、31C2 の実態へ rebase した。あわせて **二重計上を検出する新テスト**を追加
  （同じ tran polygon が 2 度 feature 化されていないか / polygon と ribbon が同じ道路で重複していないか）
- `tests/plateau-tran-convert.test.js` は投機的な code 表を検証していたため、配布同梱 codelist 準拠に全面書き直し（12/12 pass）
- HTML は本ミッションで一切変更していない。production / protected / ward-ux-v1 いずれにも
  canonical roads 参照は無い（validator が機械的に確認）

## 15. §0 遵守

| 禁止事項 | 状況 |
|---|---|
| production HTML 変更 | していない |
| protected HTML 変更 | していない |
| ward-ux-v1 描画切替 | していない（RoadLayer 不変・canonical 参照なし） |
| projection 変更 | していない |
| znorth-neg-v1 変更 | していない |
| PLATEAU road polygon を見た目だけで採用 | していない。§30 の 7 項目を数値判定してから採用 |
| OSM centerline を捨てる | 捨てていない。属性の PRIMARY source ＋ centerlineRef として保持 |
| 建物を road から clip | していない |
| source missing 道路 polygon の架空生成 | していない。属性欠測は `attributes-source-missing` で明示 |

## 16. 残課題

1. rank1 の**公的道路区域**（GSI 基盤地図情報「道路縁」/ 大阪市道路台帳）は未取得。PLATEAU より高精度なら将来差し替える
2. sectionType が市域の 42.7% で「不明」。高架の完全判別には別 source が要る
3. 東淀川区・淀川区・旭区の OSM 属性欠測は広域 PBF 取得と連動（geometry は解決済み）
4. PLATEAU 建物 ∩ PLATEAU 道路区域の HIGH 242 件の意味付け
5. 描画への反映は 31G 以降

---

**31E には自動で進まない。ユーザー確認を待つ。**
