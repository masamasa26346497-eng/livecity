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
