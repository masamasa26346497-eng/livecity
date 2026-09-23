# Mission 35K｜STATION LABELS & TOWN AREA NAVIGATION 報告

判定: **`STATION_AND_TOWN_NAVIGATION_SUCCESS`**

対象は development のみ（`public/osaka_3d_buildings.ward-ux-v1.html`）。
production は変更していない。protected（`public/osaka_3d_buildings.fullward-v3.html`）も 1 バイトも触っていない。
**production cutover は行っていない**（§30 / §35）。

---

## 1. station source（駅データの出どころ）

駅名・路線名を手で並べたものは 1 件も無い（§1）。すべて既存データの結合。

| 役割 | ファイル | 件数 |
|---|---|---|
| 駅の位置・名称（正本） | `data/processed/osaka-city/canonical/rail/stations.json` | 253 |
| 事業者・路線の属性 | OSM 広域 PBF の駅 node（`operator` / `operator:en` / `network` / `station` / `public_transport` / `ref`） | 位置一致で 253 件へ結合 |
| 近傍路線名 | canonical rail line（`nearbyLines()` 半径 220 m） | 事業者不明分の補完 |
| 生成物 | `public/map-data/osaka-city/derived/station-index.json` | 230（統合後） |

生成スクリプトは `tools/build-station-index.js`。

補足（実装上の落とし穴）: canonical の station id は `station_49be4527af0489` のようなハッシュで
OSM node id ではないため、**id 結合はできない**。位置での結合（`JOIN_M = 5` m）にしている。
OSM 抽出側は駅 node のタグ白名簿（`KEEP_TAG_KEYS_STATION_NODE`）を足して再抽出した。way のタグは変えていない。

## 2. station total（駅数）

- canonical: **253**
- 表示（統合後）: **230**
- 統合で減った分: **23**

重要度の内訳（§8 の zoom 帯に対応）:

| importance | 件数 | 意味 |
|---|---|---|
| major | 2 | 新今宮(JR) / 梅田(M) — 近傍の別事業者が最も多い駅 |
| transfer | 74 | 半径 260 m 以内に別事業者の駅がある |
| local | 154 | それ以外 |

## 3. operator breakdown（事業者の内訳）

分類は**会社名の hardcode ではなく** `operator` / `network` / 路線名の文字列マッチ（§2）。

| group | 件数 | operator（code） |
|---|---|---|
| metro | 103 | Osaka Metro `M` 103 |
| jr | 53 | JR西日本 `JR` 52 / 新幹線 `SK` 1 |
| private | 73 | 南海 `NK` 18 / 阪神 `HS` 15 / 京阪 `KH` 15 / 阪急 `HK` 12 / 近鉄 `KT` 11 / 阪堺 `HN` 2 |
| other | 1 | 不明 `?` 1（北天下茶屋） |

判定に使った情報源:

| operatorSource | 件数 |
|---|---|
| `operator` タグ | 124 |
| 近傍路線名からの推定 | 104 |
| `network` タグ | 1 |
| 決められず | 1 |

途中で 2 つ直している:

- **JR 16 駅が不明**だった。最寄り 1 本だけを見ていたため、事業者名の付かない路線名（「大阪環状線」）に当たると
  判定できなかった。半径内の全路線を見る `nearbyLines()` と、「JR大阪環状線」から「大阪環状線 → jr」を
  学ぶ `learnLineOperators()` を入れて 1 件まで減らした。
- **東淀川が JR貨物**になっていた。貨物線が先に一致していたため。貨物を後回しにする規則を入れて JR西日本になった。

ロゴは使っていない。色 + 2 文字の記号（`M` / `JR` / `HK` / `HS` / `KT` / `NK` / `KH` / `SK` / `HN`）だけで区別している（§6）。

## 4. deduplication（同一駅の統合）

規則（§4）:

- **名前が違えば別駅**。大阪駅 / 梅田駅 / 東梅田駅 / 西梅田駅は統合しない。
- 統合するのは **同名 かつ 同事業者 かつ 450 m 以内**（`DEDUPE_M = 450`）。
- 乗換は統合ではない。260 m 以内に**別事業者**があれば `transferWith` に積む（`TRANSFER_M = 260`）。

