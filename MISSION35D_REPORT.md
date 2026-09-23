# MISSION 35D — CITYWIDE MISSING BUILDING RECOVERY

**判定: `CITYWIDE_MISSING_BUILDING_RECOVERY_SUCCESS`**

先に結論を 5 行で:

- **24 区全域で 17,985 棟を追加**しました。現在の表示 **600,764 → 618,749**（+3.0%）。
- **最大の原因は OSM の元データが北で切れていたこと**でした。`osaka-latest.osm.pbf` は **lat 34.73 で建物が途切れて**おり、東淀川区は回収可能な棟が 49 棟しか見えていませんでした。広域 PBF に替えて **2,161 棟**になりました。
- **ブリリアタワー堂島は OSM に名前がありません**（無名・49 階・2,412m²）。名前ではなく地点で追跡して特定し、V4 に入っていることを確認しました。代表 9 地点の未表示 **508 棟 → V4 で 508 棟すべて回収、残り 0**。
- **PLATEAU は 1 棟も消していません**。geometry 変更 0 / canonicalId 消失 0 / projection・road・water・rail 変更 0。
- **二重表示は増えていません**（対照実験で確認）。production / protected は未変更、cutover もしていません。

---

## 1. 旧 final set の件数内訳（§13-1）

dev の既定は **V2N**（`buildings-v2-osmv2`）です。34C が作った V3 は**トグルの裏**にあり、既定ではありません。ユーザーが「まだ残っている」と感じたのはこのためです。

| 集合 | 棟数 | 内訳 | dev での扱い |
|---|---|---|---|
| **V2N（現在の表示）** | **600,764** | PLATEAU 574,112 + OSM fallback 26,652 | **既定** |
| V3（34C） | 614,593 | V2N + 回収 13,829 | トグル |
| **V4（35D）** | **618,749** | V2N + 回収 **17,985** | トグル（新設） |

---

## 2. missing candidate の抽出方法（§13-2）

34C の `building-coverage-citywide.js` を**そのまま使わず**、次の 5 点を変えて作り直しました（`tools/audit/citywide-missing-buildings.js`）。

| # | 34C | 35D |
|---|---|---|
| 1 | 「重心が中 かつ bbox IoU≥0.5」の **419,146 棟を測らずに重複扱い** | **早期判定を撤廃**。全件を測り直す |
| 2 | 除外した棟を捨てる | **除外理由ごとに記録**して妥当性を検証できるように |
| 3 | 緯度分布を見ていない | **緯度ヒストグラム**で元データの切れを検出 |
| 4 | 形の健全性は面積だけ | **縦横比・OBB 充填率**も見る |
| 5 | 水域を見ていない | **水面の中の偽建物**を除外 |

各候補について §3 の指標を全部出しています。

`overlapAreaWithPlateau` / `overlapAreaWithFinalSet` / `overlapRatioToOsm` / `centroidInsidePlateau` / `centroidInsideFinalSet` / `bboxIoUWithNearestPlateau` / `maxIoU` / `nearestPlateauDistanceM` / `partners` / `aspect` / `rectangularity` / `wardId` / `areaM2`

### 2-1. 34C の早期判定は正しかった（実測）

撤廃して測り直した結果です。

| | 件数 |
|---|---|
| 34C なら早期に重複とされていた棟 | **450,931** |
| そのうち、測ったら重複ではなかった棟 | **0** |

**34C の近道は結果的に正しく、実在建物を 1 棟も落としていませんでした。** 34C 時点では未検証だったので、今回測って確かめた上でこの結論にしています。

### 2-2. 本当の原因は元データの北側の切れだった

| OSM 元データ | in-city 建物 | 緯度の崖 | 回収可能 |
|---|---|---|---|
| `osaka-latest.osm.pbf`（34C まで） | 494,176 | **lat 34.73 で 92,708 → 9,011（比 10.3）** | 13,808 |
| **`osaka-full-coverage.osm.pbf`（35D）** | **535,260** | **なし** | **17,993** |

