# Mission 37D — 住吉区 Live City MVP

**対象は大阪市住吉区のみ。** 37C のテーマ（Cesium エンジン＋Live City UI）を維持したまま、実データに接続できたものだけを動かすページ。
この作業環境では `node` / ブラウザを実行できなかったため、**コードは書いたが一度も実行・表示確認していない**。

- 新ページ: `public/mission37d-sumiyoshi-mvp.html`（Vercel Preview: `/mission37d-sumiyoshi-mvp.html`）
- 37C ページ・37B PoC・本番 HTML 2 ファイル・Mission 36L 写真データ・canonicalId 体系は変更していない。

## P0 監査（リポジトリ実測）

| 項目 | 状態 |
|---|---|
| 建物 3D Tiles | `public/mission37b-3dtiles/osaka-sumiyoshi-9tile/`（9 tile / 10,546 棟 / 約 11MB）のみコミット済み。52 tile は未生成 |
| 建物元データ（52 tile / 35,031 棟） | `public/map-data/osaka-city/buildings/osaka-sumiyoshi/`（約 9.1MB、tracked）に存在 → 変換可能 |
| 道路・鉄道・水路・公園・ラベル | `public/mission37c-layers/osaka-sumiyoshi-9tile/`（9 tile 範囲＋300m マージンのみ） |
| 建物属性 | `mission37c-layers/.../attrs/`（高さ・用途コード・代表点のみ。**建物名・住所・築年・階数は無い**） |
| 施設データ | `public/map-data/osaka-sumiyoshi/facilities/facilities.json` 149 件（OSM, ODbL）。tourism は 4 件のみで **住吉大社は施設データに無い**（駅ラベル「住吉大社」は labels.json にある） |
| Mission 36L 写真索引 | `public/map-data/osaka-city/derived/building-photo-index.json`（約 6MB, tracked）。キーは `cg_` + 建物 id。実データで `cg_bldg_bldg_fc33740b-…`（住吉停留場）が住吉区建物 tile `tile_-7_-3` の `bldg_fc33740b-…` と対応することを確認 |

### 52 tile 化（未実施・手順のみ）
この環境ではスクリプトを実行できず、52 tile の生成・配信は**できていない**。ローカルで次を実行する:

```bash
node tools/mission37b-build-3dtiles.cjs --all          # → public/mission37b-3dtiles/osaka-sumiyoshi-all/（.gitignore 済み）
node tools/mission37c-build-theme-layers.cjs --set osaka-sumiyoshi-all --tx0 -8 --tx1 6 --tz0 -13 --tz1 5
```
37D は `?set=osaka-sumiyoshi-all` で切り替える。サイズ概算は 9 tile 約 11MB から比例して 60MB 前後（未測定）。
Vercel へ載せるなら、コミットせずビルド時生成にするか、容量を実測して判断すること。

## 実装済み（コード上。表示確認は未実施）

| 項目 | 内容 |
|---|---|
| P0 ローディング/エラー | 読込中オーバーレイ、建物 3D Tiles 失敗時の原因表示＋再読み込みボタン |
| P1 建物クリック | canonicalId＋高さ・用途（既存 attrs）。**建物名/住所/築年/階数は `データなし`**（元データに無いため）。建物名のみ、36L 索引に確認済みの対応がある場合に表示 |
| P1 写真 | クリック時に 36L 索引を遅延取得（初回のみ約 6MB）。`clickShows` の信頼度で、ライセンスのある写真だけ表示。作者・ライセンス・Commons へのリンクを必ず併記。無ければ「写真データなし」。API キー不使用・実行時の外部問い合わせは索引と画像のみ |
| P2 検索 | 駅・地名・公園（labels 26 件）＋施設・観光（OSM 149 件）。0 件・読込失敗時の文言あり。結果選択でカメラ移動、施設は詳細表示。住所検索は**未対応** |
| P2 施設/観光 | 施設レイヤー（学校・医療・公共・交通・店舗 140 件）と観光スポット（4 件）。クリックで名称・種別・住所/営業時間/電話/Web（無ければ「データなし」）・出典表示 |
| P2 周辺 | 建物クリック時、500m 以内の施設と駅を直線距離順に最大 8 件 |
| P3 レイヤー | 実データ 8 本（建物/道路/鉄道・駅/公園/河川/ラベル/施設/観光）が ON/OFF 可。人口・地価・不動産・防災は行を出さず「準備中」の注記のみ。モードタブも観光・施設以外は disabled |
| P3 モバイル | 幅 720px 以下で右パネルを下部シート、左パネルをトグル化、検索結果を全幅表示（未確認） |
| P4 | ラベルは種別ごとの表示距離で間引き（施設 1.4km、観光 4km 以内）。写真は遅延読込 |

