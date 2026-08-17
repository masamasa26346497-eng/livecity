# AutoDev Run

実行日時: 2026-08-18
タスクID: P0-1
タスク名: Ward切替回帰テスト拡充

RESULT:
SUCCESS

## 調査

- AUTODEV_RULES.md / AUTODEV_BACKLOG.md / CLAUDE.md / git status を確認。作業開始時のworking treeはclean、
  ブランチは`autodev/2026-08-18`（原則ブランチ名と一致）。
- CLAUDE.mdにはWard機能の記載が無いが、実コード（`public/osaka_3d_buildings.ward-ux-v1.html`）には
  `WardModeManager`/`FullWardManager`/`getWardUXStatus`等、AUTODEV_RULES.md 5.1で言及されている実装が
  そのまま存在することを確認した（`public/osaka_3d_buildings.html`本体にはWard関連コードは無い）。
  これはCLAUDE.mdの記載漏れであり実コードとの矛盾だが、AUTODEV_RULES.md 1「実コードを正とする」に従い
  ドキュメント側を書き換える対応はせず（スコープ外）、今回追加したテストファイルの説明のみを
  CLAUDE.mdへ追記するに留めた。
- `tests/`配下に既存のWard関連テストは無かった（新規追加）。
- `WardModeManager.switchWard()` / `FullWardManager.loadFullWard()`（generation guard・failed tile
  1回retry・retry後commit abort）/ `getWardUXStatus()` / `WardBoundaryLayer`・`WardAreaFillLayer`・
  `WardLabelLayer`の`getWardUXStatus()`参照 / Ward Selectorの`dataReady`ゲーティング処理を実コードで
  確認した上でテスト設計した。Ward lifecycleの実装自体は一切変更していない。

## 変更ファイル

- `tests/ward-lifecycle.test.js`（新規）
- `AUTODEV_BACKLOG.md`（P0-1を`[x]`へ変更のみ）
- `CLAUDE.md`（テストスイート注意点セクションへ新規テストファイルの説明を追記）
- `AUTODEV_REPORT.md`（新規、本ファイル）

## 実装内容

`tests/ward-lifecycle.test.js`を新規追加。ブラウザ・Three.jsを実行できない環境のため、
`public/osaka_3d_buildings.ward-ux-v1.html`から`WardModeManager`/`FullWardManager`/
`getWardUXStatus`の関数ソースを実際にそのまま抽出し（文字列/テンプレートリテラル/コメント内の
`{}`を無視する対応ブレース検出を自前実装）、`BuildingTileLayer`等を最小モックに差し替えて
`new Function(...)`で評価・実行することで、再実装ではなく実際に配信されるコードそのものを
テストしている（既存の`tests/html-regression.test.js`の`normalizeTownName`抽出テストと同じ方式）。

テストケース（7件）:

1. `switchWard()`が住吉区・東住吉区・平野区いずれも正常に呼べ、全タイルがcommitされる
2. generation/supersededガード: 連続切替時、古い世代はsupersededとして扱われatomic commitされない
3. `FullWardManager`: 失敗タイルは1回だけ自動retryされ、成功すれば通常どおりcommitされる
4. retry後も失敗タイルが残る場合、commitが中止され旧区がdisposeされない（旧区表示維持）
5. `getWardUXStatus()`: currentWardIdと一致する区はactive、tileが残る区はwarm、それ以外はevicted
6. `WardBoundaryLayer`/`WardAreaFillLayer`/`WardLabelLayer`が`getWardUXStatus()`を参照している
   （currentWardIdへの追従経路が失われていないことの静的確認）
7. Ward Selector: `dataReady:false`区の行には`switchWard`へ繋がるクリックハンドラが設定されない
   （`if (ready) { ... }`ブロックの外でクリックハンドラが登録されていないことを静的に確認）

`npm test`のスクリプトには追加していない（`tests/lifestyle-tab.test.js`等、既存の一部テストも
`npm test`に含まれておらず個別実行する運用が既にあるため、それに合わせた。CLAUDE.mdへ実行方法を
追記済み）。

## テスト

```bash
node --test tests/ward-lifecycle.test.js
npm test
node --check tests/ward-lifecycle.test.js
git diff --check
```

## テスト結果

- `tests/ward-lifecycle.test.js`: 7 tests / 7 pass / 0 fail
- `npm test`（既存9ファイル）: 116 tests / 101 pass / 0 fail / 15 skip（既存の仕様どおり。
  `public/osaka_3d_buildings.html`本体が本リポジトリに存在しないため`html-regression.test.js`側が
  意図通り自動skipしているもので、今回の変更による新規failureではない）
- `node --check`: 構文エラーなし
- `git diff --check`: 空白関連の警告なし

## Git

branch: autodev/2026-08-18
commit: (tools/autodev.ps1側でcommit実行予定。Claude Code側ではgit操作を行っていない)
push: (tools/autodev.ps1側で判断)

## 残課題

- generation guardのテスト中に、既存コードの仕様上の細かな挙動を確認した:
  switchWardを連続で呼んだ場合（A→B）、Bの「旧区」として扱われるのはBが呼ばれた時点の
  `currentWardId`（＝Aの切替先）であり、Aが呼ばれる直前の本当の旧区ではない。Aがsupersededに
  なった場合、Aの本当の旧区（真にactiveだった区）はAからもBからも明示的にdispose/disableされない
  経路が存在しうる（AUTODEV_BACKLOG.md P0-3「superseded load cleanup調査」に関連する可能性がある）。
  今回はテストで現状の実際の挙動をそのまま保護するに留め、修正は行っていない
  （Ward lifecycle自体の変更はスコープ外のため）。P0-3着手時に調査対象とすることを推奨する。
- CLAUDE.mdにWard機能（`osaka_3d_buildings.ward-ux-v1.html`）自体の記載が無い点は、
  ドキュメントと実コードの既存の乖離として残っている（今回のスコープ外、修正するかはユーザー判断）。
- `tests/`配下には`lod2-pipeline.test.js` / `http-download.test.js` / `landuse.test.js`という、
  `npm test`にも本レポートのCLAUDE.md記載にも含まれていないテストファイルが存在することに気づいた
  （今回は触れていない、既存の状態）。

## 実機確認事項

特になし（本タスクはコードのモック評価によるテスト追加のみで、UI/描画/性能に関わる変更は行っていない）。

## ユーザー判断が必要な点

なし（本タスクの範囲内ではNEEDS_USER_DECISION相当の判断は発生しなかった）。
