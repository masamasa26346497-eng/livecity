# Mission 35W — 地面を 35V 前へ戻し、道路をリアル化する

対象: dev `public/osaka_3d_buildings.ward-ux-v1.html` のみ
座標系: `znorth-neg-v1`（変更なし）
production / protected: **変更なし**

---

## §1 地面のロールバック

### 基準 commit

**`babae19`**（`35O: attach official facility names to buildings`）＝ 35V 導入の直前。

色は 1 つも手で決めていない。`tools/experiments/mission35w_revert_ground.py` が
`git show babae19:<dev html>` から **該当行をそのまま取り出して置き換える**。
テスト側も同じ方法で突き合わせている（`tests/mission35w-real-roads-original-ground.test.js` の
「地面まわりが 35V 直前と 1 行ずつ一致する」）。

### 戻した値

| | 35V（ネイビー） | 35W（= 35V 前） |
|---|---|---|
| 背景・fog `MS_BG_NEUTRAL` | `0x0d1524` | **`0xf6f7f3`** |
| 陸 `LAND_COLOR_MODEL` | `0x18233c` | **`0xebede6`** |
| 陸（データ表示） | `0x141d33` | **`0xe3e5de`** |
| 地表タイルの明度の振れ幅 | 0.14 | **0.97〜1.02（元式）** |
| 地面からの照り返し `hemiGround` | `0x1b2942` | **`0xe8dcc8`** |
| CSS `html,body` | `#0d1524` | **`#f3f4f1`** |
| CSS `--lc-bg`（Mission19 block） | `#0d1524` | **`#f4f6f8`** |
| `COL_NAVY`（水・公園・鉄道） | あり | **削除**（profile の値へ） |
| `CITY_THEME` / `cityThemeDark` | あり | **削除** |
| ラベルの明暗反転 | `night \|\| cityThemeDark()` | **`night` のみ** |

実機で確認した実値: `clearColor #f6f7f3` / `fog #f6f7f3` / `land #ebede6` /
`body rgb(244,246,248)`、`window.CITY_THEME` は `undefined`。

ネイビーの値（`0x0d1524` / `0x18233c` / `0x141d33` / `0x1b2942` / `#0d1524`）が
コメント以外に 1 か所も残っていないことをテストで検査している。

### 戻していないもの（§1 の「戻さない対象」）

建物名ラベル・駅名・町名・河川名・建物色ロジック・35S/35T/35U はそのまま。
35V で入れたラベル階層の改善（`BUILDING_LABEL_SHARE` / rank / `RECT_MARGIN` /
`visibleBuildings` カウンタ / 主要ビルの白いバブル）も §8 の指示どおり維持している。

---

## §2 道路のリアル化 — `RoadDetailLayer`

### 使ったデータ

`public/map-data/osaka-city/roads/tile_{tx}_{tz}.json`（2000m タイル・93 枚・47,423 feature）。
OSM way の **centerline** に加えて、実測で次の属性が入っていた:

| 属性 | 使えた件数（60 タイル 27,956 feature で実測） |
|---|---|
| `tier` | major 1,994 / mid 3,730 / local 22,232 |
| `highway` | unclassified 9,152 / residential 6,670 / service 5,418 / tertiary 3,615 / primary 740 / trunk 400 / motorway 193 … |
| `lanes` | 5,455 件（1〜8 車線） |
| `oneway` | 238 / 472（サンプルタイル） |
| `bridge` | 1,030 件 |

canonical の roads タイルも同じ 2000m グリッドなので、
**道路タイルが組み上がった所で同じ tx/tz の標示を作る**という既存 hook に相乗りできた。

### 描いているもの

