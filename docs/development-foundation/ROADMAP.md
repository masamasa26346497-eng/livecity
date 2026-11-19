# ROADMAP — Development Foundation（Issue #70, 6週間・案）

**状態: Phase A（Week 1 の文書3点）のみ提出。Week 2 以降は未着手。Draft PR のレビュー・本 Issue 上の承認が出るまで進めない。**
各タスクは「小さく・単独で戻せる・既存の動作に差分を出さない」単位。優先度 P1(高)/P2/P3。
承認欄は、後続を本 Issue のコメントで「承認 / 保留 / 却下」と返信できるよう ID（W2-1 等）を付けている。

## 共通の競合回避ルール
- 対象は **`docs/development-foundation/` と新規ファイルを原則**とする。既存ファイルの編集が必要な場合は事前に本 Issue で承認を得る。
- **触らない**: PR #61 / #68 / #66 のブランチ、Issue #65 / #67、`public/*.html`、`tools/cloud/*`（main に無く、PR 側の領域）、
  `.github/workflows/*`（GitHub App に権限なし。提案は `docs/development-foundation/proposals/` に置き、管理者が適用）、
  `public/osaka_3d_buildings.fullward-v3.html`（変更禁止, `AUTODEV_RULES.md` §3）。
- 作業ブランチは Issue ごとに独立（`claude/issue-70-*` / 指定の `feature/development-foundation-*`）、Draft PR、main へ直接 push しない。
- PR #61/#68 のマージで main に `tools/cloud` 等が入る可能性が高い。**文書の主張は commit 付きで書き、マージ後に再監査する**（W4-3）。
- 有料API・secrets・認証・本番公開は一切行わない（承認制）。

## 週次計画

### Week 1 — 正本監査 / DoD（本 PR = Phase A）
| ID | タスク | 優先 | 状態 |
|---|---|---|---|
| W1-1 | `BASELINE_AUDIT.md` | P1 | 提出（レビュー待ち） |
| W1-2 | `DEFINITION_OF_DONE.md` | P1 | 提出（レビュー待ち） |
| W1-3 | `ROADMAP.md` | P1 | 提出（レビュー待ち） |
| W1-4 | `CLAUDE.md` 更新**提案**（下記。適用はしない） | P1 | 提案のみ |
| W1-5 | Issue/PR テンプレート案（`docs/development-foundation/proposals/` に置く。`.github/` へは入れない） | P2 | **未着手**（承認後） |

### Week 2 — CI 品質ゲート監査 / 軽量回帰
依存: W1 承認、Q1〜Q3 の回答。
| ID | タスク | 優先 |
|---|---|---|
| W2-1 | `npm test` の **104 fail を分類**（データ不在 / 環境依存 / 実回帰 / flaky）。読み取りのみ、コード無変更 | P1 |
| W2-2 | npm test 未収録 34 ファイルの棚卸し（意図的除外か漏れか） | P2 |
| W2-3 | PR 向け軽量ゲートの**設計案**（`supplement-offline-test.yml` を雛形に、SHA固定・secrets無し・手動/ラベル起動）。YAML は提案ファイルとして置くのみ | P1 |
| W2-4 | 軽量回帰テスト 1〜2 本（docs の参照切れ検知等。既存テストと重複しないことを確認） | P3 |

### Week 3 — 実ブラウザE2E・証拠標準
依存: W2-1、PR #68 のマージ状況（`tools/cloud/e2e-city-lod0.mjs` を再利用し二重化しない）。
| ID | タスク | 優先 |
|---|---|---|
| W3-1 | V4 の証拠標準（スクショ命名、コンソール/404、描画・クリック・色・24区のチェック項目）を文書化 | P1 |
| W3-2 | 既存 E2E/QA ツールの能力表（合成 / 実データ / SwiftShader の別） | P2 |
| W3-3 | 実PLATEAU・実機での確認は**ユーザー環境が必要**。依頼手順書のみ作成 | P2 |

