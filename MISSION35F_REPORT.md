# Mission 35F｜OSM SHARED-SOURCE COVERAGE AUDIT

結論: **`OSM_SHARED_SOURCE_AUDIT_SUCCESS`**（最終判定は §12 の validator 出力）

旧 `osaka-latest.osm.pbf` は緯度 34.73 付近で切れている。35D で建物、35E で道路を直したが、
**同じ PBF を引いている他のレイヤーが残っていた**。今回それを全部洗い出し、
**実際に切断の影響を受けたものだけ**作り直した。

影響を受けていたのは **鉄道・駅・水系・公園・地名ラベル** の 5 レイヤー。
道路（35E の状態）と建物（V4）は意図的に触っていない。production の cutover もしていない。

---

## 1. source dependency inventory（§2）

`tools/audit/osm-source-dependency-inventory.js` → `data/reports/osm-source-dependency-inventory.json`

| レイヤー | source | 生成手順 | 配信先 | prod 共有 | 35F 前の source |
|---|---|---|---|---|---|
| 道路 | `raw/osaka-city/roads-osm.json` | `osm-pbf-city.js → build-city-layer-tiles.js → build-canonical-roads.js → refined-road-surface` | `derived/{near,mid,far}/roads` | **共有** | 広域（35E で移行済み） |
| 鉄道 | `raw/osaka-city/railways-osm.json` | `osm-pbf-city.js → build-city-layer-tiles.js → build-canonical-rail.js` | `derived/{near,mid,far}/rail` | **共有** | **旧 PBF** |
| 駅 | 同上（`railway=station` node） | `build-canonical-rail.js` | `derived/rail-stations.json` → `labels/station-labels.json` | **共有** | **旧 PBF** |
| 水系 | `raw/osaka-city/waterways-osm.json` | `osm-pbf-city.js → build-city-layer-tiles.js → build-river-layer.js` | `rivers-v2/rivers.json` | **共有** | **旧 PBF** |
| 水域 canonical | （OSM 直参照なし） | `build-canonical-water.js`（rivers-v2 + 海面ラスタ） | `derived/{near,mid,far}/water` | **共有** | 入力が旧 PBF 由来 |
| 海面ラスタ | （非 OSM） | `build-water-surface.js` | `water-surface/water-surface.json` | **共有** | 非依存 |
| 公園 | `raw/osaka-city/parks-osm.json` | `osm-pbf-city.js → build-city-layer-tiles.js → build-canonical-parks.js` | `derived/{near,mid,far}/parks` | **共有** | **旧 PBF** |
| 地名ラベル | PBF の `place` node を直接読む | `build-place-labels.js` | `derived/place-labels.json` → `labels/place-labels.json` | **共有** | **旧 PBF** |
| 駅ラベル | `derived/rail-stations.json` | `build-label-datasets.js` | `labels/station-labels.json` | **共有** | 駅 canonical 経由 |
| 建物 | PLATEAU CityGML + OSM fallback | `build-final-buildings-v4.js` | dev `derived-v4-final` / prod `derived-v2-osmv2` | **分離** | 35D で対応済み |

監査後: **旧 PBF に残っているレイヤーは 0**（`stillOnOldPbf: []`）。

### ここで一度間違えた

最初のインベントリは、生成物の `_meta.input` だけを見て source を判定していた。
`build-place-labels.js` の出力は `_meta` を持たず、トップレベルの `source` に
`data/raw/osm/osaka-latest.osm.pbf` と書いていたので、**地名ラベルを「OSM 非依存」と誤って分類した**。
`pbfOf()` が `_meta.input` / `_meta.source` / `source` / `sourceFile` のどれからでも
`*.osm.pbf` を拾うように直し、`place-labels` に `pbfProbe` を持たせて測り直した。

---

## 2. 旧 PBF の切断監査（§3）

`tools/audit/osm-shared-source-coverage.js` → `data/reports/osm-shared-source-coverage.json`

PBF 全体: 旧 nodes 5,909,958 / ways 1,256,862 → 新 nodes 46,684,627 / ways 7,406,360（近畿全域）。

