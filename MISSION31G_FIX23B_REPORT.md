# Mission 31G-FIX23B 完了報告｜Unknown Legacy Residual 18 最終解消

**結論を先に正直に書く**: 実機で報告された `unknown: 18`（Ward=北区・Building Alignment loaded・
building selected・property card OPEN・camera NEAR）の**18件全てを1件ずつ実証分類することは、
このセッションには実機ブラウザが無いため達成できなかった**。一方で、その代わりに投資した
「harnessを本物のscene graphとして使い、mission が明示した各条件（起動直後・ward切替・
Building Alignment・Top Down・Road mode・非vacuous性検証）を実測する」というアプローチにより、
**新たに2件の確定的な実バグ（HYBRID_V1/DIFF_DEBUG road groupのownership漏れ）を発見・修正**し、
**harnessで再現できる範囲では全シナリオでresidual=0**であることを実測確認した。§20/§37 で
要求された「Unresolved: 0」は**達成できていない**ことを、誤魔化さず以下に明記する。

---

## 1. unknown 18の内訳

**実機での1件ずつの実証分類は未達成**（§20 completion criteria の "Unresolved: 0" を満たせず）。
理由は以下の技術的制約（誤魔化しではなく構造的な制約として正直に記録）:

1. このセッションに実機ブラウザが無く、`window.__LEGACY_RESIDUAL_DETAIL__()`（FIX23で追加済み・
   今回さらに動作確認済み）を**実機で実行して結果を取得する手段が無い**。
2. 強化したtest harness（`tests/_ward-ux-v1-smoke-harness.cjs`）でも、以下2点は再現できない:
   - `requestAnimationFrame`がno-opのため、**per-frameのcamera距離依存LOD更新ロジックが
     一切実行されない**（camera NEAR状態を再現しても、それをトリガーに動く処理が動かない）。
   - `selectBuilding()`の完全な実行には`BLDGS`/`TOWN_POLYGONS`等の実データ形状が必要で、
     synthetic recordでは`showPropertyCard`等が早期に例外を投げる（実データが必要な箇所は
     現状Node側から到達できない）。

## 2. actual Legacy件数

harnessで実測できた範囲では **0件**（新規のLegacy building tile誤表示経路は発見できなかった）。

## 3. Canonical false positive件数

**1件（新規発見・確定・修正済み）**: `HYBRID_V1`（road render mode）の`gN`グループ
（`buildHybridMeshes()`内）。CanonicalRuntime自身が生成するRoad geometryの別レンダリングモード
であるにも関わらず、`runtimeOwner`タグが無く、`renderOrder`(=645)が900未満で既存の
bucket名regex（RoadLayer等）にも一致しないため、Road modeを`HYBRID_V1`へ切り替えると
**unknown residualへ1件誤計上**されることをharness実測で発見した。

## 4. Debug false positive件数

**1件（新規発見・確定・修正済み）**: 同じ`buildHybridMeshes()`内の`gD`グループ
（`DIFF_DEBUG`の色分け診断表示）。同様の理由で`DIFF_DEBUG`へ切り替えると**unknown residualへ
2件誤計上**（`gD`は`mH`/`mM`の2 mesh）されることを実測。

いずれも今回のFIX23B作業で**mission §30「Road mode変更でも0」の要求に基づいて監査した結果
新規発見**した実バグであり、実機の"18"（Road=FIX13時点の観測）には該当しない
（FIX13ではこれらのgroupは`visible=false`のまま）。

## 5. 各18 objectのsourceカテゴリ

未取得（§1参照）。ただし、FIX23・FIX23Bで確定的に修正した「同種のパターン」（COEXIST_NAMEや
既存名が想定していたのに実際は`.name`未設定／`runtimeOwner`未設定のまま`scene`へ直接addされる
group）を全て塞いだため、実機の18件のうち相当数はこれらの修正で解消されている可能性が高いと
推測される（が、実証はできていない）。

## 6. parent inheritance問題の有無

**確認した限り問題なし**。`coexist(o)`・`findRuntimeOwner(o)`はいずれも`o.parent`を根まで
辿る設計で、子mesh自身に`.name`/`runtimeOwner`が無くても親groupの`.name`/`runtimeOwner`を
正しく継承する（既存設計どおり。§7/§8/§9の監査の結果、classifier順序・inheritance機構自体に
バグは見つからなかった）。実際に`makeHighlightSet`の`fill`/`line`は親を持たず自身に`.name`を
設定する形、`GroundVisualLayer`等は親groupにのみ`.name`を設定する形、と混在しているが、
いずれも`coexist()`の「自身から根まで全て見る」設計により正しく機能する。