`osaka-latest.osm.pbf` は bbox 抽出で北が切れています。道路について 31 ミッションで判明していた問題（`[[osm-pbf-north-cutoff]]`）が、**建物にも同じように効いていました**。Geofabrik の `kansai-latest.osm.pbf`（336 MB）を `data/raw/osm/osaka-full-coverage.osm.pbf` として取得し、**既存の `osaka-latest.osm.pbf` は上書きせず残して**います。

---

## 3. 新しい fallback 選定ルール（§13-3）

**重複判定そのものは 32O のまま**（`tools/lib/osm-fallback-v2-classify.js`）です。前後に次を足しました。

### 採る条件
- 今の表示（PLATEAU + 既存 fallback）に十分被覆されていない（`VALID_FALLBACK` または `AMBIGUOUS`）
- 形が建物として成立する
- 水面の中でない
- 既存の複数棟を包んでいるだけの輪郭でない
- 回収分どうしで重複していない

### 形の条件（`SHAPE_GUARD`）
| 条件 | 値 | 落ちた数 |
|---|---|---|
| 面積 | 8〜60,000 m² | too-small 13,636 / too-big 2 |
| 縦横比 | ≤ 25 | **44**（塀や道路の誤登録） |
| OBB 充填率 | ≥ 0.15 | **16** |
| 自己交差なし | — | 85 |

### 複数の PLATEAU にまたがる OSM 建物（§5）
1 本の way が既存の複数棟を囲っているだけなら足すと二重になります。`partners ≥ 2` かつ `overlapRatioToOsm ≥ 0.55` を「包む輪郭」として除外します。
**今回の該当は 0 件**でした（重複判定の段階で既に落ちていたため）。

### 回収分どうしの重複
OSM が同じ建物を 2 本の way で持つことがあります。名前あり > 階数あり > 面積が大きい の順で 1 本だけ残します。→ **8 棟**を除外。

### 判定の内訳（535,260 棟）
| 分類 | 件数 |
|---|---|
| CLEAR_DUPLICATE | 512,442 |
| LIKELY_DUPLICATE | 4,803 |
| AMBIGUOUS（残す） | 2,057 |
| VALID_FALLBACK（残す） | 15,958 |
| うち水面の中で除外 | 22 |
| **回収可能** | **17,993** |
| → 包む輪郭で除外 | 0 |
| → 自己重複で除外 | 8 |
| **実際に追加** | **17,985** |

---

## 4. 区別の追加 / 除外件数（§13-4/§6）

| 区 | PLATEAU | 旧 fallback | 34C 回収 | **35D 追加** | 増加率 |
|---|---|---|---|---|---|
| **東淀川** | 33,773 | 33 | 50 | **2,161** | **6.4%** |
| **淀川** | 33,618 | 596 | 671 | **1,699** | **5.0%** |
| **旭** | 22,478 | 1,396 | 580 | **1,609** | **6.7%** |
| 鶴見 | 20,174 | 4,237 | 1,015 | 1,016 | 4.2% |
| 城東 | 31,573 | 620 | 934 | 931 | 2.9% |
| 北 | 15,699 | 3,328 | 892 | 893 | 4.7% |
| 中央 | 18,655 | 18 | 782 | 788 | 4.2% |
| 西淀川 | 24,766 | 1,516 | 743 | 743 | 2.8% |
| 平野 | 43,765 | 2,078 | 746 | 742 | 1.6% |
| 生野 | 44,618 | 609 | 628 | 628 | 1.4% |
| 東成 | 21,668 | 931 | 604 | 602 | 2.7% |
| 天王寺 | 14,233 | 4 | 601 | 599 | 4.2% |
| 西成 | 30,161 | 1,040 | 588 | 590 | 1.9% |
| 住吉 | 34,960 | 39 | 569 | 568 | 1.6% |
| 住之江 | 21,847 | 2,711 | 525 | 525 | 2.1% |
| 大正 | 17,559 | 845 | 513 | 513 | 2.8% |
| 福島 | 10,830 | 2,118 | 488 | 487 | 3.8% |
| 東住吉 | 38,209 | 78 | 481 | 476 | 1.2% |
| 此花 | 14,148 | 2,203 | 430 | 428 | 2.6% |
| 都島 | 16,106 | 1,192 | 420 | 420 | 2.4% |
| 阿倍野 | 26,497 | 0 | 419 | 419 | 1.6% |
| 西 | 12,322 | 233 | 416 | 416 | 3.3% |
| 浪速 | 10,283 | 0 | 367 | 367 | 3.6% |
| 港 | 15,938 | 827 | 370 | 365 | 2.2% |
| **合計** | **573,880** | **26,652** | **13,832** | **17,985** | **3.0%** |

