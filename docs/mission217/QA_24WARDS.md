# Mission217C 西区・平野区(LOD2=0) 実区QA（HEAD 21653f4 基準、SwiftShader・実PLATEAU2025・各1回）

PASS/FAIL/NOT_TESTED。実GPU・認証付きVercel Preview の成功ではない。Actions の queued/in_progress は開始時 0 件。

## 実行コマンド
```
node tools/cloud/build-cloud-preview.mjs --wards nishi  --single-pass --city-lod0 --out temp/nishi    # 49秒 43.9MB
node tools/cloud/e2e-city-lod0.mjs --static temp/nishi --lod --lat 34.6786 --lon 135.4900 --out temp/lod-nishi.json   # 110秒
node tools/cloud/build-cloud-preview.mjs --wards hirano --single-pass --city-lod0 --out temp/hirano   # 113秒 81.0MB
node tools/cloud/e2e-city-lod0.mjs --static temp/hirano --lod --lat 34.6150 --lon 135.5400 --shots temp/shots-hirano --out temp/lod-hirano.json   # 118秒
```
取得は Range retry 版(Mission217B)で、2区とも取得エラー・リトライ起因の失敗なし（通信エラーcauseの発生なし, `netFailed` なし）。

## 結果
| 項目 | 西区 | 平野区(LOD2=0) |
|---|---|---|
| ビルド | PASS: LOD1 12,603棟(補完12,425+LOD2同ID除外178), LOD2 1,767, doubleDrawn=0 | PASS: LOD1 46,473棟, LOD2 0(空LOD2正常), doubleDrawn=0 |
| 道路/水域 | 3,421件(0.77MB) / 77件 | 13,703件(2.88MB) / 377件 |
| LOD0 | 197セル 5タイル 115KB | 425セル 10タイル 246KB |
| `--lod` ok | PASS | PASS |
| tileset/GLB HTTP | LOD0 tileset 1/1, LOD0 GLB 5/5, 実tileset 2/2, 実GLB 55/55 が2xx | 1/1, 10/10, 1/1, 98/98 が2xx |
| optionalAsset 404 | 112件(towns-24等・他区source.json等。実建物の取得失敗ではない) | 118件(同) |
| realLayerOrIndex 404 | railways/parks 等4件（この区に無い任意レイヤー） | 同4件 |
| click→canonicalId | PASS(bldg_d2d021f6…) | PASS(bldg_ab0c4680…) |
| 情報カード開閉 | PASS | 開閉は成立。ただし開時 text=0(本文空)。内容の正否は NOT_TESTED（要調査） |
| tileFail | 全視点 0 | 全視点 0 |
| 親→葉(30km→600m) | PASS (GE 40→0, 葉6) | PASS (GE 40→0, 葉3) |
| held/loaded | 全5視点 true | 全5視点 true |
| 視点別 realShare (30k/15k/6k/3k/600) | .006/.019/.022/.390/.711 | .018/.061/.060/.310/.204 |

- 平野区 3000m/600m のPNGを目視: LOD1建物は青灰色、道路は灰色、区境線あり。黒化・白格子・LOD0とLOD1の二重描画は見えない。画面の白い領域は単独区ビルドで隣区が無い範囲。ラベル文字はフォント無しで化ける（SwiftShader環境）。PNG は実データ由来のため commit しない。
- 平野区のLOD1 fallback は、LOD2=0でもクリック・親→葉が維持されることを確認（今回SHA）。
- LOD1/LOD2色の比較は西区で数値化していない（`shot:false`）。LOD2色の目視は NOT_TESTED。座標は aim.hit=true(中心から10〜16m以内)のみで確認。

## NOT_TESTED（今回）
ラベル最終画素・検索・カードのESC・スマホ(390x844)・実GPU・認証付きVercel Preview・24区一体・55地点（現SHA）。

