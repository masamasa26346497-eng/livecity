# MISSION 33E — LANDMARK HIGH DETAIL LAYER（PoC: 大阪城）

**判定: `LANDMARK_HD_POC_SUCCESS`**（validator PASS・error 0・warning 0）

- 変更したのは **development の `public/osaka_3d_buildings.ward-ux-v1.html`** と、ランドマーク用の新規データ・ツールだけです。
- canonical building geometry / building position / projection / OSM fallback V2 / ROAD V3 / water / rail / parks / placement / canonicalId は**不変**。
- **production / protected は未変更**。実機確認後に次段階へ進みます。

---

## 1. 追加したレイヤー構成

```
canonicalRoot
├── CanonicalRuntimeRoot（既存: CR_water / CR_roads / CR_buildings / CR_parks / CR_rail）
└── LandmarkHDLayer                     ← 今回追加（runtime owner = CANONICAL）
    └── LandmarkHD_osaka-castle
        ├── LandmarkHD_osaka-castle_stone    （石垣・天守台・城門の基壇）
        ├── LandmarkHD_osaka-castle_wall     （漆喰の白壁）
        ├── LandmarkHD_osaka-castle_roof     （瓦屋根・軒）
        ├── LandmarkHD_osaka-castle_trim     （金の装飾）
        └── LandmarkHD_osaka-castle_outline  （城域の範囲帯）
```

| 項目 | 内容 |
|---|---|
| 通常建物との関係 | **完全に別レイヤー**。`CanonicalRuntime` の建物生成ロジックは変えていません |
| 旧 `LandmarkLayer`（Mission11B の低ポリ procedural 3 件） | **そのまま残置**（削除も無効化もしていません） |
| 配置 | `canonicalRoot` 直下。`tagRuntimeOwnerRecursive(group, RUNTIME_OWNER.CANONICAL)` で owner を付与 |
| legacy residual | レイヤー名が `COEXIST_NAME`（`/^Landmark/`）に合致するため共存扱い。実測 residual = **0** |
| geometry の持ち方 | ビルド時に焼き込み（`tools/build-landmark-models.js`）。HTML 側にランドマーク名も寸法も持たせていません |
| デバッグ API | `window.__LANDMARK_HD_DEBUG__()` / `__LANDMARK_HD_TOGGLE__(bool)` |

## 2. 対象ランドマークの管理（`landmark-models.json`）

`public/map-data/osaka-city/landmarks/landmark-models.json`（127 KB）。初回は大阪城 1 件のみ。

| 必須項目 | 大阪城の値 |
|---|---|
| `landmarkId` | `osaka-castle` |
| `name` / `nameEn` | 大阪城 / Osaka Castle |
| `anchor` | x 76.58 / z −9257.92 |
| `extent` | x −423.8〜543.3 / z −9671.2〜−8750.5 / maxY 55.5（城門・城域ラインを含む） |
| `sourceType` | `procedural-from-osm-and-plateau` |
| `swapRadiusM` | 900 |
| `visibleDistanceM` | 2600 |
| `pickCanonicalId` | `cg_bldg_bldg_41117eae-5c12-40c2-8d1a-9461b8db7784` |
| `suppressBuildingIds` | 同上 1 件 |
| `suppressExtent` | 52.3〜99.9 × −9283.7〜−9232.0（天守の周りだけ。47×52 m） |
| `parts` | material 別に positions / indices / triangleCount |
| `sources` | 各寸法の出所（下記 §5） |

## 3. 大阪城に使ったモデル / 形状ソース

`tools/audit/osaka-castle-source-scan.js` でリポジトリ内の実データを調べた結果（新規のネットワーク取得はしていません）。

| 部位 | 出所 | 実データの内容 |
|---|---|---|
| 天守の平面形 | **OSM way/34619038「大阪城」** | 9 頂点・1,556 m²・`historic=castle`・`building:levels=8`・`height=58`・`start_date=1583` |
| 天守台（石垣）の平面 | **canonical V2N `cg_bldg_bldg_41117eae…`** | 8 頂点・1,756 m²（LOD1 の箱＝天守台を含む外形） |
| 全高 | **PLATEAU 実測 measuredHeight = 53.2 m** | anchor から 7.1 m の棟。OSM の `height=58` と突き合わせ済み |
| 城門 4 棟 | **OSM `historic=city_gate`** | 大手門(50 m²) / 桜門(52 m²) / 青屋門(239 m²) / 北仕切門(26 m²) |
| 城域の外郭ライン | **OSM way/1550234049 `historic=castle`** | 36 頂点・576,089 m² |
| 内堀・外堀 | **canonical water（既存）** | 内堀 38,008 m² / 北外堀 39,737 / 東外堀 34,875 / 西外掘 45,829 / 南外堀 62,971。**今回は何もしていません**（33C 以前から water レイヤーが描画済み） |

