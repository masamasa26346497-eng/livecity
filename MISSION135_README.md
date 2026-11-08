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

## Mission 136: 実データ段階（建物フットプリント / 海面）
| 段階 | 内容 | 結果レポート |
|---|---|---|
| 実建物のみ | 住吉区 `public/map-data/osaka-city/buildings/osaka-sumiyoshi/`（52タイル/35,031棟）を Cesium で押し出し表示。HTTP200・ON/OFF画素差・canonicalId クリック | `data/reports/mission136/real-buildings-e2e.json` |
| 実建物＋合成レイヤー | 上＋合成の道路/河川（**合成混在のため実データ達成に数えない**） | `real-buildings-synthetic-layers-e2e.json` |
| 実の海面のみ | 公開ポリゴンから決定的に再生成した海面（此花区）。建物等は未取得のまま | `real-water-surface-konohana-e2e.json` |

```bash
# 実建物（フットプリント）を 127.0.0.1 で表示・検証
npm run wards:viewer -- --footprints-root public/map-data/osaka-city/buildings --layers-root <layers-root>
npm run wards:e2e:real-buildings -- --ward sumiyoshi --out <新規.json>
# 実の海面（ネットワーク不要）: 生成 → 区別変換 → 検証
npm run wards:gen-water-surface -- --out <新規dir>/map
npm run wards:build-layers -- --map-root <新規dir>/map --out <新規dir>/layers
npm run wards:e2e:real-water -- --layers-root <新規dir>/layers --ward konohana --out <新規.json>
```
- 建物は区ごとに 3D Tiles（`<ward>25/` または restore-release-assets.js の展開結果 `_x_<ward>/`、サーバーが規約差を吸収）→ 無ければ map-data のフットプリント → 無ければ「未取得」（404を成功扱いしない）。
- 道路・河川(線)の実データはこのリポジトリに無い（`roads/` `waterways/` `rivers-v2/` の出力物なし）。入力は Mission115 の `build-city-layer-tiles.js` が `public/map-data/osaka-city/{roads,waterways}/tile_*.json` に出力する形式（znorth-neg-v1）で、Windows ローカルにある場合は `wards:build-layers --map-root` に渡す。
- 位置づけ: 本ビューア（`mission135-ward-viewer`）が将来の正式 24 区ビューアの候補。PR #24 の `mission37g-osaka-24ward-mvp.html`（3592行）とは統合せず、座標・高さ定数と canonicalId の契約のみ共有する。
- 状態: 実データで WebGL 検証済は「住吉区の建物のみ」「此花区の海面のみ」。3レイヤー実データ検証は 0 区、24 区は 0/24。

## Mission 137: 3D Tiles(GLB)+ID sidecar・復元導線・rivers-v2/道路面
| 項目 | 内容 |
|---|---|
| GLB 契約 | 頂点属性 `_FEATURE_ID_0` + `EXT_mesh_features`(propertyTable:0) + `EXT_structural_metadata`（Cesium は property table 付き featureId だけを feature として pick する）。canonicalId は `<ward>25/ids/<glb basename>.json`（配列 or `{ids:[]}`）の `[featureId]`。sidecar が無い/範囲外は `id:null`+`unresolved`（ID を捏造しない） |
| 復元済み建物の検査 | `npm run wards:link-buildings -- --root <展開先>`（読み取り専用。区ごとに ready/rejected/not-acquired、GLB ヘッダ・実在・sidecar 有無。copy/symlink なし）。そのまま `wards:viewer --buildings-root <展開先>` に渡せる |
| rivers-v2 | `rivers-v2/rivers.json` の centerline→line、left+reverse(right)→area として waterways に合流（座標不変、suppressed/ok=false 除外） |
| 道路面/交差点 | `wards:build-layers ... --road-surface` で roads の line から導出（`derived:true`、公式幅員ではない）。ビューアは roads の kind:'area' を描画 |
| Windows 既存出力の紐付け | `npm run wards:build-layers -- --map-root <…/public/map-data/osaka-city> --out <layers> --road-surface`（roads/waterways/rivers-v2/water-surface があれば処理、無ければ未取得） |
| クリック不一致分析 | `npm run wards:click-analysis -- --dir <footprints> --ids a,b`。住吉 1/25 は重なり/重複ではなく、画面端(x=1237)での隣接高層(11.7m、隙間2.2m)による遮蔽。建物真上に寄せた再 pick で同一 ID を返すことを確認（canonicalId は未変更） |

- 実 3D Tiles/GLB は本リポジトリに無く（`tileset.json`/`*.glb` なし）、GLB の E2E は**合成 fixture のみ**。住吉区の footprints 押出は GLB 成功ではない。
- 海面は区ポリゴン由来の派生物で、実海岸線の精度は未保証（地理的に正確とは認定しない）。
- PR #24 のツリー閲覧は環境の権限で行えなかったため、sidecar 形式は本契約（README の上記）を定義した。PR #24 の実 sidecar 形式と異なる場合は `ensureSidecar` のみ差し替える。
