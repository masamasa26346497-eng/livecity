# MISSION 33C — OSAKA PLACE & LANDMARK ENRICHMENT

**判定: `OSAKA_LABEL_ENRICHMENT_SUCCESS`**（validator PASS・error 0・warning 0）

- 変更したのは **development の `public/osaka_3d_buildings.ward-ux-v1.html`** と **ラベル用の派生データ**だけです。
- 建物 geometry / 位置 / projection / ROAD V3 / water / rail / canonicalId / placement は**不変**（validator で確認）。
- **production / protected は未変更**（§32 のとおり、実機確認後に次ミッションで cutover）。

---

## 1. 追加した地名（§3/§5）

| 区分 | 件数 |
|---|---|
| 地名ラベル 合計 | **815**（33B は 697 → **+118**） |
| 出所の内訳 | OSM place ノード **697** / PLATEAU 町丁目名称 **118** |
| 階層 | 広域 60 / 中位 247 / 局所 508 |
| 北部（北緯 34.735 相当＝ z < -14,550）の地名 | **22 件**（33B は 0） |

**北部をどう埋めたか**: OSM 抽出は北緯 34.735° より北に place / station ノードが 1 件もありません（今回あらためて全件走査して確認）。
一方 **PLATEAU の建物 CityGML には全市で `gen:stringAttribute name="町丁目名称"` と `"区名"` が入っていました**。これを gml:id 単位で拾い、canonical V2N の建物重心（面積加重）と突き合わせて町丁目の代表点を作りました（`tools/build-plateau-place-labels.js`、468,920 棟を突合 → 692 町）。
結果、**淡路 / 東三国 / 上新庄 / 西淡路 / 東淡路 / 豊里 / 十八条 / 宮原 / 西宮原 / 東中島 / 新高 / 菅原 / 大桐 / 瑞光 / 井高野** などが表示されます（ハードコードは一切なし）。

北部は駅が無くスコアが上がらないため、**各区で建物数上位 3 件は最低「中位」に引き上げる**規則を入れました（区ごとの実データ順位だけで決定）。

## 2. 駅の coverage（§4）

- 駅は **canonical rail stations 233 駅をそのまま正本**として使用（`labels/station-labels.json`、`source: canonical-rail-stations`）。
- **新大阪・淡路・上新庄・東三国の各駅は、リポジトリ内のどのデータにも存在しません**。OSM PBF の `railway=station/halt` は 304 件あり、**最北が緯度 34.731**（PBF 自体は緯度 35.12 までノードを含むのに、駅だけが無い）。raw OSM railways（271 駅）も同じ範囲でした。
- §4/§5 の方針どおり**駅名のハードコードはしていません**。これらの地点は**地名ラベル（PLATEAU 由来）でカバー**しています。

## 3. 追加したランドマーク（§6/§7/§8）

| 区分 | 件数 |
|---|---|
| ランドマーク 合計 | **33**（33B は 19 → **+14**） |
| 出所 | canonical landmark registry 18 / OSM で実在確認 15 |
| Tier | **S 6 / A 12 / B 15** |

- **Tier S**（引き画面でも出す）: 大阪城・あべのハルカス・通天閣・京セラドーム大阪・**グラングリーン大阪**・ユニバーサル・スタジオ・ジャパン
- **Tier A**（中距離）: 大阪市役所・梅田スカイビル・海遊館・なんばパークス・大阪駅・大阪ステーションシティ・**うめきた公園**・**大阪中之島美術館**・大阪府咲洲庁舎・グランフロント大阪・**てんしば**・**天王寺動物園**・**インテックス大阪**
- **Tier B**（近景）: HEP FIVE・国立国際美術館・大阪市中央公会堂・あべのキューズモール・なんばCITY・なんばこめじるし・天王寺公園・JPタワー大阪・ATC・ツイン21・関電ビルディング・中之島フェスティバルタワー・大阪府庁本館・ノースゲートビルディング ほか

