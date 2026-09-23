# Mission ALIGNMENT-VISIBILITY-FINAL 完了報告
## Reference AlignmentでPLATEAU/GSI建物輪郭を確実に表示し、ずれ問題を最終判定する

**最終ステータス: `VISUAL_QA_PENDING_USER`**（validator PASS のみでは完了とみなさない。
実機スクリーンショットによる最終判定が必要）

---

## 0. 要約

実機で「PLATEAU footprint(cyan)/GSI Building Outline(magenta)がほぼ視認不能」と報告された原因は、
**表示ロジックのバグではなく、参照していたデータソースそのものが疎すぎたこと**だった。従来の
Reference Alignmentは FIX20-22 で作られた「PLATEAUとGSIのマッチ済みペア」（HIGH match・全市
truncated 3,883件）だけを描画しており、これは都心部で密度がほぼ0（FIX22で既に「梅田サンプル枠内で
HIGH match率わずか0.2%」と判明済みだった）。今回、**マッチングに依存しない独立ソース**——PLATEAU
footprintは Canonical Buildings（FIX24 exact tier）、GSI Building Outlineは GSI基盤地図情報「建築物の
外周線」の city-wide 生データ——から直接overlayを生成する方式へ置き換えた。geometry・座標・
projectionは一切変更していない。

## 1. PLATEAUが見えなかった原因

**データ量の問題（表示バグではない）。** 旧実装は `alignment-pairs-sample.json`（HIGH match ペアのみ・
全市で11,647件中3,883件をtruncate配信）を参照しており、cyan線はこの「マッチ済みペア」の
PLATEAU側リングだけを描画していた。梅田のような都心部・高層密集地では、GSI outline(屋根の外周線)と
PLATEAU footprint(地上投影)の形状差により HIGH match率が city-wide平均(2.03%)の1/10程度しかない
（FIX22で判明済み）ため、視野内にほぼ何も描画されなかった。今回、`derived/near/buildings`
（FIX24・tolM=0 exact tier・publish済み）を直接タイルfetchしてringをそのままLineSegments化する
独立処理に変更し、マッチング結果に関係なく「その場にある全建物」を表示するようにした。

## 2. GSI Buildingが見えなかった原因

同じく**データ量の問題**。GSI Building Outline(magenta)も同じ`alignment-pairs-sample.json`のGSI側
リングを描画していたため、PLATEAUと全く同じ疎さの制約を受けていた。今回、city-wideの生データ
（`data/processed/osaka-city/gsi-building-outline/building-outline-lines.json`・596,183件・
FIX20-22で正規化済み・無加工）を新規`tools/build-gsi-building-outline-tiles.js`で500mタイルへ
再配置し、Reference Alignment側は現地点周辺のタイルを直接fetchして全fragmentを描画するよう変更した。

## 3. 梅田のPLATEAU footprint数

**1,986件**（fetchしたタイル内の総数）、うち半径380m以内で**321件が可視**（LineSegmentsとして描画）。

## 4. 梅田のGSI outline数

**1,932件**（fetchしたタイル内の総数）、うち半径380m以内で**324件が可視**。

## 5. road edge数

**8,297件**（梅田近傍でfetch済みタイルの合計。既存のGSI Road Edge Authoritative Layerをそのまま再利用）。

## 6. renderOrder

`REN.building`(700)を基準に、road edge(既存の`REN.building+20`=720) < PLATEAU footprint
(`REN.building+30`=730) < GSI Building Outline(`REN.building+40`=740)。建物輪郭2色が道路縁より
確実に上へ描画される。

## 7. Y offset

道路縁(既存Y=0.20)はそのまま維持。PLATEAU footprintをY=0.25、GSI Building OutlineをY=0.30へ新設し、
どの2レイヤーも同一Yにならないよう分離（既存の`MAP_LAYER_Y`階層と同じ設計思想）。

## 8. depth設定

Reference Alignment専用の`REF_PLATEAU_MAT`/`REF_GSI_BLD_MAT`（`THREE.LineBasicMaterial`）を新設し、
両方とも`depthTest:false, depthWrite:false`を設定。通常Runtime描画に使うmaterialとは完全に非共有
（§8遵守）。GSI Road Edgeの既存materialはそのまま（`depthTest`は既定true・変更していない）。

## 9-11. 難波・天王寺・住吉 結果

全6地点で実測（`tests/alignment-visibility-final.test.js`の動的テストで自動検証済み）:

| 地点 | PLATEAU件数(可視) | GSI Building件数(可視) | Road Edge件数 | Sample match(頂点距離) | 3D building非表示 |
|---|---|---|---|---|---|
| 梅田 | 1,986 (321) | 1,932 (324) | 8,297 | 57 | ✓ (0) |
| 中之島 | 2,296 (366) | 1,946 (400) | 8,297 | 107 | ✓ (0) |
| 本町 | 2,985 (793) | 3,099 (788) | 8,796 | 237 | ✓ (0) |
| 難波 | 4,304 (997) | 4,394 (1,103) | 9,463 | 373 | ✓ (0) |
| 天王寺 | 2,018 (688) | 2,025 (798) | 10,197 | 310 | ✓ (0) |
| 住吉 | 8,352 (2,165) | 7,186 (1,927) | 11,253 | 1,562 | ✓ (0) |

全地点で3データとも0件を回避（§11/§12のcoverage要件を満たす）。property popupは全地点で非表示
（`propertyPopupVisible: false`）。6地点を順に巡回した後もLegacy residual=0を維持。

