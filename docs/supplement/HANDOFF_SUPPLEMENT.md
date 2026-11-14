# HANDOFF — 建物補完班（Issue #65）
- Branch: `claude/issue-65-20261114-0017`（main 1ba0275 基点）。本体HTML/配信設定/workflow は未変更。
- 成果: `tools/lib/building-supplement-diff.js`, `tools/audit/building-supplement-audit.js`, `tests/building-supplement-diff.test.js`, `docs/supplement/BUILDING_SUPPLEMENT_DESIGN.md`

## 第2段階（2026-11-14）
- 実装済み（コード）: 内周/MultiPolygon保持、厳密交差面積（格子近似廃止）、重心包含廃止、閾値近傍・数値曖昧は保留、候補同士重複、height未検証の分離（`estimated:null`）、`num_floors` 入力。
- **未検証: テストは第2段階 job で実行できていない**（`node --test`/`npm test` が権限拒否）。初版の「8テスト pass」は旧ロジックの結果で、現行コードの合否は不明。最初に `node --test tests/building-supplement-diff.test.js` を実行すること。
- 実データ比較: 未実施。住吉は `main` の git 追跡タイル（配信データ）で比較可能。北/中央は private asset repo が必要（設計書 §1b）。
- Overture 件数: 率は 北 35.7% / 中央 28.0%(1705/6081) / 住吉 28.8% に修正。**bbox座標は未記録のため現状再現不可**。
- 未計測: A〜D件数、PLATEAUとの差分、GSI/OSM取得、24区ID対応、権利整理。
- 注意: 実データは出力・コミットしていない。fixtureは実測ではない。他班には干渉していない。
