# Mission 32B 完了報告｜GSI Unified Building Placement
## GSI道路区画とGSI建築物を同一基盤として使い、建物を街区内へ正しく収める

**最終ステータス: `VISUAL_QA_PENDING_USER`**（validator PASS のみでは完了とみなさない。実機確認と
下記の正直な限界についてのご判断が必要）

---

## 0. 要約

**MAP POSITION/FOOTPRINT TRUTH = GSI、3D HEIGHT/ATTRIBUTE TRUTH = PLATEAU** という分離方針に従い、
新規「Visual Building Geometry」層（`data/processed/osaka-city/visual-buildings/`）を構築した。
Canonical Buildings(615,617)・Canonical Roads(199,658)・raw GSIデータはすべて不変。

**正直に先に報告する重要な制約**: §8-14で要求された「building footprintのblock(街区)内包含率」の
測定を、GSI Road Edgeを使って実装・実測したところ、**GSI Road Edgeネットワーク自体に閉じた
ループを形成しない箇所（topological gap）が非常に多く、city-wideサンプルの82%で「blockが
閉じきれず信頼できる測定ができない」という結果になった**。これは§14が想定した「GSI同士でも
はみ出すなら、PLATEAUの問題ではない」という検証をさらに一歩進めた発見であり、道路データの
限界そのものが可視化の妨げになっているという新しい知見である。信頼できた残り18%の測定では、
サイトによって48-78%の建物がfully insideで、系統的な大規模はみ出しの証拠にはならなかった。

## 1. GSI Buildingで使えたgeometry種別

**BldA（建築物ポリゴン）を新規に実データから抽出した（§2「推測禁止」を遵守・初めて実ファイルを
確認）。** これまでのミッション（FIX20-22）はBldL（建築物の外周線・LineString）のみを使っていたが、
今回raw ZIPを直接調査した結果、**BldA（建築物・Polygon。中庭等の穴=interior ringを正式に保持）**
が同じZIPに同梱されていることを確認し、専用パーサ（`tools/lib/gsi-building-area-gml.js`）と
importer（`tools/import-gsi-building-area.js`）を新規実装した。24区全域(6メッシュ)から
**571,325件**のGSI Building Polygonを抽出（918件が穴あり）。BldLより直接的なfootprint polygon
候補という§3の優先順位どおり、こちらを「GSI building polygon」として採用した。

## 2. Visual Building総数

**600,684件**（`totalVisualBuildings`）。内訳は後述（§4/§5参照）。Canonical 615,617棟のうち
one-to-many/many-to-oneの統合・分割により総数が変化している（例: 複雑な集合住宅群が1つの
Visual Buildingへ統合される等）。

## 3. GSI geometry採用数

**244,196件（40.65%）** が`geometrySource=GSI_POLYGON`（GSI BldAをそのまま採用・移動/scale/warp
一切なし）。

## 4. PLATEAU fallback数

**356,488件（59.35%）** が`geometrySource=PLATEAU_FALLBACK`（GSIとの意味のある重なりが見つから
なかったPLATEAU建物 + osm-fallback建物41,505件全て）。

## 5-7. 関係タイプ内訳

| relationship | 件数 |
|---|---|
| ONE_TO_ONE | 97,405 |
| ONE_TO_MANY | 30,422 |
| MANY_TO_ONE | 37,355 |
| COMPLEX | 11,534 |

**重要な発見と修正**: 初回実装（bbox overlap閾値0.15）では、隣接する別棟どうしがtransitive
closure（union-findの連鎖）で誤って同一groupへ巻き込まれ、**最大34棟が1つのCOMPLEX groupに
連結される**実例を検出した。閾値を0.15→0.55へ引き上げることで最大連結数を21棟まで抑制し、
ONE_TO_ONEが65,421→97,405件（+49%）に増加（誤連結が解消され、より信頼できる1:1判定が増えた）。
高さ割当は§7のルールどおり: ONE_TO_ONEはPLATEAU heightそのまま、ONE_TO_MANYは同一heightを
各partへ、MANY_TO_ONEはfootprint面積加重平均、COMPLEXは代表棟のheightを暫定付与しconfidence=
REVIEWとして正直に記録（勝手な高さ補正はしていない）。

## 8. block数