## 24区/55地点 最終QAの低コスト案（未実行）
- 現行 workflow はバッチ毎に all-wards(約1GB, 10〜15分)を再生成する。バッチ6回=約60〜90 runner分。
- 案A（推奨・権利/容量リスク最小）: 1 workflow run 内で all-wards を1回だけビルドし、同じ run の同一SHAで sweep を `--start-point` で複数ステップ(各 budget 20分以内)実行する。job上限55分に収まらない場合は2 job に分け、artifactではなく再ビルドを許容（ビルド1回/jobで計2回）。要 `.github/workflows` 編集＝管理者作業。
- 案B: `actions/cache` にビルド出力を保存。公式PLATEAU派生で既存Previewと同一範囲だが、容量(約1GB/10GB上限)と権利は管理者判断。未採用。
- 案C: 区単独ビルド+`--lod`(各約1.5〜4分)を、LOD2あり/なしの代表区＋隣接2〜3区で現SHA再検証し、24区一体は1回の最終runに限る。
- 直ちに24区ビルドは起動していない。

## 現在の未達ゲート / 次
1. 24区一体・55地点を現SHA統一で（上記案A/C）。 2. 平野区カード本文空(text=0)の原因確認。 3. ラベル画素・検索・ESC・スマホ。 4. 実GPU/Vercel認証付きPreview。

# Mission217B 取得失敗の切り分け（HEAD 13529d9 基準・追記）

## 診断（実測、秘密情報・署名URLなし）
- 取得元: `assets.cms.plateau.reearth.io` の公式 PLATEAU 2025 ZIP（1.58GB, ETag/Accept-Ranges あり）。呼び出し元は `tools/mission79-plateau2025-fetch.mjs` → `rangeFetch`（Node 組込 fetch/undici、Range、timeout 120s）。
- 本run: HEAD=200、Range 1KB/1MB/8MB=すべて206で成功。単一GML(28.8MB, 実取得1.2MB)も0.8秒で成功。**取得元の恒常的障害ではない**。
- 旧実装の弱点: `rangeFetch` はリトライなし、本文長の検証なし、エラーに `cause`(UND_ERR_SOCKET等)を出さない、GML書込が非原子的。前runの `fetch failed` は undici のソケット切断（推定。cause未記録のため**確定度: 中**）。
- 修正: rangeFetch に短い上限付きバックオフのリトライ(4回, 1→8s)・本文長厳格検証(短い/長い本文は失敗)・4xxは即失敗・`cause` 出力、fetch 側は `.part`→rename の原子的書込み。回帰テスト `tests/mission217b-range-retry.test.cjs`(3件, ローカルfixture HTTP: 切断→再試行→成功 / 切断本文→安全失敗 / 404即失敗)。

## 現HEADでの実測（北区のみ・SwiftShader）
- 北区単独ビルド（`--wards kita --single-pass --city-lod0`）: **PASS**（建物18,130, LOD2 4,553, `doubleDrawn=0`, 道路7,119, 水域141, 出力77MB）。
- 静的テスト(mission214 color / mission215 mobile-ux / mission213 city-lod0 / html-syntax / mission79-plateau2025 / retry): 全PASS（fixture/静的であり実描画の証拠ではない）。
- `--lod` + `lblidle=0/1`: 下記「E2E結果」参照。
- 西区・24区一体・実GPU・Vercel Preview: NOT_TESTED。

# Mission217 第7段階 24区QA 状況（基準 HEAD 5739fa2）

## 結果の区分
- PASS = 現SHAで実測 / HISTORICAL = 旧SHAの証拠 / NOT_TESTED = 未実施

## 今回の run（現SHA 5739fa2）で実測できたこと
- Actions の queued/in_progress は 0 件。作業ツリーはクリーン。
- 北区・西区の単独ビルド（`--wards kita|nishi --single-pass --city-lod0`）は、取得段階で `mission79-plateau2025-fetch` が `fetch failed` となり失敗（北区2回・西区1回。北区は1〜2ファイル目の取得後に失敗）。geospatial.jp への HEAD は 200 だが、大容量 GML の Range 取得が runner から安定しない。原因（一時的なネットワーク/取得元側の切断）は未特定。
- よってビルド不能 → `--lod` E2E、P0のラベル画素比較、クリック→カード→Escape、検索/区選択、390x844・1366x768 は**すべて NOT_TESTED**（今回は実行していない）。fixture/静的テストのみ実行: syntax・city-lod0・mobile-ux・color-gate の静的テストを実行（結果はPRコメント参照）。
- ラベル最終画素: NOT_TESTED。`__lblGate.open/pending` は表示PASSの根拠にしない。既定の `lblidle` はOFFのまま。実GPU採用判定は PENDING。