### Week 4 — 引き継ぎ・並行ブランチ・変更記録
| ID | タスク | 優先 |
|---|---|---|
| W4-1 | ルート直下の MISSION*_REPORT 等 89 ファイルの**索引案**（移動・削除はしない） | P2 |
| W4-2 | 並行ブランチ運用ルール（ブランチ命名、触らない領域、`claude.yml` の main/PR 乖離の扱い） | P1 |
| W4-3 | PR #61/#68 マージ後の再監査手順（`BASELINE_AUDIT.md` を commit 指定で更新） | P1 |
| W4-4 | 変更記録（CHANGELOG 相当）の標準案 | P3 |

### Week 5 — 性能計測方針
| ID | タスク | 優先 |
|---|---|---|
| W5-1 | 指標定義: cold/warm 起動、first building、24区可視、FPS/p95、転送量。各々の測定方法・環境・「実機値」条件 | P1 |
| W5-2 | 既存 `tools/cloud/perf-probe.js` / `mission212` 診断の再利用可否（PR #68 内。マージ待ち） | P2 |
| W5-3 | 実測は実機必須。**SwiftShader 値は参考外**と明記 | P1 |

### Week 6 — 監査と効果比較
| ID | タスク | 優先 |
|---|---|---|
| W6-1 | 再発率・手戻り率・実画面検証率・Issueサイクル時間の**算出可否**を再確認（履歴は main が shallow/1 commit。GitHub API 経由が必要） | P1 |
| W6-2 | BASELINE（本 PR）との差分比較レポート | P1 |

## 依存関係
```
W1(承認) ─▶ W2-1 ─▶ W2-3 ─▶ W3-1 ─▶ W5-1 ─▶ W6
              └▶ W2-2        └▶ W3-2   └▶ W5-2 (PR #68 マージ待ち)
Q1〜Q3 回答 ─▶ W2 以降
PR #61/#68 マージ ─▶ W4-3（再監査）
```

## ユーザー確認事項（回答が必要）
- **Q1**: production が指すブランチ/URL はどれか（Three.js 版 `osaka_3d_buildings*.html` / Cesium 版 / Vercel preview）。本監査では断定できなかった。
- **Q2**: `CLAUDE.md` の更新を許可するか（下記提案の適用範囲）。現状は一切変更していない。
- **Q3**: `npm test` の 104 fail は既知か（データ不在由来か）。W2-1 で分類してよいか。
- **Q4**: Week 2 以降を 1 週ずつ承認する運用でよいか（本ロードマップは各 W を個別承認とする前提）。

## `CLAUDE.md` 更新提案（レビュー用・**未適用**）
| # | 箇所（現行行） | 提案 | 要確認 |
|---|---|---|---|
| 1 | 冒頭 `:9-15` 概要 | 「Three.js 住吉区中心」→ 現行の主系統（Three.js 版 / Cesium 24区版）を併記し、**どれが production かを明記**。main に存在するファイルと PR 上のみのファイルを分けて書く | Q1 |
| 2 | `:34`, `:109`, `:176-184` テスト数 | 「9本/12ファイル/116 pass」→ 実測（181 ファイル指定 / 2,360 tests / 104 fail / 427 skipped, 2026-11-19）に更新し、**日付付き**にする。fail の扱いを注記 | Q3 |
| 3 | `:13,86,145` 「3800行超」 | 実行数 22,087 行へ訂正（または行数記載を削除） | — |
| 4 | ディレクトリ構成 | Cesium / `tools/cloud` は **PR #61/#68 マージ後に追記**（現時点で main に無いため追記しない） | W4-3 |
| 5 | 「情報源の優先順位」 | `AUTODEV_RULES.md` §1 へのリンクと、`docs/development-foundation/` への参照を追加 | — |
| 6 | 「検証」節（新設） | `DEFINITION_OF_DONE.md` の V1〜V5 を参照させる | レビュー後 |
| 7 | 「`npm` コマンド」 | CI の Claude は `Bash(npm)` 非許可（`claude.yml:62`）。`node --test <files>` を使うと注記 | — |
全面書換えはしない。上記以外の現状仕様（座標系 `znorth-neg-v1` 等）には触れない。
