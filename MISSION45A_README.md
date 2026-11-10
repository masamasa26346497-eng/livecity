# Mission 45A — 24 区の Cesium 実建物表示: 棚卸しと PC 側手順（準備・検証のみ）

**24 区の完了ではない。** Git に 3D があるのは 6 区だけで、すべて「区の一部」。検証済み（区全域）の区は 0。
実建物データの新規追加・公開・Windows 変換はしていない（ライセンス / secret / 個人情報の安全ゲートは false のまま）。

## 1. 棚卸し（Git 追跡 vs PC-only）
- 旧建物タイル（`public/map-data/osaka-city/buildings/`）で Git 追跡されているのは **住吉区 52 tile / 35,031 棟のみ**。他 23 区は gitignore 対象で PC のみ。
- Git 追跡済みの 3D Tiles（37B/37H/38E）: 住吉 9 tile、北、中央、天王寺、西、浪速（各 限定メッシュ）。これらは既に 44A の 6 区に含まれる。
- したがって「Git 追跡済みデータだけで新たに追加できる区」は **0**（住吉の残り 43 tile は旧タイルがあるが、52 tile 変換物の公開は未承認のため追加しない）。
- 実行確認: `node tools/mission43-ward-rebuild.cjs manifest` → wardsWith3dInGit=6, wardsLegacyTilesCompleteInGit=1, wardsNeedingSourceData=23, uploadAllowed=0。
  `node tools/mission43d-ward-batch.cjs batch-plan` → tracked-legacy-rebuildable 1 / not-ready 23（PC の匿名 audit 出力が無いため）。

## 2. 区ごとの状態（manifest 値。出力容量は 1,164 B/棟の推定で測定値ではない）
| 区 | 区コード | 旧タイル 棟/tile | 推定出力 MB | Git の 3D | 状態 |
|---|---|---|---|---|---|
| 北区 | 27127 | 15,779 / 44 | 17.5 | 2,698棟 | 部分表示 |
| 都島区 | 27102 | 13,199 / 33 | 14.7 | なし | 未変換 |
| 福島区 | 27103 | 11,159 / 25 | 12.4 | なし | 未変換（PC では変換成功の報告あり・Git にはなし） |
| 此花区 | 27104 | 13,437 / 58 | 14.9 | なし | 未変換 |
| 中央区 | 27128 | 18,279 / 52 | 20.3 | 5,629棟 | 部分表示 |
| 西区 | 27106 | 12,098 / 29 | 13.4 | 3,893棟 | 部分表示 |
| 港区 | 27107 | 15,489 / 34 | 17.2 | なし | 未変換 |
| 大正区 | 27108 | 17,363 / 40 | 19.3 | なし | 未変換 |
| 天王寺区 | 27109 | 14,244 / 30 | 15.8 | 6,593棟 | 部分表示 |
| 浪速区 | 27111 | 10,133 / 30 | 11.2 | 4,267棟 | 部分表示 |
| 西淀川区 | 27113 | 23,242 / 47 | 25.8 | なし | 未変換 |
| 淀川区 | 27123 | 34,289 / 62 | 38.1 | なし | 未変換 |
| 東淀川区 | 27114 | 34,685 / 66 | 38.5 | なし | 未変換（高さ sentinel 2 棟あり: 40E） |
| 東成区 | 27115 | 21,976 / 29 | 24.4 | なし | 未変換 |
| 生野区 | 27116 | 46,212 / 50 | 51.3 | なし | 未変換 |
| 旭区 | 27117 | 22,424 / 35 | 24.9 | なし | 未変換 |
| 城東区 | 27118 | 32,447 / 48 | 36.0 | なし | 未変換 |
| 鶴見区 | 27124 | 22,068 / 46 | 24.5 | なし | 未変換 |
| 阿倍野区 | 27119 | 26,924 / 38 | 29.9 | なし | 未変換（ID 衝突あり: 40D） |
| 住之江区 | 27125 | 21,608 / 67 | 24.0 | なし | 未変換（ID 衝突あり: 40D） |
| 住吉区 | 27120 | 35,031 / 52 | 38.9 | 10,546棟 | 部分表示（9/52 tile） |
| 東住吉区 | 27121 | 38,489 / 59 | 42.7 | なし | 未変換（ID 衝突あり: 40D） |
| 平野区 | 27126 | 44,434 / 83 | 49.3 | なし | 未変換 |
| 西成区 | 27122 | 29,204 / 40 | 32.4 | なし | 未変換（ID 衝突あり: 40D） |
| 合計 | | 574,213 / 1,097 | 約 637 | 33,626棟（6区） | 検証済み区 0 |

## 3. PC 側（Windows PowerShell 5.1）の手順 — 後日、ユーザーが実行（今回は未実行）
実測の参考値: 福島区 25 tile / 11,159 棟 → 出力 約 13.3MB、変換 約 0.7 秒（40F 報告）。全 23 区でも変換自体は CPU で数分、検証・確認作業が支配的と見込む（推定）。
```powershell
# 0) 読み取りのみの監査（件数のみ出力）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43e-audit.ps1
# 1) 検証・診断（40C/40D）。20 区 ok / 4 区 issues の既知結果あり
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission40c-run-local.ps1 -LegacyBuildings "<旧 buildings>" -Mode validate
# 2) 計画（既定は dry-run）→ 実行（出力先はリポジトリ外の新規フォルダ）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43f-convert.ps1 -LegacyBuildings "<旧 buildings>" -OutRoot "<新規フォルダ>" -Wards fukushima
#   承認後に -Execute を付ける。引数は tools\mission43f-convert.ps1 の記載に従う
# 3) 出力検証 + 127.0.0.1 限定プレビュー（43G）
node tools\mission43g-local-preview.cjs --out-root "<新規フォルダ>" --serve
# 4) ブラウザ: http://127.0.0.1:<port>/mission37g-osaka-24ward-mvp.html?ext=<ward> で区を選択
```
- 想定出力合計: 約 640MB（推定）。必要ディスク: 旧データ読み取り + 出力約 0.7GB。区ごとに別フォルダへ出力し、既存ファイルは上書きしない。
- 4 区（東淀川=高さ sentinel、阿倍野/住之江/住吉/東住吉/西成=ID 区間衝突）は 40D/40E の方針（複合キー・仮高さ表示）を確認してから変換する。
- 出力は Git に入れない。公開にはライセンス（PLATEAU 大阪市 2024 / OSM ODbL）・secret・個人情報の各ゲートの人による承認が別途必要。

## 4. 回帰検証（この環境、2026-10-26）
- `node tools/experiments/mission44a_render_e2e.mjs`: 6/6 pass、JS 例外 0、Google 通信 0、404 0。各区 tileset/GLB HTTP 200、画素差分 30〜53%（建物なし/あり同一カメラ）。
- `node tools/experiments/mission37h_multiward_qa.mjs`: 実クリックで canonicalId・sidecar・区名が一致（北・中央・天王寺・西・浪速）。JS 例外 0、Google 0。404 は favicon のみ。
- `node --test`（44A / 40A / 39B / 37H）: 32 件中 31 pass、1 skip（opt-in の E2E）、fail 0。
- 未計測: FPS・初回表示時間（headless はソフトウェア描画で実機値にならない）。
