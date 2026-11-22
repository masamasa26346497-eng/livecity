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