## 24区×ゲート（参照元 docs/mission213/WARD_AUDIT.md）
| ゲート | 24区の状態 |
|---|---|
| 区別 単独ビルド+`--lod`(ok, クリック一致, tileFail0, 親→葉) | HISTORICAL（各区、a4d62ec〜740c50b 等の旧SHA）。現SHA: NOT_TESTED（今回 北・西は取得失敗） |
| LOD2=0 区の正常フォールバック（minato, taisho, nishiyodogawa, ikuno, asahi, tsurumi, abeno, sumiyoshi, higashisumiyoshi, hirano, nishinari） | HISTORICAL。LOD1のみでクリック一致を旧SHAで確認 |
| tileset/GLB HTTP 2xx | HISTORICAL（個別・4区一体）。現SHA NOT_TESTED |
| 道路/河川 | 道路件数は個別ビルドの旧記録あり。見た目・交差は NOT_TESTED |
| 24区一体 | 24区ビルドは HISTORICAL（1023MB, 5393セル）。sweep は 55点中12点のみ・SHAが混在。**現SHA統一の合格ではない** |
| Vercel 認証付き Preview / 実GPU | NOT_TESTED |

## 低負荷バッチ計画（未実行）
1. 取得失敗が再現するか、ローカル/runnerで北区1区のビルドを再試行（リトライ付き取得の追加を検討。要コード変更の場合は別commit）。
2. 区単独ビルド（約30〜100秒）+ `--lod --lat/--lon` を区ごとに。LOD2ありの区を先に。
3. 55地点は既存ラベル `run-mission213-qa:<n>` で順次（各回 all-wards 約1GB を再作成。無料枠残量は不明）。ビルドのキャッシュは権利/容量未確認で未採用。
4. 省コスト順: (a) 北区ビルド+lblidle 0/1 画素比較（`--shots` の同一カメラ、ラベル近傍の差分）→ (b) 区単独E2E → (c) sweep。

## E2E結果（北区のみ、実データ、headless Chromium+SwiftShader）
- `--lod --qs "citylod0=1&lblidle=0"` と `lblidle=1`: どちらも `ok=true`, `clickSelectsBuilding=true`（各1回, exit 0）。
- ラベル画素比較(lblidle 0/1)・tileFail/視点別数値の精査・FPS: NOT_TESTED（今回は ok/click のみ確認）。実GPUは未確認。


# Mission217D（HEAD 3c677a6 基準）

## 平野区 カード text=0 の切り分け（コード読解のみ。再現は未実施）
- `selectBuilding`(public/mission37g-osaka-24ward-mvp.html:3744-3745,3800-3801)は `#lc-bldg-body.on` を付けた直後に同期で `#lc-cid` 等へ textContent を書く。区ごとの資産有無に依存せず、本文は非空になるはず。
- E2E の `text` は `innerText` の長さ。`innerText` は祖先が非描画(display:none 等)だと 0 を返すため、「bodyOn=true なのに text=0」は本体の空カードより、**測定側の偽陰性(祖先非表示・viewport 依存)**の可能性が高い。ただし**確定ではない**(平野区の単独ビルドは Actions 外では再現していない)。
- 診断を追加: `checks.infoCard.opened/closed` に `tc`(textContent長)・`cid`・`rendered`・`hiddenBy`・`vw/vh` を記録(`tools/cloud/e2e-city-lod0.mjs`)。次回の平野区 `--lod` で、tc>0 かつ rendered=false なら偽陰性、tc=0 なら本体不具合と判定できる。本体HTMLは未変更。
- 必須/任意アセット: カード本文に必須の外部資産は無い(属性はタイル由来、sidecar/写真索引は任意で失敗しても本文は残る設計)。

