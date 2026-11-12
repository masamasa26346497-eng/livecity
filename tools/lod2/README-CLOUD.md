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
