# Mission 37C — Cesium を Live City の世界観に作り変える

> **事実区分**: 下の数値はすべて **実ブラウザ（Edge headless / CDP）で実測**したもので、
> 測定スクリプトは `tools/experiments/mission37c_theme_qa.mjs`、生データは
> `data/reports/mission37c-livecity-theme/theme-qa.json`、画面写真は同ディレクトリの `*.jpg` です。
> ユーザーの実機（GPU あり）では未計測です。**headless 実行なので FPS は実機より大幅に低く出ます**
> （後述）。推測値は書いていません。

## 成果物

| 種別 | パス |
|---|---|
| ページ（新規） | `public/mission37c-livecity-theme.html` |
| レイヤー生成ツール（新規） | `tools/mission37c-build-theme-layers.cjs` |
| 配信用レイヤー束（新規・生成物） | `public/mission37c-layers/osaka-sumiyoshi-9tile/`（1.1 MB） |
| 用途コード対応表（新規） | `config/building-usage-labels.json` |
| 静的ガードテスト（新規） | `tests/mission37c-livecity-theme.test.cjs`（18件 pass） |
| 実機 QA スクリプト（新規） | `tools/experiments/mission37c_theme_qa.mjs` |
| 本レポート | 本ファイル |

**変更していないもの**: 本番 HTML 2 ファイル（`osaka_3d_buildings.html` / `osaka_3d_buildings.fullward-v3.html`）、
Mission 37B の POC 2 ファイル、`public/mission37b-3dtiles/`（tileset / GLB / sidecar）、Mission 36L 写真データ、
canonicalId 体系。`git status` で 4 ファイルとも未変更であることを確認済みで、
テスト「本番 HTML と Mission 37B の POC に 37C のコードが混ざっていない」でも固定しています。

確認 URL: `/mission37c-livecity-theme.html`
URL パラメータ: `?set=` / `?sse=8|16|32` / `?basemap=gsi-blank|gsi-pale|osm|none` / `?panel=0`

---

## 1. どこを Cesium に任せ、どこを Live City 独自にしたか

| 層 | Cesium 採用（そのまま使う） | Live City 独自化 |
|---|---|---|
| 地理・投影 | WGS84 / ECEF、楕円体、カメラ、`Cartesian3.fromDegrees` | ローカル m（znorth-neg-v1）→ 緯度経度の変換を**ページ内 1 箇所**（`PROJ` / `toLat` / `toLon`）に閉じ込め。定数は 37B・`geoToThree()` と同一 |
| カメラ操作 | `ScreenSpaceCameraController`、慣性、ズーム、`flyToBoundingSphere` | 初期視点（北上・pitch −45°・tileset の bounding sphere から range 算出）、「初期視点」「この建物に寄る」 |
| 建物の描画・LOD | 3D Tiles（`Cesium3DTileset`、SSE による取捨、タイルキャッシュ） | 配色（`Cesium3DTileStyle` の淡色トーン 3 段）、選択時の Live City ブルー＋シルエット |
| ピッキング | `scene.pick` → `Cesium3DTileFeature` | `canonicalId` の取り出し条件（`/^bldg_/`）・sidecar 照合・右パネルへの表示（37B と同じ経路） |
| 背景地図 | `ImageryLayer` の brightness / contrast / saturation / gamma / alpha | 地図の選択（既定＝地理院 白地図）、補正値の既定とスライダー UI |
| 道路・鉄道・河川・公園 | `PolylineCollection` / `Primitive`＋`PolygonGeometry` のバッチ描画 | **データ・レイヤー構成・配色・重なり順はすべて独自**（下記 §3） |
| ラベル | `LabelCollection`、`DistanceDisplayCondition` | 種別・importance ごとの字送り／色／表示距離、駅の `◉` 記号、建物に隠れない挙動 |
| UI | （不使用。標準ウィジェットは全オフ） | ヘッダー・左レイヤーパネル・右建物情報パネル・計測パネルを自前で実装 |

**Cesium ion / Google Map Tiles API は不使用**（API キー不要）。ion のサービスを一切呼んでいないので
ion ロゴだけ CSS で外し、地図データの帰属表示（地理院タイル / OpenStreetMap）は常時表示のまま残しています。

---

## 2. 要件ごとの実装と実測