## 7. selection由来件数

**0件（確認済み）**。`updateHighlight()`は既存の`hoverHL`/`selectHL`（FIX23で`.name`設定済み）の
ジオメトリ内容を書き換えるのみで新規objectを作らない。`showTownBoundary()`が作る
`townBoundaryLine`は`THREE.LineLoop`（`isLineLoop`）であり、`classifyLegacyResidual()`の
traverse条件`(!o.isMesh && !o.isLineSegments)`に該当し**そもそも判定対象外**（型として
除外されている。これは「見えなくしている」のではなく元からの仕様。over-countingの原因には
ならないが、将来LineLoopが判定対象に含まれた場合に備え`.name`は未設定のままである点を
正直に記録する — 今回は範囲外として据え置いた）。

## 8. label由来件数

**0件（確認済み・構造的に対象外）**。駅名・地名・施設名ラベルは`Sprite`実装であり
`isMesh`/`isLineSegments`のいずれでもないため、classifierのtraverse条件で最初から除外される。

## 9. ground/streetscape由来件数

**0件（FIX23で修正済みを再確認）**。`GroundVisualLayer`/`StreetscapeLayer`とも、harness実測で
起動直後から一貫して residual=0 であることを本ミッションでも再確認した。

## 10. rail由来件数

**0件（確認済み）**。RailLayerは既存の名前ベース判定（`chainName`に`Rail`を含む）で
正しく`RailLayer`バケットへ分類されるか、Canonical Buildingsのrail layer(`REN.rail`)はrtRoot
配下で構造的に除外される。今回の全シナリオ実測で`RailLayer`residualは常に0。

## 11. water/park由来件数

**0件（確認済み）**。`RiverLayerV2`/`ParkLayer`とも`toggleOldLayers()`で完全にhide/showされる
既存ガード対象であり、実測でも常に0。

## 12. その他

なし（§3/§4のHYBRID_V1/DIFF_DEBUG以外に新規のfalse positiveは発見できなかった）。

## 13. ownership修正内容

- `RUNTIME_OWNER.CANONICAL`を`HybridV1Normal`(gN)グループへ、`RUNTIME_OWNER.DEBUG`を
  `HybridV1Debug`(gD)グループへ、新設の`tagRuntimeOwnerRecursive(root, owner)`ヘルパー経由で付与。
- 既存6つのdebug overlay groupの個別`g.userData.runtimeOwner=...`代入を、同じ
  `tagRuntimeOwnerRecursive()`へ統一（子孫まで再帰的にタグ付けする設計へ強化・§17）。

## 14. attach guard追加有無

新規のattach guardは追加していない（§18「Actual Legacyだった場合」に該当する新規のasync race
バグは今回発見できなかったため）。既存のFIX23 loadFullWard guardは引き続き有効（§31の回帰防止
testで確認）。

## 15. startup residual

**0**（harness実測・複数回確認）。

## 16. building select residual

**未検証**（§1参照。selectBuilding()の完全再現がこのharnessでは困難）。ただし
`updateHighlight()`/`showTownBoundary()`という選択時に実際に呼ばれる2つの関数を個別に
コードレビューし、いずれも新規residual源にならないことを確認済み（§7）。

## 17. hover residual

**0（構造的に確認）**。hoverも`updateHighlight(hoverHL, ...)`を呼ぶのみで、selection同様
新規objectを作らない。

## 18. camera residual

**未検証**（§1参照。requestAnimationFrameベースの per-frame camera距離LOD更新がharnessで
実行できないため）。

## 19. ward switch residual

**0**（北区→中央区→住吉区→北区のサイクルをharnessで実測・§27要件どおり）。

## 20. Alignment residual

**0**（ON→OFF→ONを実測・§28要件どおり。debugCountは正しく2のまま推移）。

## 21. Top Down residual

**0**（ON→OFF→ONを実測・§29要件どおり）。

## 22. Road mode residual

**FIX13→HYBRID_V1→DIFF_DEBUG→FIX13の全サイクルで0**（§3/§4のバグ修正後に実測確認・§30要件どおり）。

## 23. harness結果

`tests/_ward-ux-v1-smoke-harness.cjs`のscene graph実装（FIX23で追加）を**維持**し、
no-opへ後退させていないことをvalidatorの新規チェック`sceneGraphHarnessActive`で保護した（§32）。
今後のRuntime testの正式baselineとして機能させる方針を維持。

## 24. non-vacuous test結果

