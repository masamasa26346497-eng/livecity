# Mission 38F — 24区施設情報の独立並列開発

- 依頼: Issue #40
- 実装担当: Claude Code（PRコメントで起動）
- 起点: PR #24 の固定commit `54aa42b239e0d88f12d88352eed95fa45c1177b3`
- このbranchのみ改修。PR #24 / main は編集しない。
- 施設の既存軽量データと区別フルデータから、軽量表示・検索・詳細を検証できる新規独立プレビューと共通モジュールを実装。
- 3D担当 Mission 38E と変更ファイルを共有しない。
- Google課金API・本番deploy・他PR merge禁止。

この文書はブランチとDraft PRを起こすための作業概要であり、機能実装完了を意味しません。

## 最小接続API契約（`public/mission38f-facility-fastload.js`、グローバル `Mission38FFacility` 相当）

本体37G統合は未実施。統合担当が使う最小面のみ（実装は上記ファイルが正）。

- `createLoader({baseUrl, fetchImpl, now})` → loader
  - `loadStartup()` → `{records, sampleCount, sourceRecordCount}`（**1,120件サンプル。全件ではない**）
  - `loadManifest()` → `ward-manifest.json`（24区、`wards[].{wardId,url,recordCount}`）
  - `loadWard(wardId)` → `records[]`（区別フル。キャッシュ、同一区の同時要求は1回に統合、失敗はキャッシュしない）
  - `selectWard(wardId)` / `selectSample()` → `{stale:false, records, ...}` または `{stale:true}`。**両者は同一トークンを共有**。後から発行された選択が常に勝つ
  - `cancelSelection()` 保留中の選択をすべてstale化。`currentToken()` / `isCurrent(token)`: 非同期catch側で最新判定
  - `getStats()` → `{requests, failures, startup, wardLoads}`
- `search(records, query, {category, limit})` → `{total, results}`。検索対象は**渡した配列のみ**（サンプル表示中は「初期サンプル内」、区ロード後は「その区の全件」とUIに明示すること）
- `describe(record)` → 全値が表示用文字列。欠落は `情報なし`、帰属既定は `© OpenStreetMap contributors`。**必ず `textContent` で描画**
- レコード実フィールド: `name, category, subcategory, wardName, address, phone, website, openingHours, wheelchair, source, sourceId, license, attribution, latitude, longitude`

イベント順/状態: `idle → (選択) loading → ready | error`。新しい選択発行時、旧選択は結果・エラーとも破棄（UIを更新しない）。error時は前の表示を維持し再試行可。

キャッシュ規則（現状）: 取得済み区は上限なしで保持（24区全部で JSON 約44MB 相当）。上限・解放は未実装。統合時はLRU（例: 直近3区）を推奨。

統合条件（将来）: 遠距離の点/ラベルは非表示、近接・ズームで段階表示。37K POI上限2,500、住吉149件既存読み込み、クリック写真・課金ガードを維持。40,585点を一括生成しない。