| 種別 | 全体 old→new | **北部** old→new | 北 | **南部** old→new | 南 | 影響 |
|---|---|---|---|---|---|---|
| `railway` way | 3,345→5,223 | 757→1,120 | **+48.0%** | 1,982→1,982 | 0.0% | あり |
| `railway=station` node | 288→362 | 39→55 | **+41.0%** | 185→185 | 0.0% | あり |
| プラットフォーム | 431→559 | 62→89 | **+43.5%** | 251→251 | 0.0% | あり |
| 車両基地 (`service=yard`) | 655→1,359 | 142→196 | **+38.0%** | 371→371 | 0.0% | あり |
| `public_transport` | 5,389→7,670 | 717→962 | **+34.2%** | 2,925→2,941 | +0.5% | あり |
| `waterway` way | 1,613→5,096 | 135→197 | **+45.9%** | 417→417 | 0.0% | あり |
| `natural=water` | 473→830 | 94→135 | **+43.6%** | 232→232 | 0.0% | あり |
| `leisure=park` | 2,168→3,337 | 228→352 | **+54.4%** | 879→878 | −0.1% | あり |
| `landuse=grass` | 1,506→1,968 | 622→702 | **+12.9%** | 729→729 | 0.0% | あり |
| `landuse=recreation_ground` | 126→215 | 15→20 | **+33.3%** | 45→45 | 0.0% | あり |
| 公園レイヤー全体 | 3,795→5,515 | 864→1,073 | **+24.2%** | 1,649→1,648 | −0.1% | あり |
| `place` ラベル node | 3,898→5,484 | 299→419 | **+40.1%** | 1,543→1,543 | 0.0% | あり |

**12 種別すべてが影響を受けていた。**

### 判定方法を途中で変えた

最初は建物・道路と同じく「緯度帯ごとの件数の崖」で切断を判定していた。
建物のように 1 帯あたり数千件あれば崖は明確に出るが、**鉄道・水系・公園は疎すぎて崖にならない**
（例: 鉄道 way の緯度 34.73 帯は旧 85 件・その上は 0〜2 件。母数が小さく「崖」と呼べる形にならない）。
実際 12 種別すべてで `cliffSaysTruncated: false` が返り、「切断されていない」という誤った結論になりかけた。

そこで判定を **北部と南部の増え方の差** に変えた（`truncationSignal`）:

- 北部（東淀川・淀川・旭・西淀川・北）が **+5% 以上** 増えている
- かつ南部が **±5% 以内**（＝ OSM 側の通常の編集差ではない）

南部が 12 種別中 10 種別でぴったり 0.0%、残り 2 つも ±0.5% 以内で動かないのに、
北部だけが 13〜54% 増える。これは切断以外に説明がつかない。

---

## 3. 24 区の OLD/NEW 比較（§4）

重点 5 区（`byWard` より）:

| 種別 | 東淀川 | 淀川 | 旭 | 西淀川 | 北 |
|---|---|---|---|---|---|
| 鉄道 way | **13→173** | **295→498** | 32→32 | 38→38 | 379→379 |
| 水系 way | **32→78** | **8→18** | **10→16** | 19→19 | 66→66 |
| 公園（全体） | **20→177** | **137→182** | 55→59 | 94→94 | 558→561 |
| `place` ラベル | **5→88** | **57→89** | 42→47 | 64→64 | 131→131 |
| 駅 node | **2→10** | **5→12** | 6→7 | 5→5 | 21→21 |

南側の代表区は全種別で 1 件も動いていない（住吉 鉄道 77→77 / 公園 72→72 / place 105→105、
平野 36→36 / 70→70 / 141→141、西成 96→96 / 84→84 / 86→86）。

**東淀川区が最も酷く、鉄道は 13 本しか無かった**（実際には阪急京都線・千里線・おおさか東線・
JR 京都線が通る区）。淀川区は新幹線基地の分だけ元々あったが、それでも 295→498。
旭区・西淀川区・北区はほぼ緯度 34.73 以南に収まるため影響が小さい。

---

## 4. 影響のあったレイヤーだけ作り直した（§5）

`tools/audit/osm-shared-source-rebuild-summary.js` → `data/reports/osm-shared-source-rebuild.json`

