# Mission 31G-FIX19B 完了報告｜Hybrid Runtime Visual Cutover

FIX19 で作った Hybrid GSI Road Surface が「画面上で FIX13 と見分けがつかない」問題に対応した。
GSI pairing / corridor DP / Hybrid geometry 自体（FIX19 の成果物）は一切変更せず、runtime 接続経路
（UIトグル → state → geometry fetch/parse → FIX13 との排他描画 → scene attach → status表示）だけを
作り直した。

## §27-1｜今回 Hybrid が見えなかった直接原因

**設計上の問題であり、「未接続」ではなかった**。FIX19 の `[Hybrid v1]` トグルは、GSI HIGH/MEDIUM 面を
**常時描画される FIX13 道路レイヤーの上に、半透明オーバーレイとして重ね描き**するだけの実装だった
（FIX13 を隠す/置き換える処理が一切無かった）。しかも重ねる色がアンバー系（濃いオレンジ opacity 0.6 /
薄いオレンジ opacity 0.45）で、下地の FIX13 道路色（medium gray `COL.road`）も元々グレー系のため、
「グレーの上に薄いオレンジを重ねる」変化が肉眼・スクリーンショットの両方で判別しづらかった。
つまり **geometry のロード・scene 追加・toggle 動作はいずれも機能していたが、「FIX13 を隠さず重ねるだけ」
という設計そのものが「見た目の変化が無い」という結果を生んでいた**。

## §27-2｜Hybrid mesh は実際に scene へ attach されていたか

**はい**。旧実装は `fetch → parse → BufferGeometry構築 → scene.add(g)` を確定的に実行しており、
`toggleGsiHybridV1()` で `visible` を切り替えるだけの単純な作りだった。geometry 自体は正しく
ロード・追加されていたと判断できる（コード上、fetch 失敗時のみ `missing`/`error` 状態になり、
成功時は必ず `scene.add` していた）。ただしこのセッションにはブラウザが無いため「実際に描画ピクセルが
出ていたか」を目視確認したわけではない、という限界は正直に記録する。

## §27-3｜FIX13 が上に残っていたか

**「上に残っていた」というより「常に同時に描かれていた」**。旧実装の Hybrid mesh は
`renderOrder=903`（FIX13 の `REN.road=640` より高い）・`Y=0.85`（FIX13 の `Y.road=0.30` より高い）
だったため、Z-fighting で隠れていたわけではなく、Hybrid が正しく FIX13 の上に重なって描画されていた
はず。問題は「隠れていた」ことではなく「FIX13 が常に下に残ったまま二重描画されていた」こと（§3 違反）。

## §27-4｜sample 範囲問題だったか

**いいえ**。FIX19 の sample 定義（10 エリア・900m四方）自体は正しく、`hybrid-surfaces-sample.json` の
geometry も正しい座標に生成されていた。sample 範囲の計算・データ自体に問題は無かった。

## §27-5｜Y / depth / renderOrder 問題だったか

**直接の「隠れるバグ」ではないが、間接的に一因**。§27-3 の通り renderOrder/Y 自体は正しく上に描画
される設定だったため技術的な「隠れ」は無かったと判断できる。ただし低 opacity のオーバーレイという
表現方法自体が、視認性確保という観点では実質的に「Y/depth 的には正しいが人間の目には効果が薄い」
状態を作っていた。FIX19B では Hybrid が道路描画を**所有**する設計（§3）に変えたため、この問題自体が
構造的に解消されている。

## §27-6｜cache 問題だったか

**旧実装では該当しない（cacheの概念が無い独立オーバーレイだった）**。ただし FIX19B で
「HYBRID_V1/DIFF_DEBUG では sample 内の FIX13 を suppress する」設計に変えたことで、
**新たに** road tile の cache 問題が発生しうることが分かった（tile は build 時点の
`roadRenderMode` を焼き込んで merged mesh を作るため、mode 切替後も古い tile が cache に残っていると
反映されない）。これに対処するため `invalidateHybridAffectedRoadTiles()` を実装し、mode 切替時に
sample bbox に重なる roads tile のみを狙い撃ちで破棄 → `refresh()` で即座に再 fetch/再 build させる
方式にした（§10/§11）。