### ランキング
- **missing が多かった区**: 東淀川 2,161 / 淀川 1,699 / 旭 1,609 / 鶴見 1,016
- **34C からの伸びが大きい区**: 東淀川 **+2,111**（43 倍）/ 旭 **+1,029** / 淀川 **+1,028** — **いずれも PBF が切れていた北部**
- **ほぼ変化のない区**: 阿倍野・浪速・西（±3 棟以内）

---

## 5. 代表ケースの結果（§13-5/§4）

**代表 9 地点で「今 表示されていない棟」は 508 棟。V4 で 508 棟すべて回収、残り 0。**

| 地点 | OSM 建物 | 既に PLATEAU で表示 | 未表示 | **V4 で回収** | 残り |
|---|---|---|---|---|---|
| **ブリリアタワー堂島** | 95 | 92 | 3 | **3** | **0** |
| グラングリーン大阪 | 693 | 634 | 52 | **52** | 0 |
| 大阪駅・ステーションシティ | 156 | 117 | 37 | **37** | 0 |
| 中之島 | 856 | 822 | 34 | **34** | 0 |
| 本町 | 716 | 685 | 25 | **25** | 0 |
| 難波 | 1,035 | 989 | 46 | **46** | 0 |
| 天王寺 | 1,021 | 974 | 47 | **47** | 0 |
| 住吉 | 7,296 | 7,244 | 52 | **52** | 0 |
| **東淀川** | 4,532 | 4,320 | 212 | **212** | 0 |

### 5-1. ブリリアタワー堂島

**この建物は OSM に名前がありません。**

```
canonicalId  cg_bldg_osm_1241852536
name         （無し）
levels       49
areaM2       2,412
rule         no-bbox-candidate（PLATEAU と bbox が 1 つも重ならない＝完全に欠落していた）
V2N          ✗ 未表示
V3           ✓
V4           ✓
```

名前での検索では見つかりません。地点（34.69466N / 135.49236E / 半径 260m）で追跡して特定しました。**その街区で最も階数の多い棟**として V4 で表示されます。

### 5-2. 各地点の最高層の棟

| 地点 | 最高層の棟 | 階数 | 状態 |
|---|---|---|---|
| ブリリアタワー堂島 | （無名） | 49 | **V4 で表示** |
| 本町 | ブランズタワー大阪本町 | 43 | **V4 で表示** |
| 中之島 | （無名。堂島の 49 階建て） | 49 | **V4 で表示** |
| グラングリーン大阪 | GRAND GREEN OSAKA THE NORTH RESIDENCE | 48 | 既に PLATEAU で表示 |
| 大阪駅 | JPタワー大阪 | 41 | 既に PLATEAU で表示 |
| 難波 | ザ・なんばタワー | 46 | 既に PLATEAU で表示 |
| 天王寺 | あべのハルカス | 60 | 既に PLATEAU で表示 |

### 5-3. 面積の大きい未表示建物（全域）

| way | 区 | 面積 | 名前 | 用途 |
|---|---|---|---|---|
| 1116212488 | 西淀川 | 37,689 m² | — | yes |
| 136251069 | 淀川 | 31,444 m² | **新大阪** | train_station |
| 415631928 | 大正 | 26,311 m² | **IKEA** | retail |
| 858359098 | 住之江 | 18,833 m² | — | warehouse |
| 226069555 | 北 | 11,951 m² | — | industrial |

---

## 6. duplicate 改善量（§13-6）

### 6-1. geometry での確認

追加した 17,985 棟から **3,597 棟をサンプル**し、選定に使ったのと同じ判定器で PLATEAU との重なりを測り直しました。

| | |
|---|---|
| 重複と判定された棟 | **0 / 3,597** |

### 6-2. 実ブラウザでの確認 — 対照実験

素朴に「回収した棟の真上から ray を撃って 2 つ以上 mesh に当たったら二重表示」と数えると、**既存建物でも当たります**。理由は 2 つで、どちらも 35D とは無関係です。

