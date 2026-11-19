# BASELINE AUDIT（Phase A / Issue #70）

- 監査日: 2026-11-19 / 対象: Issue #70 Phase A（**文書のみ。コード・設定・workflow は無変更**）
- 監査ブランチ: `claude/issue-70-20261119-1216`（`main` = `934165d`、2026-11-16 の PR #69 マージ）
- 比較参照（読み取りのみ）: PR #61 head `b56e979`（2026-11-14, Mission 212）/ PR #68 head `9af5139`（2026-11-19, Mission 213）/ PR #66 head `75350b5`
- 方針: `AUTODEV_RULES.md` §1（L11）に従い **実コードを正**とする。記憶・過去の会話は根拠にしない。
  根拠は `path:line` / commit / 実行ログ。**確認できなかったものは「未確認」と明記**する。

> **最重要の事実**: Issue #70 が「現行」とするCesium 24区開発（`public/mission37g-osaka-24ward-mvp.html`,
> `tools/cloud/build-cloud-preview.mjs`）は **`main` に存在しない**（`ls` で確認、不存在）。
> 存在するのは PR #61（`b56e979`）・PR #68（`9af5139`）のブランチ上のみ。
> したがって「main = 本番」と「PR ブランチ = 未マージの実験」を混同してはならない。

---

## (a) アーキテクチャ正本候補

| 候補 | 場所 | 状態（根拠） | 判定 |
|---|---|---|---|
| A. Three.js 単一HTML（旧本命） | `public/osaka_3d_buildings.html`（22,087行, `wc -l`）、three r128 を cdnjs から読込（同 L878） | `main` に存在。`CLAUDE.md:13` が「3800行超」と記す = **古い** | main 上の唯一の稼働系。**ただし Issue #70 の言う「現行」ではない** |
| B. Baseline/reference | `public/osaka_3d_buildings.fullward-v3.html`（8,171行） | `AUTODEV_RULES.md:56-` §3 が変更禁止と定義 | 不変の基準。触らない |
| C. ward-ux-v1 | `public/osaka_3d_buildings.ward-ux-v1.html` | `MAP24_PROGRESS.md` が開発系HTMLとして記述（README は言及なし） | main 上の開発系。本番との関係は §6 で要確認 |
| D. **Cesium 24区 MVP** | `public/mission37g-osaka-24ward-mvp.html`（PR #68 上 4,068行）、Cesium 1.121.1 を jsDelivr から読込（同 L41,L450） | **main に無い**。PR #61 / #68 のみ | Issue #70 の「現行」。ただし**未マージ** |
| E. クラウドビルド | `tools/cloud/*`（PR #68 上 `build-cloud-preview.mjs` ほか）、`vercel.json`（PR #68 のみ。`buildCommand` が `build-cloud-preview.mjs --all-wards --city-lod0`、`/` を 37G MVP へリダイレクト） | main に無い | D と対 |
| F. データパイプライン | `tools/`, `config/`, `package.json` scripts（`package.json` 全体） | main 上で稼働 | 正本（A 向けに設計。D も一部流用の可能性、**未確認**） |

**正本の暫定結論（要ユーザー確認）**: 「どの HTML/ブランチが production か」を断定できる根拠は、リポジトリ内には
見つからなかった。`vercel.json` は PR #68 にのみあり main には無い。**production 判定は未確認**。
→ ユーザーに「production が指すブランチ/URL」を確認する必要がある（ROADMAP の確認事項 Q1）。

## (b) 仕様 / 実コードの不一致