| # | 要件 | 実装 | 実測 |
|---|---|---|---|
| 1 | Cesium 標準 UI を極力非表示 | Viewer オプション 10 個を false ＋ CSS | toolbar / timeline / animation / infoBox / selectionIndicator / geocoder / fullscreen = **全て hidden or absent** |
| 2 | Live City 風ヘッダー | 紺グラデ＋アクセント角、建物数・表示タイル・FPS・初期視点ボタン | 表示確認済み（1600×1000） |
| 3 | 左レイヤーパネル | レイヤー / 背景地図 / 表示 / 計測 の 4 セクション | **レイヤー行 6、背景スライダー 5** |
| 4 | 右建物情報パネル | 用途チップ・canonicalId・高さ・用途コード・区・タイル・緯度経度・ローカル x/z・sidecar 照合・寄るボタン | クリック実測で全項目に実データ（例: 大学 / 17.7 m / 住吉区 / t_-5_-2 / 34.609619,135.501496） |
| 5 | 背景は明るく・彩度低め・情報量控えめ | 既定＝地理院 **白地図** ＋ 5 パラメータ補正（明度1.05 / コントラスト0.95 / 彩度0.25 / ガンマ1.00 / 不透明度0.85） | 画面写真で確認（`basemap-gsi-blank.jpg` / `zoom-gsi-blank.jpg`） |
| 6 | 建物を薄い青灰に | 3D Tiles の頂点色（高さで #BEC8D7→#7896C3）に淡色トーンを掛ける。トーン 3 段を UI から選択 | 画面写真で確認 |
| 7 | 選択建物を Live City ブルーで強調 | `feature.color = #50a0ff` ＋ `PostProcessStageLibrary` のシルエット | 画面写真で確認（`zoom-gsi-blank.jpg` 中央） |
| 8 | レイヤー ON/OFF UI | トグル 6 種（件数・色見本・状態つき） | **OFF→visible=false / ON→visible=true を実測** |
| 9 | 道路・河川・公園・ラベルは将来の独立レイヤー化を見据えた構造に | ダミーではなく**実データで 5 レイヤーを独立実装**。`LayerRegistry` 経由 | roads 969 / railways 67 / waterways 20 / parks 26 / labels 26（全て state=ready、error 0） |
| 10 | canonicalId クリック動作の維持 | 37B と同じ `getProperty('canonicalId')` ＋ `/^bldg_/` ＋ sidecar 照合 | `bldg_643b1d44-…` を取得、**sidecar ✓ 一致** |
| 11 | 住吉区の Cesium / 3D Tiles 表示を壊さない | 37B のファイルを読むだけ。生成物も無変更 | 37B の 4 ファイルと `mission37b-3dtiles/` が `git status` で未変更。`tests/mission37b-3dtiles.test.cjs` 6件 pass |

JS エラー **0 件**、レイヤー取得失敗 **0 件**。

### 性能（headless 実測。実機とは別物として読むこと）

| 構成 | 平均 FPS | p95 frame |
|---|---|---|
| 全レイヤー ON（9 tile / 10,546 棟） | 10.2 | 113.7 ms |
| 建物のみ（ベクタ 5 レイヤー OFF） | 10.5 | 103.6 ms |
| 近接時（3 tile / 3,532 棟、全レイヤー ON） | 21.5 | 98.3 ms |

- **今回足したベクタ 5 レイヤーの費用は平均 0.3 fps**（10.5 → 10.2）。描画負荷の主因は建物側で、
  レイヤー追加のコストはほぼ無視できる、と実測で言えます。
- 初回表示は **2,752–3,834 ms**（複数回の実測レンジ）。37B の Primitive 版 9 tile は約 10 s（ユーザー実機報告値）
  でしたが、**端末も実行条件も違うため直接比較はできません**。同一端末での比較は未実施です。
- headless Chromium は GPU がソフトウェア実装になりやすく、ここの FPS は実機より低く出ます。
  実機の値は、ユーザー環境で「10秒FPS計測」ボタンを押して `window.__mission37c.measure` を取得してください。

---

## 3. レイヤーの作り（要件9の「将来独立レイヤー化しやすい構造」）

### 3.1 なぜレイヤー束を別に生成したか

`public/map-data/osaka-city/` は `.gitignore` の `/public/map-data/osaka-city/` で**まるごと除外**されており、
Vercel には配信されません。37B が建物を `public/mission37b-3dtiles/` に生成してコミットしたのと同じ理由で、
道路・鉄道・水路・公園・ラベル・建物属性も POC 範囲だけ切り出してコミットしています。

```bash
node tools/mission37c-build-theme-layers.cjs
# 既定: 建物タイル tx -6..-4 / tz -3..-1（37B と同一範囲）+ 外側 300 m
```

