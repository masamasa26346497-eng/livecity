# AutoDev Run

実行日時: 2026-08-23
タスクID: P0-2
タスク名: WARM / picking問題の調査

RESULT:
SUCCESS

## 調査結果
- loaded-hidden / WARM状態の建物meshはvisible=falseになってもbMesh配列に残る。
- pickHit()は従来raycast結果のhits[0]を無条件に採用していた。
- 非表示meshが手前にある場合、画面上のvisibleな建物より先に選択される可能性を確認した。
- Ward lifecycle全体の変更は不要で、pickHit()の局所修正で対処可能と判断した。

## 変更
- public/osaka_3d_buildings.ward-ux-v1.html: visible=falseのhitを除外し、最初のvisible hitのみ採用。
- tests/picking-visibility.test.js: picking回帰テスト4件を追加。
- AUTODEV_BACKLOG.md: P0-2を完了[x]へ更新。
- AUTODEV_REPORT.md: 本レポートへ更新。
- CLAUDE.mdのタスク外変更は手動で破棄済み。

## テスト結果
- node --test tests/picking-visibility.test.js: 4 pass / 0 fail
- npm test: 116 tests / 101 pass / 0 fail / 15 skip
- 既存15 skipは既存仕様によるもの。

## AutoDev実行
- stream-json、stdin EOF、リアルタイム進捗、callback scope、result受信、process終了はいずれも正常。
- MaxTurns=24と40の双方でClaudeがmax_turnsに到達したためwrapperは自動commitしなかった。
- P0-2成果自体は手動検証済み。

## 残課題
- AutoDevが受入条件達成後も調査を続けてmax_turnsへ到達するため、早期終了指示の改善が必要。
- 次のBacklogはP0-3 superseded load cleanup調査。

## 実機確認
- 区切替後、非表示旧区の建物がhover/click対象にならないことをブラウザでも確認する。