253 → 230（23 件統合）。当初 90 m にしていたが、なんば・本町・心斎橋が地下鉄ホームの分割で
二重に出たため 450 m にした（同名・同事業者に限るので別駅は畳まれない）。

実際に画面で「大阪梅田駅(HK)・梅田駅(M)・大阪駅(JR)・大阪梅田駅(HS)・東梅田駅(M)・西梅田駅(M)・北新地駅(JR)」が
すべて別々に出ていることを実機で確認している（§10 のスクリーンショット）。

## 5. station label design（駅ラベルの見た目）

- CanvasTexture + Sprite。既存 `CityLabelLayer` のテクスチャキャッシュに乗せている（新レイヤーを足していない）。
- **駅は町名ラベルより強い**（§5）: font 15 / 13.5 / 12（major / transfer・medium / local）に対し、町名は 17 / 14 / 12 で
  **weight と pill の有無で差をつけている**。駅は `weight 700` + 白 pill + 枠、町名は pill 無しのハロー文字。
- 事業者バッジは pill の左に置く四角（`badge = {text: 事業者コード, bg: 事業者色, fg:'#ffffff'}`）。
  事業者が決められない駅だけ従来の丸（`dot`）に落ちる。
- emoji は使っていない。公式ロゴも使っていない（§6）。
- 優先度は既存の 1 本の collision キューに統合（§7）:
  ランドマーク S(0) > **主要駅(0.8)** > 区名・遠景(1.5) > ランドマーク A(2.5) > **乗換駅(2.2)** > ランドマーク B(3) > **駅(4.2)** > 地名 > 公園。
  ランドマーク S は駅より上に残してあるので、重要なランドマークが駅に押し出されることはない。
- zoom 帯（§8）: 遠景 = major のみ / 中距離 = transfer も / 近距離 = 全駅。

## 6. town label → boundary mapping（町名ラベル → 範囲）

生成スクリプトは `tools/build-area-boundaries.js`、出力は `public/map-data/osaka-city/derived/area-boundaries.json`。

手元に実在する境界データは 2 つだけ:

1. 町丁目ポリゴン（HTML 内 `TOWN_POLYGONS`・**住吉区 / 東住吉区 / 平野区の 3 区のみ**・出典未確認 legacy）
2. 区界（N03 行政区域・24 区すべて・正式データ）

| 種別 | 件数 | granularity | 出典 |
|---|---|---|---|
| 町丁目 | 340 | `chochome` | legacy-unverified |
| 基準地名の束ね（例: 東粉浜 = 東粉浜 1〜3 丁目） | 77 | `chochome-union` | legacy-unverified |
| 区界 | 24 | `ward` | n03-official |

ラベル → 範囲の対応: 町丁目へ 76 件 / 区界へ 513 件 / 引けず 385 件（市域外の地名）。

**町丁目データが無い区については区界へ落としている。推測ポリゴンは 1 つも作っていない**（§12。validator の
`inventedBoundary = 0`）。UI 側も「町丁目をまとめて表示」「区の範囲」のようにどちらを出しているか明示する。

実装で 1 つ直している: HTML が `id: 'place:' + q.id` としていたため `place:place:osm:福島` になり、
`place:osm:福島` を鍵にした対応表を引けず、町名クリックが無反応だった。`labelKey()` で正規化して解決。

## 7. town zoom algorithm（ズーム）

- bbox フィット（§15）。`fitRadius = max(半対角 × 1.35, 下限)`。真上視点には強制しない。**カメラの角度は変えない**（§15）。
- 小さい町は近く、大きい町は遠くなる（半対角に比例するため自動的にそうなる）。
- 遷移は 600 ms の ease-in-out（§16。`ANIM_MS = 600`）。
- 強調（§13/§14）: 輪郭 turquoise `0x40fff0`、内部 fill の不透明度 **0.07**（0.04〜0.10 の範囲内）。
  道路・鉄道より上、建物は隠さない。選択中のみ描画。