## 今回 NOT_TESTED
平野区カード再現、ESC/検索/区選択/スマホ390x844/PC1366x768、実GPU、`lblidle=1`(既定OFF維持)、24区一体、Vercel認証付きPreview。この run では実ブラウザもビルドも実行していない。

## 案A(1回生成・複数sweep)の read-only 精査
- 実行可能: 同一job内で `build --all-wards --city-lod0`(実測590〜890秒,約1GB)後、`e2e --sweep --start-point N --budget-min 20` を3〜4ステップ。計 約75〜95分で単一job上限(現55分)を超えるため2 job(ビルド2回)か、sweepを2ステップ(約40分)に絞る必要あり。
- 必要差分: `.github/workflows/mission213-qa.yml` の編集(管理者作業、App権限なし)。差分案は `docs/mission213/qa-24ward-minimal-diff.patch` を拡張する形。
- 費用: public repo の標準runnerなら無料想定だが、無料枠の確証は未取得。確証がないため全域ビルドは起動していない。
- 権利/privateリスク: 出力は公式PLATEAU2025派生で既存Previewと同範囲。artifactには集計JSONのみ(GLB/PNG非掲載)を維持。


# Mission218A 第1サイクル（HEAD b23d88f、SwiftShader、実データ）

| タスク | 依存 | 合格条件 | 結果 |
|---|---|---|---|
| T1 平野区単独ビルド（LOD2=0） | なし | ビルド成功・ID監査OK | **PASS** 106秒、46,473棟、LOD2=0、doubleDrawn=0、道路13,703、水域377、LOD0 425セル/10タイル、77MB。ツール修正は不要だった（LOD2必須の制約は現HEADに無い） |
| T2 平野区 `--lod` + カード | T1 | ok、クリックID一致、tileFail=0、カード診断 | **PASS** ok=true、clickSelectsBuilding=true、親→葉(30km 親10/ge40 → 600m 葉3)、全5視点tileFail=0 |
| T3 カード text=0 の判定 | T2 | tc/rendered で確定 | **偽陰性ではなく「再現せず」**: opened `innerText`=60, `tc`=139, `rendered=true`, `hiddenBy=null`, viewport 1000x557。closed で `rendered=false`(lc-bldg-body:display)。本体欠陥なし。過去の text=0 は旧計測条件の偽陰性（推定。当時の値は未保存で確定不可）。本体HTML未変更 |
| T4 `lblidle=0/1` 動作 | T1 | ok/クリック/カード/tileFail | 両方 **PASS**（ok=true, click一致, カードtc=139, tileFail=0）。1回ずつ |
| T5 ラベル最終画素・ラベル表示完了時刻 | T4 | 地名/駅名の最終画素一致 | **NOT_TESTED**（画像差分ツールが無く、E2Eはラベル完了時刻を出力しない） |
| ESC/検索/区選択/390x844、実GPU、24区一体55地点、Vercel Preview | — | — | **NOT_TESTED**（ESCはカードclose=PASS相当だがキー経由かは未確認） |

所要: lblidle=0 は 110秒、=1 は 94秒（E2E全体、1回ずつ。初建物時刻ではなく誤差範囲かも不明）。

## 次サイクル
1. E2Eに「ラベル表示完了時刻」と、同一カメラのラベル領域画素差分(PNG→Chromium canvasで比較)を追加。
2. 北区・西区・平野区で 1366x768 / 390x844 の検索・区選択・ESC。
3. LOD2あり区を1区ずつ追加（現SHAで）。24区一体はワークフロー分割の管理者承認後。


# Mission218B 第2サイクル（HEAD 969075a、北区のみ・実データ、headless Chromium+SwiftShader、各条件1回）

