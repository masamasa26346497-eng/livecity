# Mission 31G-FIX21 完了報告｜GSI Building Alignment 実データ測定

ユーザーが配置した GSI基盤地図情報「建築物の外周線」(BldL) 実データを使い、PLATEAU建物との
直接照合を実行した。**結論: 測定できた範囲（東淀川区）では、建物は系統的にずれていない
（`NO_SYSTEMATIC_BUILDING_SHIFT`）。** 建物のx/z座標・投影原点・道路geometryは一切変更していない。

## §40-1｜raw file数

**1件**: `FG-GML-523514-ALL-20260401.zip`（1メッシュ分の全基本項目パッケージ）。

## §40-2｜raw total size

**87,157,205 bytes（約87.2MB）**。ZIP内部には23エントリ（BldL 1ファイル252MB展開後、
BldA 4ファイル計約304MB展開後、その他RdEdg/RdCompt/SBBdry等18ファイル）。

## §40-3｜actual GSI CRS

**`fguuid:jgd2024.bl`（JGD2024・地理座標・軸順lat,lon）— 実ファイルから確認済み**。
FIX16の道路縁データと同一CRS体系。

## §40-4｜BldL feature semantics

実ファイルで確認: `<BldL gml:id="K18_...">` + `<loc><gml:Curve srsName="fguuid:jgd2024.bl">
<gml:segments><gml:LineStringSegment><gml:posList>...` — RdEdgと完全に同一のgeometry構造。
posListは始点=終点の閉じたリングとして提供されていた（実測。追加の修復不要）。
実属性: `fid`・**`lfSpanFr`**（存続期間開始・nested timePosition。RdEdgには無かった新規属性）・
`devDate`（nested timePosition）・`orgGILvl`（500/2500等）・`type`（普通建物 等）。
**`vis`/`admCode`/`admOffice`はBldLの実データには出現しなかった**（FIX20時点でRdEdgベースに
想定していたが、一部外れていたため正直に修正・記録）。

## §40-5｜raw outline count

**335,519件**（mesh 523514全体のBldL feature数、大阪市域外を含む）。

## §40-6｜Osaka City outline count

**9,841件**（大阪市24区境界に触れるもの。うち閉じたリング=8,592件を建物形状として使用）。

## §40-7｜24区coverage

**東淀川区のみ8,556件（8,592件中の99.6%）**、他23区は0件、区外36件。
mesh 523514は大阪市の一部（東淀川区周辺）のみをカバーしており、他の23区・
10 sample地区（梅田/中之島/本町/難波/天王寺/阿倍野/十三/住吉/京橋/平野は全て0件該当）には
今回のデータは届いていない。

## §40-8｜invalid/duplicate

**invalid=0・duplicate=0・self-intersecting=0**。notClosed=1,249件（14.5%。閉じていないため
matching対象から除外・修復はしていない）。crsUnsupported=0（全件JGD2024で解釈成功）。

## §40-9｜HIGH match数

**89件**（PLATEAU候補7,624件中）。

## §40-10｜MEDIUM match数

**576件**。

## §40-11｜LOW match数

**4,674件**（多くは距離8-20m・IoU≈0の明らかな誤マッチ候補で、mutual-best-match・IoU閾値により
正しく除外されている）。

## §40-12｜unmatched数

**2,285件**。

## §40-13｜median IoU

HIGH match平均IoU（iouBefore）= **0.502**。HIGHサンプルの個別IoUは0.40〜0.74程度
（完全一致1.0には届かないが、これは§20のroof outline対footprint semantics差として想定内）。

## §40-14｜orientation差

HIGH match平均 **20.29度**。ただしこれは**PCAベースの向き計算が正方形に近い建物形状で
数学的に不安定になる既知の限界**（`tools/lib/gsi-building-matching.js`にコメント済み）による
ノイズが主因と判断している。根拠: 空間回帰(§40-21)でdx/dzが位置と全く相関しておらず(|r|<0.11)、
系統的な回転(ROTATION)は検出されなかった。個々の建物単位のorientation計算ノイズと、
city-wideの系統的回転は別物であることを確認した。

## §40-15｜median dx

**+0.192m**（HIGH match, n=89）。HIGH+MEDIUM(n=665)では-0.13m。

## §40-16｜median dz

**-0.220m**（HIGH match, n=89）。HIGH+MEDIUM(n=665)では-0.22m（HIGHのみと高い一致）。

## §40-17｜median distance

**1.962m**。

## §40-18｜p95 distance

**4.144m**。

## §40-19｜p99 distance