- 解除（§17）: 同じラベルの再クリック / 空白クリック / ESC / 小バーの ✕。
- 選択状態は `{ type, id, name, ward, wardId, bbox, polygon }`（§19）。
- 表示は下部の小さなバーだけ（§18）。既存の property card とは別物で、巨大カードは出さない。

## 8. click priority（クリックの優先順位）

`UI → station / town label → 施設 → 建物 → 背景` の順（§20）。
ラベル判定は建物 pick より**前**に入れ、当たったらそこで `return` する。ラベル判定が例外を投げても
建物クリックは従来どおり動くよう try/catch で囲っている。

ドラッグ・回転での誤発火は**既存の clickIntent ロジックをそのまま使っている**（§21）。新しい判定は作っていない。

実測（`clickConflict`）: 町名ラベル「中崎西」をクリック → `cardOpened: false`（背後の建物カードは開かない）。
実測（`dragNoClick`）: ドラッグ後は `allows: false`。

境界線そのものはクリック対象にしていない（§22）。選択はラベルから。

## 9. north Osaka QA（北部・35F 復旧分）

35F で復旧した北部データを使っている（§25）。`northStationsOk: true`。

| 地点 | 確認できた駅 |
|---|---|
| shin-osaka | 新大阪(SK/JR/M) ほか 30 ラベル・事業者 M,SK,JR,HK |
| kita-osaka | 東淀川(JR) / 淡路(HK) / JR淡路(JR) / 上新庄(HK) / 相川(HK) / 南吹田(JR)・28 ラベル |

欠落 0。十三・淡路・上新庄・東淀川・新大阪いずれも出ている。

## 10. station QA（駅の実測）

8 地点すべてで複数事業者が同時に出ている（`stationSitesOk: true` / `missing: []`）。

| site | 表示ラベル数 | 出た事業者 |
|---|---|---|
| umeda | 37 | HK, JR, M, HS |
| namba | 39 | M, JR, HS, NK, KT |
| tennoji | 34 | JR, M, KT |
| shin-osaka | 30 | M, SK, JR, HK |
| kita-osaka | 28 | JR, HK, M |
| honmachi | 54 | HS, M, JR, KH, HK |
| kyobashi | 33 | JR, M, KH |
| yodoyabashi | 38 | M, JR, HS, KH |

観測できた事業者コード: `HK, JR, M, HS, NK, KT, SK, KH`。

駅クリック（§9）: 中崎町駅をクリック → 選択状態に `{name:'中崎町駅', operator:{code:'M'}, wardId:'kita', importance:'local'}`。
カメラも移動する。駅の詳細カードは作っていない（必須ではないため）。

§23 の確認駅（大阪/梅田・東梅田・西梅田・新大阪・なんば・大阪難波・天王寺・大阪阿部野橋・京橋・十三・淡路・上新庄・本町・心斎橋・淀屋橋）は
いずれかの site で表示を確認済み。淀屋橋は本町から 1.4 km 離れていて画面外だったため、専用 site を足した。

## 11. town QA（町名クリックの実測）

4/4 成功（`townSitesClicked 4 / 4`）。

| site | クリックしたラベル | 選ばれた範囲 | granularity | fit 半径 |
|---|---|---|---|---|
| sumiyoshi | 東粉浜 | towngroup:住吉区\|東粉浜 | `chochome-union` | 1,295 m |
| umeda-town | 中津 | ward:kita | `ward` | 1,955 m |
| honmachi-town | 福島 | ward:fukushima | `ward` | 1,726 m |
| awaji-town | 小松 | ward:higashiyodogawa | `ward` | 1,908 m |

`townGranularityOk: true` / `townSelectionShown: true`（輪郭メッシュ 2〜6）/ `townZoomApplied: true` /
`townClearOk: true`（解除で選択 null・輪郭 0）。

住吉は町丁目データがある区なので町丁目粒度、梅田・本町・淡路はデータが無い区なので区界。
**無い区について町界を作ってはいない**（§11/§12）。

