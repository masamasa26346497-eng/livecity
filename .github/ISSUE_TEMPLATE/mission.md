---
name: Mission（小粒な作業単位）
about: 1 Issue = 1 ブランチ = 1 PR で進めるための Mission テンプレート
title: "Mission NN｜<目的を一言で>"
labels: ""
---

## 目的
<!-- 1〜2文。何が変わればこのMissionは完了か -->

## 対象 / 非対象
- 対象:
- 非対象（触らないもの）:

## ブランチ
- 起点: `main`（`git fetch origin main` で確認した SHA: `________`）
- 作業ブランチ: `claude/missionNN-<slug>`（1 Issue につき 1 本。他Issue/PRのブランチは使わない）

## 入力
<!-- 参照するファイル・データ・関連Issue/PR。読むだけのものと変更するものを分ける -->

## 受け入れ条件
- [ ]
- [ ]

## テスト
- [ ] `npm run test:pr`（関連テスト）
- [ ] `npm test`（全件。共通基盤・HTML・データ変更時は必須）
- [ ] ブラウザ確認（必要時: `npm run smoke:browser`。未実行なら理由を明記）

## 禁止事項
- main への直接 push / merge、自動merge、自動デプロイ
- 有料API・課金対象の通信（Google Places / Maps SDK / Photorealistic Tiles 等）、APIキーの記録・出力
- canonicalId・座標・3D Tiles・既存写真/著作権帰属・旧Three.js本番画面の変更（明示された場合を除く）
- 他のIssue/PRのブランチへの push、コメントでの別エージェント起動

## 費用
- 想定: 無課金 / 課金あり（個別承認: ______）
