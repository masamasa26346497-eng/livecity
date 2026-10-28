# Mission 45X: 区別の道路・水域が「その区で」配信・描画されるか（復旧）

**実 PC の private 45I データは読んでいない（読めない）。** 検証は合成 fixture（中央区相当）の HTTP + headless Chrome（Linux）のみ。Windows 実機の確認は未実施。

## 見つかった内部ロジックのバグ（再現して修正）
1. **単一区モードで区ベクタが描画されない。** 45K の視野カリング（`viewCull`）は、セルを GPU に載せる `vecViewSync` を `allTick`（全域 3D モード）からしか呼ばなかった。区を 1 つ選ぶ通常モードでは、`wardVec.state='ready'` と件数が出ても、セルが一度も構築されず何も描かれない。
   fixture での道路 ON/OFF 画面差: 修正前 **2 px**（描画なし）→ 修正後 **約 14,900 px**。修正は `singleCullSync()`（camera.moveEnd と mount 直後）。
2. **coverage 表示が mount に追従しない。** 以前は moveEnd と 3 秒後だけ更新され、描画後も「未配信」が残ることがあった。`vecSync()`（mount / drop）と単一区の ready で更新する。
3. index.json の `layersWards` に無い区は、`layers-report.json` を問い合わせず「未配信」にする（不要な 404 を出さない）。

## 変えていないもの
道路は幅なし中心線、水域は面+線、高さ・色・投影・clip は無変更。道路面や一律 offset/transform の追加なし。元データの再生成・上書きなし。

## 読み取り専用 CLI（オーナーの PC 用）
```powershell
node tools\mission45x-diagnose-layers.cjs --layers-root "<45I root>" [--out report.json]
```
24 区ごとに「配信なし / ok / 問題あり / report なし」と道路・水域・公園・鉄道の件数を出す。区 id・件数のみで、パス・座標・feature id は出さない。`--out` は layers root 内を拒否。ネットワーク・書き込み・再生成なし。終了コード 1 = 問題あり。

## 検証（合成 fixture）
`node tools/experiments/mission45x_ward_layers_e2e.mjs --out data/reports/mission45x/ward-layers-e2e.json`
- 単一区: 中央区 → ready(roads 22 = ファイルの feature 数) → 道路 ON/OFF で画面差 → 他区へ切替で消える → 戻すと再 mount → 解除で none。
- 全域モード: near で roads:local:22、画面差あり、coverage = 区ベクタ表示中。
- layers root なし: 状態 no-layers、画面差なし、coverage「未配信（上の件数は住吉区の束）」。
- JS 例外 0。404 は layers root なしの場面の `layers-report.json` のみ（想定内）。

`node --test tests/mission45x-ward-layers.test.cjs`