| # | 文書の記載 | 実コード（根拠） | 判定 |
|---|---|---|---|
| 1 | `CLAUDE.md:9` 「v0.2.0」、概要は住吉区中心・Three.js | `package.json` は v0.2.0 のままだが scripts は 24区/PLATEAU/canonical 系が136本 | 概要が古い |
| 2 | `CLAUDE.md:13,86,145` HTML は「3800行超」 | `wc -l` = 22,087 行 | 古い |
| 3 | `CLAUDE.md:34` `npm test` は 9 本 / `:109` tests は 12 ファイル / `:184` 116 tests pass | `package.json` の test は **181 ファイル**、`tests/*.test.*` は 215 ファイル。実測 2,360 tests / 1,829 pass / **104 fail** / 427 skipped（下記 (e)） | 大きく古い。「0 fail」は現状と不一致 |
| 4 | `CLAUDE.md:176-` 「`lifestyle-tab*.test.js` は npm test に含まれない」 | その通り（`package.json` に無い）。**同様に npm test 未収録は 34 ファイル**（例: `landuse.test.js`, `mission36k-*`, `ward-lifecycle.test.js`） | 一部正しいが網羅されていない |
| 5 | Issue #70「`CLAUDE.md` は旧Three.js」 | 同意。`CLAUDE.md` に Cesium / mission37g の語は 0 件（`grep` 確認）。`README.md` も 0 件 | 事実 |
| 6 | `CLAUDE.md` 「ディレクトリ構成」に `tools/cloud` なし | main に `tools/cloud` 自体が無い（PR #61/#68 にのみ） | main 基準では正しい。**PR マージ後に陳腐化する** |
| 7 | `docs/mission213/QA_UNBLOCK.md`（PR #68）「`claude.yml:49` の allowed-tools はコメントアウト」 | **main** の `.github/workflows/claude.yml:62` は `--allowedTools "Bash(node:*),…"` が**有効**。PR #68 の claude.yml は L49 が `# claude_args: '--allowed-tools Bash(gh pr *)'`（コメント）のまま | 同名ファイルが main と PR #68 で**異なる**。PR #68 のブランチは main の権限設定を持たない |
| 8 | `CLAUDE.md` 「`data/raw` 等に成果物なし」 | `git ls-files data/raw data/processed public/map-data` = 394 件。`public/map-data/osaka-city` は `.gitignore` 対象（`MISSION37G_OSAKA_24WARD_REPORT.md` §2 PR#68上） | 部分的に古い（未精査） |

**他の文書の鮮度**: ルート直下に `MISSION*_REPORT.md` 等が 89 ファイル、runbook 類が多数。
`AUTODEV_REPORT.md` / `MAP24_PROGRESS.md`（3,894行）は追記型ログで「現状仕様」ではない。
**どれが現行仕様の正本かを示す索引が存在しない**（リスク R1）。

## (c) CI と E2E の既存能力

### main の `.github/workflows/`（24ファイル）
- **PR/push で自動実行される汎用テストゲートは無い**。`claude.yml` は `@claude` 起動のみ。
  `mission35l/35p/35r/35s/36i/36j*/36k*` は**特定 feature ブランチの push** 限定、`mission94/95/105/108/127/129`・
  `supplement-offline-test` は `workflow_dispatch`。（各ファイルの `on:` 先頭で確認）
- `claude.yml`: `fetch-depth: 1`（L36）、`concurrency queue: max`（L24）、許可ツール `Bash(node:*)` 他（L62）。
  → **`npm` は許可外**のため CI の Claude は `node --test <files>` で代用する必要がある。
- `supplement-offline-test.yml`: SHA 固定・secrets なし・手動のみ。**安全な手動テスト workflow の既存雛形**（再利用候補）。

### テスト
- 単体/回帰は Node 組込 `node --test`。**ブラウザを使うテストは main では `tools/lib/cdp-browser.js`（CDP, Edge/Chrome の Windows パス候補）経由**、
  CI 上の実ブラウザ実行は `mission129-fetch-21.yml`（手動）のみ確認。
- **E2E**: main に常設の E2E ゲートは無い。PR #68 に `tools/cloud/e2e-city-lod0.mjs`（headless Chromium + SwiftShader、
  **既定は合成 fixture**、`--static <build出力>` で実データ。結果の `fixture` が `synthetic` / `real-build-output`）がある。
- 重要な粒度差（PR #68 `MISSION213_CITY_LOD0.md` 自身の記述）: 合成 fixture の成功 ≠ 実PLATEAU 24区。
  「実PLATEAU24区、速度/FPS/転送量計測、LOD1/2 との重なり実描画比較は未実施」。SwiftShader の FPS は実機値ではない。
- **PR #68 の `npm test` には `.cjs` テストが 0 件**（`package.json` の test 文字列で確認）。PR #68 上の `tests/*.test.cjs` 18 件
  （`mission213-*`, `mission37g-osaka-24ward`, `mission212-load-speed` 等）は **`npm test` では実行されない**。個別実行が必要。
  （PR #68 のテスト実行は本監査では**未実施**）
