# Mission 141: 正規 Live City 画面で 24 区を切替（localhost・非公開）

新ビューアは作っていない。正規 `mission37g-osaka-24ward-mvp.html` の localhost 限定 `?ext45=1`（Mission 45E/82 で実装済み）に、
`tools/mission141-local-24.mjs` が「配信できる区」を渡す。

## オーナーPC（LiveCity-Preview-140）での更新と起動
```powershell
cd LiveCity-Preview-140
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
gh auth status          # private livecity-3d-data が読める gh ログインが必要（新しい Secret は不要）
node tools/mission141-local-24.mjs
```
表示された `http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1` を開き、左の「3D建物の区」で区を選ぶ。
検査のみ: `--check-only`、取得せず手元のデータだけ: `--no-fetch`、一部の区のみ: `--wards kita,chuo`。

## 区ごとのデータ元（混ぜない）
| 区 | 元 | 備考 |
|---|---|---|
| nishi | 手元の PLATEAU 2025 出力（`temp/mission81` 等。`mission81-local-preview.mjs --ward nishi` で作ったもの） | 再取得しない |
| 21 区 | private Release `livecity-3d-data` / `plateau2025-converted` の `plateau2025-<ward>.tar.gz` | あなたの `gh` ログインで読み取りのみ |
| fukushima / yodogawa | リリースに無い。手元に検証済み出力があるときだけ配信 | 無ければ「未配信」 |

## 安全
- 127.0.0.1 のみ・GET/HEAD のみ（Mission 81 サーバー再利用）。取得物は git 無視の `temp/mission141/data/` に置く。OneDrive 配下は拒否。
- アーカイブは展開前に一覧を検査（絶対パス / `..` を拒否）。既存の非空ディレクトリは上書きしない。アーカイブは展開後に削除。
- gh は `release view` / `release download` だけ。アップロード・Git への追加・公開はしない。Expo(27999) は拒否。
- 区ごとに tileset.json / ids の `bldg_*` / 区内重複なし / source.json の wardCode を検査し、通らない区は「未配信」として一覧に出す。

## 評価の分離
「配信できる区数」は変換済みデータがある区の数であり、区全域の網羅や道路・河川の有無を意味しない（道路・河川は Mission 115 の出力があるときだけ既存アダプターで接続）。
