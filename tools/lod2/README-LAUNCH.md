# LOD2 プレビュー 一発起動(PR #50 / ブランチ `mission152-lod2-parallel`)

## 一発コマンド(Windows PowerShell)
リポジトリのルートで:
```powershell
.\Start-LOD2-Preview.ps1
# 実行ポリシーで止まる場合:
powershell -ExecutionPolicy Bypass -File .\Start-LOD2-Preview.ps1
```
どのフォルダから呼んでも、スクリプト自身の場所をルートとして使います(`node tools/lod2/lod2-launch.mjs` でも可)。
流れ: 前提チェック → 公式 PLATEAU 大阪2025 から Range 取得(約0.6MB)で実 LOD2 41棟を生成 → 127.0.0.1 のみでサーバ起動 → HTTP200 確認 → ブラウザで正確な URL を開く。
**サーバ起動後、このウィンドウは終了しません(正常)。** 閉じる/Ctrl+C でサーバが止まり、ページも開けなくなります。ページは**このウィンドウが動いている間だけ**開けます。

オプション: `-NoOpen` `-Port 8153` `-CheckOnly` `-ExtRoot "C:\...\ext-3dtiles"`(24区 LOD1 を同一ページで見る場合。未指定だと LOD1 は出ません)。
URL: `http://localhost:8152/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1&lod2fly=1`

## PR24 のフォルダで動かしたら「ファイルがない」になる場合
PR24 のチェックアウトには LOD2 のコードがありません。**既存の作業を消さずに**別フォルダへ取得します:
```powershell
cd <今のリポジトリ>
git fetch origin mission152-lod2-parallel
git worktree add ..\livecity-lod2 origin/mission152-lod2-parallel   # 別フォルダ。今の作業・未コミット変更は無傷
cd ..\livecity-lod2
.\Start-LOD2-Preview.ps1
```
`git checkout` で今のフォルダを切り替えるより安全です(未コミット変更が衝突しません)。main へのマージは不要・禁止です。

## うまくいかないとき(切り分け)
| 症状 | 原因 | 対処 |
|---|---|---|
| 接続拒否 (ERR_CONNECTION_REFUSED) | launcher のウィンドウを閉じた/起動前 | ウィンドウが動いているか確認。再実行 |
| ポート使用中 | 8152 を別プロセスが使用 | `-Port 8153` |
| ページ 404 | 別サーバ/別フォルダで開いている | launcher が表示した URL をそのまま開く |
| 真っ白 | Cesium(CDN)の読み込み失敗等 | F12 → Network/Console。`http://localhost:8152/__lod2/diag.json` を確認 |
| 開くが LOD2 が無い | `lod2=1` が URL に無い/生成物なし | URL を確認。画面左下に赤い日本語バナーが出る場合はその理由に従う。`window.__lc152.state` |
| LOD2 は出るが LOD1 が空白 | `-ExtRoot` 未指定 | 24区タイルのフォルダを `-ExtRoot` に指定 |
| 生成に失敗 | 公式サイトへ接続不可(プロキシ等) | launcher のエラー末尾を確認 |

`/__lod2/diag.json` は生成物の存在・37G HTML の LOD2 フック有無を返します(秘密情報・絶対パスは含みません)。

## データ/コードの依存(PR24・PR51 統合に向けて)
- LOD2 データは**公式 PLATEAU 大阪2025 CityGML の再取得のみ**で作ります。PC 上の旧建物データには依存しません。
- 生成物は `temp/lod2-preview/`(gitignore)。`public/` や GitHub に 3D アセットはコミットしません。
- 37G HTML への変更は `const scene = viewer.scene;` 直後の opt-in 1ブロック(localhost かつ `?lod2=1` のみ)。PR24 と同じ位置を編集した場合のみ衝突します。ロジックは `tools/lod2/lod2-overlay.js` に隔離。
- LOD1 二重描画の解消は ClippingPolygon(実測は LOD1 タイルのある環境で要確認)。

## Mission 163: 全LOD2(大阪2025の33メッシュ・10,698棟)を表示する
```powershell
node tools/lod2/lod2-launch.mjs --all     # 公式 Range 取得(約73MB)→ 209タイルへ変換 → 127.0.0.1 サーバ → URL を表示
```
- 生成物は `temp/lod2-all/`(gitignore)。集計は `data/reports/mission163/lod2-all-report.json`(件数・sha256 のみ。GLB は含まない)。
- 全体ビューでは GLB を読みません(メッシュ単位ノードの geometricError=120)。建物に近づくとタイル単位でロード/解放されます。
- 色は頂点色のみ(テクスチャ未対応)。LOD2 の無い建物は LOD1 のままです。
