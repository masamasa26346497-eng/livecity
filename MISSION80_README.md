# Mission 80: PLATEAU 2025 (v5) 24 区再構築バッチと Cesium E2E

出典: 国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5）。Mission79 の source-lock・非破壊ガードを変更せず使う。

## コマンド
```
node tools/mission80-batch.mjs                       # 24 区を順次。status=ok の区は再実行でスキップ（再開）
node tools/mission80-batch.mjs --wards nishi,kita    # 区を指定
node tools/mission80-batch.mjs --verify-only         # 区間 ID 重複と合計だけ再集計
node tools/experiments/mission80_ward2025_e2e.mjs nishi fukushima   # 実 Cesium(37G)+headless Chrome の E2E
```
出力は `temp/mission80/out/<ward>-2025`（gitignore）。manifest は `data/reports/mission80/batch-manifest.json`（区ごとの棟数・unique ID・年版・ETag・tileset sha256・容量・所要・失敗理由）。旧 2022 の 24 区出力・`public/` は書かない。

## 実測（この GitHub Actions runner、headless Chrome はソフトウェア描画で FPS は実機値ではない）
- Cesium E2E（`?nobuiltin=1&ext=<ward>25`、localhost のみ。既存 2024 サンプルとの二重 mount を避けるため追加）:
  | 区 | 棟数（HUD） | tileset | 実マウスクリックで canonicalId 選択 |
  |---|---|---|---|
  | 西区 27106 | 12,603 | 1 / ready | 3/3 |
  | 福島区 27103 | 13,412 | 1 / ready | 3/3 |
  JS 例外 0、Google 通信 0、HTTP 200 146 件。404 は任意ファイル（`ext-3dtiles/index.json`、`layers/layers-report.json`）のみ。
  画像: `data/reports/mission80-ward2025/*.jpg`、結果 JSON: `e2e.json`。
- 区境界線（青）と建物の市街地は重なり、街区の間に道路の隙間が見える（目視）。**道路ポリラインとの重ね描きは未実施**（2025 版の道路レイヤーは未生成）。位置の根拠は Mission79 の tran 向き検査（identity が最少ヒット）と、本回の「代表点が区の緯度経度範囲内」テスト。
- バッチ: 都島区 17,651 棟（unique、skipped 0、約 33 秒の変換）を完了。**24 区全部は完了していない**（下記）。

## テスト
`node --test tests/mission80-batch.test.cjs` 9/9、関連（79・39B・37G・40F）合わせ 34/34 pass。
内容: 区間 ID 重複検出、24 区コードの一意性、バッチの非破壊性（rmSync は out/work のみ・通信なし）、遠景 LOD で小建物を落とさない（`coarseMinArea: 0` 固定）、EPSG:6697 の lat/lon 軸判定、一律 shift/回転が無いこと、実出力の ID 一意・`bldg_` 形式・年版 2025・出典表示・区間重複 0。

## 発見した不具合
`ids/` の `g_*.json` は簡略 LOD の再掲で、数えると棟数が 2 倍になる。バッチは `t_*.json` のみ数える（修正済み）。

## 未完了・LOD
- 24 区の完走は未達（所要が長く、この実行内では都島区のみ確定）。再開は同じコマンド。manifest の ok 区はスキップ。
- LOD2/3（テクスチャ・屋根形状）は未実装。LOD1 押し出しのみ。
- 2025 版の道路・河川レイヤー、施設、写真は未接続。
- 生 GML・GLB は commit していない。公開・Vercel・R2・課金は一切していない。
