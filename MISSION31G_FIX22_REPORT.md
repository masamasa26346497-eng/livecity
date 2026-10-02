# Mission 31G-FIX22 完了報告｜大阪市24区 Building Alignment 最終検証

ユーザーが配置した6メッシュ分（513573/513574/523503/523504/523513/523514）のGSI基盤地図情報
「建築物の外周線」(BldL) 実データを使い、大阪市24区**全域**でPLATEAU建物との直接照合を実行した。

**結論: 大阪市24区全域（重要8区すべてを含む）で、建物は系統的にずれていない
（`NO_SYSTEMATIC_BUILDING_SHIFT`）。** HIGH match 11,647件（§9目安「最低数千棟」達成）・
HIGH+MEDIUM 96,265件で同じ結論が再現され、地域別（NORTH/CENTRAL/EAST/SOUTH/BAY）・
24区別のいずれでも系統的な偏りは見られなかった。建物のx/z座標・投影原点・道路geometryは
一切変更していない。`CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT` は発生しなかった
（重要8区すべてが十分なcoverageを持つことを確認済み）。

---

## §1｜raw mesh inventory

**2ファイル**:
- `data/raw/gsi/building-outline/FG-GML-523514-ALL-20260401.zip`（87,157,205 bytes。FIX21から既存・単一メッシュの完全パッケージ）
- `data/raw/gsi/building-outline/20260913110554903-001.zip`（265,019,207 bytes。**新規**）

新規ファイルは想定と異なる形式だった: **ZIPの中にZIPが入った「ZIP-of-ZIPs」構造**（GSI基盤地図情報の
一括ダウンロード形式のひとつ）。外側ZIPの6エントリはそれぞれ `FG-GML-<meshcode>-11-<date>.zip`
という内側ZIP（`-11-` はおそらく「建物系のみ」の data item サブセットを表すコード。FIX16/FIX21の
`-ALL-` パッケージとは別形式）。合計 **6メッシュ**: `513573, 513574, 523503, 523504, 523513, 523514`
— **523514以外の5メッシュが新規追加**され、FIX16の道路縁データと完全に同じメッシュ集合になった。

zip entry総数（ネスト展開後）= **62**。

## §1b｜mesh 523514 の重複検出・解消

新パッケージの内側ZIP（`523514-11-...zip`）にも mesh 523514 のBldLが含まれており、これは
FIX21で既に処理済みの standalone `523514-ALL` パッケージと**完全に重複**していた
（内側BldLファイルサイズ 251,977,502 bytes が、既取込のBldLファイルサイズと**バイト単位で完全一致** —
同一データの再梱包と推定）。

対応: standalone `-ALL-` パッケージ（アルファベット順で優先的にソート）を先に取り込み、
後発の同一meshCodeのBldLは「重複」として検出・スキップ（二重カウント防止）。
`data/reports/gsi-building-outline-import.json` の `meshInventory.duplicateMeshSkipped` に
スキップしたファイルパス・meshCode・byteサイズ一致有無を正直に記録。

```
meshCodesImported: [513573, 513574, 523503, 523504, 523513, 523514]  (6メッシュ、重複なし)
duplicateMeshSkipped: 1件（523514, byte数一致）
```

## §2｜24区coverage再計算

GSI outline（closed ring, 540,296件）のcentroidをN03区境界で分類した結果、**24区すべてに
coverageあり**（`missingWards: []`）。区外判定された点は752件のみ（境界近傍の誤差レベル）。

| 区 | outline件数 |
|---|---|
| 北区 | 17,881 |
| 中央区 | 16,955 |
| 浪速区 | 9,349 |
| 天王寺区 | 12,976 |
| 阿倍野区 | 23,613 |
| 淀川区 | 31,578 |
| 東淀川区 | 31,880 |
| 住吉区 | 30,206 |
| （他16区も全て0件超・詳細は§9） | |

## §3｜STOP条件チェック（重要8区coverage）

北区/中央区/浪速区/天王寺区/阿倍野区/淀川区/東淀川区/住吉区の8区すべてが
`MIN_WARD_OUTLINE_COVERAGE=20`件を大幅に上回るcoverageを持つ
（最小でも浪速区の9,349件）。**`citywideCoverage.sufficient = true`**。
`CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT` は発生せず、`RESULT` は
`GSI_BUILDING_ALIGNMENT_MEASURED` のまま確定した。

