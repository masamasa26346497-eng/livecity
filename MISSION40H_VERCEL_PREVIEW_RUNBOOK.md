# Mission 40H: Vercel クリックだけプレビュー（調査と設計）

## 調査結果（リポジトリ内、実測）
- `vercel.json` / `.vercel/` / `.vercelignore` は **これまで存在しなかった**。以前のプレビューは Vercel のゼロ設定（GitHub 連携、Root Directory 未指定）で動いていたとみられる。
- PR #24 の Vercel bot コメントに、プロジェクト `livecity`（team_v2H8CFSuLuIv3LcPy0wcUdIL）の Preview 記録がある。URL:
  `https://livecity-git-claude-issue-23-20261-827d43-masamasa26346497-5380.vercel.app/`
  最終記録は 2026-10-18 06:32 UTC（Ready）。
- Claude 側の連携アカウントでプロジェクトが 0 件だったのは、オーナーの Vercel チームと別のアカウント/権限を見ている可能性が高い（未確認）。既存プロジェクトは Vercel 画面の `masamasa26346497-5380` チームで確認できるはず。再利用が最短。
- 配信対象: Git 管理下の `public/` は約 224MB（`map-data` 104MB、`mission37h-3dtiles` 24MB、`mission37b-3dtiles` 11MB ほか）。Hobby プランの静的ファイル/デプロイ上限は未確認（Vercel 公式で要確認）。
- `public/map-data/osaka-city/` は `.gitignore` 対象（強制追加された一部のみ配信される）。道路・河川・福島区建物はそこに無いため Preview には出ない。
- 福島区 3D Tiles（約 13.3MB、25 tile・11,159 棟）はオーナー PC のみ。ビューアの `?ext=` は **localhost 限定**（40F）なので Vercel では動かない。

## 今回の変更（デプロイなし）
- `vercel.json` を追加: `/` を 37G ページへ一時リダイレクト、3D Tiles/データ系ディレクトリにキャッシュヘッダ。ビルド設定・環境変数・外部通信なし。
- 既存コード・データ・main は変更していない。

## クリックだけで見る方法（最小操作）
1. **既存プロジェクトを再利用（推奨・追加費用なし）**: PR #24 の Vercel bot コメントの Preview リンクをクリックする。ログインを求められる場合は Deployment Protection が有効（Settings → Deployment Protection、変更はオーナー判断）。
2. 福島区を公開 Preview に出す場合はオーナー承認が必要（下記）。承認まで何も公開しない。

## 福島区を公開 Preview に載せる選択肢（未実施・承認待ち）
| 案 | 内容 | 費用 | 注意 |
|---|---|---|---|
| A | 福島区出力 13.3MB を `public/` に commit | 0 円 | リポジトリ肥大。PLATEAU 利用条件の確認が未了。公開データになる |
| B | Vercel Blob / 外部ストレージ | 無料枠は未確認 | 新規サービス・公開 URL 発生。承認必須 |
| C | 公開しない（localhost のみ、現状） | 0 円 | クリックだけでは見られない |

案 A の場合は、`?ext=` の localhost 限定は残したまま、同一オリジンの tileset を `EXTRA_SET_DEFS` に追加する実装が別途必要。

## 承認してほしいこと
1. 既存 `livecity` プロジェクトの再利用。
2. 福島区の公開可否と案 A/B/C の選択。
3. PLATEAU 利用条件の確認（未了）。
