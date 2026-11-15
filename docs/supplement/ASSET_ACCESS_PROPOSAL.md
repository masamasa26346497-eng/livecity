# 旧補完資産（V3/V4）の取得経路提案 — CI検証とは分離

## 確認済み / 未確定
- 確認済み（ログ、ChatGPT確認）: `Using GITHUB_TOKEN from OIDC`。これは **claude-code-action の App 用トークン**。
- 未確定: `GH_TOKEN` に `LIVECITY_3D_DATA_READ_TOKEN` が渡らなかった原因（run 43722698529 の `gh release list --repo masamasa26346497-eng/livecity-3d-data` は repo 解決不可）。トークン権限不足／env の渡り方／repo 名の不一致のいずれも未特定。**秘密値は表示・探索しない。**
- 役割分離: App トークン = このrepoのPR/コメント操作。asset 読取トークン = `livecity-3d-data` の contents:read のみ。混同しない。

## 最小経路（owner 側で実施。権限変更・拒否の迂回はしない）
1. 固定 repo = `masamasa26346497-eng/livecity-3d-data`、固定 release tag（例 `plateau2025-converted`、V3/V4 生成物の tag は未確認）の **release asset 一覧のみ** 読む（`gh release view <tag> --json assets`）。
2. 住吉に必要な asset だけを `gh release download <tag> --pattern '<該当>'` で別 dir に取得し、sha256 を記録。
3. 取得物は **公開 Git に置かない**（権利未確認）。補完は `tools/supplement/build-supplement-layer.js --candidates-format world` に渡して再照合（旧採用セットを無条件採用しない）。
4. CI検証（OFFLINE_CI_PROPOSAL.md）とは別 job・別承認。テスト job には asset トークンを渡さない。

## 必要な最小承認
- asset 読取用トークン（`livecity-3d-data` contents:read のみ）が **取得ジョブの `GH_TOKEN` にだけ** 渡ること。
- 渡っているかの確認は owner が行う（値は出力しない。`gh auth status` 相当の成否のみ）。

## 現状
所在・件数とも未取得。V3/V4 生成物（`derived-v2-osmv3` / `derived-v4-final` / `data/reports/osm-fallback-v3-build.json`）は git 上に無い。
