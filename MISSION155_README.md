# Mission 155 — 建物の網羅性監査と画面診断（24区の「変換済み」と「描画済み」を分けて測る）

**これは描画漏れの修復完了ではない。** この環境（runner）には 23 区の旧建物タイルも変換出力も無い（アクセス不可）。実データでの欠落の特定と補充は、
オーナー PC で下の 1 コマンドを実行した結果を見てからになる。空白を箱で埋める処理は一切入れていない。

## 追加したもの
- `tools/mission155-coverage-audit.cjs`（読み取り専用・ネットワーク無し）: 区×500m tile で次の 5 段を突合。
  declared（manifest の記録値）/ source（旧タイルの実数。アクセス不可なら `null`）/ converted（ids・tileset.json の参照・GLB 実在）/
  published（Git 追跡の 3D Tiles）/ rendered（画面診断 JSON）。tile 単位の原因 C3（変換で脱落）・C4（tileset/GLB 欠落）・C5（未配信・読込失敗）と、
  区ポリゴンに触れるのにソース tile が無い「空白セル」を出す。C1（真の空地）と C2（ソース欠落）は、ソース側だけでは区別できないので断定しない。
  変換で脱落した tile には、既存 40B の subset 変換コマンド（`--tiles`、別の空フォルダへ出力）を修復計画として出す。既存 tileset は変更しない。
- `public/mission155-diag.js` + 37G への配線: tileLoad / tileUnload / tileFailed を聞くだけの集計（描画・配信は不変）。`?diag=1` で左下に診断パネル
  （宣言 vs 常駐 vs 累計読込 vs 失敗、HTTP 404/CORS の別、C5/C6 のヒント、JSON コピー）。`__mission37g.stats.diag155()` でも取得できる。
- `tools/mission155-diagnose-local.ps1`（ASCII・PowerShell 5.1・読み取り専用）: `C:\lc141`、`%LOCALAPPDATA%\LiveCity-3DTiles-Out-24`、
  `..\livecity-data-pipeline\...` を「存在すれば」自動検出して監査。出力は `data\reports\mission155-coverage\audit-local.json`（件数と tile キーのみ）。

## このリポジトリで実測した事実（`data/reports/mission155-coverage/audit-repo.json`）
- 宣言 574,213 棟 / 1,097 tile（記録値）。ソースにアクセスできる区は 1/24（住吉・Git 追跡の 52 tile / 35,031 棟）。
- Git で配信している 3D は 6 区の一部のみ（合計 33,626 棟）。完全配信（full）の区は 0。残り 18 区は未配信（`not-delivered`）。
- 住吉区: 配信 10,546 棟（30.1%）。ソース 52 tile のうち 43 tile（24,485 棟）は変換済み 3D Tiles が Git に無い（C5: 未配信）。
  区ポリゴンに触れるのにソース tile が無い 500m セルが 4 つ（`t_-7_2` など）。真の空地か元データ欠落かは未判定。
- 他の 5 区（北・中央・天王寺・西・浪速）は宣言棟数に対し部分配信（例: 北区 2,698 / 15,779）。これが「空白の土地」の主因と考えられるが、
  ローカルの全 24 区変換出力での実数は未確認。

## オーナー PC の最小手順
```powershell
git fetch origin; git merge --ff-only origin/claude/issue-23-20261007-1424
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission155-diagnose-local.ps1
```
画面側: ビューアを `...mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&diag=1` で開き、区を選んで診断パネルの「JSONをコピー」→ファイルに保存 →
`-Rendered <file>` を付けて上のコマンドを再実行。貼ってほしい最小値: 実行結果の `source / convertedLocal / publishedGit / rendered` の合計と、
`issues` が 0 でない区の行。

## 検証
- `node --test tests/mission155-coverage-audit.test.cjs`: 8/8 pass（合成 fixture + 実リポジトリ。fixture は実データの代わりではない）。
- 37G の回帰（39B 区選択 QA、実 Chrome headless）: pass、JS 例外 0、Google 通信 0。診断スクリプトを読み込んだ状態で tileset の mount/破棄が通った。
  404 は ext-3dtiles/index.json（ext45 無しのため）・ローカル stations/towns・favicon のみ。
- 診断パネルの画面表示そのものは実ブラウザでは未確認（ユニットテストと mount 経路の無例外確認まで）。

## 未実施
- 欠落 tile の実補充（ソースが無いため）。LOD2 の PR #50 は触っていない。統合影響: 本変更は 37G の mountTileset に read-only の listener を足すだけ。