## 12. performance（性能）

§27 の「35I 比 FPS 低下 ≤5%」は、**同一セッション・同一カメラで駅ラベル ON / OFF を交互に 2 往復**して測った。

| 梅田・同一カメラ | FPS | draw calls | ラベル数 |
|---|---|---|---|
| 駅ラベル ON | 48.0 | 483 | 38 |
| 駅ラベル OFF | 48.5 | 478 | 33 |
| **低下** | **1.0%** | — | — |

（ON の生値 47.3 / 48.8、OFF の生値 48.8 / 48.1。差は測定ノイズと同程度。）

35I の記録（梅田 49.8 fps）との単純な引き算は**使っていない**。35I 時点の梅田は draw call 285、
今回は 483 で、読み込まれていたタイルの状態が違う。そのまま引くと 35K と無関係な差まで 35K の費用に化ける
（35H の City Mode で 1 度やった間違いと同じ）。この点は該当テストにも理由付きで書いてある。

参考の絶対値:

| site | FPS | p95 | draw calls | ラベル | texture | sprite |
|---|---|---|---|---|---|---|
| umeda | 45.9 | 33.5 ms | 483 | 38 | 472 | 473 |
| namba | 43.0 | 33.5 ms | 517 | 39 | 472 | 473 |
| shin-osaka | 58.0 | 16.9 ms | 345 | 22 | 474 | 475 |
| city-mode | 24.5 | 116.9 ms | 2,958 | 18 | 483 | 484 |

§26（全 253 駅を毎フレーム作り直さない）: sprite は 473〜484 で、230 駅 + 地名 + ランドマーク + 区 + 公園 + 河川の
**全ラベル合計**。駅だけで 230 個の sprite を毎フレーム作ってはいない（テクスチャはキャッシュ、
画面に出るものだけ sprite 化、再選定は throttle + しきい値）。

## 13. regression（回帰）

`regressionOk: true` / **JS 例外 0**。

| 項目 | 結果 |
|---|---|
| 道路モード | ROAD_V3 |
| 建物バージョン | V4（618,749） |
| canonical self-check | 0 |
| 高 LOD 建物 | 有 |
| ラベル | ok |
| 検索 / hover / 建物 pick / property card / カードの区名 | すべて有 |
| 鉄道 / 水域 / 公園 / 道路 / 建物レイヤー | すべて有 |
| City Mode | 出入り可（計測済み） |
| 区切り替え | 8 site で実施、全て正常 |

## 14. validator

`node tools/validate/station-town-navigation.js`

```
RESULT: PASS
classification: STATION_AND_TOWN_NAVIGATION_SUCCESS
errors: 0   warnings: 0
```

| 項目 | 値 |
|---|---|
| buildingCount | 618,749 |
| canonicalGeometryMutation / canonicalIdMutation | 0 / 0 |
| projectionMutation / placementMutation | 0 / 0 |
| roadMutation / railMutation / waterMutation / parkMutation | 0 / 0 / 0 / 0 |
| stationMutation | 0 |
| layers | roads 199,840 / rail 3,216 / water 823 / parks 4,194 / stations 253 |
| inventedBoundary | **0** |
| classifiedByData（駅名 hardcode 無し） | true |
| townWardsOk（町丁目は 3 区のみ） | true |
| devUiGated（dev トグルが production に出ない） | true |
| productionModified | **false** |
| protectedModified | **false** |

## 15. npm test

```
tests 2193 / pass 2178 / fail 0 / skipped 15
```

35K で追加したテスト: `tests/station-town-navigation.test.js`（27 件）。
operator 分類 / 駅名では決めない / タグ → 路線の順 / 貨物除外 / 路線名の学習 / 別駅を畳まない /
統合条件 / 乗換判定 / 基準地名 / bbox / TOWN_POLYGONS 読み出し / 区界へのフォールバック /
駅索引の実データ / バッジと強さ / 再クラスタリングしない / クリック優先順位 / ドラッグ保護 /
selectedArea の形 / 境界の見た目 / ズーム / dev UI の隠蔽 / 確認地点の網羅 / 実測 6 件。

