# Mission 95: 西区 Private 保存（owner 手動起動 workflow）

## 状態（正直な区別）
- **Mission94 の接続成功は未確定**: 「緑チェック」の報告のみ。Claude からは main 上の Actions 実行ログを取得できなかった（`gh` 不許可、CI ツールは PR 分のみ）。`OK: private connection verified (read-only)` + `visibility=private` + `token_push=true` の3点がログに揃うまで接続成功とは扱わない。skipped job は緑に見えるので、job が `check` の steps まで実行されたか確認すること。
- **実保存: 0 / 24**。西区の変換・upload は未実行（Claude は workflow も secret も実行できない）。
- **ライセンス**: `data/reports/mission79/source-lock.json` に 27100 大阪市 2025 CityGML の CKAN 記載（PLATEAU Site Policy「3. 著作権」、商用可、出典表示）が記録済み。ただしこの環境では公式ページを再取得しておらず、CKAN 記載の転記にとどまる。2025 大阪・関西万博 27999 は商用禁止のため `inspectOut` と `strictOk` が拒否する。出典: 「出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5）を加工して作成」。
- Releases の上限（1 asset 2GiB 未満）は owner 指示の公式 Docs 記載に依拠。Actions 枠・Private repo 条件は未確認。

## 変更
- `tools/mission87-persist.mjs`: 再開判定を **サイズ一致 → 再取得した実体の sha256 一致** に変更。
- `tools/mission95-persist-ward.mjs`: pack → upload(--repo, private 必須) → verify(再取得 sha256) を同期実行。`--allow-public` 拒否。
- `tools/mission95-check-output.mjs`: 27999 / 2025 以外 / ID 重複 / skipped を拒否。
- `tools/mission95/persist-ward.workflow.yml`: owner 手動起動の完全な workflow（変換 step には token を渡さず、token は connect と persist の2 step のみ）。
- `tests/mission95-persist.test.cjs`。

## owner の設置・実行
1. `tools/mission95/persist-ward.workflow.yml` を `.github/workflows/mission95-persist-ward.yml` として **main に**コピー（workflow のみの変更）。GitHub UI: Add file → Create new file。
2. Secrets に `LIVECITY_3D_DATA_TOKEN`（`livecity-3d-data` 限定 fine-grained PAT、Contents: write）。
3. Actions > Mission95 > Run workflow（ward=nishi）。
4. ログで connect の3点、strict check、`verified:true` と sha256 を確認。`mission87 status` が `stored 1 / 24` になれば成功。
