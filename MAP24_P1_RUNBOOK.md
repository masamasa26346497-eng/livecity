# 大阪市24区化 P1 ランブック（行政区境界）

このドキュメントは「大阪市24区の地図基盤」を進めるための手順書。
特に **P1-1（N03行政区境界の取り込み）** と **P1-2（取り込み結果の自動検証）** の実行手順をまとめる。

ネットワーク接続が必要な工程は **ローカルWindows PC / GitHub Actions** で実行する
（Claude Code サンドボックスからは実行不可。CLAUDE.md「実行環境の分離」参照）。

---

## 前提と現状（2026-08-31 時点）

| 項目 | 状態 |
|---|---|
| `config/wards/registry.json` | 大阪市24区すべての id/name/code/townPrefix/datasetId を保持済み |
| `config/areas/osaka-city.json` | **本セッションで新設**。`status: "staged"`。projection原点・znorth-neg-v1 は osaka-sumiyoshi と完全一致、bbox のみ24区全域へ拡張 |
| `tools/ingest/n03-administrative-boundaries.js` | N03 GeoJSON → 24区 ward record 変換。`--area osaka-city` で znorth-neg-v1 へ座標変換可能 |
| `tools/validate/boundary-ingestion.js` | **本セッションで新設**（P1-2）。取り込み結果を自動検証 |
| 実N03データ（生 WGS84 MultiPolygon 24区分） | `temp/n03-validation/osaka-city-wards.json` に抽出済み（gitignore下）。ただし **metadata の license / referenceDate / retrievedUrl が未記録** |

**canonical source（USER_DECISION 2026-08-26）**
- 行政区外周: 国土数値情報 N03 行政区域データ 2026年版（国土交通省）
- 町丁目ポリゴン: e-Stat 令和2年国勢調査 町丁・字等境界データ（別系統）

---

## P1-1: N03 を出典付きで再取り込みする（ローカルPC）

`temp/n03-validation/osaka-city-wards.json` は出典 metadata が空なので、
**元の N03 GeoJSON（大阪府）を入力に、ライセンス・出典・基準年月日を付けて取り込み直す。**

### 1. 入力ファイルの用意

国土数値情報ダウンロードサイトから「N03 行政区域データ」の **大阪府（27）2026年版** を取得し、
GeoJSON へ変換したものを用意する（例: `data/raw/osaka-city/n03/N03-2026_27.geojson`）。
`data/raw/` は gitignore 対象なのでコミットされない。

### 2. 取り込み実行

```bash
node tools/ingest/n03-administrative-boundaries.js \
  --input data/raw/osaka-city/n03/N03-2026_27.geojson \
  --area osaka-city \
  --output data/processed/osaka-city/boundaries/administrative-boundaries.json \
  --source-name "国土数値情報 N03 行政区域データ" \
  --provider "国土交通省" \
  --license "国土数値情報 利用約款（出典明記・測量法上の注記あり）" \
  --reference-date 2026-01-01 \
  --retrieved-url "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html" \
  --retrieved-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

- `--reference-date` は取得した N03 データの基準年月日に合わせて修正する。
- `--retrieved-url` は実際のダウンロードページ URL に修正する。
- `--area osaka-city` を付けると znorth-neg-v1 座標へ変換された `rings` が出力される。
  付けない場合は生 WGS84（`raw`）のまま構造検証のみ。

期待される出力: `取り込み件数(大阪市24区分): 24` / `未取得の区: 0`。
名称・コード不一致や大阪市外Featureの誤混入があると **fail-fast で異常終了**する（推測補正しない）。

---

## P1-2: 取り込み結果を検証する

```bash
node tools/validate/boundary-ingestion.js \
  --input data/processed/osaka-city/boundaries/administrative-boundaries.json \
  --area osaka-city
# または
npm run data:validate:boundaries -- --input data/processed/osaka-city/boundaries/administrative-boundaries.json --area osaka-city
```

検証項目（error 重大度が1件でもあれば exit code 1）:

| チェック | 内容 |
|---|---|
| `all-wards-present` | registry の24区すべてが record に存在 |
| `no-duplicate-wards` / `no-unknown-wards` | wardId の重複・registry外の混入なし |
| `ward-identity-matches-registry` | 各 record の wardCode / wardName が registry と一致 |
| `geometry-present` / `rings-non-empty` | polygon parse 成功・空でない |
| `coords-finite` | NaN / Infinity 座標なし |
| `coordinate-convention-consistent` / `znorth-neg-v1-tag` | 変換済み/未変換の混在なし・規約タグ整合 |
| `rings-closed` | 生 GeoJSON リングが閉じている |
| `no-oversized-segments` | 行政界の中央値セグメント長の20倍かつ800m超の「地物を横断する辺」なし（未連結multipolygonの検出） |
| `no-self-intersections` | リングの自己交差なし（O(n²)スキャン） |
| `latlon-window` | 各区の緯度経度が大阪市の妥当な窓内（生WGS84時） |
| `known-wards-stable` | 住吉区・東住吉区・平野区が存在し、既存 osaka-sumiyoshi エリアと bbox が重なる |
| `provenance-recorded` | metadata に license / referenceDate / retrievedUrl（**WARN**。error にはしない） |

検証結果 JSON は既定で `data/reports/boundary-ingestion-validation.json` に保存される。

**実データ検証済み（2026-08-31）**: `temp/n03-validation/osaka-city-wards.json`（実N03 24区・生WGS84）は
`provenance-recorded` の WARN 以外すべて PASS。自己交差・巨大セグメントは検出されず、
N03 の行政区外周ポリゴンは幾何的に健全であることを確認済み。

---

## 検証を通過したら

1. `config/areas/osaka-city.json` の `status` を `"staged"` → `"production"` へ更新。
2. `data/processed/osaka-city/boundaries/administrative-boundaries.json` をコミット
   （24区分で数千〜1.5万頂点程度、100MB制限に対して十分小さい）。
3. 以降 P1-3（新Ward dataset生成、point-in-polygon分類）・P1-4（Ward Registry dataReady同期）へ。

---

## やってはいけないこと（AUTODEV_RULES.md 準拠）

- `config/areas/osaka-sumiyoshi.json` の破壊的変更（移行完了まで温存）
- projection 原点・znorth-neg-v1 の変更
- `public/osaka_3d_buildings.fullward-v3.html`（protected baseline）の変更
- 既存3区 TOWN_POLYGONS / legacy-unverified データの削除
- 残り21区へ「出典未確認の暫定形状」を新規追加すること（USER_DECISION 2026-08-26 で禁止）
