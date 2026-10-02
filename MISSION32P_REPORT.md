# MISSION 32P — PROMOTE CORRECTED BUILDING V2 IN DEV

**判定: `V2_DEV_PROMOTION_SUCCESS`**（validator PASS・error 0・warning 1）

- **変更したもの:** development 用の `public/osaka_3d_buildings.ward-ux-v1.html`。
- **変更していないもの:** production（`osaka_3d_buildings.html`）と protected（`fullward-v3.html`）。
- **残しているもの:** V1 のデータセットと、QA 用の切替ボタン `[BLDG V1] [V2 + OLD OSM] [V2 + NEW OSM]`。

---

## 完了報告（§34）

### 1. Dev default Building
**V2 + NEW OSM**（内部名 `V2N` / 表示名「V2 CORRECTED + OSM V2」）。

- 実ブラウザで起動直後に建物系 fetch を namespace 別に数えた結果、**V2N 413 件 / V1 0 件 / 旧 OSM（V2）0 件 / visual-buildings 0 件**。
- その後に区切替と City Mode を行っても、差分は V2N +837 件 / V1 0 件 / V2 0 件。

### 2〜4. 件数

| 項目 | 件数 |
|---|---|
| 2. Total | **600,764** |
| 3. PLATEAU | **574,112**（32O の V2 と feature・属性とも完全一致） |
| 4. OSM fallback | **26,652**（V2 PLATEAU を基準に選定。除外した旧 ID は runtime の tile に 0 件） |

### 5. Duplicate
PLATEAU と重なる OSM fallback は、旧 **22,758 → 5 棟**。5 棟はすべて AMBIGUOUS として残したもの（32O）。

実ブラウザでも確認した。6 棟を真上からクリックすると、どれも当たる footprint は 1 つだけで、重複 pick は無かった。

### 6. ROAD V3 overlap（正式値・V2 建物 600,764 棟で再測定）

測り方は 1m ラスタ。ROAD V3 の geometry（32I）は変更していない。

**全市**（建物ごとの重なり面積の合計）

| 道路 | 重なり面積 | 接する建物数 | 比率 |
|---|---|---|---|
| FIX13 | 230,033 m² | 6,947 棟 | 0.33% |
| ROAD V2 | 75,279 m² | 1,683 棟 | 0.11% |
| **ROAD V3** | **12,478 m²** | **585 棟** | **0.018%** |

**サイト別**（1km 四方の union）

| サイト | FIX13 | ROAD V2 | **ROAD V3**（面積 / 棟数 / 比率） |
|---|---|---|---|
| 梅田 | 10,354 | 762 | **572 / 9 棟 / 0.14%** |
| 本町 | 5,698 | 3,332 | **393 / 7 棟 / 0.08%** |
| 難波 | 4,657 | 1,889 | **137 / 2 棟 / 0.03%** |
| 天王寺 | 3,153 | 998 | **28 / 2 棟 / 0.007%** |
| 住吉 | 1,037 | 303 | **5 / 2 棟 / 0.001%** |
| 東淀川 | 51 | 16 | **16 / 6 棟 / 0.004%** |

- 過去値（V1 建物で測った 32I: FIX13 479,511 / V2 176,180 / V3 74,798 m²）は historical として別に載せた。
- **§7:** V2 建物で測り直しても ROAD V3 の重なりは自然な水準だった。development の既定は **ROAD V3 のまま固定**した。

### 7. Water overlap（全市）

**全体:** 326 棟、22,929 m²（建物面積の 0.033%）。

**分類（§9）**

| 分類 | 棟数 | 面積 |
|---|---|---|
| REAL_WATER_STRUCTURE | 100 | 17,026 m² |
| SHORELINE_CONFLICT（食い込み 3 m 以下） | 172 | 2,013 m² |
| WATER_GEOMETRY_TOO_WIDE | 46 | 2,974 m² |
| BUILDING_SOURCE_CONFLICT | 4 | 142 m² |
| AMBIGUOUS | 4 | 774 m² |

REAL_WATER_STRUCTURE の根拠は、用途ラベル、OSM の桟橋・橋・船着場・houseboat、または GSI 建物面で 10 m 以上水面に入るもの。

**重点 5 河川**

