# Mission 85: 24 区 2025 ローカル表示の無通信 preflight

ネットワーク・変換・配信は行わない。入力は既存の `source-lock.json`（Mission79）、N03 区ポリゴン、`batch-manifest.json`、`temp/mission80/out/*` の有無のみ。

```
node tools/mission85-preflight.mjs [--root temp/mission80] [--free-gb N] [--json] [--out file.json]
```
- 区ごとの bldg/tran メッシュ数、圧縮/展開容量、必要ディスク目安（最大区の展開量 x 1.5 + 出力概算）を表示。
- **此花区 `51357341`**（住之江区にも重なる）は bldg あり・tran なしの `WARN no tran`。bldg が lock に無いメッシュは `BLOCKER` で終了コード 2（隠さない）。
- bbox に掛かるが bldg が無く tran のみのメッシュ（19 個、9 区）は `WARN tran-only` として別に表示する。建物変換では取得されない（周辺の道路データのみ）。
- 区が `artifactReady`（表示 `ARTIFACT-READY(not browser-accepted)`）になるのは、manifest が ok **かつ** そのPCに `<root>/out/<ward>-2025/tileset.json` がある場合だけ。これは変換物の準備状態であり**受入ではない**（Mission86 で改名。旧 `accepted`/`complete`）。
- 24 区すべて artifactReady で `artifactsReady=true`。`browserAccepted` は常に false。実ブラウザ受入は `tools/mission86-acceptance.mjs`（MISSION86_README.md）。
- 展開量が `mission80-batch` の既定 `--max-mb 1200` を超える区（生野・阿倍野・淀川）は、既定のままだと失敗する。`--max-mb 1400` を付ける。

## Windows (PowerShell 5.1) 起動
リポジトリのルートで。
```
node tools\mission85-preflight.mjs --free-gb 50
node tools\mission83-local-all.mjs --max-mb 1400 --max-wards 3 --deadline-min 60
```
- 取得元は source-lock 済みの公式 PLATEAU 2025 のみ（HTTP Range）。ネットワークと数十分の CPU を使うので、ここで初めて通信が発生する。
- 配信 URL: `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1`（127.0.0.1 限定）。
- 変換せず配信のみ: `node tools\mission83-local-all.mjs --serve-only`。dry-run: `--dry-run`。

## 中断・再開
- Ctrl+C で止めてよい。同じコマンドを再実行すると manifest が ok かつ出力ありの区はスキップし、未完・失敗の区は自分の `temp/mission80` 配下だけを作り直す。
- `--max-wards N` / `--deadline-min M` で1回の量を区切る。失敗した区は manifest に `failed` と理由が残り、他の区は進む。
- 生 GML・GLB は commit しない（`temp/` は gitignore）。