既存テストのうち 6 件は 35K の変更に合わせて**意図を書き直した**（古いリテラルに合わせ直してはいない）:

| テスト | 変更理由 |
|---|---|
| `35F 駅ラベルが読むファイルは…` | 読み先が `labels/station-labels.json` → `derived/station-index.json` に移った。統合後は件数が canonical と一致しないので `canonicalCount` 経由で追随を見る |
| `[Mission14] render loop / 駅名トグル / 初期表示` | クラスタリングが実行時 → ビルド時へ移った（実行時に再クラスタすると別駅が消える）。StationLabelLayer 側に実装が残っていることを見る形へ |
| `[33A] 優先度キュー` | 駅の rank が 1/4/6 → 0.8/2.2/4.2（§7） |
| `[33A] ラベルの見た目` | 駅の font が 13.5/12/10.5 → 15/13.5/12（§5） |
| `[33C §11/§13/§14]` | STATION_URL の移動 |
| `35J production は dev からプロファイル 1 行だけの変換` | `productionIsDevWithProfileOnly()` は cutover 直後しか成り立たない条件。35K は dev のみ変更（§30）なので必ず崩れる。恒常条件である build 記録との sha 一致へ差し替え |

`35K 実測: 性能と回帰` は §27 の比較方法を上記 12 の A/B へ差し替えた。

## 16. known limitations（既知の限界）

1. **町丁目の境界は 3 区（住吉・東住吉・平野）にしか無い。** 残り 21 区の町名クリックは区界へ落ちる。
   これはデータが存在しないためで、§12 に従い推測ポリゴンは作っていない。
   全区の町丁目境界が要るなら、別途 正式な町丁目境界データの取り込みが要る。
2. 使っている町丁目ポリゴンは `legacy-unverified`（出典未確認）。属性は公式でも頂点座標は暫定形状。
3. **事業者が決められない駅が 1 件（北天下茶屋）**。OSM 側に operator / network が無く、近傍路線名にも
   事業者名が入っていない。バッジは出ず、従来の丸で表示される。
4. `major` が 2 駅（新今宮・梅田）しかない。重要度は「近くにある別事業者の数」から機械的に決めており、
   駅名の重要度表を持っていない（§1 の hardcode 禁止に合わせた結果）。遠景では主要駅が 2 つしか出ない。
5. ラベル → 範囲の対応で 385 件が引けない。いずれも大阪市域外の地名（PBF は市域より広い）。市内の町名は引ける。
6. 駅の詳細カードは作っていない（§9 で必須ではないとされているため）。駅クリックは選択とカメラ移動まで。
7. City Mode の p95 が 116.9 ms。これは 35K 以前からの City Mode の性質（draw call 約 3,000）で、
   駅ラベル 18 件とは関係しない。今回の A/B でも駅ラベルの寄与は測定ノイズ内。

---

## 変更したもの / 変更していないもの

**変更した（development のみ）**

- `public/osaka_3d_buildings.ward-ux-v1.html`（駅ラベル・町名選択・クリック優先順位・dev トグル 3 種）
- `tools/build-station-index.js`（新規）/ `tools/build-area-boundaries.js`（新規）
- `tools/import/osm-pbf-city.js`（駅 node のタグ白名簿を追加。way のタグは不変）
- `tools/audit/station-town-navigation-qa.js`（新規）/ `tools/validate/station-town-navigation.js`（新規）
- `tests/station-town-navigation.test.js`（新規）+ 既存テスト 6 件の意図更新
- 配信データ: `derived/station-index.json` / `derived/area-boundaries.json`（新規 2 本）

**変更していない**

- building geometry / building count（618,749）/ canonicalId / projection / placement
- roads / rail / water / parks / highLOD の geometry
- `public/osaka_3d_buildings.html`（production）— sha256 は 35J cutover 時の記録と一致
- `public/osaka_3d_buildings.fullward-v3.html`（protected）

**production cutover は行っていない。**
