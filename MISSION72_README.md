# Mission 72: 同一オリジン認可プロキシ（オフライン実装・合成データのみ）

状態: **アダプターとテストのみ。デプロイ・配線・公開なし。「URLから24区が閲覧できる」状態ではない。**

## 追加物
- `tools/mission72-auth-proxy.cjs`: `createProxy({env, approval, manifest, store, sameOrigin})` → `{handle(req)}`。`toNodeHandler()` で Node/Vercel 形式にも変換可。
- `tests/mission72-auth-proxy.test.cjs`: 10件（合成データ、loopback のみ）。
- Mission70 の `validateManifest` は `layers/*` と `wardId` を持たないため触らず、プロキシ側に上位互換の検証を持たせた（署名は `C.sign` を再利用、`upload-gate.evaluate` で承認ゲートを再利用）。

## URL 契約（ビューア実コードで確認、変更なし）
`ext-3dtiles/<wardId>/{tileset,source,build-report}.json`、`tiles|lod/*.glb`、`ids|attrs/*.json`、`layers/{roads,waterways,parks,railways,labels,layers-report}.json`、`ext-3dtiles/index.json`（`?ext45`）。
`_lod0/` はプロキシ未対応（ビューアは取得失敗を無視する）。ストレージキーは `<wardCode>/<path>`。

## 安全ガード（fail-closed）
| 条件 | 結果 |
|---|---|
| `LIVECITY_CLOUD_PROXY!=='1'`、承認ゲート未達、manifest 未署名/未 published、許可トークン0件、store 未注入 | 全リクエスト 404（存在しない扱い） |
| 匿名・未知トークン | 403 |
| 区限定トークン（`<sha256>:ward1+ward2`）で他区 | 403 |
| Origin 不一致・`Sec-Fetch-Site: cross-site` | 403（CORS 許可ヘッダは一切出さない） |
| GET/HEAD 以外 | 405 |
| `..`、`%`、`\`、`//`、許可外パス/拡張子、manifest 外 | 404 |
| 破損/サイズ不一致/未存在オブジェクト | 502（配信しない） |
| store 例外 / タイムアウト(既定8s) / 64MiB超 | 502 / 504 / 413 |
| Range | 206、無効・複数・範囲外は 416（`content-range: bytes */N`） |
トークンは SHA-256 のみ設定に持ち、`timingSafeEqual` で比較。ヘッダ `Authorization: Bearer` か Cookie `lc_proxy`（Cesium の fetch 用）。

## ローカル確認
`node --test tests/mission72-auth-proxy.test.cjs`（mock store と loopback http で E2E。実データは存在しない）。

## 未達（実データ表示に必要なもの）
1. PLATEAU 利用条件・秘密情報/PII審査の承認（upload-gate は全て false のまま）。
2. R2 バケット作成・アップロード・Vercel への Function 配線（`api/` と rewrite は未作成。承認後に別途）。
3. 実 R2 クライアントの `store.get` 実装（本PRでは未実装）、トークン発行、Deployment Protection との併用方針。
4. 実PCの再監査とアップロード。
