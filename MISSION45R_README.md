# Mission 45R: 建物表示時の gesture p95 の切り分け（P0）

**状態: 未完了。** 実 Windows Chrome・GPU では未確認。以下はソース読解と静的テストのみ。改善は未証明。

## 45N HUD の各値の意味（ソース確認）
| 表示 | 実体 |
|---|---|
| `render X fps(描画時) p95 Y ms` | `frameLog`（直近 300 **描画フレーム**）。操作中かどうかを問わず、`resetFrames` でしか空にならない。静止中の間隔も混ざる |
| `gesture p95`（10秒測定の結果 / `summary()`） | `__mission45m` の `gestureFrameMs`。**操作中（pointer 押下 / wheel 220ms / カメラ移動）のフレーム間隔だけ**、最大 600 件。「10秒測定」開始時に reset |
| `tiles vis` | 直近フレームで `tileVisible` が発火した content 付き tile 数（全 tileset 合計。毎フレーム preUpdate で clear） |
| `sets` | mount 中の Cesium3DTileset 数（LOD0 含む） |
| `GPU` | `totalMemoryUsageInBytes` の合計（tileset 分のみ） |
→ スクリーンショットの HUD 値は rolling で、gesture p95 とは別物。3 枚の比較は同条件ではない（tiles vis 0 → 36 の変化がある）。

## 同条件の 10 秒 A/B 手順
`...mission37g-osaka-24ward-mvp.html?ext45=1&perf=1&rr=0&res=fixed`
1. 区を選び、見たい視点にする → **「視点を保存」**（メモリ上のみ。URL・保存領域・Git・送信なし。リロードで消える）。
2. 構成を切替（建物 / 道路・面）→ **「視点を復元」** → 「10秒測定」→ 10 秒間、毎回同じドラッグ/ホイール。
3. 構成ごとに繰り返し、最後に「結果を1行表示」。
追加 A/B（同じ手順、URL に付ける）: `&vcdefer=1`、`&vcull=0`、`&hudmove=1`（HUD を操作中も更新＝旧挙動）、`&sseMove=32`（下記）。

## 1 行出力に増えた項目（匿名・数値のみ）
`tilesVis sets upd=平均/p95 rnd=平均/p95 dt=平均 jsShare selTiles cmds hudMs hudSkip vcdefer hudmove sseMove`
- `upd` = Cesium の preUpdate→postUpdate（tileset 選択・タイル更新の JS）
- `rnd` = preRender→postRender（描画コマンド発行の JS。GPU 完了待ちは含まない）
- `jsShare` = (upd+rnd)/dt。低い（例 30% 未満）なら JS 外（GPU・present 待ち）が支配的という**目安**。long task が無くフレームが長い場合の既存 hint と併読
- `selTiles` = tileset.statistics.selected 合計の最大、`cmds` = frameState.commandList 長の最大（選択タイル増加 → 描画コマンド増加の確認）
- `hudMs` = HUD 更新 1 回の平均 ms、`hudSkip` = 操作中に見送った回数

## 変更
- HUD（`?perf=1`）: 既定で**操作中は更新を見送る**（1 秒ごとに `performance.getEntriesByType('resource')` 全走査と tileset 集計が走っていたため）。更新 1 回の所要を計測。`?hudmove=1` で旧挙動。HUD が負荷源かは実機の `hudMs` で判断する（未測定）。
- `?sseMove=N`（**既定 OFF**、opt-in）: 操作中だけ maximumScreenSpaceError を N まで上げ、止まって 400ms で元に戻す。操作中は建物が粗くなる。建物品質・表示範囲は既定では変えない。効果は未測定。
- 通常ページ（`?perf=1` なし）の挙動は変更なし。

## 45O 地理院重ね合わせについて
コード・データは変更していない。GLB/footprint は福島区のみ一致（ご報告の max 0.0000153m）。局所差の原因（背景の描画表現・ソース時期差・屋根の視差）は未確定。恣意的な移動・再変換はしない。45Q の視差計算欄で、真上（pitch -90°）と斜めを比べて確認してください。

## 未検証
Windows 実 Chrome での p95 の主因（Cesium update / 描画コマンド数 / GPU）、HUD 自身の寄与、`sseMove`・`vcdefer` の効果。
