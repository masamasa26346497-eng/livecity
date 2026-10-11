# Mission 38 監査レポート（Phase A）

作成: Issue #28 / 対象ブランチ: `claude/issue-28-20261011-1537`（後述「ブランチ名」参照）

**確認方法の注意**: この監査はリポジトリのチェックアウト内容（main相当 `23f965b`）の読み取りのみに基づく。
Claude Code Action の許可ツールに `gh` / GitHub API が無いため、PR #21 / #24 / Issue #25-#27 の内容は
**取得できていない**。下記の PR 規模などは Issue #28 本文の記載値であり、**未検証**と明記する。

## 1. 既存CI（実測: `.github/workflows/`）

- ワークフローは 17 本: `claude.yml` と `mission35*.yml` / `mission36*.yml`（データ生成・Places 系）。
- `claude.yml`: `issue_comment` / `pull_request_review_comment` / `issues(opened, assigned)` / `pull_request_review`
  のいずれかに `@claude` が含まれると起動。`actions/checkout@v4`（`fetch-depth: 1`、ref 指定なし）。
  許可ツールは `Bash(node:*)` と `Bash(python3 -m http.server:*)` のみ。`concurrency` 指定なし。
- **PR 時に自動でテストを走らせるワークフローは確認できていない**（`claude.yml` 以外の内容は本Phaseでは精査対象外。
  `mission*.yml` は個別Missionの手動/データ系と推定されるが未精読）。
- `npm test` は約180本のテストを1コマンドで直列実行する。関連テストだけを選ぶ仕組みは無かった（→ `npm run test:pr` を追加）。

## 2. main と PR #24（Cesium版）の違い

| 項目 | main（実測） | PR #24（Issue記載・未検証） |
|---|---|---|
| 本番画面 | `public/osaka_3d_buildings.html`（Three.js r128, CDN読込） | 同左＋Cesium試作 |
| Cesiumページ | **存在しない**（`git ls-files` で cesium / mission37 該当なし） | `public/mission37d-sumiyoshi-mvp.html` を含む |
| 規模 | - | 33 commits / 97 files（開始時点の目安） |

- **main に無い Cesium ページのテスト・スモークは「成功」扱いにしない。** スモークは main に実在するページのみ対象。
- PR #21（Google Places 写真連携, 188 commits / 53 files 目安）も同様に未取得。両PRとも本Phaseでは読むだけ・変更しない。

## 3. 起点ブランチと並列競合のリスク

1. `claude.yml` の checkout は ref 未指定。Claude Action は Issue 起動時にデフォルトブランチ（main）から
   `claude/issue-N-<日時>` を作る挙動だが、**これは Action 内部仕様でありここでは確認していない**。
   PR コメント起動では当該PRブランチへ直接 push する（Action の説明どおり）。→ PR #24 / #21 に
   `@claude` を書くと、そのブランチに push される危険がある。運用ルールで禁止する。
2. 同一ブランチへ複数の Claude 実行が同時 push すると競合する。`concurrency` が無いため、同一Issue/PRへの
   連続コメントで並走し得る。
3. 巨大PR（上記）は競合・レビュー負荷・手戻りの主因。1 Issue = 1 ブランチ = 1 PR に分割する。
4. main は `protected=false`（Issue記載）。保護設定の変更は今回依頼されていないため運用で防ぐ。

### `claude.yml` について（変更していない理由）
Claude Code Action のGitHub App権限では `.github/workflows` を変更できない。また `base_branch` 等の入力名・挙動を
このセッションでは仕様確認できないため、推測では入れない。`concurrency` の提案は
`docs/development/proposed-workflows/` に置いた（**適用は人間が行う**）。

## 4. 課金リスク

- 課金対象: Google Places / Maps SDK / Photorealistic 3D Tiles（従来のロックを維持。本Phaseは一切呼ばない）。
- 本Phaseで追加した依存・サービス: **なし**（`package.json` の dependencies は変更なし。Playwright も追加していない）。
- スモークは localhost 以外の通信をすべてブロックし、ブロックURLを記録する設計。
- Claude Action の利用枠（OAuth トークン）は既存設定のまま。並列起動数が増えると消費も増えるため、並列化は承認後。

## 5. リードタイム計測の定義

| 区間 | 開始 | 終了 | 取得元 |
|---|---|---|---|
| Issue→着手 | Issue 作成時刻 | Claude の最初のコミット/ブランチ作成 | Issue timeline / Actions run 開始 |
| 着手→PR | 最初のコミット | PR 作成（Draft可） | PR `createdAt` |
| PR→テスト完了 | PR 作成 | 最後のCI/ローカルテスト完了 | Actions run 所要時間 |
| テスト→レビュー完了 | テスト完了 | 人間の承認コメント/レビュー | PR レビュー時刻 |
| 手戻り回数 | - | - | 「要修正」ラベルが付いた回数 |

**着手前の基準値: 未測定**（過去PRのAPI取得ができていないため）。Phase B 以降の各PRで上表を記録して比較する。
「3〜5倍」は目標であり、現時点で達成は主張しない。

## 6. テスト実行結果（このブランチ・無課金・ローカル）

結果は PR 本文に記載（最終報告参照）。ブラウザ検証は Playwright / ブラウザ未導入のため**未実行**。
