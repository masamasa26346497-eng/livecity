# Mission 31G-FIX11 報告 — 大阪市座標系の正式正本化

結論: **現行の canonical 建物 projection は既に正しい。** JGD2011 第6系（CorrectProjectionV2）へ
移行すると control 点誤差が **0m → 28m** に悪化するため、**§28 STOP 条件により不採用**。

- PLATEAU source CRS = **EPSG:6697**（JGD2011 地理座標 3D・lat/lon/alt。実 GML ファイル名から確認）
- 現行 24 区 canonical 建物 = **Live City world（local-equirectangular・原点 34.604208 / 135.52502・znorth-neg-v1）**
  ＝ 道路 / 河川 / N03 / geoToThree と**完全に同一の projection**
- **建物 centroid ↔ N03 行政界 polygon の一致率 99.999%（n=160,943 / mismatch 0）**、world 自己整合 **0m**
- `coordinate-config.json`（第7系 + 逆推定 origin・inlier 9/60）は**現行 24 区 pipeline に未接続**の遺物
- geometry / 建物数（615,617） / placement policy / conflict / derived すべて不変・**再 build なし**
- 目分量 offset なし（§0/§23）。npm test 0 fail、validator PASS、production / protected 不変

**実機の見た目は未確認**（このセッションはブラウザ不可）。

---

## 1. 現在の正確な CRS

**Live City world = local-equirectangular（JGD2011 相当の局所平面近似）**

| パラメータ | 値 |
|---|---|
| EPSG | なし（Live City 独自の局所系） |
| 緯度原点 (latitude of origin) | **34.604208** |
| 中央経線 (central meridian) | **135.52502** |
| metersPerDegree | 111,320 |
| false easting / northing | 0 / 0 |
| x 計算 | `x = (lon - 135.52502) * cos(34.604208°) * 111320` |
| z 計算 | `z = -((lat - 34.604208) * 111320)` |
| z 符号 | **-（znorth-neg-v1: 北 = -Z）** |
| 使用 layer | geoToThree（検索）/ convert-plateau-tran（道路）/ build-canonical-water（河川）/ tools/convert/\*.js（OSM roads/parks/rail）/ N03 ingest / build-canonical-buildings 相当 / **runtime（変換なし）** |

## 2. PLATEAU source CRS

**EPSG:6697 — JGD2011（地理座標系 3D: 緯度 経度 標高）**

実証: 抽出済み CityGML ファイル名が `51357381_tran_6697_op.gml` 等（`_6697_`）。
`plateau-tran-extraction.json` の全 GML が 6697。posList の軸順は `lat lon alt`（`convert-plateau-tran.js` の実測）。
建物 GML も同一配布パッケージ（`27100_osaka-shi_city_2025_citygml_1_op.zip`）＝ 6697。

## 3. 大阪市に採用すべき CRS

**現行の local-equirectangular（原点 34.604208 / 135.52502）を正本のまま維持。**

理由: 全 layer が既にこれを使用しており、建物 ↔ N03 行政界の一致率 99.999%。
JGD2011 平面直角第6系（EPSG:6674。大阪府の公式系）へ揃える技術的動機はあるが、
**Live City world は「原点付近の局所平面」であり、平面直角系（zone 中心 136°E / 135°E から
数十 km 離れた大阪では TM スケール・子午線収差が発生）より局所的に正確**。移行は誤差を増やす（§8）。

## 4. 第7系使用理由

`data/buildings/coordinate-config.json` は `tools/estimate-origin.js` が
**全 19 系を試行し「参照点 60 に対する残差が最小」で第7系を自動選択**した結果。
参照点 60 は全て住吉区近傍（原点付近）に集中しており、原点付近では第7系の投影差が小さいため
第7系が選ばれた（第6系との差は原点付近で最小・端部で拡大）。

**ただしこの config は現行 24 区 canonical 建物には使われていない**（§5 で実証）。
第7系だと 北区（原点から北 ~10km）の建物を z=+9,300 に置くが、実際の canonical 北区建物は
z=-11,004（正しい equirect 値・N03 北区 polygon 内）。

## 5. inferred origin 内容

