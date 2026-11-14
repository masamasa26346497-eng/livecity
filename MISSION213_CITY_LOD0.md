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
