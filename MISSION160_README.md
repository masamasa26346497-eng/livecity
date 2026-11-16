# Mission 160: 2025 西区 localhost 一発起動と受入導線

対象: Mission 79 が変換した PLATEAU 大阪 2025 西区（報告値 12,603 棟・30 tile）。**所有者 PC の実ファイルにはアクセスしていない**ため、実データでの動作は未検証。

## 所有者 PC での最小手順（Windows PowerShell 5.1, リポジトリ直下）
前提: `temp\mission79\nishi-2025\tileset.json` が既にある（Mission 79 の出力。無ければ `node tools/mission79-run.mjs --ward nishi` で作成。これは取得を伴うため本 PR では実行していない）。
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission160-nishi2025-start.ps1 -Root "temp\mission79"
```
静的監査（ファイルのみ）→ 127.0.0.1 限定の読み取り専用サーバー起動。表示される URL:
`http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?ext=nishi-2025&bw=27106&qa=1&fac=0`

別シェルで実ブラウザ受入（Chrome/Edge を CDP で起動、headless）:
```
node tools/experiments/mission160_nishi2025_browser.mjs --root temp/mission79 --shots
```
レポート: `data/reports/mission160-nishi2025/{static-audit-local,browser-local}.json`（`ownerPcAcceptance` は常に false。人が画面を見て判断する）。

## 監査項目
tileset.json / GLB の存在と glTF ヘッダ・長さ、HTTP 200 と 404 無し、detail(`tiles/`) と簡略 LOD(`lod/`) の GLB が実際に要求されたこと、区 OFF/ON の画素差分、source.json の vintage=2025 / wardCode=27106（27999 万博は拒否）/ ライセンス・出典、attrs と ids の件数・ID 一意・`bldg_` 形式、代表点が N03 西区ポリゴン内に 99% 以上、高さ sentinel 無し、実マウスクリックでの canonicalId 選択、JS 例外 0、Google 通信 0。

注: CityGML 原本は LOD1 のみ（Mission 79）。ここでの「LOD」は tileset の detail と簡略グループの別であり、CityGML LOD2 の表示ではない。

## 制限
fixture / CI の成功は所有者 PC の受入ではない。headless はソフトウェア描画で性能値にならない。24 区完成を意味しない。
