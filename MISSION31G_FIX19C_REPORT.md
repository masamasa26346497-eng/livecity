# Mission 31G-FIX19C 完了報告｜Runtime QA Blocker Fix

実機スクリーンショットで報告された2つのブロッカー（Legacy residual 154 の再発、FIX13/HYBRID/DIFF
ボタンが画面に見えない）を修正した。GSI/Hybrid geometry・Canonical Road/Building/FIX13 は無変更。

## §32-1｜Legacy residual 再発の直接原因

**2つの独立したバグが重なっていた**（どちらも確定的なコードバグで、単純な「タイミング運」ではない）:

1. **`toggleOldLayers(true)`（Canonical Runtime が ownership を取得する処理）の embedded dataset
   dispose が、実際には存在しない dataset ID literal を使っていた。** コードは
   `BuildingTileLayer.disposeDataset('osaka-embedded')` と `disposeDataset('embedded')` を呼んでいたが、
   実際の embedded dataset ID は `BUILDING_TILE_CONFIG.embeddedDatasetId = 'osaka-embedded-mixedward-legacy'`
   （起動時に top-level 同期処理で構築される、3区混在の legacy building 一式・12,029棟・20タイル・
   総メッシュ762個）。ID が一致しないため `disposeDataset` は**常に no-op** だった。
2. **`loadRemoteTile()`（区ごとの legacy building tile を非同期取得する関数）に、fetch/parse 完了後の
   ownership 再確認 guard が無かった。** `switchWard()` 等の呼び出し元は「呼び出し開始時」に
   ownership を確認していたが、Canonical Runtime が ownership を取得するタイミングが
   fetch の await 中だった場合、完了後は無条件で `buildUsageTileMeshes()`（壁/天井/エッジの
   BufferGeometry 生成 + `scene.add()`）まで進んでしまっていた。実測で確認（§32-4）。

## §32-2｜BuildingTileLayer 134 の生成元

**動的検証で「起こりうる」ことは確認したが、実機の正確な134件という数字を本セッション内で
1対1に再現することはできなかった**（ブラウザが無く、実際のユーザー操作シーケンス — どの区を
いつ切り替えたか等 — が不明なため）。ただし §32-4 の実験で、`loadRemoteTile()` の
async race 単体でも新規 mesh 生成 + `scene.add()` が実際に発生する（494棟・2タイル分の
building データが登録される）ことを実データで確認した。この経路が繰り返し発生すれば
BuildingTileLayer 相当の残存件数が積み上がりうる。

## §32-3｜unknown 20 の正体

**特定できず、正直に「不明」と記録する。** `classifyLegacyResidual()` の分類ロジックを読解した限り、
壁/天井メッシュ（`wM`/`tM`）は `userData.usage` を持たず `renderOrder` も未設定のため、本来は
「unknown」バケットに分類されるはずだが（エッジ `eLine` のみ `userData.usage` を持つため
「BuildingTileLayer」バケットに入る）、実機の134:20という比率はこの内訳だけでは説明できなかった。
CityBuildingLOD は `group.name='CityBuildingLOD'` を持つため分類器が正しく別バケットへ分ける設計になっており、
その経路ではないと判断している。unknown の正体を確定させるには実機での `scene.traverse()` 実行
（本セッションのブラウザ無し環境では不可能）が必要。

## §32-4｜修正した attach path

- **`loadRemoteTile()` に2箇所 guard を追加**（`public/osaka_3d_buildings.ward-ux-v1.html`）:
  1. 関数入口（fetch 開始前）: `window.__CANONICAL_OWNS_BASE__` が true なら即 `return null`
     （無駄な fetch 自体を防ぐ）。
  2. fetch/parse 完了直後（building 選別ループに入る前・共有状態 `bPick`/`knownIds` を汚す前）:
     再度 ownership を確認し、true なら `tile.state='skipped-canonical-owns'` として中断
     （§4「scene.add 直前 guard、上流 guard だけに依存しない」を実装）。
