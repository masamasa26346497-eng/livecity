# PR#68 へ渡す Cesium 接続パッチ（案・未適用）
確認元: `git fetch origin claude/issue-67-20261114-1354` → `git show origin/claude/issue-67-20261114-1354:public/mission37g-osaka-24ward-mvp.html`（読取のみ。fetch 時点の HEAD `efdced09a34cf7edbcac4e9dd78a6b4cca50f900`。報告値 `364ae1e` より新しく、並行更新中）。拒否はなし。
実ビューアは **Cesium 1.121.1**（L450 CDN、L527 `new Cesium.Viewer`、IIFE 内）。投影は L485-489 の `PROJ`/`COS_CLAT`/`toLon`/`toLat`/`toCart`、逆変換は L1380 `cartToLocal`。
旧 `PR68-connection-snippet.md`（THREE 前提）は **無効のため削除**した。

PR#68 の `public/mission37g-osaka-24ward-mvp.html` の IIFE 内、`viewer` と `fail` 定義後（例: 末尾 `if (q.get('panel') === '0')` の直前）に追加する。既存コードの削除・改変なし。`public/supplement-layer/`（`projection.js`、`supplement-layer.js`、`supplement-cesium-adapter.js`）を PR#66 から取り込む。

```js
  // ── 補完建物（Issue #65）: 既定OFF。?supplement=1 のときだけモジュールを読み込み、sup.enable() を呼ぶまで通信しない ──
  if (q.get('supplement') === '1') {
    import('./supplement-layer/supplement-cesium-adapter.js').then((m) => {
      const sup = m.connectSupplement({ Cesium, viewer, PROJ, baseUrl: 'map-data/osaka-city/buildings-supplement/' + SET + '/' });
      window.__supplement = sup;   // UI トグル: sup.enable() / sup.disable()
    }).catch((e) => fail('supplement', e));
  }
```
- `PROJ` を渡すので式は PR#68 と同一定数。`projection.js` も同値で、`tests/supplement-cesium-adapter.test.js` が固定する。
- 未確認データの公開許可（`allowUnpublishable`）は `connectSupplement` の引数に存在せず、URL では変更できない。
- 取得失敗/manifest 不在: `sup.layer.state==='error'`。既存の地図と requestRenderMode には影響しない。レンダは変更時のみ `scene.requestRender()`。
- ピック: `scene.pick` の結果を `sup.pickRecord(picked)` に渡す（`id.layer==='supplement'` のみ処理。既存の `id.layer` 処理とは別値）。
- 色: heightClass 別の識別色。既存 `TONE` とは意図的に区別し、推定高さを実測と見せない。
- **未確認**: 実ブラウザでの表示、実データ、PR#68 の既存ピック/LOD0 との干渉、配色の最終調整。