## 追加物
- `e2e-city-lod0.mjs --static <出力> --lblab [--lblab-size 1366x768|390x844] [--lblab-v 0|1]`: 同一視点(3000m,-45°)で `lblidle=0/1` を比較。ラベル有無は **全 LabelCollection の show=false/true の画素差**(A,A2,B の3フレームで不安定画素を除外)で判定。推定bbox内の差分画素も出力。ラベル完了=画素差>0の最初の時刻(状態フラグではない)。
- 同じ変種で 区選択→飛行 / 検索→結果選択→飛行 / 建物実クリック→canonicalId+カード本文→ESC を実行。
- `tests/mission218b-lblidle-patch.test.cjs`(5件 pass): fake Cesium 上で monkey patch の既定OFF非影響・heavy 保留/少数即時・20秒保険・viewer destroy を確認。実ブラウザ/実GPUの代替ではない。

## 結果(北区、各1回。時間は誤差範囲かもしれず、改善とは言わない)
| サイズ | lblidle | ok | 最初の実タイル選択 | ラベル画素 最初に>0 | gate open | 最終ラベル差分画素(bbox内) | ラベル数(視野内) | tileFail | 区選択飛行 | 検索選択飛行 | クリックID一致 | カード本文tc | ESC閉 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1366x768 | 0 | PASS | 18.1s | 31.2s | - | 87,103(81,822) | 80 | 0 | 16.6km | 17.9km | PASS | 142 | PASS |
| 1366x768 | 1 | PASS | 10.6s | 24.3s | 24.3s | 131,053(76,319、不安定画素65,271) | 80 | 0 | 16.4km | 19.6km | PASS | 142 | PASS |
| 390x844 | 0 | PASS | 9.7s | 18.2s | - | 56,564(54,260) | 88 | 0 | 11.1km | 9.3km | PASS | 141 | PASS |
| 390x844 | 1 | PASS | 7.8s | 16.5s | 16.6s | 56,563(54,259) | 88 | 0 | 1.0km | 8.7km | PASS | 141 | PASS |
(飛行量は camera.positionWC の移動距離[m→km換算]。`wardSelectFlightMovedM` を参照。390x844/lblidle=1 の区選択は1.0kmで他より小さい。原因未調査)

- **ラベル画素**: 390x844 は lblidle 0/1 で最終画素差(56,564 / 56,563)がほぼ一致。1366x768 は bbox内が 81,822 対 76,319(約93%)で、完全一致ではない。lblidle=1 は不安定画素が多く(タイル更新中)、**画素一致の確証は取れていない**。ラベル「省略」が起きていないこと(labelReleasedButNoPixels=false、released しても画素0になる問題は検出されず)までは言える。
- **initial building pixel**(最初の実タイル選択直後の実建物画素率)は 1366: 0.556(lbl0)/0.355(lbl1)、390: 0.255/0.253。計測時刻のタイル進行が異なり比較不能。
- lblidle=1 の gate: triggerMs=3.4〜8.9s(実タイル選択)、doneMs=7.2〜18.1s(ページ起動から)。

## フォント(限界)
runner に日本語フォントなし(`fc-list :lang=ja` 空、canvas で「日」が未定義コードポイントと同一描画=豆腐)。**文字の判読/文字化け/フォント欠損の画素検証は NOT_TESTED**。ラベルは「豆腐として描かれる画素」の有無・位置でしか見ていない。日本語フォント(Noto Sans CJK JP は SIL OFL=無償)の導入は apt で可能と思われるが、runner へのインストールは workflow/環境変更に当たるため今回は行っていない。

## ハーネス欠陥 vs 本体
- 390x844 で最初クリック不一致(c=false)だった原因は **ハーネス**: 画面中心付近の pick 候補が UI オーバーレイ(ヘッダ/シート)に覆われクリックが canvas に届かなかった(`elementFromPoint` で 143 候補が覆われ、canvas 上の候補へ変更し PASS)。本体修正なし。
- 区選択が 0m だった初回は、E2E 側の flyTo 無効化を解除する前にクリックしたハーネス欠陥(順序修正済み)。