**採否ルール**（無秩序な追加を避けるため）:
- OSM の要素で `tourism=museum/zoo/aquarium/attraction/viewpoint/gallery` `leisure=park/stadium` `shop=mall` `amenity=townhall/conference_centre` `man_made=tower` `historic=building/castle` `building=retail/commercial/public` のいずれかを持つものだけ採用（**案内板・ホテル・記念碑は除外**）。
- 名前は完全一致か「◯◯ 北館 / ノースパーク」等の別館表記のみ代表名へ寄せる。**「万博記念公園 鶴見緑地」のような別施設は採用しない**。
- 「うめきた」「大阪駅」「大阪港」「万博記念公園」は名前が一般的すぎるため除外リストに入れ、実体のある施設名（グラングリーン大阪 / うめきた公園 / 大阪駅・大阪ステーションシティ / 海遊館）を使用。

## 4. 河川名ラベル（§10〜§13）

| 区分 | 件数 |
|---|---|
| 河川ラベル 合計 | **59**（新規） |
| 重要度 | 主要 19 / 中位 10 / 局所 30 |

- 主要: **淀川・安治川・木津川・大和川・神崎川・正蓮寺川・左門殿川・福町堀・尻無川・大川・寝屋川・平野川・平野川分水路・道頓堀川・三十間堀川・城北川・堂島川・木津川運河・古川**
- 中位: **土佐堀川**・住吉川・六軒家川・南外堀・北外堀・東外堀・内堀 ほか
- 出所は **canonical water の名称付き feature**（池は除外。`川 / 堀 / 運河 / 水路` と waterway タグで判定）。
- 配置は最大 part の重心、向きは**多角形の主軸（PCA）**。画面上の角度はカメラごとに投影して求めるので、**カメラを回しても流路に沿います**。
- デザインは**青〜青緑（昼 `#2f7f95` / 夜 `#9fd8ef`）+ 白ハロー**。建物ラベルより控えめで、道路（灰）・鉄道（紺）と混ざりません。

## 5. Source / provenance（§7/§26）

`public/map-data/osaka-city/labels/` に整理しました（`manifest.json` 付き。`data/processed/osaka-city/derived/labels/` にも同じもの）。

| ファイル | 内容 | provenance |
|---|---|---|
| `place-labels.json` | 地名 815 | `source`（osm-place / plateau-town）・`sources[]`・`sourceId`・`ward`・`chomeCount` / `buildings`・`score`・`rank` |
| `landmark-labels.json` | ランドマーク 33 | `source`（canonical-landmark-registry / osm）・`sourceId`（way/12345 等）・`category`・`tier`・`zoomBand`・`priority` |
| `river-labels.json` | 河川 59 | `source: canonical-water`・`angle`・`areaM2`・`importance` |
| `station-labels.json` | 駅 233 | `source: canonical-rail-stations`・`sourceId` |

区名・公園名は既存の `derived/map-label-anchors.json`（N03 / canonical parks）を継続利用しています。

## 6. 優先順位とズーム階層（§8/§13/§14）

| ズーム | 出るもの |
|---|---|
| 低（> 9km） | 区名・広域地名・**主要河川**・Tier S ランドマーク・主要駅 |
| 中（3.5〜9km） | ＋ 中位地名・中位駅・Tier A ランドマーク・中位河川・大規模公園 |
| 高（< 3.5km） | ＋ 局所地名・全駅・Tier B ランドマーク・局所河川・公園 |

優先度（1 本のキュー）: **ランドマーク S → 駅(主要)/区名 → 広域地名 → ランドマーク A/B → 中位駅 → 公園 → 中位地名 → 河川 → 局所**。
ただし**引き画面では主要河川を駅の直後まで引き上げ**（都市構造が読めるように）。

## 7. 衝突結果（§17）