| ファイル | 件数 | サイズ | 中身 |
|---|---|---|---|
| `roads.json` | 969 | 249 KB | OSM 由来。`tier` = major 10 / mid 57 / local 902 |
| `railways.json` | 67 | 14 KB | OSM 由来 |
| `waterways.json` | 20 | 12 KB | 線 12（細江川ほか）＋ 面 8（池・貯水池） |
| `parks.json` | 26 | 6 KB | 面のみ |
| `labels.json` | 26 | 4 KB | 駅 6 / 地名 17 / 公園 2 / 区 1 |
| `attrs/t_*.json` | 9 ファイル / 10,546 棟 | 772 KB | 高さ・用途・代表点。**クリック時にそのタイルの分だけ遅延取得** |

合計 1.1 MB。初回に読むのは `attrs/` を除く 284 KB です。

### 3.2 構造

- **1 レイヤー = 1 ファイル**。形は取得元タイルと同じ `{features:[{id, kind, p, ...}]}` のまま変えていません。
  将来ライブタイルへ差し替えるときは、ビューア側の `mount()` の中の取得方法だけを変えれば済みます。
- 座標は**取得元のまま znorth-neg-v1 のローカル m** で持ち、投影はビューアの 1 箇所だけで行います。
  レイヤーを足しても投影が増えません。
- ビューアの `LayerRegistry` は各レイヤーに `mount()` と `applyVisible(on)` だけを要求します。
  新しいレイヤーは「descriptor を 1 つ `register()` する」だけで、UI 行・トグル・件数表示・
  エラー表示・計測への反映が自動で付きます。
- 線は `PolylineCollection`（material を共有してバッチ）、面は 1 レイヤー = 1 `Primitive`。
- 重なり順は Three.js 版の Y スタックと同じ考え方で、高さで決めます:
  `water 0.5 < park 0.9 < road 1.4 < rail 2.0`（テストで順序を固定）。

### 3.3 今後の独立レイヤー化の方針メモ

1. **切り出し範囲を広げる段階**: ツールは `--tx0/--tx1/--tz0/--tz1` で範囲を変えられます。
   住吉区全域（52 tile）なら roads は概算で 10 倍強（約 2.5 MB）。この規模までは 1 ファイルのままで十分です。
2. **市全域へ行く段階**: 1 ファイルでは持ちません。**取得元と同じ 2000 m タイル境界のまま**
   `roads/t_<tx>_<tz>.json` に分け、ビューア側を「カメラ位置から必要タイルを決めて取得・破棄」に変えます。
   このとき変えるのは各レイヤーの `mount()` だけで、UI・トグル・重なり順・配色には手が入りません。
   37B の `?mode=dynamic` の tile 選択ロジックがそのまま流用できます。
3. **さらに先**: 道路・水域・公園は面として押し出す価値が薄いので、建物のような 3D Tiles 化よりも
   **ベクタタイル（Mapbox Vector Tile）か、タイル分割した現行 JSON** のままが妥当だと考えます。
   ただしこれは未検証の見立てで、計測はしていません。
4. **ラベル**: 今は 26 件を一括で持っています。件数が増えたら `importance` による事前間引き
   （major のみ別ファイル）が効きます。現状の `distanceDisplayCondition` による出し分けは、
   件数が数千になると衝突回避が必要になります（Three.js 版の `CityLabelLayer` が持っている機能で、
   Cesium 側には移植していません）。
5. **建物属性**: `attrs/` はタイル単位の遅延取得なので、範囲を広げても初回コストは増えません。
   この形は維持してよいと考えます。

---

## 4. 背景地図について（判断の経緯）

要件5「明るく・彩度低め・情報量控えめ」に対して、次の順で試して実測で選びました。

1. **OSM 標準タイル**（37B の既定）→ 地図側に地名・店名・建物が全部描かれており、Live City のラベルと二重になる。却下。
2. **CARTO Positron（light_nolabels）** → 見た目は理想だが、**実際に返ってきたのは「API KEY REQUIRED」の
   透かしタイル**（2,049 B の placeholder）。HTTP 200 なので件数チェックだけでは気づけず、画面写真で発覚。
   API キーが要るので却下。
3. **地理院タイル 淡色地図** → キー不要・日本全国・z18 まで。ただし地名の文字量が多い。既定にはせず選択肢に残す。
4. **地理院タイル 白地図**（採用・既定）→ キー不要、ほぼ白紙。道路・鉄道・河川・公園・ラベルは
   Live City 側が描くので、背景は下地に徹します。最大 z14 ですが、**近接時の画面写真で破綻しないことを確認済み**
   （`zoom-gsi-blank.jpg`）。内容がほぼ空なので拡大してもぼけが目立ちません。

4 種（白地図 / 淡色地図 / OSM / なし）を UI から切替可能にし、5 パラメータの補正スライダーを付けています。
帰属表示は Cesium の既定だと「Data attribution」の折りたたみに入ってしまうため、
`Credit(..., true)` で**常時表示**にしました（地理院タイル利用規約 / ODbL 対応）。