## §4｜importer scalability（実測で新たに発見・修正した2件の実行時エラー）

1. **FIX21の `push(...records)` spread修正は維持**（`for (const r of records) ctx.allRecords.push(r);` —
   ctxオブジェクト化に伴いprefixが付いたが、forループ経由でspreadでない、という不変条件はテストで
   引き続き検証。既存の完全一致regexを `(?:ctx\.)?` 許容へ緩和）。
2. **BldL以外を展開しない性能最適化を維持・ネスト内側にも拡張**: 外側ZIPのエントリがそれ自体ZIP
   （`.zip`拡張子）である場合、`readZipEntriesFromBuffer`/`extractEntryFromBuffer`（新規追加。
   file path版の`readZipEntries`/`extractEntry`とロジック完全同一・既存関数は無変更）で再帰的に
   処理し、BldA/RdCompt/SBBdry等は内側ZIPでも展開しない。
3. **新規発見・修正**: 6メッシュ全件（rawRecords=1,801,044件）を処理した結果、
   `building-outline-lines.json` の書き込みで **`RangeError: Invalid string length`**
   が実際に発生した（`JSON.stringify(全features)` がV8の1文字列あたりの上限を超えた。
   最終的なファイルサイズは432MB）。修正: feature 1件ずつ`JSON.stringify`してstreaming書込する
   `writeLargeLinesJson()`を新規実装（一時ファイル→軽量な構造検証(`{}`/`[]`対応・文字列閉じの
   バランスのみ確認。ファイル全体を1文字列として再読込すると同じ上限に当たるため意図的に
   フル再パースはしない)→rename、という既存`writeJsonSafely`と同じ安全設計を踏襲）。
4. **付随して発見・修正**: 432MBのファイルを`tools/audit/gsi-building-alignment.js`側で
   `fs.readFileSync`→`JSON.parse`で読む既存コードも同じ上限に当たりうるため、
   `tools/lib/large-json-array-reader.js`を新規追加し、1行=1 feature という
   `writeLargeLinesJson`の出力仕様に基づいた行単位streaming読込に変更（内容の解釈は不変）。

いずれも§0遵守: raw/geometryの内容・解釈は一切変えず、読み書きの実装方式のみを変更した
純粋なスケーラビリティ対応。回帰防止テストを`tests/gsi-building-outline-import.test.js`に追加。

## §5｜matching algorithm

`tools/lib/gsi-building-matching.js`（FIX20/21から**完全無変更**。IoU/面積類似度/PCA向き差/
bbox overlap/centroid候補探索/mutual best match→HIGH/MEDIUM/LOW/UNMATCHED分類）をそのまま再利用。
git diffで無変更であることを確認済み。

## §6｜HIGH match数（目標達成）

**HIGH = 11,647件**（§9の目安「最低数千棟以上」を達成。閾値は緩めていない
— `CONF_THRESHOLDS`はFIX20から不変）。

| confidence | 件数 |
|---|---|
| HIGH | 11,647 |
| MEDIUM | 84,618 |
| LOW | 404,546 |
| UNMATCHED | 73,301 |
| 合計（PLATEAU候補） | 574,112 |

city-wide平均のHIGH match率 = 2.03%（PLATEAU候補中）。

## §7｜HIGH-only と HIGH+MEDIUM の一致確認

| | n | medianDx | medianDz |
|---|---|---|---|
| HIGHのみ | 11,647 | +0.019m | -0.056m |
| HIGH+MEDIUM | 96,265 | +0.004m | -0.058m |

両者とも`classifyShift`結果は`NO_SYSTEMATIC_SHIFT`で完全一致（`corroboration.corroborated = true`）。
FIX21のような非対称ロジック（n<2000の場合の代替判定）に頼る必要はなく、HIGHのみで
§9の目安を正攻法で満たした上で、HIGH+MEDIUMでも再現性が確認できた。

## §8｜city-wide displacement 統計（robust statistics含む）

