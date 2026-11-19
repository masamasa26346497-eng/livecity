# Mission 37J: 旧 Live City のデータ・考え方を Cesium 版へ再利用（施設の区別ロード）

## 1. 棚卸し（旧 Three.js 版 `osaka_3d_buildings.ward-ux-v1.html` ↔ 現行 `mission37g-osaka-24ward-mvp.html`）

| 機能 | 旧版 | 現行 Cesium 版 | 実データの所在 | 判定 |
|---|---|---|---|---|
| 建物クリック → canonicalId | `selectBuilding` | あり（37B〜37H） | 3D Tiles + attrs/ids | 済 |
| 写真（Wikimedia / 36L 索引） | 36L | あり（37D/37F） | `derived/building-photo-index.json` | 済 |
| Google 写真 | 36L bridge（Places API **New**） | ロック（`ENABLED=false`） | — | 37I で監査済み。再実装しない |
| 町丁目 | `TOWN_POLYGONS` | 住吉区のみ（37D） | 住吉 104 件のみ | データ不足（他区は未整備） |
| 駅・地名ラベル | `LabelLayer` | 住吉区のみ | `mission37c-layers/*/labels.json` | データが住吉区のみ |
| **施設（学校・医療・飲食・店舗…）の表示・検索・詳細** | `FacilityDataStore`（区別 fetch） | **住吉区 149 件のみ** | `public/map-data/osaka-city/facilities/wards/*.json`（**24 区・40,585 件、git 追跡済み**） | **今回移植** |
| 人口・世帯 | `DemographicsDataStore` 等 | なし | 住吉区系のみ | データ不足 |

選定理由: 24 区分の実データが既に配信可能な形で揃っており（座標は `geoToThree` と同一の局所座標 `znorth-neg-v1`）、新しいデータ生成なしに 24 区へ効くのは施設のみ。

## 2. 移植内容（`public/mission37g-osaka-24ward-mvp.html` のみ変更）
旧版の「区単位で遅延 fetch する」考え方だけを採り、Three.js の DOM・描画は移していない。

- カメラ真下（画面中心の地表点）の区を `WardUI.hit` で判定し、高度 9km 以下のときだけ `wards/{wardId}.json` を 1 回だけ取得（1.5 秒周期、`?fac=0` で無効）。
- 既存の POI レイヤー（施設／観光スポット）へ追加。レイヤーのトグル・クリック詳細（名称・種別・住所/営業時間は「データなし」表示・出典 OSM/ODbL）・検索・周辺施設（500m）は既存コードをそのまま利用。
- 37D の住吉区束（149 件）とは `sourceId` で重複除去（149 件は全て区別ファイルに含まれることをテストで確認）。
- カテゴリ「飲食」「宿泊」を追加。区別ファイル由来の飲食店は点のみ（距離 3km 以内で表示、ラベルは生成しない。名称はクリック・検索で確認できる）。数千件のラベル生成を避けるため。
- 取得失敗時は `fail()` に記録し再試行可能（Promise キャッシュを破棄）。他機能は止まらない。
- 診断: `__mission37g.facilityWards[wardId] = { loaded, fileRecords, license }`。QA 用 `pickPoiId` を localhost + `?qa=1` のみのフックに追加。

### 適用範囲の注意
- これは「施設（POI）」であって 3D 建物ではない。3D 建物が見える区は従来どおり 5/24（一部のみ）。
- 区別ファイルは大きい（北区 4.5MB、中央区 4.1MB。最小 0.5MB）。カメラが入った区だけ取得する。圧縮配信前提で、Vercel 上の転送量は未測定。
- 施設は OSM 由来で、住所・営業時間・電話は大半が空（「データなし」と表示）。名称・属性は作っていない。

## 3. 検証
- `node --test`（37D/E/F/G/H/I/J の 9 ファイル）: **99 件中 99 pass**。新規 `tests/mission37j-ward-facilities.test.cjs` 5 件（24 区ファイルの存在・件数、sourceId 一意、座標が `geoToThree` と 1m 以内で一致、37D 束が包含される、ページ接続、課金ロック・本番 HTML 無変更）。
- 実 Chrome（headless / ローカルサーバー）`tools/experiments/mission37j_ward_facilities_qa.mjs`:
  - 北区（3D 一部配信）: 5,655 件ロード → 施設点を実クリック → 施設パネルに出典 OSM/ODbL。飲食店名の検索でヒット。
  - 鶴見区（3D 未配信）: 842 件ロード → 実クリックで施設パネル。
  - 住吉区: 区ファイル 965 件のうち 37D 束と重複しない 875 件だけ追加（重複 0）。
  - 全域ビュー起動時は区別ロード 0 件。Google 通信 0、JS 例外 0。
  - 対照として 37D 既存施設も同じ方法で pick できることを確認。
- 発見した不具合（修正済み）: `LayerRegistry.register` は定義を複製するため、元オブジェクトに `addRecs` しても点が追加されなかった。登録後の複製を保持するよう修正。
- 3D 建物クリックの回帰（`mission37h_multiward_qa.mjs`、5 区のうち 4 区×3 棟＝12 棟）: 12/12 で canonicalId・sidecar・区名が一致（Google 0 / JS 例外 0）。
  - **注意**: 1 回目の実行は、固定 900ms 待ちでは「sidecar 照合中…」のままで 12 件とも sidecar 判定が false だった。完了まで待つよう QA を直して再実行し、全件一致。照合の完了までに **2.1〜7.1 秒**かかった（`sidecarWaitMs`）。
  - この遅延が今回の施設ロード（北区 4.5MB の JSON 解析＋点生成）と headless のソフトウェア描画のどちらに由来するかは**切り分けていない**（施設ロードなし `?fac=0` の基準値は未取得。37H の QA は 900ms で通っていたので、並走負荷が悪化要因の可能性は高い）。実機での体感は未確認。次の改善候補は、区ファイルを `facilities-startup.json` 系の軽量版へ切り替えること、点生成の分割（フレーム分散）。
- headless はソフトウェア描画のため FPS は実機値ではない（約 1.5）。**性能は未計測**。スクリーンショットは基盤地図の取得ができず白地になる（ラベル文字も日本語フォント無しで豆腐）。見た目の比較（Before/After 画像）は取得できていない。

## 4. 移せなかった / 残り
- 駅・地名ラベル、町丁目、人口統計: 住吉区以外のデータが未整備のため移植せず（捏造しない）。
- 施設の名称重複・閉店等の鮮度は未検証（OSM のスナップショット 2026-10-01）。
- 区別ファイルの軽量化（座標・名称・カテゴリのみの startup 版 `facilities-startup.json` 0.9MB の活用）は次の候補。
- Google Places UI Kit は `ENABLED=false` のまま。36L の `PAID_GOOGLE_PHOTOS_ENABLED=false` も未接触。
