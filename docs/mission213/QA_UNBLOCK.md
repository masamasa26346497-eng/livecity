# Mission 213 QA ブロッカーと最小解除手順

状態: **適用待ち**。QA workflow はまだ存在せず、一度も実行されていません。

## 事実(実ログ・コメントで確認済み)
- Claude Code runner の許可ツールは既定のまま(`.github/workflows/claude.yml:49` の `--allowed-tools` はコメントアウト)。`Bash(node …)` は許可されない。
- 前景コマンドは最大10分。24区ビルドは約815秒 → Claude 経由の単発実行では完走できない。background はジョブ終了時の orphan cleanup で停止する。
- Claude の GitHub App に `workflows` 権限が無く、`.github/workflows/` へは push できない(Claude 自身も回避しない)。
- 実装・検証コードの変更は Claude Code のみが行う。ChatGPT 等が独断でコードを直接変更しない前提。
- App トークンは約1時間で失効(前回 137分後に 401)。したがって長時間処理は Claude ではなく Actions 側の `GITHUB_TOKEN` で実行・報告させる。

## GitHub 仕様上の注意(PR #68 レビューでの指摘を反映)
- `workflow_dispatch` の「Run workflow」ボタン / `gh workflow run` は、**workflow ファイルが default branch(main)に存在する場合のみ**一覧に出ます。PR ブランチにだけ置いても UI には出ません(PR #68 レビュー指摘どおり)。
- main に存在すれば、"Use workflow from" で別ブランチを選ぶとそのブランチ上の YAML が実行されます。
- 一方 `pull_request` 系イベントは default branch への配置が**不要**で、PR ブランチ上のファイルで動きます。
- 提案 YAML は両方に対応済み: `pull_request: labeled`(経路A)と `workflow_dispatch`(経路B)。なお `.github/workflows/` の既存 mission35*/36* は別目的で、PR #68 の QA には流用できません(ビルド対象・引数が異なる)。

## 不足している最小権限
`.github/workflows/mission213-qa.yml` を **1ファイル追加できる書き込み**(リポジトリ管理者のみ)。
GitHub App の `workflows` 権限の付与は**不要**(付与しないほうが安全)。Claude は main へ push / merge しません。

## 適用手順(経路A・推奨: main に何も置かない。1回だけ)
1. `docs/mission213/qa-workflow-proposal.yml` の内容をそのまま `.github/workflows/mission213-qa.yml` として、ブランチ `claude/issue-67-20261114-1354` にコミット(GitHub Web UI の "Add file → Create new file"、ブランチ選択はこのブランチ。管理者本人の権限)。
2. PR #68 にラベル `run-mission213-qa` を作成して付与(ラベルは未作成なら新規作成)。`labeled` イベントで起動します。
   - 実行条件: 同一リポジトリの PR、head が上記ブランチ、ラベル名が一致、のときのみ。それ以外ではジョブ全体がスキップされます。
   - 検証対象は PR head の SHA(merge ref ではない)。
3. 再実行: ラベルを外して付け直す。パラメータは既定値(8点 / 3000,10000m / 15分)固定。変えたい場合は経路Bを使うか YAML 既定値を更新してください。

## 経路B(任意): workflow_dispatch を使う場合
- 同じ YAML を **main に追加する管理者操作が別途必要**です(workflow 単体の追加で、PR #68 のマージとは別)。この判断は管理者に委ねます。
- 追加後: Actions → `mission213-qa` → Run workflow → "Use workflow from" で `claude/issue-67-20261114-1354` を選択(main を選ぶと `if` によりスキップされます)。CLI なら `gh workflow run mission213-qa --ref claude/issue-67-20261114-1354`。
- 入力欄 max_points / alts / budget_min を変更できます。
- 必要な権限: Actions の実行は write 権限以上。ジョブ自体は `contents: read` と `pull-requests: write`(結果コメント用)のみ。

以降は追加操作不要: workflow が build → sweep → 集計を同期実行し、PR #68 へ結果を自動コメントします(`GITHUB_TOKEN`、secrets 不使用)。

## 守っている制約
- ジョブ 55 分、ビルド 38分/6GB/空きディスクの既存ガード、`workflow_dispatch` のみ(自動連続実行なし)、PR #68 ブランチ限定(`if` で dispatch は `github.ref`、PR 経路は head ref・同一リポジトリ・ラベルを検査)。
- 有料 API・secrets・認証設定変更・main/PR #61/production への変更なし。
- artifact は集計 JSON と summary のみ。PLATEAU 原データ・GLB・ビルド出力は保存しない。

## 未確認事項
- 提案 YAML は未実行(PyYAML での構文読み込みのみ確認)。`pull_request: labeled` が PR のベースが main 以外(feature/mission206-osaka24-cloud-direct)でも起動する点は GitHub 仕様上の理解で、実機では未検証。ubuntu-latest の Chrome パスは `command -v` で解決(`--chrome` で渡す)が、SwiftShader 起動可否は初回実行で判明する。
- Cesium 1.121.1 は jsDelivr から取得(runner から到達可能なことは過去 run で確認済み)。
- 初回は sweep 8点×2高度のみ。24区全域完了は max_points を増やした複数回実行(各回は 55分以内)が必要になる可能性がある。
- Vercel Preview: この run の GitHub CI ツールで読み取りを試みた結果は PR コメント参照。HTTP 200 は未確認。