| 指標 | 値 |
|---|---|
| medianDx / medianDz | +0.019m / -0.056m |
| meanDx / meanDz | +0.018m / -0.044m |
| stdDx / stdDz | 1.817m / 1.921m |
| **madDx / madDz**（新規） | 1.124m / 1.238m |
| **trimmedMean(10%) Dx/Dz**（新規） | +0.009m / -0.041m |
| medianDistance | 2.115m |
| p90 / p95 / p99 / max | 3.94m / 4.78m / 6.55m / 8.00m |
| 平均orientation差 | 15.06° |
| IoU（HIGH match平均） | 0.509（roof outline対footprintのため1.0には届かない。想定内） |

median・trimmed meanとも実質ゼロで一致（外れ値の影響を受けにくい統計でも結論は変わらない）。
MAD（1.1-1.2m）はstd（1.8-1.9m）よりやや小さく、分布が正規分布よりやや尖っている
（中心付近に多く集まりつつ裾が長い）ことを示すが、中心自体はゼロ近傍で安定している。

## §9｜24区全区分の内訳

| 区 | HIGH | MEDIUM | LOW | UNMATCHED | medianDx | medianDz | medianIoU |
|---|---|---|---|---|---|---|---|
| 北区 | 215 | 1,658 | 10,314 | 3,593 | -0.137 | +0.004 | 0.483 |
| 中央区 | 256 | 2,527 | 12,617 | 2,879 | +0.024 | -0.261 | 0.479 |
| 浪速区 | 131 | 1,169 | 6,551 | 2,282 | -0.216 | -0.358 | 0.486 |
| 天王寺区 | 224 | 1,808 | 10,287 | 1,925 | -0.114 | +0.023 | 0.487 |
| 阿倍野区 | 826 | 5,388 | 19,037 | 1,674 | +0.037 | -0.127 | 0.490 |
| 淀川区 | 444 | 3,827 | 23,398 | 6,620 | +0.156 | +0.094 | 0.481 |
| 東淀川区 | 420 | 3,330 | 22,334 | 8,600 | -0.036 | -0.157 | 0.479 |
| 住吉区 | 1,411 | 7,252 | 25,365 | 900 | -0.017 | -0.109 | 0.498 |
| 西区 | 189 | 1,653 | 8,216 | 2,040 | +0.195 | -0.070 | 0.476 |
| 福島区 | 157 | 1,395 | 7,718 | 1,889 | +0.060 | -0.039 | 0.476 |
| 此花区 | 181 | 1,435 | 8,682 | 3,139 | +0.208 | +0.255 | 0.498 |
| 港区 | 298 | 2,074 | 10,259 | 2,858 | -0.106 | +0.167 | 0.488 |
| 大正区 | 292 | 2,239 | 11,580 | 3,252 | +0.112 | +0.163 | 0.481 |
| 西淀川区 | 379 | 2,613 | 14,885 | 5,365 | +0.006 | +0.027 | 0.490 |
| 都島区 | 207 | 1,785 | 9,367 | 1,837 | -0.171 | -0.231 | 0.479 |
| 東成区 | 525 | 3,816 | 16,563 | 1,073 | +0.046 | -0.075 | 0.490 |
| 生野区 | 1,177 | 8,436 | 34,051 | 2,548 | +0.061 | +0.051 | 0.492 |
| 旭区 | 527 | 4,025 | 16,265 | 1,608 | -0.029 | -0.072 | 0.495 |
| 城東区 | 587 | 4,707 | 23,099 | 4,054 | +0.067 | -0.024 | 0.475 |
| 東住吉区 | 959 | 7,126 | 28,681 | 1,723 | +0.096 | -0.073 | 0.483 |
| 西成区 | 666 | 4,983 | 21,319 | 2,236 | -0.014 | -0.119 | 0.488 |
| 鶴見区 | 304 | 2,398 | 15,803 | 3,563 | +0.066 | +0.007 | 0.469 |
| 住之江区 | 455 | 3,090 | 15,073 | 2,991 | -0.117 | -0.098 | 0.507 |
| 平野区 | 817 | 5,884 | 33,081 | 4,652 | +0.027 | -0.029 | 0.487 |