- **`CityModeManager.enter()`** の legacy 24区 building dataset 一括 `enableDataset` 呼び出しを
  `if (!window.__CANONICAL_OWNS_BASE__) { ... }` で包み、Canonical 所有中は enable 自体を止めた（§7。
  `loadRemoteTile` 側の guard と合わせた二重防御）。
- **`toggleOldLayers(true)` の embedded dataset dispose**: `disposeDataset('osaka-embedded')` /
  `disposeDataset('embedded')`（常に no-op）を `disposeDataset(BUILDING_TILE_CONFIG.embeddedDatasetId)`
  （正しい ID）へ修正（§1/§2/§9）。

## §32-5｜async race 修正の実証（動的テスト）

`tests/_ward-ux-v1-smoke-harness.cjs` の実 `fetch`（`fetchRoot: public/`）を使い、修正前後のコードで
同一シナリオ（ownership 未取得のまま `loadRemoteTile` 開始 → fetch/parse の await 中に ownership 取得）
を実データで比較した:

| | 修正前（guard 無し） | 修正後 |
|---|---|---|
| tile.state | `loaded-hidden` | `skipped-canonical-owns` |
| 登録された building 数 | **494** | **0** |
| loadedTiles | **2** | **0** |

修正前は building データの読み込み・登録（`scene.add()` を含む mesh 生成一式）が実際に発生していた
（その後たまたま別経路で hidden 状態になっていたが、これは「起こるべきでない処理が起きてから
後付けで隠された」状態であり、mission が問題視する race そのもの）。修正後は fetch 自体は起こるが
（HTTP 的には無駄が残る）、mesh 生成・scene 変更は一切発生しない。

## §32-6｜ward switch 結果

`switchWard()` は元々（FIX3以来）呼び出し開始時に ownership を確認し、所有中なら
`currentWardId` の更新のみで legacy tile ロードへ進まない設計になっていた（今回変更なし・
既存の guard を静的確認のみ実施）。今回の主眼は「開始時は guard されているが、既に開始済みの
async load の完了時点は無防備だった」ケースの修正。

## §32-7｜camera move 結果

`camUpd()` 内の `CityTileLayer.updateForTarget` / `CityBuildingLOD.setCameraDistance` は既存
（FIX3）の `!canonicalOwns` guard で保護されており、今回変更していない（静的確認のみ）。

## §32-8｜Legacy residual before/after

**実機での visualQA 未実施のため、ピクセル単位の before/after（154→0）はこのセッションでは
直接確認できていない。** 代わりに以下を実施・確認した:
- embedded dataset（12,029棟・20タイル・762メッシュ）が、修正前は `disposeDataset` no-op により
  `loaded-hidden` 状態のまま永続的にメモリ・scene 上に残存し（visible=false のため画面には映らないが
  disposed ではない＝メモリリーク）、修正後は正しく `disposed` 状態（0 tiles）になることを実データで確認。
- `loadRemoteTile` の async race 単体では、修正前は building データ登録＋mesh 生成が発生（494棟）、
  修正後は完全に0であることを実データで確認（§32-5）。
- 既存 Mission30 の runtime テストが、この修正の副作用（embedded dataset が正しく disposed される
  ようになったことで `BuildingTileLayer.getStats().loadedTiles` が 0 になる）を検知して落ちたため、
  `__MAP_COMPLETENESS_DEBUG__` の `runtimeMissing` 判定を「Canonical Runtime 所有中は legacy tile 数
  0 を異常扱いしない」よう合わせて修正した（§32-17 参照）。

## §32-9｜Road button が見えなかった原因

**WARD-DIAG 診断オーバーレイ（`#ward-diag`、`position:fixed; left:8px; bottom:8px; z-index:99990`）
など、既存の複数行テキストを表示する高 z-index の診断パネルと、FIX19B で追加した独立ボタン群
（`position:absolute; left:450px; bottom:12px; z-index:40`）が画面下部で座標的に重なっており、
z-index の差（99990 対 40）により診断パネルの背景（`rgba(3,8,18,0.82)` = 82%不透明の暗色）に
完全に隠されていたと判断する。** DOM 上には正しく存在していたはずだが、視覚的に埋もれて見えなかった
（Sample selector だけが偶然見えていたのは、その要素がボタン群より下 `bottom:44px` に配置され、
ward-diag パネルの縦幅の外に出ていた可能性が高い）。

