# Mission 71 P0: idMismatch=167 の解明と公開前チェックリスト（公開・アップロードはしない）

## 167 件の正体
Mission70 の監査は `ids/*.json` の各タイルに対応する `attrs/*.json` が無いものを `idMismatch` に数えていた。
3D Tiles 変換は LOD 階層用に `ids/g_*.json` と `lod/g_*.glb` を作るが、LOD グループには attrs が無い（構造上正しい）。
リポジトリ内の実サンプル `public/mission37h-3dtiles/tennoji-sample` では、旧 idMismatch(1以上) == LOD グループ数 で一致（テスト済み）。
オーナーPCの 167 も「各区の lod tile 数と一致する傾向」と整合する。**ただし 24 区の実データでの確認は未実施**（再監査で確定する）。
建物 ID の書き換えは行っていない。

## 監査器の変更（`tools/mission70-audit-offline.cjs`、読み取りのみ）
- `idMismatch`: 真の不整合のみ（leaf の ids/attrs 件数不一致、leaf ids に attrs なし、attrs に ids なし、leaf 内 ID 重複、LOD の ID が leaf に存在しない）。
- `idMismatchLegacy`: 旧定義のカウント（互換用。LOD 構造差を含む）。
- `structural`: `lodGroupTiles` / `lodGroupsWithoutGlb` / `lodIdTotal` / `leafIdTotal`。
- `integrity`: `attrsWithoutIds` / `duplicateLeafIds` / `lodIdsNotInLeaves`。
- `schema` 文字列は変更していない（既存キーは残し、キーを追加しただけ）。

## オーナーPCでの再監査（読み取りのみ）
```powershell
node tools\mission70-audit-offline.cjs --src "<legacy buildings dir>" --out-root "<45D root>" --json
```
見る値: `totals.idMismatch`（0 が期待）、`totals.idMismatchLegacy`（約167）、`totals.lodGroupTiles`（167 と一致するか）、`totals.lodGroupsWithoutGlb`、`totals.duplicateLeafIds`、`totals.lodIdsNotInLeaves`。
`idMismatch` が 0 でなければ真の不整合なので、`wardsAnonymous[n].integrity` で区を特定する。

## 人手ゲート（自動で true にしない）
`licenceApproved` / `noSecretsReviewed` / `noPersonalDataReviewed` は監査器・アップロードゲートとも false 固定。以下を人が確認して初めて承認できる。

PLATEAU 許諾チェックリスト（いずれも未確認。許諾済みと推定しない）:
- [ ] 提供元（国土交通省 Project PLATEAU、G空間情報センター 大阪市 2024）の公式利用規約の URL と取得日を記録
- [ ] 適用ライセンス名（例: 政府標準利用規約2.0 / CC BY 4.0 互換かどうか）を一次資料で確認
- [ ] 加工物（LOD1 を GLB/3D Tiles に変換）の再配布が可能か
- [ ] 掲載すべきクレジット文言を確定（現状の暫定: 「出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2024）を加工して作成」）
- [ ] 各区の `source.json` に license 情報を追加（現状 `noLicenceInfo=24`）
- [ ] 非公開（認証付き）配信でも利用条件を満たすか
- [ ] 秘密情報・個人情報（パス、ユーザー名、属性値）が成果物に無いことの人手レビュー（自動検査 secretHits=0 は補助）

## 構成方針（実装済みは契約とゲートのみ。ストレージ作成・アップロードなし）
認証付き Vercel Preview + private R2 + 認可プロキシ。認可は SSO のみに依存せず、`mission70-cloud-contract.cjs` の fail-closed ハンドラ（既定 OFF、authz 無し/false で拒否、署名付き manifest、path 検証）で二重化する。3D 建物のみ。

## 未完了工程（URL で見るまで）
1. オーナーPCで再監査し idMismatch=0 を確認
2. PLATEAU 許諾の人手確認と source.json への反映
3. 人手ゲート3件の承認（人が `upload-gate` の設定に記入）
4. R2 バケット作成・費用上限決定（要承認、未実施）
5. 認可プロキシ実装・デプロイ（未実施）
6. 24 区の HTTP 200 とブラウザ描画の検証（**未検証**）
