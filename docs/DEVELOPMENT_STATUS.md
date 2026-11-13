# DEVELOPMENT_STATUS — 機能別・区別の状態

語彙（これ以外は不可）: `verified` / `implemented_unverified` / `blocked` / `missing` / `unknown`
根拠にはリンク（URL）またはリポジトリ内パスを付ける。根拠のない `verified` は禁止。

## 機能別

| 機能 | 状態 | 根拠 |
|---|---|---|
| 24区の取得・組立（統合 942.2MiB, missingContent=0） | verified | https://github.com/masamasa26346497-eng/livecity/actions/runs/43425976639 |
| 北/中央 LOD2 merge | verified | https://github.com/masamasa26346497-eng/livecity/actions/runs/43425976639 |
| 実Chrome静的検証 | verified | https://github.com/masamasa26346497-eng/livecity/actions/runs/43425976639 |
| 5地点 実クリックQA | blocked | https://github.com/masamasa26346497-eng/livecity/actions/runs/43425976639 （`window.__mission37g.drillIds` undefined） |
| 公開URLへの配信 | missing | https://github.com/masamasa26346497-eng/livecity/issues/64 |
| 建物クリック性能（施設空間グリッド） | implemented_unverified | MISSION36K_IMPLEMENTATION_STATUS.md |
| 駅・地名ラベル | unknown | tests/mission14-station-label.test.js |
| 建物写真 | unknown | tests/mission35z-building-photo-preview.test.js |
| 経路検索 | unknown | docs/HANDOFF.md |
| LOD1色とLOD2色の一致 | unknown | docs/HANDOFF.md |
| 不動産機能 | missing | docs/HANDOFF.md（後回し方針） |

## 区別（24区）

統合24区のデータ組立は run 43425976639 で verified。区ごとのクリックQA・配信状態は個別に確認されておらず unknown。

| 区 | データ組立 | クリックQA | 配信 | 根拠 |
|---|---|---|---|---|
| 24区（共通） | verified | blocked | missing | https://github.com/masamasa26346497-eng/livecity/actions/runs/43425976639 |
| 区別の個別状態 | unknown | unknown | unknown | docs/HANDOFF.md |

## 更新履歴

- 2026-11-13: 初版（Mission 218）。Issue #64 本文の事実のみに基づく。この checkout で run を再確認していない。
