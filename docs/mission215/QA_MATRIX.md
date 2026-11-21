# Mission 215 QA マトリクス(基準 SHA 719cfe3 + 本コミット)
| 項目 | 優先 | 状態 | 根拠 |
|---|---|---|---|
| 未選択時モバイル右パネル非表示 | P0 | PASS(静的CSSのみ) | tests/mission215-mobile-ux.test.js。変更前は FAIL(規則なし)。実画面は NOT_TESTED |
| 区カード/右パネル重なり | P0 | PASS(静的) / 3サイズ実測 NOT_TESTED | 同上 |
| 区選択で左パネルを閉じる | P0 | PASS(静的) | 同上 |
| Escape 段階閉じ・aria・閉じるボタン・44px | P1 | PASS(静的) / キーボード実操作 NOT_TESTED | 同上 |
| 3サイズの実ブラウザ重なり検査 | P0 | NOT_TESTED | WebGL ページの E2E は今回未実施 |
| 検索リスト矢印キー | P2 | NOT_TESTED | 未実装 |
| FPS・操作時間・初回タイル速度 | P2 | NOT_TESTED | 計測仕様のみ(PLAN.md) |
| 同一SHAで55地点PASS・Preview WebGL・24区クリック | ゲート | NOT_TESTED | 本サイクル対象外 |
