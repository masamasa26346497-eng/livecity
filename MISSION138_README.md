# Mission 138: 既存の Live City 24区ページに実フットプリント建物と区別レイヤーを統合

## 正規の表示先は 1 つだけ
`public/mission37g-osaka-24ward-mvp.html`（ヘッダー・左の 24 区一覧・右の建物/施設パネル・写真・駅/地名・道路縁はそのまま）。
別ビューア（`mission135-ward-viewer.html` など）は使いません。PR #48 のコードは読み取って機能単位で再利用しただけで、PR #48 には何も push していません。

| 用途 | URL |
|---|---|
| 公開 PR プレビュー（従来表示。`?fp=1` は無効） | `https://livecity-git-claude-issue-23-20261007-1424-…vercel.app/mission37g-osaka-24ward-mvp.html` |
| ローカル（住吉区の実フットプリント 35,031 棟） | `node tools/mission138-serve-local.cjs` → `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?fp=1` |

`?fp=1` は **localhost / 127.0.0.1 限定**です。公開ホストでは URL に付けても何も起きず、従来の表示のままです（後方互換）。

## 使い方（住吉区だけならデータの用意は不要）
```
node tools/mission138-serve-local.cjs
# → ページ左の「3D建物の区」で住吉区を選ぶ。35,031 棟 / 52 tile が描画される（Git 管理済みの map-data から）
```
他区を足すとき（手元の非公開データ。Git・Vercel・Actions には載せない）:
```
node tools/mission138-serve-local.cjs ^
  --footprints-root <旧 buildings ディレクトリ（osaka-<ward>/manifest.json, tile_*.json を含む。private release を展開した先でよい）> ^
  --layers-root     <tools/mission135 の build-ward-layers 出力（<ward>/layers/roads|waterways|water-surface|status.json）> ^
  --ext             <3D Tiles 出力（任意。あればそちらを優先）>
```
サーバーは 127.0.0.1 のみ・GET/HEAD のみ・許可ファイル名の allowlist・symlink 拒否・Host/Origin 検査で、何も書かず、コピーも削除もしません。
private release の認証や Secret の再設定は不要です（展開済みのフォルダを指定するだけ）。

## 区ごとの建物表示の優先順位（setBuildingWard）
1. 外部変換の 3D Tiles（`?ext=` / `?ext45=1`）がある区 → 3D Tiles（従来どおり）。
2. 無ければ `?fp=1` のとき実フットプリント押出し（`public/mission138-footprints.js`）。**ただし既存の部分配信サンプル（北・中央・天王寺・西・浪速）より棟数が少ないときは置き換えない**（劣化させない）。
3. どれも無ければ従来の「3D建物未整備」表示。偽の建物は描かない。

## データ状況（正直な区別）
| 区分 | 区 | 内容 |
|---|---|---|
| 実データで描画できた（実 Chrome で確認） | 住吉区 | 実フットプリント 52 tile / 35,031 棟（canonicalId はそのまま） |
| 実 3D Tiles（従来から。一部のみ） | 北・中央・天王寺・西・浪速・住吉(9tile) | 変更なし |
| 合成 fixture で**接続機能だけ**確認 | 道路・河川・水面（住吉区の位置に置いた数本） | 実データではない。QA 専用 |
| データ未配信 | 上記以外の 18 区（フットプリント/3D Tiles とも本リポジトリに無い） | 地図・区境界のみ。「描画できた」とは扱わない |

道路・河川の実アセット（Mission115 出力）は GitHub 上にありません。手元にあれば `--layers-root` で同じ画面に出ます（`status.json` があればレイヤー有りと判定。無ければ「no-layers」で何も描かない）。
private repo `livecity-3d-data` の Release（建物 24 archive 約 289MB）は、このジョブでは取得していません（公開側に持ち込まない方針）。展開済みのフォルダがあれば `--footprints-root` で同じページから確認できます。

## 検証
- `node --test tests/mission138-footprints.test.cjs`（新規 8 件）と、既存の 37/38F/39/40/45 系テスト 427 件が、いずれも全件 pass。
- 実 Chrome（headless・ローカル・ソフトウェア描画）: `node tools/experiments/mission138_integrated_qa.mjs` → `data/reports/mission138/`。FPS は実機値ではありません。
- 既存の 39B 区選択 QA（`?fp` なし）も再実行し、従来の動作に退行がないことを確認。
