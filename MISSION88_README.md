# Mission 88: 実ブラウザ証拠の収集器（コードのみ・データ取得/公開なし）

`tools/mission88-collect-evidence.mjs` は、Mission86 の 7 項目に対応する証拠を **ユーザー PC の Cesium ブラウザで採取**し、
`data/reports/mission86/evidence/<ward>.json` に書く。受入判定そのものは `tools/mission86-acceptance.mjs` が行う。

```
node tools/mission88-collect-evidence.mjs --ward nishi [--root temp/mission80] [--evidence dir] [--port 8188] [--check-only]
node tools/mission86-acceptance.mjs
```
終了コード: 0=採取成功 / 1=採取失敗または入力不整合 / 2=入力欠損（missing）/ 64=引数不足。

## 捏造しにくくする仕組み（署名ではなく、取り違え・無自覚な編集・環境偽装の検出）
- **origin は環境から導出**。CLI で指定できない。`CI` / `GITHUB_ACTIONS` / `RUNNER_*` があれば `ci-runner`、`--fixture` は `fixture`。
  `local-pc` 以外は受入ディレクトリでなく `evidence/non-acceptance/` に書く（Mission86 も origin≠local-pc を不合格にする）。
- 採取失敗・欠損は `evidence/failed/` に `collection.status = failed|missing` と `failedItems` を書き、非ゼロ終了。
- `tilesetSha256` は **ディスク上の tileset.json から計算**し、manifest の値と不一致なら採取しない（出力が manifest に紐付く）。
- 証拠に `executedAt`、`url`（127.0.0.1）、`collector.command`、collector スクリプトの SHA-256、source-lock / manifest / N03 の SHA-256、
  `integrity.digest`（正規化 JSON の SHA-256）を含む。Mission86 は digest 不一致・`collection.status≠ok` を不合格にする。
- 既存の証拠は上書きしない（`wx`）。入力は読み取りのみ。削除・コピー・子プロセス・外部通信なし（Google 通信は検知して記録）。

## 採取する項目
| 項目 | 採取方法 |
|---|---|
| sourceLock2025 | lockEtag を source-lock から記録（manifest と照合は Mission86） |
| coverage | 出力 attrs/ids から棟数・ID 一意性、manifest との一致。meshAccounting は `source.json` に記録がある場合のみ転記（推測しない） |
| http200 | 127.0.0.1 の読み取り専用サーバーで tileset.json / GLB の 200 を数え、区アセットの 404 を記録 |
| pixelDiff | ページの QA フック `readbackCanvas()`（scene.render 直後の WebGL canvas 読み戻し）で建物 ON/OFF を真上・斜めで比較。フックが無ければ `method` は偽らず `unsupported-page-hook`（＝不合格） |
| realClick | 高さ 30–120m の上位 3 棟。`pickId` で当たる画面点を CDP の実マウスで押し、`selectedCanonicalId` と出力 ids を照合。選択イベントの直接発火はしない |
| n03Inside | 全棟の代表点を N03 区ポリゴン（穴あり）で判定。bbox のみは使わない |
| roadWater | **常に `unverified`**（独立検証は未実装）。この項目が未実証のため、現状の収集器だけでは **accepted にならない** |

## 限界・未実施
- この回は Linux CI で無通信テストのみ。実 Chrome・実データでの採取は **未実施**（`temp/mission80` が無い）。厳格 accepted は **0 / 24** のまま。
- headless はソフトウェア描画。FPS・時間は実機値ではない。
- digest は署名ではない。悪意ある手書き偽造は防げない（レビューで origin・コマンド・ハッシュを確認する前提）。
- 道路・水域の独立検証が実装されるまで、どの区も 7/7 にならない。
- 24 区の変換・永続保存（Mission87）・PLATEAU 再配布条件・Releases 利用は未承認。今回は一切行っていない。