**正直な注記（Sample match の計測方法）**: 上表の「Sample match」は「PLATEAU footprintの重心」から
「最寄りのGSI outline頂点」までの距離が5m未満のペアをカウントした簡易照合であり、FIX21/22の
city-wide統計（GSI outline自体の重心どうしのcentroid-to-centroid・全市medianDx=0.019m/
medianDz=-0.056m）とは計測方法が異なる。頂点は建物輪郭上の点のため、真の位置誤差が0でも建物の
半径相当のオフセットが乗る（実測medianDistanceは2.5〜3.2m）。**位置精度の正式な指標としては
FIX21/22のcity-wide centroid-to-centroid統計を参照すべきであり、この簡易指標は「同じ場所に
対応する建物がどれだけ見つかるか」の目安に留める**（validator/report双方にこの注記を明記）。

## 12. geometry変更なし確認

`tools/validate/alignment-visibility-final.js`の`geometryMutation=0`・`coordinateMutation=0`で確認。
canonical buildings featureCount=615,617／canonical roads featureCount=199,658／
refined-road-surface.json indexedCount=30,190、いずれも不変。projection定数(135.52502)も不変。
production/protected HTMLも無変更（hash baseline比較で確認）。

## 13. Validator

`node tools/validate/alignment-visibility-final.js` → **RESULT: PASS**（全19チェックtrue/0）。
既存の`tools/validate/alignment-reset.js`もPASSを再確認（前回ミッションの成果物に影響なし）。

## 14. npm test

```
ℹ tests 1527
ℹ pass 1512
ℹ fail 0
ℹ skipped 15
EXIT=0
```
前回ミッション(ALIGNMENT-RESET)完了時点のベースライン（1519 tests/1504 pass）から、新規
`tests/alignment-visibility-final.test.js`（8件、全PASS）分だけ純増。既存テストの退行は0件。

## 15. visualQaStatus

**`VISUAL_QA_PENDING_USER`。** 実機ブラウザでの最終確認が必須:
1. `[Reference Alignment]`を開き、cyan(PLATEAU)/magenta(GSI Building)が今度こそ明確に見えるか。
2. 6地点それぞれで、右下パネルの overlay counts（PLATEAU/GSI Building/Road Edge の件数・Visible内訳）
   が0件のERROR表示になっていないか。
3. cyanとmagentaの重なり方から、mission本体§18の判定ルール（A: 建物位置OK / B: 系統的な方向ずれ /
   C: 道路参照だけ不自然 / D: roof-vs-footprint形状差）のどれに該当するかをユーザー自身の目で判定。
4. property card・building hover tooltipがReference Alignment中に一切出ないこと。
5. サイト切替のたびに前サイトのoverlayが残っていないこと。

---

## 作業中に発見・修正した副産物

1. **`#prop-card`のvisible判定の落とし穴**: `.style.display !== 'none'`という判定は、CSS側
   （`display:none`）で初期非表示にしているだけの要素に対しては常に「表示中」と誤判定する
   （inline styleは空文字のまま、CSSのdisplay:noneはstyle.displayに反映されない）。
   `showPropertyCard()`が明示的に`'block'`をセットする設計に合わせ、`=== 'block'`での判定へ修正。
2. **GSI Road Edgeの初回fetchが不必要に遅延する経路を発見・修正**: `updateGsiRoadEdgeByCamera()`は
   manifest未読込時に読込を開始して即returnするだけで、次のfetchは次回の per-frame `update()` tick
   （約200ms周期のrAFループ）任せだった。Reference Alignmentを開いた直後にoverlay countsを
   即座に確認しようとすると、road edge側だけ0のままになる非対称な挙動があったため、
   `ensureGsiRoadEdgeReady()`という「manifest+対象タイルを全てawaitする」専用経路を新設し、
   `setReferenceAlignment()`から使うよう変更（通常表示側のstreaming版`updateGsiRoadEdgeByCamera`は
   無変更）。
3. **旧`[Building Alignment]`トグルとの状態競合**: Reference Alignment ONで強制OFFにした
   `buildingAlignmentGroup.visible`を、OFFに戻す際に元の値へ復元し忘れていたため修正
   （ユーザーが独立して`[Building Alignment]`をONにしていた場合、Reference Alignmentを抜けても
   復帰しない実バグになるところだった）。

---

## 完了チェックリスト

- [x] orthographic = true（6地点で実測確認）
- [x] visible3DBuildings = 0（6地点で実測確認）
- [x] plateauFootprintCount > 0（全6地点）
- [x] gsiBuildingOutlineCount > 0（全6地点）
- [x] gsiRoadEdgeCount > 0（全6地点）
- [x] plateauVisible > 0（全6地点）
- [x] gsiBuildingVisible > 0（全6地点）
- [x] gsiRoadVisible > 0（全6地点）
- [x] propertyPopupVisible = false（全6地点）
- [x] geometryMutation = 0
- [x] coordinateMutation = 0
- [x] validator PASS
- [x] npm test 0 fail（1527 tests / 1512 pass / 0 fail / 15 skip）
- [x] production/protected 無変更
- [x] **STOP** — 次工程へは自動で進まない

**VISUAL_QA_PENDING_USERでSTOPします。** 実機で `[Reference Alignment]` を開き、cyan/magenta/greenの
3色が今度こそ明確に見えるか、6地点を巡って最終判定（§18のA〜Dのどれに該当するか）をお願いします。
