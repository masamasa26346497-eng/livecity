# Mission 45M: 位置ずれの切り分け（GLB 実頂点検証）と操作性の既定変更

## 45K の説明の訂正
45K は「MPD=111320 固定のため地理院背景に対し 5km で 17m / 15km で 52m ずれる」と説明したが、**誤り**。
元の緯度経度→local と local→緯度経度が同じ式・同じ定数（CLAT/CLON/MPD）なら往復は厳密に元へ戻る（実測 1e-9 m、±20km でも <1e-6 m）。
メートル尺度の近似そのものは、背景地図との位置ずれを生まない。ずれうるのは「原点・軸・定数が元ソースと異なる」場合と、元データ自体の位置品質のみ。

## 実 GLB の独立検証（`tools/mission45m-verify-glb-geometry.cjs`）
ビルダーを import せず、GLB の POSITION → Y-up→Z-up(+90° about X) → 親子 tile transform → ECEF → Bowring 反復で測地座標 → geoToThree 順変換 → 元 tile JSON の fp / z0 / top と比較。
tracked 住吉 9 tile（2,112 棟サンプル、11,849 頂点）の結果:

| 指標 | p50 | p95 | max |
|---|---|---|---|
| 水平誤差 | 3.7e-6 m | 7.8e-6 m | 1.5e-5 m |
| 高さ誤差 | 2.8e-9 m | 3.5e-7 m | 1.8e-6 m |
| 回転(Procrustes) | 7.8e-6° | 3.6e-5° | 1.8e-4° |

平均オフセット東/南 ≈ 1e-8 m、鏡像 0、region 逸脱 0、ID 不一致 0、glTF node transform なし。**GLB→tileset→ECEF の変換連鎖には回転・鏡像・符号・オフセットの誤りは無い**（住吉 tracked 分）。
よって建物と道路/背景のずれは変換連鎖由来ではなく、(a) 元 PLATEAU 建物と OSM 道路・地理院背景の位置品質差、(b) 24区の 45D 出力が別 srcDir から作られた場合の差、(c) 視差（高さのある建物を斜めから見る）のいずれか。ここまでは未特定。恣意的な回転・平行移動は入れていない。

オーナーPC の 45D private GLB に対する実行（read-only、集計値のみ出力。ID・座標・パスは出さない）:
```powershell
node tools\mission45m-verify-glb-geometry.cjs --tileset "$env:LOCALAPPDATA\LiveCity-3DTiles-Out-24\fukushima" --src "..\livecity-data-pipeline\public\map-data\osaka-city\buildings\osaka-fukushima" --sample 5
```
`pass:true` なら変換連鎖は健全で、ずれの原因は元データ側。`pass:false` なら `horizontalErrM`、`meanOffset*`、`fitRotationDegAbs`、`mirrorSuspectBuildings` が原因の手がかり。

## 操作性（localhost ?ext45=1）
実 PC で rr=0&res=fixed が軽かったため、既定を変更:
- requestRenderMode は `?rr=1` を明示した時だけ ON（既定 OFF）。
- 解像度は ext45 で既定固定（`?res=auto` で動的）。
- 計測: `__mission45m.snapshot()` が入力→次描画の遅延(p50/p95)と、操作中のフレーム間隔(p50/p95, 25ms/50ms 超の数)を返す。
効果は実 Windows Chrome で未確認。headless の数値は実機値ではない。

## Windows
```powershell
git pull --ff-only; node tools\mission45e-preview.cjs   # 既存のプレビュー起動手順。URL に ?ext45=1
```
比較する最小 3 指標: `__mission45m.snapshot()` の inputToRenderMs.p95 / gestureFrameMs.p95 / gestureFrameMs.over50ms（既定 vs `?rr=1` vs `?res=auto`）。
