# Mission 45O: 位置ずれの切り分け（建物 footprint ↔ 道路）と診断画面

## オーナー PC の実測（記録）
`mission45m-verify-glb-geometry --out-root ... --ward fukushima --sample 5`（45D 福島区、read-only）:
tilesChecked 25 / buildingsChecked 2241 / GLB ids 11159 / idsMismatch 0 / 水平誤差 p50 3.9e-6 m, p95 8.0e-6 m, **max 1.5e-5 m** / 高さ誤差 max 3.3e-6 m /
回転 median 8.3e-6°, max 1.5e-4° / 平均オフセット東 3.3e-8 m, 南 3.8e-8 m / 鏡像 0 / region 逸脱 0 / attrs 欠落 0 / 非 canonical ID 0 / `pass:true`（`resolvedVia:out-root`、往復 1.1e-9 m）。
**結論: 福島区の GLB→World 変換と元 footprint の位置・回転は一致している。建物 GLB の再変換は不要。** 他区は未検証（根拠なく合格としない）。

## 今回の追加（原因を「元データ同士」で確定するための道具）
1. `tools/mission45o-footprint-vs-road.cjs`（読み取り専用）
   元 footprint（旧 tile の `fp`）と元道路の中心線を同一ローカル座標で比べる。道路を (dx, dz) ずらしたとき「道路上の点が footprint の内側に入る割合」を数え、
   ゼロが最小なら建物と道路は相対的にずれていない（`aligned-at-zero`）。最近傍距離や yaw の当て推量とは違い、観測できる矛盾（道路が建物を貫く）だけを使う。
   最小が非ゼロでも、4 分割（西/東/北/南）で同じ向きにならない限り `inconclusive`。`consistent-shift-candidate` でも **適用はしない**（2D 画面で実地物を確認してから）。
2. `public/mission45o-align-diag.html`（`127.0.0.1` 限定、データ送信なし）
   `--dump` で作る `diag.json` をファイル選択で読み、footprint(赤)・道路(青)・地理院淡色タイル(任意)を同一 XY に重ねる。クリックで local x/z と緯度経度、
   原点・軸・単位・道路 manifest の生成日/規約を表示。道路オフセットは見た目の確認のみ（データには反映されない）。

## 実行（PowerShell、結果は集計のみ）
```powershell
git pull --ff-only
node tools\mission45o-footprint-vs-road.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --ward fukushima
```
2D 画面を使う場合（出力先は存在しないフォルダ、リポジトリ外）:
```powershell
node tools\mission45o-footprint-vs-road.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --ward fukushima --dump "$env:LOCALAPPDATA\LiveCity-diag\fukushima"
node tools\mission45e-preview.cjs   # 既存のローカルサーバー。続けて http://127.0.0.1:<port>/mission45o-align-diag.html を開き diag.json を選択
```
貼ってほしいのは `verdict`、`whole.zeroOffsetFraction`、`whole.best`、`halves[].best` のみ。

## 読み方
- `aligned-at-zero`: 元建物と元道路は相対的にずれていない。見えているずれは (a) 地理院/OSM ラスタとの差、(b) 高さによる視差、(c) 別 tileset/版の表示。
  → `?basemap=none` で A/B、真上（pitch -90°）かつ terrain 0 で視差を除く。ラスタだけにずれが出れば、ずれはラスタ側。
- `consistent-shift-candidate`: 元データ同士に一貫した平行移動がある可能性。2D 画面で実地物（交差点・鉄道・大規模建物）を指して確認するまで修正しない。
- `inconclusive`: 平行移動と断定できない。

## 操作性（p95）
Windows 実機の `__mission45n.runs` が無いため、今回は性能コードを変更していない。headless のソフトウェア描画は gesture 中の main thread 占有を再現できず、
PolygonGeometry 建設 / tileset mount / labelSync のどれが p95 の最悪値かは未特定。`?ext45=1&perf=1` の HUD で
①全 ON ②建物 OFF ③道路/面 OFF を同じ操作で各 10 秒測り `__mission45n.runs` の gestureFrameMs.p95 / over50ms を貼ってもらえれば、寄与の大きい箇所に限って修正する。
