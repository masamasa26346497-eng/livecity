# MISSION 32Q — PRE-PRODUCTION CLEANUP

**判定: `PRE_PRODUCTION_CLEANUP_SUCCESS`**（validator PASS・error 0）

- **対象:** 残課題 3 点（Legacy residual / property card の固定表示 / SUPPRESS 2 棟）だけ。
- **変更したファイル:** development 用の `public/osaka_3d_buildings.ward-ux-v1.html` と、V2N の placement のうち 1 tile + manifest（区インデックスの集計を含む）。
- **変更していないもの:**
  - Building V2 / OSM fallback V2 / ROAD V3 / projection / origin / 区の割当
  - placement 全体（再生成していない）
  - production / protected

---

## 1. Legacy residual 4 の正体（実ブラウザ・実コードで特定）

4 件とも、Scene 直下の**無名 Group**にぶら下がっていました。`runtimeOwner` と `datasetId` はどちらも無く、4 件とも見える状態・視錐台内で、**実際に描画されていました**（`onAfterRender` で確認）。

| # | geometry | 頂点数 | material | 生成元（コード） |
|---|---|---|---|---|
| 1 | Mesh | 7,629 | MeshStandardMaterial #969b99 opacity 1 | `ParkingLayer`（駐車場の舗装面。`PARKING_STYLE.color`） |
| 2 | Mesh | 31,542 | MeshStandardMaterial #f2f2ee opacity 1 | `ParkingLayer`（駐車場の白線。`PARKING_STYLE.lineColor`） |
| 3 | Mesh | 657 | MeshStandardMaterial 頂点カラー opacity 0.93 | `CemeteryLayer`（`createSacredLayer` の面） |
| 4 | LineSegments | 562 | LineBasicMaterial #9aa39c | `CemeteryLayer`（敷地の縁取り。`SACRED_STYLE.edgeColorReal`） |

- **レイヤー統計との突き合わせ:** `ParkingLayer.getStats().vertices` = 39,171 = 7,629 + 31,542。`CemeteryLayer.getStats().vertices` = 657。
- **データの出所:** どちらも HTML に埋め込まれた旧 3 区データ（`OSM_PARKING` 102 件 / `OSM_CEMETERY` 31 件）。原点付近約 6 km 四方で、仮説どおり「旧 3 区の埋め込み地図」に由来していました。
- **ずれていた原因:** 他の旧レイヤーは `legacyRoot` 配下に置かれ、canonical 所有中は `legacyRoot.visible=false` で消えます。この 2 レイヤーだけは `scene.add(group)` で Scene 直下に置かれていたため、canonical 表示でも残っていました。

**residual には数えられていなかった見えている object も、すべて特定しました。**

| 見え方 | 正体 | 分類 |
|---|---|---|
| 小さな mesh（茶・緑） | 樹木 `TreeLayer` | 共存を許可（`COEXIST_NAME` の Tree） |
| 小さな mesh（#a8b0b8） | 屋上設備 `RooftopLayer` | **legacy**。旧建物 `BLDGS` の屋根に置く InstancedMesh なので、canonical 表示では旧建物の位置に浮く |
| Sprite | 施設・地名・区名・駅名ラベル | 共存を許可 |

## 2. 修正方法（§4）

**旧レイヤーを `legacyRoot` 配下へ移しました。** canonical 所有中は非表示、Legacy 表示では従来どおり表示されます。

- 対象: `ParkingLayer` / `CemeteryLayer`・`TempleLayer`（`createSacredLayer`）/ `RooftopLayer`
- 同じ性質で現在は空の `SchoolLayer` / `WaterLayer` も合わせて移しました。
- 変更内容:
  - `scene.add / remove / children.includes(group)` を `legacyRoot.*` に置き換えた。
  - group に名前を付け、`RUNTIME_OWNER.LEGACY` タグを付けた。
- **除外リストで隠すことはしていません。** `COEXIST_NAME`（診断の除外リスト）には何も足していません。
- Legacy 表示へ戻すと、駐車場と墓地は `legacyRoot` 配下で表示されることを実ブラウザで確認しました。
- 共存レイヤー（`TreeLayer`、`FacilityLayer`、`LabelLayer`、`WardLabelLayer`、`StationLabelLayer`）は**名前を付けただけ**で、表示は変えていません。
- **status（§14）:** self-check 済みで residual が 0 のときは `[CANONICAL OK]` と表示するようにしました。未検証の間は従来どおり `[CANONICAL]` です。

