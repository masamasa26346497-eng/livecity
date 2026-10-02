# Mission 31C2 Runbook — PLATEAU tran:Road 取得 → Canonical Roads Polygon 化

現状: **完了**。`data/reports/plateau-tran-acquisition-status.json` = `READY-FOR-POLYGON-FIRST`、
canonical roads は polygon-first（199,658 feature 中 198,266 が PLATEAU tran 道路区域面）。

このドキュメントは再実行手順と、実データで確定した仕様のリファレンス。

---

## 0. 取得経路（2 通り）

このサンドボックスは**ネットワーク不可**なので、実際に使ったのは **A（ローカル配布 ZIP からの展開）**。

### A. 配布 ZIP から展開（ネットワーク不要・今回採用）

```bash
node tools/extract-plateau-tran.js \
  --zip "C:/Users/user/OneDrive/ドキュメント/LiveCity/27100_osaka-shi_city_2025_citygml_1_op.zip"
# --list を付けると展開せず一覧のみ
```

- ZIP 7,152 エントリのうち `udx/tran/*_tran_6697_op.gml` **288 file / 495.5MB** を
  `data/raw/plateau/osaka-city/tran/` へ展開し、`codelists/*.xml` 295 件を隣に置く。
- 出典・データセット年度・市コード・ライセンス・展開日時を `source-metadata.json` に記録する（§3）。
- ZIP 全体を展開しない（`tools/lib/zip-reader.js` が中央ディレクトリから必要エントリだけ取り出す。ZIP64 対応）。

### B. ネットワーク経由（ローカル PC）

```bash
node tools/fetch-plateau.js --layer tran --city-code 27100 --list
node tools/fetch-plateau.js --layer tran --dataset plateau-osaka-tran \
  --city-code 27100 --out data/raw/plateau/osaka-city/tran/
```

`--layer` 省略時は従来どおり `bldg`。既存の建物取得には影響しない。

---

## 1. 実データで確定した schema（§5・推測禁止だったため実測）

```
core:cityObjectMember
└ tran:Road [gml:id]                        … 市域 199,162 件
   ├ tran:function      codeSpace=Road_function.xml          … 行政種別（面種別ではない）
   ├ uro:roadStructureAttribute > uro:RoadStructureAttribute
   │  └ uro:sectionType codeSpace=RoadStructureAttribute_sectionType.xml … 構造区分
   ├ tran:lod1MultiSurface                  … 199,162 件（全 Road にある）★これが道路区域
   │  └ gml:MultiSurface > surfaceMember > Polygon > exterior/interior > LinearRing > posList
   └ tran:trafficArea / tran:auxiliaryTrafficArea（lod3MultiSurface）… 888 件のみ（0.4%）
```

- `srsName="http://www.opengis.net/def/crs/EPSG/0/6697"`、`srsDimension="3"`、posList は **lat lon alt**。
- `gml:interior`（穴）が 1,263 件ある。Polygon 単位で exterior/interior を対応させること。

### codelist（配布 ZIP 同梱が正本）