「OSM 由来だから全部作り直す」はしていない。§2 の北/南差分で影響を確認したレイヤーだけを作り直した。

**作り直した（5）**

| レイヤー | やったこと |
|---|---|
| rail | raw → tiles → `canonical/rail` → `derived/{near,mid,far}/rail` |
| stations | `canonical/rail/stations.json` → `derived/rail-stations.json` → `labels/station-labels.json` |
| water | raw → tiles → `rivers-v2` → `canonical/water` → `derived/{near,mid,far}/water` |
| parks | raw → tiles → `canonical/parks` → `derived/{near,mid,far}/parks` |
| place-labels | `build-place-labels.js` の source を広域 PBF へ → `derived/place-labels.json` → `labels/place-labels.json` |

**触らなかった（4）**

| レイヤー | 理由 |
|---|---|
| roads | 35E で広域 PBF へ移行済み。derived は production と共有しているので rollback しない（§13） |
| buildings | 35D/35E で V4 を作成済み。今回 cutover もしない（§13） |
| water-surface | 海面ラスタ。OSM 非依存 |
| canonical water の生成規則 | 作り方（rivers-v2 + 海面ラスタ）は変えず、入力だけ新しくした |

derived の再生成は `tools/build-derived-shared-layers.js` で rail/water/parks **だけ** を対象にした。
既存の `build-derived-geometry.js` の `main()` は water/roads/buildings/parks/rail をまとめて作り直すため、
そのまま回すと道路（35E の状態）と建物を巻き込む。LOD の可視判定
（`railVisibleAt` / `waterVisibleAt` / `parkVisibleAt`）は元実装からそのまま写し、変えていない。

旧 raw は `*-osm.osaka-latest-backup.json`、旧ラベルは `*.osaka-latest-backup.json` として全部残した。
旧 PBF `data/raw/osm/osaka-latest.osm.pbf` も削除していない。

---

## 5. 鉄道（§6）

`canonical/rail` **2,828 → 3,216 本**（+388）。derived near 3,216 / mid 2,151 / far 1,724。

| 区別 | 現状 |
|---|---|
| 本線（`rail` 2,724 / `subway` 427 / `light_rail` 65） | `canonical/rail` の line feature。tier（major 1,724 / urban 427 / local 1,065）別に描く |
| 駅（`railway=station` node） | `canonical/rail/stations.json` = **253**（別ファイル。線とは混ぜない） |
| 車両基地（`service=yard`） | **canonical では区別できていない**（下記） |
| プラットフォーム（`railway=platform`） | 取り込んでいない。抽出の way フィルタが `rail\|light_rail\|subway` のみ |

**表示方式は変えていない。** `buildGroup(layer === 'rail')` は従来どおり tier ごとに 1 本の
`THREE.LineSegments` へ統合し、色・`renderOrder`・高さ（`Y.rail` / `Y.railBridge`）もそのまま。
今回変えたのは入力データだけ。

### 車両基地を区別しようとして、やめた

§6 に従って yard を分けようとしたところ、**canonical の `attributes.service` が全 3,216 件 null** だった。
原因は `tools/import/osm-pbf-city.js` の出力タグ白リストに `service` が無く、抽出時に落ちていたこと
（OSM では車両基地も `railway=rail` なので、`service` が無いと本線と見分けられない）。

`service` を白リストへ足して取り直した（way 4,768 本・geometry 差 0・増えたタグは `service` のみ。
内訳 yard 1,117 / siding 360 / crossover 206 / spur 21）。
ところが canonical へ通すと **siding 360 → 1,485・crossover 206 → 414 に膨れた**。

`build-canonical-rail.js` は tile に無い属性を **路線名単位** で補完している。
railway tile の feature は `{id, kind, railway, p, name, railClass}` しか持たず **元の way id を残していない**ため、
way ごとのタグを正しく結び付けられない。ある路線に 1 本でも側線があると、その路線の全 way が siding になる。

誤った区別を入れるより無い方がましなので、**`service` を路線名単位の補完から外した**
（canonical は従来どおり null、件数・LOD 分類は 3,216 / 1,724 / 427 / 1,065 で 1 つも動いていない）。
raw には `service` を残したので、次にやるときの材料はある。
本当に区別するには tile に way id の lineage を持たせる必要があり、それは tile パイプラインの変更なので別ミッション（§16-5）。