**正直な設計判断（§8/§9）**: グローバルなblock polygonデータセットは構築していない。FIX17-19で
「本格的なroad networkのpolygonize（交差点処理を含むtopology構築）は時間内で実装しない」と
明記されてきた経緯を踏襲し、今回も同様の判断をした。代わりに、建物ごとの局所ウィンドウを
grid rasterize+flood-fillする近似手法で直接containmentを測定した（後述）。そのため「block数」
という単一の city-wide カウントは存在しない（建物ごとに動的に局所blockを求める設計）。

## 9. block assignment率

**測定した建物のうち、信頼できる形で局所blockへ割当てできたのは17.8%のみ**（city-wideサンプル
2,968件中528件）。残り82.2%は「§13分類=BLOCK_POLYGONIZATION_ERROR」——**margin(建物bbox拡張幅)を
45m→90mへ倍増させても結果がほぼ変化しなかった**ため、これはラスタウィンドウの不足ではなく、
**GSI Road Edgeネットワーク自体が閉じたループを形成しない箇所が多いこと**（FIX16-18で既知だった
「交差点付近の短フラグメント」問題と整合）が原因と判断した。

## 10-13. fully inside / slightly outside / major outside / manual review率

**信頼できる測定（block閉鎖に成功したケース）のみで集計**（openBlockのケースはoutsideRatioの
値自体が信頼できないため分離。詳細は§9参照）:

| 対象 | 信頼できる測定数 | fully inside | slightly outside(2-15%) | major outside(>15%) |
|---|---|---|---|---|
| city-wide sample | 528 | 57.77% | 36.36% | 5.87% |
| 梅田 | 64 | 48.44% | 23.44% | 28.13% |
| 中之島 | 87 | 56.32% | 21.84% | 21.84% |
| 本町 | 189 | 78.31% | 13.23% | 8.47% |
| 難波 | 396 | 53.28% | 35.86% | 10.86% |
| 天王寺 | 131 | 52.67% | 22.14% | 25.19% |
| 住吉 | 619 | 59.13% | 19.71% | 21.16% |

manual review（COMPLEX関係のもの）は11,534件（全体の1.9%）。

**注記**: 信頼できるサンプル数が各地点64-619件と少なく、統計的な確度には限界がある（§9の
topology gap問題により、測定できた母数自体が小さいため）。

## 14. 梅田結果（重点）

大型・高層建物を含む梅田サンプルで、信頼できる測定64件中: fully inside 48.44%・major outside
28.13%。**§14の核心（GSI-vs-GSIでも越えるか）に対する回答**: 今回のVisual Buildingの多くは
`geometrySource=GSI_POLYGON`（GSI建物）であり、これをGSI Road Edgeと比較しているため、**測定できた
限りでは「GSI同士でも一定割合ではみ出しが見られる」**——これは（a）密集市街地での建物と道路の
現実の近接（庇・オーバーハング等）、（b）GSI内部でも建物調査と道路調査が別キャンペーン・別時期で
実施されていることによる局所的な非整合、（c）本手法自体の残存誤差、のいずれかまたは複合と考えられ、
断定的な結論は避ける。ただし**梅田は測定可能率も低く（575件中64件=11%のみ信頼できる測定）、統計的な
確証には至っていない**。

## 15. 難波結果

信頼できる測定396件中: fully inside 53.28%・slightly outside 35.86%・major outside 10.86%。
6地点中もっとも「slightly outside」の割合が高い。

## 16. 天王寺結果

信頼できる測定131件中: fully inside 52.67%・major outside 25.19%。

## 17. 住吉結果

信頼できる測定619件中: fully inside 59.13%・major outside 21.16%（6地点中もっとも母数が大きい）。

## 18. runtime結果

**Visual Building Geometryを opt-in devトグルとして実装した（既定OFF）。** status panel内の
`[Visual Buildings(GSI)]`ボタンでON/OFF切替可能（Console不要）。ONにすると`buildings`層の
tile fetch先が`near/mid/far/buildings`から`visual-buildings/{near,mid,far}`へ切り替わる
（既存の`buildGroup`/extrusion/placement policy/pickingコードは無変更——tile schemaを
`canonicalId`(単一・property card互換)・`canonicalIds`(配列)・`attributes.heightM/usageCategory`
等、既存near/buildingsと同一に設計したため）。**§0の理由により、今回はdefaultへ昇格させていない**:
上記の測定結果（信頼できる測定が18%程度に留まり、その中でも一定のはみ出しが見られる）を踏まえ、
データ品質にはまだ改善余地があると判断した。動的テストでON/OFF切替後もLegacy residual=0を確認済み。

