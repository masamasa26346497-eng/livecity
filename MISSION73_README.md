# Mission 73: 「道路は描かれるのに建物が無い街区」の切り分け

ユーザー報告（北区・ローカル閲覧）は、ここではスクリーンショットを見ていない（テキスト説明のみ）。座標変換バグとは断定しない。

## 既出（再実験しない）
45M（福島区 GLB→World 一致 max 1.5e-5m）/ 45O,45P（footprint vs 道路に一貫した平行移動なし）/ 45Y（座標基準・高さ基準は同一、住吉は一致）/ 58,61,63（板の接合・視差・層高さ差）。
北区は private で、ここでは未検証。

## 今回の静的コード調査で分かったこと
- 37B の tileset は group（geometricError 40）→ leaf（geometricError 0）の構成。group の簡略 LOD は **footprint の bbox を押し出し、bbox 面積 100m² 未満の棟を捨てる**（`coarsen`, `--coarse-min-area 100`）。
- よって SSE が大きい/遠いと group が選ばれ、**小さい家屋の街区は建物が出ないのに道路線（別プリミティブ）は常に出る**。座標ずれと見分けがつかない見え方になる。
- 追跡済みの住吉区 52 tile で実測（`data/reports/mission73-sumiyoshi-coarse-lod.json`）: 35,031 棟中 coarse に残るのは 13,821（**60.55% 脱落**）。100m セルの 2.09% は coarse で 0 棟、62.24% は半数未満。
- これは **候補原因の定量化**で、北区で実際にそれが原因かは未確認。45D 変換（北区ローカル）が同じ coarsen を使うかも、PC 側の結果で確認が必要。

## 追加
1. `tools/mission73-coarse-lod-loss.cjs`（読み取り専用・ネットワークなし・ID/座標は出さない）
   `node tools\mission73-coarse-lod-loss.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city\buildings\osaka-kita"`
2. `__mission37dQA.coverage73(cols, rows)`（`localhost` + `?qa=1` のみ、読み取りのみ）: 描画対象 tile を leaf/coarse に分けた数、画面格子の pick 内訳（建物/他/無）、tileset の SSE、中央点の往復画素差。
   位置の誤差は測らない（往復整合のみ）。

## ユーザーが PC で 1 回貼る手順（座標・ID は出ない）
ページを `?qa=1` 付きで開き、建物が欠けて見える視点で DevTools Console に:
```js
copy(JSON.stringify(__mission37dQA.coverage73(16, 10)))
```
（66 の probe と同じ __mission37dQA。）
続けて同じ場所で近づいて（高度 < 500m）もう一度。読み方:
- 遠景で `selected.coarse` が多く、近づくと `leaf` が増えて建物が出る → LOD の仕様。SSE を下げる/coarse 側の最小面積を下げて再変換する対象。
- 近づいても建物が無く `leaf` に偏る → データ欠落（元 PLATEAU の範囲）か未ロード。`tilesets[].tilesLoaded` と `stats.pending` を見る。
- `projCheck` が ±1px を超える → 変換の問題。そのときに初めて座標を疑う。

## 未検証
実ブラウザ・北区・24 区・Mission70/71 idMismatch 再監査・Mission72 クラウド URL はいずれも未完のまま。全棟の一律 shift は行っていない。