---

## 6. 水域（§7）

`canonical/water` **528 → 823**（+295）。derived near 823 / mid 214 / far 26。

**既存の canonical water を OSM で上書きしていない。** canonical water の作り方は
`build-canonical-water.js`（rivers-v2 + 海面ラスタ）のままで、その入力である rivers-v2 を
新しい PBF から作り直しただけ。海面ラスタ（`water-surface.json`）には触っていない。

二重表示の確認:

- geometry 指紋（0.1 m 丸め）の重複 **0 件**、canonicalId の重複 **0 件**
- 河川ラベルは 68 件で、`淀川` `神崎川` `安治川` `大和川` などいずれも **1 回ずつ**
- 淀川本流は canonical 側で 1 feature のまま（重複追加なし）

北部の増分は主に **神崎川水系**（東淀川 32→78、淀川 8→18、旭 10→16 の waterway way）。
神崎川は市域北端の境界河川で、旧 PBF では途中で途切れていた。

---

## 7. 公園（§8）

`canonical/parks` **2,954 → 4,194**（+1,240）。derived near 4,194 / mid 304 / far 55。

**ParkLayer の設計は維持。** 分類（`real` = park/recreation_ground/garden/playground、
`green` = green_space/sports_ground、`grass` = それ以外）も、LOD の出し分け
（far = `rankable` かつ 50,000 m² 以上 / mid = 実公園かつ 8,000 m² 以上 / near = 全部）も
`build-derived-geometry.js` のものをそのまま使っている。増えたのは北部の実データだけ。

区別の増分（canonical の代表点ベース）: 東淀川 169 / 淀川 175 / 旭 57 / 西淀川 93 / 北 356。

---

## 8. 駅とラベル（§9）

駅 **233 → 253**（+20）。北部の区別: 東淀川 10 / 淀川 12 / 旭 7 / 西淀川 5 / 北 21。

**駅名のハードコードはしていない。** `build-label-datasets.js` は
`derived/rail-stations.json`（canonical の駅）をそのまま使い、クラスタリングだけ
既存の `StationLabelLayer.clusterStations`（Mission14 と同じロジック）に委譲している。

### ここでもう一度間違いを見つけた

`derived/rail-stations.json` を 253 に更新しただけでは **画面のラベルは古いままだった**。
`CityLabelLayer` が実際に読むのは `labels/station-labels.json` で、これは
`build-label-datasets.js` が別に生成する。走らせ直すまで 233 のままで、
北部の駅名（東淡路・下新庄・柴島 など）は出ていなかった。

地名ラベルも同様に `build-place-labels.js` が旧 PBF をハードコードしていたので、
広域 PBF を優先する `resolvePbf()` に直した（旧ファイルはフォールバックとして残す）。

| ファイル | 35F 前 | 35F 後 |
|---|---|---|
| `derived/place-labels.json`（OSM place） | 697 | **872** |
| `labels/place-labels.json`（+ PLATEAU 町丁目） | 815 | **974** |
| `labels/station-labels.json` | 233 | **253** |
| `labels/river-labels.json` | 59 | **68** |

北部に出るようになった地名: 宮原・下新庄・東中島・東三国・豊秀町・淡路・東淡路・豊里・菅原・大桐 など。

---

## 9. 重複（§10）

`tools/audit/shared-layer-duplicate-audit.js` → `data/reports/shared-layer-duplicate-audit.json`

| レイヤー | 35F 前 | 後 | canonicalId 重複 | geometry 重複 | タイル行 | タイル跨ぎ |
|---|---|---|---|---|---|---|
| rail | 2,828 | 3,216 | **0** | **0** | 3,780 | 410 |
| water | 528 | 823 | **0** | **0** | 1,303 | 119 |
| parks | 2,954 | 4,194 | **0** | **0** | 4,446 | 236 |
| stations | 233 | 253 | **0** | — | — | — |

`duplicateRailIncrease = 0` / `duplicateWaterIncrease = 0` / `duplicateParkIncrease = 0`。