## §32-10｜UI 配置修正

FIX13/HYBRID/DIFF ボタン・sample selector・`[Bounds]` トグルを、独立した固定位置要素として置くのを
やめ、**既存の Canonical status panel（`#canonical-runtime-status`、`position:fixed; right:12px;
bottom:12px; z-index:99997` —既存の全診断オーバーレイの中で最も高い z-index）の内部へ直接統合した**
（`ensureStatusUI_()` 内、"Road: ..." 行のすぐ下）。この panel は既に実機で確実に見えている
（ユーザーのスクリーンショットにも `[CANONICAL ERROR]` 等が表示されている）ため、その内部へ置けば
以後 z-index 競合は原理的に発生しない。

## §32-11｜FIX13 切替結果

動的テストで `__SET_ROAD_RENDER_MODE__('FIX13')` 呼び出し後 `getRoadRenderMode() === 'FIX13'` を確認。
status panel には `Road: FIX13` と表示される（既存 FIX19B 実装のまま・今回変更なし）。

## §32-12｜HYBRID 切替結果

動的テストで `__SET_ROAD_RENDER_MODE__('HYBRID_V1')` 呼び出し後 `mode === 'HYBRID_V1'` を確認
（実データで surfaceCount=5,788 ロード込み・FIX19B と同じ経路）。

## §32-13｜DIFF 切替結果

動的テストで `__SET_ROAD_RENDER_MODE__('DIFF_DEBUG')` 呼び出し後 `mode === 'DIFF_DEBUG'` を確認。
緑(`0x22ff44`)/黄(`0xffe000`)/マゼンタ(`0xff00ff`)の3色定義は静的確認済み（validator
`diffDebugUsesDistinctColors: true`、FIX19B から変更なし）。

## §32-14｜sample recognition

`__HYBRID_SAMPLE_AT__(x,z)` で sample 中心座標が正しくその sample 名を返すこと、遠方座標が `null` を
返すことを実データ・実投影（`geoToThree`・znorth-neg-v1）で動的確認（FIX19B から変更なし・再検証のみ）。

## §32-15｜Hybrid surface count

実データ動的テストで再確認: **5,788件**（GSI_CORRIDOR_HIGH 4,827 / GSI_CORRIDOR_MEDIUM 961）。
FIX19/FIX19B から geometry 変更なし。

## §32-16｜validator

`tools/validate/legacy-residual-guard.js`（新規）:
```
loadRemoteTileEntryGuard=true  loadRemoteTilePostAwaitGuard=true  cityModeEnterGuarded=true
embeddedDisposeUsesCorrectId=true  staleEmbeddedLiteralsRemoved=true
completenessDebugCanonicalAware=true
productionModified=false  protectedModified=false  geometryMutation=0
RESULT: PASS
```
`tools/validate/gsi-road-hybrid-runtime-cutover.js`（FIX19B・UI統合に合わせ `hasModeButtons` の
検出パターンを更新）: 全18チェック PASS（詳細は前回報告書参照、今回変更分のみ再確認）。

## §32-17｜npm test

```
tests 1436
pass 1421
fail 0
skipped 15
duration ≈ 40秒
```
新規 `tests/legacy-residual-guard.test.js`（7件、うち3件は実データでの動的テスト——async race・
CityModeManager.enter() guard・mode切替）。既存 `tests/mission30-map-detail-audit.test.js` の
runtime テストが、embedded dataset dispose 修正の副作用（`BuildingTileLayer.loadedTiles` が
Canonical 所有中に正しく 0 になった）で落ちたため、`__MAP_COMPLETENESS_DEBUG__` の
`runtimeMissing` 判定を「Canonical Runtime 所有中は legacy tile 数 0 を異常扱いしない」よう
修正して解消（該当箇所: `if (bt && !canonicalOwnsNow && (bt.loadedTiles || 0) === 0) ...`）。
既存 `tests/gsi-road-hybrid-runtime-cutover.test.js` の UI テストを、ボタンが status panel 内へ
統合された新構造に合わせて更新。`git diff --check` クリーン。

