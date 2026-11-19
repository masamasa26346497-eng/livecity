# Mission213 --baseline 計測メモ(北区・実データ・headless Chromium+SwiftShader)

条件: `--wards kita --single-pass --city-lod0` の同一ビルド、固定視点(3000m/-60°、flyTo 無効化)、`--baseline`(cold: Network.clearBrowserCache、warm: about:blank 経由で再読込)。2回実行。

| run | phase | viewer起動 | 全タイル完了 | (完了−起動) | req | bytes |
|---|---|---|---|---|---|---|
| 1 | cold | 1.9s | 17.8s | 15.8s | 155 | 17.2MB |
| 1 | warm | 18.3s | 33.9s | 15.6s | 164 | 3.4MB |
| 2 | cold | 1.8s | 18.2s | 16.4s | 171 | 17.4MB |
| 2 | warm | 16.1s | 32.8s | 16.7s | 171 | 3.4MB |

## 切り分け(実測)
- 異常(warm の viewer 起動 16〜18 秒)は2回とも再現。
- リクエストのタイムスタンプ(`reqHead`/`maxGap`)では、warm は HTML・Cesium.js(jsDelivr のキャッシュ)等を 44ms までに要求した後、**次のリクエストが 15.9 秒後**。アプリのタイル取得ではなく、キャッシュ済み Cesium.js 等の読込/実行がその間止まっている。原因(ディスクキャッシュ経由の遅延か CDP/SwiftShader 側か)は**未特定**。
- 「起動→全タイル完了」の差分は cold/warm でほぼ同じ(約16s)。SwiftShader では、キャッシュで通信量が 17MB→3.4MB に減っても、この区間は短くならない(描画/選択が支配的と推測。未検証)。
- よって warm の絶対時間は**性能改善の根拠に使わない**。使えるのは bytes(cold 17MB / warm 3.4MB)とリクエスト数のみ。
- 重複リクエスト: `/ext-3dtiles/index.json` 4回、`/__lod2/diag.json` 4回ほか。キャッシュヘッダで吸収されるが未最適化。
- frame p50/p95: cold 56/77ms、warm 59/74ms(SwiftShader、実機値ではない)。
- tileFail は本モードでは測っていない(`--lod`/`--compare` の担当)。

## 24区 matrix 提案(qa-ward-matrix-proposal.yml)の適用条件(提案のまま・未適用・未実行)
- 適用: 管理者が Web UI で `.github/workflows/mission213-qa-wards.yml` を1回作成。Claude/GitHub App は workflows を編集できない。PR #68 head 限定は YAML の `if` と checkout の `head.sha` で固定済み。
- 起動: ラベル `run-mission213-wards`。再実行はラベルの付け直し。
- 想定消費: 24 job × 約3〜5分(ビルド数十秒+E2E)≒ 70〜120 runner 分。public リポジトリの標準 runner は無料、private なら分数消費(管理者が確認)。**この見積りは過去の単独区ビルド実測からの推定で、matrix 自体は未実行。**
- artifact: 集計 JSON のみ(7日)。PLATEAU 原データ・GLB・PNG は上げない。
- 欠点: 区ごと単独ビルドのため **24区一体の WebGL・区境の連続性は測れない**(それは一体ビルド+`--sweep` 側)。LOD2 を持たない区(平野区など)は単独ビルドが失敗する既知の制約がある。
- 一体用の小バッチ案: 24区ビルド出力(約1GB)は artifact にしない方針のため再利用できない。`--sweep` は start_point ラベルで 12 点ずつ分割する既存方式を、置換修正後の SHA で再実行するのが現実的。
