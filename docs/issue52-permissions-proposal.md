# Issue #52 外部取得再開のための最小権限変更案（提案のみ・未適用）

この文書は提案です。実行中に権限は変更していません。`.github/workflows/claude.yml` は main 側の管理で、
この PR のブランチからは変更しません（GitHub App に workflow 更新権限がないため、変更する場合は人手での反映が必要）。
main へ反映する前に、人間がレビューしてください。

## 現状（確認済みの拒否）
- `gh issue view`、`curl`、WebFetch は未許可。Bash はオフラインのテスト/プレビュー/読み取りに限定。

## 提案: 読み取り専用・ドメイン限定
1. **WebFetch** を次のドメインに限定して許可
   - `www.wikidata.org`（Wikidata API / Special:EntityData）
   - `commons.wikimedia.org`（MediaWiki API: `action=query` / `wbgetentities` / `geosearch`、読み取りのみ）
   - `upload.wikimedia.org` は不要（画像本体は取得せず、URL とメタデータだけ保存する）
2. **OSM**（任意・第2段階）: Overpass はレート制限が厳しいため、まずは既存の `tools/photos/extract-osm-wikidata-tags.mjs` が使う
   ローカル PBF 経由を維持し、外部 Overpass は許可しない。
3. **Bash** は無制限にせず、特定コマンドだけ追加
   - `Bash(node tools/photos/fetch-*:*)`（取得スクリプトを固定パスで実行）
   - `Bash(gh issue view:*)`（Issue 本文の読み取りのみ。`gh issue edit` / `gh api` は含めない）
4. 取得スクリプトの責務（コード側で担保）
   - User-Agent に連絡先を含める / 1 リクエスト以上の間隔 / リトライ上限 3 回 / 結果をキャッシュして再開可能な小分け処理
   - 検索操作ごとの外部通信はしない（事前索引のみ参照）

## 提案しないもの
- 無制限の Bash、`bypassPermissions`、`curl` の無条件許可。
- 有料 API（Google Places、Flickr 商用 API 等）、Mapillary の認証付き呼び出し（トークン未設定のため接続口のみ）。
- 大阪観光局素材（申請と用途条件があるため一括取得しない）。

## workflow 更新権限について
- 上記 1 と 3 は `claude.yml` の `allowed_tools` 相当の変更で、**workflow ファイルの編集が必要**。
  GitHub App には workflow 更新権限がないため、リポジトリ管理者が main へ PR/commit する必要がある。
- 代替: ローカル PC で取得し、`data/photos/` に候補 JSON を置く。本 PR の `tools/photos/lib/import-candidates.mjs` が
  検証・重複除去・保留を行うため、権限変更なしでも取り込みは進められる。
