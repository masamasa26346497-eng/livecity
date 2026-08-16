# PHASE_B_RUNBOOK.md — 東住吉区追加・区境検証の実行手順

前提: Phase A完了（正式手順＝逆推定に確定。coordinate-origin-status.md参照）。
本手順は HTML と BUILD_ID(building-multiward-ready-v2) を一切変更しない。
BUILD_IDの更新（→ building-multiward-v1）は手順6のブラウザ合格後に別途行う。

## 手順0: 事前チェック
```
node tools/check-phase-b-ready.js
```
GO になるまで手順1〜2を実施する。

## 手順1: 座標原点の確定（正式手順＝逆推定）
1. `data/buildings/references.template.json` を `references.json` へコピー
2. 参照点を3点以上記入（推奨は高精度参照法: coordinate-origin-status.md §4.5 の
   OSM wayノード照合。施設代表点を使う場合は区の東西端を含む4〜5点）
3. 実行と記録:
```
node tools/estimate-origin.js --refs data/buildings/references.json \
  --out data/buildings/origin-estimation-report.json
```
4. 判定「合格（maxResidual ≤ 20m、高精度参照法なら ≤ 2m目安）」の場合のみ、
   表示された転記値で `data/buildings/coordinate-config.json` を作成する。
   要注意/不整合の場合は参照点を見直す（推測値でのconfig作成は禁止）。

## 手順2: 東住吉区CityGMLの配置
PLATEAU（27114 東住吉区）の建物CityGML(.gml)を `data/source/osaka-higashisumiyoshi/` へ配置。

## 手順3: 変換（統計を確認すること）
```
node tools/convert-plateau-buildings.js \
  --input data/source/osaka-higashisumiyoshi \
  --dataset osaka-higashisumiyoshi --ward 東住吉区 \
  --coordinate-config data/buildings/coordinate-config.json \
  --output data/processed/osaka-higashisumiyoshi-buildings.json \
  --html-ref public/osaka_3d_buildings.html
```
確認: 出力件数が概ね妥当（東住吉区は住吉区と同規模感）/ 無効除外・自己交差除外が少数 /
高さ取得元の内訳（measuredHeight が多数派であること）。

## 手順4: 座標範囲の机上検証（ブラウザ前の安全確認）
変換出力のbounds（split実行時に表示）が住吉区 X[-2298.7, 2298.65] の**東側に隣接**
していること（東住吉区は住吉区の東隣。大きく離れる/重なりすぎる場合は原点か符号の誤り）。

## 手順5: タイル化（上位manifestへ自動登録）
```
node tools/split-building-tiles.js \
  --input data/processed/osaka-higashisumiyoshi-buildings.json \
  --dataset osaka-higashisumiyoshi --ward 東住吉区 \
  --output public/data/buildings/osaka-higashisumiyoshi
```
確認: 検算(合計=入力-除外)true / タイル座標範囲が手順4と整合。

## 手順6: ブラウザ検証（受入基準）
ローカルHTTPサーバーで正規版を開き（強制リロード）、以下を確認:
1. Console: `[BuildingTileLayer] datasets登録: osaka-sumiyoshi, osaka-higashisumiyoshi`
   / `dataset=osaka-higashisumiyoshi manifest=ready ...`
2. 区境（住吉区東端 x≈2300付近）をズーム: 建物が連続し、隙間・重複・浮きがない
3. `BuildingTileLayer.getDatasetStats('osaka-higashisumiyoshi')` … idDup/fuzzyDupの件数が僅少
4. 東住吉区の建物クリック → prop-cardに ward=東住吉区 が表示される
5. カメラを両区間で往復 → Console にエラーなし・FPS低下なし
6. 住吉区の既存表示・機能に回帰がない

## 手順6.5: 定量計測（住吉区単体 vs 2区構成の比較）

両構成で**同じ視点・同じウィンドウサイズ**にしてから、DevTools Consoleへ
`tools/measure-render-performance.js` を貼り付けて実行（各10秒計測）。

1回目: 東住吉区dataset を `BuildingTileLayer.disableDataset('osaka-higashisumiyoshi')` で無効化 → 計測
2回目: `enableDataset(...)` で有効化し、同じ視点へ戻して → 計測

比較して報告する項目:
- FPS（平均・下位5%・最小）… 目安: 平均の低下が10%以内、下位5%が30fps以上
- Draw Calls / Triangles / geometries
- 読み込みタイル数・表示タイル数・描画建物数（dataset別）
- JSヒープ使用量(MB)と計測中の増加量（増え続けないこと）

## 手順7: 合格後のみ
BUILD_ID を `building-multiward-v1` へ更新（1行）し、完了報告に統計とスクリーンショットを添える。
不合格の場合はBUILD_IDを変更せず、症状（Consoleログ・座標範囲）を記録して差し戻す。
