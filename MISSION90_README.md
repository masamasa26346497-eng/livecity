# Mission 90: PC 用ワンコマンド検証オーケストレーター（コードのみ・未実機）

`tools/mission90-pc-verify.mjs` は既存ツールを順に同期実行するだけ（再実装なし）:
mission85-preflight(計画) -> mission80-batch(不足区を1区ずつ変換) -> mission88-collect-evidence(区ごと実Chrome採取) -> mission86-acceptance(受入一覧)。

## Windows PowerShell 5.1（リポジトリのルート）
```
node tools\mission90-pc-verify.mjs --free-gb 100
node tools\mission90-pc-verify.mjs --execute --max-download-mb 1200 --deadline-min 180 --free-gb 100 --max-mb 1400 --wards nishi
node tools\mission90-pc-verify.mjs --execute --max-download-mb 1200 --deadline-min 180 --free-gb 100 --max-mb 1400
```
- 既定は plan-only（通信・変換・採取・書込なし）。計画に外部アクセス先、保存先、取得量見込み、必要空き容量を表示する。
- `--execute` は `--max-download-mb` と `--deadline-min` の明示が必須。取得見込み超過、空き容量不足/不明、bldg欠落、CI/runner環境は実行を拒否。
- 状態は `data/reports/mission90/run-state.json`。失敗区は理由を残して次へ進む。再実行で変換済み・採取済みをスキップ。
- 中断: Ctrl+C、または `data/reports/mission90/STOP` を作成。
- 最終: `data/reports/mission90/acceptance.json`（mission86 の判定そのもの）。全24区厳格受入でなければ終了コード3。
- 閲覧: `node tools\mission83-local-all.mjs --serve-only` -> `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1`

## 限界
- Linux CI では plan-only と単体テストのみ。Windows実機・実Chrome・実取得は未実施。厳格受入 0/24、GitHub永続保存 0/24 のまま。
- roadWater は mission86 の条件のまま（本工程は緩和しない）。分析は PR コメント参照。
