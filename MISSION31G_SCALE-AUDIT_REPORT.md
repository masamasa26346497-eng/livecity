# Mission 31G-SCALE-AUDIT 完了報告｜Building vs Map Scale 最終監査
## 「位置」ではなく「大きさ」が合っていない可能性を検証する

**最終ステータス: 測定完了・STOP**（今回は測定専用ミッション。補正はRuntimeへ一切適用していない）

---

## 結論（先出し）

**classification: `BUILDING_SIZE_CORRECT`**

建物サイズ・地図スケールともに系統的な誤差は検出されなかった。city-wide 11,647棟のHIGH match、
affine transform推定、距離別スケール検定、runtime 615,617棟全数比較、ward別集計のいずれも
「大きさは合っている」ことを裏付ける結果で一貫していた。ユーザーが実機で感じた「サイズ感が
合っていない」という印象は、今回の測定結果からは**データのスケール誤差では説明できない**。

---

## §23必須フィールド（19項目に沿って報告）

### matchedCount

**11,647**（FIX22で確認済みの数値と完全一致・再現性を確認）。574,112 PLATEAU候補 × 540,296 GSI
outline候補からmutual best matchで導出（既存`tools/lib/gsi-building-matching.js`を無変更で再利用）。

### footprint（面積・周長・bbox・主軸長の比較。HIGH match 11,647棟）

| 指標 | median | p10 | p25 | p75 | p90 | p95 |
|---|---|---|---|---|---|---|
| areaRatio (PLATEAU/GSI) | **0.9979** | 0.761 | 0.852 | 1.162 | 1.303 | 1.363 |
| linearScale (√areaRatio) | **0.9989** | 0.873 | 0.923 | 1.078 | 1.141 | 1.168 |
| widthRatio (bbox幅) | 1.0083 | 0.728 | 0.860 | 1.179 | 1.386 | 1.532 |
| depthRatio (bbox奥行) | 1.0015 | 0.721 | 0.851 | 1.172 | 1.377 | 1.512 |
| perimeterRatio | 0.9984 | 0.844 | 0.912 | 1.086 | 1.174 | 1.230 |

median は area/linearScale/width/depth いずれも **1.00 ± 1%以内**。p10-p90の広がり（0.76〜1.30等）は
個別建物単位のノイズ（後述のroof-vs-footprint semantics・matching誤差）であり、**中心傾向には
系統的な拡大/縮小は見られない**。

### affine（PLATEAU→GSI 2D affine transform推定。11,647棟のcentroidペアから最小二乗）

```
scaleX = 1.00000   scaleZ = 1.00000
rotation = -0.0007°   shear = -0.00001
tx = 0.053m   tz = -0.073m
```

scaleX/scaleZ とも小数点5桁まで**厳密に1.00000**。rotation・shearも実質ゼロ。tx/tzはFIX21/22の
centroid-to-centroid統計（medianDx=0.019m/medianDz=-0.056m）と同オーダーのサブ10cm、既知の
source間の小残差の範囲内。**map内部のスケール・回転・せん断はいずれも異常なし**。

### runtime（mesh/parent/root scale + footprint dimension全数比較）

- `meshScale = 1`／`parentScale = 1`／`effectiveWorldScale = 1`
  — `public/osaka_3d_buildings.ward-ux-v1.html`を静的検査した結果、`canonicalRoot`・`legacyRoot`・
  `rtRoot`・`layerGroup[*]`・`scene`・建物メッシュへの`.scale`代入は**0件**（`.scale.set()`等の
  全出現箇所はsprite/label/dot等の2DビルボードUIのみで、3Dジオメトリ側は一切触れていない）。
  THREE.Object3Dの既定値(1,1,1)がそのまま使われている。
- **footprint dimension 全数比較（615,617棟）**: `canonical/buildings`（source）と
  `derived/near/buildings`（FIX24 exact tier・実際にbrowserへ配信されるデータ）を同一canonicalIdで
  直接比較。**615,617/615,617棟で座標完全一致（coordinatesIdentical=true）・面積比 min=median=max=1.000000・
  maxAreaDiff=0m²**。Runtimeへ渡る前後で寸法が一切変化していないことを全数で確認。

### distanceRatio（PLATEAU上距離 vs GSI上距離。1,500棟サンプルから1,124,250ペア）