- `mission213-qa.yml`（PR #68）はラベル `run-mission213-qa` で起動、`.github/workflows` への push は GitHub App に権限が無いため
  管理者が手動適用する運用（`docs/mission213/QA_UNBLOCK.md`）。

## (d) 不足とリスク

| ID | 内容 | 根拠 | 重大度 |
|---|---|---|---|
| R1 | 現行仕様の正本/索引が無く、`CLAUDE.md` が旧仕様 → AI が古い前提で実装・重複実装 | (b)-1〜6 | 高 |
| R2 | PR/push の自動品質ゲートが無い（`npm test` は誰も自動では回さない） | (c) | 高 |
| R3 | `npm test` が **現状 104 件失敗**。ゲート化すると常に赤。原因（ローカル専用/gitignore データ不在か、実回帰か）を切り分けていない | (e) | 高 |
| R4 | npm test 未収録テストが 34（main）。PR #68 は新規 `.cjs` が全て未収録 | (b)-4, (c) | 中 |
| R5 | 「検証済み」の粒度が不統一（合成 fixture / SwiftShader / 実機が同じ「確認済み」で語られうる） | (c) | 高 |
| R6 | main と PR #61/#68 の `claude.yml` が乖離。ブランチ起点により AI の権限が変わる | (b)-7 | 中 |
| R7 | PR #61 / #68 / #66 が大規模（`main..pr/68` = 1,431 files / +123,543 行）で long-lived。マージ競合・文書陳腐化が発生しやすい | `git diff --stat main pr/68` | 高 |
| R8 | PR/Issue テンプレートが無い（`.github/ISSUE_TEMPLATE`, `pull_request_template.md` 不在） | `ls` | 中 |
| R9 | 実機 FPS・転送量・起動時間の計測が無い（既存は SwiftShader 値のみ。`perf-probe.js` は PR #68 に存在） | PR #68 `MISSION37G_..._REPORT.md` §4 | 中 |
| R10 | Mission 系 workflow が 20 超で feature ブランチ名をハードコード。不要化後の掃除方針が無い | `on:` 一覧 | 低 |

## (e) 現状測定指標（実測値のみ）

`main`(=本ブランチ, 差分ゼロ) で、`package.json` の `test` 引数を `node --test` に渡して実行（Node v24.22.2, Linux runner）:

| 指標 | 値 |
|---|---|
| tests | 2,360 |
| pass | 1,829 |
| **fail** | **104** |
| skipped | 427 |
| duration | 約 83.6 秒 |

- 失敗例（ログ抜粋）: `[FIX24 §1]`, `[33B §1/§2]`, `[FIX10 §18/§19]`, `extractExactBuildingGeometry …`, `[README] data/raw/gsi/... README.md が存在し…`
  → 一部は `data/raw/gsi/...` の不在を主張しているため **gitignore / ローカル専用データ不在が原因の可能性**があるが、
  **全 104 件の原因分類は未実施**（Week 2 の作業）。
- 実行は **キャッシュなし・1 回のみ**。再現性（flaky の有無）は**未確認**。
- 未計測（ベースライン欠落）: 不具合再発率、手戻り率、実画面検証率、Issue サイクル時間、cold/warm 起動、FPS/p95、転送量。
  これらは Week 6 の比較に必要だが、**現時点で履歴から安全に算出できる根拠データを整理していない**（Week 1〜2 で定義）。

---

## 未確認点（本監査で確認できなかったこと）
1. production が指すブランチ/URL（Vercel 設定の実体、保護設定）
2. PR #61 / #68 / #66 上のテストの実行結果（本監査では実行していない）
3. 104 件失敗の原因分類と flaky 性
4. 実 PLATEAU / 実機 Chrome+GPU での 24区表示（既存報告は合成 fixture/SwiftShader/localhost）
5. Issue #65 / #67 本文・PR #66 の実装内容の詳細（今回は head commit と題名のみ参照。Issue 本文は未取得）
6. 本リポジトリは shallow（`git rev-parse --is-shallow-repository` = true）で main の履歴は 1 commit のみ。**コミット履歴に基づく再発率等は算出不能**