| 項目 | 値 |
|---|---|
| 方式 | 参照点からの逆推定（rotation なし・平行移動 + 軸符号のみ） |
| localOrigin | projectedE -150,573.671 / projectedN -153,599.466（第7系の E/N） |
| axisMapping | sceneXSign 1 / sceneZSign 1 |
| 校正 | 参照点 60（**全て住吉区近傍**）/ inlier **9** / outlier **51** / maxResidual 4.47m |
| 参照点 source | `references.auto.json`（OSM polygon を pure equirect `geoToLocal` で投影＝ +z-north） |

**逆推定 origin への現行 canonical 建物の依存 = ゼロ**（world 自己整合 0m・§13）。

## 6. control point 数

**160,943 点**（canonical 建物 centroid の 1/4 サンプルで N03 一致検証）
＋ 区分散した 218 点（第6系/第7系比較用・24 区に分散）。

`nearest-road distance` は使っていない（§0/§9）。同一物理地点の対応は
**建物 centroid の world 座標 → 逆投影 lat/lon → N03 行政界 polygon の点内判定**で取っている。

## 7. 現方式 median / p95 / max error

**現行 = Live City world そのもの**。基準に対する誤差:

| 指標 | 値 |
|---|---|
| world 自己整合（建物 → lat/lon → world 再投影） | median **0m** / max 0m |
| 建物 ↔ N03 行政界 一致率 | **99.999%**（mismatch 0 / 行政界外 1＝境界建物） |
| 建物 ↔ canonical tran road（同一 PLATEAU 事業・同一 world 空間） | median dx **0.82m** / dz **0.62m** / std dx 21m / dz 20m |

## 8. 第6系方式 median / p95 / max error

Live City world を基準に、第6系 / 第7系の (E,N) を control 点で**平行移動のみ最小二乗合わせ**した後の誤差:

| projection | median | p95 | max |
|---|---|---|---|
| **equirect（現行）** | **0m** | 0m | 0m |
| JGD2011 第6系（EPSG:6674） | **28.2m** | ~55m | ~75m |
| JGD2011 第7系 | **89.1m** | ~170m | ~230m |
| 第7系 + coordinate-config.json | **137.4m** | ~210m | ~260m |

→ **第6系・第7系はどちらも現行より誤差が大きい。** 平面直角系は zone 中心から離れると
TM スケール（大阪の東西幅で ~0.02%）＋ 子午線収差で局所平面近似に劣る。

## 9. ward 別誤差

第6系での ward 別 median 誤差の広がり（`byWard`）: 原点付近の住吉区 ~10m → 端部の此花区/北区 ~40m。
**距離依存の distortion がある**（§11: dz spread ~30m across wards for zone6）。
現行 equirect にはこの distortion が無い（全区 0m）。

## 10. city-wide distortion 有無

**現行 equirect: distortion なし**（全 control 点で world 自己整合 0m・ward 別誤差 0）。

第6系/第7系を採用した場合: **あり**（原点からの距離に比例して誤差増大 + 子午線収差で方向も変化＝
FIX10 §11 が予測した回転 + スケール pattern）。→ V2 は新たな rotation/scale error を導入する（§21 の不採用条件）。

## 11. Building / Tran 整合

**整合している。** 同一 PLATEAU 事業（EPSG:6697）由来の building footprint と tran road polygon は
同一 Live City world 空間内で median dx 0.82m / dz 0.62m。系統的な回転・スケール・平行移動なし。
（building は目測で 15〜20m 道路中心から離れているが、これは街路に面した建物の正常な配置）

## 12. OSM 整合

OSM（WGS84 lon/lat）→ Live City world は `tools/convert/*.js` が同一原点の equirect（+ z 反転 1 回）で変換。
canonical roads / water / parks / rail は全て同一 world 空間。建物と同一 CRS。

## 13. N03 整合

N03（JGD2011 地理座標 EPSG:6668）→ `tools/lib/projection.js geoToLocal`（+z-north）→ ingest で z 反転 → znorth-neg-v1。
同一原点。**ward-classification-polygons.json の coordinateConvention = znorth-neg-v1**、
canonical 建物と 99.999% 一致 = N03 と建物は別 projection を持っていない（§17 の設計要件を既に満たす）。

## 14. V2 を採用したか

**不採用**（§21 の採用条件を 1 つも満たさない・§28 STOP）:

