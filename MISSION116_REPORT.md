# Mission 116 — 24区 建物＋河川 統合表示: 監査レポート（第1段階）

**状態: 未完（ブロック中）。** GitHub Actions 上のリポジトリには 24区の実データが無く、描画・実ブラウザ検証は実施できていない。成功扱いにはしない。

## 実測結果（`node tools/audit/mission116-ward-water-audit.js`、結果: `data/reports/mission116/ward-water-audit.json`）

- `public/map-data/osaka-city/buildings/manifest.json` は 24区・574,213棟・1,097タイルを宣言。
- リポジトリ内に実タイルがあるのは **住吉区のみ**（53ファイル。manifest宣言は52タイル）。他23区は 0 ファイル。
- 河川・水域・道路・公園・鉄道は、リポジトリ内ファイル数がすべて 0:
  `waterways/`, `rivers-v2/`, `water-surface/`, `roads/`, `parks/`, `railways/`（`public/map-data/osaka-city/` 配下）。
  `tools/build-river-layer.js` は `waterways/tile_*.json` を入力に取るが、その入力が無い。
- `data/raw/` は存在せず、PLATEAU/OSM の元データも無い。
- 福島区の建物データ（宣言 11,159棟/25タイル）もリポジトリには無い。ユーザーが確認した福島区の表示は Windows ローカル出力によるもので、Actions からは読めない。

## 24区の検証表

| 項目 | 結果 |
|---|---|
| manifest 宣言 | 24区すべてあり |
| リポジトリ内の建物タイル | 住吉区のみ（他23区は未検証） |
| 河川・水面データ | 全区 データ無し（未検証） |
| HTTP 200 / WebGL 実ブラウザ描画 / 建物と河川の位置整合 | 全区 未実施（未検証） |

区ごとの詳細は `ward-water-audit.json` を参照。

## 未実施事項

- 区切替での建物＋河川の統合描画、座標系・高さ基準の実測、FPS測定、スクリーンショット。
- 共通座標系の確認は、既存の `znorth-neg-v1` 規約（`data/buildings/coordinate-config.json`）を維持する前提。建物のみの一律平行移動は行わない。

## Windows PowerShell で必要な作業（ユーザー側）

```powershell
cd <livecity のルート>
node tools/audit/mission116-ward-water-audit.js   # ローカルの実データでタイル数を再確認
npm run data:import -- --area osaka-city          # 水域未生成なら OSM/国土数値情報から生成（要ライセンス確認）
node tools/build-river-layer.js
node tools/build-water-surface.js
```

期待結果: 24区すべてで `tilesInRepo` がmanifest宣言と一致し、`rivers-v2/rivers.json` と `water-surface/water-surface.json` が生成される。

## 次に必要な判断

1. ローカルの建物・水域出力の場所（パス）と、取り込み方法（GitHubへ上げない前提）の指示。
2. 水域データの取得元とライセンス確認の承認。
