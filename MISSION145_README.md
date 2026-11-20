# Mission 145: 24区の駅名・地名・施設名（正規画面 `mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1`）

新しいビューアは作らず、37G ページにレイヤーを足した。

| 機能 | データ | 状態 |
|---|---|---|
| 駅（24区・247 マーカー） | `public/mission145-data/stations-24.json`（OSM 駅 node/way 299 件を同名 450m 以内で統合） | 表示・クリック・検索 動作。**運営会社は未取得**（下記） |
| 運営会社 | `node tools/mission145-build-stations.cjs --src <旧 map-data/osaka-city> [--osm-raw <railways-osm.json>] --force` | 路線データがあるときだけ解決 |
| 町名・町丁目名（住吉区以外 23 区） | `public/mission145-data/towns-24.json`（**未生成**） | 表示コードは実装済み。入力の小地域 GeoJSON が必要 |
| 住吉区の町丁目 | 37D の実装（境界つき）をそのまま使用 | 変更なし |
| 施設・店舗・公共（24区） | `map-data/osaka-city/facilities/wards/*.json`（OSM, 40,585 件）。37J/38F の遅延ロード | 既存。パネルに「営業状況は未確認」を追記 |

## 駅の運営会社の決め方（推測しない）
1. OSM `operator` タグ → 2. OSM `network` タグ（根拠表示に「運営会社そのものではない可能性」と出す）→ 3. 駅から 220m 以内を通る路線の OSM 名に事業者名が含まれる場合（「近くの路線名から判定」）。
決まらなければ「不明」、路線データを渡していなければ「未取得」。乗換駅は 1 マーカーに複数事業者を並べる。

## ローカルで運営会社を出す（PC 側の再設定は不要）
`node tools/mission141-local-24.mjs --root C:\lc141` は旧 OSM データ（`..\livecity-data-pipeline\public\map-data\osaka-city`）を自動検出し、
`public/mission145-data/stations-24.local.json`（gitignore、新規ファイルのみ）を作る。ページは localhost でこれを優先する。`--no-stations` で無効、`--force-stations` で再生成。

## 町名・町丁目（24区）の生成
```
node tools/mission145-build-towns.cjs --input <e-Stat/CODH 小地域 GeoJSON> [--force]
```
KEY_CODE 先頭 5 桁が 24 区の区コードに一致する単位だけを出力する（入力に無い町は作らない）。ラベル位置は「ポリゴン内で縁から最も遠い点」で、建物中心や bbox 中心ではない。境界線は再配布しない（ラベル点のみ）。
表示: 高度 >4500m 区名のみ / 1800–4500m 町名（最大40） / ≤1800m 町丁目名（最大48）。重なりは画面空間で回避。カメラ真下の区（最大3区）だけ生成し、離れると破棄。ラベルは pick 対象外（建物・施設のクリックと競合しない）。

## ライセンス・帰属
- 駅・施設: © OpenStreetMap contributors, ODbL 1.0（帰属をパネルに表示。派生データを公開する場合は ODbL の継承条件に従うこと）。
- 町丁目: 総務省統計局 e-Stat / CODH Geoshape, CC BY 4.0。
- 本ミッションはローカル QA のみ。公開デプロイ・Google 等の有料 API は使っていない。