### 数え方で 2 回間違えた

1. **タイル跨ぎを重複と数えていた。** canonical のタイルは、複数タイルにまたがる feature を
   各タイルへ重複して載せる（1 本の鉄道路線が 8 タイルに出るのは仕様）。
   素朴に全タイルの feature を足すと rail 3,780 行になり、manifest の 3,216 と合わず
   「564 件の重複」に見えた。`canonicalId` で畳んでから数えるよう直し、
   タイル行数と跨ぎ数は別項目として残した。
2. **見本の配列長を重複件数として報告していた。** 見本は 20 件で打ち切るので、
   実際に何件あっても「20」と出る。カウンタと見本を分けた。

さらに駅について、**同名で近い駅を重複と判定していた**。これは乗換駅（鶴橋の JR / 近鉄 /
地下鉄が別 node など）で OSM の元々の性質。絶対数ではなく**旧 source との率の比較**に直した:

- 旧: 駅 271 件中 同名近接 25 組 = **9.2%**
- 新: 駅 332 件中 同名近接 29 組 = **8.7%**

率は上がっていない（`rateIncreased: false`）＝ 35F が重複を増やしていない。

---

## 10. 実ブラウザ QA（§11）

Edge headless + 実 GPU（`tools/lib/cdp-browser.js`）。各地点で真下へ 2,601 本レイを撃ち、
半径 350 m の正方形のうち何割がそのレイヤーに覆われているかを測る。
スクリーンショットは `data/reports/osm-shared-source-qa/*.jpg`。

| 地点 | 建物 | 道路 | 鉄道 | 水域 | 公園 | ラベル | 駅ラベル |
|---|---|---|---|---|---|---|---|
| 新大阪 | 10% | 28% | **21%** | 0% | 0% | 2 | 1 |
| 東三国 | 37% | 26% | **2%** | 0% | 1% | 2 | 1 |
| 淡路 | 40% | 21% | **4%** | 0% | 0% | 3 | 1 |
| 上新庄 | 37% | 18% | **1%** | 0% | 0% | 4 | 1 |
| 十三 | 23% | 20% | **5%** | 0% | 0% | 6 | 1 |
| 西中島 | 30% | 27% | **6%** | 0% | 0% | 3 | 2 |
| 柴島 | 27% | 18% | **3%** | 6% | 0% | 4 | 2 |
| 旭区北部 ※ | 8% | 13% | **2%** | 24% | 17% | 2 | 0 |

**8 地点すべてで鉄道が出ている**（35F 前は全地点 0%。下記の計測バグのため）。
新大阪が 21% と突出するのは新幹線の車両基地で軌道が並走しているため。
水域は淀川・城北川に近い柴島・旭区北部でのみ出る（内陸の地点で 0% なのは正しい）。

※ **旭区北部は地点そのものを訂正した。** 35E から引き継いだ座標 34.7320 / 135.5560 は
**どの区ポリゴンにも入っていなかった**（市境を越えて守口市側）。建物タイルは区に紐づいて
読み込まれるため、区が決まらないこの点では建物が 1 棟も出ず「旭区北部の建物 0%」という
誤った読みになっていた（道路は区に紐づかないので 14% 出ていた）。
旭区の中の点 34.7360 / 135.5540 へ直したところ 建物 8% / 水域 24% / 公園 17% になった。
35E の `SITES` 自体は変えていない（35E のレポートの数字を後から動かさないため）。
訂正は `SITE_FIX` として 35F 側に持ち、`originalLat` / `originalLon` も記録している。

画面が読んでいる駅ラベル（クラスタ後）: **174 → 191**。
`labels/station-labels.json` を 253 に作り直したことが実際に反映されている。

---

## 11. 性能（§12）

| 地点 | FPS | frame p95 | draw calls | 三角形 | tiles | 35E |
|---|---|---|---|---|---|---|
| 梅田 | **52.4** | 33.5 ms | 238 | 460,340 | 240 | 36.9 |
| 新大阪 | **55.1** | 33.4 ms | 157 | 404,807 | 239 | 33.3 |
| 東淀川 | **59.9** | 16.8 ms | 201 | 351,177 | 240 | 33.8 |
| 淀川 | **49.8** | 33.6 ms | 197 | 414,895 | 240 | 30.8 |
| City Mode | **37.7** | 33.6 ms | 1,634 | 1,887,118 | 547 | 26.9 |