## NOT_TESTED
実GPU(SwiftShader のみ)・日本語文字の画素検証・複数 viewer での monkey patch 二重ラップ・viewer destroy 後の実ブラウザ挙動・北区以外・平野区/西区での lblab・24区/55地点(今回は起動していない)・Vercel 認証付き Preview。
**lblidle は既定OFFのまま採用保留**(再現: 下記)。

## ユーザー実GPUでの採用判定手順
```
node tools/cloud/build-cloud-preview.mjs --wards kita --single-pass --city-lod0 --out temp/kita
node tools/cloud/e2e-city-lod0.mjs --static temp/kita --lblab --lblab-size 1366x768 --out lblab-pc.json   # 実機GPUなら --chrome で実Chrome指定(SwiftShader フラグは E2E 内で固定)
```
実GPU採否は、最初の実タイル選択時刻・ラベル画素>0 時刻・bbox 内差分画素が lblidle 0/1 で同等かを複数回(各5回以上)見る。

## 次の優先順位
1. 日本語フォント導入可否の判断(許可後に文字領域の画素比較)。2. 390x844/lblidle=1 の区選択飛行量(1.0km)の原因調査。3. 平野区・西区で lblab。4. 実GPU。

## Mission218C(2026-11-23)第7段階ゲート分類
**自動で確認済み(北区・SwiftShader・各1回、基準 45aa526+ハーネス修正)**: 日本語フォントありで lblab PC/mobile × lblidle 0/1 の4条件 PASS(検索・区選択・クリック・カード・ESC)。390 の区選択1.0kmはハーネス欠陥(修正後 0/1 とも 11.1km)。
**ユーザー実機確認待ち**: 実GPUでの cold/warm 各5回以上の初建物・ラベル完了時刻(lblidle 0/1)、実Chrome での日本語ラベル判読、認証付き Vercel Preview(現行SHA の HTML/tileset/GLB 200 と WebGL)。合格条件: ラベル領域画素が lblidle 0/1 で同等、操作 PASS、tileFail=0、初建物時刻が悪化しない。
**阻害要因**: (1) 24区同一SHA 110視点+24区クリックは 1GB ビルド(約10〜15分)と 55 地点バッチ(約5ジョブ)が必要。前景10分上限・`.github/workflows` 編集不可。今回起動していない=**NOT_TESTED**。364ae1e の過去 sweep は別SHAで現HEADのPASSではない。(2) 西区/平野区の `--lblab`・複数viewer patch・Preview は今回未実施(NOT_TESTED)。
**P2 最短策**: 既存ラベル `run-mission213-qa:<n>` を 0/12/24/36/48 の順に1件ずつ付与(各バッチは自前ビルド約10〜15分・無料public runner)。現 workflow は `--lod`/`--lblab` を呼ばないため、置換後の24区クリックには管理者による `docs/mission213/qa-24ward-minimal-diff.patch` 方式の更新が必要(承認事項)。同一SHAで全バッチを揃えるまで「24区PASS」とは書かない。