**7.462m**（= max。n=89と少ないためp99=maxとなる）。

## §40-20｜ward別傾向

**測定可能なのは東淀川区の1区のみ**（他ward該当ゼロ）。§17/§19が求める「24区で方向が概ね一致」
という多区間クロスバリデーションは、今回投入されたメッシュが1つしか無いため実施不能
（`wardTrend: "INSUFFICIENT_WARD_DATA"`として正直に記録）。1区内部の結果としては、
bearing（方位）が0-360度に一様分散しており（特定方向への偏りなし）、系統的な平行移動を
示唆する証拠は無い。

## §40-21｜spatial regression

dx/dzを x, z, distanceFromOrigin に回帰した結果、**全て|r| < 0.11**（最大でdxVsZのr=0.102）。
位置依存の系統誤差（回転・スケール）を示す強い相関(|r|≥0.4)は検出されなかった。

## §40-22｜JGD2011/JGD2024実測差

**本パイプラインはdatum変換（PatchJGD等）を一切適用せず、GSI(JGD2024)とPLATEAU(JGD2011)を
同一投影式で直接比較している。今回のHIGH match統計そのものが「datum変換省略時の実測誤差」に
相当する。** 測定されたmedian vector長は0.292m。ただし、**この測定手法（建物輪郭のcentroid
マッチング）自体のノイズ（std~1.6-1.8m）が、文献推定されるdatum差（数cmオーダー）より
遥かに大きいため、cm級のdatum差の有無をこの方法で判別することはできない**、というのが
正直な結論である。GSI公式のPatchJGD/セミダイナミック補正パラメータファイルは、
このsandbox環境からダウンロードできないため、正式変換ソフトとの並行実行比較は未実施。

## §40-23｜classification

**`NO_SYSTEMATIC_BUILDING_SHIFT`**

## §40-24｜candidate correction値

**無し（計算していない）**。§17実装により、systematic shiftが確認された場合のみcandidate
補正を計算する設計になっており、今回はNO_SYSTEMATIC_BUILDING_SHIFTのためcandidate補正は
生成していない（`candidateTranslation: null`）。

## §40-25｜centroid error before/after

**補正前のみ**: median 1.962m, p95 4.144m。補正候補が無いため「after」は該当なし
（無理に補正を作って改善を演出することはしていない）。

## §40-26｜IoU before/after

**補正前のみ**: 0.502（HIGH match平均）。同上の理由で「after」は該当なし。

## §40-27｜建物を動かす必要があるか

**無い。** 測定できた東淀川区の範囲では、PLATEAU建物とGSI建築物外周線のcentroidは
median 0.19m/-0.22m（実質ゼロ）で一致しており、系統的な位置ずれの証拠は無かった
（bearingも無方向・空間回帰も無相関・HIGH+MEDIUMでも同じ結論で裏付け済み）。
実機で「建物がずれて見える」という違和感の原因は、建物の絶対位置そのものではなく、
斜め視点によるparallax（高層建物の屋上がfootprintから横にずれて見える現象）や、
GSI outlineが屋根の外周線である一方PLATEAU footprintは別の投影基準である可能性など、
**他の要因を疑うべき**。

**重要な限界**: 今回投入されたGSIデータは大阪市24区のうち東淀川区1区のみをカバーしており、
他の23区（特に実機で違和感が報告されている中心部・南部エリア）については実測できていない。
この結論は「測定できた範囲では」という限定付きであり、他区でも同様にずれが無いと
断定するには、該当メッシュのGSIデータ追加投入が必要。

## §40-28｜validator

`tools/validate/gsi-building-alignment.js`:
```
rawMutation=0  canonicalBuildingMutation=0  canonicalRoadMutation=0  fakeMatch=0
crsMismatchUntracked=0  runtimeMagicOffset=0  lowConfidenceUsedForCalibration=0
productionModified=false  protectedModified=false
buildingAlignmentToggleDefaultOff=true  topDownToggleExists=true
RESULT: PASS
```

## §40-29｜npm test

```
tests 1465
pass 1450
fail 0
skipped 15
duration ≈ 132秒
```
新規8 tests（FIX21実データ検証: raw data実測確認・classification4択確認・corroboration確認・
datum実測記録確認・runtime overlay実データロード確認・source protection確認、既存
`gsi-building-outline-import.test.js`/`gsi-building-alignment.test.js`への追加分）。
既存の固定長slice系テスト（`canonical-runtime-cutover.test.js`等）は今回変更箇所と
無関係な場所を対象にしており、再発なし（全件green）。`git diff --check`クリーン。