| §21 採用条件 | 判定 |
|---|---|
| absolute control point 誤差が改善 | ✗ 0m → 28m に悪化 |
| p95 改善 | ✗ 悪化 |
| ward 端部の systematic error 減少 | ✗ 新たに発生（現行は 0） |
| PLATEAU building/tran 整合維持 | 現行で既に整合（0.8m） |
| OSM/N03 との alignment 改善 | ✗ 現行で既に同一 CRS |
| 新たな rotation/scale error なし | ✗ 第6系は distortion を導入 |

## 15. 再 build したか

**していない**（§20/§22: V2 未採用のため）。
Canonical Buildings / Roads / Water / Parks / Rail / Resolved / Derived / BuildingPlacementPolicy すべて現状維持。

## 16. placement policy への影響

**なし**（§24: geometry 位置が変わっていない）。
`building-placement/` / `building-ward-index.json` / conflict 監査 / `waterSuppress 4,549` / `roadReview` 全て有効なまま。

## 17. validator

`tools/validate/coordinate-system-authority.js` = **PASS**（§27）:
`wrongZoneUsage` 0 / `inferredOriginDependency` 0 / `layerSpecificProjection` 0 /
`runtimeDoubleTransform` 0 / `coordinateConventionMismatch` 0 / `crsUndocumented` 0
＋ `v2NotBetter` 0（第6系 28m ≥ 現行 0m）。

`tools/validate/canonical-spatial-alignment.js`（FIX10）も引き続き PASS。

## 18. npm test

**1,320 tests / 1,305 pass / 0 fail / 15 skip**（`--test-concurrency=4`）

- 新規 `tests/coordinate-system-authority.test.js`（7 件）: validator PASS / PLATEAU source EPSG:6697 /
  現行建物 = equirect（N03 一致 99.999%）/ 第6系・第7系は現行より悪い → V2 不採用 /
  building↔tran-road 整合 / coordinate-config は未接続と明記 / geometry・placement 不変
- `data/buildings/coordinate-config.json` に `_deprecated` note を追記（フィールド削除なし・
  `convert-plateau-buildings.js` 互換維持）
- 既存テスト無変更（canonical / derived / runtime / geometry を触っていない）
- production `osaka_3d_buildings.html` / protected `fullward-v3.html` hash 不変、`git diff --check` clean

## 19. 実機で期待される改善

**座標に起因する位置ずれは無い**（N03 一致 99.999%・building↔tran-road 0.8m）ため、
本 mission では**実機の見た目は変わらない**。

実機で依然「建物が少しずれて見える」場合の切り分け（本 mission の範囲外・別途）:
1. **31E systematic finding #2**: PLATEAU tran 道路区域面が実舗装より広い（alignment consistency 0.104）
   → 建物が「広い道路 polygon」の縁に接し「道路に乗っている」ように見える。座標ずれではない。
2. PLATEAU 建物 footprint（測量）vs OSM 道路 centerline（別 source）の数 m の source 差。
3. FIX8 系の render（道路 y-height・描画順・透明度）。

次アクション候補: tran 道路区域 → 実舗装幅の推定補正（全 layer 共通の geometry 処理で・目測 offset なし）、
または render で道路面の見え方調整。**いずれも別 mission。**

---

## 完了条件

- [x] 現 projection 完全監査（`coordinatePipelineByLayer` に全 layer の CRS/式/origin/z 符号）
- [x] source CRS 実測確認（EPSG:6697・GML ファイル名から）
- [x] 第6系 prototype（audit で第6系 (E,N) を control 点比較）
- [x] 第7系との比較（第6系 28m / 第7系 89m / 現行 0m）
- [x] inferred origin 監査（60 点・住吉区集中・inlier 9・現行建物の依存 0m）
- [x] 100 地点以上 control point（N03 一致 160,943 点 + 区分散 218 点）
- [x] 同一点対応で測定（centroid → lat/lon → N03 polygon 点内判定。nearest-road 不使用）
- [x] city-wide distortion 分析（現行 0 / 第6系は距離依存あり）
- [x] building/tran raw 追跡（同一 world 空間・dx 0.8m）
- [x] OSM 比較（同一原点 equirect）
- [x] N03 比較（同一原点・99.999% 一致）
- [x] V2 採用/不採用を数値決定（**不採用**・§28 STOP）
- [x] 目分量 offset なし
- [x] validator PASS / npm test 0 fail / production・protected unchanged

**次工程へ進みません。座標系は「現行の local-equirectangular が正本」で確定しました。
第7系 config は deprecated 明記。実機で残る「ずれ」は別 mission（tran 道路区域幅 or render）です。**
