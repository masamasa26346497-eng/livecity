# Mission 46A: 建物↔道路 位置合わせの監査フロー（24区・ローカル非公開データ対応）

**状態: 監査ツールを追加。viewer の座標バグは確認できず、viewer・データは無変更。追跡済み公開データ（住吉区）では origin/軸/単位/高さの不整合なし。私有18区は PC で実行する CLI を準備しただけで、実データでは未検証。「位置合わせ完了」ではない。**

## 最小1コマンド（PowerShell 5.1・読み取り専用・ネットワークなし）
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission46a-align-audit.ps1 -Src "..\livecity-data-pipeline\public\map-data\osaka-city"
# 45D タイル / 45I レイヤーも照合する場合
... -TilesRoot "%LOCALAPPDATA%\LiveCity-3DTiles-Out-24" -LayersRoot "<45I root>"
```
`-Src` は `buildings/` と `roads/` を含む `osaka-city`（`...\buildings` を渡しても可）。Node のみでも: `node tools/mission46a-align-audit.cjs --src <dir> [--tiles-root] [--layers-root] [--wards a,b] [--out <新規.json>]`。
終了コード 0=不整合なし / 1=問題あり or エラー / 2=引数不正・`--out` が入力内/既存（何もしない）。

## 区ごとに検証すること
1. 元 footprint（PLATEAU 旧タイル）: 非有限座標/退化リング、重心が tile セル内か（>50m 逸脱のみ不整合）、重心が自区 N03 ポリゴン内に入る割合（<95% は origin/軸/区割り異常）、高さ sentinel/範囲外、z0≠0。
2. 道路（元 OSM）: 橋/トンネル/地下タグ別件数、道路が footprint を貫く割合（全道路 / 地上のみ）、平行移動プローブ（±15m、**報告のみ・適用しない**）。
3. 45D タイル（`--tiles-root`）: attrs の代表点が元データと一致（≤0.5m）、source.json の wardCode、tileset の変換行列を **独立に** ECEF→測地→ローカルへ戻して tile セル中心との差（≤1m）と楕円体高（≈0）。
4. 45I レイヤー（`--layers-root`）: wardCode、座標系 `znorth-neg-v1`、頂点が区 bbox+400m 内か、道路頂点が元道路頂点と 0.3m 以内で一致する割合（≥95%）。

## 限界（出力にも必ず付く）
- 道路が建物を貫く割合は位置精度の証明ではない（立体交差・高架・時期差・OSM 中心線の幅）。
- 回転・縮尺・非一様誤差は検査していない。自動で座標を動かさない。
- 「元データと段が一致」は輸送の無破損の証明であって、元データ自体の実世界との一致は証明しない。
- GLB 頂点そのものは見ない（`tools/mission45m-verify-glb-geometry.cjs`）。

## private 区の footprint の扱い（設計判断）
45Y `?gfp=1` の赤輪郭オーバーレイは、私有区の footprint をブラウザへ配信する必要があり、認証のないループバックサーバーでは同一PC上の他プロセス/ページから読まれるリスクがあるため **拡張しない**。代わりに CLI が footprint をローカルで集計し、`--serve` は **集計 JSON のみ**（`/align46a/summary.json`）を 127.0.0.1 限定・GET のみ・Host/Origin 検査つきで返す。建物 ID・座標・パスは出力に含まれない。公開配信・GitHub アップロードなし。

## 検証（この環境）
- `node --test tests/mission46a-align-audit.test.cjs` 6件: 追跡済み住吉 35,031 棟、実コンバータ出力（tileset 変換行列→セル中心差 <0.5m）、合成 45I、改ざん検知（tileset を25m動かす／45I道路を5m動かす）、読み取り専用・loopback。
- 実在データ側で viewer の座標バグは確定できなかったため viewer は変更していない（`toCart` は 37B 変換器と同一定数・同一軸）。
- Windows PowerShell 5.1・実 Chrome・私有18区の実データでは未実施。
