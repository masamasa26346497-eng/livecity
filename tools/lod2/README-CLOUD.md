# LOD2 クラウドプレビュー(静的バンドル)

北区(梅田)・中央区の公式 PLATEAU 大阪2025 の LOD1(LOD2 の gml:id を除外した補完版)+ 実 LOD2 を、
**サーバ処理なしの静的ファイル**として `temp/cloud-bundle/` に作る。Vercel Preview などにそのまま置ける。
旧 45D・旧年データは一切読まない(`source.json` が vintage 2025 / wardCode 一致でない区は生成を拒否)。

## 作り方(ネットワーク必要・公式 ZIP の Range 取得のみ・認証/トークン不要)
```
node tools/mission79-run.mjs --ward kita --max-mb 1500
node tools/mission79-run.mjs --ward chuo --max-mb 1500
node tools/lod2/lod2-build-all.mjs
node tools/mission79-build-ward-2025.cjs --ward kita --jsonl temp/mission79/kita-work/kita.jsonl --out temp/mission79/kita-2025-ex --exclude-ids temp/lod2-all/manifest.json
node tools/mission79-build-ward-2025.cjs --ward chuo --jsonl temp/mission79/chuo-work/chuo.jsonl --out temp/mission79/chuo-2025-ex --exclude-ids temp/lod2-all/manifest.json
node tools/lod2/lod2-cloud-bundle.mjs --wards kita,chuo
node tools/lod2/lod2-cloud-verify.cjs      # 静的 HTTP + 非 localhost ホスト名 + headless Chrome で確認
```
出力は `temp/` のみ(gitignore)。`public/` には書かない。`BUNDLE_MANIFEST.json` に出典・ライセンス・sha256・サイズ・監査結果。

## Vercel への渡し方(Vercel 操作は別担当。このリポジトリのコードは認証情報を扱わない)
- 配信物: `temp/cloud-bundle/` の中身(約 95MB、263 ファイル)。環境変数は不要。
- 設定: Framework = Other / Build Command なし / Output Directory = バンドルのルート。`vercel.json`(GLB の MIME、noindex)同梱。
- 例(認証済みの担当環境で): `cd temp/cloud-bundle && vercel deploy`(Preview。`--prod` は付けない)。
- 公開前に人が確認すること: ① 出典表示(画面右下に同梱) ② `BUNDLE_MANIFEST.json` の `rights.confirmedByHuman` を true にする判断。

## 同梱しないもの(権利未確認 or 無関係)
駅(OSM/ODbL)・地名・施設/Google Place ID・道路縁/河川(出典未確認)・住吉サンプル。画面では「未接続」/404 になるが、建物表示には影響しない。
同梱の非 PLATEAU データは 国土数値情報 N03 の区境界 1 ファイルのみ(37G の全域3D が必須。出典明記が条件)。

## 既知の制約
- 37G の既定は「建物を表示しない」。ページを開いた後、3D 表示モードで「全域3D」を選ぶと 2 区の建物が出る(検証はこの操作を含む)。
- `/__lod2/diag.json` は静的配信に無いため、右上パネルに「診断取得できません」と出る(描画には影響しない)。
- 37G HTML の配信コピーのみ、localhost 限定ゲート 3 箇所を書き換える(`public/` の原本は無変更)。

## Mission 199: GitHub Actions -> private artifact -> (gated) Vercel Preview
PC に配信物を保存せず、runner 上で生成・監査・artifact 保存まで行う。テンプレート: `tools/lod2/cloud-workflow/lod2-cloud-preview.yml`
(Claude の GitHub App は `.github/workflows` に書けないため、人が次でコピーする: `cp tools/lod2/cloud-workflow/lod2-cloud-preview.yml .github/workflows/`)。
- 起動は手動 `workflow_dispatch` のみ(push / PR / schedule では動かない)。
- `build` ジョブ(シークレット不使用): 公式 2025 の北区・中央区を再生成 → バンドル → テスト → 静的 Chrome 検証 → 監査(`lod2-cloud-audit.mjs`: 容量 120MiB 以下、`rights.confirmedByHuman=false` 維持、秘密情報らしい文字列なし) → 非公開 artifact `lod2-cloud-bundle`(保持 3 日)。
- `deploy` ジョブ(別ジョブ): `deploy=true` かつ `rights_approved=CONFIRMED` かつ Environment `lod2-preview-approval` の必須レビュアー承認がすべて揃った時だけ動く。`vercel deploy`(Preview)のみ。`--prod` は使わない。
- `BUNDLE_MANIFEST.json` の `confirmedByHuman` はコード側では true にしない。権利の最終判断は人が `rights_approved` 入力と Environment 承認で行う。

### 人が一度だけ行う設定(値はここに書かない・ログに出さない)
1. Vercel でプロジェクトを手動作成する(ChatGPT 連携 API では 403 で作成不可だった。権限修復または手動作成が必要)。Git 連携の自動デプロイは無効にし、main の自動本番公開をしない。
2. GitHub > Settings > Environments で `lod2-preview-approval` を作り、Required reviewers を設定する。
3. 同 Environment の Secrets に `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` を登録する。
4. Actions タブ > lod2-cloud-preview > Run workflow。最初は `deploy=false` で build と artifact のみ。

### 制約(未確認を含む)
- artifact は保持 3 日。約 95MB は Actions のサイズ上限内の見込みだが、この runner からは実行していない。
- Vercel Hobby は非商用・利用上限がある。約 95MB の静的配信が通るかは未確認。
- このワークフローは未実行。ここで確認したのは YAML の静的監査テストと監査スクリプトの単体テストだけ。
- 過去の 37G Preview のデータは本バンドル(公式 2025 を再生成)とは別物として扱う。
