# Mission 37G — 大阪市24区の地図ページ（第1段階）

ページ: `public/mission37g-osaka-24ward-mvp.html`（37D のコピー＋24区レイヤー。37D / 37C / 37B / 本番 HTML は無変更）

## 1. 「地図を閲覧できる区」と「3D建物が見える区」は別

| 項目 | 区数 / 件数 | 根拠 |
|---|---|---|
| 地図（国土地理院ベース）＋区境界＋区名ラベルで閲覧できる区 | **24 / 24** | `mission37g-data/osaka-24-wards.json`（区コード 27102〜27128、重複 0） |
| **3D 建物が実際に見える区** | **1 / 24（住吉区の一部のみ）** | 配信済み 3D Tiles は 9 tile・10,546 棟だけ（住吉区の元データ 35,031 棟の約 30%） |
| 住吉区 52 tile の 3D Tiles | 未生成 | 37B ツールは `--all` 対応済みだが未実行・未配信 |
| 大阪市全域の建物元データ（件数のみ） | 574,213 棟 / 1,097 tile | `public/map-data/osaka-city/buildings/manifest.json` |

画面上でも、住吉区以外を選ぶと「3D建物データ未配信（地図と区境界のみ。元データ N棟は未変換）」と出す。区一覧の各行にも「地図のみ」/「3D一部」を付けた。

## 2. 区境界のデータ
- 出典: 国土数値情報 N03 行政区域データ（国土交通省、基準日 2026-01-01）。リポジトリ内の `ward-classification-polygons.json`（37 以前に取り込み済み）を `tools/mission37g-build-wards.cjs` で 242KB に整形。**形状は新規に作っていない**（頂点数が元データと一致することをテストで確認）。
- 検証（`stats.wardValidation` とテスト）: 24 件、区コード・区名・ID が各 24 種、全コードが 271xx、全区にポリゴン（飛び地・穴は元データのまま）。
- `public/map-data/osaka-city` は `.gitignore` 対象のため、ページが読むのは `public/mission37g-data/osaka-24-wards.json`（追跡対象）。

## 3. 実装した機能
- 初期視点: 全域（24区の bbox から算出。固定値なし）。「全域に戻る」ボタン。
- 区一覧 24 件／検索（「鶴見」→「区 鶴見区」）→ flyTo。区境界・区名ラベルは独立に ON/OFF（レイヤー `wards` / `wardlabels`）。
- 地面クリックで区を選択（建物・POI の pick が無いときだけ。canonicalId の経路は不変）。選択した区は太い青線で強調し、下部カードに区名・区コード・3D 配信状況・元データ件数・出典を表示。
- 広域（高度 4,500m 超）では町丁目（住吉区のみ）は選ばず区を選ぶ。施設の点は 12km 以内でのみ表示（全域ビューの散乱防止）。
- 区名ラベルは 4km 以内に近づくと消え、町丁目ラベルに譲る。
- ついでに `public/mission37d-data/sumiyoshi-towns.json`（104 件、形状 101 / なし 3、統計 101）を生成して追加（37D で未生成のため 404 になっていた。`node tools/mission37d-build-towns.cjs`）。

## 4. 検証（Node 22、headless Chrome・ローカル静的サーバー。Vercel Preview は未確認）
- `node --test`（37G 8 件＋37B/37C/37D/37E/37F 既存）: 全 pass（37G 追加分と 37D〜37F の 85 件 pass / 0 fail、37B・37C の 28 件 pass）。
- `tools/experiments/mission37g_ward_map_qa.mjs`: 全域初期画面、北区・中央区・住吉区・平野区への移動（カメラ高度 6,370 / 5,468 / 5,827 / 8,174m、選択区が一致）、検索経由の鶴見区、全域に戻る（高度差 0m）。Google 通信 0、JS 例外 0、404 は favicon.ico のみ。
- 退行確認（`mission37g_regression_qa.mjs`、37G ページに対して）: 住吉区の 3D 建物を実クリック → 阪和病院・東福寺の写真が `displayed`（作者・ライセンス・Commons リンク）、連続切替・解除で前の写真が残らない。課金ガード QA は全項目 true（Google 通信 0、`ENABLED=false`、要素生成ブロック）。
- スクリーンショット・JSON: `data/reports/mission37g-wards/`。
- 性能: headless Chrome はソフトウェア描画で FPS 約 2 と出るが、**実 GPU の値ではないため性能の根拠にならない（実機 FPS は未計測）**。headless のため日本語フォントが無く、スクリーンショットのテキストは豆腐表示になる（実機では表示される想定。未確認）。

## 5. 全区 3D 化に向けた調査（未実装・次段階）
- **元データが無い**: `public/map-data/osaka-city/buildings/` に実在するのは `osaka-sumiyoshi`（52 tile、9.1MB）だけ。他 23 区の建物 tile はリポジトリにない（manifest は件数のみ）。出典は PLATEAU 2024 大阪市の 3D Tiles ZIP（約 1.31GB、`building-sources/plateau-2024-manifest.json`）で、取り込みはネットワークのあるローカル／CI での処理になる。
- **容量見積り**: 37B 変換の 9 tile 実績は GLB 等で約 10.9MB（約 1.0KB/棟）。全市 574,213 棟だと概算 約 590MB（未生成の外挿）。リポジトリへのコミットや Vercel の静的配信には不向き（Vercel の無料枠の上限は未確認）。
- **次の順序案**: (1) 住吉区 52 tile を生成・サイズ実測（`node tools/mission37b-build-3dtiles.cjs --all`）→ (2) 区ごとの `tileset.json` を 1 本の親 tileset に束ね、カメラ近傍のみ読む構成にして区単位で追加 → (3) 配信は Git ではなく外部ストレージ／CDN が必要になる可能性が高い（**費用や新サービスの導入になるため、事前承認が必要**）。
- 本ページの `COVERAGE` 表（住吉区のみ `partial`）を、区ごとの tileset が追加されるたびに更新する構造にしてある。

## 6. 未解決
- 住吉区以外の施設・駅・道路・町丁目・写真データは未接続（住吉区のデータのみ）。
- 区境界の線は 24 区全部で約 2px の線のみ（塗りつぶしなし）。
- Vercel Preview の画面確認は、保護の設定によりこちらからはできない。
- 37E の QA スクリプトを 37G に向けて再実行した際に上書きされた 37E のレポートファイルは、コミットに含めていない。
