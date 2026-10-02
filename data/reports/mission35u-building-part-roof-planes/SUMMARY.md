# Mission 35U — building part の平面屋根復元

対象: OSM way **267613423**（`building=residential`、名前なし）
座標系: `znorth-neg-v1`
状態: **EXPERIMENTAL_POINT_CLOUD_PLANAR_ROOF** — 公式 PLATEAU LOD2 ではない。

関連ファイル
- 生成元 `tools/experiments/mission35u_build_part_roof_planes.py`
- 生成物 `public/map-data/osaka-city/experimental/mission35u/part-roof-planes-267613423.json`
- 計測 `data/reports/mission35u-building-part-roof-planes/planes.json`
- 実機 QA `data/reports/mission35u-building-part-roof-planes/browser-qa.json` + `*.jpg`
- テスト `tests/mission35u-building-part-roof-planes.test.js`

---

## §1 building part 判定

35T では、この OSM way は canonical 建物 `cg_bldg_bldg_be65d290-…` に対して **UNMATCHED**（建物全体としては一致しない）だった。
35U は「一致しないから捨てる」ではなく「**部分**ではないか」を別に判定する。

| 条件 | 結果 |
|---|---|
| `sourceCoveredRatio >= 0.90`（source が candidate にほぼ収まる） | OK |
| `candidateCoveredRatio` が 0.25–0.75（candidate 側は部分的にしか覆われない） | OK |
| source の重心が candidate の中にある | OK |
| 2 番目の候補が弱い（IoU <= 0.20） | OK |
| source の面積 < candidate の面積 | OK |

**判定: `BUILDING_PART_CANDIDATE`**（`failed: []`）
条件を 1 つでも落としていたら `PART_UNCERTAIN` で止め、形状は作らない。

source footprint 面積 1,015.96 m²、重心 `[-3968.473, -14803.990]`。
関係は `PART_OF_CANONICAL`。**建物全体として強制マッチさせていない。**

---

## §2 屋根候補点の取り出し

35S は 40 点しか使えておらず、明らかに少なすぎた。取り出しロジックを作り直した。

### 作り直した理由（実測）

先に `mission35u_point_filter_diag.py` で footprint 内の点を実測したところ、

- 点は地上 **12〜62 m** に散らばっている
- 近傍の高さのばらつき（local std）の中央値が **9.72 m**

つまりここは平屋根の低層ではなく **高い棟**で、上空からの点群には屋根面だけでなく
**壁面の反射**も大量に入っている。
当初の「近傍の高さのばらつきが大きい点は樹木として捨てる」方式は、この条件では
60,000 点中 59,336 点（99%）を捨て、**棟そのものを消して低い点だけ残していた**。

そこで「屋根 = 上から見たときの一番上の面」と定義し直し、
**XY を 1 m 格子に切り、各セルの最高点から下へ 1.2 m の厚みだけ**を屋根とした。
壁面の反射（同じ XY で下へ続く点）はこれで自然に落ちる。

### 件数の内訳

| 段階 | 点数 |
|---|---:|
| LAS 全体 | 8,870,514 |
| footprint 近傍 | 771,363 |
| footprint 内 (`inFootprint`) | 188,638 |
| 地面クリアランス 2.5 m 未満を除外 | −579 |
| 高さの外れ値（2%/99% 分位の外） | −5,643 |
| 上面バンドより下（= 壁面の反射） | −180,492 |
| 上面バンド内 (`topSurfacePoints`) | 1,887 |
| 孤立点 | −1 |
| **屋根候補点** | **1,886** |

XY セル数 242、spike セル除外 0 件。地面標高 4.423 m。
屋根の高さ中央値 59.494 m / 最大 63.52 m（地上高）。

35S の 40 点 → **1,886 点（47 倍）**。

---

## §3 RANSAC 平面分割

`RANSAC_TOL_M = 0.35`、`RANSAC_ITERS = 600`、最小 support は
`max(PLANE_MIN_SUPPORT=60, 3% × 点数)` → 実際のしきい値 **60**。
しきい値未満の面は捨てる（**1 面を除外**）。採用 **5 面**。

| # | support | 法線 | 傾き | RMS 誤差 | 最大誤差 | 地上高の範囲 | 面積 | 三角形 |
|---|---:|---|---:|---:|---:|---|---:|---:|
| 0 | 812 | (−0.128, 0.119, 0.985) | 10.04° | 0.136 m | 0.350 m | 61.03–62.40 m | 167.79 m² | 67 |
| 1 | 250 | (0.106, −0.036, 0.994) | 6.46° | 0.134 m | 0.341 m | 60.23–62.32 m | 50.68 m² | 50 |
| 2 | 104 | (0.498, 0.036, 0.867) | 29.94° | 0.207 m | 0.348 m | 11.95–26.81 m | 248.72 m² | 66 |
| 3 | 87 | (0.610, −0.059, 0.790) | 37.79° | 0.170 m | 0.346 m | 34.69–61.61 m | 362.66 m² | 51 |
| 4 | 68 | (−0.012, 0.012, 1.000) | 0.96° | 0.106 m | 0.339 m | 59.32–60.05 m | 170.88 m² | 85 |

全 5 面とも RMS 0.11–0.21 m で、点群に対してよく当たっている。

### 素直に書いておく残課題

plane 2 と plane 3 は傾き 30°・38°、高さの範囲が 15 m・27 m と広い。
support も 104 / 87 と小さい。これは屋根面ではなく、
**上面抽出で残った壁面・セットバック面**である可能性が高い。
今回は「傾きで屋根/壁を機械的に切る」しきい値を入れていないので、そのまま残している。
plane 0 / 1 / 4（support 812 / 250 / 68、傾き 0.96–10.04°、高さ 59–62 m）が
本来の屋根面と考えるのが妥当。**次のミッションで扱うべき課題として記録する。**

