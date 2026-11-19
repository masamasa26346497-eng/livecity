# Mission 46B: 見かけの位置ずれの切り分け（幾何ずれ / 線幅 / 屋根の視差）

**状態: viewer の座標バグは確認できず、viewer・データは無変更。見かけのずれを 3 要因に分けて数値化する読み取り専用 QA を追加。24 区の実世界との位置精度は未検証。「位置合わせ完了」ではない。**

## 読んだ事実（コード）
- 建物 GLB は頂点ごとに lon/lat→ECEF（37B 変換器）、道路・河川は viewer の `toCart`（`Cartesian3.fromDegrees(toLon,toLat)`）。両者は同じ逆変換式で、45M（GLB↔元 fp 1e-5 m）と 46A（tile 変換行列↔セル中心）で輸送の無破損を確認済み。一律 shift / rotation の根拠なし。
- 道路は `PolylineCollection` の**ピクセル幅**（ward 道路: major 4.5+1.5px / mid 3+1px / local 1.8px）。建物は実寸メートル。実際の道路幅データは無い。
- 建物底面は楕円体高 0、道路 1.4m（casing 1.3m）、河川 0.5m、公園 0.9m、鉄道 2.0m。地形なし（`depthTestAgainstTerrain=false`）。高さ差は鉛直 ≤2m で水平のずれは生じない。

## 追加: `tools/mission46b-visual-offset-qa.cjs`（.ps1 付き、読み取り専用・ネットワークなし・集計のみ）
各区で OSM 道路中心線（橋・高架・トンネル除く、8m 間隔）と PLATEAU footprint から:
1. **edgeGapM**: 道路サンプルから最寄り footprint 辺までの距離（p5/p25/p50/p75）と footprint 内の割合 = 幾何的な近さ。
2. **widthArtefact**: カメラ range 300/800/1500/3000m での地上 m/px と、「描画線の半幅 ≥ 実際の隙間」になるサンプル割合 = 位置合わせが完璧でも線が建物に触れる割合。
3. **parallax**: 屋根高さ h の斜視(pitch -35/-60/-90°)での屋根ずれ h/tan(pitch)。真上は 0。
実行（PowerShell 5.1、全 24 区、ローカル private データのまま）:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission46b-visual-offset-qa.ps1 -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
```
貼ってほしいのは区ごとの 1 行（`gapP50 / inside / widthTouch@1500m / roofShift`）のみ。`-Wards fukushima` で 1 区、`-Out <新規ファイル>` で JSON。

## 公開データ（住吉区 35,031 棟 + 同梱道路 9tile）の結果
`data/reports/mission46b/sumiyoshi-public-visual-offset.json`
- 道路サンプル 15,810 点、footprint 内 0.1%。隙間 p5/p50/p75 = 1.79 / 4.18 / 6.04 m → **幾何的には道路は建物の間を通る**（平行移動の根拠なし）。
- 線幅だけで建物に触れるサンプル: range 300m 0.08%、800m 0.3%、1500m 2.9%、**3000m 31.6%**（1px≈3.2m のため）。
- 屋根ずれ: pitch -35° で p50 10m / p90 15m（中央値の隙間 4.18m を超える建物 100%）、-60° で p50 4.0m、真上 0。
→ 斜め視点で「建物が道路からずれて見える」現象は、住吉区のデータでは**屋根の視差が主因と整合**、遠景では線幅が加わる。他区は上のコマンドで同じ指標を出す（未実施）。

## 方針（未適用・推測しない）
- 道路幅・道路面・offset の全区一律適用はしない。実幅データ（OSM `width`/`lanes` 等）が区ごとに裏付けられるまで保留。
- 確認の決定的手順（1 つ）: 同じ視点で `?gfp=1`（住吉のみ）か、真上 pitch -90° + `?basemap=none` で赤輪郭と道路を比べ、真上でずれが消えるなら視差・線幅。真上でも残るなら 46B の `inside`/`gapP50` が高い区から元データの時期差・橋を疑う。
- 非対象: main merge、公開、private upload、GLB 再変換、45I 再生成、有料 API。
