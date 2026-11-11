# Mission 196B: PLATEAU 2025 クラウド Preview(静的 build output)

非本番・レビュー専用。main へマージしない。GLB/GML/zip は Git に入れない(出力は `temp/`、gitignore 済み)。

## コマンド
```
node tools/cloud/build-cloud-preview.mjs [--wards kita] [--out temp/cloud-preview/static]   # 公式 PLATEAU 2025 を Range 取得 → 変換 → 静的出力
node tools/cloud/verify-cloud-preview.cjs                                                   # 純静的サーバで全ファイル HTTP200 + headless Chrome 実測
```
Vercel: `buildCommand = node tools/cloud/build-cloud-preview.mjs` / `outputDirectory = temp/cloud-preview/static`(`vercel.json`)。

## 出力構成(ローカル serve と同じ URL。PHP/Node 常駐不要)
`/mission37g-osaka-24ward-mvp.html`(複製。localhost ゲート4箇所 + 内蔵サンプル404早期return1箇所のみ修正。元 `public/` は不変)
`/ext-3dtiles/index.json`, `/ext-3dtiles/<区>/…`(LOD1) / `/lod2-preview/…`(LOD2 + overlay.js) / `/__lod2/diag.json`(静的) / `/cloud-preview.json`(出典・版)

## 旧データ混入防止
入力は公式 PLATEAU 大阪市 2025 CityGML の HTTP Range 取得のみ。`nobuiltin=1` 既定(URL 無指定でも注入)、`public/` の旧内蔵サンプル
(mission37b/37h/38e/40j-3dtiles, map-data, osaka_3d_*.html, *.local.json)は出力に含めない(含まれていたら build 失敗)。画面左下に出典・版・帰属表示。

## 外部リソース
Cesium 1.121.1(cdn.jsdelivr.net)、GSI 淡色地図タイル(cyberjapandata.gsi.go.jp)。自前ホストはしていない(CDN 障害時は表示不可)。

## GitHub Actions
App 権限で `.github/workflows` を変更できないため、テンプレートを `tools/cloud/github-actions-cloud-preview.yml.template` に置いた(要手動で配置)。