**天守閣の同定**: `landmarks.json` の大阪城は `resolved: false`（V1 区別 building dataset との照合に失敗）でしたが、canonical V2N を調べ直すと **anchor から 7.1 m・高さ 53.2 m・面積 1,756 m²** の棟が 1 件だけあり、OSM の bbox（41×45 m）と実測 bbox（43.5×47.7 m）も一致しました。半径 200 m 内で 20 m を超える棟はこれと消防・警察(24 m)の 2 件だけで、距離・高さ・平面のすべてが一致するのはこの棟のみです。

### 実データと様式化の切り分け

| | 内容 |
|---|---|
| **実データ** | 天守の平面形・天守台の平面形・全高 53.2 m・城門 4 棟の位置と平面・城域ライン |
| **様式化（実測値ではない）** | 全高を「天守台 : 天守 = 0.27 : 0.73」に分ける比率、5 層の積み方、軒の出（平面比 0.20）、軒の垂れ（全高比 0.042）、最上層の屋根勾配（全高比 0.160）、城門の高さ 9 m |

様式化パラメータは `CASTLE_STYLE` に集約し、**生成した JSON 自身の `sources.stylized` にも note 付きで記録**しています（「これらの実測値はリポジトリ内に無い。測量値として主張しない」）。見える屋根の段数を 5 としたのは、OSM の `building:levels=8`（8 階）＝ 5 層 8 階という構成に合わせたものです。

### モデルの規模

| material | 三角形 | 内容 |
|---|---|---|
| stone | 98 | 天守台・城門の基壇 |
| wall | 242 | 天守 5 層の白壁・城門 |
| roof | 353 | 各層の軒・寄棟屋根 |
| trim | 104 | 軒先と棟の金装飾 |
| outline | 420 | 城域の範囲帯 |
| **合計** | **1,217 三角形 / 1,024 頂点** | |

LOD1 の箱（8 頂点の押し出し ≒ 24 三角形）に対して **50.7 倍**の情報量です。

## 4. 表示の切替条件（§3）

```
HD を出す条件 = [LANDMARK HD] が ON
              かつ カメラ距離 cs.r <= visibleDistanceM（2,600 m）
              かつ 視点とランドマークの距離 <= visibleDistanceM × 2（5,200 m）
```

実測（大阪城を正面に置いてカメラ距離を変えたとき）:

| カメラ距離 | HD 表示 | LOD1 抑制 |
|---|---|---|
| 300 m | **ON** | 1 棟 |
| 600 m | **ON** | 1 棟 |
| 900 m | **ON** | 1 棟 |
| 1,800 m | **ON** | 1 棟 |
| 2,400 m | **ON** | 1 棟 |
| 3,200 m | OFF | **0**（従来表示へ戻る） |
| 6,000 m | OFF | **0** |

遠景では従来どおり canonical の LOD1 建物が出ます。市内の別地点（梅田・住吉）にいる間は視点距離の条件で外れるので、**読み込みも抑制も起きません**（draw call・三角形数とも HD ON/OFF で完全に同一＝実測で確認）。

## 5. 既存建物の抑制方法（§3）

**描画時にだけ効く仕組みで、canonical のデータには一切触れていません。**

1. HD がアクティブになると `LandmarkHDLayer` が `suppressBuildingIds` を内部 Map に入れ、`suppressVersion` を進めます。
2. `CanonicalRuntime` の buildings タイル生成ループが、`LandmarkHDLayer.isSuppressedBuilding(canonicalId)` の棟を **mesh に入れずスキップ**します（既存の placement policy `SUPPRESS` の判定は従来どおり残っています）。
3. スキップした棟の **footprint は `landmarkHdFp` に保持**します。クリック時の property card は従来どおり出せます（§6）。
4. 表示/非表示が切り替わった瞬間に `invalidateLandmarkHdTiles()` が、**ランドマークの extent に重なる buildings タイルだけ**を破棄して作り直します（タイルを二重キャッシュしません。hybrid road の既存手法と同じ）。