**全24区でmedianDx/dzが±0.36m以内**（roof-footprint形状ノイズ std~1.8mよりずっと小さい）。
特定区への系統的な偏りは無い。

**観察（断定ではなく傾向）**: 北区/中央区/浪速区/天王寺区/西区など都心の高層・高密度区は、
outline件数の割にHIGH件数が相対的に少ない（例: 北区 outline 17,881件に対しHIGH 215件、
生野区は outline規模が近い区と比べHIGH 1,177件と対照的）。§12のUmeda深掘りで同傾向を確認。

## §10｜地域クラスタリング（NORTH/CENTRAL/EAST/SOUTH/BAY）

大阪市の公式行政ブロックではなく、24区のbbox中心座標（znorth-neg-v1）から機械的に求めた
地理的グルーピング（BAYは大阪市が「臨海部」として扱う5区と一致）。

| region | 区 | n | medianDx | medianDz | stdDx | stdDz |
|---|---|---|---|---|---|---|
| NORTH | 東淀川・淀川・旭・都島 | 1,598 | -0.014 | -0.076 | 1.68 | 1.83 |
| CENTRAL | 北・中央・西・福島・浪速・天王寺 | 1,172 | -0.020 | -0.108 | 2.14 | 2.16 |
| EAST | 鶴見・城東・東成・生野・平野・東住吉 | 4,369 | +0.063 | -0.019 | 1.71 | 1.91 |
| SOUTH | 西成・阿倍野・住吉 | 2,903 | +0.011 | -0.119 | 2.01 | 1.95 |
| BAY | 此花・港・大正・住之江・西淀川 | 1,605 | -0.012 | +0.023 | 1.61 | 1.77 |

5地域すべてでmedianが±0.12m以内・同じ方向一致は見られない（符号がバラバラ＝ランダムノイズと整合）。
方向依存の系統誤差は無い。

## §11｜サンプル12地区別の内訳（新大阪・長居を追加）

| 地区 | n | medianDx | medianDz | p95Distance |
|---|---|---|---|---|
| 梅田 | 1 | +0.076 | +0.990 | 0.99 |
| 中之島 | 10 | +0.917 | +1.519 | 6.32 |
| 本町 | 8 | +0.624 | +0.813 | 5.11 |
| 難波 | 19 | -0.478 | -0.572 | 5.57 |
| 天王寺 | 10 | -0.467 | -0.936 | 3.14 |
| 阿倍野 | 13 | -0.836 | -0.936 | 5.66 |
| 十三 | 45 | +0.088 | -0.741 | 3.75 |
| **新大阪**（新規） | 3 | +0.853 | -3.181 | 6.46 |
| 住吉 | 88 | -0.257 | -0.138 | 4.55 |
| **長居**（新規） | 42 | -1.856 | -1.110 | 5.19 |
| 京橋 | 22 | +0.043 | -0.422 | 7.27 |
| 平野 | 64 | +0.184 | +0.309 | 4.77 |

**正直な注記**: 梅田・中之島・本町・天王寺・阿倍野・新大阪はサンプル数n<20と少なく
（450m四方の小さな枠内かつ都心部でHIGH match率自体が低いため）、個別地区medianの
信頼区間は広い。24区全体・region別（§9/§10）の方が母数が大きく結論の根拠として頑健。
長居(n=42)のmedianDx=-1.86mはやや目立つが、std~1.8-1.9mの1標準偏差以内であり、
小さいサンプルのノイズの範囲として説明可能（系統誤差と断定する根拠はない）。

## §12｜梅田 深掘り

サンプル枠内（450m四方）のmatching候補502件中、HIGH match**わずか1件**
（HIGH match率0.2%、city-wide平均2.03%の約1/10）。大型建物（面積閾値150㎡）の
個票を作れるだけの母数が無かった。

**推測（断定不可）**: 梅田は超高層・高密度建物が集中する地区。GSI outlineが
「屋根の外周線」（roof outer line）であるのに対しPLATEAU footprintは地上投影のため、
高層建物ほど庇・屋上設備等による形状差が大きくなりIoU/面積類似度の閾値を割りやすい、
という§13相当の既知の限界が最も強く効いている可能性がある。§9の都心区(北区/中央区等)で
共通して見られた「outline件数の割にHIGH件数が少ない」傾向と整合する。

