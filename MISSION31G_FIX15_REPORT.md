# Mission 31G-FIX15 完了報告｜GSI Official Road Edge Import & Validation Prototype

生成物: `data/reports/gsi-road-edge-prototype.json` / `data/reports/gsi-road-edge-prototype-validation.json`
方針: FIX14 で最有力候補とした GSI 基盤地図情報「道路縁」を **REFERENCE / PROTOTYPE として取り込む pipeline を構築**する。FIX13 をいきなり置換しない（§0）。実データが無ければ捏造せず STOP。

---

## §33-1｜raw GSI データが存在したか

**存在しなかった**（`data/raw/gsi/road-edge/` は本ミッション開始時点で空。FIX14 で調査した通り、GSI 基盤地図情報はローカル PC でのアカウント登録・ダウンロードが必要で、このサンドボックスでは取得できない）。
`tools/import-gsi-road-edge.js` は `GSI_ROAD_EDGE_RAW_DATA_MISSING` を表示して正常終了し、既存パイプラインには一切影響しなかった。

---

## §33-2｜読み込んだ file

**0 件**（`sourceFiles: []`）。

---

## §33-3｜実 source CRS

**未取得のため不明**。ただし pipeline 側は判定・変換ロジックを実装済み（`tools/lib/gsi-road-edge-transform.js` の `classifyCrs()`）。JGD2000/JGD2011 の地理座標（lat/lon, srsName に `.bl` や `4326`/`6668` を含むもの）のみサポートし、平面直角座標系（第I〜XIX系）等の投影 CRS は `crsUnsupported` として明示的に除外する（**第6系・第7系への強制変換はしない**・FIX11 Coordinate Authority を維持・§4 遵守）。

---

## §33-4｜道路縁 feature の意味

GSI JPGIS(FGD) 公開仕様に基づく一般的構造（実ファイル未検証）として実装:
- `fgd:RdEdg`（道路縁）= 道路と道路以外の境界を表す **line**（LineString）。車道と歩道の区別は道路縁単体では付かない（§3 で区別すべきと明記された road boundary / carriageway edge / sidewalk edge のうち、RdEdg は "road boundary" に相当し、carriageway edge そのものではない可能性が高い — この区別は実データでのみ確認できる）。
- 同一ファイル内に混在しうる他 feature type（`AdmBdry`＝行政界等）は `otherFeatureTypes` として記録し、RdEdg と混同しないようにした。
- `parseRoadEdgeGml()` は合成 fixture（テストコード内で構築した最小 GML）で構造検証済みだが、**実 GSI ファイルでのフィールド単位の検証はしていない**（正直な記録・§5 のコメントに明記）。

---

## §33-5｜feature 数

**0 件**（raw data が無いため）。

---

## §33-6｜大阪市 feature 数

**0 件**。

---

## §33-7｜invalid / duplicate

**0 件**（計測対象データが無いため）。ただし検証ロジック（`tools/lib/gsi-road-edge-validate.js`）は単体テストで動作確認済み: 合成データで invalid coordinate 1件・zero length 1件・duplicate 1件・extreme outlier 1件をすべて正しく検出した（`tests/gsi-road-edge-prototype.test.js` §9 テスト）。

---

## §33-8｜coverage

**評価不能**（大阪市域内 feature 0 件）。

---

## §33-9｜pairing HIGH/MEDIUM/LOW/UNPAIRED

**全て 0**（`{"high":0,"medium":0,"low":0,"unpaired":0}`）。pairing 評価ロジック（並行性・分離距離・方向・縦断重なり判定）は実装済みだが、GSI line が無いため実行対象がない。

---

## §33-10｜sample polygon 生成数

**0 件**（HIGH confidence pair が 0 件のため）。§15 の「全大阪 polygon 化禁止・sample エリア限定」の制約は、そもそも生成対象が無いため自動的に満たされている。

---

## §33-11｜御堂筋等の道路幅比較

**GSI 幅は測定不能（null）**。ただし FIX13 で既に算出済みの他 3 指標（PLATEAU polygon 実効幅 / FIX13 visual 幅 / OSM lanes advisory 幅）は `majorRoadWidths` に再掲した（捏造ではなく既存 `refined-road-visual-surface.json` の再利用）:

| 道路 | gsiWidthM | plateauTranWidthM | fix13VisualWidthM | osmLanesWidthM |
|---|--:|--:|--:|--:|
| 御堂筋 | null | 20.5 | 20.5 | 17.5 |
| 新御堂筋 | null | 16.6 | 16.6 | 3.5 |
| 中央大通 | null | 20.8 | 20.8 | 15.0 |
| 玉造筋 | null | 14.0 | 14.0 | 6.0 |
| 今里筋 | null | 15.8 | 15.8 | 6.0 |
| あびこ筋 | null | 17.7 | 17.7 | 6.5 |
| 松虫通 | null | 16.1 | 16.1 | 6.0 |
| 国道1号／25号／43号 | null | null | null | null（`name` 属性が canonical road attributes に無く、ref/route 番号は現行 pipeline 未収録のため抽出不可） |

---

## §33-12｜FIX13 との差

**測定不能（NOT_AVAILABLE）**。`fix13Comparison` フィールドにその旨を明記し、`GSI_NARROWER`/`GSI_WIDER`/`SIMILAR` 等の分類は一切出力していない（validator の `fakeMeasurement` チェックで確認済み・0 件）。

---

## §33-13｜Building overlap 比較

**測定不能（NOT_AVAILABLE）**。sample polygon が 0 件のため比較対象がない。

---

## §33-14｜GSI の方が優れているか

**判定していない**。§20「Buildingを正解として使わない」の原則に加え、そもそも実 geometry を見ていないため、GSI の位置精度・道路構造・pairing 実用性のいずれも独立評価できていない。「GSI が FIX13 より劣る」（`GSI_NOT_BETTER_THAN_FIX13`）という判定も**していない**（§23 はデータを見た上での判定を要求しており、見ていない以上その判定はできない）。

---

## §33-15｜次 Mission で正式採用すべきか

**現時点では判断材料が無い**。`adoptionRecommendation.decision = "INSUFFICIENT_DATA_NOT_EVALUATED"`。
§22 の 7 条件チェックリストはいずれも `unknown`（ライセンス条件のみ FIX14 の調査結果を引き継ぎ `pending`＝測量法上の申請要否の個別照会が必要）。
**ユーザーへの案内（Console 操作不要・作業は 1 つだけ）**:

> GSI 基盤地図情報から大阪市を含む道路縁（RdEdg）データを取得し、`data/raw/gsi/road-edge/` へ配置してください（ZIP のまま可）。詳細は `data/raw/gsi/road-edge/README.md` を参照。

配置後は `npm run data:gsi-road-edge:import` → `npm run data:gsi-road-edge:audit` → `npm run data:gsi-road-edge:validate` を実行すれば、pairing 評価・sample polygon 生成・幹線道路幅実測・building overlap 比較・adoption recommendation が自動で走る（§11-22 のロジックは実装済み・実データでの検証は未実施）。

---

## §33-16｜validator

`tools/validate/gsi-road-edge-prototype.js` — **RESULT: PASS**

```json
{"rawMutation":0,"canonicalRoadMutation":0,"buildingMutation":0,"fix13RefinedSurfaceMutation":0,
 "crsMismatch":0,"untrackedFeature":0,"fakeMeasurement":0,"reportStatusHonest":true,
 "productionModified":false,"protectedModified":false,"toggleDefaultOff":true,"toggleNoConsoleRequired":true}
```

§29 の 8 必須チェック（rawMutation / canonicalRoadMutation / buildingMutation / crsMismatch / untrackedFeature / fakeMeasurement / productionModified / protectedModified）**全て条件達成**。

---

## §33-17｜npm test

```
tests 1366 / pass 1351 / fail 0 / skipped 15
```

新規 `tests/gsi-road-edge-prototype.test.js`: **14 件 pass**（directory/README存在・missing-data STOU・report schema・fakeMeasurement 0・validator PASS・CRS強制変換なし・GMLパーサ合成fixture・座標変換+大阪市clip・geometry validation・format検出・runtimeトグル既定OFF・canonical/building/FIX13不変・production/protected無混入・npm scripts存在）。

**副産物として発見・修正した既存の潜在バグ（本ミッションのスコープ外だが npm test を通すために必要だった）**: `tests/mission07/08/09-building-*.test.js` の 3 ファイルが `CityBuildingLOD` の return 文を完全一致文字列で検索しており、後続ミッションで return フィールドが増えたため `indexOf` が `-1` を返し `.slice(start, -1)` がファイル末尾までスキャンする状態になっていた（偶然 false positive を起こしていなかっただけの潜在バグ）。本ミッションの新規 IIFE が `THREE.LineSegments` を使ったことで顕在化したため、3 ファイルとも「安定した prefix 検索＋`endIdx > startIdx` の assert」へ修正した（挙動としては元の意図通りに戻しただけで、テストの検証内容自体は変えていない）。