| Road_function | | RoadStructureAttribute_sectionType | |
|---|---|---|---|
| 1 | 高速自動車国道 | 1 | 土工区間・通常区間 → ground |
| 2 | 一般国道 | 2 | 高架橋 → elevated |
| 3 | 都道府県道 | 3 | 橋梁 → bridge |
| 4 | 市町村道 | 4 | 交差部 → intersection |
| 10–15 | 建築基準法42/43条道路 | 5 | アンダーパス → underpass |
| 9000/9010/9020 | 未調査/対象外/**不明** | 6 | トンネル → tunnel（地表面から除外） |
| | | 7 | 橋・高架 → elevated |
| | | 9 | 不明 |

市域実測分布: function `9020`(不明) 194,135 / `3` 2,918 / `2` 1,371 / `1` 738。
sectionType `1` 112,323 / `9`(不明) 85,703 / `7` 1,031 / `6` 90 / `4` 14 / `3` 1。

> **重要**: `tran:function` は行政種別であって「車道/歩道」ではない。
> 車道/歩道の細分は `TrafficArea_function.xml` 側の別 codelist で、この配布では 0.4% にしか存在しない。

### §7 道路面の定義（この配布での確定事項）

canonical road geometry = **`tran:Road` の `lod1MultiSurface`（道路区域＝車道＋歩道を含む道路敷地）**。
全 Road に一様に存在するのでこれを唯一の polygon source とする。
TrafficArea(lod3) は同じ Road の内側を細分した別 LOD なので、併用すると同一面を二重計上する。
採用せず件数のみ記録する（§14）。トンネル区間は地表の道路面ではないので `surfaceKind='subsurface'` として除外。

---

## 2. 変換

```bash
npm run data:convert:plateau-tran
# = node --max-old-space-size=4096 tools/convert-plateau-tran.js --convert --input data/raw/plateau/osaka-city/tran/
# 構造だけ見たいとき: node tools/convert-plateau-tran.js --inspect --input data/raw/plateau/osaka-city/tran/
```

出力 `data/processed/osaka-city/canonical/roads-tran/polygons.json`（gitignore・約 122MB）。
実績: 198,626 polygon（roadSurface 198,536 / subsurface 90）、invalid 率 **0.269%**
（zero-area 369 / self-intersection 167）。

## 3. §30 STOP 条件の判定（採用可否をここで決める）

```bash
npm run data:audit:plateau-tran-coverage
```

| check | しきい値 | 実測 | |
|---|---|---|---|
| crsDetermined | EPSG:6697 → znorth-neg-v1 | 確定 | PASS |
| bboxWithinCity | 市域 extent と交差 | 交差 | PASS |
| allWardsCovered | 24/24 区 | **24/24** | PASS |
| cityCellCoverage | ≥ 0.55 | **0.9951** | PASS |
| invalidRate | ≤ 0.05 | **0.0027** | PASS |
| osmMedianOffset | ≤ 8m | **0m** | PASS |
| osmUnmatchedRatio | ≤ 0.35 | **0.006** | PASS |

OSM centerline サンプル点の **94.0% が tran polygon の内側**に落ちる。位置系の不整合は無い。
1 つでも FAIL なら `RESULT: STOP` となり、polygon 化へ進んではいけない。

## 4. canonical roads の再構築（polygon-first）

```bash
npm run data:build:canonical-roads
npm run data:validate:canonical-roads
```

処理は 3 パス構成:

- **pass A** — centerline ごとに tran polygon を空間 match し、`polygon → 通っている centerline 群` の索引を作る。
- **pass B** — **polygon 起点**で 1 枚 = 1 feature を出力。属性は対応 centerline から join。
  対応が無い面は geometry だけ採用し `attributes-source-missing` を立てる。
- **pass C** — polygon で表現されなかった centerline のみ ribbon fallback。

> polygon 起点にするのが要点。road 起点だと交差点の面を複数の道路が同時に採用して
> 道路面積が水増しされ、Building∩Road などの conflict 計数まで狂う。

## 5. QA 監査

```bash
npm run data:audit:canonical-road-intersection    # §15 交差点 before/after
npm run data:audit:canonical-road-structure       # §17 高架・橋梁・トンネル
npm run data:audit:canonical-road-ward-sources    # §20/§21 区別 geometry/attribute source
npm run data:audit:canonical-conflicts            # §18/§19 Building∩Road, Road∩Water
npm run data:audit:plateau-tran-status            # 総合ステータス
```

---

## 既知の限界

- `sectionType` は市域の **42.7% が「不明」**。高架路線名を持つ 309 feature は PLATEAU にも OSM にも
  高架の signal が無く、地上ランプ・側道の可能性があるため推測で高架化しない。
- OSM PBF は lat≈34.735 で bbox clip されており、**東淀川区・淀川区・旭区**の OSM 道路属性が欠測。
  geometry は PLATEAU で埋まったが、名称・車線数は付かない（東淀川区の OSM 属性率 3.8%）。
- 描画は切り替えていない（§0）。`RoadLayer` / `CityTileLayer` は不変で、canonical は
  `data/processed/osaka-city/canonical/roads/` に閉じている。描画反映は 31G 以降。
