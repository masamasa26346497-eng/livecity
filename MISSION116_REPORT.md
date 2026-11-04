# Mission 116 — 24区 建物＋河川 統合表示（実装・検証ツール）

状態: **実装済み（検証ツール・パス解決・失敗診断・回帰テスト）／ローカル実データでの実描画は未検証**

## 前提の整理（既存実装の特定結果）
- ビューアは既存の `public/osaka_3d_buildings.ward-ux-v1.html`（`npm run preview` の既定）。`WardModeManager.WARD_DEFS` に24区が定義済み（`dataReady:true`）。区の切替で `BuildingTileLayer`（建物）と `CityTileLayer`（waterways/roads/parks/railways）が**選択区のbboxを覆うタイルだけ**を段階ロードする（P1-6E）。HTMLは今回変更していない（座標系・回転・高さ基準を壊さないため）。
- 配信パス規約（HTMLと同一。`tools/lib/ward-layer-plan.js` の `urls`）:
  - 建物: `map-data/osaka-city/buildings/manifest.json` → `{datasetId}/manifest.json` → `{datasetId}/tile_{tx}_{tz}.json`（500m）
  - 都市レイヤー: `map-data/osaka-city/{waterways,roads,parks,railways}/manifest.json` と `tile_{tx}_{tz}.json`（**flat配置**、2000m）
  - 河川V2: `rivers-v2/rivers.json` / 海面: `water-surface/water-surface.json`
- 座標系: `znorth-neg-v1`（原点 34.604208/135.52502、+X東・−Z北）。区ごとの原点・オフセット・建物だけの平行移動は禁止。本ツールは**検出のみ**で補正しない。
- GitHub上のリポジトリにある実タイルは住吉区のみ。他23区の建物・全区の河川/水域はWindowsローカルにのみ存在する想定。

## 追加したもの
| ファイル | 内容 |
|---|---|
| `tools/lib/ward-layer-plan.js` | 区→読み込みURL計画、失敗診断コード（missing-file / invalid-json / wrong-dir / convention-mismatch / count-mismatch / out-of-ward）、水域の線/面区別、区ポリゴン内率・地表高さ・建物×水面の整合検査 |
| `tools/verify-ward-layers.js` | 24区（または `--ward` 指定）の検査CLI。`--http` で127.0.0.1に静的サーバーを立てHTTP 200確認。`data/reports/mission116/ward-layer-verification.{json,md}` を出力 |
| `tests/mission116-ward-layers.test.js` | 11件。24区の計画、区選択の分離、全区boundsと区ポリゴンの整合、投影原点/北=−Z固定（回転0°）、住吉区実タイルの区内率≥99%・z0≈0、60m平行移動/回転の検出感度、HTMLの描画高さ(水0.04/0.05 < 道路0.13)とURL規約の一致、河川の線/面fixtureと診断 |
| `package.json` | `verify:wards`, `verify:wards:http`、`npm test` に新テスト追加 |

## 実行結果（この環境 = GitHub Actions、実データは住吉区のみ）
- 新テスト 11/11 pass。`node tools/verify-ward-layers.js --http` は24区を検査し、**ローカルデータ完備 0/24**（住吉区は建物のみOK・区内率100%・地表高OK、河川/水域ファイルはリポジトリに無い）。
- 既存テストの失敗（今回の変更と無関係・データ不在による）: `canonical-spatial-alignment`/`coordinate-system-authority`（`data/processed/.../canonical` 不在）、`ward-tile-coverage` 実データ（建物タイル不足）、`runtime-visible-layer-alignment` 動的（overlay不在）。`html-regression` は標準パスのHTML不在でskip。
- WebGL/実ブラウザ描画、FPS、ON/OFF、画像確認は**未実施**。どの区も「描画成功」とは報告しない（`browserVerified` は常に false）。

## ローカル（Windows PowerShell）で必要な作業 — 最小
実データのある作業ツリーのルートで:
```powershell
node tools/verify-ward-layers.js --http                                  # 24区の在庫・整合・HTTP200。結果は data\reports\mission116\ward-layer-verification.md
node tools/verify-ward-layers.js --ward fukushima,sumiyoshi,nishi --http --strict   # 最低限3区 (完備でなければ終了コード1)
node tools/preview.js --port 8000                                        # → http://localhost:8000/osaka_3d_buildings.ward-ux-v1.html
```
期待結果: 福島区は 建物=OK・waterways=OK・水域種別=`polygon+line`（`line-only` なら水面ポリゴン欠落）・区内率≥90%（実際は住吉区で100%）・HTTP200 全件。`なし(wrong-dir)` と出たら河川タイルが `tiles/` 配下にあるので、`{layer}/` 直下へ配置（`tools/build-city-layer-tiles.js --public`）。`out-of-ward` が出たら座標のずれ—**建物の平行移動で直さず**、変換を再生成。
出力された `ward-layer-verification.md` をIssueへ貼ってください。その結果を元に、実ブラウザでの位置整合・FPS・ON/OFFの検証へ進みます。
公開URLは作成していません（ライセンス・個人情報・秘密情報・再配布ゲート未承認）。