| 河川 | 棟数 / 面積 | 内訳 |
|---|---|---|
| 大川 | 6 棟 / 758 m² | 実在構造 746（毛馬閘門の構造物 2 棟は GSI で確認、OSM の橋・浮桟橋・渡船場）、GSI で建物確認済みの岸側 12 |
| 淀川 | 13 棟 / 1,921 m² | すべて実在構造（淀川大堰など `man_made=bridge`） |
| 道頓堀川 | 5 棟 / 238 m² | 実在構造 132 / 水域が広すぎ 104 / 岸線 2 |
| 木津川 | 8 棟 / 577 m² | 実在構造 409 / 水域が広すぎ 147 / 岸線 21 |
| 安治川 | 4 棟 / 1,310 m² | 実在構造 1,290（水上消防署の桟橋・houseboat）/ 岸線 20 |

**§10 大川の「31 m²」:** 32N で測った中之島 1km 四方の値で、現在は 33 m²。内訳は次のとおりで、誤った建物は無い。建物の自動 SUPPRESS もしていない。

| 面積 | 内容 |
|---|---|
| 18 m² | OSM の `man_made=bridge` と重なる構造物（実在構造） |
| 14 m² | 堂島川の岸線で、食い込みは 2 m |
| 1 m² | 岸線の端 |

### 8. Placement（V2 で完全に再生成・§11〜§13）

| | DISPLAY | SUPPRESS | REVIEW | EXEMPT |
|---|---|---|---|---|
| V1（正式・旧） | 549,241 | 4,549 | 55,440 | 6,387 |
| 32N 暫定（V2 + 旧 OSM・tran 基準） | 613,833 | 479 | 1,115 | 190 |
| **V2 正式（32P）** | **600,567** | **2** | **99** | **96** |

- **規則:**
  - 道路は ROAD V3 と比べ、道路との重なりだけでは SUPPRESS しない。REVIEW 30 棟（V3 carriageway 比 30% 以上）。
  - 水域では、実在構造を EXEMPT（95 棟）にする。
  - SUPPRESS は、水面比 85% 以上で、OSM にも GSI にも存在しない建物だけ。
- **途中で直した点:** 最初の判定では SUPPRESS が 10 棟だった。GSI（国土地理院）の建物面で確認したところ、そのうち 8 棟には GSI の建物面があった（被覆率 100%）。独立ソースで裏付けのある建物を消していたことになるので、分類に GSI の裏付けを加え、8 棟は EXEMPT / REVIEW に移した。
- **残った SUPPRESS 2 棟:** 港区・尻無川の 22 m²（水面へ 4.8 m）と、住之江区・貯水池の 17 m²（9 m）。どちらも小さな構造物で、OSM・GSI どちらにも存在しない。

### 9. Ward counts（N03 2026・V2 から再生成）

- 24 区の合計は 600,532 棟。残り 232 棟は区境界の外。

| 区 | 棟数 | 区 | 棟数 | 区 | 棟数 |
|---|---|---|---|---|---|
| 北 | 19,027 | 都島 | 17,298 | 福島 | 12,948 |
| 此花 | 16,351 | 中央 | 18,673 | 西 | 12,555 |
| 港 | 16,765 | 大正 | 18,404 | 天王寺 | 14,237 |
| 浪速 | 10,283 | 西淀川 | 26,282 | 淀川 | 34,214 |
| 東淀川 | 33,806 | 東成 | 22,599 | 生野 | 45,227 |
| 旭 | 23,874 | 城東 | 32,193 | 鶴見 | 24,411 |
| 阿倍野 | 26,497 | 住之江 | 24,558 | 住吉 | 34,999 |
| 東住吉 | 38,287 | 平野 | 45,843 | 西成 | 31,201 |

### 10〜11. Picking / Property card（実ブラウザで実際にマウス操作）

対象は 6 棟: 梅田 PLATEAU、梅田の新 OSM（大阪富国生命ビル）、住吉 PLATEAU、鶴見の新 OSM、旭の新 OSM、住之江の残した旧 OSM。

- 6 / 6 で、hover の tooltip が表示され、クリックで狙った canonicalId が選ばれ、property card が表示された。
- card の ID 欄は canonicalId と一致した。
- card の用途欄は、PLATEAU では「消防・警察（コード:402）」「大学（コード:422）」など、新 OSM では「商業施設（コード:commercial）」などで、null は無かった。
- **以前からの表示（今回は変更していない）:** card のタイトルには、どこの建物でも「／ 南港南エリア」が付く。`showPropertyCard` に文字列で直書きされているためで、建物版とは関係ない。

