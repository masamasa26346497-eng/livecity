# Mission 74: 近景での建物と道路の見かけのずれ（視差 vs 座標）の切り分け

実 PC のスクリーンショットは Claude は閲覧していない（依頼文の説明のみ）。西区の近景は、中央区の同地点の遠景→近景の前後比較ではない。座標ずれは断定しない。座標定数・LOD・データは変更していない。

## 監査（コード読解）
- 道路・河川は PolylineCollection / 面 Primitive で `toCart(x,z,LAYER_H.*)`（道路 1.4m、河川 0.5m）。建物は 3D Tiles（tile 中心 ENU、z0=0=楕円体高）。**起源の異なるデータ**なので、道路中心線が建物外形の辺と一致する必要はない。
- 道路は +1.4m の線、建物は屋根まで h の立体。斜めから見ると屋根は h·tan(視線の鉛直からの傾き) だけ画面上で道路側へ「ずれて」見える（視差）。
- 既存 45Y の赤い footprint 輪郭（道路と同高さ）が、視差を除いた比較用に既にある。

## 追加
1. `tools/mission74-parallax-model.cjs`（純粋・オフライン）: source→WGS84→ECEF→tile ENU→ECEF の往復と視差式。変換器と独立実装の ECEF で照合。
2. `__mission37dQA.parallax74(cols, rows)`（`localhost` + `?qa=1` のみ・読み取りのみ・ID/座標なし）: 建物 pick の `pickPosition` 往復誤差、屋根の地表上高さ、視線の傾き、**予測される見かけの水平ずれ**の p50/p95/max。
3. `tests/mission74-parallax.test.cjs`（5 件）: 定数不変、往復 <1e-6m、tile ENU 連鎖 <1mm（500m tile・高さ 120m）、視差式、フックの読み取り専用性。

## 所有者の 1 回だけの QA（同一地点を 2 回）
最新を取得（上書き・reset 不要。作業フォルダが古い場合のみ）:
```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
```
`...mission37g-osaka-24ward-mvp.html?qa=1&bw=27106` を開き、同じ地点で高度 < 500m にして Console で:
```js
copy(JSON.stringify(__mission37dQA.parallax74(12, 8)))
```
**真上（pitch -90）で 1 回、斜めで 1 回**実行して貼る。読み方:
- `roundTripM` が mm 級 → 変換経路は無罪。
- 斜めで `predictedApparentShiftM.p95` が数 m〜十数 m、真上で ≈0 → 見かけのずれは視差。
- 真上でも道路と建物外形のずれが残る → 別ソース間のずれ（データ側）。そのとき初めて 45Y の赤輪郭と合わせて調べる。

## 未検証
実ブラウザ・実データ・西区。遠景と近景の同一地点比較は未取得（足りない）。
