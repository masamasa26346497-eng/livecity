# Mission 215 QA マトリクス(基準 SHA 719cfe3 + 本コミット)
| 項目 | 優先 | 状態 | 根拠 |
|---|---|---|---|
| 未選択時モバイル右パネル非表示 | P0 | PASS(静的CSSのみ) | tests/mission215-mobile-ux.test.js。変更前は FAIL(規則なし)。実画面は NOT_TESTED |
| 区カード/右パネル重なり | P0 | PASS(静的) / 3サイズ実測 NOT_TESTED | 同上 |
| 区選択で左パネルを閉じる | P0 | PASS(静的) | 同上 |
| Escape 段階閉じ・aria・閉じるボタン・44px | P1 | PASS(静的) / キーボード実操作 NOT_TESTED | 同上 |
| 3サイズの実ブラウザ重なり検査 | P0 | NOT_TESTED | WebGL ページの E2E は今回未実施 |
| 検索リスト矢印キー | P2 | NOT_TESTED | 未実装 |
| FPS・操作時間・初回タイル速度 | P2 | NOT_TESTED | 計測仕様のみ(PLAN.md) |
| 同一SHAで55地点PASS・Preview WebGL・24区クリック | ゲート | NOT_TESTED | 本サイクル対象外 |

## 第2サイクル: 実ブラウザ検証(基準 SHA d739a11、アプリ本体は無変更)
実行: `node tools/mission215-ui-e2e.mjs --out report.json`(headless Chromium + CDP、実ページを localhost 配信、Cesium は CDN)。
**区ボタン・閉じるボタン・Escape・btn-panels は実イベント。建物/施設/町丁目の選択は実データが無いため、コードと同一の DOM 更新(`#lc-bldg-empty` に `display:none`、各 `*-body` に `.on`)を再現した emulated 検証。**

| 視点 | 未選択で右パネル | 施設/町丁目/建物(emulated)で右パネル表示 | 区ボタン44px | 区選択で左パネル閉/aria | 区カード↔右パネル重なり | Escapeで区閉じ | 検索結果↔区カード |
|---|---|---|---|---|---|---|---|
| 360×640 | PASS(非表示) | PASS×3、画面内に収まる | PASS | PASS | なし | PASS | INFO(重なる・結果が前面 z40>16) |
| 390×844 | PASS | PASS×3 | PASS | PASS | なし | PASS | INFO(同上) |
| 768×1024 | PASS(表示。>720px は従来レイアウト) | PASS×3 | 対象外 | 対象外 | なし | PASS | 重なりなし |
| 1366×768 | PASS(表示) | PASS×3 | 対象外 | 対象外 | なし | PASS | 重なりなし |

- 閉じるボタン(モバイル): 実クリックで状態が未選択に戻り右パネルが消え、focus は `btn-panels`。44px 以上。PASS。
- `:has(#lc-bldg-empty:not([style*="none"]))` は 4 状態(未選択/施設/町丁目/建物)で選択中カードを消さなかった。**欠陥は再現せず、アプリ本体は変更していない**(fail→pass の根拠となる修正はなし)。
- 未検証: 実データでの建物/施設クリック経路そのもの、Escape 時のカメラ不変(`clearSelection` は `flyTarget=null` にするため飛行中の Escape は飛行を中断する。コード読解のみ)、`:has` 非対応ブラウザ、実機スマホ、Vercel 認証済み現 HEAD、FPS。
- 前サイクルの `tests/mission215-mobile-ux.test.js` 6件は PASS(静的)であり、上の実ブラウザ結果とは別物。

## 第3サイクル: 検索のキーボード操作(基準 SHA 7b0caa4)
実行: `node tools/mission215-search-e2e.mjs [--html <旧版>]`(headless Chromium + CDP の**実キー入力**。labels.json の fetch のみ合成の3候補に差し替え。Cesium は CDN)。
| 区分 | 項目 | 結果 |
|---|---|---|
| 実ブラウザ PASS | ArrowDown/Up でハイライト(class・aria-selected・aria-activedescendant)移動、Enter でハイライト済み候補を選択、Escape で閉じて検索欄 focus、Tab で閉じ込めない、0件で矢印が安全、結果が無いとき矢印を preventDefault しない、combobox/aria-expanded/aria-controls | 390×844 と 1366×768 で各12項目、新コード 24/24 PASS。旧コード(`--html` に変更前版)は 12 項目 FAIL(Enter が常に先頭候補を選ぶ、ARIA/ハイライトなし、Tab で結果が残る) |
| 模擬(emulated) | 地図遷移 | 合成座標への `camera.positionWC` 変化のみ確認。実データの位置は未確認 |
| NOT_TESTED | 古い検索応答の上書き防止(`searchSeq` ガードはコード上のみ。E2E は応答遅延を再現していない)、検索失敗時の表示、実機スマホ/IME変換中の Enter、実3Dクリック、速度、Vercel 現SHA WebGL、同一SHA55地点 | 未実施 |
文言: ext45 の index が2区以上を登録したときだけ読み込み文言と `ward-cov-note` を切替(「全24区描画済」とは書かない)。ext45 なし(住吉区ローカル)は従来文言のまま。Cloud 文言の実ブラウザ確認は NOT_TESTED。

