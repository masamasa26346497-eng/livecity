# Mission 38: PR #29 CI 失敗 104 件の切り分け

出典: GitHub Actions「PR fast tests」run 38190403528 / job `related`（`1edb08d`、FULL 182/182 files）。
合計 2366 tests / 1836 pass / **104 fail** / 426 skipped。ログ全体（21MB）を `tools/ci/classify-tap-failures.js` で解析。
分類は**ログ上の文字列だけが根拠**で、原因を実行して確定したものではない。

## 件数（機械分類。手がかり文字列による）
| 分類 | 件 | 根拠 |
|---|---|---|
| 生成データ欠落の疑い | 48 | `ENOENT … data/processed/osaka-city/…`、`manifest が無い`、`ビルド記録が無い` 等 |
| assertion（要個別確認） | 39 | 実データ/DOM依存の動的テスト（`runtime:`、`動的:`）、`protected は不変` 等。データ欠落の副作用かは未確認 |
| `is not defined` | 6 | 下記「テスト基盤の不整合」 |
| 手がかりなし | 11 | 大半が `Cannot read properties of null (reading 'featureCount'/'landmarks')`。欠落データを null で読んだ結果と推測されるが**未確認**のため unknown のまま |

詳細リスト: `tools/ci/baseline/pr29-run38190403528.json`（名前・分類・エラー先頭）。

## 判明していること（根拠あり）
1. **PR #29 の差分は 13 ファイル（docs / CI tooling / templates / package.json / .gitignore / CLAUDE.md）で、`public/`・`data/`・既存テストを一切変更していない。**
   失敗テストはすべて PR が触っていないファイルに属する。従って「PR のコード変更が直接起こした」可能性は低い。ただし **main の同条件実行は未取得**のため main 起因とは断定しない。
2. `ENOENT` の対象（`data/processed/osaka-city/canonical/…`、`public/map-data/osaka-city/{railways,parks,water-surface,landmarks,…}`）は、CLAUDE.md が「生成データは未配置の可能性」と述べている領域。CI のチェックアウトに無いのは整合的だが、リポジトリに本当に無いのか gitignore/LFS かは未確認。
3. **テスト基盤の不整合（再現済み）**: `tests/exact-triangle-highlight.test.js` のローダーが `crGetBiTriIndex` を抽出対象に含めず、
   `extractExactBuildingGeometry` が `crGetBiTriIndex is not defined` で落ちる（ローカルでも再現、HTML 側の関数は存在）。
   Mission 36D で HTML 側に追加された関数にテストローダーが追随していない既存の不具合で、PR 由来ではない。
   同じ原因のものが `tests/mission-36e-full-surface-highlight.test.js` にもある可能性が高い（ローカルで両ファイル実行時 8 件失敗）。
   ※このセッションでは**修正していない**（既存テスト・期待値の変更は本 PR の範囲外。独立 Issue 候補）。

## 独立修正 Issue 候補
- A. `exact-triangle-highlight` / `mission-36e` のローダーに `crGetBiTriIndex` 等の依存関数を追加（テスト基盤）。
- B. 生成データ依存テストを「データ統合テスト」として分離し、データ未配置時に**明示的な理由付き skip**または専用 job に（無条件 skip 禁止）。
- C. `35C` の `C:\LiveCityAssets\…` のように環境固有パスに依存するテストの是正。
- D. `Mission19` CSS / `Mission08` ハイライト等、データ欠落と無関係な assertion 失敗（要個別調査。main でも赤か確認）。

## 未実施・未検証
- main HEAD `23f965b` での全件実行: **未実施**（この環境で `npm test` 全件実行は許可されなかった。回避もしていない）。
- 39 件 assertion と 11 件 unknown の真因: **未判明**。

## main と PR を同条件で比較する手順（無課金・ネットワーク不要）
同一 runner / Node 22 / `npm ci --ignore-scripts` で、それぞれ:
```bash
git checkout <sha>            # 23f965b (main) と PR head の2回
npm ci --ignore-scripts
node --test --test-reporter=tap $(node -e "console.log(require('./package.json').scripts.test.match(/tests\/[\w.-]+\.test\.js/g).join(' '))") > /tmp/tap-<label>.log 2>&1
node tools/ci/classify-tap-failures.js /tmp/tap-<label>.log --json > /tmp/fail-<label>.json
```
両 JSON の `name` 集合の差分が「PR 起因の新規失敗」。main に `tools/ci/` が無いため、解析は PR ブランチ側のスクリプトで行う。
各テストファイルは 106 秒超をタイムアウト管理するなら `node --test --test-timeout=106000` を付ける。

## 検証経路の設計（赤を隠さない）
`tools/ci/select-tests.js --run --baseline <json>`:
- テストは通常どおり全件/選択実行。
- **baseline にない失敗 = 新規失敗 → exit 1**。失敗を解析できない異常終了 → exit 1。
- baseline 内の失敗は `::warning::既知の赤が N 件` として毎回表示。**成功とは呼ばない**。
- baseline は「PR 上で観測した赤」であり、main 比較が済み次第 `source` を更新する。件数が減ったら baseline から削除する（`nowPassing` に出る。SELECTED 実行時は未選択分も出るので、FULL のときだけ参照する）。
- `package.json` / workflow 変更で FULL に切り替わる安全側の方針は維持。
- 軽量 job `ci-tools` は `tests/ci-*.test.js` だけを baseline なしで厳格に実行（ここは一切の赤を許さない）。
- 提案 workflow: `docs/development/proposed-workflows/pr-fast-tests.v2.yml.txt`（**未適用**、GitHub UI での適用が必要）。

## 次工程（今回は着手しない）条件と安全策
- Playwright: 別 Issue。ブラウザは `npx playwright install` の多量ダウンロードを伴うため承認制。ローカル静的サーバー限定・外部通信遮断（`browser-smoke.mjs` の既存方針）・Three.js のローカル配置とライセンス確認・`smoke-result.json` 保存・未実行は `not-run`（exit 2）。
- 並列 Claude: 同一ブランチに複数起動しない。ブランチ/Issue ごとに分離し、workflow の `concurrency` は `claude-concurrency.snippet.txt` を別承認で適用。