## 未実装・未計測

- 52 tile 3D Tiles の生成・配信（上記手順）。現状 Preview は 9 tile（10,546 棟）。
- 住吉大社などの観光スポット詳細：施設データに無いため出していない（出典確認済みの公開データ追加は次段階）。
- 建物名・住所・築年・階数、住所検索。
- 性能：**全て未計測**（初期ロード・FPS・p95・通信量・PC/モバイル）。基準は Primitive 52 tile の 8.3fps / 14,013ms（ユーザー実測）。3D Tiles 化での改善は 9 tile でも未検証。
- `node --test tests/mission37d-sumiyoshi-mvp.test.cjs` 未実行。ブラウザ表示未確認。

## 確認手順（Preview）
1. `/mission37d-sumiyoshi-mvp.html` を開き、建物・道路・施設の点が出るか、ローディングが消えるか。
2. 「住吉」「公園」「薬局」などで検索 → 候補選択 → カメラ移動。存在しない語で 0 件文言。
3. 建物をクリック → canonicalId、`データなし`表示、周辺施設、（該当時のみ）写真。
4. 施設の点をクリック → 詳細。
5. DevTools で `__mission37d`（layers / selectedCanonicalId / selectedPoi / lastPicked.photo / lastSearch）。
6. 幅 400px 程度で右パネルが下部シートになるか。

## 町丁目（住吉区）追加

### 監査（実ファイルの読解。スクリプトは実行できていない）
| 項目 | 結果 |
|---|---|
| 名称・ID | `data/processed/osaka-sumiyoshi/boundaries/administrative-boundaries.json` に住吉区 **104 件**（東住吉区 102 件、計 206）。`compositeCode`（例 `27120:001001`）と `chochoName`（例 `南住吉一丁目`）。出典: 国勢調査町丁・字等別境界（e-Stat / CODH Geoshape、CC BY 4.0、基準日 2020-10-01） |
| 公式の頂点座標 | **リポジトリに無い**。上記ファイルの `geometry` は全件 null。35L の元 zip と派生 `area-boundaries.json` も未コミット |
| 形状の唯一の実在ソース | 本番 HTML の `TOWN_POLYGONS`（暫定・出典未確認）。住吉区は **101 キー**（104 件中 3 件は形状なし見込み）。キーは `住吉区我孫子4丁目` 形式（算用数字）で、`normalizedChochoName` と結合できる |
| 統計 | `town-stats.json` から結合（人口・世帯・高齢化率。公式値 / 計算値の区別を保持）。無い町丁目は null |

### 実装
- `tools/mission37d-build-towns.cjs`: 上記 3 ソースを結合して `public/mission37d-data/sumiyoshi-towns.json` を生成（HTML は読むだけ）。形状は新規作成せず、結合できなかった町丁目は `geometryStatus: "none"`。`--check` で件数だけ表示。
- `public/mission37d-data/town-normalize.js`: 名称正規化（ブラウザ / Node 共用）。
- `public/mission37d-sumiyoshi-mvp.html`: レイヤー「町丁目境界」「町丁目名ラベル」、検索、クリック選択、右パネルを追加。
  - ラベル: カメラ高度 >4500m=区名、1800–4500m=町名（重心）、≤1800m=正式な町丁目名。画面中心に近い順に重なり回避し、町名 40 / 町丁目 48 件で打ち切り。駅名など既存ラベルは別レイヤーのまま。
  - 検索: 漢数字/算用数字/全角/空白を正規化。「長居東」のように丁目省略なら全丁目が候補。候補は「住吉区 長居東四丁目」の形で区付き表示。0 件・データ未接続は文言で明示。
  - クリック: 建物 / POI を pick できなかったときだけ、地表座標の点内判定で町丁目を選ぶ（canonicalId の経路は不変）。輪郭と薄い塗りでハイライトし、右パネルに正式名称・ID・取得済み統計のみ表示（無い項目は「データなし」）。境界レイヤー OFF 中は選択しない。
- `tests/mission37d-towns.test.cjs`: 正規化、104 件・ID 一意、座標範囲、ラベル段階、建物選択との両立（静的）。

### 未実行・未確認
- **データ束は未生成**です（この環境で node が実行できないため）。生成するまで Preview は町丁目レイヤーが「取得失敗」、検索は「町丁目データが未接続」と表示します。
  ```bash
  node tools/mission37d-build-towns.cjs
  node --test tests/mission37d-towns.test.cjs
  ```
- テスト・ブラウザ表示ともに未実行。
- 輪郭は暫定形状。公式の頂点座標を使うには 35L の zip（`tools/download/estat-town-boundaries.js`）から `tools/build-official-town-boundaries.js` を実行して差し替える必要があります。