鉄道 +388 本 / 水域 +295 / 公園 +1,240 を足したが、**5 地点すべてで 35E より速い**。
悪化していないので原因調査（§12 の但し書き）は不要。
鉄道は tier ごとに 1 本の `LineSegments` へ統合されるため本数が増えても draw call は増えず、
公園・水域も面を 1 mesh へ統合しているため同様。

---

## 12. regression と validator（§14/§15）

`data/reports/osm-shared-source-audit-validation.json` → **RESULT: PASS / errors 0 / warnings 0**

| 項目 | 値 |
|---|---|
| `buildingV4DevDefault` | **true** |
| `productionBuildingCount` | **600764** |
| `road35EStatePreserved` | **true**（roads 199,840 / refined 29,942 / source 広域 PBF） |
| `projectionMutation` | **false** |
| `canonicalBuildingMutation` | **false**（V4 618,749 のまま） |
| `roadV3LogicMutation` | **false** |
| `duplicateRailIncrease` | **0** |
| `duplicateWaterIncrease` | **0** |
| `duplicateParkIncrease` | **0** |
| `productionModified` | **false** |
| `protectedModified` | **false** |
| `stillOnOldPbf` | **[]** |

regression（§14）は実ブラウザで全項目 OK・JS 例外 0:

`roadMode: ROAD_V3` / `buildingsVersion: V4` / `selfCheck: 0` / `highLod: true` /
`labels: ok` / `stationLabels: ok` / クリック `pick: true` / プロパティカード `card: true` /
区名表示 `cardHasWard: true` / 検索 `search: true` / 鉄道・水域・公園・道路の各レイヤー存在 true。
区切り替えは 8 地点すべてで `WardModeManager.switchWard()` を通しており、全地点で描画されている。

---

## 13. npm test（§16）

**2,094 tests / 2,079 pass / 0 fail / 15 skip**

最初は 7 件失敗した。すべて「旧データを前提に直書きされた固定値」で、実装の回帰ではない。
数字を書き換えて通すのではなく、**その検査が何を守りたかったのか** に戻して直した。

| 失敗したテスト | 中身 | 対応 |
|---|---|---|
| `[31F] canonical rail` | 駅 233 直書き | `canonical-baseline.js` の `CANONICAL_STATION_COUNT` を参照へ |
| `[32R §5-§9]` `[32R §14]` | 同上（2 か所） | 同上 |
| `[33C §4] 駅は canonical rail をそのまま使う` | **「北部に駅は 0 件」** を仕様として固定していた | 「北部に駅が 10 件以上出る」＋出所が `canonical-rail-stations` であることへ |
| `[33C §3/§5] 北部の地名` | **「北部は PLATEAU 由来のはず」** | 33C 当時は OSM に北部の place が無かったためで、今は OSM からも入る。「出所が記録されていること」へ |
| `[Mission22] 主要7河川 geometry 回帰` | 神崎川 5 seg / 258 tri / 6,692 m | **20 / 814 / 18,324 m** へ更新（他 6 河川は 1 つも動いていない） |
| `[Mission04] 神崎川の 43m ピンチ` | 最小幅 > 60 m | 狙いは「単発の落ち込みが無いこと」。隣接比で見る判定へ書き換え（実測の最悪比 1.026） |

`canonical-baseline.js` には rail 2,828→3,216 / stations 233→253 / water 528→823 /
parks 2,954→4,194 を理由つきで履歴に追加した（35E で roads について作った仕組みと同じ）。

**神崎川の 5 seg → 20 seg は今回の成果そのもの。** 市域北端の境界河川で、
旧 PBF では下流 6.7 km しか入っておらず、本来の 18.3 km になった。
他の 6 河川（淀川・大和川・安治川・木津川・寝屋川・道頓堀川）は seg 数・三角形数・
centerline 長のいずれも 1 も動いていない。**生成ロジックではなく入力だけが変わった**証拠。

