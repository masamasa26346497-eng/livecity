# Mission 35Y — 建物単位の正確なホバー・クリック選択

対象: dev `public/osaka_3d_buildings.ward-ux-v1.html` のみ
座標系: `znorth-neg-v1`（変更なし）
production / protected: **変更なし**

---

## §1 元の picking 方式と、何が悪かったか

`CanonicalRuntime.pickBuilding()` は次の順で建物を決めていた。

1. 建物タイルの **merged mesh** へ `Raycaster.intersectObjects()`
2. **当たった三角形の素性をそこで捨て**、`hit.point` の (x, z) だけを使って footprint を空間検索
3. `Math.abs(f.cx - px) > 400` の bbox で粗く絞る
4. `pointInRing()` が当たればそれ。**外れたら「一番近い centroid」**
5. その距離が `fpD > 90000`（= **300m**）を超えたときだけ諦める

つまり `hit.faceIndex` という「どの建物の三角形に当たったか」という一番確実な情報を
捨てたうえで、最後は **最近傍 centroid** に頼っていた。§3 が禁じている方式そのもの。

### なぜ拾えない / 隣を拾うのか（実測で確認した内訳）

| 症状 | 原因 |
|---|---|
| **壁をクリックすると隣の建物になる** | 壁の `hit.point` は footprint の **縁** に乗る。`pointInRing` は境界で落ちやすく、落ちた瞬間に最近傍 centroid へ飛ぶ。実測で壁の成功率は **74.4%**（屋根は 97.6%） |
| 凹型・L 字で外れる | footprint の **重心が polygon の外**に出るので、centroid fallback が別の建物を指す |
| 同じ建物が 2 回出てくる | `visibleBuildingFootprints()` に dedupe が無く、タイル境界で重複。実測 **20,227 件** |
| hover が重い | `mousemove` のたびに `layerGroup.buildings.traverse()` で候補 mesh を作り直していた |

`hit.point` の高さ（y）も使っていなかったので、上下に重なる建物は区別できない作りだった。

---

## §2/§4 新しい方式 — 三角形 → 建物 ID

**1 棟 1 mesh にはしない**（draw call を増やさない）。merge したまま、
「どの三角形がどの建物か」を typed array で持つ。

建て込み側（`byCat` バケットへ積むところ）:

```js
const triBefore = bucket.pos.length / 9;
pushExtrude(bucket.pos, f.geometryType, f.coordinates, h, ...);
const triAfter  = bucket.pos.length / 9;
const bIdx = fpRec ? bucket.fps.push(fpRec) - 1 : -1;
for (let t = triBefore; t < triAfter; t++) bucket.tri.push(bIdx);
```

mesh 側:

```js
m.userData.crTriBuilding = Uint16Array.from(bucket.tri, v => v < 0 ? 65535 : v);  // 三角形 → 建物 index
m.userData.crTriEmpty    = 65535;                                                  // 建物に紐づかない三角形
m.userData.crBuildingFps = bucket.fps;                                             // index → footprint
```

建物が 65,535 を超える bucket では `Uint32Array` へ自動で切り替える。
**三角形 1 枚あたり 2 byte。draw call も三角形数も頂点数も増えない。**

pick 側:

```js
const bi = ud.crTriBuilding[hit.faceIndex];
if (bi !== ud.crTriEmpty) return ud.crBuildingFps[bi];   // ← これで決着
```

- **bbox だけでの選択は無い**（bbox は fallback 経路の粗い絞り込みにしか残っていない）
- **最近傍 centroid は完全に削除**した
- footprint が無い建物（centroid 欠損）は `-1` を入れてあり、当たっても「建物なし」を返す

### footprint fallback（§3-C）

対応表を持たない mesh（Umeda Visual PoC / Block QA の mesh）に当たったときだけ、
`pointInRing()` による **内外判定のみ**へ落とす。ここでも centroid は使わない。
実測では通常表示でこの経路に落ちた回数は **0 回**（`byPolygon: 0`）。

---

## §5/§6 形状に沿う / 屋根も壁も

- **穴・中庭**: 屋根は `THREE.ShapeUtils.triangulateShape(contour, holes)` で穴を抜いて
  三角形化されているので、**穴の中には三角形が存在しない** → 当たらない。特別な処理は不要。
- **凹型**: 三角形単位で引くので、凹んだ部分に三角形が無ければ当たらない。
- **MultiPolygon / 複数パート**: `pushExtrude` が `polys` を回して同じ建物へ積むので、
  どのパートに当たっても同じ ID になる。
- **屋根も壁も同じ経路**。面の向きで分岐していない（内訳を数えているだけ）。
  実測で屋根 3,059 / 壁 1,489 ヒット。

