# 並列 Claude Code 2系統試験の設計と実施条件（Mission 38・設計のみ／未実施）

**現時点で並列エージェントは起動していない。** 本書は CI ゲートが検証された後の別工程の条件を定める。

## 前提ゲート（全て満たすまで開始しない）
1. `pr-fast-tests.yml`（v2）が適用され、`ci-tools` ジョブが PR 上で緑であること（Actions run URL を記録）。
2. main の全件テスト基準値（失敗件数・名前）が独立環境で取得され、baseline との差分が説明されていること。
3. オーナーによる明示承認（Issue コメント）。

## 構成
- 系統ごとに独立 Issue と独立ブランチ（`claude/issue-<N>-<日時>`）。同一ブランチに複数実行を立てない。
- 競合回避: Issue 作成時に「触るファイル」を宣言し、重複しない系統の組み合わせだけ許可。`public/osaka_3d_buildings.html` を触る系統は同時に1つまで。
- concurrency: Claude 実行は Issue/PR 番号ごとに直列化（`proposed-workflows/claude-concurrency.snippet.txt` 参照）。
- 各 PR は Draft。CI（ci-tools 緑 + 新規失敗0）を通るまでレビュー依頼しない。

## コスト
- 1 実行あたり上限（所要時間・ターン数）を Issue に記載。有料 API・課金通信は禁止。
- 試験は2系統・1往復まで。実行時間と CI 分数を記録し、速度改善は計測後にのみ主張する。

## ロールバック
- 各系統は専用ブランチなので、PR を閉じてブランチを削除すれば戻せる。main へは人手マージのみ。

## レビュー責任
- マージ判断はオーナー。Claude は承認・マージ不可。レビュー結果は PR コメントに残す。
- 失敗・未実行・スキップは成功と書かない。

---
# 追記: 並列PoC（Issue #33/#34）の実証結果と統合ゲート（Mission 38C）

**PoC成功 ≠ 本番レディ。** 確認できたのは「2系統が重複時間帯に起動し、別ブランチへ干渉せず push できる」ことのみ。

## 実証ログ（オーナー報告・GitHub API で確認済みとされる値。本書作成者が再計測したものではない）
| 系統 | Issue | Actions run | ブランチ | コミット | 変更ファイル | Draft PR |
|---|---|---|---|---|---|---|
| A | #33 | 38434006026 | `claude/issue-33-20261013-1652` | `baedb127` | `docs/development/mission38-parallel-trial/agent-a.md` | #35 |
| B | #34 | 38434007907 | `claude/issue-34-20261013-1652` | `fa2e1033` | `docs/development/mission38-parallel-trial/agent-b.md` | #36 |

- 両ジョブは 2026-10-13 16:52:10 UTC に同時開始、`Run Claude Code` が同時に in_progress、両方 success。
- 本書作成時に `node tools/ci/parallel-merge-gate.js --base origin/main origin/claude/issue-33-20261013-1652 origin/claude/issue-34-20261013-1652` を実行し **PASS**（ファイル単位のみ。意味上の競合なしの証明ではない）。

## 統合前チェック: `tools/ci/parallel-merge-gate.js`
- 共通 base（`merge-base`）の一致、重複パス、削除/リネーム、重要パス（`.github/`, `package*.json`, `CLAUDE.md`, `public/`, `data/`, `config/`, `tools/lib/`, `tools/ci/`, secrets 系）を検査。
- 不明 ref・git 取得失敗・変更が空・解析不能は fail closed（exit 2）、検出は exit 1。git は `execFileSync` の引数配列で呼び、ref は厳格に検証する。
- 常に「同一ファイルが無くても意味上の競合は有り得る」と警告する。

## 独立 PR レビュー手順
1. 各 PR が Draft であり、同一 base（main の同一コミット）から分岐していることを gate で確認。
2. PR ごとに別レビュー。ci-tools 緑 + 新規失敗0 を確認。
3. 1本目をオーナーがマージ → 2本目を最新 main に更新 → gate と ci-tools を再実行 → マージ。両方一度にマージしない。
4. 意味上の競合（API・テスト・設定の暗黙依存）は人手レビューで確認する。

## CI の赤とその理由（現状）
- 実ワークフローは旧版で baseline 無しの全件実行のため、既知の104件（生成データ欠落 48・assertion 39・`is not defined` 6・手がかりなし11、機械分類）で赤。新規の壊れではない可能性が高いが、main との同条件比較は未実施。
- v2（baseline 比較 + ci-tools 厳格緑）は提案のみで **未適用**。GitHub 上で緑になった実証はまだ無い。

## 段階的な導入条件
1. v2 workflow を人手で適用し、`ci-tools` が GitHub 上で緑（run URL 記録）。
2. main の全件基準値を取得し baseline と差分説明。
3. `claude.yml` concurrency 提案の適用（注意点は `claude-concurrency.snippet.txt`）。
4. 2系統を本番課題で試行（1往復、コスト上限明記）。gate PASS + 独立レビュー。
5. 上記が揃うまで本番運用と呼ばない。