---

## 14. production / protected の状態（§13）

- `public/osaka_3d_buildings.html`（production）: **未変更**。建物は V2N・600,764 のまま。
  build profile も変えていない。
- `public/osaka_3d_buildings.fullward-v3.html`（protected）: **未変更**。
- **既知状態**: production が読む道路 derived は共有データなので、**35E で更新済みのものを
  既に読んでいる**。これは 35E で承認された状態であり、rollback していない。
- **今回新たに共有データが変わったレイヤー**: rail / water / parks / stations / place-labels。
  これらの derived・labels も production と共有のため、**production の表示にも反映される**。
  建物だけが dev/prod で namespace 分離されている（dev `derived-v4-final` / prod `derived-v2-osmv2`）。
- 建物の production cutover は **していない**（§19）。

---

## 15. 自分の誤りを 6 件見つけて直しました

1. **疎なレイヤーに「崖」判定を使った** — 12 種別すべてで「切断されていない」と出た。
   北/南の差分に変えたら全部影響ありだった。
2. **タイル跨ぎを重複と数えた** — rail で 564 件の偽の重複。canonicalId で畳んで解決。
3. **見本の上限を重複件数として報告した** — 何件あっても 20 と出る。カウンタを分けた。
4. **乗換駅を重複と判定した** — 絶対数ではなく旧 source との率比較に変更。
5. **鉄道が実ブラウザで 0% と出た** — canonical の鉄道は `THREE.LineSegments` で描かれており、
   QA プローブが `o.isMesh` だけを集めていた。`isLineSegments` も対象にし、
   線の当たり幅（複線の軌道敷 = 4 m）を `Raycaster.params.Line.threshold` に設定して 0% → 実測値になった。
   **35E の「道路 0%」と同じ種類の誤り**（データではなく計測が壊れていた）。
6. **QA 地点が市域の外にあった** — 「旭区北部」として 35E から引き継いだ 34.7320 / 135.5560 は
   どの区ポリゴンにも入らない（守口市側）。建物タイルは区に紐づくので建物が 0% になり、
   「旭区北部に建物が無い」と読めてしまう。旭区内の点へ直したら 8% / 水域 24% / 公園 17% になった。

加えて §1 と §9 で、インベントリの source 判定漏れ（地名ラベル）と、
配信ファイルとラベルファイルの二段構造（`rail-stations.json` ≠ `station-labels.json`）を見つけて直した。

**3 回とも同じ形の誤り**（鉄道 0% / 建物 0% / 重複 564 件）で、いずれも
**データではなく計測が壊れていた**。35D・35E に続いて 3 ミッション連続なので、
おかしな数字が出たらまず測り方を疑うのが正しい。

---

## 16. known gaps

1. **市域外のラベルが増えた（地名 241 → 387 件、駅 9 → 13 件）。** `build-place-labels.js` は
   大阪市の外接矩形（`CITY_BBOX`）で切っており、区ポリゴンでは切っていない。
   旧 PBF では北側が物理的に無かったので北の市域外地名も出なかったが、広域 PBF では出る
   （南吹田・東園田町・南武庫之荘 など）。ただし**南側では以前から同じことが起きていた**
   （滝井元町 = 守口市、天美東 = 松原市、衣摺 = 東大阪市）ので、35F が作った問題ではなく、
   北も南と同じ挙動になっただけ。既存設計を勝手に変えないため今回は触っていない。
   駅も同じで、旧 233 件中 9 件（布施・徳庵・八尾南 など）が既に市域外だったものが、
   新 253 件では 13 件（+ 守口市・守口・太子橋今市・南吹田）になった。
   直すなら「区ポリゴンで切る」だが、それはラベル側の設計変更なので別ミッション。
2. **プラットフォーム（`railway=platform`）は canonical rail に入れていない。** 面データであり、
   線路として描くと二重になる。北部で +43.5% 復活しているが、現在の表示設計では使っていない。
3. **旭区の鉄道は 32→32 で増えていない。** 旭区は緯度 34.73 以南にほぼ収まるため、
   切断の影響がもともと小さい。京阪本線は復活対象外（元から入っていた）。
