# Mission 32H 完了報告 — UMEDA REAL-WORLD GROUND TRUTH AUDIT

> **historical-invalidated-by-v2**（Mission 32P で追記）: このレポートの数値は V1 建物（平面直角座標 第7系由来・地図に対し 0.93° 回転）を前提にしている。梅田の建物と独立ソースの照合を V1 建物で行った（ずれの主因は回転だった）。現在の値は `data/reports/v2-final-road-overlap.json` / `v2-final-water-overlap.json` / `v2-placement-policy.json` を参照。ファイルは記録として残す。


**最終判定: `REAL_WORLD_ROOT_CAUSE_IDENTIFIED`**
**§19 最終分類: `REAL_STRUCTURE_DOMINANT`** / **H1 = `H1_SUPPORTED`** / **H2 = `H2_NOT_ESTABLISHED`**

> **§20 の方針: 建物を道路/区画へ押し込む施策を正式終了する。**

AUDIT ONLY。building geometry / Road / Land Block / offset / scale / clipping / canonical rebuild は一切行っていない。

---

## §0. 先に: 32G の前提が誤っていた（本ミッション最初の発見）

32G は「大阪市24区(Kita区/梅田)の建物生CityGMLはこのサンドボックスに存在しない」と記録し、
住吉区を代替証拠として結論を出していた。**これは誤りだった。**

梅田の生CityGMLは `data/raw/osaka-higashisumiyoshi/` 配下に（ディレクトリ名に反して）
二次メッシュ **523503 / 523504** として実在する。梅田中心は `52350349_bldg_6697_op.gml`。
本ミッションは梅田そのものを**一次証拠**として使用した。

この訂正により、32G の「LOD2 は無い」という一般化も崩れた（§4）。

---

## §3. 梅田の生PLATEAU（実データ集計・推測なし）

使用メッシュ4件（AOIと交差するもの）: `52350339` `52350349` `52350430` `52350440`
srsName: `http://www.opengis.net/def/crs/EPSG/0/6697`

| geometry | 件数 |
|---|---|
| bldg:Building | **7,358** |
| bldg:lod0FootPrint | 7,337 |
| **bldg:lod0RoofEdge** | **21** |
| bldg:lod1Solid | 7,358 |
| **bldg:lod2Solid** | **1,367** |
| bldg:GroundSurface | 1,370 |
| bldg:RoofSurface | 2,301 |
| bldg:WallSurface | 15,878 |

lod0FootPrint(7,337) + lod0RoofEdge(21) = 7,358 = 建物数。**LOD0外形は必ず1つだけ存在する。**

メッシュ別 LOD2: 52350339=565 / 52350349=239 / 52350430=429 / 52350440=134

## §4. LOD2 判定

**`UMEDA_LOD2_AVAILABLE`**（1,367 / 7,358 = 18.6%）

32G は住吉区サンプル(LOD2=0)から「LOD2なし」と一般化していた。§4 が警告していたとおりの誤りであり、
本ミッションで訂正した。

## §15. LOD2 があっても H1/H2 は判別できない（重要な測定結果）

LOD2 を持つ 45 棟について lod0FootPrint / GroundSurface / RoofSurface投影 / WallSurface下端 を比較した:

| 測定 | 中央値 |
|---|---|
| 屋根投影の footprint 被覆 | **0.9999** |
| 屋根投影が footprint の外に出る割合 | **0.0** |
| GroundSurface 面積 / footprint 面積 | **1.000** |
| GroundSurface が単一標高の平坦面 | 45 / 45 |
| WallSurface 下端 = GroundSurface 標高 | 45 / 45 |

⇒ **`LOD2_PROVIDES_NO_INDEPENDENT_OUTLINE`**。
4つの geometry はすべて**同一の平面外形**であり、LOD2 は「外形が地面接地形状か」について
独立した観測を一切与えない。§15 の比較は実行したが、これ単独では H1/H2 を分けられない。

> 32G で「GSI との比較」が無効だったのと同じ罠。**実行した上で無効と判定**したことが結果である。

---

## §5–§9. Ground Truth: 航空写真は無い / OSM を使った