**二重表示していないことの実測**: 天守の真上から真下へ ray を撃って、当たった順に並べました。

| | 最前面から順に |
|---|---|
| HD **ON** | `LandmarkHD_…_trim` → `LandmarkHD_…_wall` → `LandmarkHD_…_stone` → …（**CanonicalRuntimeRoot の建物は 0 件**） |
| HD **OFF** | 通常の canonical 建物 mesh（**LandmarkHD は 0 件**） |

画面の色数も HD ON で **350 色** / OFF で **252 色**（320px 幅サンプル）と、見た目がはっきり変わっています。

## 6. Picking 対応（§6）

`pickHit()` の先頭で HD メッシュへ raycast し、当たったら `pickCanonicalId` から **既存の property card 用データをそのまま作って**返します（`CanonicalRuntime.buildingDataById()`）。card 側の計算ロジックは変えていません。

実測（天守の中心をクリック）:

| 項目 | 結果 |
|---|---|
| hover（ツールチップ） | 表示される ✓ |
| card | 表示される ✓ |
| card の canonicalId | `cg_bldg_bldg_41117eae-5c12-40c2-8d1a-9461b8db7784`（= `pickCanonicalId`）✓ |
| card の見出し | **「大阪城 ／ 大阪市中央区」**（バッジは「ランドマーク」） |
| 高さ / 階数 / 底面積 | 53.2 m / 8 階 / 1,756.3 m²（すべて実データ） |
| 仮の値（推定階数・想定賃料など） | **0 件** ✓ |

card の見出しだけ、ランドマークから開いたときに **実在する施設名（landmark registry 由来）** を出すようにしました。`landmarkName` が無い通常の建物は従来どおり用途名です。用途・高さ・面積などの中身は canonical のデータのまま変えていません。

`outline`（城域の範囲帯）は pick 対象から外してあり、地面をクリックしたときに城が選ばれてしまうことはありません。

## 7. 性能比較（§7）

各地点 15 秒・カメラ静止・タイル整定後。HD ON → OFF の順で同一セッション内で測定。

| 地点 | FPS (HD ON) | FPS (HD OFF) | draw call ON/OFF | 三角形 ON/OFF |
|---|---|---|---|---|
| 梅田 | 48.5 | 49.1 | 392 / 392 | 588,139 / 588,139 |
| 住吉 | 46.7 | 48.1 | 301 / 301 | 847,826 / 847,826 |
| **大阪城** | **59.5** | 59.7 | **204 / 199（+5）** | **539,062 / 537,877（+1,185）** |

- **HD 対象外の地点（梅田・住吉）は draw call も三角形数も完全に同一**です。近景でのみ読み込む設計どおり、他地点には何のコストも掛かりません。
- 大阪城でも draw call +5（material 5 種）・三角形 +1,185 のみで、FPS 差 0.2（測定ノイズの範囲）。
- JSON は 127 KB で、初回の 1 回だけ読み込みます。

## 8. Visual QA 結果

`data/reports/landmark-hd-qa/` にスクリーンショットを保存しました。

| ファイル | 内容 |
|---|---|
| `closeup-sw.jpg` / `closeup-s.jpg` / `closeup-e.jpg` | 近距離（r 170〜220 m）から見た天守。UI を隠して撮影 |
| `castle-near.jpg` / `castle-mid.jpg` / `castle-far.jpg` | r 320 / 900 / 2,400 m |
| `castle-hd-on.jpg` / `castle-hd-off.jpg` | 同一カメラでの ON/OFF 比較 |

目視での確認:
- **石垣の上に 5 層の白壁が積み上がり、各層に青緑の瓦屋根と金の軒先、頂部に寄棟屋根**という形で、大阪城と分かる輪郭になっています。
- 配色は Live City の明るいトーン（33A palette v2）に合わせた落ち着いた色で、周囲の建物（用途別の淡い色）や公園の緑から浮きません。
- 城門 4 棟が堀の内外に小さく建ち、城域の範囲帯が公園の地表に薄く出ます。
- 夜間は `PALETTE.night` に切り替わります（mesh は作り直さず色だけ差し替え）。

