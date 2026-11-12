# Mission 45Q: 45O 診断画面の確認支援・位置ずれ切り分け・操作性 A/B

**状態: 未完了。** headless Chrome（Linux, fixture）での自動検証のみ。Windows 実機での改善は未証明。

## 変更
- `public/mission45o-align-diag.html`: `diag.json` を検査してから読む（壊れた JSON / 形違いは画面に理由を出し、状態を変えない）。出所（建物タイルの更新日範囲、道路 manifest の生成日・更新日）を表示。**視差の目安**（高さ × tan(鉛直からの傾き)）の計算欄を追加。外部送信コードなし。`window.__diag45` はテスト用（状態読み取りのみ）。
- `tools/mission45o-footprint-vs-road.cjs --dump`: `meta.source` に `buildingsMtime` / `roadsManifestMtime`（日付の範囲のみ。座標・ID なし）。ファイル更新日は生成の目安で、測量日・撮影日ではない。
- `public/mission45p-areacull.js` + 37G: A/B スイッチ `?vcdefer=1`（操作中は面ユニットの破棄も見送り、止まってから破棄）。**既定は従来どおり。効果は未測定。**
- `tools/experiments/mission45q_diag_ui_e2e.mjs`: 2 ペイン・読み込み・赤/青の実描画・ピン・リサイズ・GSI 既定 OFF・外部通信 0・JS 例外 0 を fixture で検証。

## 位置ずれの切り分け（この画面で分けられるもの）
| 疑い | 見る場所 |
|---|---|
| 元データ同士（footprint と OSM 道路）の差 | 赤と青の相対位置。複数地点で向きが揃うか（ピン） |
| 地理院ラスタ側の差 | GSI を ON にして GSI オフセットだけ動かす。赤・青は動かない |
| 高さ・カメラ視差 | 視差計算欄。3D の屋根は高さ×tan(傾き)だけずれて見える。真上（pitch -90°）で A/B |
| 出所・時期の差 | 情報欄の mtime（生成日の目安） |
既知の対応点なしに shift / yaw は適用しない。

## 実機で追加で見てほしい（スクリーンショット 3〜4 枚）
大きな交差点、鉄道駅の高架、大型建物の角、橋の 4 地点。各地点で Cesium（`?basemap=none`、真上）と 2D 診断画面の同地点を並べて撮る。座標・ID・diag.json は共有不要。

## Windows PowerShell 手順
```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
# 新規フォルダ名を使う（既存出力先は上書き拒否）
$d = "$env:LOCALAPPDATA\LiveCity-diag\fukushima-$(Get-Date -Format yyyyMMdd-HHmmss)"
node tools\mission45o-footprint-vs-road.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --ward fukushima --dump $d
node tools\mission45e-preview.cjs
```
表示された `http://127.0.0.1:<port>/mission45o-align-diag.html` を開き、「ファイルを選択」で `$d\diag.json` を選ぶ。
3D 側のプレビューは 45E/45C の既存手順（`-LayersRoot` は 45E の README の値を使う。本ブランチで変更していない）。

## 3 条件ベンチ（同一地点・同一操作）
`...mission37g-osaka-24ward-mvp.html?ext45=1&perf=1&rr=0&res=fixed` で、同じ視点・同じドラッグ/ホイール操作を各 10 秒:
①「建物 ON / 道路/面 ON」 ②「建物 OFF」 ③「道路/面 OFF」。それぞれ「10秒測定」。最後に「結果を1行表示」。
追加 A/B: 同条件に `&vcdefer=1`、`&vcull=0`。
共有してよい匿名集計: `__mission45n.summary()` の 1 行（gestureP95, over50, longTasks, heapMB, hint）と `vec45p` の数値のみ。

## 未検証
Windows 実 Chrome での 45O 画面、`vcdefer` の効果、p95 の主因（建物 / ベクタ / 面 / streaming）。操作性の「解決」は主張しない。
