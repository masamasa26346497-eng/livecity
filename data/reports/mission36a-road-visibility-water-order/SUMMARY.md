# Mission 36A — 大阪市全域の道路視認性強化＋水面との重なり順修正

GitHub Issue #5 / branch `feature/mission-35z-building-photo-preview`

## 1. 調査で分かったこと（実装前）

### 1-1. 道路の塗りが水面より **下** にあった（要件2の原因）

`public/osaka_3d_buildings.ward-ux-v1.html` の CanonicalRuntime のレイヤー高さ:

| レイヤー | Y | renderOrder | material |
|---|---|---|---|
| 水面 `CR_water` | **0.14** | 610 | transparent / opacity 0.96 / depthWrite **false** |
| `RoadV3_Margin` / `RoadV3_Uncertain` | **0.087** | 639 | transparent / depthWrite false |
| `RoadV3_Carriageway` | **0.099** | 640 | **不透明** / depthWrite true |
| `RoadBucket_*`（FIX13） | 0.22〜0.30 | 638〜642 | — |
| `RoadBucket_bridge`（高架） | 3.0 | 642 | 不透明 |

`ROAD_V3_Y = { base: 0.087, carriageway: 0.099, diff: 0.101 }` は、Mission 32I が ROAD V3 を
「FIX13 の下に敷く比較用オーバーレイ」として作ったときの値。Mission 32K で ROAD_V3 が
**既定表示へ昇格した際にこの Y が見直されなかった**ため、既定の道路面が水面より 0.04m 低いまま残っていた。

three.js は不透明→半透明の順に描くので、
不透明な車道面(0.099) → 半透明の水面(0.14, depthTest 有効) の順になり、
**水面が depthTest に勝って車道面を塗りつぶす**。これが「川と重なる場所で道路が消える」現象。

### 1-2. ただし、淀川の橋が見えない主因は別（データ側）

実機 ray 計測（`diag/diag.json`）:

| 地点 | 水面サンプル点 | その真上に道路 mesh がある点 | 内訳 |
|---|---|---|---|
| 十三大橋（淀川） | 94 | 3 | `RoadBucket_bridge`@y3.0 のみ |
| 中之島 | 32 | 6 | `RoadBucket_bridge`@3.0 / `RoadV3_Uncertain`@0.087 / `RoadBucket_primary`(非表示) |

`diag/juso-2-nowater.jpg`（水面レイヤーを消した画）を見ると、淀川の川面の上には
**そもそも道路ポリゴンが存在しない**。淀川を渡る橋の大半は canonical 道路データに面が無く、
渡っているのは鉄道（`Y.rail`=0.5 / `railBridge`=3.2、もともと水面より上）だけ。

つまり要件2の「水面が道路を覆う」は**中之島など河川際で実在する**が、
淀川の橋が見えないのは **描画順ではなくデータ被覆の問題**。
Issue の「道路データそのものの位置・形状は変更しないこと」に従い、今回はデータを作らない。

## 2. 実装（`public/osaka_3d_buildings.ward-ux-v1.html` のみ）

| # | 変更 | 前 | 後 |
|---|---|---|---|
| ① | `ROAD_V3_Y` | `{ base: 0.087, carriageway: 0.099, diff: 0.101 }` | `{ base: Y.road - 0.06, carriageway: Y.road, diff: Y.road + 0.002 }` = `0.24 / 0.30 / 0.302` |
| ② | `COL_DEPTH.road`（既定パレット） | `0x8b929e` | `0x7e8693` |
| ③ | `RoadV3_Margin` opacity | `0.45` | `0.60` |
| ③ | `RoadV3_Uncertain` opacity | `0.55` | `0.66` |

### ① 採用した「道路 > 水面」の方法：Y を既存の道路スタックへ揃える

- `depthTest = false` は**使っていない**（建物を透過するため Issue でも禁止）。
- `polygonOffset` も**使っていない**（同一平面ではなく高さが違う問題なので不適）。
- `renderOrder` は**既存のまま**（`REN.water 610 < REN.road 640`）。もともと正しく、
  Y と向きが逆だったのが問題だったので、Y を合わせて初めて両者が一致した。
- 値を直書きせず `Y.road`（=0.30, FIX13 の primary と同じ）から導出。`Y.road` を動かしても再発しない。
- 結果として水面(0.14) との間隔は **0.10m**。ばらつきの無い平行面なので z-fighting は起きない
  （既存の道路スタックは 0.02m 間隔で成立している）。鉄道(0.5)・高架(3.0)・建物より下は維持。

### ②③ 視認性

- 地表 `LAND_COLOR_MODEL`(0xebede6) に対するコントラスト比 **2.91 → 3.41**
  （グラフィック要素の下限 3:1 を超える）。
- `railLocal`(0x69717f) よりは明るいままなので「鉄道は道路より濃い」(§13) は維持。
- 色相は blue-gray のまま（原色化しない）。主要/一般の差は `mix(COL.road, COL.white, t)` で
  作っているので、道路種別の階段は比率ごとそのまま保たれる。
- 引いた画面で道路網の形を作っているのは幅のある道路区域（margin/uncertain）なので、
  §11 dark paint rule（濃い色は車道面だけ）を守り **色は変えず opacity だけ**上げた。

## 3. QA 結果（実機 Edge / headless / 1440×900）

`tools/experiments/mission36a_road_water_qa.mjs`。配色に依存しない差分法で測る:

