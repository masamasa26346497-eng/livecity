# Mission 45G: 全域3Dの高速化（実 PC での計測は未実施）

対象は localhost の `?ext45=1`（45E の読み取り専用サーバー）だけ。公開ページ（Vercel）の既定挙動は変えていない。

## 入れたもの
| 項目 | 内容 | 無効化 |
|---|---|---|
| requestRenderMode | ext45 で既定 ON。静止中は描画しない。tile 読み込み中は 250ms ごと、静止中は 2 秒ごとに 1 回描画を要求（POI/ラベルの取りこぼし対策）。カメラ移動・各 UI 変更は従来の `scene.requestRender()` | `?rr=0` |
| 解像度の自動調整 | 動作中の平均が 40ms を超えたら 0.1 刻みで 0.6 まで下げ、止まって 20 フレームで 1.0 に戻す（クールダウン 45 フレーム）。Cesium 既定の「DPR を無視した 1 倍」は変えない | `?res=fixed` / 高 DPI で鮮明にするなら `?dpr=1` |
| キャッシュ予算 | 全 tileset の合計 768MB（既定は tileset ごとに 512MB+overflow）。1 つあたり最低 64MB、overflow 64MB | `?cache=0` / `?cacheMB=<合計>` |
| 画面外 coarse の抑制 | 斜め視点で、画面の水平 fov 外にある遠い区の粗 LOD は mount しない（detail は対象外、真下視点は対象外） | `?cull=0` |
| 計測 | `window.__mission45g.snapshot()`、`?perf=1` で左下に表示。描画 FPS/p95、可視 tile、tileset 数、`totalMemoryUsageInBytes` 合計、mount/drop/culled、DPR・解像度、通信の件数とバイト、移動後に安定するまでの ms | — |
| 遠景 LOD0 | `tools/mission45g-build-lod0.cjs`（オフライン・決定的）。下記 | `?lod0=0` |

## 遠景 LOD0（オーナーが明示的に実行したときだけ）
- 入力: 45D 出力の `attrs/` と `source.json` だけ（読み取り）。45D ルートの「中」には作らない（45D の許可名ルールを壊すため）。
- 出力: 別フォルダ（リポジトリ外・OneDrive 外・入力の外）。マーカー `.livecity-45g-lod0.json` 付き。
- 中身: 200m セルごとの平均高さの角柱（概略ブロック）。**実棟ではない**。ID は `lod0_*` で canonicalId ではない。棟数が 2 未満のセルは出さない。高さ 400m 超の欠損値は平均に入れない。
- 表示: 45F が mount していない区の間だけ表示。近づいて detail / coarse が mount されると隠れ、正確な建物に置き換わる。
- LOD0 がなくても 45F の機能は変わらない。

```powershell
# 計画のみ（何も書かない）
node tools\mission45g-build-lod0.cjs --src "$env:LOCALAPPDATA\LiveCity-3DTiles-Out-24" --plan
# 生成（owner 承認後）。出力は 45D ルートとは別
node tools\mission45g-build-lod0.cjs --src "$env:LOCALAPPDATA\LiveCity-3DTiles-Out-24" --out "$env:LOCALAPPDATA\LiveCity-3DTiles-LOD0-24"
# 起動（既存の 45E に --lod0 を足す）
node tools\mission45e-preview.cjs --src <legacy buildings> --out-root "$env:LOCALAPPDATA\LiveCity-3DTiles-Out-24" --lod0 "$env:LOCALAPPDATA\LiveCity-3DTiles-LOD0-24" --serve
```

## A/B の取り方
同じ視点で `?ext45=1&perf=1&rr=0&res=fixed&cache=0&cull=0&lod0=0`（従来相当）と `?ext45=1&perf=1`（45G）を比べる。
静止 10 秒間の `renders`（描画回数）、移動中の p95、`tilesetMemoryMB`、`net`、`settleMs` を見る。