---

## §4 屋根の分類

`FLAT_ROOF`（1 面かつ傾きが `FLAT_SLOPE_DEG = 7°` 未満）にも
`STEPPED_FLAT_ROOF` にも当てはまらないため、**`UNKNOWN_PLANAR_ROOF`**。

§3 のとおり急傾斜面が混じっており、切妻・寄棟などへ決められる根拠がない。
**無理に切妻等へ決めていない**（生成元に `GABLE` / `HIP_ROOF` の語は存在しない）。

---

## §5 壁

壁は **source footprint の外周のみ**から生成している（canonical 建物の外周は使わない）。
外周を densify し、地面から各頂点直上の屋根面高さまで立ち上げる。

---

## 形状（§4/§5 の結果）

| | 35S RAW | 35U PLANAR |
|---|---:|---:|
| 支持点 | 40 | 1,886 |
| 三角形 | 103 | **429**（屋根 319 / 壁 110） |
| 頂点 | — | 460 |

### footprint containment

| 頂点 | footprint 外 | 許容 | 判定 |
|---:|---:|---:|---|
| 460 | **0** | 0.75 m | **ok** |

はみ出しゼロ。隣接建物を侵食していない。

---

## §7 canonical 建物全体の LOD1 について

`lod1SuppressionAllowed: false`。
dev ランタイム側も `function isSuppressedBuilding() { return false; }` で固定しており、
35U のレイヤーは **canonical 建物の LOD1 を 1 件も消さない**。
building part なので当然で、35S/35T の HIGH 限定 suppression とは別扱いにしている。

---

## §8 実機 QA

実機（CDP / 1440x900）で dev を開き、「35S 点群LOD2へ」で対象へ寄ってから
3 視点 × 3 モードを撮影した。`browser-qa.json` と 15 枚の jpg が結果。

| 判定項目 | 結果 |
|---|---|
| JS 例外 | **0** |
| RAW モードで 35S だけが出る | OK |
| PLANAR モードで 35U だけが出る | OK |
| BOTH モードで両方出る | OK |
| 3 視点とも 35U が視錐台に入る | OK |
| `lod1SuppressedCount`（全 9 コマ） | **0**（§7 のとおり 1 件も消していない） |
| 撮影用に隠した canonical 建物を毎回戻した | OK（6 回とも復帰後 0） |

### QA 自体の作り直し（2 点）

最初の QA は緑のフラグが全部立ったのに、絵は使い物にならなかった。
フラグは「視錐台に入っているか」しか見ておらず、**見えているか**は見ていなかった。

1. **`side` 視点でカメラが隣の建物の中に入っていた。**
   `phDeg: 6, r: 200` ではカメラ高さが約 21 m にしかならず、60 m 級の隣接建物の内側に入り、
   画面全体が建物の内側の色で埋まっていた。`phDeg: 20, r: 300`（高さ約 103 m）へ直した。
2. **真上からは canonical LOD1 の箱に完全に隠れて、緑の屋根がほぼ見えなかった。**
   §7 のとおり LOD1 を消さないので、これは正しい挙動だが、目視確認ができない。
   そこで **撮影用に canonical 建物レイヤーの `visible` を一時的に落とした絵**
   （`*-nobldg.jpg`）を各視点で追加し、撮影後に必ず戻すようにした。
   これは §7 が禁じる LOD1 suppression ではない（`lod1SuppressedCount` は終始 0）。

### 目視の結果（`oblique-raw-nobldg.jpg` ↔ `oblique-planar-nobldg.jpg`）

| | 35S RAW（青） | 35U PLANAR（緑） |
|---|---|---|
| 高さ | 約 26 m — **実際の棟（約 62 m）と合っていない** | 約 62 m — 点群の実測と一致 |
| 屋根面 | くしゃくしゃに折れた三角形の集合 | 平面（RMS 0.11–0.21 m） |
| 不自然な尖り | **あり**（右側に 1 本、高く突き出している） | **なし** |
| footprint 外へのはみ出し | — | なし（頂点 460 / 外 0） |
| 隣接建物の侵食 | — | なし |

§8 の観点では、**ギザギザは減り、屋根は平面化され、不自然な尖りは消えた**。

### 残っている見た目の問題（隠さず記録する）

- **屋根の輪郭がギザギザ。** 面は平らになったが、各平面の外形を点の外周から作っているため、
  輪郭が 1 m 格子のギザギザを引きずっている。面の平面化と輪郭の整形は別の処理で、
  今回は前者しかやっていない。
- **平面どうしの間に穴が開いている。** 5 面は footprint を隙間なく覆っていない
  （真上から見ると屋根面に抜けが見える）。平面の境界を交線で閉じる処理が要る。
- §3 に書いたとおり plane 2 / 3 は壁面の可能性が高い。

これらは「無理に埋めると推測形状になる」ため今回は手を入れていない。


---

## §10 テスト

- `tests/mission35u-building-part-roof-planes.test.js` — **16 件 / fail 0**
- `tests/mission35s-custom-lod2.test.js` + `tests/mission35t-custom-lod2-matching.test.js` — **30 件 / fail 0**

## §0 変更していないもの

- `public/osaka_3d_buildings.html`（production）— 変更なし
- `public/osaka_3d_buildings.fullward-v3.html`（protected）— 変更なし

変更したのは dev `public/osaka_3d_buildings.ward-ux-v1.html` のみ。