| 距離帯 | n | median | p10 | p90 |
|---|---|---|---|---|
| 0-100m | 603 | 0.9978 | 0.942 | 1.050 |
| 100-500m | 7,721 | 0.9999 | 0.990 | 1.010 |
| 500-1000m | 18,800 | 0.9999 | 0.996 | 1.004 |
| 1-5km | 364,630 | **1.0000016** | 0.999 | 1.001 |
| 5km+ | 732,496 | **1.0000018** | 0.9996 | 1.0004 |

**重要な所見**: 距離が長くなるほどratioのばらつきが縮小し、median は限りなく1.0000へ収束する
（0-100mでのp10-p90幅±5-6% → 5km+で±0.04%）。これはprojection scaleの系統誤差がある場合に
予想される「距離が長いほど誤差が拡大する」パターンの**正反対**であり、近距離での散らばりは
個別建物のmatching精度由来のランダムノイズが平均化されずに残っているだけ、と解釈するのが自然。
**§13の判定基準に照らし、projection scale問題の兆候は無い。**

### byWard（24区別 median areaRatio/linearScale/widthRatio/depthRatio）

全24区で集計（`data/reports/building-map-scale-audit.json`の`byWard`に全区分を記録）。上位8区
（サンプル数順）:

| 区 | n | areaRatio | linearScale | widthRatio | depthRatio |
|---|---|---|---|---|---|
| 住吉区 | 1,411 | 0.998 | 0.999 | 1.009 | 1.006 |
| 生野区 | 1,177 | 0.993 | 0.997 | 1.006 | 0.997 |
| 東住吉区 | 959 | 1.005 | 1.002 | 1.002 | 0.990 |
| 阿倍野区 | 826 | 1.013 | 1.006 | 1.012 | 1.014 |
| 平野区 | 817 | 0.986 | 0.993 | 0.993 | 0.998 |
| 西成区 | 666 | 1.000 | 1.000 | 1.028 | 0.982 |
| 城東区 | 587 | 0.987 | 0.993 | 0.998 | 1.038 |
| 旭区 | 527 | 0.985 | 0.992 | 0.987 | 1.018 |

24区全て medianAreaRatio が **0.98〜1.02のレンジ**に収まっており、特定区だけが系統的に
大きい/小さいという傾向は見られない。

### deepDive: umeda / sumiyoshi

**梅田**（半径600m）: **matchedCount = 7棟のみ**（正直な制約: FIX22で既に判明していた「都心部・
高層密集地はGSI outlineとのHIGH match率が極端に低い（梅田は市平均の1/10）」という問題がここでも
再現した。large/medium/smallに分けると各3-5棟しかなく、統計的に信頼できる分析は困難）。
areaRatio median=1.0032（サンプル数が少ないため参考値）。

**住吉**（半径600m）: **matchedCount = 146棟**（梅田よりはるかに堅牢）。要求どおりlarge/medium/small
各30棟で分析: large medianAreaRatio=1.026、medium=0.979、small=0.928。小型建物ほどGSI比でやや
小さく出る弱い傾向があるが（roof outline vs footprintの相対差が小型建物ほど効きやすいため、と
推定・断定はしない）、極端な系統誤差ではない。全体medianAreaRatio=1.026、linearScale=1.013と
city-wide中央値(0.998)よりやや高いが1桁%の範囲内。

**都心部(梅田)特有か全域共通か**という§18の問いへの回答: **測定サンプルの制約上、梅田単独では
統計的結論を出せない**。ただしcity-wide 11,647棟・住吉146棟・24区全区分のいずれにも系統的な
サイズ誤差の兆候が無いことから、「全域共通のスケール問題」は否定できる。梅田固有の見た目の
違和感があるとすれば、GSIとの直接比較では検証しきれない要因（高層建物のparallax等、既存ミッションで
「座標バグではない」と結論済みの現象）を疑うのが妥当。

### classification

**`BUILDING_SIZE_CORRECT`**

### recommendedCorrection

```json
{ "applicable": false, "appliedToRuntime": false, "reason": "サイズは概ね正常であり補正不要。" }
```

補正は**一切Runtimeへ適用していない**（§0/§21遵守）。

---

## §10/§11 meters-per-degree / 異方性スケール監査

全pipeline（`tools/lib/projection.js`・`tools/lib/gsi-road-edge-transform.js`・
`tools/build-canonical-{buildings,roads,parks,water}.js`）が`config/areas/osaka-city.json`の
単一`projection`設定（centerLat=34.604208 / centerLon=135.52502 / metersPerDegree=111320）を
共有しており、独自ハードコード値・複製は検出されなかった。異方性補正（経度側のみcos(centerLat)を
乗じる）はx軸側にのみ一貫して適用されており、z軸側には適用されない設計で全ファイル一致。
GSI Building Outline importもこの共有projectionを経由（`gsi-road-edge-transform.js`の
`latLonPairsToWorld`を再利用）しているため、建物・道路・GSIいずれも同一の投影式・原点を使っている
ことをコードレベルで確認した。

