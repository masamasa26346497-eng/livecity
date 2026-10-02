# Mission 32M 完了報告 — BUILDING ROTATION ROOT CAUSE AUDIT

**最終: `BUILDING_ROTATION_ROOT_CAUSE_IDENTIFIED`**
**§25 classification: `PLANE_RECTANGULAR_CONVERGENCE_ERROR`**

AUDIT ONLY。canonical 建物の再生成・回転補正・道路/投影/原点の変更・production 反映は、いずれもしていません。
正解（truth）には **生 CityGML・生 tran GML・生 OSM・生 N03 の緯度経度だけ**を使いました。
canonical 座標から逆算した緯度経度は一度も使っていません（FIX11 の循環を繰り返さないため）。

---

## 結論

**建物だけが「平面直角座標 第7系」で投影されていて、それ以外のレイヤーはすべて Live City の equirect で投影されています。**

平面直角座標のグリッド北は、真北から「経線収差」の分だけ傾いています。
建物レイヤーではこの傾きがそのまま残り、地図に対して **時計回りに 0.93°** 回った状態になっています。
大阪府の公式の系は第6系ですが、実際には第7系が使われていたため、回転が大きくなりました（第6系なら 0.27°）。

**回転が初めて現れる段階:**
`ROTATION_FIRST_APPEARS_AT = B: tools/convert-plateau-buildings.js の latLonToJPRect(zone 7)`
（生の緯度経度を第7系へ投影した時点）。これより後の段階は、座標を 1 mm も変えていません。

---

## §1 変換経路

### 建物

| 段階 | 関数 / ファイル |
|---|---|
| A 生データ | `data/raw/osaka-higashisumiyoshi/*_bldg_6697_op.gml`（EPSG:6697・lat lon h）※ディレクトリ名に反して全市分 |
| パース | `convertBuildingXml()` / `parsePosList()` — `tools/convert-plateau-buildings.js` |
| **B 投影** | **`latLonToJPRect(lat, lon, cfg.jprectZone=7)`** — 同上 |
| ローカル化 | `toLocal(E, N, cfg)`（`localOrigin` を引く）＋ z 反転 — `data/buildings/coordinate-config.json` |
| C1 中間ファイル | `temp/ward-poc-all-buildings.jsonl`（2026-08-05） |
| C2 区分割 | `tools/build-ward-building-datasets.js` → `public/map-data/osaka-city/buildings/<ward>/` |
| C3 canonical | `tools/build-canonical-buildings.js` → `data/processed/osaka-city/canonical/buildings/`（座標は `fp` のまま） |
| D 描画タイル | `public/map-data/osaka-city/derived/{near,mid,far}/buildings/` |
| E runtime | `tileUrl()` → `buildGroup()` → `pushExtrude(f.coordinates)` — `ward-ux-v1.html` |

### 地図（道路）

| 段階 | 関数 / ファイル |
|---|---|
| 生データ | `data/raw/plateau/osaka-city/tran/*.gml`（EPSG:6697） |
| 投影 | equirect（`config/areas/osaka-city.json`）— `tools/convert-plateau-tran.js` |
| canonical | `canonical/roads-tran/polygons.json` → `canonical/roads` |
| 描画 | derived roads / ROAD V3 |

鉄道・水域・公園（OSM）は `tools/convert/*.js` → `tools/lib/projection.js`（equirect）、
行政界（N03）は `ward-classification-polygons.json`（equirect）です。

## §2/§3 設定の実値

| | 建物 `data/buildings/coordinate-config.json` | 地図 `config/areas/osaka-city.json` |
|---|---|---|
| 方式 | 平面直角座標（`geographic-jprect`）JGD2011 | local-equirectangular |
| 系 | **第7系**（「残差最小で自動選択」） | — |
| 原点 | 36°N / **137.1667°E**（中央子午線） | 34.604208°N / 135.52502°E |
| 縮尺係数 | 0.9999 | 1°＝111,320 m（cos は原点緯度で固定） |
| false easting / northing | 0 / 0 | 0 / 0 |
| ローカル原点 | E −150,573.671 / N −153,599.466 | — |
| 軸 | lat lon / sceneXSign +1・sceneZSign +1（出力で z 反転） | x＝東、z＝−北 |
| 北の向き | **グリッド北**（真北から経線収差だけ傾く） | **真北**（全域で −Z） |
| ファイル上の状態 | 「DEPRECATED」注記あり（生成 2026-07-20） | 現行 |

