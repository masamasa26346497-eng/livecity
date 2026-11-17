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

## 第4段階: 小範囲補完パイプライン・CI/asset提案（run 43723091545）
- **権限拒否の実原因（訂正）**: `restrict_untrusted_prs`（PR作成者が write 未確認 → checkout コードを実行するコマンド拒否）。claude.yml の古さではない。無効化・別トリガー迂回はしていない。今回も `node --test ...` は拒否され **テストは未実行（合否不明）**。
- **完成したコード**: `tools/lib/supplement-pipeline.js`、`tools/supplement/build-supplement-layer.js`（既存タイル dir + 明示候補 → 新規/既存一致/保留 → 独立 manifest/タイル。既存非上書き、欠落/未収録は `no-existing-coverage` 保留、ID重複保留、座標・高さ根拠・既存ID保存、入力欠落は exit 2 の構造化エラー）、`tests/supplement-pipeline.test.js`（合成入力・**未実行**。実データの結果ではない）。
- **提案（未適用）**: `OFFLINE_CI_PROPOSAL.md` + `proposed-ci/supplement-offline-test.yml.proposed`、`ASSET_ACCESS_PROPOSAL.md`、`SUPPLEMENT_LAYER_INTEGRATION_SPEC.md`（合流先 PR #68 / 安定 #61、既定OFF・遅延・別manifest）。HTML・高速化側は未変更。
- **未取得データ**: 旧V3/V4生成物、asset repo、OSM PBF。件数（一致/追加/保留）は **未計測**。住吉の実比較は未実施。
- **必要な最小承認**: (a) owner が提案ymlを配置し SHA 指定で実行、または Bash(node) が許可される信頼状態（write権限者の起動）、(b) 取得ジョブにのみ asset 読取トークン(contents:read)。

## 第5段階: 2546694 レビュー指摘の修正（テスト未実行 / restrict_untrusted_prs により node 実行不可）
- byId 上書き: レコードと元候補を入力位置(`inputIndex`)で結付け。同一ID別形状でも判定した形状が出力される。
- 不正形状: `geometry:null, diagnostic:true` の診断レコードとして hold.json へ。クラッシュしない。
- 既存タイル: 不正fpは `degradedTiles`（件数・id最大20）/`existingStats.invalidFootprints` に記録、そのタイルは covered にせず周辺候補は `no-existing-coverage` で保留。
  manifest/tile 形式は main の住吉配信ファイルの記述で照合（manifest `tiles[{tx,tz,file,count}]`, tile `buildings[{id,fp,h,...}]`）。tile原点規則は実行時に `originMismatch` として全棟計測される（本環境では未計測）。
- 旧V3/V4: `recovered-index.json`（canonicalId/ring/levels/cls/missionId）アダプタ追加。index に元OSM height・heightSource は無く復元不能（levels*3m の推定扱い）。fixture は生成コードのキーを写した合成物。
- publishable: `licenseVerified=true` + license≠unknown + `attribution` 非空のときのみ true（CLI: `--license-verified true --attribution ...`）。
- 未取得: 旧V3/V4生成物・実OSM。実建物追加は未完了。件数は未計測（0件ではない）。
- 次の1操作: owner が `docs/supplement/proposed-ci/supplement-offline-test.yml.proposed` を `.github/workflows/supplement-offline-test.yml` に配置し、修正後SHAを入力して workflow_dispatch。

## 第6段階（独立レイヤー実装・接続案）
- 追加: `public/supplement-layer/supplement-layer.js`, `tests/supplement-layer.test.js`, `docs/supplement/proposed-integration/PR68-connection-snippet.md`（第7段階で削除・Cesium版に置換）、SPEC 追記。
- **テスト: 未実行**（node 実行は restrict_untrusted_prs で拒否される状況が継続。回避せず、この run では再試行もしていない）。CI 提案 workflow は登録済みだが実行履歴 0 件（owner 確認）＝成功扱いしない。合否不明。
- ビューア接続: **未接続**。PR#68 ブランチは本 run で未読。座標/色/高さ単位は接続時に確認（snippet 参照）。
- 実データ: **未取得**。旧 V3/V4 生成物・asset repo（過去 run で解決不可）・OSM は取得していない。この run では外部取得を試みていない（過去に拒否/不可だった経路の反復を避けた）。
- 件数: 照合数/採用数/保留数は **未計測**（0 件ではない）。実建物の追加は未完了。fixture は実在の街の建物として配信していない。
- 次の最小操作: (1) owner が supplement-offline-test workflow を現 HEAD の SHA で workflow_dispatch（`node --test` で supplement-layer / supplement-pipeline / building-supplement-diff を実行）。(2) 実データ取得は別途、読取専用の取得ジョブで（ASSET_ACCESS_PROPOSAL.md）。(3) PR#68 側で snippet を適用し座標一致を確認。

