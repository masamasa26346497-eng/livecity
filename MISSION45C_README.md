# Mission 45C — PC-only 23 区を安全にローカル表示する導線（コードと手順のみ。実 PC データは未変換）

**24 区の完成ではない。** 部分表示 6 区 / 全域完成 0 / 未表示 18 区（Git に 3D がない区）。23 区の元建物データは Windows PC にだけあり、
この環境・GitHub・Vercel からは触れていない。実データの変換・アップロード・公開はしていない（ライセンス / secret / 個人情報ゲートは false、`uploadAllowed: 0`）。

## 追加したもの（新規ファイルのみ。43F/43G/44A の既存機能は変更なし）
- `tools/mission45c-coverage.cjs`（read-only）: 区ごとに **source（旧タイルの canonicalId 数）/ converted（43F 出力の ids）/ rendered（ブラウザが mount した棟数）** を突合。
  件数と真偽値だけを出力（パス・ID なし）。`--kind` は既定 `synthetic`。45B の evidence スキーマ互換の行を出すが、`real` を自称しない。
  45B ツール本体は main 由来の別ブランチにあるため取り込まず、スキーマ（`livecity.mission45b.ward-evidence/1`）の形だけ合わせた。
- `tools/mission45c-ward-flow.ps1`（ASCII、PowerShell 5.1）: plan / convert / verify / preview を 1 ファイルに統合。既定は **福島区の dry-run のみ**。
  `convert` は `-Execute` と `-Approved` の両方が必要。出力先の既定は repo 外 `..\livecity-3dtiles-out`（43F が既存ファイルの上書き・削除を拒否）。
- `tools/experiments/mission44a_ext_e2e.mjs`: 末尾に 45C の coverage（converted と rendered が full）を追加。

## オーナー手順（リポジトリのルートで 3 コマンド。1 と 2 の間に承認が必要）
```powershell
# 1) 福島区 dry-run（読み取りのみ。何も作らない）。既定の LegacyBuildings = ..\livecity-data-pipeline\public\map-data\osaka-city\buildings
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45c-ward-flow.ps1
# 2) 承認後のみ: 別フォルダへローカル変換 + 43G 検証
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45c-ward-flow.ps1 -Step convert -Execute -Approved
# 3) 127.0.0.1 限定プレビュー → 表示された URL (?ext=fukushima) を開き、左パネルで福島区を選ぶ
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45c-ward-flow.ps1 -Step preview
```
- 追加検証: `-Step verify`（43G 再検証 + coverage。出力は件数のみ）。他の区は `-Wards a,b`（段階的に。23 区一括は避ける）。
- 東淀川（高さ sentinel）と ID 衝突区（阿倍野・住之江・住吉・東住吉・西成）は 40D/40E の方針（複合キー・仮高さ表示）。
- ソースが見つからないとき、wrapper は探したパスを表示して停止する（何も作らない）。

## 検証（この環境、2026-10-26）
- `node --test tests/mission45c-coverage.test.cjs`（新規 6 件）+ 44A / 43F / 43G の既存テスト: 42 件中 41 pass、1 skip（opt-in の E2E）、fail 0。
- 実 Chrome（headless）E2E `mission44a_ext_e2e.mjs`: 合成の未整備区（miyakojima）を 43F で変換 → 43G で検証・配信 → ビューアで mount。
  tileset/GLB 200、画素差分 52%、coverage source=6 / converted=6 / rendered=6（full）、他区選択で解放、JS 例外 0、Google 通信 0、404 なし。**合成データであり実データの証明ではない。**
- Git 追跡の住吉: 9 tile 3D Tiles は source 35,031 棟/52 tile に対し converted 10,546 棟/9 tile = **partial**、source にない ID は 0。
- 実 PC データでの coverage、PowerShell 5.1 での実行、実機の FPS は未検証。
