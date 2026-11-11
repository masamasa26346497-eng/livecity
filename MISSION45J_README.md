# Mission 45J — 道路と建物の位置ずれ診断 + ベクタ描画の高速化

状態: コードとテストのみ。**Windows 実機の Chrome / 実データでは未確認**（Actions から実 PC の原本にはアクセスできない）。

## 1. 位置ずれ（回転）— コードから分かったこと / 分からないこと
| 経路 | 規約 | 根拠 |
|---|---|---|
| 建物 GLB | `lon = CLON + x/(cos(CLAT)·MPD)`, `lat = CLAT − z/MPD` → WGS84 ECEF → タイル中心 ENU → glTF `[E, U, −N]` | `tools/mission37b-build-3dtiles.cjs` |
| ビューア道路 | 同じ式の `toCart` | `public/mission37g-osaka-24ward-mvp.html` `PROJ` |
| 旧 OSM タイル | `config/areas/osaka-city.json` の projection（同一原点・同一 MPD）で変換し z を反転 | `tools/build-city-layer-tiles.js` |

- 3 経路の式は一致する。`tests/mission45j-align.test.cjs` で、24 区すべての代表点について GLB 経路と `toCart` 経路の ECEF 差が 1 mm 未満であることを確認した（合成点。住吉以外・遠方区を含む）。
- **旧タイルの manifest に投影原点 / metersPerDegree は記録されていない**（`coordinateConvention: znorth-neg-v1` の宣言だけ）。以前の 45I 生成器はこの宣言を確認せず、出力に同じ文字列を固定で書いていた。つまり「原点違い・軸違いの旧タイルがあっても気付けない」状態だった。
- 実データの原因（回転か、原点ずれか、旧タイルの混在か）は、**この環境では確定できない**。確定には下の診断をオーナー PC で実行する必要がある。回転の角度は 4 クラスタ以上で一致しない限り断定しない設計にした。

### 追加した検証
- `tools/lib/mission45j-align.cjs`
  - `validateSourceManifest`: 規約・座標系・bbox の桁（±60km 超は単位/原点違いを疑う）・layerBounds の整合。投影原点が未記録である旨を notes に残す。
  - `probeConvention`: 道路頂点が N03 区ポリゴンに入る割合を、8 通りの軸/符号（二面体）で比較。`identity-confirmed` / `alternative-fits-better` / `inconclusive`。
  - `yawScan`: 建物代表点を ±3° 回して最近の道路までの距離中央値を比較。1 km クラスタ 4 つ以上で ±0.1° 以内に揃い、改善 15% 超のときだけ「検出」。
- `tools/mission45i-build-layers-24.cjs`: 生成前に上記 manifest 検証 + N03 突合を行い、合致しなければ `convention-mismatch` として**何も書かない**。出力の `coordinateConvention` は manifest の値。`layers-report.json` に `alignmentEvidence` を残す。
- `tools/mission45j-align-check.cjs`（読み取り専用・何も書かない）: オーナー PC 用の診断。
- ビューア `?align=1`: 描画に使った道路頂点が N03 区ポリゴンに入る割合などを `__mission37g.stats.vec45i.align[wardCode]` に出す。

### オーナー PC での診断（Windows PowerShell 5.1、何も書き込まない）
```powershell
node tools\mission45j-align-check.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --ward fukushima --ext "..\livecity-3dtiles-out-fukushima" --yaw
```
見る項目: `manifest.ok` / `probe.verdict`（`identity-confirmed` なら軸・符号違いではない）/ `nearest.p50`（建物から最近の道路まで。都市なら通常は数十 m 以内）/ `yaw.conclusion`。
`alternative-fits-better` や、`yaw.rotationDetected: true` かつ `estimatedDeg` が出た場合のみ、変換の補正が客観的に正当化される。その場合も補正は生成器の 1 か所に限り、**既存の 45I private root は変更せず、別の root（v2）に作り直す**（オーナー承認が必要）。