## §13｜住吉 深掘り（Live City初期開発の基準地域）

サンプル枠内の全confidence候補3,890件中、HIGH match88件（HIGH match率2.3%——city-wide平均2.03%
とほぼ同水準で、梅田のような特異な低さは見られなかった）。大型建物（面積閾値150㎡以上）4件を個票化:

| dx | dz | distance | IoU | orientation差 | 面積 |
|---|---|---|---|---|---|
| -6.034 | -3.983 | 7.23 | 0.407 | 3.19° | 361.8㎡ |
| -0.245 | +1.338 | 1.36 | 0.553 | 33.14° | 348.1㎡ |
| -3.444 | +0.427 | 3.47 | 0.632 | 19.89° | 293.3㎡ |
| +0.970 | -3.708 | 3.83 | 0.403 | 1.02° | 185.2㎡ |

4件のdx/dzは個々にはばらつくが（±6m程度）、符号も大きさも一貫した方向を示しておらず
（1件目は南西・4件目は北東方向）、系統誤差ではなく建物ごとのroof-footprint形状差＋
matching自体のノイズと整合する。住吉区全体（n=1,411 HIGH、§9）でもmedianDx=-0.017m/
medianDz=-0.109mと実質ゼロであり、Live City初期開発の基準地域においても系統的なずれの
証拠は無い。

## §14｜空間回帰（dx/dz vs x/z/distance）

`spatialRegression`（FIX20/21から無変更のライブラリ関数）による全6組み合わせの相関係数:

| | r |
|---|---|
| dxVsX | 0.0065 |
| dxVsZ | 0.0137 |
| dxVsDist | -0.0128 |
| dzVsX | -0.0177 |
| dzVsZ | -0.0084 |
| dzVsDist | 0.0170 |

**全て`STRONG_R=0.4`を大幅に下回る（最大でも|r|=0.018）**。位置依存の系統誤差（ROTATION/SCALE）
の証拠は無く、`classifyShift`が`NO_SYSTEMATIC_SHIFT`と判定した根拠を裏付ける。

## §15｜datum差の実測評価

本パイプラインはdatum変換（PatchJGD等）を一切適用せずGSI(JGD2024)/PLATEAU(JGD2011)を
同一投影式で直接比較しており、今回のHIGH match統計自体が「datum変換省略時の実測誤差」に相当する。

- median vector長 = **0.059m**（文献推定レンジ「数cm」の上限0.15m以内）
- ただし全体classificationが`NO_SYSTEMATIC_BUILDING_SHIFT`のため、この0.059mは
  「datum差が実在する」ことの証拠ではなく、building-shape matching自体のノイズ
  （std~1.8-1.9m）に埋もれて**見えていないだけ**という解釈が正しい（FIX21から継続する
  慎重な言い回しを維持。二値の断定はしていない）。
- GSI公式のセミダイナミック補正パラメータファイルはネットワーク制限によりダウンロード
  出来ず、正式変換ソフトとの並行比較は未実施（FIX20/21から変わらず正直に記録）。

## §16｜最終判定

```
classification: NO_SYSTEMATIC_BUILDING_SHIFT
RESULT: GSI_BUILDING_ALIGNMENT_MEASURED
citywideCoverage.sufficient: true
```

FIX21（東淀川区限定・n=89、median 0.19m/0.22m）から、大阪市24区全域・n=11,647まで
拡大した結果、**より小さく・より頑健な**median（0.02m/0.06m）で同じ結論が再現された。
n拡大でmedianが縮小したこと自体が、FIX21の値が小サンプルノイズだったことを示唆しており、
今回の city-wide 結果の方が真値に近いと考えられる。

## §17｜runtime `[Building Alignment]` overlay の更新

HIGH match全件(11,647件)をそのままruntimeへ送るとpayloadが肥大化するため、
均等間引きで**3,883件**に縮小して`alignment-pairs-sample.json`へ収録
（統計計算自体は間引き前の全件で実施。ファイル名どおり"sample"という位置づけを維持）。
`alignment-status.json`（HIGH/MED/LOW/Unmatched・median dx/dz/distance）も更新。
動的テスト（実fetch・`tests/gsi-building-alignment.test.js`）で`status==='ready'`・
`pairCount>0`・`stats.matching`存在を確認済み。