| 条件 | 重なり組数 | 完全重複 | 最小文字高 |
|---|---|---|---|
| 11 地点すべて（近景） | **0** | **0** | 8px 以上 |
| City Mode（広域） | **0** | **0** | 25px 以上 |

## 8. 11 地点 QA（§22/§28・development・実ブラウザ）

| 地点 | 合計 | 地名 | 駅 | 施設 | 河川 | 区 | 公園 |
|---|---|---|---|---|---|---|---|
| 梅田 | 34 | 19 | 3 | 6 | 1 | 0 | 5 |
| **新大阪** | **9** | **9** | 0 | 0 | 0 | 0 | 0 |
| **淡路** | **11** | **11** | 0 | 0 | 0 | 0 | 0 |
| 本町 | 34 | 22 | 5 | 2 | 2 | 0 | 3 |
| 京橋 | 33 | 21 | 4 | 1 | 3 | 0 | 4 |
| 難波 | 36 | 22 | 6 | 5 | 1 | 0 | 2 |
| 天王寺 | 34 | 18 | 9 | 6 | 1 | 0 | 0 |
| 住吉 | 30 | 17 | 3 | 2 | 5 | 0 | 3 |
| 大阪城 | 33 | 12 | 5 | 4 | 7 | 0 | 5 |
| 中之島 | 39 | 16 | 9 | 6 | 4 | 0 | 4 |
| 大阪港 | 23 | 10 | 2 | 2 | 4 | 1 | 4 |
| City Mode | 18 | 0 | 4 | 5 | 9 | 0 | 0 |

- ブラウザ例外 0、legacy residual 0。
- City Mode では主要河川 9 本（淀川・安治川・神崎川・堂島川・尻無川・正蓮寺川・左門殿川・三十間堀川ほか）と Tier S ランドマーク・主要駅が出て、都市の骨格が読めます。
- **河川名トグル**（新設）: OFF で河川ラベルのみ 0 になり、ON で戻ることを実測。

## 9. 性能（§21・各 30 秒）

| 条件 | FPS 平均 | FPS p5 | frame P95 | draw calls | JS heap | 表示ラベル |
|---|---|---|---|---|---|---|
| 梅田 | 46.1 | 29.9 | 33.4ms | 396 | 476MB | 25 |
| 新大阪 | 59.9 | 59.2 | 16.9ms | 237 | 537MB | 6 |
| 難波 | 50.7 | 29.9 | 33.4ms | 286 | 480MB | 26 |
| City Mode | 45.4 | 29.9 | 33.5ms | 465 | 446MB | 18 |

33B production（梅田 52.2 / 難波 52.7 / City Mode 34.4）と同水準で、**大幅な悪化はありません**（City Mode はむしろ改善。計測時のタイル読み込み状況の差）。ラベル追加による draw call の増加は 1 桁台です。

## 10. before / after（§29・同一カメラ）

`data/reports/label-enrichment-qa/` に保存（`{shinosaka,umeda,osakacastle,nakanoshima}-{before,after}.jpg`、`city-{before,after}.jpg`）。

| 地点 | ラベル before → after | 内訳の変化 |
|---|---|---|
| **新大阪** | **1 → 9** | 地名 1 → 9（十八条・東三国・西三国・宮原・西宮原・東中島 ほか） |
| 梅田 | 31 → 34 | 地名 16→19 / 施設 5→6（グラングリーン大阪・うめきた公園）/ 河川 0→1 |
| 大阪城 | 28 → 33 | 河川 0→7（北外堀・東外堀・南外堀・平野川 ほか）/ 施設 3→4 |
| 中之島 | 34 → 39 | 河川 0→4（堂島川・土佐堀川 ほか）/ 施設 5→6（大阪中之島美術館） |
| City Mode | 18 → 18 | 内訳が変化（区名 8 → 河川 9・施設 5・駅 4。広域で都市構造が読める形へ） |