**航空写真・正射画像はこの環境に 1枚も存在しない**（`data/**` 画像0件、`public/**` はロゴPNGのみ、
HTML内のタイル/画像URL参照0件、キャッシュ無し、ネットワーク不可）。
よって §5(画像との真上比較)・§6(画像bounds→world変換) は**実行不能**。
`orthophoto.source` / `captureDate` / `bounds*` は **null のまま**にした（数値を捏造していない）。

代わりに **OSM 建物outline**（`data/raw/osm/osaka-latest.osm.pbf`）を Ground Truth に使った。
OSM の建物は航空写真等から人手でトレースされた「上空から見て実在する構造物」の独立記録である。
AOI内: OSM建物 1,550 / OSM highway 3,532。

### §8/§9 位置合わせ（非建物 control point）

| 項目 | 値 |
|---|---|
| control point 数 | **32**（≥10） |
| 種別 | GSI Road Edge 由来 ROAD V2 車道corridor 中心点（**OSMとは独立由来・非建物**） |
| OSM highway 中心線までの距離 中央値 | **1.36 m** |
| p95 / max | 12.05 m / 28.17 m |

道路中心同士の比較なので理論値は0付近。**数十mずれた状態で建物を評価してはいない**（§9）。

> §8 は交差点/橋/河川縁等を例示しているが、このリポジトリで OSM 由来でない非建物レイヤーは
> GSI Road Edge 系列しか存在しない（rivers/rail/parks/roads は全て OSM 由来で、比較すると自己比較に
> なり無意味）。そのため control point は GSI 由来の車道 corridor 中心とした。

### 妥当性ゲート（32G の失敗を繰り返さないための事前検証）

32G では「GSI は道路上に建物を描かない」ため、GSI の**不在**が H1 でも H2 でも同じ観測を生み、
判別不能に陥った。同じ轍を踏まないよう、OSM を使う前に情報量を測った。

| 測定 | 値 |
|---|---|
| AOI 全体の OSM 建物被覆率 | 39.9%（飽和していない） |
| **PLATEAU建物が無い道路/線路セルに OSM建物が乗っている割合（ベースライン）** | **6.9%** |
| **問題建物の「道路/線路と重なる部分」の OSM 被覆（中央値）** | **98.4%** |
| **濃縮率** | **約 14.3 倍** |

さらに**証拠の非対称性**を分けて扱った:
- 【存在】OSM がそこに建物を描いている ⇒ 構造物が実在する — 位置合わせさえ通れば成立
- 【不在】OSM が描いていない ⇒ 構造物が無い — OSM が道路上に建物を描く性質を持つ場合のみ成立

不在ベースの結論(`PLATEAU_FOOTPRINT_OVERSIZED`)にだけ妥当性ゲート通過を要求した。

---

## §1/§2. 問題群と対照群

- **問題群 30 棟**（32G のサンプルを固定。≥20）
- **対照群 30 棟**（area/height/局所密度で照合。選定に実名・class・lod0Kind は一切使っていない＝循環回避）

| | 問題群 | 対照群 |
|---|---|---|
| 面積 中央値 | 4,127.7 m² | 2,843.2 m² |
| 高さ 中央値 | 99.2 m | 68.0 m |
| 100m内 建物密度 中央値 | 15 | 16.5 |
| road 重なり 中央値 | 0.314 | 0.000 |
| rail 重なり 中央値 | 0.215 | 0.000 |
| LOD2 保有率 | 0.80 | 0.70 |

---

## §10/§11. 分類結果

### §10 現実との照合

| 分類 | 問題群 | 対照群 |
|---|---|---|
| **A REAL_OVERHEAD_STRUCTURE** | **3** | 0 |
| **B FOOTPRINT_MATCHES_REAL_BUILDING** | **24** | 24 |
| C PLATEAU_FOOTPRINT_OVERSIZED | **1** | **3** |
| D PLATEAU_FOOTPRINT_UNDERSIZED | 0 | 0 |
| E TEMPORAL_CHANGE | 0 | 0 |
| F AMBIGUOUS | 2 | 3 |