### 12〜20. Visual fixtures

実ブラウザ（Edge・実 GPU）で撮影した。各地点は、その地点がある区の区モードで表示している。画像は `data/reports/v2-visual-qa/`。

| # | 地点（区） | 結果 |
|---|---|---|
| 12 | 梅田（北区） | 建物 543 mesh。V2 + OLD OSM と同一カメラで比較すると、抑制 / review 表示は「水7 道28 / review 76」から「水0 道0 / review 5」に減った。二重建物は見られない |
| 13 | 東淀川 | 509 mesh。OSM fallback は 0（OSM PBF の北端外）。PLATEAU だけで表示に問題なし |
| 14 | 本町（中央区） | 510 mesh。表示に問題なし |
| 15 | 難波（浪速区） | 372 mesh。表示に問題なし |
| 16 | 天王寺（地点は阿倍野区側） | 325 mesh。表示に問題なし |
| 17 | 住吉 | 400 mesh。表示に問題なし |
| 18 | 鶴見 | 新 OSM（灰色の用途不明）が街区に沿って並ぶ。巨大な建物・浮いた建物・区外へのはみ出しは見られない |
| 19 | 旭 | 鉄道沿いの新 OSM が街区内に収まっている |
| 20 | 東成 | 区の東端に新 OSM がまとまっている。街路に沿っていて、不自然な形は見られない |

**§23 河川（City Mode・真上から）**

- 大川の天満橋付近と中之島（堂島川・土佐堀川）では、建物は岸線の内側に収まっている。
- 毛馬と淀川大堰では、水上に見えるのは閘門や堰の構造物（EXEMPT）。

### 21. 性能（実ブラウザ・§19/§20）

**計測条件**

- ブラウザは Edge 153（headless）、GPU は Intel HD Graphics 630（Direct3D11）、画面は 1600×1000。
- 各地点の区モードで、同じカメラ位置（r = 700、45°）から 30 秒間静止して測った。

| | FPS 平均 | FPS p5 | frame p95 | frame 最大 | draw calls | triangles | JS heap | 読込中 tile |
|---|---|---|---|---|---|---|---|---|
| 梅田 V1 | 46.6 | 29.9 | 33.5 ms | 50.3 ms | 384 | 632,551 | 810.8 MB | 0 |
| **梅田 V2N** | **46.1** | 29.9 | 33.5 ms | 133.3 ms | **375** | **630,571** | **454.2 MB** | 0 |
| 住吉 V1 | 46.3 | 29.9 | 33.5 ms | 50.1 ms | 302 | 884,369 | 527.0 MB | 1 |
| **住吉 V2N** | **46.1** | 29.9 | 33.5 ms | 66.6 ms | 302 | **881,172** | **475.0 MB** | 1 |

- **結果:** V2N の FPS・frame p95 は V1 と同等。draw calls・triangles・GPU geometry 数はわずかに減った。大きな悪化は無い（許容: FPS −20%、p95 +25% + 2 ms）。
- **frame 最大:** 梅田 V2N の 133 ms は 30 秒中の単発。p95 は変わらない。
- **JS heap:** 1 つのページで順に計測したので、GC のタイミングに左右される。参考値として扱う。
- **headless の条件:** 更新は 60 Hz 上限。FPS p5 = 29.9 は、このマシンで 2 フレームに 1 回の更新になる瞬間がある、という意味。

### 22. Validator — `data/reports/v2-dev-promotion-validation.json`

| 項目 | 値 |
|---|---|
| devDefaultBuildingMode | V2_NEW_OSM |
| v1Default | false |
| v1StillAvailableForQa | true |
| plateauV2Count / osmFallbackV2Count / totalBuildingCount | 574,112 / 26,652 / 600,764 |
| oldOsmFallbackUsed | false |
| roadMode / rawGsiEdgeDefault | ROAD_V3 / false |
| placementGeneratedFromV2 / wardIndexGeneratedFromV2 | true / true |
| productionModified / protectedModified | false / false |

**warning 1 件:** legacy residual 4（下の「既知の課題」を参照）。

32N と 32O の validator も再実行し、どちらも PASS だった。「既定は V1」を前提にしていた判定は、V1 / V2N のどちらでも通るように直した。

