# ASSET_REGISTRY — 資産台帳

> secret の値・トークンは記載禁止（secret **名**のみ可）。再取得・再生成の前に必ずここで既存資産を確認する。

## 1. 外部資産（private data repo）

| 項目 | 値 | 根拠 |
|---|---|---|
| asset repo | `masamasa26346497-eng/livecity-3d-data`（private） | `.github/workflows/mission129-fetch-21.yml` の `DATA_REPO` |
| release tag | `plateau2025-converted` | 同 `TAG` |
| 読み取り用 secret 名 | `LIVECITY_3D_DATA_READ_TOKEN`（値は記載しない） | 同 workflow |
| manifest | 個別の場所は unknown（release 内 asset か要確認） | — |
| data 年度 | PLATEAU 2025 系（tag 名より）。詳細は unknown | tag 名 |
| 統合24区サイズ | 942.2MiB / missingContent=0 | Actions run 43425976639（Issue #64） |
| 権利状態 | unknown（PLATEAU 等の利用条件の確認はオーナー事前承認事項） | — |

## 2. 対象24区（`config/wards/registry.json` が唯一のソース）

kita, miyakojima, fukushima, konohana, chuo, nishi, minato, taisho, tennoji, naniwa, nishiyodogawa, yodogawa, higashiyodogawa, higashinari, ikuno, asahi, joto, tsurumi, abeno, suminoe, sumiyoshi, higashisumiyoshi, hirano, nishinari

| 区 | id | 備考 |
|---|---|---|
| 24区 | 上記24 id | `config/areas/osaka-city.json`（24区エリア）。`osaka-sumiyoshi.json` は住吉区系3区の旧エリアで、24区版で置き換えない |

台帳の24区列挙は `config/wards/registry.json` と一致しなければならない（`tools/validate/handoff-docs.js` が検査）。

## 3. リポジトリ内の主要資産の所在

| 資産 | 場所 | 状態 |
|---|---|---|
| Live City 本体HTML | `public/osaka_3d_buildings.html`（production）、`public/osaka_3d_buildings.ward-ux-v1.html`（dev UI） | 実在を確認 |
| 配信データ | `public/map-data/` | 実在を確認（中身の網羅性は unknown） |
| 施設データ | 40,585 records / 24 ward shards | `MISSION36K_IMPLEMENTATION_STATUS.md` |
| 境界（N03） | `data/processed/osaka-city/boundaries/administrative-boundaries.json` | `config/areas/osaka-city.json` statusNote |
| 経緯ログ | `MAP24_PROGRESS.md`, `MISSION*_REPORT.md` | 実在 |
| 取得 workflow | `.github/workflows/mission129-fetch-21.yml` ほか | 実在（読み取り専用・アップロードなし） |

## 4. ソースの根拠・ライセンス（`config/areas/osaka-city.json`）

- N03: 国土数値情報の利用約款（出典明記）
- OSM: ODbL 1.0
- e-Stat: 政府標準利用規約2.0
- PLATEAU: 利用条件は unknown（要確認）

## 5. 再利用ルール

- 取得済みの24区データがある場合は再取得しない。まず上記 release を確認する。
- 24区版を2区スタンドアロンに置き換えない。
- 台帳の更新は追記。過去の記述は消さず、変更時は証拠リンクを付ける。