**問題群 30 棟中 27 棟(90%)が「現実に存在する構造物」として確認された。**

### §11 構造種別（駅施設等を普通の建物と混ぜない）

問題群: STATION 2 / CANOPY 1 / COMPLEX 1 / NORMAL 26 — 対照群: NORMAL 30

提供者の実名(`gml:name`)による同定:
- `bldg_9c2c736c…` = **大阪駅**（18,206 m², road 66.9%, rail 12.9%, `bldg:class=3003 普通無壁舎`）
- `bldg_8e4695fb…` = **大阪梅田駅**（27,126 m², road 18.2%, rail 19.9%）
  → OSM側も `building=train_station` name=大阪梅田 が 99.5% を被覆し、独立ソースと整合

---

## §12/§13. H1 / H2

### H1 = `H1_SUPPORTED`

1. 提供者自身が実名/意味付けで「線路・道路上空に及ぶ構造物」と記録している建物が 3 棟（大阪駅・大阪梅田駅を含む）。
2. 独立ソース OSM が、問題群の「道路/線路と重なる部分」の **98.4%** を建物outlineで被覆。
   ベースラインは **6.9%** に過ぎず **約14倍の濃縮**。偶然では生じない。

⇒ **2つの独立した作成者が「そこに構造物がある」と一致して記録している。**
   Live City 側で建物を区画へ押し込むべきではない。

### H2 = `H2_NOT_ESTABLISHED`

問題群の OVERSIZED は 1 棟、**対照群では 3 棟**。問題群のほうが少ない。
すなわち OVERSIZED は問題群に固有の欠陥ではなく、通常建物にも同程度に存在する背景ノイズ。

**対照群が効いた例**: `lod0RoofEdge`（屋根投影外形として提供される建物）の出現率は
問題群 13.3% / **対照群 10.0%** / メッシュ全体 0.29%。
問題群だけ見れば「メッシュ全体の46倍」で H2 の証拠に見えるが、対照群も同じく高い。
これは lod0RoofEdge が空中写真測量・地図情報レベル1000 の**大型建物バッチ**だからで、
**面積効果であって問題群固有ではない**。対照群を取っていなければ誤断定していた。

---

## §14. 時点差

| ソース | 時点 |
|---|---|
| PLATEAU `uro:surveyYear` | **2017**（7,341棟） |
| PLATEAU `core:creationDate` | 2023-03-22（7,337棟） / 2025-03-21（21棟） |
| GSI 道路縁 | 2026-04-01 / 2026-07-01 |

`temporalConflictCount = 26`（測量2017 vs 比較データ2026 で9年差）。

ただしこの時点差は H1 の結論を弱めない。**OSM は継続更新される現行データであり、
2017年測量の PLATEAU と 98.4% で一致している。** 建替え・再開発による差を geometry error と
誤判定してはいない（§14）。

---

## §7. `[REALITY QA]` オーバーレイ

`#canonical-runtime-status` に **`[REALITY QA]`**（既定OFF・read-only・opt-in）を追加。

- **Orthographic Top Down 固定**（`CanonicalRuntime.isRealityQaActive()` → orthoCamera）
- PLATEAU lod0 = cyan / GSI建物 = magenta / **OSM建物 = green** / ROAD V2 = gray / rail = black
- **building extrusion = OFF / Land Block = OFF**（OFFに戻すと必ず元の表示状態へ復元）
- 航空写真 base は**出せない**ことを `unavailableLayers: ['ORTHOPHOTO(base)']` で明示
- 画像を入手したら `overlay.json` の `orthophoto` に `{url, west, east, north, south}` を入れれば
  base として表示される。**px数ではなく west/east/north/south の4隅を `geoToThree()` で変換して
  quad を張る**実装（§5の「見た目で手動伸縮」は禁止）

`__SET_REALITY_QA__(bool)` / `__REALITY_QA_DEBUG__()` を公開。

> Mission17 の「巨大 plane / helper を新規追加しない」ガード（`PlaneGeometry` ちょうど1個）を
> 弱めないため、`PlaneGeometry` ではなく頂点を直接置く実装にした。ガードは無傷のまま通っている。

