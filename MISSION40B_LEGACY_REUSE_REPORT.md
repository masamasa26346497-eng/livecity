# Mission 40B: 旧 Live City 建物資産の棚卸しと一括 3D Tiles 変換

## 結論（実測）
- 旧 Three.js 版 (`osaka_3d_buildings.ward-ux-v1.html`) は `map-data/osaka-city/buildings/manifest.json` と区別 `osaka-<ward>/tile_*.json` を読む。
- **このリポジトリで Git 追跡されている旧タイル実体は住吉区 52 tile / 35,031 棟だけ**。残り 23 区は `.gitignore`（`public/map-data/osaka-city/buildings/`）のため Git・Vercel に無い。
- root manifest の 574,213 棟 / 1,097 tile は記録値。コミット済みの `data/reports/building-dataset-generation.json` の入力は 48,773 棟（住吉＋隣接区の溢れ）で、24 区ぶんの実体が過去に生成された証拠は repo 内に無い。旧タイルが 24 区ぶん存在するなら、**オーナーのローカル PC のみ**。
- 旧タイルは 37B 変換器の入力形式そのもの（`id`=gml:id, `fp`, `z0`, `h`, `usage`, `repX/repZ`）。再ダウンロード不要で直接 3D Tiles 化できる。

## 実装
`tools/mission40b-legacy-tiles-batch.cjs`（ネットワーク・Google 参照なし、元タイルは読み取り専用）
- `--inventory`: 24 区の棚卸し → `data/reports/mission40b-legacy-reuse/inventory.json`
- `--ward <id> [--tiles tx_tz,...] [--out dir] [--force]`: 1 区を変換（GLB / LOD / ids / attrs / source.json）。既に 37B/37H/38E の tileset がある区は `--force` なしでは再生成しない。
- `--all-available`: 旧タイルが完全に揃い、未変換の区だけ順に変換
- `--verify <dir> --against <dir>`: canonicalId 集合の突き合わせ

## 検証（住吉区の実データ）
| 項目 | 結果 |
|---|---|
| 9 tile 変換 vs コミット済み 37B tileset | 10,546 棟、canonicalId 完全一致、`t_-5_-2.glb` バイト一致 |
| 52 tile 全変換 | 35,031 棟 / unique 35,031 / skipped 0 / fallback 0 / GLB 36.0MB・attrs 2.6MB・合計 40.8MB / 変換 0.86 秒 |
| 描画速度 | 未計測（headless はソフトウェア描画。ブラウザ QA は未実施） |

## 棚卸し（`--inventory`）
- 旧タイル実体あり: 1 区 / 35,031 棟（住吉）
- 既存 Cesium 3D Tiles: 6 区 / 33,626 棟（住吉 9 tile、北、中央、天王寺、西、浪速。いずれも一部）
- 旧タイル実体がなく変換できない棟数（manifest 記録値）: 539,182

## 残工数・必要な操作
1. オーナーのローカルに旧タイルがあれば `node tools/mission40b-legacy-tiles-batch.cjs --all-available` で 23 区を一括変換（住吉 52 tile は約 1 秒、全市でも CPU 数分の見込み・外挿）。出力は `temp/mission40b/<ward>/`（gitignore）。
2. 全市の合計は約 0.6GB と外挿。Git/Vercel 静的配信には不向き。配信方式（外部ストレージ等）は費用承認が必要。
3. ローカルに無い区は、PLATEAU の Range 取得（37H の方式）で欠損メッシュのみ補う。
4. 住吉 52 tile（約 41MB）は 37G に未公開。公開可否はサイズ判断待ち。
5. PLATEAU の利用条件確認は未了。

## 旧版 LOD / ラベル制御
旧版は `WARD_LABEL_*`（距離フェード・倍率クランプ）等を持つが、Cesium 版は 37K-2 の POI 予算・`distanceDisplayCondition` で既に代替済み。今回は移植していない。