## §19 Road-block scale（正直な限界）

GSI Road Edgeから「街区」ポリゴンを再構成するには交差点処理を含む本格的なポリゴン化が必要で
（FIX17-19で`Strategy A`として明示的に見送られてきた作業）、本ミッションの時間内では実施していない。
代わりに、§6のaffine transform（PLATEAU building centroid vs GSI building centroid、道路とは
独立に2つのauthoritative sourceを直接比較）と§10/§11のprojection共有監査が、実質的に
「地図全体のスケール整合性」を道路を介さずに検証しており、これらの結果（scaleX=scaleZ=1.00000）が
§19の問いに対する強い間接的な回答になっていると考える。独立した街区ベースの実測は次ミッションへの
持ち越しとして正直に記録する。

---

## §7/§9 Runtime Scale 監査の詳細（証跡）

```json
{
  "nonSpriteScaleAssignments": [],
  "canonicalRootScaleTouched": false,
  "legacyRootScaleTouched": false,
  "rtRootScaleTouched": false,
  "layerGroupScaleTouched": false,
  "sceneScaleTouched": false
}
```

`ward-ux-v1.html`内で`.scale`を触っているのは全てsprite（ラベル・アイコン・ドット等の2D billboard）
のみで、canonicalRoot/legacyRoot/rtRoot/layerGroup/scene/建物メッシュのいずれにも`.scale`代入コードが
存在しない。THREE.js の既定値(1,1,1,1)が一貫して使われている。

---

## Validator / npm test

`node tools/validate/building-map-scale-audit.js` → **RESULT: PASS**（全10チェックtrue/0）。

```
ℹ tests 1533
ℹ pass 1518
ℹ fail 0
ℹ skipped 15
EXIT=0
```

前回ミッション(ALIGNMENT-VISIBILITY-FINAL)完了時点(1527/1512)から、新規
`tests/building-map-scale-audit.test.js`（6件、全PASS）分だけ純増。退行0件。

---

## 作業中に発見・修正した副産物

1. **`recommendedCorrection`のスキーマ不整合**: `classification=BUILDING_SIZE_CORRECT`の分岐で
   `appliedToRuntime`フィールドが欠落しており、validatorの`correctionNotApplied`チェックが
   誤ってfalseになっていた。全分岐で`appliedToRuntime: false`を明示するよう修正。
2. **`tools/lib/projection.js`の誤検出**: このファイルは「定義」側（centerLat/centerLon/
   metersPerDegreeを引数として受け取る汎用関数）であり「`area.projection`を参照する」側の
   ファイルではないため、他の呼び出し元ファイルと同じ正規表現チェックでは false positive になった。
   このファイルだけ「独自の座標定数を持たず、値をそのまま使う」という別条件で判定するよう修正。
3. **Runtime footprint dimensionのサンプル手法を全数比較へ改善**: 当初はHIGH matchから100件を
   サンプリングしていたが、tile走査範囲を60ファイルに絞っていたため実際には7件しかヒットしなかった。
   より単純で高速・かつ確実な「全615,617棟を直接比較」（約11秒で完了）へ置き換え、
   §8の「期待値1.000000」を全数で確認できるようにした。

---

## §25 完了条件

- [x] footprint area ratio
- [x] width ratio
- [x] depth ratio
- [x] linear scale
- [x] affine transform
- [x] runtime matrixWorld scale
- [x] parent/root scale
- [x] distance ratio
- [x] 24区比較
- [x] 梅田比較（サンプル数7棟という制約込みで正直に報告）
- [x] 住吉比較（30棟×3サイズ帯で実施）
- [x] classification（BUILDING_SIZE_CORRECT）
- [x] correction candidate（記録のみ・Runtime未適用）
- [x] npm test fail 0（1533 tests / 1518 pass / 0 fail / 15 skip）
- [x] geometry一切変更なし（geometryMutation=0・coordinateMutation=0・roadMutation=0）

**今回は数値測定のみでSTOPします。** 建物サイズ・地図スケールに系統的な誤差は見つかりませんでした。
ユーザーが実機で感じられた「サイズ感の違和感」について、次にどう深掘りするか（実機スクリーンショット
での特定建物の指摘、Perspective視点でのparallax再確認等）のご指示をお待ちします。