## 第4サイクル: 検索の信頼性(基準 SHA 3526480)
実行: `node tools/mission215-search-robust-e2e.mjs [--html <旧版>]`(headless Chromium + CDP。390×844 / 1366×768 各16項目、新コード 32/32 PASS)。既存 `mission215-search-e2e.mjs` は 24/24 PASS(回帰なし)、`mission215-mobile-ux`/`mission209-37g-html-syntax` 7件 PASS。360×640 は未実施。スクリーンショットなし。
| 区分 | 項目 | 結果 |
|---|---|---|
| REAL(CDP実入力) | IME 変換中(`Input.imeSetComposition` + keyCode 229)の Enter で submit しない / 候補表示中でも候補を確定しない / 確定文字列(insertText)で候補が更新される / 通常 Enter は従来どおり候補を選ぶ / ext45 なしの文言維持 | PASS |
| EMULATED | Safari 型(compositionend の後に keyCode 229 の Enter keydown): 合成 KeyboardEvent。**旧 HTML は FAIL(defaultPrevented=false)→ 修正後 PASS**。実 Safari/実 IME は NOT_TESTED | 修正で PASS |
| FIXTURE(サーバ合成) | 先発A(応答2.5s遅延)→後発B先着→A後着でもBの結果のまま / 入力後 Escape → 古い応答が来ても閉じたまま / 候補選択後の古い応答で再オープンしない / labels.json 500 で「不完全」表示・偽の候補なし・再読込で復旧 / index.json 3区=Cloud文言(「全24区描画済」とは書かない)、1区・500・404=ローカル文言 | PASS |
修正: `qInput` keydown で `Enter` かつ `isComposing || keyCode===229` なら `preventDefault`(Safari の変換確定 Enter による誤 submit 対策)。Chromium の実 IME 変換中 Enter は修正前から submit されなかった(欠陥は再現せず)。競合・失敗時・Cloud 文言も欠陥は再現せず。
NOT_TESTED: 実 IME(OS)・実 Safari、`lc-loading` が実 tile で消えるタイミング(合成 index では tile 無し)、実データの 24区 WebGL/3Dクリック/FPS、現 HEAD の Vercel Preview、同一SHA 55地点 QA。次ゲート: 北区/西区の単独ビルド(`build-cloud-preview.mjs --wards kita --single-pass --city-lod0`)+ `e2e-city-lod0.mjs --lod` を現 HEAD で実行(実3Dクリック)、Preview はデプロイURL+認証済みアクセスが必要。