| | 内容 | 根拠 |
|---|---|---|
| A 縁石 / 路肩 | 車道の両端に暗い帯（`0x7c838c`）。道路の形がいちばん出る要素 | `lanes` / `highway` から求めた半幅 |
| B 中央線 | 片側 2 車線以上は実線、それ以外は破線（線 5m / 空き 5m） | `lanes` |
| B' 一方通行 | **中央線を引かない**（引くと嘘になる） | `oneway` |
| C 車線境界 | 4 車線以上で車線ごとに破線 | `lanes` |
| D 外側線 | 幹線の両端に実線 | `tier === 'major'` |
| E 停止線 | 交差点の手前に幅 0.40m の帯 | 交差点形状 |
| F 横断歩道 | **推定**（後述） | 交差点形状 |
| G 高架・橋 | 標示ごと `Y.roadBridge` まで持ち上げ、縁石を 1.9 倍に太くして桁に見せる | `bridge` |

### 主道路と生活道路の差（§2-A）

半幅は `lanes` があればそれを使い（1 車線 3.0m）、無ければ種別から:

| highway | 半幅 |
|---|---:|
| motorway / trunk | 7.0 m |
| primary | 6.5 m |
| secondary | 5.5 m |
| tertiary | 5.0 m |
| residential / unclassified | 4.0 m |
| service | 2.5 m |

さらに **ズームで出す対象が変わる**（§5）ので、引いた画面では幹線だけに縁石が付き、
主道路と生活道路が明度でも分かれる。

### 白線の幅は実寸ではない（正直に書いておく）

実測すると、この画面は **1px ≒ `cs.r` / 1300 [m]**。
実寸の白線（0.15m）を描くと r=900 で 0.2px になり、**完全に消える**。
そこで幅を `clamp(1px相当 × 2.2, 0.28, 1.8) [m]` として、
**画面上で 2px 前後**になるようにしている。地図表現としての誇張であり、実寸ではない。
ズームは約 1.45 倍ごとの「段」でだけ作り直す（連続ズームで作り直し続けない）。

### §6 横断歩道 — 推定である

**このデータセットに OSM の crossing 情報は 1 件も無い**（`roads/` 全タイルを走査して 0 件、
`derived/` 以下にも crossing を持つデータセットは無い）。
そのため交差点形状からの推定で置いており、指示どおり次を守っている:

- dev のみ
- **主要道路どうしの交差点のみ**（`majorArms.length >= 3`）。生活道路には出さない
- near band のみ
- コードに `CROSSWALK_ESTIMATED = true`、debug に
  `crosswalkIsEstimated: true` と `crosswalkSource: 'ESTIMATED_FROM_JUNCTION_GEOMETRY'`、
  説明文つきで出している

交差点は「3 本以上の way が共有している頂点」として検出している。

---

## §3 道路 geometry は作り変えていない

`RoadDetailLayer` は centerline の座標を読むだけで、

- `pushPolygon` / `pushExtrude`（既存の道路面生成）を呼ばない
- `refined-road-surface` / `road-visual-v3`（既存の道路面データ）に触らない
- 道路を移動しない・実在しない道路を足さない
- 座標規約を変えない

既存の道路 style（`buildRoadStyles()`）は 35V 内の差し戻しのまま、`babae19` と同一。
以上をテストで検査している。

---

## §4 パフォーマンス（10 地点の平均。実機 1440x900）

| | before（35V 状態） | after（35W） | 差 |
|---|---:|---:|---:|
| **draw call** | 133.2 | **146.3** | **+13.1（+9.8%）** |
| **triangles** | 483,153 | **506,022** | **+22,869（+4.7%）** |
| **mesh 数** | 834 | **848.8** | +14.8 |
| geometries | 730 | 743.2 | +13.2 |
| **FPS** | 55.5 | **56.0** | **+0.5（低下なし）** |

1 道路 1 mesh にしていない。**タイルあたり「縁石」1 + 「白線」1 の 2 draw call** へ merge し、
`meshFromPositions` の呼び出しはレイヤー全体で 2 か所だけ。
ズーム段が変わったら前の段の geometry / material を `dispose()` している。
カメラ注視点から `reach`（= `clamp(r × 2.4, 700, 3400)` m）の外にある feature は作らない。

### 地点ごとの標示量