## 2. 高速化（道路を消さずに）
| 問題（コードから） | 変更 |
|---|---|
| detail 変更（near/mid/far）のたびに区を全 destroy → 再 fetch → 再 parse → 再 clip | tier 別 primitive（`roads:major/mid/local`, `waterways`, `parks`, `railways`）に分け、**粗くする方向は show/hide のみ、細かくする方向は不足キーだけ追加**（`vecRelevel`）。再 fetch・再 clip なし |
| 全頂点を区ポリゴンで厳密 point-in-ring | セル（64 m）前計算で内/外/境界に分類し、境界セルだけ厳密判定（`LC45I.makeInsideTester`）。結果は厳密判定と同一 |
| 区ポリゴン clip を読み込みのたびに実行 | 生成器が区ポリゴンで 1 回だけ clip し、`clipped: "ward-polygon"` をファイルに記録。ビューアはその場合 clip を省く（既存 45I の root は従来どおりビューアで clip） |
| 長い構築が main thread を占有 | 約 12 ms ごとに `setTimeout 0` で譲り、古い要求なら打ち切る |
| カメラ操作中にも構築 | 操作中は新規構築を保留（`deferredMoving`）、停止後 450 ms で再計画。1 tick に構築するのは 1 区まで |

- 計測の出し口: `__mission37g.stats.vec45i` の `clipMs, convertMs, polylines, vertices, yields, layerFetches, layerFetchMs, builtKeysTotal, relevelsTotal, reuseTotal, deferredMoving, pipExact, pipFast, prebuiltClip`。
- `?ext45=1&vec=0` で新ベクタを止めた基準と、同じ操作で比較できる。
- Node 計測（`node tools/mission45j-bench-clip.cjs 60000`、合成点・24 区・各 6 万点）: 区内判定は旧 約 3.6 秒 → 新 約 0.6 秒（約 6 倍）、**24 区すべてで結果一致**。これは Node の CPU 時間で、ブラウザの FPS ではない。

## 3. 未確認
- 実機ブラウザでの FPS・p95・位置ずれの有無（Windows Chrome WebGL）。
- 実データで `probe` / `yaw` がどう出るか。
- `makeAreaLayer`（河川・公園の PolygonGeometry）は未変更。重い場合は `vec` の near だけで生成される。
- 既存 45I private root のファイルは再生成していない（`clipped` ヘッダなし = 従来どおりビューアで clip）。

## 追記: 45D 出力の位置ずれ診断は `--out-root` を使う（実機未確認）

`--ext` は旧形式（`<ext>/<ward>/attrs`）専用で、45D の実レイアウト（`pc23/<ward>-aN/attrs`、住吉は `sumiyoshi-aN/sumiyoshi/attrs`）では建物点 0 件になります。
45D 出力には `--out-root` を使います。45E `plan()` が 45D ルートを原本から再検証（24/24、棟数一致）し、検証済みの区ディレクトリだけを読みます。
`--src` は旧 OSM ルート（`buildings/` と `roads/` を含む `osaka-city`）のままです。何も書きません。console は集計値のみ。

```powershell
node tools\mission45j-align-check.cjs --src "..\livecity-data-pipeline\public\map-data\osaka-city" --ward fukushima --out-root "$env:LOCALAPPDATA\LiveCity-3DTiles-Out-24" --yaw
```

- 45D ルートが検証できない／区がない場合は、パスを含まないエラーで終了します。
- 建物点が 0 件のときは成功扱いにせず、警告を出して終了コード 4 になります（`--ext` でも同様）。
- 上記コマンドの Windows 実機での動作は未確認です（合成 fixture のテスト `tests/mission45j-align-outroot.test.cjs` のみ）。
- 45D の検証に時間がかかる場合があります（原本から再計算するため）。

### `--plan`（45I 既存 private root）の表示最適化と v2 root 再生成の違い
- 既存 private root の `clipped` 未収載は、ビューア側の表示最適化（fast clip）で緩和できる範囲があります。
- ビルド時の事前 clip の恩恵は、v2 root を再生成した場合のみです。再生成には PC での変換が必要で、ここでは実施していません。
- 実機での位置ずれの原因は不明のままです。診断結果（probe / nearest / yaw）を見るまで断定しません。
