# オフラインCI提案（建物補完テスト） — 提案のみ・未適用

## 実原因（訂正）
run 43722698529 / job 132837900151 のログ（ChatGPT確認）: 「The author of pull request #66 is not confirmed to have write access, so commands that run code from the checkout are denied」。
`claude.yml` は main と PR で同一 blob（a2ecd4b）、`Bash(node:*)` は渡っている。**原因は設定の古さではなく `restrict_untrusted_prs` による制限**。本提案はこの防御を無効化しない／別トリガーで迂回しない。

## 目的
`node --test` を、secrets なし・contents:read のみ・deploy/upload なしで実行し、結果を人間が確認できるようにする。
**現時点で `tests/building-supplement-diff.test.js` と `tests/supplement-pipeline.test.js` は一度も実行されていない（合否不明）。**

## 設計
- 提案ファイル: `docs/supplement/proposed-ci/supplement-offline-test.yml.proposed`（bot は `.github/workflows` を変更できないため、owner がレビュー後に配置）。
- トリガー: `workflow_dispatch` のみ（入力 `sha`）。**PR 作成者の信頼判定は GitHub の通常の承認経路に任せ、`pull_request_target` は使わない。**
- 実行する SHA は owner がレビューして入力する。ワークフローは入力 SHA を checkout し、**ブランチ名ではなく SHA 固定**。
- `permissions: contents: read` のみ。`secrets` 参照なし。`actions/upload-artifact` / deploy / `gh release` なし。ネットワークを使うステップは checkout のみ（`npm ci` も使わない: この2テストは Node 組み込みのみ依存）。
- 実行コマンド: `node --test tests/building-supplement-diff.test.js tests/supplement-pipeline.test.js`（結果はジョブログのみ）。
- レビュー済み SHA: 本PRの現HEAD（最終報告に記載）。コミットが増えたら再レビューして SHA を更新する。

## 実行条件（正規経路が整ってから）
1. owner が提案ファイルを確認し `.github/workflows/` へ配置（bot 不可）。
2. owner が `workflow_dispatch` で SHA を指定して実行。
3. 失敗時は Claude 担当で修正（ログ貼付で可）。

## 未確認事項
- テスト失敗の有無は未確認。期待値の一部は手計算。
