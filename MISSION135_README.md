# Mission 135: Cesium 24区ビューア（建物＋道路＋河川）— ローカル専用

| 部品 | ファイル |
|---|---|
| ビューア（Cesium、区選択・4トグル・欠落表示） | `public/mission135-ward-viewer.html` / `.js` |
| 127.0.0.1 専用の読み取りサーバー | `tools/mission135/server.js` |
| Mission115 タイル → 区別レイヤー変換（読み取り専用） | `tools/lib/ward-layer-adapter.js`, `tools/mission135/build-ward-layers.js` |
| 合成 fixture（実データではない） | `tools/mission135/make-fixtures.js` |
| 実 Chrome/WebGL E2E | `tools/mission135/e2e.mjs`（`tools/lib/cdp-browser.js` は PR #24 から取り込み） |
| 区別状態（未取得／生成済／WebGL検証済） | `tools/mission135/ward-status.js` |

## データ形式
- 建物: `<buildings-root>/<ward>25/{tileset.json,*.glb,ids/*.json}`（PR #24 の `ext-3dtiles` と同じ）
- 道路・河川: `<layers-root>/<ward>/layers/{roads,waterways,water-surface}.json`
  `{coordinateConvention:"znorth-neg-v1", features:[{kind:"line"|"area", p:[[x,z],...], tier?, waterClass?}]}`
  （x,z は `config/areas/osaka-city.json` の局所座標。ビューアは同じ投影の逆変換だけで経緯度化。補正値なし）

## 手順（ネットワーク取得・公開なし）
```bash
# 1) 既存のローカル Mission115 出力（roads/ waterways/ water-surface/ を含むフォルダ）から区別レイヤーを生成
npm run wards:build-layers -- --map-root <public/map-data/osaka-city 相当> --out <layers-root>
# 2) 127.0.0.1 で起動（建物は <buildings-root>/<ward>25/ に展開済みのもの）
npm run wards:viewer -- --buildings-root <dir> --layers-root <layers-root>
# 3) 状態表（未取得／生成済／WebGL検証済）
npm run wards:status -- --buildings-root <dir> --layers-root <layers-root>
# 合成 fixture の実 Chrome 検証（Chrome が必要）
npm run wards:e2e:synthetic -- --out data/reports/mission135/synthetic-e2e.json
```

## 現状
- 合成3区の実 Chrome/WebGL 検証は通過（`data/reports/mission135/synthetic-e2e.json`）。**実データ24区は 0/24 検証済**。
- rivers-v2 は出力規約が未解析で変換対象外。建物の canonicalId クリック検証は合成 fixture では未実施。