平均輝度はほぼ同じ（0.706 → 0.707 など）＝ **33A/33B の配色はそのまま**です。

## 11. Validator — `data/reports/label-enrichment-validation.json`

| 項目 | 値 |
|---|---|
| buildingMutation / roadMutation / waterMutation / projectionMutation | 0 / 0 / 0 / 0 |
| cityLabelLayerActive | true |
| northStationCoverageImproved（北部でラベルが出るようになったか） | **true** |
| landmarkCountIncreased（19 → 33） | **true** |
| riverLabelsCreated（59・主要 19） | **true** |
| nearOverlapCount | **0** |
| provenanceOk / stationsFromCanonical | true / true |
| productionModified / protectedModified | **false / false** |

## 12. npm test

- `npm test`: **1,776 tests / pass 1,761 / fail 0 / skip 15**（追加は `tests/label-enrichment.test.js` 10 件）。
- lifestyle-tab 系（npm test 対象外）も fail 0。
- 既存テストの更新: 33A のデータ URL（`derived/` → `labels/`）・`typeVisible` に river 追加・ランドマーク優先度が tier ベースになった点。33B の「production = dev の生成物」テストは、**dev が先行している間は production とビルド記録の一致だけを見る**形に調整しました。

## 13. 既知のギャップ（正直な申告）

1. **新大阪・淡路・上新庄・東三国の「駅」ラベルは出ません。** リポジトリ内のどのデータにも北緯 34.735° 以北の駅が存在しないためです（§4 に従いハードコードしていません）。地名ラベルでその地域は識別できます。
2. **「京橋」「新大阪」の地名ラベルはありません。** 町丁目名として実データに無く（京橋は東野田町など、新大阪は西中島）、§15 のとおり偽の地名は作っていません。駅名（京橋駅）では出ます。
3. 北部は駅データが無いため、地名の順位付けで不利になります。区ごとの上位 3 件を中位へ引き上げて補っていますが、広域（低ズーム）では北部の地名は出ません。
4. 河川ラベルは**水面ポリゴンの主軸**に沿わせています。曲がりの大きい河川（寝屋川・平野川など）では、区間によって向きが実際の流れとずれて見えることがあります（centerline 分割は次の改善候補）。
5. 大阪城の堀（北外堀・東外堀・南外堀・内堀）も河川データに含まれるため表示されます。城郭の地図としては自然ですが、「河川名」トグルで一括 OFF にできます。
6. `data/raw/osm/osaka-latest.osm.pbf` 自体は緯度 35.12 までノードを含むのに駅・place だけが欠けています。北部を本格的に埋めるなら、**OSM 抽出の取り直し**が最も確実です（ネットワークが必要なため今回は実施していません）。

## 14. 生成物

| 種別 | パス |
|---|---|
| データ | `public/map-data/osaka-city/labels/{place,landmark,river,station}-labels.json` + `manifest.json`（`data/processed/osaka-city/derived/labels/` にも同じもの）、`derived/plateau-place-labels.json` |
| ツール | `tools/build-plateau-place-labels.js`、`tools/build-label-datasets.js`、`tools/audit/osm-label-source-scan.js`、`tools/audit/label-enrichment-qa.js`（`npm run preview` が必要） |
| Validator | `tools/validate/label-enrichment.js` |
| レポート | `data/reports/{plateau-place-labels,label-datasets,osm-label-source-scan,label-enrichment-qa,label-enrichment-validation}.json`、`data/reports/label-enrichment-qa/*.jpg` |
| テスト | `tests/label-enrichment.test.js`（npm test に登録） |
| 変更したファイル | `public/osaka_3d_buildings.ward-ux-v1.html`（development のみ） |

production へはまだ反映していません。実機で確認していただき、問題なければ次ミッションで cutover（`node tools/build-production-html.js`）します。

`OSAKA_LABEL_ENRICHMENT_SUCCESS`
