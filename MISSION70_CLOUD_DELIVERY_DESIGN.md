# Mission 70 P0: 24区をURLで閲覧するためのクラウド配信 事前設計

状態: **設計と安全ゲートの準備のみ**。アップロード、ストレージ作成、Vercel設定変更、公開は一切行っていない。「URLから24区表示」は未完成。

## 1. 現状（事実）
- PC側: Mission45E `-Plan` で kind=real, 24/24区, 574,213棟 = 変換574,213棟。クラウドには実データなし。
- Vercel `livecity` Preview は SSO保護あり。阿倍野区などが「未配信」なのは変換物がGit/Previewに無いため。保護は解除しない。
- ゲート（licenceApproved / noSecretsReviewed / noPersonalDataReviewed）は全て false。`published.json` は空。
- Git上の 3D Tiles は6区の一部のみ。全区をGitに入れる方式は不可（容量）。

## 2. 配信方式の比較
料金・無料枠はオーナー提示の公式ページ（R2 pricing / Vercel Blob pricing）に基づく。**Claudeは外部GETをしておらず、金額は未検証**。契約前に最新値を確認すること。

| 観点 | A: Vercel Preview + Cloudflare R2（private bucket）+ 同一オリジン認可プロキシ | B: Vercel Blob（private store） |
|---|---|---|
| 無料枠 | Standard 10GB-month、Class A 100万、Class B 1,000万/月、egress無料（提示値） | Hobby枠あり。転送・操作は従量課金（上限値は未確認） |
| 想定容量 | 変換物は概算0.7GB規模（約1.2KB/棟、住吉実測からの外挿）。実値は監査コマンドで確定 | 同左 |
| 読み取り量 | 3Dタイル数千〜数万オブジェクト。Class B（GET）で消費。区単位遅延ロードで抑制 | 取得ごとの課金/転送量課金。Preview利用で転送が嵩む懸念 |
| アクセス制御 | bucketは非公開。Vercel Function（同一オリジン）が認可後に読む。bucket URLは公開しない | private storeはトークン経由の読み取り。取得経路をFunction経由にする必要 |
| Range / Content-Type | 契約モジュールが 206/416、`model/gltf-binary`、`application/json` を検証済み（合成） | 同左を実機確認要 |
| 認証負荷 | Function起動＋R2読取。Hobbyの関数実行/帯域上限は未確認 | 同左 |
| 更新/ロールバック | manifest version と署名で切替。旧版オブジェクトを保持して戻す | 同様 |
| 主な依存 | Cloudflareアカウント、R2、Vercel環境変数（secret） | Vercelストア作成、トークン |
| 推奨度 | **第一候補（無料枠が最も余裕、egress無料）** | 第二候補（運用先が1つで済む） |

### 認可の注意
- **Vercel SSO（Preview保護）とAPI認可は別物**。ブラウザがPreviewにログインできても、`/ext-3dtiles/*` を返すFunctionが自前で認可しなければ保護にならない。`handle()` 契約は authz 注入が無ければ全拒否（404）、不許可は403、とした。
- SSOとFunctionが同じ検証をするかは未確定。実装前にVercelのprotection bypass/ヘッダの扱いを確認すること（回避はしない）。
- bucket直URL・署名URLの長期発行はしない。CORSは許可しない（同一オリジンのみ）。キャッシュは `private`。
- 匿名GET=403/404、許可者GET=200 を受入基準にする（§6）。

## 3. 範囲の分離
- 初回の将来公開対象は **建物3D Tilesのみ**（PLATEAU）。道路・河川・公園・鉄道（OSM, ODbL派生DB義務・帰属）は別審査段階に分離する案を推奨。`upload-gate` は `scope=buildings-3dtiles-only` 以外を拒否。
- PLATEAU: FAQ上は原則商用可のオープンライセンスだが、大阪市2024の固有条件・帰属要件を確認するまで承認しない。

## 4. オフライン監査（PC上で実行、読み取りのみ）
```powershell
node tools\mission70-audit-offline.cjs --src "<legacy buildings dir>" --out-root "<45D root>" --json
```
- 既存45Eの `plan()`（45D証明をディスクから再計算）を再利用。再変換・再アップロード不要。
- 出力は匿名集計のみ: 区は番号表示、総バイト・ファイル数・サイズ分布・拡張子/MIME・tileset参照切れ・ids/attrs整合（個数）・非許可ファイル種別・秘密/個人パス様パターンの件数・source.jsonのライセンス記載有無。パス、座標、ID、名称は出さない。
- 書込み・削除・通信なし（テストで検査）。ゲートは監査結果から自動で true にならない（人の判断）。
- 出力の `technicalBlockers` が空でも `uploadAllowed:false` のまま。

## 5. 受信側の最小契約（実装済み・デフォルト無効・合成fixtureのみ）
- `tools/mission70-cloud-contract.cjs`: manifest schema（区別 counts/bytes/sha256/path/published/version、HMAC署名）、tileset参照検証、`handle()`（fail closed、GET/HEAD、Range、Content-Type、同一オリジン、sha不一致は502で配信しない）。
- ビューア(37G)・published.json・vercel.json は未変更。ストレージURL/秘密はコードに無い（テストで検査）。

## 6. 初回データ移行 手順（未承認・実行不可）
`tools/mission70-upload-gate.cjs` は**通信コードも資格情報の読取もなく、アップロードできない**。許可判定とドライラン計画のみ。
承認ファイルで全て true が必要: licenceApproved / noSecretsReviewed / noPersonalDataReviewed / costApproved / storageProviderApproved / ownerApprovedUpload、加えて月額上限（円）、転送バイト上限、provider（cloudflare-r2 | vercel-blob）、scope、`--execute` 時は `LIVECITY_UPLOAD_CONFIRM` の一致。
設計:
1. 区単位・64MB程度のバッチ。ハッシュ照合済みはスキップ（中断再開）。
2. 転送バイト上限に達したら停止（`stoppedByCap`）。上限超過分は送らない。
3. アップロード後に manifest（署名付き）を最後に公開。manifest無しは不可視＝部分状態が見えない。
4. ロールバック: manifest version を戻す。オブジェクト削除は別承認。
5. 無駄な課金防止: 1区で試験→匿名403/許可200確認→残り区。予算アラートは事後通知で強制上限ではない点に留意。

## 7. 受入判定表（承認・URL作成後に全て満たして初めて「URLから24区表示完成」）
- [ ] 24区すべてで、非ローカルHTTPSの tileset.json / GLB が許可者に200
- [ ] 悪意ある匿名GET（bucket直URL含む）が403/404
- [ ] 24区それぞれ WebGL描画のpixel diff（ローカル描画との比較）
- [ ] 各区で建物クリック→canonicalId一致
- [ ] ロード遅延（区選択→初回表示）を実測、区切替で前区を解放
- [ ] 予算上限超過時の停止手段を実証
- [ ] 漏洩防止（secret混入なし、署名URL/トークンが公開コードに無い）
- [ ] ライセンス表記・帰属を画面に表示
現時点は全て未達。

## 8. 未確定条件
Vercel Blob/R2の最新料金、Hobbyの関数帯域・実行上限、SSOとFunction認可の連携方法、PLATEAU大阪市2024固有条件、実データのバイト総量（監査で確定）、WebGL24区描画の実機確認。

## 9. オーナーが次回一度だけ行う確認
1. PCで §4 の監査コマンドを実行し、出力JSONを貼る（パスなし・匿名）。
2. 保存先（R2 か Blob か）と月額上限（円）の方針を一言で決める。
アップロードの依頼はしない。
