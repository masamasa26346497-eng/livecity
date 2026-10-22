# Mission 42: 約75GB元データの移管前監査

**状態: 手順とツールの整備のみ。ユーザーPCの監査は未実施。75GB実データは一切アップロードしていない。**
GitHub Actions / Claude からユーザーPCのファイルには到達できないため、監査の実行と結果の判断はユーザー側で行う。

## 1. Git上の既存データと不足（確認結果）

確認できた範囲（この作業ブランチ = `main` と同一内容）:

| 区分 | Git上の状況 |
|---|---|
| `data/` | 約97MB（建物タイル `data/buildings/osaka-sumiyoshi/`、`manifests/`、`reports/`、`photos/*.json` の候補一覧、`processed/`） |
| `public/` | 約181MB（配信用 `map-data/`、本体HTML）。`public/map-data/osaka-city/buildings/` と `data/processed/osaka-city/buildings/` は `.gitignore` で除外（再生成前提） |
| `data/raw/` | `.gitignore` で除外。原本（PLATEAU GML、OSM、e-Stat取得物）はGitに無い |
| 出典・ライセンス記録 | `config/datasets/*.json`（8件）の `license` / `attribution` のみ。PLATEAU=CC BY 4.0/政府標準利用規約2.0、OSM=ODbL 1.0、e-Stat=規約準拠、社人研=商用可否「要確認」 |
| 既存の監査ツール | `tools/audit/plateau-source-inventory.js` など（リポジトリ内 `data/` を走査。ユーザーPCの全体は対象外） |

**確認できなかったもの（未確認と明記）**: PR #24 と「Mission 42 台帳」。このブランチ・ローカルgit履歴に該当ファイルが無く、実行環境から GitHub API（`gh`）も使えなかったため内容を確認できていない。台帳の場所（ファイル名またはPRの差分）を教えてもらえれば、§5 の取り込み時に突き合わせる。

**不足（Gitに無く、ユーザーPCにある可能性が高いもの）**: PLATEAU原本（CityGML/GML）、OSM PBF/Overpass生データ、e-Stat原本、地理院データ、写真類、およびそれらの取得日・版・取得URLの記録。Googleの出典コンテンツ（Places/写真）はGit上に存在しない（`data/photos/google-places-pilot-candidates.json` はOSM由来座標のみ）。

## 2. Windows PCでの読み取り専用監査手順

スクリプト: `tools/audit/local-data-inventory.ps1`（PowerShell 5.1+、管理者権限不要）

```powershell
# 1. このリポジトリを任意の場所にclone/ダウンロード（元データのフォルダの外）
# 2. 実行（OutDir は Root の外側。内側を指定するとエラーで停止）
powershell -NoProfile -File tools\audit\local-data-inventory.ps1 `
  -Root "D:\LiveCityData" -OutDir "C:\temp\lc-inventory"