- `R_all` / `R_noWater` / `R_noRoad` / `R_noRoadNoWater` の 4 枚を同一カメラでレンダリング
- `roadContrast` = 実際に見えている道路画素の |ΔRGB| 平均（背景に対する道路の濃さ）
- `roadInkRatio` = 見えている道路画素 / 全画素

| 地点 | contrast before → after | roadInk before → after |
|---|---|---|
| 大阪市全域 (r=14000) | 5.85 → **6.76** (+15.6%) | 15.85% → 15.92% |
| 大阪市北部 (r=7000) | 8.20 → **9.57** (+16.7%) | 22.36% → 22.45% |
| 十三大橋（淀川） | 10.63 → **12.67** (+19.2%) | 16.71% → 16.85% |
| 新淀川大橋（新御堂筋） | 11.44 → **13.65** (+19.3%) | 20.28% → 20.54% |
| 淀川大橋（国道2号） | 10.13 → **12.18** (+20.2%) | 14.92% → 15.02% |
| 中之島 | 15.20 → **17.50** (+15.1%) | 16.99% → 17.28% |
| 中之島（引き） | 10.31 → **12.18** (+18.1%) | 23.96% → 24.21% |
| 梅田（近景） | 11.95 → **13.67** (+14.4%) | 18.82% → 18.90% |
| 本町（近景） | 19.63 → **22.41** (+14.2%) | 10.63% → 10.77% |

全 9 地点で向上。ink がほぼ同じで contrast だけ上がっている＝
**道路を太くしたのではなく濃くした**ことの裏付け。

### 重なり順（after / 全 9 地点・118 行の mesh スタック）

- 可視の道路 mesh の最小 Y = **0.24** > 水面の最大 Y = **0.14**（間隔 0.10m）
- `depthTest: false` の道路 mesh = **0 件**
- 水面レイヤーは消していない（`display.layers.water === true`、水面 mesh も従来どおり Y=0.14）

### 残った `occludedByWaterPx`（画素指標）について

after でも中之島で 110〜621px（道路画素の 0.05〜0.26%）が「水に隠れた道路」と判定される。
`diag/after-mask-*.png`（赤＝該当画素）と ray 照合の結果、その正体は
**高架橋（`RoadBucket_bridge`@y3.000 / `RoadDetailEdge`@y3.020）のアンチエイリアス縁**で、
いずれも水面(0.14)より上にあり物理的に水に隠れ得ない。
道路色が濃くなったぶん「道路なし背景との差」が固定しきい値(6)を超えやすくなり、
before(6px) より数が増えて見えているだけで、退行ではない。
重なり順の判定は画素指標ではなく上記の **Y / depthTest の不変条件**で行う。

## 4. Issue の QA 条件に対する結果

| # | 条件 | 結果 |
|---|---|---|
| 1 | 全域ズームアウトで道路網が前より明確 | ✅ contrast +15.6%（全域）/ +16.7%（北部）。`after-citywide*.jpg` |
| 2 | 淀川を渡る道路・橋で水面が道路を覆わない | ✅ 可視道路の最小 Y 0.24 > 水面 0.14。ただし §1-2 のとおり淀川の橋は元々道路ポリゴンが無い箇所が多い |
| 3 | 中之島周辺でも道路が正しく見える | ✅ `after-nakanoshima.jpg` で大江橋・淀屋橋の車道面が川面の上に出る（before は川面が連続） |
| 4 | 道路が建物を不自然に透過していない | ✅ 道路 material の `depthTest:false` = 0 件（構造的に透過し得ない）。近景の建物画素に対する道路寄与 0.25〜0.31% は建物シルエットの AA と高架(y=3.0)による正当な前後関係 |
| 5 | 水面表示を消していない | ✅ 水面 mesh は Y=0.14 / opacity 0.96 のまま。レイヤートグルも ON |
| 6 | 既存機能を壊していない | ✅ `npm test` 2206 pass / 0 fail。mission35L〜35Z の 10 本も全 pass |
| 7 | 新規 JS エラーなし | ✅ console error は before/after とも 1 件で同一（既存の `CemeteryLayer/TempleLayer` TDZ） |
| 8 | 既存テストの失敗を増やさない | ✅ HEAD(460bcd3) の worktree と比較し、失敗数 21 → 20（増加なし） |

## 5. 変更していないもの

- 道路 / 水面の geometry・座標・取得元（`road-visual-v3` タイル、canonical water）
- `Y.water`（水面を下げて逃げていない）、`REN.*`（renderOrder）
- `COL`（CURRENT プロファイル＝35H 以前の比較用配色）、`railMajor/railUrban/railLocal`
- `ROAD_V2_Y`（0.085 / 0.095。QA 比較専用モードで既定表示では描かれない。既定表示の是正が
  今回の対象なので触っていない）
- `public/osaka_3d_buildings.html`（production）と `osaka_3d_buildings.fullward-v3.html`（protected）。
  production への反映は従来どおり別ミッションの cutover 作業。

## 6. 再現手順

```bash
node tools/preview.js --port 8080          # 別ターミナルで dev を配信
MISSION36A_PHASE=after node tools/experiments/mission36a_road_water_qa.mjs
node --test tests/mission36a-road-visibility-water-order.test.js
```

`tests/mission36a-road-visibility-water-order.test.js` は 35L〜35Z と同様
`npm test` のスクリプトには含めていない（個別実行）。