## §4/§5/§6 第7系仮説の検証（実データ・実コード）

`convert-plateau-buildings.js` の `latLonToJPRect()` を**ソースからそのまま取り出して**使い、
生の緯度経度から計算しました（式の再実装はしていません）。

### 経線収差（真北がグリッド上で何度傾くか、時計回りを正）

| | Live City 原点 | 梅田 |
|---|---|---|
| 第6系（136°E） | 0.270° | 0.287° |
| **第7系（137.1667°E）** | **0.932°** | **0.951°** |

### 地図の座標 → 各段階の座標（2,400 棟の重心で相似変換を当てた結果）

| 段階 | scale | **回転** | 残差 中央値 |
|---|---|---|---|
| A 生 lat/lon（地図の変換） | 1 | **0°** | 0 |
| （参考）第6系で投影した場合 | 0.99653 | 0.267° | 1.37 m |
| **B 第7系で投影** | 0.99679 | **0.930°** | 1.37 m |
| C1 jsonl | 0.99679 | 0.930° | 1.37 m |
| C2 区データセット | 0.99679 | 0.930° | 1.37 m |
| C3 canonical | 0.99679 | 0.930° | 1.37 m |
| D 描画タイル | 0.99679 | 0.930° | 1.37 m |
| E runtime | 0.99679 | 0.930° | 1.37 m |

**符号も大きさも第7系と一致し、第6系とは一致しません**（第6系で投影した場合の 0.267° は第6系の収差 0.270° と一致しており、測定方法自体が正しいことの確認にもなっています）。

> scale 0.9968 は建物側の誤差ではありません。地図側の equirect が 1°＝111,320 m に固定されていて、
> 大阪付近の実際の子午線長（約 110,950 m/°）より南北に 0.33% 長いことによるものです。
> 32L の「南北の相対縮尺 0.9976」と同じ現象です。建物も equirect で作り直せば、この差も消えます。

### 段階間の同一性

| 遷移 | 結果 |
|---|---|
| B（第7系）→ C1 jsonl | 回転 **0°**・scale **1.000000**・残差 **0.0015 m**（p95 0.0032 m）。違いは平行移動（= `localOrigin`）だけ |
| config の `localOrigin` を当てた場合の残差 | dx −0.0002 m / dz 0.00002 m |
| C1 → C2 → C3 → D | 14,656 頂点すべてで差 **0 m** |
| D → E runtime | 梅田サイト内の 70 棟・588 頂点が **588/588** scene にそのまま存在 |

## §13 回転の向き

**時計回り**（北が上の地図で見て、建物レイヤーが地図に対して時計回りに回っている）。
そのため、回転中心より北にある建物ほど**東へ**ずれます（梅田で東へ約 173 m）。

## §14/§15 回転中心

地図 → canonical の相似変換の不動点は **world (−1133.7, −312.9)**、Live City 原点から **1,176 m** です。
canonical は第7系の座標を `localOrigin` で平行移動しただけなので、回転中心は
「`localOrigin` を決めるときに合わせた地点」付近（住吉・東住吉のあたり。config の calibration は旧3区 PoC の参照点）に来ます。
Live City 原点でも平面直角座標の原点でもありません。

## §16 24区の影響（原点から近い順）

| 区 | 原点からの距離 | 予測変位 | 実測変位（中央値） | 実測数 |
|---|---|---|---|---|
| 東住吉 | 1.6 km | 34 m | 49 m | 152 |
| 住吉 | 1.8 km | 11 m | 34 m | 84 |
| 阿倍野 | 3.3 km | 47 m | 41 m | 4 |
| 平野 | 3.8 km | 79 m | 62 m | 186 |
| 西成 | 5.0 km | 68 m | 57 m | 135 |
| 生野 | 5.3 km | 92 m | 103 m | 142 |
| 天王寺 | 6.3 km | 99 m | — | 0 |
| 浪速 | 6.7 km | 99 m | 95 m | 13 |
| 大正 | 7.3 km | 103 m | 99 m | 34 |
| 住之江 | 7.9 km | 111 m | 43 m | 90 |
| 東成 | 8.0 km | 133 m | — | 0 |
| 中央 | 8.4 km | 133 m | 147 m | 120 |
| 港 | 9.4 km | 138 m | 123 m | 60 |
| 西 | 9.4 km | 143 m | — | 0 |
| 城東 | 10.5 km | 174 m | — | 0 |
| 福島 | 10.9 km | 169 m | — | 0 |
| **北（梅田）** | **11.2 km** | **177 m** | **169 m** | 57 |
| 都島 | 12.0 km | 195 m | 173 m | 3 |
| 鶴見 | 12.3 km | 207 m | 240 m | 120 |
| 此花 | 12.3 km | 185 m | 167 m | 60 |
| 西淀川 | 13.7 km | 212 m | 188 m | 120 |
| 旭 | 14.0 km | 230 m | — | 0 |
| 淀川 | 14.6 km | 231 m | 223 m | 127 |
| 東淀川 | 15.6 km | 254 m | 251 m | 173 |

