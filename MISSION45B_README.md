# Mission 45B — 24区 受入マトリクスと PC 実データ検証の経路

**24区の完了ではない。** 実建物データの取得・変換・アップロード・公開は一切していない。ライセンス / secret / 個人情報ゲートは false のまま。
PC-only の 23 区は未変換。実 ZIP・OneDrive・ユーザー PC にはアクセスしていない。

## 追加物（すべて新規ファイル。PR #24 / Mission 45A のファイルは編集していない）
- `tools/mission45b-acceptance-matrix.cjs` — 24区の受入マトリクス（read-only、パス/ID/PII を出力しない）。未達なら終了コード 1。
- `config/mission45b-ward-source-counts.json` — 区コード別 source 棟数 / tile 数 / Git 追跡 3D 棟数（45A 棚卸しの転記。再測定値ではない）。
- `tests/mission45b-acceptance-matrix.test.cjs` — 12 件。

## 受入の定義
区が `accepted` になる条件は、証拠種別 `real` で次の全てを満たすこと:
`realSourceVerified` / `http200` / `webglPixelsChanged` / `clickedBuildingIdVerified` / `coverage=full`（変換棟数・tile 数が source と一致）/ 同時常駐区数 ≤ 2。
`complete24` は 24 区すべて accepted のときだけ true。合成 fixture・Git 追跡の部分メッシュ・静的テストは `accepted` に数えない。
不正な証拠（ゲートを true にする、upload/publish を主張する、不明な区、型不正）は文書ごと棄却する。

## 証拠ファイル（PC 側で作成、Git に入れない）
```json
{ "schema": "livecity.mission45b.ward-evidence/1",
  "wards": [ { "code": "27103", "kind": "real", "realSourceVerified": true, "http200": true,
               "webglPixelsChanged": true, "clickedBuildingIdVerified": true,
               "convertedBuildings": 11159, "convertedTiles": 25, "peakResidentWards": 1 } ] }
```
値は真偽 / 整数のみ。パスや建物 ID は入れない。

## 所有者が PC で行う最小手順（今回は未実行・承認後）
1. `tools\mission43e-audit.ps1`（読み取りのみ）で旧 `buildings` の件数監査。
2. `tools\mission43f-convert.ps1 -LegacyBuildings "<旧 buildings>" -OutRoot "<リポジトリ外の新規フォルダ>" -Wards fukushima`（既定 dry-run。承認後に `-Execute`）。ZIP を使う場合は建物ディレクトリだけを所有者が選別して展開する。
3. `node tools\mission43g-verify-local.cjs --out-root "<新規フォルダ>" --src "<旧 buildings>"`（read-only 検証）。
4. `node tools\mission43g-local-preview.cjs --out-root "<新規フォルダ>" --serve`（127.0.0.1 限定）→ ブラウザで `?ext=<ward>` を選択し、HTTP 200・画素差分・建物クリックを区ごとに確認。
5. 結果から上記の証拠ファイルを作り `node tools/mission45b-acceptance-matrix.cjs --evidence <file>` で判定。
4 区群（東淀川=高さ sentinel、阿倍野/住之江/東住吉/西成=ID 衝突）は 40D/40E の方針を確認してから変換する。

## 未実装 / 制約
- 43F/43G/44A のツールは PR #24 ブランチにのみ存在する（この独立ブランチには無い）。そのため PC 実データ用の E2E ランナー（44A の `--ext-root` 対応）は、45A と競合しないよう PR #24 のマージ後に別途追加する。証拠ファイルの自動生成は未実装。
- 同時常駐区数は証拠の自己申告値（`peakResidentWards`）であり、本ツールは測定しない。
