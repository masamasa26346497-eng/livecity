# Mission 196 — PLATEAU 2025 クラウド閲覧 Preview 設計書（実装前・未デプロイ）

状態: **設計のみ。Preview URL は未発行。「表示可能」とは言えない。**
このブランチは `main` 起点であり、PR #50 のファイル（`public/mission37g-osaka-24ward-mvp.html`、
`tools/lod2/lod2-all-wards.mjs`、E2Eハーネス）は含まれない。PR #50 を上書きしないため、
実装は PR #50 ベース（`pr50` から分岐）で行う必要がある。

## 1. 依存（main に無く PR #50 にあるもの）
- 37G HTML / overlay JS / LOD2 ハーネス
- `tools/lod2/lod2-all-wards.mjs`（公式2025を1区ずつ生成）
- Mission194R `deb8dff`（旧45Dは `--allow-legacy` 以外で自動接続しない）
- 24区 LOD1 統合ランナー（Mission193, 615,234棟）

## 2. 構成案
GitHub Actions（Mission193 と同様に runner 上で一時生成）→ 生成物を `vercel deploy --prebuilt`
（Preview、`--prod` 禁止）。Git リポジトリ・Actions artifact には GML/GLB/巨大zipを置かない。
- Stage 0（最小）: 北区（梅田）+ 中央区のみ。LOD1 + LOD2（`--exclude-ids` による ID 差集合、Mission184 の機構）。
- Stage 1: 24区 615,234棟。通常は8区上限のため `?coarseMax=24` を opt-in（性能/メモリ警告を画面表示）。
- 旧LOD1/45Dへのフォールバックは禁止。`source.json` の vintage / gml source lock / version / wardID を
  ロード時に検証し、不一致なら描画せずエラー表示。
- 画面表示: 「PLATEAU 2025」、建物棟数/表示区数、LOD1/LOD2 の色分け、梅田LOD2ジャンプボタン。
- 道路との水平整合・LOD2重複は **未解消の検証課題として画面に明記**（Mission195 の結果待ち）。

## 3. 無料枠・容量（未実測）
Vercel Hobby は 1デプロイあたりのファイル数/サイズ・帯域に上限がある。24区の3D Tiles 容量は
**未実測**。Stage 0 で実測し、超過する場合は Cloudflare Pages / GitHub Pages 等の静的CDNを比較する。
実測前にデプロイしない。

## 4. ライセンス
PLATEAU は G空間情報センター/国交省の利用規約に従い出典表示が必要（画面とREADMEに表示）。
OSM 由来の地物は再配布条件（ODbL）が未確認のため配信対象から除外。
未確認ライセンスの地物は配信しない。

## 5. ChatGPT に依頼する Vercel 操作（Claude は認証情報を持たない）
1. team `masamasa26346497-5380` にプロジェクト（例 `livecity-plateau2025-preview`）を作成、**Git連携なし**。
2. Deployment Protection（Vercel Authentication）を Preview で有効化（無料で可能な範囲）。
3. 実装PR完成後、Actions で生成した `dist/` を `vercel deploy --prebuilt`（`--prod` なし）で配信。
4. 発行された Preview URL を PR にコメント。本番ドメイン・main マージは行わない。

## 6. 完了条件（E2E, headless Chrome）
梅田近景で LOD2 tileVisible>0 / triangles>0、LOD1 ON/OFF 画素差>0、旧ソース接続0、HTTP 4xx/5xx=0、
出典表示あり、24区 manifest が 615,234棟と一致。
