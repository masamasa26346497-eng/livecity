# Mission 140: run 42438843605 の受入証拠の精査 + 西区(PLATEAU 2025)の localhost 再現

## 1. run 42438843605（実データ。合成 fixture ではない）
証拠: `data/reports/mission140/run42438843605-acceptance.json`
- STRICT data check: 21/21 データ OK。ただし `browserAcceptedWards:0`（このステップはファイル検査のみ）。
- Private browser acceptance（headless Chrome 156、ソフトウェア描画）: **ACCEPTED 19 / NOT ACCEPTED 2 / 21**。
  - NOT ACCEPTED: konohana, nishinari（理由 `click-id-mismatch`）。
  - 全 21 区で tileset 200 ×1、GLB 200、404 は 0、mounted 1、state ready、画素差分 31.8〜51.1%。
- ログだけでは証明できない（未検証）: 区ごとの N03 区整合、道路・河川、ブラウザ内での区全域 coverage（`full-candidate` は元データ件数比で、描画の証明ではない）。
- 21 区に nishi / fukushima / yodogawa は含まれない。**24/24 は示されていない。完成の宣言はしない。**

## 2. 西区 PLATEAU 2025（12,603 棟）localhost 1 コマンド
既存の Mission 81 のランチャーを使う（別ビューアは作っていない。正規 `mission37g-osaka-24ward-mvp.html` の localhost 限定 `?ext=` ローダー）。
```
node tools/mission81-local-preview.mjs --ward nishi
```
表示された `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext=nishi25` を開く。
再現結果（この runner、実 Chrome headless）: `data/reports/mission140/nishi-2025-e2e-rerun.json`、画像 `nishi-top-on.jpg` / `nishi-oblique-on.jpg`。
12,603 棟、tileset 1 本 ready、実マウスクリック 3/3 で canonicalId 選択、画素差分 真上 251,797 px / 斜め 560,494 px（1,410,000 px 中）、JS 例外 0、Google 通信 0、建物代表点は N03 西区 bbox 内 100%。
出典: 国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025）。取得は公式ソースのみ、出力は gitignore 下の `temp/`。公開・アップロードはしていない。

## 3. 未実施
- 所有者側の private 資産（livecity-3d-data）のローカル読込: この環境にはトークンも資産も無く、未接続。既存の `?ext45=1` + `tools/mission45e-preview.cjs` が受け口。
- 残り 23 区の非破壊検証（PC 側で実行する）。
- konohana / nishinari の click-id-mismatch の原因調査。
- 道路・河川、実機 FPS、Windows 実機。
