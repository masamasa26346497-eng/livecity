# Issue #52 外部取得再開のための最小権限変更案（提案のみ・未適用）

この文書は提案です。実行中に権限は変更していません。`.github/workflows/claude.yml` は main 側で管理され、
このブランチからは変更しません。main へ反映する前に、人間がレビューしてください。

## 観測事実と推定の区別
**観測した事実**（この Actions 実行・このブランチで確認したもの）
- このブランチの `.github/workflows/claude.yml` には `claude_args` / `allowed_tools` の指定がない（コメントアウトされた例のみ）。
- 前回までの実行で、`gh issue view`、`curl`、WebFetch は承認が必要で拒否された。
- Claude Code Action の実行指示には「`.github/workflows` 配下のファイルは GitHub App の権限上、変更できない」と明記されている。

**ユーザーの説明（このブランチからは確認できない）**
- main の `claude.yml` は Bash をオフラインのテスト/プレビュー/読み取りに限定しており、`Bash(node:*)` が既に許可されている。
  main の実ファイルは読めていないため、下の差分は main の現行 `claude_args` に合わせて人が調整する必要がある。

**推定（未検証）**
- workflow ファイルを更新できないのは GitHub App が `workflows` 権限を持たないため、という説明は上記の実行指示と整合するが、
  実際に push して拒否を確認したわけではない。「権限がない」と断定せず、管理者が main で変更する前提にする。

## 重要: `Bash(node:*)` が許可済みなら、`fetch-*` の追記だけではドメイン制限にならない
`Bash(node:*)` は任意の node スクリプト（インラインの `fetch()` を含む）を実行できる。そこへ
`Bash(node tools/photos/fetch-*:*)` を足しても、許可範囲は何も狭まらず、取得先も制限されない。
ドメイン制限は次の二層で担保する（どちらか片方では足りない）。

1. **ツール権限（Claude Code 側）**: `WebFetch(domain:...)` は WebFetch ツールのドメインだけを制限する。Bash 経由の通信は制限しない。
2. **取得器（コード側・実装済み）**: `tools/photos/lib/safe-fetch.mjs`
   - https の GET のみ、許可ホストは完全一致（`www.wikidata.org` / `commons.wikimedia.org`）、許可パスと読み取り系 action
     （Wikidata: `wbgetentities` / Commons: `query`）のみ。認証情報付き URL・非標準ポートは拒否。
   - リダイレクトは自動で追わず（`redirect: 'manual'`）、各リダイレクト先を同じ検証にかける。最大 3 回。許可外ホストへの転送は中断。
   - 要求間隔 `minIntervalMs`（**ミリ秒**、既定 1000 = 1 秒以上空ける）、リトライは 429/5xx のみ最大 3 回（指数バックオフ）、タイムアウト 20,000 ms。
   - キャッシュ（URL のハッシュ）に保存し、`--offline` でキャッシュだけを使って再実行できる（再開可能な小分け処理）。
   - User-Agent は汎用のクライアント名のみ。連絡先が必要なら環境変数 `PHOTO_FETCH_UA_CONTACT` で指定する（コードに個人情報を入れない）。
   - 試験: `tests/mission52-photo-routes.test.cjs`（許可外ホスト/パス/action、リダイレクト先、リトライ上限、キャッシュ、オフライン）。

ただし、`Bash(node:*)` が許可されたままだと、**Claude が取得器を使わずに別の node コードで外部へ接続することは権限上は防げない**。
取得器の制限は「正しい経路を使えば取得先が広がらない」ことを保証するものであって、サンドボックスではない。
権限の面で取得先を絞りたい場合は、`Bash(node:*)` を狭める（テスト用の固定コマンドへ置き換える）か、ネットワーク側（ランナーの egress 制限）で制御する必要がある。
どちらも main 側の判断なので、本 PR では提案にとどめる。

## 提案する最小の差分（`.github/workflows/claude.yml`、main で人がレビューして適用）
main の現行 `claude_args` に次を**追加**する（現行の許可を置き換えない）。`<既存>` は main に既にある許可。

```diff
         with:
           claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
+          claude_args: |
+            --allowed-tools "<既存>,WebFetch(domain:www.wikidata.org),WebFetch(domain:commons.wikimedia.org),Bash(node tools/photos/fetch-issue52-routes.mjs:*),Bash(gh issue view:*)"
```

- 取得は `node tools/photos/fetch-issue52-routes.mjs`（safe-fetch 経由）に集約する。`--limit N` で小分け、`--offline` でキャッシュのみ。
  このスクリプトは公開索引を変更せず、`data/photos/issue52-import-report.json` と `issue52-adopted.json` だけを書く。索引への接続は `mergeIntoIndex` を人がレビューしてから行う。
- `Bash(gh issue view:*)` は Issue 本文の読み取りのみ。`gh issue edit` / `gh api` は含めない。
- 既に `Bash(node:*)` がある場合、上の `Bash(node tools/photos/...)` 行は冗長（制限にならない）。意図を明示するための記載で、制限の根拠にはしない。

## 提案しないもの
- 無制限の Bash、`bypassPermissions`、`curl` の無条件許可。
- `upload.wikimedia.org`（画像本体）は取得しない。URL とメタデータだけ保存する。
- OSM Overpass の外部取得（レート制限が厳しい）。OSM の明示タグは既存のローカル PBF 経由（`extract-osm-wikidata-tags.mjs`）を維持する。
- 有料 API（Google Places、Flickr 商用 API 等）、Mapillary の認証付き呼び出し（トークン未設定のため接続口のみ）。
- 大阪観光局素材（申請と用途条件があるため一括取得しない）。

## 適用手順（人が行う）
1. main で `claude.yml` を上記のとおり編集する PR を作り、レビューする（この PR からは行わない）。
2. 適用後、まず `--limit 20` で小さく取得し、`issue52-import-report.json` の `heldByReason` と `byRoute` を確認する。
3. 問題がなければ分割して取得を進め、`issue52-adopted.json` をレビューしたうえで索引へ接続する。

## workflow 権限が使えない場合の代替
ローカル PC で `node tools/photos/fetch-issue52-routes.mjs` を実行し、生成された `data/photos/issue52-*.json` を本ブランチに追加する。
検証・重複除去・保留・索引接続は権限変更なしで進められる。
