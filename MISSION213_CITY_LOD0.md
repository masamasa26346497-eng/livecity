# Mission 213 — 24区一体 階層LOD(Phase 0 計測基準 / Phase 1 都市全体LOD0 試作)

状態: **技術実証(Draft)**。実ブラウザ描画・実データ生成・性能は **未検証**(この実行環境はネットワーク/ブラウザ無し)。

## 現行コード監査(PR #61 `b56e979` 時点・コード読みのみ)
- `build-cloud-preview.mjs` は `index.json` に `lod0Wards: []` を出力 → 37G `lod0Sync()` は `!lod0Wards.length` で即 return。遠景LOD0は事実上無効。
- 既存 LOD0 経路(45G)は区ごと tileset・`allMode` 時のみ・旧45D attrs 前提。PLATEAU2025 正規データ由来ではない。
- クリックは `scene.pick` + `canonicalId`。LOD0 を同経路に載せると誤選択するため `allowPicking:false` で除外。

## Phase 1 試作(本PR)
- `tools/cloud/city-lod0.mjs`: ビルド済み `ext-3dtiles/<区>/attrs`(補完LOD1)+ `lod2-preview/footprints.json`(LOD2棟の重心)から **全区共通グリッド**(既定200m)で概略ブロックを集約。
  - 区境セルは1つに統合(二重化/穴なし)。LOD2化した棟を数え戻し、LOD2のみのセルの欠落を防ぐ(高さ不明は既定12m・`lod2OnlyCellsDefaultHeight` に計上)。
  - 出力 `ext-3dtiles/_city-lod0/`: 10×10セル(2km)ごとの GLB + 親 tileset(ADD)→子(REPLACE)。`coverage-report.json` に24区matrix。欠落区があれば fail closed。
  - id は `lod0_<cx>_<cz>`(`bldg_` ではない)。決定的(乱数・時刻なし)。座標定数は37B同一で不変。
  - `index.json` に `cityLod0` を追記(既存キー不変)。
- `build-cloud-preview.mjs --city-lod0`: **既定OFF**(既存Preview不変)。
- 37G HTML `?citylod0=1`: **既定OFF**。カメラ高度 ≥ `citylod0min`(既定2500m)で表示、近づくと実LOD1/2に委譲。`allowPicking:false`。
- ロールバック: フラグを付けなければ従来と同一。

## 未実装(Phase 2 以降)
タイル単位の LOD0→LOD1→LOD2 置換(REPLACE 統合root vs viewer管理の比較)、先読み/キャンセル、foveated 等の比較、ハッシュ付きURL・圧縮。

## Phase 0 計測プロトコル(未実施)
cold/warm × PC/低速4G で: (A)UI ready (B)最初の建物 (C)24/24区可視 (D)横断時の空白 (E)区クリック→高精細 (F)転送MB/req (G)FPS/p95 (H)GPU/heap。
`window.__lc212perf.snapshot()` と `perf.cityLod0` を使用。Vercel認証で実URL不可なら同一bundleを localhost で測り、範囲を明記する。

## 検証
`node --test tests/mission213-city-lod0.test.cjs`(合成fixture)・`tests/mission209-37g-html-syntax.test.js` ほか既存cloudテスト 14件 pass。実データ生成と画面確認は未実施。

## 実ブラウザE2E(合成fixture・実PLATEAUではない)
`node tools/cloud/e2e-city-lod0.mjs [--chrome /usr/bin/chromium] [--out report.json]`
headless Chromium(SwiftShader WebGL)+ localhost で 2区×450セルの合成LOD0を Cesium 1.121.1(jsDelivr)で描画。同一カメラで LOD0 表示/非表示のフレームを比較し「LOD0が寄与した画素率」を計測する。
確認できたこと(合成のみ): tileset/GLB 7件 HTTP200、区境(x=3000)を挟む5地点で LOD0 寄与率 0.67〜0.72 の連続(穴なし)、`?citylod0` 無しでは LOD0 を一切取得しない、近接(800m)で LOD0 非表示、注意書き表示。
**実測で判明**: Cesium 1.121.1 では `allowPicking:false` でも LOD0 が `scene.pick` に出る。click ハンドラで LOD0 を除外し drillPick で実LOD1/2を拾い直す修正を入れた(LOD0 は `canonicalId` を持たず `bldg_` ではないので建物選択にはならない)。
**距離ベース tile.show 置換は既定無効に変更**(`?citylod0swap=1` で明示有効)。穴の恐れが未検証のため。
未実施: 実PLATEAU24区、速度/FPS/転送量計測、LOD1/2 との重なり実描画比較。

## 実データ(公式PLATEAU 2025)での生成・E2E(Mission 213 続行)
runner から geospatial.jp への取得が可能(ZIP Range・無料枠ガード内・追加課金なし)。`node tools/cloud/build-cloud-preview.mjs --all-wards --city-lod0 --out temp/cloud-all` を実行(24区・約13.6分・出力約1.0GB・既存ガード time38分/out6GB 内)。
- **実データ検証で発見・修正したバグ**: `footprints.json` の hull は `[lon,lat]` だが旧 `loadLod2Points` は `[lat,lon]` と誤認(合成fixtureでは検出不能)。LOD2 重心が別位置に落ち、セル数 5599/82タイルだったものが修正後 5393セル/82タイル。値域判定+判定不能は fail closed。
- 元LOD1 615,234 = 補完LOD1 604,542 + LOD2同ID除外 10,692(ID監査 doubleDrawn 0)。LOD0: 24/24区 ok・5,393セル・82タイル・GLB 3.04MB・tileset 35KB。
- 実データE2E: `node tools/cloud/e2e-city-lod0.mjs --static temp/cloud-all --lat <緯度> --lon <経度> --out r.json`(`--static` は build 出力を読み取り専用で配信。元ファイル無改変・`ext-3dtiles/index.json` の `cityLod0` が無ければ exit 3)。
  実LOD1/2 を載せた状態で、高度3000mの LOD0 寄与画素率、高度600mで LOD0 自動非表示、画面格子 pick(LOD0 pick 0)、CDP の実マウスで建物クリック→`livecity:37d-building-selected` の canonicalId 一致、cold/warm 転送量を取得する。
- 制限: SwiftShader(ソフトウェアWebGL)・localhost のため FPS/p95/所要時間は実機の値ではない。LOD0 のみの空白(区境の穴)を都市全域で網羅した検証ではない。`?citylod0swap=1` は引き続き未検証・既定OFF。