## 3. residual before / after（実ブラウザ）

| 状態 | before | after |
|---|---|---|
| 起動直後（東住吉区） | **residual 4** / 見えている legacy object 4 / status `[CANONICAL ERROR]` | **0 / 0** / status `[CANONICAL OK]` |
| 梅田（北区） | 4 / 4 | **0 / 0** |
| City Mode | 4 / 4 | **0 / 0** |
| V1 → V2 → V2N 切替 | — | 0 / 0 |
| Map Audit ON→OFF 後 / Reference Alignment ON→OFF 後 / 100m ruler 後 | — | 0 / 0 |

**起動後の status の表示:**
- `[CANONICAL OK]`
- `Buildings: V2 CORRECTED + OSM V2`
- `Count: 600,764　Placement: V2`
- `Road: ROAD V3　Raw GSI Edge: OFF`
- `Legacy residual: 0`
- `Canonical ready`

**32Q 前の HTML との同一条件比較:** residual 以外は同じでした。City Mode（FAR 帯）で `canonicalMesh.parks` と `rail` が 0 になるのは、32Q 前の HTML でも同じで、以前からの挙動です。

## 4. property card 固定表示の原因

`showPropertyCard()` に次の直書きがあり、どの建物のタイトルにも「／ 南港南エリア」が付いていました（旧 3 区時代の名残）。

```js
document.getElementById('pc-title').textContent = usageDisplayName(d) + ' ／ 南港南エリア';
```

## 5. property card 修正

`propertyAreaLabel(d)` を追加しました。実データがあるときだけ地域を付けます。

1. 旧埋め込み建物: 区名 + 町丁目
2. canonical 建物: `wardId`（N03 2026）から「大阪市◯◯区」
3. 区名だけ

どれも無ければ、「／」を含めて地域部分を出しません（§8）。

## 6. 6 地点の card QA（実ブラウザで真上からクリック）

| 地点 | 選ばれた建物（期待どおり） | タイトル |
|---|---|---|
| 梅田 | ✔ | 事務所 ／ **大阪市北区** |
| 本町 | ✔ | 官公庁 ／ **大阪市中央区** |
| 難波 | ✔ | 事務所 ／ **大阪市浪速区** |
| 天王寺 | ✔（地点は阿倍野区側） | 事務所 ／ **大阪市阿倍野区** |
| 住吉 | ✔ | 大学 ／ **大阪市住吉区** |
| 東淀川 | ✔ | 飲食店 ／ **大阪市東淀川区** |

- 6 地点とも、「南港南エリア」は出ず、地域名はその建物の N03 の区と一致しました。hover の tooltip も表示されました。
- 画像は `data/reports/pre-production-cleanup-qa/card-*.jpg`。
- 開発用 status パネルを一時的に隠して撮った版は `card-umeda-panel-hidden.jpg` と `card-higashiyodogawa-panel-hidden.jpg`。

## 7. SUPPRESS 2 棟の個別判定

| | A 港区 / 尻無川 | B 住之江区 / 貯水池 |
|---|---|---|
| canonicalId | `cg_bldg_bldg_a3de3906-…6d780305bc87` | `cg_bldg_bldg_a29b4ebd-…2df56d3c94ba` |
| source | PLATEAU（class 3001・用途 461 事務所） | PLATEAU（class 3001・用途 461 事務所） |
| 面積 | 22 m² | 17 m² |
| 高さ | 4.3 m（計測値・2017 年調査） | 計測なし（-9999。表示は既定 3 m） |
| OSM の建物 | 無し（最寄りの OSM 建物まで 14 m） | 無し（6 m と 24 m 先に、PLATEAU の高さ付きで取り込まれた OSM 建物がある。この 1 棟だけ無い） |
| OSM の水辺構造 | **係留場所 `seamark:type=berth`（N.1）が 18 m 先** | 無し（`natural=water water=basin` の内側） |
| GSI の建物 | 無し | 無し |
| 水域との重なり | 100%・岸から 4.8 m（尻無川） | 100%・岸から 9 m（basin） |
| 分類 | BUILDING_SOURCE_CONFLICT | BUILDING_SOURCE_CONFLICT |
| **判定** | **REVIEW に変更（表示）** | **SUPPRESS を維持** |