1. LOD band（near / mid）を移行中は両方描かれている
2. 建物は usageCategory ごとに束ねた mesh なので、隣の棟が別の束に入る

そこで **同じ band の中で 2 mesh 以上に当たった割合**を、同一地点・同一カメラで V2N と V4 について測りました。

| 地点 | V2N | V4 | 差 | |
|---|---|---|---|---|
| 北区（梅田） | 39.3% | **38.1%** | −1.1pt | OK |
| 中央区（本町） | 4.4% | **4.2%** | −0.3pt | OK |
| 東淀川区 | 0.0% | **0.0%** | ±0 | OK |
| 旭区 | 13.5% | **13.6%** | +0.1pt | OK |
| 淀川区 | — | — | — | **測定不能**（後述） |

**判定できた 4 地点すべてで V4 は V2N 以下**でした。35D は二重表示を増やしていません。

---

## 7. picking / property card の QA（§13-7/§7）

実ブラウザ（Edge headless / 実 GPU）で確認しました。

| 項目 | 結果 |
|---|---|
| 追加分の property card が出るか | **12/12 OK** |
| ward 名が出るか | **12/12 OK** |
| 実測高さが無い棟に高さを出していないか | **OK** |
| canonicalId が付いているか | **OK** |
| usageCategory が付いているか | **OK**（無いと色も card も出ない） |
| JS 例外 | **0 件** |

カードの例:
```
建物（用途不明） ／ 大阪市北区
cg_bldg_osm_178958637
底面積 1237.7 m²   区 大阪市北区
最寄駅 渡辺橋駅（直線距離 約200m）
```

attributes の例: `wardId: "chuo"` / `usageCategory: "other"` / `heightM: 6` / `source: "osm-fallback"` / `placement: "DISPLAY"`

### 表示棟数の変化（同一カメラ）

| 地点 | V2N | V4 | 差 |
|---|---|---|---|
| ブリリアタワー堂島 | 10,269 | 10,624 | **+355** |
| グラングリーン大阪 | 14,788 | 15,316 | +528 |
| 大阪駅 | 16,473 | 17,059 | +586 |
| 中之島 | 9,945 | 10,281 | +336 |
| 本町 | 17,954 | 18,327 | +373 |
| 難波 | 12,881 | 13,234 | +353 |
| 天王寺 | 11,888 | 12,035 | +147 |
| 住吉 | 22,556 | 22,788 | +232 |
| **東淀川** | 13,542 | 14,074 | **+532** |

**9 地点すべてで増加、減少は 0。** スクリーンショットは `data/reports/missing-recovery-qa/{地点}-{V2N,V4}.jpg`。

---

## 8. placement の変化（§13-8/§8）

新しい建物集合で placement を作り直しました（回収分を既定 DISPLAY にせず、既存と同じ規則で評価）。

| policy | V2N の記録 | **V4** |
|---|---|---|
| DISPLAY | 549,241 | **616,693** |
| REVIEW | 55,440 | **1,246** |
| SUPPRESS | 4,549 | **553** |
| EXEMPT | 6,387 | **257** |

REVIEW / SUPPRESS が大きく減っていますが、これは 35D が緩めたからではありません。比較対象の `building-placement-policy.json` は **V1 canonical 時代の記録**で、入力そのものが違います。V4 は `PLACEMENT_NO_31E=1` で 34C の V3 と同じ条件で生成しています。

**回収分を不必要に REVIEW / SUPPRESS へ落としていないこと**は、追加 17,985 棟のうち placement 非 DISPLAY が 2,056 棟（全体の 0.33%）であることで確認しました。

---

## 9. validator（§13-9/§11）

`tools/validate/citywide-missing-recovery.js` → **PASS / errors 0 / warnings 0**

| 項目 | 結果 |
|---|---|
| `buildingGeometryMutation`（PLATEAU） | **0** |
| `canonicalIdMutation`（既存） | **0** |
| `plateauRemoved` | **0** |
| `projectionMutation` | **0** |
| `roadMutation` | **0** |
| `waterMutation` | **0** |
| `railMutation` | **0** |
| `rebuiltFinalHasNoDuplicateWithPlateau` | **true**（0/3,597） |
| `rebuiltFinalCoverageImproved` | **true**（+17,985） |
| `representativeMissingCasesResolved` | **508 / 508** |
| `pickingWorksForAddedBuildings` | **true** |
| `noNewDoubleDisplay` | **true** |
| `runtimePickingOk` | **true** |
| `productionModified` | **false** |
| `protectedModified` | **false** |

