# Mission 37I — Google 写真 API 監査（Legacy → New 移行の要否）と旧コード再利用

実施: 2026-10-13 / 無課金・Google への通信 0 / `ENABLED=false` 維持 / 本番 HTML 2 ファイル無変更

## 1. 監査方法（再現可能）

`node tools/mission37i-audit-google-photo-api.cjs` — `git grep` のみ（ネットワークなし・書き込みなし）。
対象 ref: 現 HEAD、`feature/mission-36l-building-photo-linking`、36h / 36i / 36j、`origin/main`。
Legacy パターン: `maps/api/place`, `photo_reference`, `photoreference`, `html_attributions`, `place/details/json`,
`findplacefromtext`, `place/textsearch`, `place/nearbysearch`, `PlacesService`。
（`data/` 配下は除外。.js/.mjs/.cjs/.html が対象。）

**結果: 全 ref で Legacy 一致 0 件。移行対象は 0。**
`tests/mission37i-google-photo-audit.test.cjs` が現ツリーで同じことを固定する。

## 2. 経路ごとの監査表

| 経路 | 場所 | 状態 |
|---|---|---|
| 旧 Three.js 橋渡し（Place Details + photo media） | `feature/mission-36l-…` の `public/livecity-building-photo-bridge.js` | **New 実装済**（`places.googleapis.com/v1/places/{id}`、FieldMask `id,displayName,googleMapsUri,photos`、`/media?skipHttpRedirect=true`）。`PAID_GOOGLE_PHOTOS_ENABLED=false`。**本ブランチには未取り込み** |
| オフライン照合ツール | `tools/google-places/lib/places-client.mjs`, `field-mask.mjs` | **New 実装済**（HEAD に存在） |
| 旧 UI Kit 段階実装 | 36L ブランチの `livecity-places-ui-kit.js` | 使われていない（Three.js DOM 依存。Cesium へは移植しない） |
| Cesium 版の Google 写真 | `public/mission37e-places-ui-kit.js` + 37D/37G の配線 | **New（UI Kit）設計・ロック中**。Google へのエンドポイント参照なし |
| 建物→Place ID 索引 | `public/mission37d-data/verified-google-place-ids.json` | ChIJ 形式 Place ID のみ保持。写真 URL / photo resource は未保持 |
| Wikimedia 写真（36L/37F） | 37D/37G `renderPhoto` | Google と無関係（影響なし） |
| `public/osaka_3d_buildings.ward-ux-v1.html`（本ブランチ内の旧 HTML） | New パターンの文字列のみ一致 | 変更しない |

## 3. 再利用する旧ロジックと、Cesium 側の一元化アダプタ

結論: **新規アダプタは不要。既に一元化済み。**

- 37D / 37G とも、`livecity:37d-building-selected` のリスナーは 1 つ、`PlacePhotoPanel` のインスタンスも 1 つ。
  選択 → `select(canonicalId)`、解除 → `clear()`（テストで固定）。
- 旧 36L の再利用対象は 37E で既に純粋関数／クラス化済み:

| 旧 36L の考え方 | 現在の場所 |
|---|---|
| 索引キー（canonicalId → `cg_bldg_`+id）、VERIFIED のみ採用 | `toPlaceIndexKey`, `select()` |
| 非同期競合（最後の選択だけ採用） | `_seq` による superseded 判定 |
| キャッシュ（索引は 1 回だけ取得、失敗時は再試行） | `loadIndex()` |
| 未照合時の安全な UI（前の建物の Place ID を先に捨てる） | `select()` 冒頭、`unmatched` 表示 |
| 帰属処理 | 自前で描かず `gmp-place-attribution` に委譲（`MARKUP_SPEC`） |
| 有料呼び出しのハードロック | `ENABLED=false`、`createPlaceDetailsElement` が throw |

- 旧 36L の Google 写真 URL・photo resource は「メモリ内のみ・長期保存しない」方針。Cesium 版は
  そもそも保持しない（Place ID のみ）。この方針は変えない。

## 4. SKU / 課金の再監査（通信前の判断）

- 37E の `BILLING` は `AdvancedPlaceDetailsElement (<gmp-place-details>)` ＝ Pro と記録していた。
  オーナー指摘（`gmp-place-details`=Essentials、`gmp-advanced-place-details`=Pro）と食い違う。
- **この環境では Google 公式ページを取得できず（WebFetch 未許可）、どちらが正かは未確認。**
  推測で書き換えず、`BILLING.skuVerification='unverified-possible-mixup'` を付け、
  `ACTIVATION_BLOCKERS` に「SKU/要素対応が未再監査」を追加した。確認が済むまで金額見積もりは無効とみなす。
- 確認が必要な公式ページ: places-ui-kit/overview, places-ui-kit/place-details, 価格ページ。
  どの要素が写真（`gmp-place-media`）を含めて何の SKU か、無料枠の件数も併せて記録すること。
- 引き続き: 予算アラート・ブラウザ側カウンタ・`maxInstantiations` は 100 円の強制上限ではない。

## 5. Legacy が無かったため実施しなかったこと

Legacy 形式が見つからなかったため、photo_reference / html_attributions → New 形式へのアダプタとモックテストは
作っていない（指示の「本当に Legacy を発見した箇所のみ」に従う）。将来 36L の橋渡しを取り込む場合は、
`photos[].name`（`places/{id}/photos/{ref}`）、`authorAttributions[]`（displayName / uri）、
`maxWidthPx`/`maxHeightPx` を使う New 形式のまま、`PAID_GOOGLE_PHOTOS_ENABLED=false` で移植すること。

## 6. 利用者写真投稿（将来構想のみ。今回は実装・公開しない）

- 一般住宅・戸建ての写真は、無審査で自動掲出しない（公開前に人手審査）。
- 撮影者本人の権利許諾（ライセンス選択と作者表示）を得たものだけ受け付ける。
- 位置の秘匿（住宅は番地特定につながる位置を丸める）、顔・表札・車のナンバー・窓の内部が写るものは
  ぼかしか不掲載。
- 削除申請の窓口を明示し、申請があれば速やかに非表示にする。EXIF の位置情報は公開前に除去。
- Google 画像を投稿写真や Wikimedia 写真と混在・複製しない。

## 7. 検証

- `node --test`（37I / 37E / 37D / 37G / 37H の 5 ファイル）: 66 件中 66 件 pass。
- 課金ガード QA（実 Chrome・ローカル）: `googleRequestCount=0`, `jsErrors=0`, `kitEnabled=false`,
  `rapidKeepsLatest` / `createPlaceDetailsBlocked` / `noGmpElementsInDom` / `wikimediaSlotIntact` すべて true。
- 住宅など写真のない建物・5 区表示の再クリック QA は今回は再実行していない（コード・配信は無変更）。
