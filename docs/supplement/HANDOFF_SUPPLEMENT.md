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

## 第3段階: 旧OSM補完資産（V2/V3/V4）の所在（2026-11-14、コード読取のみ・未実行）
**実行制約:** run 43595159701 では `node --test tests/building-supplement-diff.test.js` が権限拒否（回避せず）。新幾何ロジックは引き続き未検証。既存CI経路は未確認（`.github/workflows` は bot から読取/変更不可と認識。要確認）。

| 項目 | 状態 | 所在 |
|---|---|---|
| 補完コード V2 | 再利用可能（コード） | `tools/build-osm-fallback-v2.js`, `tools/lib/osm-fallback-v2-classify.js`, `tools/lib/osm-building-fallback.js` |
| 補完コード V3 (Mission34C) | 再利用可能（コード） | `tools/build-osm-fallback-v3.js`、入力は `tools/audit/building-coverage-citywide.js` が出す `data/processed/osaka-city/osm-fallback-v3/missing-candidates.json` |
| 補完コード V4 (Mission35D) | 再利用可能（コード）。V3の後継 | `tools/build-final-buildings-v4.js`、入力 `data/processed/osaka-city/missing-recovery-v4/candidates.json`（`tools/audit/citywide-missing-buildings.js`） |
| 生成済み canonical/derived/report | **git に無い（欠落）**。`data/processed/osaka-city/` は boundaries/facilities のみ、`public/map-data/osaka-city/` に `derived-v2-osmv3` / `derived-v4-final` 無し、`data/reports/osm-fallback-v3-build.json` 無し | 過去実行環境（ローカルPC/asset repo）にある可能性。未確認 |
| 取得済みOSM PBF | git に無い | `tools/import/osm-pbf-city.js` で再取得が必要（要ネットワーク） |
| 表示側接続 | **既に本体HTMLにある** | `public/osaka_3d_buildings.html` L14307 `derived-v2-osmv3/recovered-index.json`、L14395 `derived-v4-final/recovered-index.json`、L18298-18307 namespace切替（V2N/V3/V4）。データが無ければ読込失敗＝現行未接続の理由 |
| 過去報告値 | 履歴の手掛かりのみ | MISSION34C_REPORT.md: V3回収 13,829棟（600,764→614,593、60m頭打ち解除31棟）。「V2 NEW 26,652」は本リポで裏付け未確認。現行追加可能数ではない |

### 再利用方針
- 既存の V3/V4 を丸ごと再実装しない。**現行PLATEAU footprint**（住吉は `public/map-data/osaka-city/buildings/osaka-sumiyoshi/` のgit追跡タイル）で再照合する。旧採用セットを無条件追加しない。
- 旧コードの注意点: (1) `MAX_FALLBACK_HEIGHT_M=60` と `building:levels×LEVEL_HEIGHT_M` の換算高さが `actualHeight`/`heightUnknown:false` になる（実測と混同）→ 本PRの `estimated:null`/measured分離に合わせて別フィールド化する。(2) 面積重なり判定（`measureOverlap`/`classifyOverlap`）はグリッド近似ベース → 閾値近傍は本PRの厳密判定へ。(3) `dedupeRecovered` は score 先勝ち（名前>階数>面積）で曖昧重複を落とす→ 本PRの `candidate-duplicate` 保留に寄せる。
- 最小接続案: 候補JSON生成だけ本PRの厳密diffに差し替え、`recoveredFeature`/`derived` ビルドと HTML の `recovered-index.json` 読込（L14307/14395）は既存を使う。HTMLは未変更（道路河川・高速化・クリックの巻き戻し回避）。
- 統合対象ブランチ/SHA: Issue #64 最新履歴は未取得のため**未確定**（PR #61 head `b56e979`、PR #63 head `95057a5` が候補）。

### 未解決
テスト実行、V3/V4生成物の所在確認、住吉でのOSM照合（OSM取得にネットワーク要）、Issue #64の統合SHA確定、独立Draft PRでの接続試作（未着手）。件数: 既存一致/追加候補/保留はすべて **未計測**（0件ではない）。
