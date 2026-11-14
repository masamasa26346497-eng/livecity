# Mission 212: 読み込み高速化(低リスク分のみ)
実装: ビルドが配信用 HTML の head に (1) cdn.jsdelivr.net への preconnect、(2) Cesium.js の preload、(3) /ext-3dtiles/index.json の preload、(4) cloud-perf-probe.js を注入。元の public/ HTML は変更しない。
プローブ(tools/cloud/perf-probe.js): 端末内のみ。`window.__lc212perf.snapshot()` で リクエスト数/転送量/初回タイル・建物ready時刻/区選択後の初回タイル/JS heap を取得。外部送信・永続化なし。Cesium/本体が20秒起動しない・スクリプト読込失敗時は赤帯で表示(空白を完成扱いしない)。
未計測: baseline/変更後の数値は未取得(認証付き Preview をこの runner で開けない)。改善率は不明。
既存の遅延設計(区は選択時に mount、旧区は destroy、coarseMax:8、cacheBudget、LOD2 は別 tileset)は変更していない。
原因候補(コード上の観察のみ・未実測): Cesium.js(CDN)の同期ブロック読込 / 約15本の同期 script / LOD2 footprints.json の起動時全量取得 / 配信 GLB の URL が非ハッシュのため max-age=3600 止まり / Cloud では requestRenderMode が既定 OFF(常時描画)。
計測手順: Preview を開き DevTools コンソールで `JSON.stringify(__lc212perf.snapshot())` を冷キャッシュ(ハードリロード)と暖キャッシュで各回取得。