## §27-7｜HYBRID mode の surface 数

実データでの動的テスト（`tests/gsi-road-hybrid-runtime-cutover.test.js`）で実測: **5,788件**
（FIX19 の sample-scoped `hybrid-surfaces-sample.json` をそのまま使用。geometry 自体は無変更）。

## §27-8｜GSI HIGH 数

**4,827件**（実データ動的テストで実測。`bySource.GSI_CORRIDOR_HIGH`）。

## §27-9｜GSI MEDIUM 数

**961件**（実データ動的テストで実測。`bySource.GSI_CORRIDOR_MEDIUM`）。

## §27-10｜FIX13 fallback 数

Hybrid dataset 側に専用の polygon として持たせていない（§7 の設計: FIX13_FALLBACK は「sample 内で
GSI に被覆されていない、生の FIX13 feature」をそのまま指す）。件数としては FIX19 の報告書
（`data/reports/gsi-road-hybrid-v1.json`）の `coverage.fix13FallbackAreaM2 = 863,175m²`
（10サンプル合計・面積ベース）を参照。runtime 上は「suppress されなかった FIX13 feature」として
自動的に描画される（新規 geometry 生成なし）。

## §27-11｜runtime mode 切替結果

動的テストで FIX13 → HYBRID_V1 → DIFF_DEBUG → FIX13 の順に切替え、いずれも例外なく完了し
`getRoadRenderMode()` が都度正しい値を返すことを確認（`tests/gsi-road-hybrid-runtime-cutover.test.js`
の `[FIX19B §1/§15]` テスト）。tileCache が空の状態（テスト環境）でも `invalidateHybridAffectedRoadTiles()`
は安全に no-op で完走する。

## §27-12｜unexpected FIX13 residual

**構造的に 0**。suppress 判定（`hybridCoveredAt` が非 null を返した場合）の直後に無条件で
`continue` する実装のため、covered な FIX13 feature が bucket へ push されることは無い
（FIX18 の `illegalPairCrossing=0`「構造的に発生しない」と同じ立証方法。静的ソース解析で確認、
validator `unexpectedFix13ResidualInsideHybrid: 0`）。動的な scene 走査による「実際に描画されなかった
ことのピクセルレベル確認」はブラウザが無いため未実施（§27-17 参照）。

## §27-13｜status UI

右下の既存 `canonical-runtime-status` パネル（Console 不要・常時表示）に追加:
- `Road: FIX13` / `Road: HYBRID V1` / `Road: DIFF DEBUG`
- sample 内: `Sample: <name>` / `Hybrid surfaces: N` / `GSI HIGH: X%` `GSI MED: Y%` /
  `Fallback: Z%` `Unresolved: W%` / `suppressed N`
- sample 外: `Sample: OUTSIDE PROTOTYPE AREA` / `Rendering: FIX13 fallback`
- エラー時: `HYBRID ERROR: 0 surfaces loaded` / `Hybrid load failed`

## §27-14｜DIFF_DEBUG 結果

GSI HIGH=鮮明な緑(`0x22ff44`)・GSI MEDIUM=黄色(`0xffe000`)・FIX13_FALLBACK(sample内残存分)=
マゼンタ(`0xff00ff`) の3色を実装（static validator `diffDebugUsesDistinctColors: true`）。
**UNRESOLVED（赤）は今回スコープ外**: 5m grid rasterize（FIX19のNode.jsバッチ処理）の産物であり、
対応する vector geometry を runtime 側で持たないため、赤面としては描画していない（正直な
スコープ限定・§0 の「geometry algorithm 変更禁止」との兼ね合い）。件数は status UI に
`Unresolved: W%` として数値表示することで代替した。

