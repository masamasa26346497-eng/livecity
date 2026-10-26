# Mission 45D — 24 区ローカル 3D Tiles 一括変換オーケストレーター（コードのみ。実 PC データは未変換）

**この環境（GitHub runner）は Windows PC の旧建物データに触れていない。実 24 区の変換は実行していない。** 合成 24 区 fixture と
Git 追跡済みの住吉区 52 tile（35,031 棟）の再構築でのみ検証した。PowerShell 5.1 / OneDrive 上の挙動は実機未検証。

## 追加
- `tools/mission45d-convert-all.cjs`: 既存 43F（PC-only 23 区）/ 43D（Git 追跡の住吉）/ 43G（再検証）を束ねる。新規変換ロジックなし。
- `tools/mission45d-convert-all.ps1`（ASCII / PS5.1）: `plan`（既定・読み取りのみ）/ `convert`（`-Execute -Approved` 両方必須）/ `verify`。
- `tests/mission45d-convert-all.test.cjs`（9 件）。

## 動作
1. 同一実行でソースを audit し、`auditReady` が true でなければ何も作らず中止。総棟数は **実行時の audit** から取り、定数に依存しない。
2. 出力 root は repo / public / ソースの外、新規か空、または 45D の marker 付きで自ツールのエントリだけを含む場合のみ。
   リンク / junction / 無関係ファイルは拒否。上書き・削除なし（コードに削除 API なし）。
3. 住吉 → 43D rebuild + 37B 9 tile 回帰（GLB/ids/leaf 統計が全一致）。続いて PC 23 区 → 43F が区ごとに変換→**即検証**し、最初の失敗で停止。
4. 全区を 43G でディスクから再検証。住吉も PC ソースの canonicalId 集合と一致を確認（Git と PC のデータ差も検出）。
5. 完了判定: `convertedWards = verifiedWards = 24`、`convertedBuildings = sourceBuildings`（audit）、`failures = 0` のみ `complete: true`。
   `completion.json` に匿名集計（区数・棟数・状態のみ）を保存。ID 区間衝突（262 想定）は警告のみ。ID の書換・削除なし。高さ sentinel は 40E のまま。
6. 中断後の再実行: 検証済みの区は再変換しない。失敗・中断した区は新しい attempt ディレクトリで再試行（既存は触らない）。

## Windows 3 ステップ（リポジトリのルート）
```powershell
# 1) dry-run（何も作らない）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45d-convert-all.ps1
# 2) 承認後のみ: 別フォルダ ..\livecity-3dtiles-out-24 へローカル変換（アップロードなし）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45d-convert-all.ps1 -Step convert -Execute -Approved
# 3) 読み取り専用の再検証
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45d-convert-all.ps1 -Step verify
```
`complete` は**ローカル変換の完了**のみ。ブラウザでの 24 区表示・公開許可とは別（ゲートは false のまま）。表示確認は 45C の `-Step preview`（区ごと）。
容量は約 1.16KB/棟 × 総棟数の概算（数百 MB）。出力は Git / Vercel / Artifacts に入れない。
