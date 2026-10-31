# Mission 44A — 3D 建物の「画面表示」確認（Cesium 37G ビューア）

## 結論（この環境の実 Chrome / headless で確認）
Git 追跡済みの実データ 6 区（住吉・北・中央・天王寺・西・浪速。**いずれも区の一部**）で、区を選ぶと建物が画面に描画されることを、
「建物なし/ありの同一カメラ画像の画素差分」で確認した。24 区中 18 区は Git に 3D が無く「3D未整備」。PC のみにある 23 区の変換は未実施。

## 再現手順（ワンコマンド）
```bash
node tools/experiments/mission44a_render_e2e.mjs            # 6 区の描画 E2E（Chrome + CesiumJS CDN が必要）
node tools/experiments/mission44a_ext_e2e.mjs               # 43F→43G→?ext= の配線 E2E（合成 fixture。実データではない）
MISSION44A_E2E=1 node --test tests/mission44a-render-e2e.test.cjs   # 上の 2 本をまとめて（既定は静的チェックのみ）
```
- 各区: 区選択前に建物なしで撮影 → 左パネルのセレクトで区を選ぶ → tileset.json / GLB が HTTP 200 → `Cesium3DTileset` が primitives に 1 本以上 → `tilesLoaded` →
  カメラが建物範囲へ寄っている → 同じカメラで撮影 → 画素差分 1% 以上、を全て満たすと pass。
- 画像は保存しない（`--shots` を付けたときだけ gitignore 済みの `temp/mission44a/`）。公開・upload・artifact 化はしない。
- 前提: Chrome / Chromium、`cdn.jsdelivr.net` への接続（CesiumJS は CDN から読む）。WebGL は headless のソフトウェア描画で動く。接続できない環境では起動に失敗し、原因を出力して終了コード 1 になる。
  背景地図（国土地理院）が取れなくても建物の描画判定には影響しない。headless は日本語フォントが無いため文字が豆腐になる。FPS は実機値ではない。

## ビューアの変更（最小）
- 区一覧・「3D建物の区」セレクト・検索で区を選び、3D が mount できたら、**建物データのある範囲（tileset の境界球）へ自動で寄る**（ピッチ -45°）。従来は区全体の俯瞰で、一部メッシュだけの 3D が小さく見えた。
- 状態表示は従来どおり（読込中 / 表示中 / 3D未整備 / 失敗）。区のリストに「3D一部」「3D未整備」を明記。24 区すべてに建物があるようには見せない。
- QA 専用フック `cameraVsTilesets()`（localhost かつ `?qa=1` のみ。読み取り専用）を追加。

## PC のみの 23 区を表示するまでの最短導線（実データ変換は PC 側。未実施）
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission43f-convert.ps1 -LegacyBuildings "<旧 buildings>" -OutRoot "<リポジトリ外の新規フォルダ>" -Wards fukushima -Execute
node tools\mission43g-local-preview.cjs --out-root "<同上>" --serve
# 表示された http://127.0.0.1:<port>/mission37g-osaka-24ward-mvp.html?ext=fukushima を開き、左パネルで福島区を選ぶ
```
（引数名は `tools\mission43f-convert.ps1` / `MISSION43_README.md` の記載に合わせること。実行前に必ず plan（既定）で確認する。）
- 43G は 43F 出力のうち検証に通った区だけを 127.0.0.1 で配信する。ビューアは `source.json.wardCode` で区コードと結び付ける。合成 fixture の E2E で、この配線と「verified 以外の区は mount されない」ことを確認済み。

## 公開・安全
- main / Production / Vercel 変更なし。Google・有料 API 通信 0（E2E で計測）。新規の第三者 3D データの追加なし。ライセンス・PII・secret の安全ゲートは false のまま（公開しない）。
