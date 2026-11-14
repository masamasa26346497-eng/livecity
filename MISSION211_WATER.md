# Mission 211 - 24区 Cloud Preview へ水域面(国土地理院 WA)を統合 / 道路・水の整合実測

## 河川の取得元調査(実測、2026-11-14 に実ネットワークで確認)
- 公式 PLATEAU 大阪市 2025(`plateau-27100-osaka-shi-2025`)の CityGML ZIP 中央ディレクトリ(7089 エントリ)を再取得して確認: `udx/` は bldg/tran/fld/dem/brid/cons/tnm/veg/urf/htd/frn/luse のみで、**`udx/wtr`(WaterBody)は存在しない**(`codelists/WaterBody_*.xml` の定義のみ)。`fld` は洪水浸水想定で水面ではない。
- 同パッケージの「3D Tiles, MVT」ZIP(5721 エントリ)と「関連データセット」ZIP にも water/wtr/river を含むファイルは無い。→ source-lock に wtr を足す方法は無い(ロック更新で解決しない)。
- 代替(採用): 国土地理院 `optimal_bvmap-v1` z16 ベクトルタイルの `WA`(水域面ポリゴン、基盤地図情報)。無料・公開・キー不要で、Mission50/57 が既に同じ取得元・同じデコーダ(`tools/lib/mission46d-mvt.cjs`)を使用。出典: 国土地理院(基盤地図情報を含む)。OSM(ODbL)は使っていない。河川中心線は面として扱わない。
- 検証: 新コードで Mission50 の大川・中之島窓を再生成すると、既存 `public/mission50-data/gsi-okawa-nakanoshima.json` の水面 51 ポリゴンと外周が **51/51 完全一致**(座標補正なし)。大江橋の経度線(135.5012E)を南→北に走査すると水面が 2 本(土佐堀川・堂島川)で、間(中之島)は陸。

## 実装
- `tools/cloud/gsi-water-layers.mjs`: 区のbbox → z16 タイル(区間で共有キャッシュ、並列4・60ms間隔・上限 1500 タイル) → WA を建物と同じ projection のローカル m に変換 → 外周頂点が区内にある面を `ext-3dtiles/<区>/layers/waterways.json`(kind:'area'、`h`=穴)に出力。長い川が複数区に跨るため、隣接区に同じ面が重複しうる(同色・同高さ)。
- タイルが1つでも取れなければ、その区の水域を「成功」扱いにせず省略+`index.json.layersReport.waterways.failed` に記録(建物・道路は影響なし)。0 件の区はファイルを作らず `none` と記録(捏造しない)。`--no-water` で無効化。
- `public/mission37g-osaka-24ward-mvp.html`: 面レイヤーが `f.h`(穴)を PolygonHierarchy の穴として描く(中州・島を青く塗らない)。水面の高さ 0.5m < 道路面 1.1m なので橋は水面の上に描かれる。ON/OFF は既存 `LayerRegistry` の waterways。
- `vercel.json`: ビルドコマンドの先頭に `node --test tests/mission209-37g-html-syntax.test.js` を必須ゲート化(構文エラーなら配信物を作らない=Mission209 の事故再発防止)。

## 実データでの位置整合(梅田メッシュ 52350349、公式 tran 559 道路区域)
- 道路区域 559 件中、重心が GSI 水面の内側に入ったのは 1 件(橋)のみ。道路と水面が同一座標系で並んでいる(一律ずれなら大量に重なるか全く合わない)。補正オフセット/回転は一切入れていない。

## 未検証(unknown)
- 実 WebGL での水面・道路の表示、Canvas 画素、建物クリック退行、Z-fighting の目視。Vercel ビルド結果(新規の GSI 取得 ~数百タイルの時間を含む)。
- 24区の区別件数(coverage matrix)は Vercel ビルドのログと `/ext-3dtiles/index.json` の `layersReport` に出る。ここでは未実測。
- 公園・鉄道は未配信。淀川は区ごとの面分割(タイル境界)で出る。GSI WA に含まれない水域(小水路等)は出ない。
- 隣接区の重複水面で alpha 0.95 が二重に乗る箇所と、既存 `gsiwater`(大川窓/住吉窓)との重複は、同色・同高さのため差は僅か(未目視)。