## 9. Validator — `data/reports/landmark-hd-poc-validation.json`

| 項目 | 値 |
|---|---|
| layerSeparated / runtimeOwnerTagged | **true / true** |
| suppressionIsRenderOnly | **true** |
| configComplete / provenanceOk | **true / true** |
| hdMoreDetailedThanLod1（detailRatio） | **true（50.7 倍）** |
| doubleDisplayCount | **0** |
| distanceSwitchWorks | **true** |
| pickingWorks / cardFakeValues | **true / 0** |
| uiToggle / pickingWired / noHardcodedLandmark | true / true / true |
| buildingMutation / roadMutation / projectionMutation | **0 / 0 / 0** |
| productionModified / protectedModified | **false / false** |
| errors / warnings | **0 / 0** |

## 10. npm test

- `npm test`: **1,813 tests / pass 1,798 / fail 0 / skip 15**（新規 `tests/landmark-hd-poc.test.js` 17 件）。
- lifestyle-tab 系（`npm test` 対象外）: 38 / pass 27 / **fail 0** / skip 11。
- 既存テストの更新は `tests/pre-production-cleanup.test.js` の 1 行のみ（card の見出しが「ランドマーク名 or 用途名」になったため。32Q の「地域名は実データがあるときだけ付ける」という趣旨はそのまま保っています）。

## 11. 既知の制約

1. **縦方向の比率は実測値ではありません。** 天守台と天守の比、層の積み方、軒の出、屋根勾配は様式化パラメータです。平面形と全高だけが実データです（設定 JSON の `sources.stylized.note` に明記）。
2. **城門の高さ 9 m は既定値です。** OSM の 4 門に高さタグがありません。平面と位置は実データです。
3. **石垣そのものは作っていません。** OSM の `barrier=wall` は 19 本・合計 975 m の断片で、大半が天守から 267 m 以上離れた不連続なもので、石垣として連なっていません。**実データが不連続なまま「石垣」として描くと実在しない壁を作ることになる**ため、今回は不採用としました。天守台の石垣のみ canonical の実 footprint から起こしています。
4. **破風（千鳥破風・唐破風）はありません。** PoC は silhouette 重視のため、屋根は寄棟の簡略形です。
5. **用途は PLATEAU の「大学（コード 422）」のままです。** これは元データの誤分類と思われますが、勝手に書き換えていません（card の見出しはランドマーク名を出すので実用上の混乱はありません）。
6. **`landmarks.json` の `resolved: false` は更新していません。** 今回 canonical V2N 側で天守棟を同定しましたが、registry の照合ロジック（V1 区別 dataset が対象）には手を入れていません。registry を直すなら別ミッションです。
7. **城域の範囲帯は「構造物」ではありません。** OSM `historic=castle` は城域の境界線であって石垣ではないため、高さ 0.25 m・幅 12 m の平らな帯に留めています。
8. **HD は 1 件のみ**（PoC）。2 件目以降は `landmark-models.json` に追加するだけで動きますが、形状生成は大阪城向けに書いたものなので、別のランドマークには別の生成コードが要ります。

## 12. 生成物

| 種別 | パス |
|---|---|
| 変更したファイル | `public/osaka_3d_buildings.ward-ux-v1.html`（development のみ） |
| データ | `public/map-data/osaka-city/landmarks/landmark-models.json`（`data/processed/osaka-city/landmarks/` にも同内容） |
| ツール | `tools/audit/osaka-castle-source-scan.js`（実データ調査）、`tools/build-landmark-models.js`（設定＋geometry 生成）、`tools/audit/landmark-hd-qa.js`（実ブラウザ QA・`npm run preview` 必須） |
| Validator | `tools/validate/landmark-hd-poc.js` |
| テスト | `tests/landmark-hd-poc.test.js`（npm test に登録） |
| レポート | `data/reports/{osaka-castle-source-scan,landmark-models-build,landmark-hd-qa,landmark-hd-poc-validation}.json`、`data/reports/landmark-hd-qa/*.jpg` |

production へはまだ反映していません。実機で `[LANDMARK HD]` トグルと大阪城の見え方・クリックを確認いただき、問題なければ次段階へ進みます。

`LANDMARK_HD_POC_SUCCESS`