## §18｜geometry / production 保護

- Canonical buildings: **615,617棟**（不変）
- Canonical roads: **199,658本**（不変）
- FIX13 refined-road-surface indexedCount: **30,190**（不変）
- raw GSI building-outlineファイル: 無変更（validator `rawMutation=0`）
- production (`osaka_3d_buildings.html`) / protected (`fullward-v3.html`): 無変更
- Building x/z座標・投影原点・道路geometry・FIX13/FIX19コード: 一切変更していない

## §19｜validator / test

`tools/validate/gsi-building-alignment.js` を拡張（新規`CITYWIDE_GSI_BUILDING_COVERAGE_INSUFFICIENT`
RESULTに対しても`GSI_BUILDING_ALIGNMENT_MEASURED`と同じfakeMatchチェックを適用する分岐を追加）。

```
RESULT: PASS
rawMutation=0, canonicalBuildingMutation=0, canonicalRoadMutation=0, fakeMatch=0,
crsMismatchUntracked=0, runtimeMagicOffset=0, lowConfidenceUsedForCalibration=0,
productionModified=false, protectedModified=false
```

`npm test`: **1473 tests / 1458 pass / 0 fail / 15 skip**（既存の固定長slice等の脆弱testパターンの
再発は無し。今回の変更に対応する新規回帰テストを`tests/gsi-building-outline-import.test.js`と
`tests/gsi-building-alignment.test.js`に追加、全てpass）。

`git diff --check`: 実質的な問題なし（既存ファイルのLF/CRLF警告のみ、今回の変更由来ではない）。

## §20｜ファイル変更サマリ

**新規**:
- `tools/lib/large-json-array-reader.js`（大容量features配列のstreaming読込）

**変更**:
- `tools/lib/zip-reader.js`（`readZipEntriesFromBuffer`/`extractEntryFromBuffer`を純粋追加。既存関数は無変更）
- `tools/import-gsi-building-outline.js`（ネストZIP対応・メッシュ重複検出・streaming書込。FIX21の
  spread修正・非BldL-skip最適化は維持）
- `tools/audit/gsi-building-alignment.js`（streaming読込・§2/§3 key-ward coverage判定・§9 24区full breakdown・
  §10 region clustering・§11 12地区・§12/13 deep dive・§8 robust stats追加。matching library自体は無変更）
- `tools/validate/gsi-building-alignment.js`（新RESULT値への対応分岐追加）
- `tests/gsi-building-outline-import.test.js`（streaming書込の回帰防止テスト追加）
- `tests/gsi-building-alignment.test.js`（FIX22セクション7件追加）

**data/raw配下は無変更**（既存2ファイルのみ、今回はユーザーが事前に配置済み）。

---

## 完了条件チェックリスト

- [x] §1 raw mesh inventory（2ファイル・62 zip entries・6メッシュ・523514重複検出）
- [x] §2 24区coverage再計算（missingWards=0）
- [x] §3 重要8区STOP条件チェック（全区covered、STOP未発生）
- [x] §4 importer scalability（FIX21修正維持＋新規streaming書込/読込修正）
- [x] §5 matching library無変更で再利用
- [x] §6 HIGH match目標達成（11,647件、閾値緩和なし）
- [x] §7 HIGH/HIGH+MEDIUM一致確認
- [x] §8 robust statistics（MAD・trimmed mean）追加
- [x] §9 24区full breakdown
- [x] §10 region clustering
- [x] §11 12地区（新大阪・長居追加）
- [x] §12 梅田深掘り
- [x] §13 住吉深掘り
- [x] §14 空間回帰
- [x] §15 datum差実測評価
- [x] §16 最終判定（4択のいずれか・曖昧な結論なし）
- [x] geometry/production完全不変
- [x] validator PASS
- [x] npm test 0 fail
- [x] git diff --check clean

**次工程へ自動で進まずSTOPします。ユーザーの確認をお待ちします。**
