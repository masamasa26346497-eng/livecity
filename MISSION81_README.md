# Mission 81: PLATEAU 2025 西区を 1 コマンドで localhost 閲覧

出典: 国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5）。西区（27106）のみ。他区・本番配信は対象外。

## コマンド（repo ルート、Windows PowerShell / macOS / Linux 共通）
```
node tools/mission81-local-preview.mjs --ward nishi
```
表示された `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext=nishi25` をブラウザで開く。Ctrl+C で停止。
オプション: `--port`, `--max-mb 800`, `--min-free-gb 3`, `--no-fetch`（データが無ければ取得せず停止）, `--check-only`（検証のみ、配信しない）。

## 動作
1. `temp/mission81/out`, `temp/mission80/out`, `temp/mission79` の既存 2025 西区出力を検証（年版 2025・wardCode 27106・ids と棟数の一致・ID 重複なし・出典ホスト）し、有効なら再利用。
2. 無ければ source-lock（公式 PLATEAU 27100 2025・ETag 固定・PLATEAU サイトポリシー・出典表記）を検証 → 容量(inflated ≤ 800MB、空き容量)確認 → `mission79-run.mjs`（Range 取得・非破壊変換）。西区は取得約 29MB・展開約 599MB・変換 約数十秒。失敗時は自分の `temp/mission81` だけ削除して停止。
3. 127.0.0.1 固定で read-only 配信（GET/HEAD のみ、`/ext-3dtiles/nishi25/` 以外の ext は 404、パス走査拒否）。`--host` は受け付けない。万博 27999・未知の区・未知ライセンスは拒否。

## 実測（GitHub Actions runner、headless Chrome=ソフトウェア描画。FPS・時間は実機値ではない）
`node tools/experiments/mission81_launcher_e2e.mjs nishi`（ランチャーを子プロセスで起動し、その URL を開く）。結果 `data/reports/mission81/e2e.json`、画像は同ディレクトリ。
- 12,603 棟 / 30 tile。HUD 12,603、tileset 1 本 ready、実マウスクリック 3/3 で canonicalId 選択。
- 建物 tileset の ON/OFF で画素差分: 真上 約 25 万 px、斜め 約 56 万 px（1500×940 中）。
- サーバー側で tileset.json 200 ×1、GLB 200 ×34。404 は任意ファイルのみ（index.json / layers-report.json / favicon）。JS 例外 0、Google 通信 0。
- 建物代表点は N03 の西区 bbox 内 100%。
## 未検証
Windows 実機、道路ポリラインとの重ね描き（2025 道路レイヤー未生成）、実機 FPS、残り 23 区、Mission45B の 24 区受入（完成扱いしない）。
