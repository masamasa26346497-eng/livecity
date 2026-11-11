# Mission 63 P0: 既存スクリーンショットの目視比較（外部GET 0、コード変更なし）

HEAD 0d54775 時点。Git 追跡済みの PNG/JPG を画像として開いて比較した。ピクセル計測はしていない（目視）。

## 目視したファイル
- Mission 59（同一カメラ・同一地点の ON/OFF 組）: `data/reports/mission59/`
  - hanwa-hospital-{top-all-on, top-bg+bldg, top-bg-only, top-gsi-vec-only, oblique-all-on, oblique-globe-off}.png
  - hosoigawa-{top-all-on, top-gsi-vec-only, oblique-all-on}.png
  - sumiyoshi-park-ne-{top-all-on, top-gsi-vec-only}.png
- Mission 58（住吉大社の池・公園、gsipale）: `data/reports/mission58-plates/gsipale-spot1-water-osm-{top-all, top-vecOFF, top-globeOFF, obl-all}.jpg`

## 見えたこと
1. 「vec-only」「vecOFF」が切るのは OSM の roads/waterways/parks のみ。橙の細線（GSI 道路縁 7,184）は残る。
   - 橙線は GSI ラスター背景の道路縁の灰色線の真上に載っている（spot1 vecOFF、目視で数 px 以内）。
2. 道路は「帯」ではなく細い線。橙の道路縁の間（道路幅）に対し、OSM 道路は細い青灰の線として中央付近を通る。
   - hanwa top-all-on の斜め道路・南北道路で、線は両側の橙線のほぼ中央。左右の偏りは目視で数 px。
   - 道路「面」は描かれていない。道路幅いっぱいの面と線のずれに見える可能性がある。
   - コード: 線幅は画面 px 固定（`addRoadPl` / `roadW`、37G html 746-759 行、ROAD_BANDS で高度帯ごとに縮小）。
3. globe OFF（Mission 58 spot1）でも、道路・水・公園・橙線は globe ON と同位置・同形で描画される。
   - 37G html 536 行 `depthTestAgainstTerrain=false`。地表（楕円体）がオーバーレイを覆う・z-fighting する証拠は見えない。
   - Mission 59 の `*-globe-off` は直前に vec を OFF にしてから globe を切っている（`mission59_bg_vs_render_qa.mjs` 97-98 行）。
     → 建物しか映らない。道路・水の globe 依存の検証にはならない。
4. spot1 の池（水 0.5m）は公園（0.9m, alpha 0.8）の上に、青のまま見える（top-all, obl-all, globeOFF）。
   - 高さ順（公園が上）だと水は公園色に染まるはずだが、そうなっていない。半透明 Primitive の描画順は高さではなく別要因とみられる。
   - 4 視点で同じ向き。カメラ距離で順序が反転するかは未検証。
5. 背景ラスターの解像度が撮影タイミングで違う。
   - hanwa の top-bg+bldg は背景が巨大にぼけ（「我孫」の巨大文字）、top-all-on / gsi-vec-only は鮮明。
   - 同じ地点で背景のタイル LOD が違う。bg+bldg と all-on の比較は LOD の差を含む。

## 見えなかったこと
- 建物底面と道路・河川の面が食い違う明確な欠陥（水面が建物を覆う、地表が建物を覆う、道路の誤投影）は、読んだ画像に確認できなかった。
- 屋根の位置ずれは top で出るが、斜め視点では建物底面は橙の道路縁にほぼ接している。独立した地上基準点が無いので水平誤差は未測定。

## 未確定
- 描画順の反転（4）、道路が建物フットプリント内に隠れる量（線 1.4m と壁 0..h の交差）は未検証。
- ユーザーが見た異常の画像が repo に無い。必要なもの: 該当 URL＋地点（lat/lon）＋カメラ高度/向き＋スクリーンショット。
