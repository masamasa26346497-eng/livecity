# Mission 31G-FIX20 完了報告｜GSI Building Alignment Ground Truth

PLATEAU建物の絶対位置を、道路を一切基準にせず、独立した authoritative building footprint（GSI基盤地図情報
「建築物の外周線」BldL）と直接照合するためのパイプライン・matching algorithm・runtime QA UIを構築した。
**実データ未取得のため、実際の位置ずれの有無はまだ測定できていない**（§1 に従い正直に記録・捏造していない）。

## §30-1｜GSI building raw file数

**0件**。`data/raw/gsi/building-outline/` に実データが配置されていない
（README.mdのみ。ユーザーがGSI基盤地図情報「建築物」データを取得・配置していない状態）。

## §30-2｜GSI CRS

**未確認（実データが無いため測定不能）**。ただし FIX16 で道路縁（RdEdg）の実データが
`fguuid:jgd2024.bl`（JGD2024・地理座標）だったことから、同じ基盤地図情報の建築物データも
同一CRSである可能性が高いと推定している（未検証の推定）。

## §30-3｜outline数

**0件**（raw data 未取得のため）。

## §30-4｜24区coverage

**測定不能**（raw data 未取得）。`tools/audit/gsi-building-alignment.js` はGSI outlineのcentroidを
N03行政界で分類しcoverageByWard/missingWardsを算出する機能を実装済み（実データ投入後に有効化される）。

## §30-5｜HIGH match数

**0件**（raw data 未取得）。ただし合成データ（実PLATEAU建物4,064棟を既知の一定オフセット
dx=1.4m/dz=-0.9mだけ平行移動させた検証用データ）で pipeline を実行したところ、
**HIGH match 3,548件**（86.5%）を正しく検出し、§9の「最低数千棟以上」を満たすことを実証した
（この結果は正式な report には含めていない。検証用の一時データは削除済み・§18/§19 参照）。

## §30-6｜MEDIUM match数

**0件**（raw data 未取得）。合成データ検証では462件（11.4%）。

## §30-7｜unmatched数

**0件**（raw data 未取得。matching自体を実行していないため）。合成データ検証では6,831件
（GSI側4,064棟に対しPLATEAU候補11,202棟を用意したため、対応が無いPLATEAU建物が多数UNMATCHEDになるのは
想定通り）。

## §30-8｜median dx

**測定不能**。合成データ検証では注入した既知オフセット dx=1.4m を**誤差0.00mで正確に復元**した
（`medianDx: 1.4`）。

## §30-9｜median dz

**測定不能**。合成データ検証では既知オフセット dz=-0.9m を**誤差0.00mで正確に復元**した
（`medianDz: -0.9`）。

## §30-10｜median distance

**測定不能**。合成データ検証では medianDistance=1.664m（=√(1.4²+0.9²)、幾何学的に正しい値）。

## §30-11｜p95 distance

**測定不能**（raw data 未取得。合成データでは全建物が同一オフセットのため p50=p90=p95=p99=1.664m
で分散ゼロ。これは合成データの性質上当然で、実データでは分散が出るはず）。

## §30-12｜ward別傾向

**測定不能**。合成データ検証では全建物に同一シフトを適用したため `wardTrend: "GLOBAL_TRANSLATION_CANDIDATE"`
が正しく検出された（全区が同方向）。

## §30-13｜JGD2011/JGD2024差

**文献調査（WebSearch）による推定値**: 東京など、2011年以降に大規模地殻変動を伴う地震の影響を
受けていない安定地域では、JGD2011→JGD2024の水平差は**約1cm程度**。一方、東北2011・熊本2016・能登2024など
実際に地殻変動を伴った地震の震源域では数十cm〜3m超（仙台で約3.37m）に達する。**大阪市は該当する
大規模地殻変動地震の震源域ではない**ため、理論的には大阪での水平差は東京と同程度（**cmオーダー**）と
推定される。ただし、この推定はGSI公式のセミダイナミック補正パラメータファイルを実際にダウンロードして
大阪市内の格子点で数値評価したものではなく、公開資料からの推定値である点を明示する（実測未実施）。

## §30-14｜rotation差

**測定不能**（raw data 未取得）。合成データでの回転検出テスト（theta=0.002rad）では、
dx/dzが位置(x,z)と非常に強く相関（|r|>0.999）することを確認し、`classifyShift()`が正しく
`ROTATION`として分類することを実証した。

## §30-15｜IoU before

**測定不能**。合成データ検証（既知シフト1.4m/-0.9m、建物サイズ10m×8m）ではIoU(補正前)=0.549。

## §30-16｜candidate correction

**未生成**（raw data 未取得のため）。§17実装により、classification=CONSTANT_TRANSLATIONかつ
HIGH match≥30件の場合のみ、robust median（目分量ではない）からcandidate translationを算出する
機能を実装済み。合成データ検証では正しくdx=1.4/dz=-0.9を候補として算出した。

## §30-17｜IoU after candidate

**測定不能**。合成データ検証ではIoU(補正後候補)=0.999（ほぼ完全一致）——候補補正が実際に
alignmentを改善することを確認する§17の判定ロジックが正しく機能することを実証した。

## §30-18｜classification

**`INSUFFICIENT_MATCHING_DATA`**（raw data が無いため。§28の4択のうち、これが唯一正直な選択）。

## §30-19｜建物を本当に動かす必要があるか