---

## §33-18｜canonical / building / FIX13 不変確認

| 項目 | 値 | 判定 |
|---|---|---|
| canonical roads featureCount | 199,658 | **不変**（FIX12/13 と一致） |
| canonical buildings featureCount | 615,617 | **不変** |
| FIX13 `refined-road-surface.json` indexedCount | 30,190 | **不変** |
| raw GSI ファイル | ハッシュ baseline 新規記録（今回変更 0 件） | **不変** |
| production HTML | hash baseline 一致 | **不変** |
| protected HTML | hash baseline 一致 | **不変** |
| `git diff --check` | clean | ✅ |

---

## 完了条件（§32・実データ無しの場合）チェック

- [x] input directory（`data/raw/gsi/road-edge/`）
- [x] importer skeleton（`tools/import-gsi-road-edge.js`）
- [x] parser（`tools/lib/gsi-road-edge-gml.js` / `gsi-road-edge-format.js`）
- [x] validator（`tools/validate/gsi-road-edge-prototype.js`、幾何検証は `tools/lib/gsi-road-edge-validate.js`）
- [x] report schema（`data/reports/gsi-road-edge-prototype.json`・§28 全フィールド）
- [x] missing-data STOP（`GSI_ROAD_EDGE_RAW_DATA_MISSING`。エラーでパイプライン全体を壊さない）
- [x] ユーザー作業を1つだけ案内（§33-15 参照）
- [x] FIX13 完全維持（canonical road / building / refined-road-surface すべて featureCount・indexedCount 一致）

## 追加で実装した項目（実データ到着時に即使える状態にするため）

- `tools/audit/gsi-road-edge-sample-compare.js`: sample エリア10地区（梅田・本町・難波・天王寺・十三・住吉・中之島・阿倍野・京橋・平野）定義、pairing評価（HIGH/MEDIUM/LOW/UNPAIRED）、sample polygon生成（HIGH confidenceのみ・sampleエリア限定）、adoption recommendationチェックリスト（実装済み・実データでの実行は未検証）
- runtime `[GSI Road Edge]` toggle（既定OFF・マゼンタ色0xff2d95でFIX13道路色と明確に区別・Console不要・per-frame cost無し）
- `tools/build-derived-public.js` に GSI正規化lineの配信ステップ追加（データが無い間はno-op）
- npm scripts: `data:gsi-road-edge:import` / `:audit` / `:validate`

## 変更ファイル

| ファイル | 種別 |
|---|---|
| `data/raw/gsi/road-edge/README.md` | 新規（input directory・gitignore対象） |
| `tools/lib/gsi-road-edge-format.js` | 新規（内容ベース形式判定） |
| `tools/lib/gsi-road-edge-gml.js` | 新規（JPGIS(GML) RdEdgパーサ） |
| `tools/lib/gsi-road-edge-validate.js` | 新規（geometry validation） |
| `tools/lib/gsi-road-edge-transform.js` | 新規（CRS判定・世界座標変換・N03 clip） |
| `tools/import-gsi-road-edge.js` | 新規（importer） |
| `tools/audit/gsi-road-edge-sample-compare.js` | 新規（sample比較・pairing） |
| `tools/validate/gsi-road-edge-prototype.js` | 新規（§29 validator） |
| `tests/gsi-road-edge-prototype.test.js` | 新規（14件） |
| `tests/mission07-building-white.test.js` / `mission08-building-edge.test.js` / `mission09-building-ao.test.js` | 変更（潜在バグ修正・§33-17参照） |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 変更（`[GSI Road Edge]` toggle 追加・末尾IIFE） |
| `tools/build-derived-public.js` | 変更（GSI配信ステップ追加） |
| `package.json` | 変更（npm scripts 3件・test list追加） |
| `data/reports/gsi-road-edge-prototype.json` / `-validation.json` | 生成 |
| `data/reports/baselines/gsi-raw-hashes.json` | 生成（raw変更検知baseline） |

production `osaka_3d_buildings.html` / protected `osaka_3d_buildings.fullward-v3.html` は**不変**。

---

**次工程（Official Road Surface Integration）へは進まず、Import Pipeline のプロトタイプ構築のみ完了。FIX13 を正式 baseline として維持。ユーザー確認待ち。**
