# Mission 86: 24 区の厳格な実ブラウザ受入判定（無通信・read-only）

`mission85-preflight` の `artifactReady`（manifest ok ＋ tileset 存在）は**変換物の準備状態**であり、受入ではない。
受入は `tools/mission86-acceptance.mjs` が、PC ローカルの実ブラウザ証拠ファイルを検証して判定する。

```
node tools/mission86-acceptance.mjs [--root temp/mission80] [--evidence data/reports/mission86/evidence] [--json] [--out file]
node tools/mission86-acceptance.mjs --template nishi      # 証拠ファイルの雛形（プレースホルダ。そのままでは不合格）
```
終了コード: 24 区すべて accepted でなければ 3。

## 7 項目（独立。全部 pass の区だけ accepted=true）
| 項目 | pass の条件 |
|---|---|
| sourceLock2025 | manifest が ok・vintage 2025・sourceEtag が source-lock と一致、証拠の lockEtag も一致 |
| coverage | manifest のメッシュ数が lock の区メッシュ数と一致、buildings=sourceBuildings、skipped/fallbacks 0、ID 一意、証拠の tilesetSha256・buildings が manifest と一致（出力に紐付く） |
| http200 | ローカル tileset がある ＋ 証拠で tileset200≥1・glb200≥1・区アセットの 404/5xx なし |
| pixelDiff | `pixel.method=webgl-readback-on-off`、真上・斜めの建物 ON/OFF 差分が両方 >0（画像のみは不可） |
| realClick | 実マウスクリックで選択され、出力 ids に存在する canonicalId が 3 件以上 |
| n03Inside | `coverage.method=n03-polygon` で建物代表点が N03 区ポリゴン内 95% 以上（bbox 判定は不可。95% は仮の基準） |
| roadWater | `roadWater.status=verified`（roadsChecked, maxOffsetM あり）。`unverified` は未検証のまま pass にしない |

状態は `pass` / `fail`（証拠が基準を満たさない）/ `missing`（証拠なし）。

## 受入にならないもの
fixture・synthetic、画像のみ、manifest のみ、2022 年データ（vintage≠2025）、6 区部分表示、runner temp / CI 由来
（origin が local-pc 以外）、127.0.0.1 以外の URL、Google 通信あり、JS エラーあり、別区の証拠、tilesetSha256 が manifest と違う証拠。

## 現状（このリポジトリ）
`data/reports/mission86/evidence/` は存在しない。**厳格 accepted = 0 / 24**。既存の `data/reports/mission81/e2e.json`（西区）は
種別・lock 紐付け・tilesetSha256・N03 ポリゴン判定・idInOutput・道路水域が無く、7 項目すべて不合格（テストで固定）。

## 証拠を作る手順（PC ローカル。ここで初めて通信・変換が発生する）
1. `node tools/mission85-preflight.mjs --free-gb 50`
2. 西区: `node tools/mission81-local-preview.mjs --ward nishi`
   24 区: `node tools/mission83-local-all.mjs --max-mb 1400 --max-wards 3 --deadline-min 60`（127.0.0.1 限定）
3. 実ブラウザ E2E（`tools/experiments/mission80_ward2025_e2e.mjs` / `mission81_launcher_e2e.mjs` が元）で、上表の形式の証拠を
   `data/reports/mission86/evidence/<ward>.json` に出力する。**この証拠を書き出す E2E の拡張（tilesetSha256 紐付け、WebGL 画素読み戻し、
   N03 ポリゴン判定、idInOutput、道路水域）は未実装。** 現在の e2e は一部項目しか出さない。
4. `node tools/mission86-acceptance.mjs`

生 GML・GLB・証拠スクリーンショットの大容量物は commit しない。24 区全件の受入が出るまで完成と呼ばない。
