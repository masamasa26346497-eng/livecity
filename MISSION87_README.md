# Mission 87: 24 区 PLATEAU 2025 変換済み成果物の GitHub Releases 保管

`tools/mission87-persist.mjs`（pack / upload / verify / status）。通常 Git には追加しない。アーカイブは `temp/mission87/`（gitignore 済み）、区別 manifest は `data/reports/mission87/storage-manifest.json`。

## 保存方法の評価
| 方法 | 容量 | 公開範囲 | 費用 | 判断 |
|---|---|---|---|---|
| 通常 Git | リポジトリ肥大（全市 約0.6GB+） | リポジトリと同じ | 0 | 不採用 |
| Releases assets | 1 ファイル 2GiB 未満、区ごと 1 asset | リポジトリの可視性に従う（公開リポジトリなら**誰でも取得可**） | 通常 0 だが帯域・容量の無料枠は未確認 | 採用候補 |
| Actions artifact | 保持期限あり | 認証必須 | 枠消費 | 永続に不向き |
| 外部ストレージ | - | - | 要契約 | 承認が必要 |

- 対象は公式大阪市 27100 / PLATEAU 2025 の建物変換物のみ。万博 27999、写真、Google 関連、秘密情報らしき名前は `inspectOut` が**拒否**する（黙って除外しない）。
- PLATEAU の利用条件は未確認。公開リポジトリへの upload は `--allow-public` が無ければ拒否する（オーナー承認事項）。

## 使い方（変換済み出力があるPCで）
```
node tools/mission87-persist.mjs pack --ward fukushima
node tools/mission87-persist.mjs upload --ward fukushima            # dry-run
node tools/mission87-persist.mjs upload --ward fukushima --execute  # private なら可。public は --allow-public も必要
node tools/mission87-persist.mjs verify --ward fukushima           # 再取得して sha256 と tar 内容を確認
node tools/mission87-persist.mjs status
```
- 再開: 同サイズの asset が既にあれば upload はスキップ。アーカイブが既にあれば pack は上書きしない。manifest は atomic 書き込み。
- `status` の `browserAccepted` は常に 0。保存と Mission86 の実ブラウザ受入は別。
