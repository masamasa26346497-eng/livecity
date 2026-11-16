# Mission 45I: 24区の道路・鉄道・河川・公園・名称レイヤー（PC のみで生成・localhost で配信）

## 何が入ったか（コードのみ。実データでの生成・描画は未実施）
| 部品 | ファイル | 役割 |
|---|---|---|
| ビルダー | `tools/mission45i-build-layers-24.cjs` | 旧 Live City の OSM タイル（40G と同じ読み取り器）から、24 区それぞれの `layers/{roads,waterways,parks,railways,labels,layers-report}.json` を **別の private ルート**に新規生成。`coverage.json` に区ごとの段階を出す |
| 配信 | `tools/mission45e-preview.cjs` `--layers-root` / `.ps1 -LayersRoot` | マーカー付きルートの既知 6 ファイルだけを 127.0.0.1 で読み取り専用配信。`index.json` の `layersWards` で区を通知 |
| 計画 | `public/mission45i-vec.js` | 全域 3D モードで「どの区を・どの詳細度で」常駐させるか（最大 4 区。近景=全 tier、中景=major+mid、遠景=major のみ）。DOM 非依存 |
| ビューア | `public/mission37g-osaka-24ward-mvp.html` | 建物 mount と独立した `vecTick`。世代 token、離脱/詳細度変更で destroy、JSON キャッシュ解放、住吉区の 9 tile 束との二重線回避 |

## 安全装置
- 出力ルートは Git/Vercel の外、OneDrive 外、旧ソースと別、**45D ルートの中には書かない**（マーカー `.livecity-45i-layers.json` が必須）。既存の区の `layers/` は上書きせずスキップ。
- 旧ソースは読むだけ。ネットワーク通信・外部サービス・Google は使わない。
- 名前は旧タイルの OSM `name` のみ（道路・鉄道を区ごとに最大 600/200 件）。**推測で補完しない。**

## 24区の段階表（builder の `coverage.json`）
`sourceAvailable` → `generated` はビルダーが出す。`served` / `browserRendered` はビルダーでは分からず常に `false`。ページ側は `__mission37g.stats.vec45i`（mounted / ticks / mountsTotal / dropsTotal）で実描画の状態を見る。

## 住吉区の扱い
- 既存の 9 tile 束（約 2.1km 四方）は無変更。区ベクタは**道路と鉄道だけ**を、束の `manifest.json` の `bboxLocal` の外側に限定して描く（二重線なし）。
- 束の外側の公園・河川面は区ベクタに含めない（束と重なるため）。未対応として残る。

## 町名・町丁目・駅名（未対応の範囲）
- 町丁目の名称と統計は `mission37d-data/sumiyoshi-towns.json`（住吉区 104 件）だけ。**他 23 区の町丁目は元データ（e-Stat 町丁目名称と公式境界）がこのリポジトリにないため、今回は作っていない。**境界の捏造もしない。
- 駅名・地名ラベルの 24 区化も、名称付きの正規ソースが手元にないため未実施。今回の検索対象に増えたのは、旧タイルに `name` がある道路・鉄道のみ（地図上のラベルは出さず、検索→移動のみ）。
- 次の入力が揃えば拡張できる: e-Stat の町丁目名称（区別）、公式の町丁目境界 polygon、駅の名称付き座標。

## Windows での実行（オーナー操作・承認後）
```powershell
# 1) 生成（読み取り専用入力。まず -Plan 相当の確認は --plan）
node tools\mission45i-build-layers-24.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --layers-root "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24" --plan
node tools\mission45i-build-layers-24.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --layers-root "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24"
# 2) 既存の 45E プレビューに接続（従来の一行起動は -LayersRoot なしでそのまま動く）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission45e-preview.ps1 -LayersRoot "$env:LOCALAPPDATA\LiveCity-MapLayers-Out-24"
```
表示 URL は `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext45=1`。`?vec=0` でベクタを無効化して A/B 比較できる。

## 未検証
実 PC の旧 OSM タイルでの生成件数、24 区の WebGL 描画、FPS・heap、道路と建物の位置合わせ（40G の `--check-only` が使える）は、この環境では確認できない。