## 第5サイクル: 実PLATEAU北区の実3Dクリック(基準 SHA a9e9e4e)
実行: `build-cloud-preview.mjs --wards kita --single-pass --city-lod0 --out temp/kita`(89秒、75.9MB、LOD1 18,130棟、LOD2 4,553棟、doubleDrawn=0)→ `e2e-city-lod0.mjs --static temp/kita --lod`(headless Chromium+SwiftShader、約2分、2回実行し2回とも ok=true)。`--lod` に情報カード開閉チェック(`checks.infoCard`)を追加。
| 項目 | 結果 |
|---|---|
| 実LOD1/2 GLB(realGlb) | 94件、非2xx 0 / LOD0 GLB 8件 非2xx 0 / tileset 非2xx 0 |
| tileFail | 全5視点 0 / held・loaded 全て true |
| 親→葉 | 30km: 選択7(葉0, geometricError最大40) → 600m: 6(葉6, 0)。PASS |
| Cesium canvas への実マウスクリック(CDP)→canonicalId一致 | PASS(2回とも) |
| 情報カード表示(#lc-bldg-body.on, empty 非表示)→ Escape で閉じる | PASS(実キー入力) |
| 転送量(1実行) | 約53MB(キャッシュ条件未統制の参考値) |
| 404 | optionalAsset(towns/stations/favicon/GSI blank等)と未生成の railways/parks。実建物資産ではない |
| 検索→区選択→3D表示 | NOT_TESTED(本E2Eは検索を経由しない) |
| LOD2の黒化の画素確認 | NOT_TESTED(PNG未取得・未目視。GLB数値のみ) |
| navigation→初回実建物描画の時間・FPS | NOT_TESTED(本モードは出力しない。`--baseline` は warm 不具合あり) |
| Vercel 認証済み Preview HTTP200/WebGL | NOT_TESTED。ユーザー操作: Vercel にログインして PR の Preview URL を開く、または Shareable Link を発行 |
値は SwiftShader であり実GPU性能ではない。本体HTMLは無変更。

## 第6サイクル(段階A): 速度ベースライン(基準 SHA a57991d + 本コミット。アプリ本体は無変更)
実行: `build-cloud-preview.mjs --wards kita --single-pass --city-lod0 --out temp/kita`(148秒=ビルド時間でありユーザー閲覧のロード時間ではない)→ `e2e-city-lod0.mjs --static temp/kita --baseline`(headless Chromium+SwiftShader、視点 3000m/-60°、`--out`)。**実GPUではない。各条件 1〜3回の参考値**。
`--baseline` に追加した段階別指標(定義): `tViewerMs`=viewer(`window.__v`)出現 / `tFirstRealMs`=実タイル(非LOD0)選択数>0 / `tFirstRealPixelMs`=実タイルを隠したフレームとの画素差>0.2%(選択数>0だけでは描画を意味しないため) / `tClickableMs`=画面格子pickで実建物canonicalIdが取れた最初 / `tAllTilesLoadedMs`=全tileset tilesLoaded かつ選択>0が1.5秒連続 / `clickInPage`=CDP実クリック→選択イベント・情報カードの in-page 時間と longtask。建物IDは出力しない。
| 指標(ms) | cold(3回) | warm(3回) |
|---|---|---|
| viewer 出現 | 2042〜2063 | 2089〜2244 |
| 最初の実タイル選択 | 21027〜25330 | 20845〜20994 |
| 最初の実建物画素フレーム | 22405〜27376 | 23347〜24971 |
| クリック可能(pick取得) | 25376〜30705 | 26231〜27984 |
| 全タイル安定 | 26280〜31074 | 27512〜28062 |
| 転送量 | 18.7MB | 4.6MB(キャッシュ有効) |
| frame p50/p95 | 61〜62 / 69〜78 | 56〜59 / 65〜75 |
| heap | 86〜108MB | 86〜101MB |
| tileFail | 0 | 0 |
- **warm 起動遅延バグは再現しなかった**(旧: 30秒)。cold/warm 差は転送量(18.7→4.6MB)のみで、**表示完了時間は cold と warm で差がない(どちらも約20〜28秒)**。= 時間の支配項はネットワークではない。
- 最大のボトルネック(測定事実): viewer 出現(約2秒)から最初の実タイル選択まで約19〜23秒、リクエストが出ない無通信区間(cold 18.8秒、warm 9秒。直後の要求は `/map-data/osaka-city/facilities/ward-manifest.json`)。ネットワークでもタイル選択でもなく**メインスレッドの初期化(JS/SwiftShader)側**。ただし原因の関数までは未特定で、SwiftShader 起因かアプリ起因かは切り分けていない。→ 実GPU または CPU プロファイル(`Profiler`)が次の測定。**アプリ本体は推測では変更していない**。
- 異常値(要追試): 実クリック直前の `scene.pick` 1回が約21.7秒(3回中3回。in-page 計測)。同じ pick を含む画面格子探索は数秒で終わっており、直前の計測処理(60回の `scene.render` や画素差プローブ)との相互作用の可能性がある。pick 後のクリック→選択イベント→情報カードは 0.6〜1.2秒、Escape で閉じる PASS。原因未特定のため修正していない。
- `realPixelShare` は cold 0.15〜0.22、warm 0.90〜0.97 と大きくばらつく(warm の値は画像タイル読込等の差を含む疑い)。**画素差の絶対値は改善証拠に使わない**。出現判定(>0.2%)のみに使用。
- LOD2 の色: `--lod --shots` の近景 600m(-60°)PNG をローカル目視。建物は青灰色で黒化なし。ただし**このフレーム内の建物がLOD2かLOD1かは識別していない**ため、LOD2 の色一致は NOT_TESTED。PNG は commit/upload していない。`--lod` は ok=true(5視点 held/loaded/tileFail=0、親→葉、クリック、情報カード開閉)。
- 計測重複: `tools/cloud/perf-probe.js`/`public/mission45g-perf.js`/`mission45l-interaction.js` は実ページ内の別系統計測で、本 E2E とは統合していない(今回は触らず)。
- NOT_TESTED: 実PC GPU、現HEAD同一SHA 55地点、保護付き Vercel Preview、24区全域、モバイル相当(CPU スロットリング)、プロファイラによる初期化の内訳。

## 第6サイクル(段階B): 描画開始までの約20秒の切り分け(基準 SHA ee1225b + 本コミット。**アプリ本体は無変更**)
実行: 北区ビルド(`--wards kita --single-pass --city-lod0`、86秒=ビルド時間でありユーザー閲覧のロード時間ではない)→ `e2e-city-lod0.mjs --static temp/kita --profile [--probe] [--pick] [--labels-off]`(新規モード。CDP `Profiler`(1ms)+ longtask。cold を毎回キャッシュ消去で2回)。headless Chromium+SwiftShader、実GPUではない。出力は関数名/URL/行のみ(建物ID・PNG・GLB なし)。
| 条件 | 最初の実タイル選択(ms, cold×2) | 安定(ms) | 転送 | tileFail |
|---|---|---|---|---|
| A 計測介入なし(500ms周期の軽量evalのみ) | 24946/28485、27818/29759(2回実行) | 26402〜31194 | 18.1MB・153〜168req | 0 |
| B 介入あり(`--probe`: 画素差プローブ=scene.render×2+canvas読出し) | 28038/29207 | 31234/32128 | 18.1MB | 0 |
| **C 環境のみ変更 `--disable-accelerated-2d-canvas`**(A と同じ計測) | **11674/11502** | 12941/13031 | 18.0MB | 0 |
| C+B | 12270/12622 | 15101/15564 | 17.8MB | 0 |
| A+全LabelCollection無効(診断) | 8777/9681 | 9806/10703 | 17.8MB | 0 |
- **計測介入は主因ではない**: A(介入なし)でも 25〜30秒。B は A より数秒遅い(介入は一部上乗せするが、20秒の主因ではない)。
- **プロファイラが特定した主因**: viewer 出現〜最初の実タイル選択の約25秒のうち、メインスレッドは 93%(busy 23〜25秒)。ネットワークの無通信区間はメインスレッドの長いタスク(3〜14秒×数回)と一致。内訳(自己時間): `Cesium.js:8787 hHe`(Cesium のテキスト寸法計測: `measureText`+`canvas.getImageData` — LabelCollection のラベル文字ごと)13.6〜17.7秒、`Cesium.js:92 _Le`(shader compile/link、SwiftShader)4.6〜5.3秒、残りは各数百ms以下。呼び出し元スタックにアプリ側の関数は無く(Cesium の render ループ内)、アプリ初期化(`poiSyncAll`/`updateVecCoverage`/`mmDraw` 等)は各 20〜650ms 程度。ラベルは 8 コレクション・計667個。
- **切り分け**: `--disable-accelerated-2d-canvas`(2D canvas を CPU 実装にするだけ)で `hHe` が消え、最初の実タイル選択が約26秒→約11.5秒。= **2D canvas の GPU(SwiftShader)読み戻し(`getImageData`)が支配的で、SwiftShader/ヘッドレス環境起因の可能性が高い**。実GPU/実ブラウザで同じ読み戻しコストが出るかは **NOT_TESTED**(実ブラウザでは `hHe` が速い可能性も、ラベル数667に比例して効く可能性もある)。ラベルを全て無効にしても 9〜10秒かかり、これは shader compile(SwiftShader)など。
- **pick 約21秒の外れ値**: 安定後に単独で `scene.pick` を1回呼ぶと 0.76〜0.81秒(2回目 0.12秒、内訳は `readPixels`=GPU同期待ち 0.74〜0.79秒)。`--disable-accelerated-2d-canvas` の baseline でも クリック直前 pick は 17.6〜21.0秒だったため、これは **`--baseline` のプローブ列(格子pick約280回・60回の scene.render 等)直後に起きる計測起因の外れ値で、アプリ単体の遅さではない**(厳密な原因関数は未特定)。
- **判断**: 原因が SwiftShader の CPU 描画・計測介入・外部待機側であるため、**アプリ本体は変更しない**(根拠なしの変更を避ける)。pick/クリック回帰も不要。5% 程度の差は改善と扱わない。
- 回帰(本体無変更のため軽量のみ): `tests/mission213-city-lod0`・`mission213-sweep-plan`・`mission213-http-classify`・`mission214-color-gate`・`mission215-mobile-ux`・`mission209-37g-html-syntax` で 32件 pass。
- NOT_TESTED: 実GPU/実ブラウザでのラベル寸法計測コスト、モバイル相当、現HEAD同一SHA 55地点、24区全域、Vercel 認証付き Preview の WebGL。
- 次の安全な一手: (1) 実GPU/実ブラウザ(ユーザーのPC)で `?` なしの Preview を開き DevTools Performance で `measureText`/`getImageData` が長いか確認、(2) 長い場合のみ、ラベルを実タイル安定後に遅延生成/件数上限にする最小変更を A/B(`--profile` の A条件で再計測)。

## 第7サイクル(段階C): ラベル初期化の遅延 `?lblidle=1`(opt-in・既定OFF。基準 SHA cd154b1)
**実装**(`public/mission37g-osaka-24ward-mvp.html`、`?lblidle=1` のときだけ): `Cesium.LabelCollection.prototype.update` を包み、ラベル数 >40 の collection(北区では 2 個)だけ、最初の実LOD1/2 タイル選択(保険: `?lblidlemax`=20秒)まで update を止め、その後 idle で 1 個ずつ解放。ラベルは削除・縮小しない。少数(区名等)は即時。診断: `window.__lblGate`。
**コード追跡**: LabelCollection は 8 個(labels.json=地名/公園、stations 148、towns24 は区ごと base/full、townlabels 3、wardlabels、facilities)。計667個。文字寸法計測は Cesium が最初の update で行う(作成時ではない)ため、update 側で遅延するのが最小介入。
**A/B**(北区1区ビルド、headless SwiftShader、`--profile` A条件、cold 各2回、HTTP キャッシュ消去。2回目の A は別実行):
| 条件 | 最初の実タイル選択(ms) | tileFail | 非2xx |
|---|---|---|---|
| A 既定 | 46901 / 35749 / 38297 / 38262 | 0 | 0 |
| B `lblidle=1` | 17913 / 20484 / 12140 / 18879 | 0 | 0 |
- B は全4回で A の最短より速い(差 約15〜25秒)。ただし**実行ごとのばらつきが大きく**(A は前サイクルで 25〜28秒)、SwiftShader の 2D canvas 読み戻し(`hHe`)を後ろへ回しただけの可能性が高い。**実GPUでの改善とは言えない。NOT_TESTED。**
- 最終表示: `--settle`(安定後20秒)で `open=true, pending=0, released=2` を2回確認(全 heavy collection が解放済み)。ラベルの画素レベルの最終表示確認は NOT_TESTED。
- 計測プローブは A/B 同一(500ms周期の軽量 eval のみ。介入なし)。
- 回帰: syntax・city-lod0・mobile-ux・color-gate で 20件 pass(静的)。**検索・クリック・区切替・スマホの実ブラウザ回帰は今回 NOT_TESTED**。
- **判断**: 既定は OFF のまま。実GPU/実機での確証と上記回帰が済むまで既定ONにしない。区切替で towns24 を再作成する経路(towns は区ごとに collection を作るが、開始後は gate が open 済み)は、遅延の対象外。
## 第7段階(24区・55地点)の最小QA案(今回は実行しない)
1. 1GB ビルドを避ける: 既存 `mission213-qa` のラベル `run-mission213-qa:<n>` バッチ(12点×2高度/回)を現SHAで再実行(全55点で約5回、各 約45分未満、無料runner)。
2. 区ごとの単独ビルド(`--wards <区> --single-pass --city-lod0`、数十秒〜1分、LOD2を持つ区のみ)で `--lod` を回し、クリックcanonicalId・LOD2色(mission214-color-gate)・roads/waterways HTTP を確認。
3. 24区を跨ぐ確認は上の sweep バッチ。Vercel Preview は認証付きで管理者側確認(NOT_TESTED)。
- NOT_TESTED: 実GPU・実機Safari・現SHA 55地点/24区・Vercel Preview。