### 23. npm test
**1,716 tests / pass 1,701 / fail 0 / skip 15。**

- 追加: `tests/v2-dev-promotion.test.js`（10 件）。
- 32N / 32O のテストのうち、既定 V1 を前提にしていた 3 箇所を V2N に合わせて更新した。
- 重いハーネス系テストの並列実行時の不安定さは、今回の実行では出なかった。

### 24. production / protected
**変更なし**（git status でも validator でも確認）。

### 25. Final verdict
**`V2_DEV_PROMOTION_SUCCESS`**

---

## 既知の課題（今回は直していない）

1. **起動時の status が `[CANONICAL ERROR]`（Legacy residual 4）になる。** V1 に切り替えても同じ 4 つの mesh が残るので、建物版には依存しない。
   - 正体は、原点を中心とした約 6 km 四方の地表レベルの mesh 群。灰 #969b99（7,629 頂点）、白 #f2f2ee（31,542 頂点）、半透明（657 頂点）、線（562 頂点）で、Scene 直下の無名 Group にぶら下がっている。
   - 旧 3 区埋め込み地図の名残とみられる。
   - 記憶にある「ShapeUtils スタブが無いためハーネスでは見えない未タグ mesh」と同種なので、専用 mission での対応を提案する。
   - ハーネスでは 0 件になる（スタブの都合）。
2. **property card のタイトルに「／ 南港南エリア」が直書きされている**（上記 11）。
3. **OneDrive:** 32N で消した競合コピーが、クラウド側から戻っている（V2 の旧フォルダ）。§28 の指示どおり今回は掃除していない。どのツールも正規のファイル名だけを読む。

## §26 過去レポートの扱い

- 32G・32H・32I のレポート（MD と JSON）に `historical-invalidated-by-v2` を明記した（JSON は `historicalStatus` キーの追加、MD は冒頭への注記）。ファイルは削除していない。
- 一覧は `data/reports/historical-invalidated-by-v2.json` にまとめた。32J・32K・32L と V1 の placement は「参考」として同じファイルに載せている。

## 生成物・変更

| 種別 | パス |
|---|---|
| 正式レポート（§27） | `data/reports/v2-final-road-overlap.json`、`v2-final-water-overlap.json`、`v2-placement-policy.json`、`v2-runtime-performance.json` |
| 検証・補助 | `data/reports/v2-dev-promotion-validation.json`、`ward-building-index-v2-final.json`、`historical-invalidated-by-v2.json`、`data/reports/v2-visual-qa/*.jpg`（52 枚） |
| 中間データ | `data/processed/osaka-city/v2-final/building-overlaps.json` |
| 再生成した公開物 | `data/processed/osaka-city/derived-v2-osmv2/building-placement/`、`building-ward-index.json`（data と public。synced-dir-writer で書き、共有の親ディレクトリは消していない） |
| ツール | `tools/lib/scanline-raster.js`、`tools/lib/cdp-browser.js`、`tools/audit/v2-final-overlap.js`、`tools/build-v2-placement-policy.js`、`tools/audit/v2-runtime-browser-qa.js`（`npm run preview` が必要）、`tools/validate/v2-dev-promotion.js` |
| HTML | `ward-ux-v1.html`: 既定を V2N に変更、status に標準構成を表示、建物系 fetch の namespace 別カウンタを追加 |

## 次の Mission（production 昇格候補）の判断材料（§33）

| 条件 | 状況 |
|---|---|
| V2 既定の実機表示 | ブラウザ QA では OK。**ユーザーの実機確認待ち** |
| 重複が実質なし | 5 棟（AMBIGUOUS）のみ |
| ROAD V3 overlap が自然 | 全市 0.018% |
| Water overlap が自然 | 実在構造と岸線が大半。建物側の誤りと判断したのは 4 棟 |
| Placement が妥当 | SUPPRESS 2 / REVIEW 99 / EXEMPT 96 |
| 9 fixture の目視 | 画像は撮影済み。**ユーザーの確認待ち** |
| 性能 | 問題なし |
| npm test | fail 0 |

**production に上げる前に決めてほしいこと:** 既知の課題 1（legacy residual による `[CANONICAL ERROR]` 表示）を、昇格の前に直すかどうか。

`VISUAL_QA_PENDING_USER`