- 予測は区の外接矩形の中心に、実測した相似変換を当てた値です。区の中の位置によって変位は変わるので、実測（生 CityGML から間引いて測定）と完全には一致しません。
- 「—」の区は、間引いたメッシュにその区の建物が入らなかったため実測がありません。
- **北部の区では 170〜250 m ずれています。**

## §17 レイヤー比較（生の緯度経度 → 地図の変換 → canonical の頂点との一致）

| レイヤー | 確認頂点数 | 5 cm 以内で一致 | frame |
|---|---|---|---|
| 道路（PLATEAU tran） | 5,331 | **100%**（回転 0.00001°） | 地図と同じ |
| 鉄道（OSM） | 3,000 | **100%** | 地図と同じ |
| 水域（OSM） | 3,000 | **98.7%** | 地図と同じ |
| 公園（OSM） | 3,000 | **100%** | 地図と同じ |
| 行政界（N03） | 3,000 | **100%** | 地図と同じ |
| **建物（PLATEAU）** | — | — | **第7系ローカル（回転 0.93°）** |

**回転しているのは建物だけです。**

## §18/§19 どの設定が実際に使われたか

| ファイル | 状態 | 根拠 |
|---|---|---|
| `data/buildings/coordinate-config.json`（第7系） | **USED** | ファイルには「DEPRECATED・現行 pipeline に未接続」とあるが、**その注記が書かれる前**（config 2026-07-20 → jsonl 2026-08-05）に全市の建物変換に使われ、その結果が canonical まで無変換で残っている。jsonl を 1 mm 精度で再現できる。現在これを読むコードは無い |
| `tools/convert-plateau-buildings.js`（geographic-jprect） | **USED**（過去の一括変換で） | 出力形式が jsonl と一致。ward が全件「東住吉区」＝東住吉 PoC の設定のまま全市を変換した痕跡 |
| `temp/ward-poc-all-buildings.jsonl` | **USED**（canonical の実質的な座標の元） | `build-ward-building-datasets.js` の既定入力。区データセットの manifest にも記録 |
| `tools/build-ward-building-datasets.js` | USED | 座標は変えない（差 0 m） |
| `tools/build-canonical-buildings.js` | USED | 座標は変えない（差 0 m）。投影は区判定の逆変換にだけ使う |
| `config/areas/osaka-city.json` | USED（道路・水域・公園・鉄道・行政界）/ **建物の座標生成には UNUSED** | |
| FIX11 の結論（`coordinate-system-authority-audit.js`） | **DEPRECATED として扱うべき** | 基準の緯度経度を canonical から逆算していたため「建物は equirect・誤差 0 m」と誤った |

## §22/§23 正しく作り直した場合の予測（実際の再生成はしていません）

§24 に従い、「全体を −0.93° 回す」ではなく、**正しい変換（生の緯度経度 → 地図と同じ equirect）**を同じ建物に仮に当てて比べました。

| | 梅田（800 棟） | | 住吉（799 棟） | |
|---|---|---|---|---|
| | 現在 | 作り直し後 | 現在 | 作り直し後 |
| OSM 建物との一致（中央値） | 22.5% | **91.8%** | 41.8% | **91.4%** |
| 道路（tran）との重なり（平均） | 30.6% | **2.6%** | 20.2% | **0.1%** |
| 水域との重なり（平均） | 2.39% | **0.04%** | 0.38% | **0%** |
| 正しい区に入っている割合 | 77.7% | **98.2%** | 97.5% | **97.7%** |