## §27-15｜validator

`tools/validate/gsi-road-hybrid-runtime-cutover.js`（新規・§23）実行結果:
```
roadRenderModeExists=true  hybridReplacesFix13InsideSample=true  fix13OutsideSample=true
diffDebugUsesDistinctColors=true  hybridZeroSurfaceErrorVisible=true  sampleOutsideStatusVisible=true
unexpectedFix13ResidualInsideHybrid=0  geometryMutation=0
productionModified=false  protectedModified=false
RESULT: PASS（エラー0・警告0）
```
既存 `tools/validate/gsi-road-hybrid-v1.js`（FIX19）も、置き換えた識別子（`roadRenderMode`/
`setRoadRenderMode`）に合わせて toggle 検出パターンを更新し、引き続き PASS（エラー0・警告0）。

## §27-16｜npm test

```
tests 1429
pass 1414
fail 0
skipped 15
duration ≈ 41秒
```
新規 `tests/gsi-road-hybrid-runtime-cutover.test.js`（10件、うち2件は実データでの動的テスト。
smoke harness の実 `fetch`（`fetchRoot: public/`）で本物の `hybrid-surfaces-sample.json` を
読み込ませ、`surfaceCount>5000`・`GSI_CORRIDOR_HIGH>4000`・`GSI_CORRIDOR_MEDIUM>500`・
sample 判定が実座標で正しく動くことまで検証）。既存テストのうち FIX19 由来の runtime toggle テスト
（`tests/gsi-road-hybrid-v1.test.js`）を新しい `ROAD_RENDER_MODE` 実装に合わせて更新。
`tests/road-visual-surface.test.js`（FIX12由来）で固定長 `slice(s, s+1800)` が roads branch への
コード追加で壊れる潜在バグを発見・修正（`html-test-endidx-literal-string-trap` と同種。終端を
固定長オフセットではなく次の layer branch 開始位置へアンカーする方式に変更し、今後の追加にも
耐えるようにした）。`git diff --check` クリーン。

## §27-17｜visual QA status

**`VISUAL_QA_PENDING_USER`**。このセッションではブラウザを操作できないため、実際の描画結果（色・
位置・重なり）は目視確認していない。代わりに以下を実施した:
1. インラインスクリプトを Node の VM 上で実行し、構文エラー・top-level throw が無いことを確認
   （`tests/_ward-ux-v1-smoke-harness.cjs`、real fetch 付き）。
2. 実データを実際に fetch/parse させ、surfaceCount・HIGH/MEDIUM 内訳・sample 判定が期待通りの
   実数値を返すことを動的に検証。
3. suppress ロジック・Y/renderOrder・cache 無効化・status UI 文言を静的ソース解析で検証。
**スクリーンショットの成功を捏造することはしていない**（§21）。ユーザーがローカルで
`public/osaka_3d_buildings.ward-ux-v1.html` を開き、右下 `Road: HYBRID V1` の表示と、
FIX13/HYBRID/DIFF ボタンでの切替、DIFF モードでの緑/黄/マゼンタの塗り分けを直接確認できる状態。

## 完了条件（§26）チェック

- [x] Hybrid runtime 接続経路確認（UIトグル→state→manifest load→sample判定→geometry fetch→parse→
      FIX13 suppress→scene attach まで実データで動的検証）