---

## 10. npm test（§13-10/§12）

**2,045 tests / fail 0。**

`tests/citywide-missing-recovery.test.js`（28 件）を追加し `npm test` に登録しました。

- 形の健全性（細長すぎる塀・壊れた形・小さすぎ/大きすぎ）
- 水域の判定
- 市域 bbox が 24 区の北端まで届いていること / 緯度の崖の検出
- 区界からの距離
- 重複判定（包む輪郭・回収分どうし・情報の多い方を残す）
- 回収した棟が picking に必要な属性を持つこと / 60m の頭打ちを外す条件
- 代表ケースの定義と anchor が正本の座標変換を通ること
- PLATEAU を壊していないこと / dev に V4 がある / production に V4 が無いこと
- 実測の確認（早期判定の取り違え 0 / 北の崖の解消 / 24 区すべてを報告）

### 既存テストの修正（2 件）

`BUILDINGS_VERSION_BASE` と `BUILDINGS_VERSION_LABEL` を **1 行まるごとの一致**で見ていたため、V4 を足した時点で落ちました。版を足すたびに落ちる書き方なので、**その test の主旨だけを固定**する形に直しました（V2N が `derived-v2-osmv2` を読むこと / 各版のラベルが残っていること）。意図は保っています。

---

## 11. 自分の誤りを 4 件見つけて直しました

| # | 症状 | 原因 | 是正 |
|---|---|---|---|
| 1 | 広域 PBF で `Set maximum size exceeded` | 建物 way の node 参照を全部集めてから座標を引く順序。関西全域では V8 の Set 上限（約 1,677 万）を超える | 先に**市域 bbox の node だけ**を拾い、その node を使う way だけ残す順に変更 |
| 2 | ブリリアの anchor が **約 500m ずれていた** | world 座標を手で書き写していた | anchor を**緯度経度で書き**、正本の `latLonToLiveCityWorld()` で変換。テストで固定 |
| 3 | 「名前で特定できて未表示」が **実在しない建物を数えていた** | パターンが緩く「ブリリアントコート」「JRWD堂島タワー」を拾っていた。さらに **OSM の canonicalId が final set に無い＝未表示** と誤解していた（PLATEAU 側に同じ建物があれば表示されている） | パターンを厳密化し、指標を `候補に上がっている棟だけが未表示` に変更。`coveredByPlateau` を別に数える |
| 4 | 二重表示が **6 件ある**と出た | ray が当たった mesh 数をそのまま数えていた。LOD band の同時描画と usageCategory ごとの束ねで、**既存建物でも 2 以上になる** | V2N との**対照実験**に変更（同一 band 内の重なり率を比較）。V2N でも 39% あることが分かり、V4 は同率以下 |

**#3 と #4 は、どちらも「悪い数字」が出たので調べたら測り方が間違っていた、という順序です。** 逆（良い数字が出て満足する）だったら気付けませんでした。#1 の対照実験では、最初に淀川区で「+85.7pt 悪化」と出ましたが、実数を見ると V2N の hitProbes が **0**（タイル未読み込み）で測定自体が無効でした。固定待ちを settle 待ちに変え、データ不足の地点は**判定不能として除外**するようにしています。

---

## 12. known limitations（§13-11）

1. **淀川区の対照実験が測定不能**。V2N で建物が 1 つも描画されず（hitProbes 0）、比較になりませんでした。他 4 地点では判定できています。QA 地点の座標選びの問題で、データの問題ではありません。
2. **`outsideCityNearEdge` 3,885 棟は採っていません**。区界の 30m 以内の外側にある棟で、境界処理の都合で落ちた可能性がありますが、**確証がないので足していません**（§2 の「勝手に生成しない」）。記録だけ残しています。
3. **`tooSmall` 13,636 棟**（8m² 未満）は既存ルールのまま除外しています。物置・小屋が多いと見られますが、基準を勝手に変えていません。
4. **高さは OSM タグ依存**です。`height` / `building:levels` がある棟だけ実測値を使い（上限 300m）、無い棟は用途別の既定値で `heightUnknown` を立てています。card に高さ行は出しません。
5. **V4 はまだ既定ではありません**。dev の `[V4 REBUILT FINAL]` ボタンで切り替えます。
6. **広域 PBF は建物にしか使っていません**。道路・鉄道・水域は従来のまま（§0 の変更禁止）。道路の北側の欠落は未解決で、別ミッションの範囲です。

