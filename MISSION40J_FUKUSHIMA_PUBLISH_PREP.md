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

## 公式一次資料に基づくライセンス根拠（オーナーが確認した出典。Claude 環境では直接取得できていない）

| 対象 | 根拠資料 | 実装への反映 |
|---|---|---|
| PLATEAU 建物 | PLATEAU FAQ https://www.mlit.go.jp/plateau/faq/ （商用利用可、CC BY 4.0 等の旨） | ページ出典欄に「出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2024）を加工して作成」と FAQ へのリンク |
| OSM 道路・河川・公園・鉄道 | OSMF Attribution Guidelines https://osmfoundation.org/wiki/Attribution_Guidelines （地図の近くで OSM/ODbL を表示） | 出典欄に「© OpenStreetMap contributors（ODbL 1.0）」と https://www.openstreetmap.org/copyright へのリンク。Cesium Credit にも常時表示 |
| OSM 抽出データ | OSMF Produced Work Guideline https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline | 区別レイヤー JSON は抽出可能な派生データのため、公開前に Produced Work か Derivative Database かの判断が必要（下記） |

## 未確認事項（公開前に解決する）
1. 大阪市の元データ固有の条件: PLATEAU 大阪市 2024 データセット個別の利用条件・クレジット表記指定（FAQ の一般論とは別に確認が必要）。
2. ODbL の派生データベース: 福島区の `layers/*.json` は OSM から切り出した抽出データで、公開すると Derivative Database として ODbL の share-alike（同条件での提供・データ入手手段の提示）が及ぶ可能性がある。法的判断は未了。
3. 1・2 が未解決のうちは `--license-checked` を付けないこと。

## ユーザーPCでの dry-run 最小手順（何も書き込まれない）
```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
node tools\mission40j-stage-public.cjs --src "..\livecity-3dtiles-out-fukushima\fukushima" --ward fukushima
```
出力の `problems` が空か、`size`、`buildings`（期待 11,159）、layers 完全性を確認して結果を貼ってください。`--execute` と `git add -f` はまだ実行しないでください。

## dry-run 実測結果（オーナー PC、Claude 環境からは再確認不可）
mode=dry-run / ward=fukushima / files=91 / 14,085,050 bytes（13.43MB）/ wardCode 27103 / buildings=11159 / ids=11159 / hasLayers=true / problems=[] / maxMb=40。実データは Claude 環境にないため、Git に追加していない（追加できない）。

## 公開前に残る権利・帰属の課題（WebFetch 不許可のため一次資料は未取得。以下は未確認事項の整理）
1. **PLATEAU 大阪市 2024 個別条件**: 大阪市データセットの G 空間情報センター掲載ページの利用条件（ライセンス名・クレジット文言）を原文で確認する。加工物のため「加工して作成」の表記要否も確認。
2. **OSM 抽出レイヤー（layers/*.json）**: 区ごとの道路・河川・公園・鉄道は OSM の抽出ベクターで、Produced Work ではなく Derivative Database と扱われる可能性がある。その場合 ODbL の share-alike（同ライセンスでの提供、データ入手方法の明示）が必要。判断が付かなければ layers は公開せず、建物 tileset のみ公開する案もある。
3. **帰属表示**: 地図近傍に「© OpenStreetMap contributors（ODbL 1.0）」と PLATEAU 出典を常時表示（37G ページに実装済み）。公開 Preview 上での表示は未確認。
4. **PLATEAU 出典の source.json**: stage スクリプトは PLATEAU 記載がなければ中止する（実データで通過済み）。

## 公開時の manifest 登録（実装済み、未実行）
`--execute`（--license-checked --owner-approved-release --approved-by 必須）が、新規ファイルのみコピーし、`public/mission40j-3dtiles/published.json` に `{ward, approved:true, approvedBy, approvedAt, licenseChecked, bytes, buildings}` を追記する。ビューアは `approved===true` の区のみ同一オリジン tileset として登録（`pub-<ward>`）。

## 公開後のプレビュー確認方法（承認後）
1. `git add -f public/mission40j-3dtiles/fukushima public/mission40j-3dtiles/published.json` → push（最終承認後のみ）。
2. Vercel Preview で「3D建物の区」から福島区を選択。HUD の建物数 11,159、`__mission37g.stats.publishedWards` に `fukushima`。
3. 建物クリックで canonicalId・区名・高さ、DevTools の 404 / 例外 / Google 通信が 0、出典欄に PLATEAU と OSM が表示されること。
