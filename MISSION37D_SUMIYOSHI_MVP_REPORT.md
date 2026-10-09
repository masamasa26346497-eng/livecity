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
