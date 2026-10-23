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

## 追補: キャッシュ上限・距離間引き・本体統合条件（37G/PR24は読取り調査のみ。接続は未実施）

### キャッシュ（実装済み）
- `createLoader({maxCachedWards})`。既定 **3区**（LRU）。取得・再訪のたびに最近使用へ更新し、超過分は最古から解放（`stats.evictions`）。
- `getCachedWards()`（古い順）, `releaseWard(id)`, `clearCache()`。解放した区は再訪時に再取得（inflightの重複排除は維持、失敗はキャッシュしない）。
- 解放しても、呼び出し側が `records` の参照を保持している間はGCされない。UI側は区切替時に旧配列の参照を捨てること。
- startupサンプル（1,120件）は常駐。キャッシュ対象外。

### 距離間引き（実装済み・純関数）
- `cullByDistance(records, cx, cz, {cap, ptMax, lbMax})` → `{points:[{r,d}], labels:[{r,d}], dropped}`。座標は `localX/localZ`（znorth-neg-v1、m）。座標なしは除外。
- 既定は37Kと同値: 点 12000m（飲食 3000m）、ラベル 1400m、同時点数 `POI_CAP=2500`（近い順）。
- 全24区40,585件に対しNode上で p50 ≈ 34ms / p95 ≈ 47ms（点2,500・ラベル424・間引き19,151、カメラ原点）。**毎フレーム呼ばない**。カメラ移動が止まった後、または37Kの `makeCamGate` 相当で変化時のみ呼ぶ。

### 37G（読取り調査）で確認した接続点
- 37Gの `ensureWardFacilities` は `localX/localZ` と `sourceId` で重複除去し、全件を `facExtra` に永続保持（解放なし）。`makePoiLayer.sync()` が37Kのヒステリシス（生成済みは1.25倍まで保持）付きで間引き。
- 統合時の最小変更案: (1) `facExtra` への無制限追加をやめ、ローダーのLRUで保持する区のみ `addRecs`、解放区は `removeRecs`（px/lb破棄）する。(2) 点生成は `cullByDistance` の `points` のみ、ラベルは `labels` のみ。(3) 区別ファイル由来の飲食はラベル無し（37K踏襲）。
- 建物クリックを阻害しない条件: JSON parse・間引き・点登録は1フレームに詰めず（区ロードは `await` 後に分割、点追加は数百件ずつ `requestAnimationFrame`/idle）。クリックのsidecar選択中は施設ロードを開始しない／進行中なら新規区取得を待たせる。stale結果はトークンで破棄。`fac=0/1` 対照計測は統合後に37G上で実施すること。
- 守る条件: POI上限2,500、住吉149件（37D束）既存読み込み、クリック写真・課金ガード、OSM/ODbL帰属。

### 未実施（このPRの範囲外・要統合担当）
37G上での建物クリック遅延 (2.1〜7.1秒) の原因切分け、FPS/heap比較、実機GPU計測。