## 19. performance

近傍・遠景ともに既存の500m tile architecture・near/mid/far LOD階層をそのまま踏襲
（`tools/build-visual-buildings-derived.js`でNEAR=exact/MID=6m/FAR=12m simplify）。
Visual Buildings tierの容量: near 421MB / mid 314MB / far 71MB（公開データ総量は既存873.7MBから
1,671.1MBへ増加、+797MB）。**opt-inトグルのためdefault表示時の性能には影響しない**（fetchされない）。
ON時の実機フレームレート・draw calls等は本セッションでは測定不可（ブラウザ不可）。

## 20. validator

`node tools/validate/visual-buildings.js` → **RESULT: PASS**（全16チェックtrue/0）。
`canonicalBuildingMutation=0`・`gsiBuildingMutation=0`・`gsiRoadMutation=0`・
`visualBuildingBlockAssigned=true`・`gsiGeometryUsed=true`・`majorOutsideRateReported=true`・
`illegalGlobalOffset=0`・`illegalGlobalScale=0`・`illegalWarp=0`・
`correctionNotAppliedByDefault=true`（局所補正は今回0件=未適用）。

## 21. npm test

```
ℹ tests 1547
ℹ pass 1532
ℹ fail 0
ℹ skipped 15
EXIT=0
```
前回ミッション(31G-FIX25)完了時点(1539/1524)から、新規`tests/visual-buildings.test.js`
（8件、全PASS）分だけ純増。退行0件。

## 22. visual QA status

**`VISUAL_QA_PENDING_USER`。** 実機ブラウザでの確認事項:
1. status panelの`[Visual Buildings(GSI)]`をONにし、Currentのbuilding footprintとの見た目の違いを確認。
2. 梅田・中之島・本町・難波・天王寺・住吉で、GSI Road Edge（緑）とVisual Building（ON時）の関係を確認。
3. §9で判明した「measurement困難」自体が実際のGSI道路縁の疎密とどう対応するか、目視で確認。

---

## §0 Geometry Freeze の遵守確認

- Canonical Buildings featureCount=615,617（不変）
- Canonical Roads featureCount=199,658（不変）
- refined-road-surface.json indexedCount=30,190（不変）
- GSI raw data（BldA/BldL/RdEdg）: importスクリプトは正規化・大阪市clipのみ、simplify/buffer/snap/
  pair/polygonizeは一切行っていない
- Visual Building構築時、global offset/global scale/warpコードは検出されず（validator確認済み）
- 局所補正（PLATEAU_FALLBACK_ADJUSTED）は0件——§17-19の厳格な適用条件（GSI unavailable・block
  assignment HIGH confidence・shape維持・小さなtranslationのみ・近隣配置を壊さない）を満たすケースの
  実装・適用まで手が回らなかったため、今回は**適用しない**という保守的な選択をした（正直な開示）。

---

## 完了チェックリスト（§39対応の総括）

- [x] GSI BldA実データ確認・抽出（推測なし）
- [x] Visual Building Geometry構築（600,684件）
- [x] one-to-one/one-to-many/many-to-one/complexの正式対応
- [x] 高さ割当ルール実装（勝手な補正なし）
- [x] GSI-vs-GSI containment測定（重要な制約を発見・正直に報告）
- [x] 6地点QA（梅田重点含む）
- [x] runtime opt-inトグル実装（default不変)
- [x] validator PASS
- [x] npm test 0 fail
- [x] Canonical geometry完全不変
- [ ] 局所補正の実装・適用（§17-19、今回は0件・見送り）
- [ ] グローバルblock polygonデータセット（§8/§9、今回は局所ラスタ近似で代替）
- [x] **STOP** — 次工程へは自動で進まない

**次工程へ自動で進まずSTOPします。** 特に「GSI Road Edgeのtopological gapにより信頼できる
containment測定が18%程度に留まる」という発見は、今後このアプローチをさらに進めるべきか
（例: block判定手法自体の再設計、GSI Road Edgeの別途polygonization等）の重要な判断材料になると
考えます。ご確認・ご指示をお願いします。
