# Mission 79: PLATEAU 2025 (v5) CityGML 原本からの非破壊再構築

出典: 国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5）。ライセンス: PLATEAU サイトポリシー（商用利用可、出典表示）。
27999（万博会場、商用不可）は別データ。`guardPackage` が 27100 以外を拒否する。

## コマンド（すべて読み取り専用の取得、出力は `temp/`＝gitignore）
```
node tools/mission79-plateau2025-source.mjs                 # CKAN→HEAD→ZIP中央ディレクトリ(Range)→ data/reports/mission79/source-lock.json
node tools/mission79-run.mjs --ward nishi --dry-run         # N03 bbox と交差するメッシュ数・容量を表示（取得しない）
node tools/mission79-run.mjs --ward nishi --limit-meshes 2  # 一部メッシュ
node tools/mission79-run.mjs --ward nishi --max-mb 700 --legacy public/mission37h-3dtiles/nishi-sample
```
段階: 取得(bldg+tran, Range, sha256, 再開, ETag照合, 容量上限) → `mission36k-convert-citygml-runtime.mjs`(無変更) → N03点内判定 → 500m tile → 3D Tiles(`mission37b` build, `coarseMinArea=0`で小建物を落とさない) → ID対照表 → 道路×建物の向き検査。
出力先が空でない/旧出力場所なら中止。失敗時は即停止。生 GML・GLB は commit しない。

## 実測（このrunner、無料のCommons不要・PLATEAU公開ZIPのRangeのみ）
- 2025 ZIP: 1,580,421,888 B、ETag `3d62380f…`、7,089 ファイル（bldg 270 / tran 288）。全体は取得していない。
- 西区(27106)全域: 16 メッシュ（圧縮28.7MB/展開599MB）→ 取得～3D Tiles まで約49秒。
  読込 42,060 棟 → 西区内 **12,603 棟**（ID一意、skipped 0、fallback 0）、30 tile、GLB 17.7MB、合計21.1MB。
  変換器が自己交差で1棟除外（メッシュ全体、区外の可能性あり）。
- 2024 との照合（既存 nishi-sample 3,893 棟）: gml:id 完全一致 3,893 / 3,893、重心ずれ最大 0 m、高さ差中央値 0。
  → 2025 年版の建物レイヤーは、この範囲では 2024 と同一。2025 で ID が変わった建物は検出されず、
  追加 8,710 棟は旧サンプルの範囲外（= 旧にない）であり「新築」ではない。legacy-only 0。
- 向き検査（PLATEAU tran 道路 vs 建物重心、座標系 znorth-neg-v1）: identity の道路上ヒット 0.61%、flipX/flipZ/rot180/swap は 15.9–31.4%。反転・回転なし。
- 未確認: Cesium でのブラウザ描画（今回は未実施）、OSM 補完との照合、LOD2/3 の利用、旧2022ローカル24区との照合（このPCには無い）。

## 次
`--ward` を変えて他区を実行（北区など）。全24区の展開前に配信方式と容量の承認が必要（約0.6GB規模）。
