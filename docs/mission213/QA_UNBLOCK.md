# Mission 213 QA ブロッカーと最小解除手順

状態: **適用待ち**。QA workflow はまだ存在せず、一度も実行されていません。

## 事実(実ログ・コメントで確認済み)
- Claude Code runner の許可ツールは既定のまま(`.github/workflows/claude.yml:49` の `--allowed-tools` はコメントアウト)。`Bash(node …)` は許可されない。
- 前景コマンドは最大10分。24区ビルドは約815秒 → Claude 経由の単発実行では完走できない。background はジョブ終了時の orphan cleanup で停止する。
- Claude の GitHub App に `workflows` 権限が無く、`.github/workflows/` へは push できない(Claude 自身も回避しない)。
- 実装・検証コードの変更は Claude Code のみが行う。ChatGPT 等が独断でコードを直接変更しない前提。
- App トークンは約1時間で失効(前回 137分後に 401)。したがって長時間処理は Claude ではなく Actions 側の `GITHUB_TOKEN` で実行・報告させる。

## 不足している最小権限
`.github/workflows/mission213-qa.yml` を **1ファイル追加できる書き込み**(リポジトリ管理者のみ)。
GitHub App の `workflows` 権限を付与する必要は**ありません**(付与しないほうが安全)。

## 適用手順(1回だけ)
1. `docs/mission213/qa-workflow-proposal.yml` の内容をそのまま `.github/workflows/mission213-qa.yml` として、ブランチ `claude/issue-67-20261114-1354` にコミット(GitHub Web UI で可。管理者本人の権限で push)。
2. Actions タブ → `mission213-qa` → Run workflow(ブランチは上記、入力は既定のまま)。

以降は追加操作不要: workflow が build → sweep → 集計を同期実行し、PR #68 へ結果を自動コメントします(`GITHUB_TOKEN`、secrets 不使用)。
再実行は同画面の Run workflow のみ。パラメータは入力欄(max_points / alts / budget_min)で変えられ、再コミット不要。

## 守っている制約
- ジョブ 55 分、ビルド 38分/6GB/空きディスクの既存ガード、`workflow_dispatch` のみ(自動連続実行なし)、PR #68 ブランチ限定(`if: github.ref`)。
- 有料 API・secrets・認証設定変更・main/PR #61/production への変更なし。
- artifact は集計 JSON と summary のみ。PLATEAU 原データ・GLB・ビルド出力は保存しない。

## 未確認事項
- 提案 YAML は未実行。ubuntu-latest の Chrome パスは `command -v` で解決(`--chrome` で渡す)が、SwiftShader 起動可否は初回実行で判明する。
- Cesium 1.121.1 は jsDelivr から取得(runner から到達可能なことは過去 run で確認済み)。
- 初回は sweep 8点×2高度のみ。24区全域完了は max_points を増やした複数回実行(各回は 55分以内)が必要になる可能性がある。
- Vercel Preview: この run の GitHub CI ツールで読み取りを試みた結果は PR コメント参照。HTTP 200 は未確認。