# オプション
#  -Root "D:\A","E:\B"        複数フォルダ
#  -HashMode All              全ファイルをSHA-256（75GBでは数十分〜数時間）
#  -HashMode None             ハッシュ無し（最速。ただし重複・再現性検証は不可）
#  -ScanContent               1MB以下のテキストを走査し秘密/個人情報らしきパターンの「件数だけ」記録
```

安全設計:
- 読み取りのみ（`Get-ChildItem` / `Get-FileHash` / 小さなテキストの読み取り）。削除・移動・コピー・通信・アップロードのコマンドは含まない（テストで静的に検証）。
- 出力に**ファイル内容・一致した文字列・ファイル名は含まない**。共有用の `files.csv` のパスは `pathId`（パスのSHA-256先頭12桁）のみ。
- 実パスとの対応は `path-map.local.csv` のみ。**共有・コミット禁止**（`.gitignore` 済み）。
- 既定ハッシュは「同サイズが複数あるファイルのみ」。重複は SHA-256 一致で判定。

出力:

| ファイル | 内容 | 共有 |
|---|---|---|
| `summary.json` | 総容量、拡張子別、出典候補別、リスクフラグ件数、重複グループ・無駄容量、100MB/2GB超件数 | 可 |
| `files.csv` | `pathId, ext, sizeBytes, lastWriteUtc, sha256, sourceHint, riskFlags` | 可（内容確認の上で） |
| `path-map.local.csv` | `pathId ⇔ 実パス` | **不可** |

調査項目と判定方法:
- 容量・拡張子: 集計。
- ハッシュ・重複: SHA-256。
- 出典候補 `sourceHint`: ファイル名/パスのパターン（plateau, osm, estat, gsi, ipss, osaka-city-open, google, unknown）。**候補であり確定ではない**。
- 秘密情報リスク: ファイル名（`.env`, 鍵・証明書拡張子, credential/token 等）。`-ScanContent` 時は秘密鍵ブロック/APIキー形式/メール/電話番号の**有無のみ**。
- 個人情報リスク: ファイル名（住民, 名簿, 顧客, .pst 等）と上記内容パターン。
- 同期競合コピー（`-DESKTOP-`）、リパースポイントも `hold` フラグ。

注意: ファイル名ベースの検出は網羅的ではない。`-ScanContent` でも暗号化・バイナリ・1MB超は見ない。**監査が通っても「秘密/個人情報なし」の保証にはならない**。公開前に所有者が対象を目視確認する工程（§6 Phase 2）を必須とする。

> 実装状況: このスクリプトは作業環境（Linux）では実行できておらず、**PowerShell上での実動作は未検証**（Node側の静的テストのみ）。初回はまず小さなフォルダで試してほしい。不具合があればエラー文（パスを伏せて）を共有してください。

## 3. 再配布条件の分類（初期値）

定義: `config/transfer/license-classification.json`。判定は `blocked` / `hold` / `conditional` の3値のみ（自動承認なし）。これは法的判断ではない。

| 出典 | 初期判定 | 根拠 / 条件 |
|---|---|---|
| PLATEAU | conditional | リポジトリ記載: CC BY 4.0 / 政府標準利用規約2.0。出典表示、取得元・日付・版の記録、加工の明記。原本より派生タイルの公開を優先 |
| OSM | conditional | ODbL 1.0。© OSM contributors、派生DBはODbL（Share-Alike）、取得日記録。他データとの結合派生物は個別判断 |
| e-Stat/国勢調査 | conditional | e-Stat規約準拠（リポジトリ記載）。出典表示、加工明記。**小地域境界は別条件の可能性があり個別確認まで保留** |
| 地理院 | hold | リポジトリに条件記録なし |
| 社人研推計 | hold | リポジトリ自身が「商用利用可否は要確認」と記載 |
| 大阪市オープンデータ | hold | 条件記録なし |
| Google由来 | blocked | Maps Platform規約はキャッシュ・再配布を制限。公開対象外、ローカル保管のみ |
| 出典不明 | hold | 特定できるまで公開不可 |
| 秘密/個人情報フラグ付き | blocked | — |

複数出典に該当するファイルは最も厳しい判定を採用する。ゲートの緩和にはユーザーの明示承認と根拠URL・確認日の記録が必要。

## 4. 保存先候補・コスト・上限・配信/再現テスト

料金・上限は変動するため、**採用前に各公式ページで再確認すること**（以下は作成時点の一般的な理解で、未検証の概算を含む）。

| 候補 | 上限・特性 | コスト目安 | 向き |
|---|---|---|---|
| GitHub リポジトリ（通常git） | 50MB超で警告、100MB超でpush拒否。リポジトリは1GB未満推奨 | 無料枠内 | 小さな配信用JSON/タイル、台帳、manifest。**75GB原本は不可** |
| Git LFS | ファイルあたり上限は料金プラン依存、保存/帯域に課金 | 有料（従量） | 75GBには不向き・コスト大 |
| GitHub Releases アセット | 1ファイル2GiB未満、アセット数は多数可 | 無料 | 分割した中サイズ原本のアーカイブ（公開されるため conditional のみ） |
| Cloudflare R2 | エグレス無料、保存は従量（約$0.015/GB-月）。S3互換 | 75GBで約$1〜2/月＋操作課金 | 配信用タイルの本命候補 |
| Backblaze B2 | 保存約$6/TB-月、Cloudflare経由でエグレス無料の構成あり | 75GBで約$0.5/月 | 非公開バックアップ原本 |
| AWS S3 / GCS | 高機能・エグレス課金あり | 75GB保管＋転送で数ドル〜 | 既存利用がある場合 |

推奨構成案: ①公開してよい派生配信物（conditional かつ承認済み）→ 小さければGit、大きければ R2 + 既存 `fetch()` パス互換のURL。②原本75GB → **非公開**のバックアップ（B2等）または手元保管のみ。公開バケットに原本は置かない。

配信・再現テスト計画:
1. 移管前: 対象ファイルの SHA-256 を台帳化（`files.csv`）。
2. 移管後: 取得したファイルのSHA-256が台帳と一致することを検証（ダウンロード→照合）。
3. 再現: `npm test` と `node --test tests/html-regression.test.js` がグリーン、`data:process`系が fixture 上で同一出力であること。
4. 配信: ステージング用の別バケット/別パスでHTMLから `fetch` できること、CORSとCache-Control確認。**本番サイトは変更しない**。
5. ロールバック手順（アップロードしたオブジェクトの削除）を事前に文書化。

## 5. 監査結果の入力方法

1. ユーザーが §2 を実行。
2. `summary.json` と `files.csv` の中身を目視で確認（パス/個人情報が混入していないこと）。
3. 問題なければ、リポジトリ外で以下を実行して判定レポートを得る（Claude/CIにファイルを渡さなくても自分で完結できる）:
   ```bash
   node tools/audit/ingest-local-inventory.js --summary C:\temp\lc-inventory\summary.json --files C:\temp\lc-inventory\files.csv --out C:\temp\lc-inventory\readiness.json
   ```
   - `path-map.local.csv` を指定すると拒否される。`files.csv` に許可外の列やパスらしき値があると拒否される。
   - `--out` を省略すると `data/reports/mission42-transfer-readiness.json` に出力する（コミットするかはユーザーが判断）。
4. Claudeに共有する場合は `summary.json` と `readiness.json`（集計のみ）を、Issueコメントに貼るか別途承認した方法で共有。`files.csv` の共有は任意。

出力 `readiness.json`: 判定別（blocked/hold/conditional）の件数・容量、保存先層別、出典候補別、警告（ハッシュ未取得・内容スキャン未実施・件数不一致）。

## 6. 承認ゲート付き段階移管計画

各Phaseの前にユーザーの明示承認を必要とする。承認なしに次へ進まない。

- **Phase 0（今回）**: 手順・ツール・分類表の整備。実データ移動なし。
- **Phase 1: 監査実行（ユーザー）**: §2→§5。結果で `blocked`/`hold` の内訳を確認し、`hold` の出典を調査して台帳に根拠URL・日付を追記。
- **Phase 2: 公開候補の選定（ユーザー承認）**: `conditional` のうち、所有者が目視で秘密/個人情報なしを確認したものだけを承認リスト化。Google由来・不明・フラグ付きは対象外。
- **Phase 3: ステージング移管（小規模）**: 承認リストの最小サブセット（例: 1区分、数十MB）を非本番の保存先へ。ハッシュ照合・fetch・テストを確認。
- **Phase 4: 段階拡大**: 区分ごとに Phase 3 を繰り返す。各回で出典表示（attribution）ファイルを同梱。
- **Phase 5: 本番反映（別途承認）**: 配信用派生物のみ。`main` へのマージ・本番切替は別PRとレビュー。

## 7. 未完了事項

- PR #24 と Mission 42 台帳の内容確認（アクセス不可）。
- PowerShellスクリプトの実機（Windows）での動作確認。
- ユーザーPCの実監査、各出典の最新利用条件の公式ページでの再確認、保存先の最新料金確認。
- 本作業は実データのアップロード、main変更、本番変更、有料API実行を一切行っていない。
