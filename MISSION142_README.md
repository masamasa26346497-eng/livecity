# Mission 142: 24 区切替ランチャーの実運用化（Mission 141 の拡張。新ランチャーは作っていない）

`tools/mission141-local-24.mjs` に次を追加した。正規ページ `mission37g-osaka-24ward-mvp.html` の `?ext45=1` を使う点は変わらない。

| 追加 | 内容 |
|---|---|
| `--local fukushima=DIR,yodogawa=DIR` | リリースに無い区（福島・淀川）など、手元の既存 3D Tiles 出力を指定。コピーせず、他の区と同じ検証を通ったものだけ配信 |
| `--layers-root DIR` | Mission 115 / 45I の道路・河川出力（`DIR/<区>/layers/*.json`）を、配信できる区にだけ `/ext-3dtiles/<区>25/layers/` として配信。ファイルが無い区は何も描かない（404） |
| 欠落区の一覧 | `NOT DELIVERED (n): ...` を必ず表示 |
| Windows 対策 | tar は cwd + 相対名（`C:\` を host:path と誤解しない）／rename・rm の再試行／前回の途中で止まった `<区>-work` を自動で掃除／120 字超の `--root` に MAX_PATH 警告／未知の区 ID はエラー |

## オーナー PC（PowerShell）
```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
gh auth status
node tools\mission141-local-24.mjs --root C:\lc141 --local "fukushima=C:\...\livecity-3dtiles-out-fukushima\fukushima" --layers-root "C:\...\livecity-layers"
```
`http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1` を開き、左の「3D建物の区」で区を選ぶ。`--no-fetch`（取得なし）、`--check-only`（検査のみ）、`--wards a,b` も使える。
道路・河川の元は `node tools\mission115\layers-run.cjs build --src <旧 osaka-city map-data> --layers-root <dir>`（Mission 115。旧 OSM タイル由来）。

## 検証の区分
- **合成/repo サンプルでの実 Chrome E2E**: `node tools/experiments/mission142_switch_e2e.mjs`（結果 `data/reports/mission142/`）。repo の PLATEAU 2024 サンプル（北・中央）を 2025 名に見立てた fixture と、**合成の**道路・河川線（配線確認用。実在の道路ではない）。Windows でも 2025 実データでもない。
- 此花・西成のクリック不一致の実データ再検証は、private Release を読める既設の owner 用 Actions（Mission 130 の accept21）でのみ可能。この fixture では代替できない。
- 24 区完成は、各区の実描画・全域網羅・クリック・位置・実道路/河川の確認が揃うまで主張しない。