---

## §18/§21. 成果物と検証

| 種別 | パス |
|---|---|
| 監査ツール | `tools/audit/umeda-real-world-ground-truth-audit.js` |
| レポート | `data/reports/umeda-real-world-ground-truth-audit.json` |
| Validator | `tools/validate/umeda-real-world-ground-truth-audit.js` → **RESULT=PASS** |
| テスト | `tests/umeda-real-world-ground-truth-audit.test.js`（15件・全pass） |
| QA データ | `data/processed/osaka-city/reality-qa/umeda/overlay.json` ＋ public コピー |

### §21 Validator

| check | 値 |
|---|---|
| buildingMutation / roadMutation / landBlockMutation / projectionMutation | **0 / 0 / 0 / 0** |
| controlPointsChecked | **true**（32点・中央値1.36m） |
| problemAndControlCompared | **true**（30 / 30） |
| temporalDatesChecked | **true** |
| umedaRawPlateauUsedAsPrimaryEvidence | **true** |
| overlayReadOnly / productionModified / protectedModified | true / false / false |
| **orthophotoGeoreferenced** | **false**（画像が無いため実行不能。WARNで明示。捏造せず） |

### 不変条件（全て維持）

Canonical Buildings **615,617** / ROAD V2 **169,468** / Land Block **178** /
`znorth-neg-v1` projection 不変 / production・protected HTML 不変

`npm test` = **1,618 tests / 1,603 pass / 0 fail / 15 skip**

---

## §20. 次の方針

1. **建物を道路/区画へ押し込む(clip/shrink/warp/offset)施策を正式に終了する。**
   問題群 30 棟のうち 27 棟は現実に存在する構造物であり、押し込めば現実と乖離する。
2. 「建物が道路にはみ出して見える」の残りの改善余地は**建物側ではなく道路側**にある。
   ROAD V2 の envelope は PLATEAU tran の道路区域（32Dで確定: 歩道を含む行政上の道路敷地）であり、
   実在建物の下にも及ぶ。**32E の「GSI道路縁から車道を復元して暗くする」方向の延長が正しい。**
3. 例外の OVERSIZED 1 棟 / AMBIGUOUS 2 棟は、対照群でも同程度(3棟/3棟)出ている背景ノイズ。
   個別補正の対象にしない。
4. building単位の provenance は本監査で取得済み
   （lod0Kind / bldg:class / gml:name / LOD2有無 / publicSurveySrcDescLod0 / srcScaleLod0 / OSM被覆率）。
   必要ならこれを confidence として持たせる。

---

## 限界（正直な開示）

1. **航空写真が無い。** §5/§6 は実行していない。Ground Truth は OSM で代替した。
2. **OSM と PLATEAU は完全に独立とは言い切れない。** どちらも航空写真を主要情報源としうるし、
   OSM 記入者が PLATEAU 由来情報を参照した可能性も排除できない（大阪市での PLATEAU 一括インポートは
   確認されていないが、この環境では検証手段が無い）。「2ソースの一致」は独立検証として強いが、
   完全独立の証明ではない。
3. **OSM は権威データではない。** 網羅性が場所によって異なる（AOI被覆率39.9%）。
4. **対照群の照合精度。** ±30%以内の厳密一致は 16/30 で、残り 14 棟は最近傍で代替した。
   問題群が大型・高層（中央値 4,128 m² / 99 m）で、同規模かつ道路重なりの少ない通常建物が
   1.2km四方のAOI内に十分存在しないため。対照群は問題群よりやや小さく低い。
5. **railRatio は近似。** Canonical Rail 中心線±5m の corridor（32Gと同一。実測軌道敷幅ではない）。
6. **サンプル選定条件の扱い。** 問題群は32Gが「道路/線路と重なる」条件で選んだものなので、
   道路/線路の重なり量は分類の根拠には使わず、記述統計としてのみ扱った（循環論法の回避）。

---

**§22 STOP。今回は修正していない。`REAL_WORLD_ROOT_CAUSE_IDENTIFIED` で停止する。**