## Mission218D(2026-11-23)西区・平野区 `--lblab` 実データ(基準 HEAD d9c4b79、SwiftShader・各1回・日本語フォント Noto CJK 導入済み)
ビルド(区単独・直列): 西区 60秒/41.9MB(LOD1 12,603=補完12,425+LOD2同ID除外178、LOD2 1,767、doubleDrawn=0)、平野区 90秒/77.3MB(LOD1 46,473、LOD2=0 `single-pass-no-lod2`、doubleDrawn=0)。実データ(fixtureではない)。
コマンド: `e2e-city-lod0.mjs --static temp/<区> --lblab --lblab-size <WxH> --lat --lon --ward-name <区名>`(西区 34.6786,135.4900 / 平野区 34.6156,135.5639)。
| 区 | サイズ | lblidle | 結果 | tileFail | 初建物ms | ラベル画素初出ms | ラベル差分px(bbox内) | 区選択m | 検索結果/飛行m | クリックID一致 | カード本文tc | ESC閉 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 西 | 1366 | 0/1 | PASS/PASS | 0/0 | 24664/13990 | 41168/31058 | 143,785/100,553 | 12554 | 6/17006,16994 | 一致 | 141 | PASS |
| 西 | 390 | 0/1 | PASS/PASS | 0/0 | 11644/8231 | 20323/18684 | 30,873/36,555 | 7156 | 6/8360,3177 | 一致 | 141 | PASS |
| 平野(LOD2=0) | 1366 | 0/1 | PASS/PASS | 0/0 | 25512/12462 | 41617/29297 | 22,959/23,011 | 24787 | 6/33554,32792 | 一致 | 139 | PASS |
| 平野(LOD2=0) | 390 | 0/1 | PASS/PASS | 0/0 | 11751/9804 | 24680/23497 | 15,943/15,814 | 15144 | 6/23910,24582 | 一致 | 139 | PASS |
- 平野区: ラベル画素は lblidle 0/1 でほぼ一致(差0.2〜0.8%)。LOD2=0でも実建物クリック(LOD1 fallback)・カード本文(tc=139>0)・ESC PASS。
- 西区: ラベル画素は lblidle 0/1 で差が大きい(1366: 143,785 vs 100,553、390: 逆向き)。不安定画素・タイル進行差の可能性があるが原因未確定。画素一致は**確証なし**(lblidle は既定OFF維持)。
- 初建物時刻は lblidle=1 が全4条件で早い(各1回のためばらつき未評価。改善とは断定しない)。
- `labelReleasedButNoPixels` は全条件 false、`jaGlyphRendered=true`(豆腐ではない)。文字の判読・欠字の目視は未実施(PNG未撮影)。
- 本体不具合: 検出なし。ハーネス問題の再発なし。コード変更なし。
- NOT_TESTED: 実GPU、複数viewer monkey patch、24区同一SHA110視点、Vercel認証付きPreview。

### 第7段階 残ゲート(最短順)
1. (管理者・1回)`docs/mission213/qa-24ward-minimal-diff.patch` を `.github/workflows/mission213-qa.yml` へ適用(App は workflows 権限なし)。
2. ラベル `run-mission213-qa`、`:12`、`:24`、`:36`、`:48` を1件ずつ直列付与(各約10〜15分、public runner無料)。全バッチ同一SHAで揃うまで24区PASSと書かない。
3. ユーザー実機Chromeで `--lblab`(各5回以上、lblidle 0/1)。要・実GPU端末。
4. 認証付きPreview: 管理者がログイン状態で現SHAの HTML/tileset/GLB 200 と WebGL を確認(認証は変更しない)。

## Mission218E(2026-11-23)西区ラベル差異の確定(基準 HEAD 8145bb5 + 本コミット、SwiftShader・実データ西区)
**結論: 218D の「143,785 vs 100,553」等はハーネスの測定タイミング差(偽陽性)。アプリ本体の欠陥ではない。**
- 原因: 旧 `--lblab` は「最初にラベル画素>0 になった時点」の1回測定で、実建物タイルのロード/選択が進行中だった(実測: 早期測定で `unstablePx` 147,180〜313,117)。lblidle=1 は初建物が早く、測定時のタイル進行段階が異なっていた。
- 修正(`tools/cloud/e2e-city-lod0.mjs`、本体無変更): 選択タイル数と `tilesLoaded` が3連続で不変になるまで待ち(`settled`)、その後3回測定して `labelRepeat`(最小/中央/最大)・`realShareSettled`・`labelSample`(canvas ラベル文字列)を記録。
- 日本語フォント: 本 runner は既定で CJK 無し(`jaGlyphRendered=false`)のため `fonts-noto-cjk` を導入して測定(runner のみの操作、repo 無変更)。導入後 `jaGlyphRendered=true`。
- 結果(西区 34.6786,135.4900、3000m -45°、安定後、選択タイル 39(PC)/25(mobile)で lblidle 0/1 同一):
| サイズ | 実行 | lblidle 0 bbox内px(3回) | lblidle 1 bbox内px(3回) | 推定bbox px |
|---|---|---|---|---|
| 1366 | 1 | 143325×3 | 143325×3 | 183,732 |
| 1366 | 2 | 141857/143304/143325 | 140886/141856/143331 | 183,732 |
| 390 | 1 | 62057/72304/72304 | 72304/72304/74816 | 119,697 |
  安定後の中央値は lblidle 0/1 で一致(PC 143,325 / mobile 72,304)。ばらつきは `unstablePx>0` の1サンプル(アニメーション/フェード由来)で、中央値を採用すれば消える。
