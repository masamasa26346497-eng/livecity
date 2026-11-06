# 並列開発 運用手順（Mission 38 / Phase A）

> **Phase A では並列実行を有効化しない。** 本手順はレビュー・承認後に Phase B で 2 系統の実地検証を行ってから使う。

## 1. 基本ルール
1. 1 Issue = 1 専用ブランチ = 1 PR（Draftで開始）。ブランチ名は `claude/missionNN-<slug>`。
2. 起点は常に最新 `main`: `git fetch origin main && git rev-parse origin/main` で SHA を確認し、Issue/PRに記録する。
3. 他PRのブランチ（例: #21 `feature/mission-36l-building-photo-linking`, #24 `claude/issue-23-20261007-1424`）に
   push・checkout・`@claude` コメントをしない。
4. 同一ブランチへ同時に複数の Claude Code を走らせない。実行中の Issue/PR には追加の `@claude` を書かない（完了を待つ）。
5. main への直接 push / merge / 自動merge / 自動デプロイ禁止。マージは人間の明示承認のみ。force push 禁止。
6. 有料API・課金対象通信は個別承認なしに実行しない。キー・認証情報は記録しない。

## 2. 状態の見分け方（外部SaaSなし）
PR のラベルと CI で判断する。

| 状態 | 判定 |
|---|---|
| 作業中 | Draft PR、または Claude の Actions run が実行中 |
| テスト中 | Draft 解除前で `npm run test:pr` / `npm test` の run が実行中 |
| 要修正 | CI 失敗、またはレビューで changes 要求（`needs-fix` ラベル推奨） |
| レビュー待ち | Draft 解除済み・CI green・未承認（`needs-review` ラベル推奨） |

確認コマンド例（人間のローカル）: `gh pr list --json number,title,isDraft,statusCheckRollup`

## 3. テスト手順
- 日常: `npm run test:pr`（`origin/main` との差分から関連テストを選択。関連不明/共通基盤は自動で全件）。
- マージ前・共通基盤/HTML/データ変更: `npm test`（全件。経路は常に残す）。
- 文書のみの変更は「テスト対象なし」と表示される。**全件成功の意味ではない。**
- ブラウザ: `npm run smoke:browser -- --three-js <ローカルのthree.min.js r128>`。Playwright 未導入時は exit 2（未実行）。
  green は「例外なくロード」のみで、機能保証ではない。結果とスクリーンショットは `artifacts/smoke/`（git管理外）。

## 4. CI 提案（人間が適用）
`docs/development/proposed-workflows/` に `.yml.txt` として置いた（Claude Code Action は workflows を変更できない）。
- `pr-fast-tests.yml.txt`: PR で `test:pr` を実行、手動実行で全件、スモーク結果を artifact 化。
- `claude-concurrency.snippet.txt`: `claude.yml` の job に足す `concurrency`（同一Issue/PRの Claude 実行を直列化、キャンセルしない）。

## 5. Cesium ページ統合時の後続テスト設計（PR #24 マージ後の別Issue）
- 対象: `public/mission37d-sumiyoshi-mvp.html`（main に存在しない間はテスト対象外・成功扱い禁止）。
- 統合後に追加: ① ファイル存在とロード（pageerror 0）② Cesium Ion / Google Photorealistic Tiles への通信をブロックし
  ブロック件数を記録 ③ 住吉エリアの canonicalId 一覧がfixtureと一致 ④ スクリーンショット artifact。
- 課金対象の読み込みはスタブ化し、実タイル取得を伴う確認は個別承認とする。

## 6. Phase B 開始に必要な承認
1. 本PR（Phase A）のレビューとマージ承認。
2. `claude.yml` への `concurrency` 追記と `pr-fast-tests` ワークフロー追加の適用承認（人間が実施）。
3. 2 系統同時実行の検証許可（別ブランチ・別Issue 2 本、課金なし）。