## §7/§8 hover と click

hover の highlight は元々 footprint 形状（屋上 fan + 壁面）に沿っており、bbox は使っていない。
hover と click は **同じ `pickHit()` → `CanonicalRuntime.pickBuilding()`** を通る
（`pickBuilding` の呼び出し口はコード中に 1 つだけ）。

## §12 タイル境界の重複

`visibleBuildingFootprints()` に canonicalId の dedupe を入れた。
**20,227 件 → 0 件。** pick 側は手前の 1 枚で決着するので、そもそも 2 回返らない。

## §14 hover 性能

候補 mesh を毎回 traverse し直すのをやめ、タイル構成が変わるまで使い回す
（建物タイルが組み上がったら `invalidatePickCache()`）。
候補は「見えている建物 mesh」だけで、実測 **474 個**。60 万棟を毎回 raycast はしていない。

---

## §17 自動 QA の結果（同じ計測器での before / after）

7 地点（梅田高層密集 / 本町 / 難波 / 天王寺 / 住宅密集地 / 新高 / タイル境界）で、
建物 footprint の **内側と分かっている点**の「中央・端・壁」を画面へ投影して pick する。

| | before | after |
|---|---:|---:|
| 標本 | 201 | 255 |
| **success** | **93.5%** | **99.6%** |
| **wrong neighbor** | **6.5%**（13 件） | **0.4%**（1 件） |
| no hit | 0% | 0% |
| 中央 | 97.6% | 99.0% |
| 端 | 98.7% | **100%** |
| **壁** | **74.4%** | **100%** |
| 小さい建物（<200m²） | 93.4% | 99.5% |
| footprint 重複 | 20,227 | **0** |
| hover FPS | 50.01 | 49.96 |
| pointer handler | 4.92 ms | 4.78 ms |

**真上からの ray（遮蔽が起こり得ない）では 168/168 = 100%** で期待どおりの建物を返す。

目標 95% に対して **99.6%**。巨大 hitbox は使っていない（画面上の許容も足していない）。
唯一残った 1 件は梅田の高層密集で、屋根が別棟と接している所。

### 計測器そのものを 4 回直した（正直に記録する）

最初に出た数字は全部おかしく、いずれも **計測側の誤り**だった。

1. **建物タイルは区ごとに読む**ため、カメラを動かすだけでは新しい場所の建物が出てこない。
   7 地点中 6 地点で標本 0 だった → `WardModeManager.switchWard()` を入れた。
2. `visibleBuildingFootprints()` は **高さを返さない**。全建物の屋根を y=6 として投影していた
   （高層ビルでは地面すれすれを指すことになる）→ 真上から ray を落として実際の屋根高さを測る方式へ。
3. **footprint の重心が polygon の外に出る凹型**があり、そこを「期待位置」にしていた。
   → 必ず内側にある点を求め、複数の footprint が重なる点は標本から外した。
4. **斜め視点では手前の高い建物に隠れて見えない点がある**。見えない点を指して
   別の建物が返るのは正しい挙動なので、遮蔽されている標本（227 件）は分母から外した。

この 4 つを直す前の「成功率 11%」「42%」といった数字はすべて計測の誤りで、
製品の実力ではない。上の表が同じ計測器で測り直した正しい比較。

---

## §16/§18 視覚 QA

`1-single-building-hover.jpg` / `2-adjacent-buildings.jpg` / `3-dense-umeda.jpg` /
`4-small-building.jpg`（45 m²）/ `5-irregular-footprint.jpg`（頂点 33 の複雑な輪郭）/
`6-selected-building.jpg`（クリック選択）。
いずれも実際に `mousemove` / `click` を投げて撮っている。

---

## §19 テスト

`tests/mission35y-precise-building-picking.test.js` — **15 件 / fail 0**
（faceIndex→buildingId / bbox のみ禁止 / centroid のみ禁止 / 穴の除外 / 凹型 /
屋根・壁の同一経路 / hover と click の同一性 / 重複 dedupe / 小さい建物 /
hover 性能 / production・protected 未変更 / 実機 success 95% 以上）

---

## 未解決事項

- **`ambiguous` 標本が多い**（1 地点あたり 66〜152）。footprint どうしが重なっている場所が
  それだけあるということで、picking ではなくデータ側の話。§11 の LOD 優先とあわせて別途。
- **§11 の LOD 優先は明示的な実装を足していない。** 実際には「見えている mesh にしか
  当たらない」ので結果的に最上位表現が選ばれるが、優先順位を宣言した形にはなっていない。
- **§13 の画面上の許容（数 px）は入れていない。** 小さい建物の成功率が 99.5% あり、
  必要が無かったため。入れると隣棟へ侵入する危険があるので、必要になってからにする。