## 第7段階（Cesium アダプタ・隔離統合ページ・取得診断）
- 前提訂正: PR#68 の実ビューアは **Cesium 1.121.1**（Three ではない）。第6段階の THREE 前提 snippet は無効＝削除。前回「PR#68 未読」は fetch 未実施が原因（`git fetch origin claude/issue-67-20261114-1354` と `git show` は拒否されず成功）。PR#68 HEAD は fetch 時点 `efdced09a34cf7edbcac4e9dd78a6b4cca50f900`（並行更新中。書込みなし）。
- 追加（既存 loader は作り直さず buildMesh/group だけ差し替え）:
  - `public/supplement-layer/projection.js`: PR#68 L485-489/L1380 と同一の world(x,z)↔lon/lat。
  - `public/supplement-layer/supplement-cesium-adapter.js`: `createCesiumMeshBuilder`（PolygonHierarchy の穴・MultiPolygon=複数インスタンス・height/extrudedHeight・heightClass 別色）、`createCesiumGroup`（scene.primitives＋requestRender）、`connectSupplement`（既定OFF、moveEnd を 200ms debounce でカメラ範囲更新、disable で listener 解除/Primitive 破棄、`pickRecord`）。`allowUnpublishable` は引数に無く URL からも変えられない。
  - `public/supplement-layer/integration-preview.html`: 隔離統合ページ（データ無し。manifest 不在なら error 表示のみ。base は同一オリジン相対パスのみ）。
  - `tests/supplement-cesium-adapter.test.js`: 投影回帰（式・往復・z 北=負・PR68 HTML があれば定数照合）、穴/MultiPolygon/高さ、グループ、既定OFF通信ゼロ、範囲外は取得せず moveEnd で取得、404/unpublishable、破棄。Cesium は最小スタブ。
  - `docs/supplement/proposed-integration/PR68-connection-patch.md`: IIFE 内へ追加する最小パッチ（案・未適用）。
  - `docs/supplement/proposed-ci/supplement-offline-test.yml.proposed`: 対象を 4 テスト（diff / pipeline / layer / cesium-adapter）に更新（配置し直しではなく、登録済み workflow の `run:` 行の差し替え案）。
  - `docs/supplement/proposed-ci/supplement-asset-list.yml.proposed`: 取得診断用 read-only workflow 案（固定 repo `livecity-3d-data`・tag `plateau2025-converted`・asset 名一覧のみ、checkout なし＝PR コードを secret 付きで実行しない）。
- 取得障害の診断: main の claude.yml は action env の GH_TOKEN に `LIVECITY_3D_DATA_READ_TOKEN` を渡すが、ログは OIDC App token 使用。**これだけで secret 欠落とは断定しない**（action が GH_TOKEN を上書き／この job の環境では gh の token が App token になっている可能性）。上記 workflow の 1 回目の step が「secret が空か」、2 回目が「repo/release に到達できるか」を分けて示す。旧 V3/V4 資産の存在は **未確認**。
- **テスト: 未実行**（この run で node 実行は試していない。restrict_untrusted_prs の拒否が継続している前提で反復を避けた。新規テストの期待値は手計算＝合否不明）。
- ビューア接続: PR#68 実 HTML を読み、投影・viewer・IIFE 位置・RR 利用は確認した。**接続自体は未適用**（PR#68 書込み禁止）。ブラウザ表示は未確認。
- 実データ: 未取得。件数（照合/採用/保留）は**未計測**（0 件ではない）。建物追加は**完了していない**。
- 次の1操作（owner）: ① `.github/workflows/supplement-offline-test.yml` の `node --test` 行を proposed の行に差し替え、現 HEAD の SHA で workflow_dispatch。② `supplement-asset-list.yml.proposed` を `.github/workflows/supplement-asset-list.yml` として配置し workflow_dispatch（1回）。結果の RESULT 行を共有。