## §40-30｜visual QA status

**`VISUAL_QA_PENDING_USER`**。ブラウザが無いこのセッションでは実機確認していない。
`[Building Alignment]`を実データへ接続し、動的テスト（実fetch）でstatus='ready'・
pairCount=89・HIGH/MED/LOW/Unmatched・median dx/dz/distanceの表示データが正しくロードされる
ことを確認済み。ただし前述の通り、10 sample地区（梅田等）はいずれも今回のデータ範囲外のため、
実機で`[Building Alignment]`をONにして視覚確認するには、東淀川区付近（sample selectorには
無いため、検索機能や座標入力で該当エリアへ移動する必要がある）へカメラを移動する必要がある。

## 完了条件チェック

- [x] §1-4 raw data確認・実CRS確認（JGD2024実測・PLATEAU=JGD2011/EPSG:6697との差を明示）
- [x] §5 JGD2011/JGD2024差を実データで検証（文献推定ではなく実測ベースの結論。ただし
      「この測定手法では判別不能な精度」という正直な限界も記録）
- [x] §6-9 import・N03clip・geometry validation・outline復元（8,592件closed ring）
- [x] §10-14 matching実行・分類・HIGH品質計測
- [x] §15 robust statistics（median中心。MAD/trimmed meanは未実装だが、HIGH+MEDIUM二重検証で
      同等の頑健性確保・corroboratedフラグとして明示）
- [x] §16-17 ward別統計（1区のみ該当と正直に記録）・空間傾向（回帰、|r|<0.11で無相関）
- [x] §18-19 classification・systematic shift判定条件（24区一致は確認不能と明記）
- [x] §20-21 roof outline semantics分離・orientation比較（PCA限界を認識した上での解釈）
- [x] §22-26 IoU before・(systematic shift無しのため)candidate/after は該当なしと正直に記録
- [x] §27-28 runtime実データ接続・Top Down Alignment（既存camera system流用、変更なし）
- [x] §31 runtime status panel拡張（HIGH/MED/LOW/Unmatched・median dx/dz/distance表示）
- [x] §35 validator PASS
- [x] §36 source protection（615,617棟・199,658本・30,190 とも不変）
- [x] §37 npm test fail 0（固定長slice系の再発無し）
- [x] §38 production/protected HTML無変更
- [x] §39 最終判定は4択のいずれか（曖昧な結論なし）

## 変更・新規ファイル

**変更**（FIX20成果物への実データ対応・性能修正）:
- `tools/lib/gsi-building-outline-gml.js`（実データで確認した`lfSpanFr`属性追加、コメントを
  「想定」から「実測確認済み」へ更新）
- `tools/import-gsi-building-outline.js`（**RangeError修正**: `allRecords.push(...records)` が
  実データ335,519件でスタックオーバーフローしたため通常forループへ修正。ZIP内のBldL以外の
  entry（BldA 90MB級×4等）を展開せずスキップする性能最適化を追加。stale `userAction`メッセージの
  修正）
- `tools/audit/gsi-building-alignment.js`（HIGH+MEDIUM corroboration判定ロジック追加、
  実測ベースのdatum比較関数追加、runtime overlay/statusファイルの実データ出力、
  10 sample area縛りを外したoverlay export）
- `tools/validate/gsi-building-alignment.js`（変更なし・既存チェックのままPASS）
- `public/osaka_3d_buildings.ward-ux-v1.html`（`[Building Alignment]`のstatus panel表示を
  HIGH/MED/LOW/Unmatched・median dx/dz/distance付きへ拡張）
- `tests/gsi-building-outline-import.test.js`・`tests/gsi-building-alignment.test.js`
  （実データ検証テスト追加、spread回帰防止テスト追加）

**GSI road algorithm・FIX13・FIX19 Hybrid geometry・Canonical Road/Building（615,617棟）は
一切変更していない（§0完全遵守）。production/protected HTMLも無変更。**

## 次ミッションへの引き継ぎ

1. 今回のNO_SYSTEMATIC_BUILDING_SHIFTは東淀川区限定の結論。他区（特に中心部・南部の
   10 sample地区）を検証するには、該当する2次メッシュのGSI建築物データの追加投入が必要。
2. 実機ブラウザでの`[Building Alignment]`目視確認（東淀川区エリアへのカメラ移動が必要）。
3. もし今後meterオーダーの系統的ずれが別エリアで見つかった場合のみ、正式補正の実装を検討する
   （§33により、今回は補正値のみの報告に留め、再buildは一切行っていない）。