- **住吉も悪化しません**（§23）。住吉は変位 20〜30 m 程度なので「比較的自然」に見えていましたが、OSM との一致は 42% → 91% に上がります。
- **区の判定について**: 正解には生 CityGML の属性「区名」を使いました。現在の canonical の区ラベルは、回転した座標を行政界に当てて付けたものなので、それを正解にすると「今のままが正しい」ように見える循環になります。実際、**梅田のサンプルでは現在の区ラベルの 22% が生 CityGML の区名と食い違っています**（一致率 78.0%）。
- **道路との重なり 30.6% → 2.6%**: 32G〜32I で「梅田の建物が道路に重なる」とした量の**大部分はこの回転によるもの**だった可能性が高いです。

## §20 作り直す場合の影響範囲

**作り直しが必要:**
- `temp/ward-poc-all-buildings.jsonl`（または生 CityGML から equirect で直接作る）
- `public/map-data/osaka-city/buildings/<ward>/`（24区 ＋ unclassified）
- `data/processed/osaka-city/canonical/buildings/`（geometry と、属性の wardId）
- `public/map-data/osaka-city/derived/{near,mid,far}/buildings`（LOD）
- building placement policy（水域・道路との重なり比が、ずれた位置で計算されている）
- `building-ward-index.json`
- Visual Building PoC、Land Block PoC の建物割り当て

**再評価が必要なレポート:** 32G、32H（道路重なり）、32I / ROAD V2（Building∩DarkRoad の KPI）、alignment 系、FIX11、32J。

**影響を受けないもの:** canonical の道路・水域・公園・鉄道・行政界、ROAD V3 の道路形状そのもの（建物を参照していない）。

## §21 canonicalId

**維持できます。** canonicalId は `'cg_bldg_' + 生 CityGML の gml:id` で、座標とは無関係です。
属性ファイルも canonicalId をキーにしているので、物件リンクは壊れません。
ただし、属性がどのタイルファイルに入るかは座標で決まるので、格納先のタイルは変わります（キーは変わりません）。

## §24 直し方についての所見

原因は投影そのものなので、**生の CityGML から地図と同じ equirect で作り直す**のが正しい方法です。
単純に全建物を −0.93° 回すと、次の問題が残ります。
- 回転量は場所によって違います（第7系の収差は 0.93°〜0.95°）
- 南北の縮尺差（0.24%）も残ります
- 回転中心を決める根拠が「過去の localOrigin の合わせ方」になってしまいます

---

## 成果物と検証

| 種別 | パス |
|---|---|
| 監査ツール | `tools/audit/building-rotation-root-cause.js` |
| レポート | `data/reports/building-rotation-root-cause.json` |
| Validator | `tools/validate/building-rotation-root-cause.js` → **RESULT=PASS** |
| テスト | `tests/building-rotation-root-cause.test.js`（10件・全 pass） |

### §27 Validator

| check | 値 |
|---|---|
| buildingMutation / roadMutation / projectionMutation | **0 / 0 / 0** |
| 監査対象の config（第7系）の変更 | 0 |
| **rawLatLonUsedAsTruth** | **true** |
| **inverseDerivedTruthUsed** | **false** |
| **rotationMeasuredAtEachStage** | **true**（A〜E の 7 段階） |
| **firstBadStageIdentified** | **true**（B） |
| runtime の頂点同一性 | true（588/588） |

Canonical Buildings **615,617** / Roads **199,658** は不変です。production と protected の HTML も変更していません。

### npm test

**1,685 tests / 1,670 pass / 0 fail / 15 skip**

---

## 測定の途中で直した点（正直な記録）

1. **runtime の同一性が最初 72% でした。** overlay は梅田サイトから半径 380 m の円で描画しているのに、四角い範囲で比べていたためです。円の内側に限定すると 588/588 で一致しました。
2. **区の配置が「補正すると悪化する」（99.8% → 79.9%）という結果が一度出ました。** 正解に canonical の区ラベルを使っていたためで、そのラベル自体が回転した座標から付けられているので循環していました。生 CityGML の「区名」に切り替えると、77.7% → 98.2% と改善する結果になりました。

---

## 次に必要な判断

**canonical 建物を、生 CityGML から地図と同じ equirect で作り直すかどうか**をご判断ください。
作り直す場合は、上記の影響範囲をまとめて更新し、canonicalId を保ったまま、作り直した後の結果を過去のレポートと比べる計画を立てます。

**STOP: `BUILDING_ROTATION_ROOT_CAUSE_IDENTIFIED`**