**現時点では判断できない。** 実データが無い以上、「PLATEAU建物が実際にずれているか」を
主張することはできない。ただし今回の合成データ検証により、**もし実際にずれが存在するなら、
このパイプラインは正確にそれを検出・定量化できる**ことを確認済み（既知の1.4m/-0.9mシフトを
誤差0mで復元、回転も正しく検出）。実データ取得後、次のいずれかになる:
- classification=`NO_SYSTEMATIC_BUILDING_SHIFT` → 建物は動かさない。
- classification=`DATUM_TRANSFORM_REQUIRED` → runtime hackではなくsource正規化パイプラインで
  datum変換を検討（§18/§19）。
- classification=`SYSTEMATIC_BUILDING_SHIFT_CONFIRMED` → 次ミッションで正式補正を検討
  （今回は615,617棟を一切書き換えていない・§29）。

## §30-20｜validator

`tools/validate/gsi-building-alignment.js`:
```
rawMutation=0  canonicalBuildingMutation=0  canonicalRoadMutation=0  fakeMatch=0
crsMismatchUntracked=0  runtimeMagicOffset=0  lowConfidenceUsedForCalibration=0
productionModified=false  protectedModified=false
buildingAlignmentToggleDefaultOff=true  topDownToggleExists=true
RESULT: PASS
```

## §30-21｜npm test

```
tests 1458
pass 1443
fail 0
skipped 15
duration ≈ 47秒
```
新規 22 tests（`gsi-building-matching.test.js` 8件・`gsi-building-outline-import.test.js` 4件・
`gsi-building-alignment.test.js` 10件）全て pass。matching algorithm は合成fixtureで
既知オフセット復元・回転検出・mutual-best-match排他・面積不一致排除を検証済み。`git diff --check`クリーン。

## §30-22｜visual QA status

**`VISUAL_QA_PENDING_USER`**。ブラウザが無いこのセッションでは実機確認していない。
`[Building Alignment]`（GSI outline=赤系線・PLATEAU footprint=シアン系線、Canonical status panel内、
既定OFF）・`[Top Down Alignment]`（既存camera systemのcs.phを直接操作、ジンバルロック回避の
安全値0.08radを流用）を実装し、動的テスト（実fetch・実トグル呼び出し）で例外なく動作することを確認済み。
実データが無いため overlay自体は「(データ無し)」表示になる。

## 完了条件チェック

- [x] §1 raw data確認 → `GSI_BUILDING_OUTLINE_RAW_DATA_MISSING`で正直にSTOP（捏造せず）
- [x] §2 GSI feature semantics確認（公開資料ベース。BldL=建築物の外周線=roof outer line、
      BldA=建築物ポリゴン、を明記。実ファイルでの確認は今後）
- [x] §4 JGD2011/JGD2024 datum差の文献調査完了（大阪は cm オーダーと推定）
- [x] §5 normalize pipeline実装済み（`tools/import-gsi-building-outline.js`。raw geometry不変・N03 clip）
- [x] §6 24区coverage算出ロジック実装済み（実データ投入後に有効化）
- [x] §7-9 matching algorithm実装（単純nearest centroidではなくIoU/面積/orientation/mutual best matchの合成）
- [x] §10-12 統計・回帰・分類ロジック実装（合成データで既知の答えを正しく復元することを検証済み）
- [x] §13 roof outline差とtranslation差の分離（BldLの意味論をコード・READMEに明記）
- [x] §15-17 IoU before/candidate-after比較実装（目分量禁止・robust median使用）
- [x] §19 runtime magic offset禁止（validator確認済み・そもそも実装していない）
- [x] §21/§22 Building Alignment / Top Down Alignment UI実装（既定OFF・Canonical status panel統合）
- [x] §27 validator PASS
- [x] npm test fail 0
- [ ] 実データでの measurement（**未完了。ユーザーがGSI建築物データを取得・配置するまで不可能**）

## 変更・新規ファイル

**新規**:
- `data/raw/gsi/building-outline/README.md`
- `tools/lib/gsi-building-outline-gml.js`（BldL GMLパーサ）
- `tools/lib/gsi-building-matching.js`（matching/統計/回帰/分類ライブラリ）
- `tools/import-gsi-building-outline.js`
- `tools/audit/gsi-building-alignment.js`
- `tools/validate/gsi-building-alignment.js`
- `tests/gsi-building-matching.test.js`（8 tests）・`tests/gsi-building-outline-import.test.js`（4 tests）・
  `tests/gsi-building-alignment.test.js`（10 tests）

**変更**:
- `public/osaka_3d_buildings.ward-ux-v1.html`: `[Building Alignment]`・`[Top Down Alignment]`
  トグルをCanonicalRuntime内に実装し、Canonical status panel（FIX19Cの教訓通り、確実に見える
  最前面panel内）へ統合。`window.__TOGGLE_BUILDING_ALIGNMENT__`等を公開。
- `package.json`（新規npm scripts 3件、`scripts.test`に新規テスト3ファイル追加）
- `.gitignore`（`gsi-building-outline/`関連ディレクトリ追加）

**GSI road algorithm（pairing/corridor DP）・FIX13・FIX19 Hybrid geometry・Canonical Road/Building
（615,617棟）は一切変更していない（§0完全遵守）。production/protected HTMLも無変更。**

## 次ミッションへの引き継ぎ

1. **最優先**: ユーザーがGSI基盤地図情報「建築物」データ（BldL）を`data/raw/gsi/building-outline/`へ
   配置し、`npm run data:gsi-building-outline:import` → `npm run data:gsi-building-outline:alignment`
   を実行すれば、初めて実際の位置ずれ有無が判明する。
2. 実データ取得後、classificationに応じて次段階（datum変換 or 正式補正 or 現状維持）を判断する
   別ミッションが必要（§29により今回は書き換えを一切行っていない）。
3. 実機ブラウザでの`[Building Alignment]`・`[Top Down Alignment]`目視確認。