- ラベル文字列: canvas の LabelCollection から「住吉・粉浜・東粉浜・長居・南住吉・帝塚山西・万代…」を取得、lblidle 0/1 で同一。豆腐判定 `sameAsTofuForRare=false`。**PNG による文字の欠字・視認性の目視は未実施**(実データ派生物のため撮影・commit しない)。DOM と canvas の文字列照合は canvas 側のみ(DOM のラベル要素は未対象)。
- 操作テスト(検索・区選択・クリック・カード・ESC)はこの再実行でも全 `ok=true`(PC 2回、mobile 1回、各 lblidle 0/1)。
- 採否: **lblidle は既定OFFのまま**(実GPU・5回以上・実Chrome 日本語判読が未確認のため)。citylod0 も既定OFF。本体・座標・LOD は変更なし。

### P1 レビュー(workflow/patch、読み取りのみ。変更なし)
- `docs/mission213/qa-24ward-minimal-diff.patch` は現 workflow の step 構造(`steps.build`、`$CHROME`、`--cells` フラグの存在)と整合。権限は既存の `contents: read` / `pull-requests: write` のみで追加不要。artifact は `qa.json`+`summary.md` のみで画像/GLB は含まれない。
- 懸念: (1) 各バッチが ~1GB を再ビルド(実測 590〜890秒)し、1バッチ最大 ~50分(job上限55分)。5バッチ=最大約250分/月(public リポジトリなら標準 runner 無料、private なら月2,000分枠の約12%)。(2) patch 内 `|| true` は E2E 失敗を握りつぶすため、同一SHA PASS の根拠にするには `ok` を summary で必ず読むこと。(3) 区境座標2点は例示で、sweep の `ward-border` 行の lon/lat に置換が望ましい。(4) `--lblab` は patch に含まれない。西区/平野区の lblab を24区ビルドで回すなら `--lblab --ward-name <区> --lat --lon` の step 追加が別途必要。
- 適用手順(管理者、1回): Web UI で `.github/workflows/mission213-qa.yml` を PR #68 ブランチ上で編集 → patch の `+` 行を "Sweep E2E" の直後に挿入してコミット → PR のラベル `run-mission213-qa`、完了後に外して `:12`、`:24`、`:36`、`:48` を**直列に1件ずつ**付与(同一SHAのまま。途中でコミットが入ると SHA が変わるため新規に0から)。
- 24区同一SHA PASS は**未実施(NOT_TESTED)**。非workflow経路の代替: 区単独ビルドの `--lod`/`--lblab`(北区・西区は合格済み、平野区は LOD2=0 のため `--lod` 不可)。

### 第7段階を閉じるための最小証拠の分類
| 区分 | 項目 |
|---|---|
| Claude だけでできる(実施済み) | 西区ラベル差異の切り分け(本節)、区単独の lblab/lod/クリック(北・西・平野) |
| Claude だけでできる(未実施) | 他の区の単独 lblab、平野区以外の LOD2 有区の `--lod`(各約1〜3分) |
| 管理者の workflow 操作が必要 | patch 適用、ラベル 0/12/24/36/48 の直列付与による24区同一SHAの sweep+`--lod`+`--cells` |
| ユーザー実GPU/認証Preview が必要 | 実Chrome での lblidle 0/1 各5回以上の初建物・ラベル時刻、日本語ラベルの目視判読、認証付き Preview の現SHA HTML/tileset/GLB 200 と WebGL |