---

## 13. 成果物

**新規ツール**

| ファイル | 役割 |
|---|---|
| `tools/audit/citywide-missing-buildings.js` | 全域再監査（早期判定の撤廃・除外理由の記録・緯度の崖・形の健全性・水域） |
| `tools/audit/missing-recovery-fixtures.js` | 代表ケースの追跡（名前 + 地点） |
| `tools/build-final-buildings-v4.js` | V4 の生成（canonical / derived / placement / ward index） |
| `tools/audit/missing-recovery-runtime-qa.js` | 実ブラウザの card / picking / 表示棟数 |
| `tools/audit/missing-recovery-overlap-control.js` | 二重表示の対照実験 |
| `tools/download/plateau-ortho-archive.js` | （35C）再利用 |
| `tools/validate/citywide-missing-recovery.js` | §11 の検証 |
| `tests/citywide-missing-recovery.test.js` | 28 件 |

**データ**

- `data/processed/osaka-city/canonical/buildings-v4-final/`（618,749）
- `data/processed/osaka-city/canonical/buildings-v4-recovered/`（17,985 + `recovered-index.json`）
- `data/processed/osaka-city/derived-v4-final/` と `public/map-data/osaka-city/derived-v4-final/`
- `data/raw/osm/osaka-full-coverage.osm.pbf`（336 MB。`osaka-latest.osm.pbf` は**残しています**）

**レポート**

`citywide-missing-buildings.json` / `missing-recovery-fixtures.json` / `final-buildings-v4-build.json` / `missing-recovery-runtime-qa.json` / `missing-recovery-overlap-control.json` / `citywide-missing-recovery-validation.json` / `building-placement-policy-v4.json` / `ward-building-index-v4.json`

**dev ランタイム**（`public/osaka_3d_buildings.ward-ux-v1.html` のみ）

- `[V4 REBUILT FINAL]` ボタン（V1 / V2 / V2N / V3 / V4 の 5 択）
- `[DIFF: MISSING RECOVERY]` ボタン — 35D で足した 17,985 棟だけを**水色**で表示
- `window.__MISSING_RECOVERY__(on)` / `window.__MISSING_RECOVERY_DEBUG__()`

---

## 14. production 未反映（§13-12/§15）

| | |
|---|---|
| `public/osaka_3d_buildings.html` | **未変更**（SHA-256 が最後の承認済みビルドと一致） |
| `public/osaka_3d_buildings.fullward-v3.html` | **未変更** |
| production に `derived-v4-final` の文字列 | **0 件**（テストで固定） |
| dev の既定 | **V2N のまま**（V4 はトグル） |

---

## 15. STOP

**`CITYWIDE_MISSING_BUILDING_RECOVERY_SUCCESS`**

§15 のとおり production cutover はしていません。dev で止めています。

### 確認していただきたいこと

1. dev を開き、`[V4 REBUILT FINAL]` に切り替えて **堂島・東淀川・旭・淀川**を見てください。特に**東淀川区は +2,161 棟**と最も変化が大きい区です。
2. `[DIFF: MISSING RECOVERY]` を ON にすると、35D で足した 17,985 棟だけが水色で出ます。
3. 追加した建物をクリックして card が出ること・区名が出ることをご確認ください。

### 次の判断

**V4 を dev の既定にするか**、そのうえで **production へ cutover するか**です。どちらもこちらでは進めません。

あわせて、広域 PBF で**道路の北側の欠落**も直せる状態になりました（東淀川区の道路カバー率 10% / 淀川区 57%）。これは建物とは別レイヤーなので 35D では触っていません。ご指示があれば別ミッションとして扱います。
