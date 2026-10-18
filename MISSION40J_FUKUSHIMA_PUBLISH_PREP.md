# Mission 40J: 福島区を Vercel Preview に出すための準備

## 利用条件の確認状況（未確認）
この環境では WebFetch が許可されず、一次資料（PLATEAU サイトポリシー、OSM Copyright）を読めていません。**確認済みとは扱いません。**
- PLATEAU（国土交通省）: 利用条件・クレジット表記の最終確認は未了。暫定表示「出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2024）を加工して作成」を既存ページが出している。
- OSM 由来の道路・河川・公園・鉄道: ODbL 1.0。帰属「© OpenStreetMap contributors」を表示。派生データベースの公開は ODbL の share-alike 対象になり得るため、公開前にオーナーが条件を確認すること。
- 確認用 URL（オーナーが読む）: https://www.mlit.go.jp/plateau/site-policy/ ・ https://www.openstreetmap.org/copyright ・ https://opendatacommons.org/licenses/odbl/1-0/

## 実装
- `tools/mission40j-stage-public.cjs`: 既定は dry-run（何も書かない）。容量・ファイル数・棟数・ids 件数・layers 完全性・PLATEAU 出典・不明な拡張子を検査。`--execute` は `--license-checked --owner-approved-release --approved-by` が全て必要。コピーは新規ファイルのみ（上書き拒否）、元データは読み取り専用、git は実行しない。
- `public/mission40j-3dtiles/published.json`: 現在は空。`approved:true` の区だけビューアが同一オリジンの tileset として登録する（空の間は追加の通信・404 なし）。
- `.gitignore`: 配置した区ディレクトリは Git 無視。公開時のみ `git add -f`。

## オーナーの手順
```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
# 1) 検査のみ（何も書かれません。容量が表示されます）
node tools\mission40j-stage-public.cjs --src "..\livecity-3dtiles-out-fukushima\fukushima" --ward fukushima
# 2) 利用条件を確認し、公開を最終承認する場合のみ
node tools\mission40j-stage-public.cjs --src "..\livecity-3dtiles-out-fukushima\fukushima" --ward fukushima --execute --license-checked --owner-approved-release --approved-by "<名前>"
```
その後の `git add -f` / push は、承認後に別途依頼してください。