- **A を REVIEW にした理由:** 近くに係留施設があり、桟橋や浮き桟橋の上の小さな事務所である可能性を否定できません。§11 の「OSM なし」には当たりません。実ブラウザでは、川岸に並ぶ小さな構造物の列の中に表示され、クリックで選択・card 表示ができました。
- **B を SUPPRESS のままにした理由:** OSM なし、GSI なし、水面比 100%（岸から 9 m）、17 m² の小規模構造物で、§11 の条件をすべて満たします。実ブラウザでも非表示で、選択もされませんでした。

**反映方法**
- `tools/apply-placement-overrides.js` で、対象 tile 1 つと manifest の集計だけを書き換えました。placement 全体は再生成していません（manifest の生成時刻は 32P のまま）。
- 根拠は `data/processed/osaka-city/v2-final/placement-overrides.json` に残しました。
- **placement:** DISPLAY 600,567 / **SUPPRESS 1** / **REVIEW 100** / EXEMPT 96。
- 区インデックスは集計（renderable / suppress）だけを更新しました。区ごとの建物数は変わっていません。

## 8. Validator — `data/reports/pre-production-cleanup-validation.json`

| 項目 | 値 |
|---|---|
| buildingV2Mutation / roadV3Mutation / projectionMutation | 0 / 0 / 0 |
| legacyResidual / visibleLegacyObjects | **0 / 0**（上の 11 状態すべて） |
| propertyAreaHardcodeRemoved | true |
| suppress2Reviewed | true |
| productionModified / protectedModified | false / false |
| 追加で確認した項目 | 区の割当に変化なし、placement は再生成していない、回帰 OK、ブラウザ例外 0 |

- **warning 1 件:** 「南港南エリア」が検索メッセージ（「◯◯は南港南エリアの 3D データ範囲外です」）に残っています。property card ではないので今回は変更していません。
- 32P の validator も再実行し、PASS でした。

## 9. npm test

- `npm test`: **1,722 tests / pass 1,707 / fail 0 / skip 15**。追加は `tests/pre-production-cleanup.test.js`（6 件）。
- `showPropertyCard` を変更したので、`npm test` 外の lifestyle-tab テストも実行し、fail 0 でした。

## 10. production / protected

**変更なし**（git status でも validator でも確認）。

---

## 今回は触っていないが、production 切替の前に知っておいてほしいこと

1. **開発用 status パネルが property card を覆う。**
   - パネル（`canonical-runtime-status`、z-index 99997、31G-FIX19C で最前面にしたもの）が、画面右上の card（z-index 99995）の上に重なります。card は表示・選択とも正常ですが、パネルに隠れて見えません。
   - 以前からの重なりで、今回の 3 課題の範囲外なので変えていません。
   - production 切替のときに、このパネルを通常ユーザーに出すかどうかと合わせて決めてください。
2. **card の「最寄駅」が実際の所在と合わない。** 梅田の建物で「弁天町駅（徒歩12分）」と表示されます。`buildPropertyData` の旧ロジックによるもので、今回は触っていません。
3. **検索の範囲外メッセージに「南港南エリア」が残っている**（上記の warning）。

## 生成物

| 種別 | パス |
|---|---|
| レポート | `data/reports/legacy-residual-probe-before.json`、`legacy-residual-probe-after.json`、`pre-production-cleanup-qa.json`、`pre-production-cleanup-validation.json`、`data/reports/pre-production-cleanup-qa/*.jpg` |
| 個別判定の根拠 | `data/processed/osaka-city/v2-final/placement-overrides.json` |
| ツール | `tools/audit/legacy-residual-probe.js`、`tools/audit/pre-production-cleanup-qa.js`（どちらも `npm run preview` が必要）、`tools/apply-placement-overrides.js`、`tools/validate/pre-production-cleanup.js` |
| 変更 | `public/osaka_3d_buildings.ward-ux-v1.html`、`derived-v2-osmv2/building-placement/{manifest, tile_-13_-11}.json` と `building-ward-index.json`（data と public）、`data/reports/v2-placement-policy.json`（個別判断を追記） |

production への昇格はしていません。次の Mission で production cutover だけを行う想定です。

`READY_FOR_PRODUCTION_CUTOVER`