- [x] ROAD_RENDER_MODE 正式化（3値・曖昧な複数 boolean を廃止）
- [x] sample 内 FIX13 二重描画なし（covered 判定直後の無条件 continue で構造的に保証）
- [x] sample 外 FIX13 維持（`if (sample)` ガードの外では一切触れない）
- [x] Sample Bounds 表示可能（`[Hybrid Sample Bounds]` トグル）
- [x] DIFF_DEBUG 強色表示（緑/黄/マゼンタ。UNRESOLVED=赤は正直にスコープ外と明記）
- [x] 右下 Road mode 表示
- [x] sample 名表示
- [x] surface 件数表示
- [x] 0件エラー表示（`HYBRID ERROR: 0 surfaces loaded`）
- [x] fetch error 画面表示（`Hybrid load failed`）
- [x] FIX13/HYBRID/DIFF ボタン
- [x] geometry 不変（Canonical Road=199,658 / Buildings=615,617 / FIX13 indexedCount=30,190。
      FIX19 Hybrid geometry も無変更・provenance.json 等の中身は無編集）
- [x] validator PASS（新規 runtime-cutover validator・既存 hybrid-v1 validator とも PASS）
- [x] npm test fail 0（1414 pass / 0 fail / 15 skip）

## 変更・新規ファイル

**新規**:
- `tools/validate/gsi-road-hybrid-runtime-cutover.js`（§23 validator）
- `tools/build-hybrid-sample-status.js`（§13 status UI 用の軽量サマリ packaging。geometry 計算は
  一切せず、FIX19 の既存 `samples/*.json` から数値のみ抽出する純粋なパッケージング）
- `tests/gsi-road-hybrid-runtime-cutover.test.js`（10 tests。うち2件は実データでの動的テスト）
- `data/processed/osaka-city/gsi-road-hybrid-v1/sample-status.json` /
  `public/map-data/osaka-city/gsi-road-hybrid-v1/sample-status.json`（新規。gitignore対象は既存パターン
  踏襲＝public側はgit未コミット）

**変更**:
- `public/osaka_3d_buildings.ward-ux-v1.html`:
  - CanonicalRuntime 内に `ROAD_RENDER_MODE` state・`HYBRID_SAMPLE_AREAS`・Hybrid dataset ロード・
    point-in-quad 40m grid index（`point-in-polygon-loop-performance-trap` 教訓を適用）・
    `setRoadRenderMode()`/`getRoadRenderMode()`/`getHybridRuntimeDebug()` を追加
  - `buildGroup()` の roads branch に、sample 内 GSI 被覆座標の FIX13 feature を suppress するロジックと
    DIFF_DEBUG 用マゼンタ bucket を追加
  - 右下 status パネルに Road mode / sample 詳細表示を追加
  - 旧 `[Hybrid v1]` 単純トグル IIFE を、FIX13/HYBRID/DIFF ボタン + sample selector（既存 `flyTo()`
    再利用）+ `[Hybrid Sample Bounds]` トグルへ置き換え
  - `[Hybrid Seams]` IIFE は変更なしでそのまま維持
  - `window.__SET_ROAD_RENDER_MODE__` / `__ROAD_RENDER_MODE_DEBUG__` / `__HYBRID_SAMPLE_AREAS__` /
    `__HYBRID_SAMPLE_AT__` を追加
- `tools/validate/gsi-road-hybrid-v1.js`（toggle 検出パターンを新しい `ROAD_RENDER_MODE` 実装に合わせて更新）
- `tests/gsi-road-hybrid-v1.test.js`（runtime toggle テストを新実装に合わせて更新）
- `tests/road-visual-surface.test.js`（固定長 slice の潜在バグを発見・アンカー方式へ修正。FIX19B の
  コード追加が直接の引き金だが、バグ自体は FIX12 以来存在していた既存の脆弱パターン）
- `package.json`（`data:gsi-road-edge:hybrid-v1-status` / `data:gsi-road-edge:validate-hybrid-runtime`
  スクリプト追加、`scripts.test` に新規テストファイル追加）
- `.gitignore`（変更なし。既存の `gsi-road-hybrid-v1/` 配下パターンで新ファイルもカバー済み）

**GSI pairing / corridor DP / Hybrid geometry 自体（`tools/audit/gsi-road-hybrid-v1.js` 等）は
一切変更していない（§0 完全遵守）**。