**PASS**（§33）。意図的に`window.__SCENE__`（新規公開）経由でdummy legacy object
（position 2000要素・COEXIST_NAME等どれにも一致しない名前）をsceneへadd →
`classifyLegacyResidual()`が`unknown:1`として正しく検出 → removeすると0に戻ることを実測。
「最初から何も無いからPASSする」という脆弱なtest設計になっていないことを直接証明した。

## 25. validator

`tools/validate/legacy-residual-guard.js`へ5項目追加（計23項目）。

```
RESULT: PASS
tagRuntimeOwnerRecursiveDefined, hybridRoadGroupsOwnershipTagged, residualDetailUiPresent,
testingBridgesExposed, sceneGraphHarnessActive: 全てtrue
geometryMutation: 0 / productionModified: false / protectedModified: false
```

## 26. npm test

**1491 tests / 1476 pass / 0 fail / 15 skip**（新規7 test中5件が動的scene graph検証。
うち§33の非vacuous testは今回のミッションで最も重要な信頼性向上）。

## 27. visual QA status

`VISUAL_QA_PENDING_USER`。**次ミッションへの最重要引き継ぎ**:

1. 実機ブラウザで、報告されたrepro条件（北区・Building Alignment ON・Top Down ON・
   building選択・property card OPEN・camera NEAR）を再現し、`window.__LEGACY_RESIDUAL_DETAIL__()`
   を実行する（Console操作、または今回追加した`[Residual details]`ボタンで代替可能）。
2. `unknown`が0であれば、今回のFIX23/FIX23Bの修正で実機の18件も解消されたと確定できる。
3. `unknown`が0でなければ、`__LEGACY_RESIDUAL_DETAIL__()`の出力（uuid/name/parent/renderOrder/
   geometry/material/runtimeOwner/creationPath等を含む完全な内訳）をそのまま次ミッションへ
   提供いただければ、今回build済みの分類基盤を使って**確実に**原因を特定できる。
4. 特に camera NEAR 状態でのみ発生する経路（CityBuildingLOD/BUILDING_EDGE_LOD等の
   distance-based update）と、building選択に伴う経路（`selectBuilding`内の残り処理）は
   このセッションのharnessでは検証できなかった最有力候補として優先的に確認すること。

---

## §0 遵守確認

- Canonical Building/Road geometry: 無変更（615,617棟 / 199,658本）
- GSI Building Alignment / Hybrid Road geometry: 無変更（座標・データは一切触っていない。
  今回touchしたのはownership marker付与のみ）
- FIX13: 無変更（refined-road-surface.json indexedCount=30,190）
- residual thresholdは緩めていない（`>0`のまま維持。むしろ発見したbugを直接修正した）
- `unknown`を一律無視／DEBUG扱いで隠す修正はしていない（HYBRID_V1側はCANONICAL・DIFF_DEBUG側は
  DEBUGと、それぞれの実態に即して個別に正しいownerを判定し付与した）
- production (`osaka_3d_buildings.html`) / protected (`fullward-v3.html`): 無変更

---

## 完了条件チェックリスト

- [ ] unknown 18全件の正体特定 → **未達成**（§1参照。実機ブラウザでの追加確認が必要）
- [ ] unresolved 0 → **未達成**（正直に報告）
- [x] actual Legacy数確定 → 0件（harness実測範囲内）
- [x] false positive数確定 → Canonical 1件・Debug 1件（新規発見・修正済み）
- [x] parent ownership inheritance → 問題なしと確認
- [x] selection object ownership → コードレビューで新規residual源にならないことを確認（動的実測は未達成）
- [x] label ownership → 構造的に対象外と確認
- [x] ground/streetscape child ownership → FIX23修正の再確認・0
- [x] rail/water/park ownership → 0
- [x] residual 0 → harnessで再現できる全シナリオで0（startup/ward切替/Alignment/TopDown/Road mode/非vacuous test）
- [ ] property card OPENでも0 → **未検証**
- [ ] camera moveでも0 → **未検証**（per-frame LOD処理がharnessで動かないため）
- [x] ward switchでも0
- [x] alignment/top-downでも0
- [x] Road mode変更でも0（今回の主要な新規修正）
- [x] non-vacuous test → PASS（dummy注入→検出→除去→0を実証）
- [x] validator PASS
- [x] npm test fail 0（1491 tests / 1476 pass / 0 fail / 15 skip）
- [x] geometry不変

**次工程へ自動で進まずSTOPします。実機ブラウザでの`__LEGACY_RESIDUAL_DETAIL__()`実行結果（または
新設の[Residual details]ボタンでの目視）を、可能であれば次のご指示に含めていただけると、
残るunknown 18の正体を確実に特定できます。**