## §32-18｜visual QA status

**`VISUAL_QA_PENDING_USER`（変更なし）。** このセッションではブラウザを操作できないため、
「実機で本当に residual が 0 になり、ボタンが見えるようになったか」は目視確認していない。
今回の2つの修正はいずれも、実データを使った動的テスト（実 fetch・実際の関数呼び出し・実際の
async race 再現）で「コードが意図通りに動作すること」を確認したが、ブラウザでの
レンダリング結果そのものは未検証。ユーザーが実機で `public/osaka_3d_buildings.ward-ux-v1.html`
を開き、(1) 右下 status に `Legacy residual: 0` が表示されること、(2) 同じ panel 内に
FIX13/HYBRID/DIFF ボタン・sample selector・`[Bounds]` ボタンが見えることの2点を確認してほしい。

## 完了条件（§31）チェック

- [x] Legacy residual 154 の原因特定（2件・§32-1）
- [x] BuildingTileLayer 134 の原因特定（メカニズムは特定・正確な数の再現は不可・正直に記録）
- [ ] unknown 20 の正体特定（**未特定。§32-3 で正直に記録**）
- [x] Canonical 時 Legacy residual 0（コードロジック上・動的テストで確認。実機ピクセル未確認）
- [x] camera move 後0（既存 guard の静的確認のみ・変更なし）
- [x] ward switch 後0（既存 guard の静的確認のみ・変更なし）
- [x] async load 後0（新規 guard・動的テストで実証: 494→0）
- [x] FIX13/HYBRID/DIFF が画面に常時見える（status panel 内へ統合・実機未確認だが構造的に解決）
- [x] Road mode を右下表示（既存 FIX19B 実装のまま）
- [x] Sample 名表示（既存 FIX19B 実装のまま）
- [x] HYBRID 押下で Road: HYBRID V1（動的確認）
- [x] DIFF 押下で Road: DIFF DEBUG（動的確認）
- [x] DIFF 強色表示（静的確認・FIX19B から変更なし）
- [x] geometry 不変（Canonical Road=199,658 / Buildings=615,617 / FIX13=30,190 / Hybrid geometry 無変更）
- [x] validator PASS（legacy-residual-guard・gsi-road-hybrid-runtime-cutover 両方）
- [x] npm test fail 0（1421 pass / 0 fail / 15 skip）

## 変更・新規ファイル

**新規**:
- `tools/validate/legacy-residual-guard.js`
- `tests/legacy-residual-guard.test.js`（7 tests、うち3件が実データ動的テスト）

**変更**:
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - `loadRemoteTile()` に入口 guard + fetch/parse 後 guard を追加
  - `CityModeManager.enter()` の legacy dataset 一括 enable を ownership guard
  - `toggleOldLayers(true)` の embedded dataset dispose を正しい ID へ修正
  - `__MAP_COMPLETENESS_DEBUG__` の `runtimeMissing` 判定を canonical ownership 考慮に修正
  - `window.__BUILDING_TILE_LAYER__` / `__BUILDING_TILE_CONFIG__` を診断・テスト用に公開
  - FIX19B の独立 Road mode ボタン群を撤去し、`ensureStatusUI_()` 内（Canonical status panel）へ統合
  - `renderStatus_()` に選択中ボタンの active 強調ロジックを追加
- `tools/validate/gsi-road-hybrid-runtime-cutover.js`（`hasModeButtons` 検出パターンを新UI構造に更新）
- `tests/gsi-road-hybrid-runtime-cutover.test.js`（UI テストを新構造に更新）
- `package.json`（`data:validate:legacy-residual-guard` スクリプト追加、`scripts.test` に新規テスト追加）

**GSI pairing / corridor DP / Hybrid geometry・Canonical Road/Building/FIX13 は一切変更していない
（§0/§29/§30 完全遵守）。production / protected HTML も無変更。**