| 地点 | band | markW | 縁石 tri | 白線 tri | draw call | 交差点 | 横断歩道 |
|---|---|---:|---:|---:|---:|---:|---:|
| 梅田 | mid | 1.80 | 27,468 | 2,432 | 18 | 0 | 0 |
| 中津 | mid | 1.52 | 14,564 | 1,466 | 16 | 0 | 0 |
| 十三 | mid | 1.80 | 7,084 | 1,048 | 15 | 0 | 0 |
| 本町 | mid | 1.52 | 16,992 | 1,896 | 15 | 0 | 0 |
| 難波 | mid | 1.52 | 21,288 | 2,550 | 20 | 0 | 0 |
| 天王寺 | mid | 1.69 | 11,236 | 1,452 | 16 | 0 | 0 |
| 新高(35S) | near | 1.18 | 8,400 | 14,672 | 16 | 29 | 27 |
| 本町交差点(近景) | veryNear | 0.44 | 7,840 | 14,330 | 8 | 54 | 3 |
| 御堂筋(中景) | near | 0.88 | 9,620 | 31,812 | 14 | 53 | 58 |
| 阪神高速(高架) | veryNear | 0.73 | 18,304 | 17,906 | 10 | 231 | 67 |

---

## §5 ズーム別

| band | 条件 | 出すもの |
|---|---|---|
| far | `r > 2200` | **何も出さない**（道路の塗りだけ。group ごと非表示） |
| mid | `700 < r <= 2200` | 幹線の縁石 + 中央線 |
| near | `450 < r <= 700` | ＋ 中位道路、車線境界・外側線、停止線、（推定）横断歩道 |
| veryNear | `r <= 450` | ＋ **生活道路の縁石**（街路の形が全部出る） |

---

## §9 QA（実機・CDP・1440x900・7 地点 + 寄り 3 カット）

| 確認項目 | 結果 |
|---|---|
| 地面色が 35V 前に戻っている | OK（`#f6f7f3` / 陸 `#ebede6`、`CITY_THEME` は undefined） |
| 道路の形が見やすい | OK（縁石で輪郭が出る） |
| 主道路/支線道路が区別できる | OK（半幅の差 + band ごとの出し分け） |
| 中景で白線が見える | OK（幅を画面 2px 相当へ合わせている） |
| 交差点が道路らしく見える | OK（停止線・推定横断歩道） |
| 高架/橋が判別できる | OK（`Y.roadBridge` へ持ち上げ + 太い縁石） |
| 建物名が残っている | OK（10 地点すべてで表示） |
| 駅名 / 町名 / 河川名 | OK |
| **JS 例外** | **0** |
| クリック等既存機能 | `BuildingNameStore` / 35S/35T/35U レイヤーとも健在 |

### 見え方の限界（隠さず記録する）

淀屋橋〜北浜のような **高層ビルが密集した街区を 35〜40° の俯角で見ると、道路そのものが
建物に隠れて**、白線もほとんど見えない（`4-major-road.jpg`）。
標示は作られている（同地点で白線 31,812 三角形）が、画面に出ていないだけ。
幅の広い道路や俯角の浅い視点では、はっきり読める（`3-intersection-close.jpg` /
`5-elevated-road.jpg`）。これは標示の問題ではなく視点の問題なので、
今回は誇張幅を上げて無理に見せることはしていない。

---

## §11 テスト

- 新規 `tests/mission35w-real-roads-original-ground.test.js` — **19 件 / fail 0**
  （地面が 35V 前と 1 行一致 / ネイビー残存なし / road base / lane marking / zoom 制御 /
  建物名ラベル維持 / geometry 非改変 / 1 道路 1 mesh でない / draw call 前後比較 /
  production・protected 未変更）
- `tests/mission35v-dark-ground-road-visual.test.js` — **9 件 / fail 0**。
  地面の検査は 35W へ **移した**（消してはいない）。35W 側は git 履歴と突き合わせるので
  元より強い条件になっている。35V にはラベル側の責務だけを残した。

---

## §0 production / protected

`public/osaka_3d_buildings.html` と `public/osaka_3d_buildings.fullward-v3.html` は変更なし
（`git diff HEAD` が空。テストでも `RoadDetailLayer` / `CITY_THEME` が入っていないことを検査）。