4. **`landuse=grass` の北部増分（+12.9%）は他より小さい。** 北部の OSM 側の入力密度そのものが
   低い可能性があり、切断以外の要因（マッピング粒度）が混ざっている。
   ただし南部が 0.0% で動かないので、切断の影響が**ある**ことは変わらない。
5. **車両基地（yard / siding / crossover）を canonical で区別できない。** §5 のとおり、
   railway tile の feature が元の OSM way id を持たないため、way 単位のタグを結び付けられない。
   raw には `service` を残した（yard 1,117 / siding 360 / crossover 206 / spur 21）ので、
   tile に way id の lineage を足せば区別できる。**bridge / tunnel / layer も同じ性質の
   way 単位タグ**なので、raw に入れる場合は同じ罠を踏む（`build-canonical-rail.js` に注意書きを入れた）。
6. **`derived` の rail は `name / railway / lodClass / railClass` しか運ばない**（`pickAttr`）。
   canonical に属性を足してもランタイムには届かない。表示に使うには derived 側の設計変更が要る。

---

## 17. 成果物

**新規**

| ファイル | 役割 |
|---|---|
| `tools/audit/osm-source-dependency-inventory.js` | §2 各レイヤーの source / 生成手順 / prod 共有の有無 |
| `tools/audit/osm-shared-source-coverage.js` | §3 12 種別の旧/新 PBF 比較。北/南差分で切断を判定 |
| `tools/audit/osm-shared-source-rebuild-summary.js` | §5 作り直した／触らなかったレイヤーと理由 |
| `tools/audit/shared-layer-duplicate-audit.js` | §10 重複と乗換駅の区別 |
| `tools/build-derived-shared-layers.js` | §5 rail/water/parks **だけ** の derived 再生成 |
| `tools/audit/osm-shared-source-runtime-qa.js` | §11/§12/§14 実ブラウザ QA |
| `tools/validate/osm-shared-source-audit.js` | §15 validator |
| `tests/osm-shared-source-audit.test.js` | §16 テスト |

**変更**

| ファイル | 変更 |
|---|---|
| `tools/build-place-labels.js` | source を広域 PBF 優先の `resolvePbf()` に（旧はフォールバックとして残す） |
| `tools/build-label-datasets.js` | 「北部は元データに無い」という但し書きを削除（事実でなくなった） |
| `tools/lib/canonical-baseline.js` | rail / stations / water / parks の件数と履歴を追加 |
| `tools/import/osm-pbf-city.js` | railways の出力タグに `service` を追加（車両基地の区別用。raw のみ） |
| `tools/build-canonical-rail.js` | way 単位の `service` を路線名単位で配るのをやめた（誤った区別を防ぐ） |
| `tests/canonical-derived.test.js` / `tests/final-ui-cleanup.test.js` / `tests/label-enrichment.test.js` | 駅 233 直書き → `CANONICAL_STATION_COUNT`。「北部に駅・地名は無い」という旧前提を書き換え |
| `tests/mission22-river-network.test.js` | 神崎川のスナップショットを更新（他 6 河川は不変） |
| `tests/mission04-river-width-smooth.test.js` | 最小幅の固定値 → 隣接比による「単発の落ち込み」判定へ |
| `package.json` | テストを登録 |

**データ**（いずれも旧版をバックアップとして保存）

`raw/osaka-city/{railways,waterways,parks}-osm.json` /
`public/map-data/osaka-city/{railways,waterways,parks}/` /
`canonical/{rail,water,parks}` / `derived/{near,mid,far}/{rail,water,parks}` /
`derived/rail-stations.json` / `derived/place-labels.json` /
`labels/{place,station,river}-labels.json`

---

## 18. STOP

§19 のとおりここで止まります。

- 建物の production cutover は **していません**。
- `public/osaka_3d_buildings.html` の build profile も変えていません。
- 旧 PBF の影響を受けていたレイヤーは **鉄道・駅・水系・公園・地名ラベル** の 5 つでした。
- 道路（35E）と建物（V4）は意図的に触っていません。

次に進む場合の判断はユーザーにお願いします。

**`OSM_SHARED_SOURCE_AUDIT_SUCCESS`**
