# Mission 213 QA ブロッカーと最小解除手順

状態: **v1 は適用済み・実行済み**(run 43717330656 / 43720356612)。**v2(下記「v2 差分」)は適用待ち**で、現行 `.github/workflows/mission213-qa.yml` は未更新です(Claude は workflow を書き換えていません)。

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

## v2 差分(既存 `.github/workflows/mission213-qa.yml` を更新する・1回だけ)
目的: ラベル経路でも `--start-point` を指定でき、経路の全点を複数バッチで重複なく検証できるようにする。

現行(v1) → v2 の変更点:
| 項目 | v1(現行・適用済み) | v2(`qa-workflow-proposal.yml`) |
|---|---|---|
| ラベル条件 | 名前が `run-mission213-qa` と完全一致 | `startsWith('run-mission213-qa')`。実際の値は `tools/cloud/qa-batch.mjs start` が `^run-mission213-qa(:\d{1,3})?$` で厳密検証し、不正ならビルド前に失敗 |
| 開始点 | 常に 0(同じ8点を再試験するだけ) | ラベル `run-mission213-qa:<n>` の n(ラベルのみ `run-mission213-qa` は 0)。dispatch は `start_point` 入力 |
| 1回の点数 | `--max-points 8`(=8点×2高度=16撮影) | 既定 12点×2高度=24撮影、予算 25 分 |
| 集計 | インライン node | `qa-batch.mjs summary`(index 範囲・要確認点・次ラベルを表示) |
| unit test | 2ファイル | `mission213-sweep-plan.test.cjs` を追加 |
| 変更なし | 55分上限、ビルド 38分/6GB ガード、secrets なし、artifact は集計 JSON のみ、PR #68 head 限定 | 同左 |

`--max-points` は「点」数です(1点=全高度を撮影)。経路の総点数は実データの qa.json `sweep.routePlanned` に出ます(fixture の計画値は 62 点。実データは未確認)。62点なら 12点刻みで 0/12/24/36/48/60 の 6 バッチです。

### 管理者が1回だけ行う操作(GitHub Web UI)
1. ブランチ `claude/issue-67-20261114-1354` で `.github/workflows/mission213-qa.yml` を開き、鉛筆アイコン(Edit)で全文を `docs/mission213/qa-workflow-proposal.yml` の内容に置き換え、同ブランチへコミット。
2. ラベル `run-mission213-qa:12` 以降を使うには、ラベルを事前に作成(Issues → Labels → New label)。必要な分(`:12 :24 :36 :48 :60`)をまとめて作っておけば以後の操作はラベル付与のみ。

### 更新後の進め方(ラベルの付け外しだけ)
1. 先頭バッチ: PR #68 の `run-mission213-qa` を外して付け直す(start=0)。
2. 完了コメントの「次バッチ」に出る `run-mission213-qa:<n>` を PR #68 に付与。これを末尾到達(`次バッチ` が出ない)まで繰り返す。
3. not-loaded / camera-not-held が出た点は、同じ start のラベルを付け直して再撮影(前回 JSON の引継ぎは不要)。
4. 同時実行: `concurrency` で直列化。待機中のジョブは最新の1件だけ残り、古い待機は取り消される。前のバッチ完了を待ってからラベルを付けること。

### 費用見積り(推定・未実測の部分あり)
- 1バッチ ≒ ビルド 11〜15 分(実測 656〜890 秒)+ sweep 最大 25 分 + 準備 ≒ 最大 約45分。ジョブ上限 55 分。
- 6バッチで最大 約 270 分の Linux runner 分(1x)。private リポジトリの Free プランは月 2,000 分の無料枠内。有料 API・有料サービスは使わない。枠を超えるとジョブが止まる/課金設定次第で課金される可能性があるため、残枠はリポジトリ設定で要確認。
- 毎バッチの再ビルド(約 1GB)は避けられない。`actions/cache` で省略する案は、容量上限・権利/アクセス境界(private cache、artifact 化しない)の確認が済んでいないため v2 には入れていない。

### resume を使わない理由
`start_point` だけで区間分割が成立するため、前回 JSON の引継ぎ(artifact の跨ぎ取得)は不要。`--resume` はローカル/dispatch 向けに残している。artifact は 7 日保持の集計 JSON のみ。