---

## 5. Vercel での確認

`public/` 配下がそのまま配信される構成で、追加したものは**すべてコミット対象**です
（`.gitignore` に当たらないことを確認済み）:

- `public/mission37c-livecity-theme.html`
- `public/mission37c-layers/osaka-sumiyoshi-9tile/`（1.1 MB）
- 建物は既にコミット済みの `public/mission37b-3dtiles/osaka-sumiyoshi-9tile/`（11 MB）を参照

外部依存は CDN の CesiumJS 1.121.1（jsDelivr）と、地理院タイル / OpenStreetMap のラスタだけです。

---

## 6. 残課題・未確認

- **実機（GPU あり）での FPS 未計測**。headless の値しかありません。ユーザー環境で「10秒FPS計測」を実行し、
  `window.__mission37c.measure` を記録してください。37B の同条件（9 tile）との比較も未実施です。
- **52 tile（住吉区全域）は未試行**。37B の 3D Tiles が 9 tile 分しかコミットされていないためです
  （`--all` 生成物は `.gitignore` 済み）。レイヤー束の方は `--tx0..--tz1` を広げれば生成できます。
- **ラベルの衝突回避が無い**。今は 26 件なので問題になっていませんが、件数が増えると重なります。
- **既存の不具合（37C とは無関係・未修正）**: `tests/mission37b-cesium-poc.test.js` は `.js` 拡張子なのに
  `require()` を使っており、`"type": "module"` の本リポジトリでは**元から実行できません**
  （`ReferenceError: require is not defined`）。37B レポートの「未実行」と整合します。
  `.cjs` へのリネームで直りますが、37B の成果物に手を入れることになるため本ミッションでは触っていません。
- **モバイル幅は CSS のブレークポイントのみ**（900 px 未満でパネルを縮小）。実機での操作性は未確認です。

## 6b. 第2段で追加した UI 骨格（実装済み / ダミーの区別）

> **この節の追加分は、コードを書いただけで、ブラウザでの表示確認・テスト実行をしていません**
> （この環境ではブラウザと `node` の実行が使えませんでした）。上の §2 の実測は第1段（`c10f697`）時点のものです。

| 要素 | 状態 | 備考 |
|---|---|---|
| ヘッダー: ロゴ / 検索 / モードタブ | 実装済み | 検索は `labels.json`（駅・地名）の名称一致でカメラを寄せるだけ。住所ジオコーディングは未実装 |
| モードタブ 観光 | 実装済み（標準ビュー） | |
| モードタブ 不動産 / 人口・統計 / 防災 / ビジネス | **ダミー** | 切替えると「準備中」の帯を出すのみ。表示内容は変わらない |
| レイヤー 建物 / 道路 / 鉄道・駅 / 公園・緑地 / 河川・水域 / 地名・ラベル | 実データ接続済み | 6件 |
| レイヤー 公共施設 / 写真 / 人口・世帯 / 地価 / 不動産 / 店舗・飲食店 / 観光スポット / 防災情報 | **ダミー（UI状態のみ）** | `makeDummyLayer()` で登録。同じ id で `mount()/applyVisible()` を持つ descriptor に差し替えれば接続できる |
| 右パネル: canonicalId・属性 | 実装済み | 第1段から |
| 右パネル: 基本情報 / 写真 / 周辺情報 | **空の枠** | 写真は `#lc-photo-slot[data-slot=mission36l-photo]` が差し込み口。Mission 36L データには触れていない |
| ミニマップ | 簡易実装 | major/mid 道路とカメラ位置を 2D canvas に描画（500 ms 周期）。クリック移動は未実装 |
| 昼 / 夕 / 夜、影表示、地形強調 | **UI枠のみ（夕・夜・影・地形は disabled）** | 昼のみ選択状態。機能は未実装 |
| `window.__mission37c` | 実装済み | `layers`（dummy フラグ付き）/ `selectedCanonicalId` / `theme`（getter）/ `tilesetStats`（getter）/ `mode` |

## 7. 再現手順

```bash
# レイヤー束の再生成（ネットワーク不要。public/map-data を読むだけで書き込まない）
node tools/mission37c-build-theme-layers.cjs

# 静的ガード
node --test tests/mission37c-livecity-theme.test.cjs      # 18 件

# 実機 QA（要 Edge/Chrome。別シェルで静的サーバを立ててから）
python -m http.server 8137 -d public
node tools/experiments/mission37c_theme_qa.mjs           # → data/reports/mission37c-livecity-theme/
```
