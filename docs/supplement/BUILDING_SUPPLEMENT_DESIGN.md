# 建物補完レイヤー設計（Issue #65）— 初版 2026-11-14

> 範囲: 調査・設計・差分監査CLI（fixture検証）。**本体HTML・配信設定・main・本番は未変更。** 全量公開ではない。
> 用語: 「網羅率」は使わない。真の建物総数は不明で、数値はすべて「参照データに対する照合率」。

## 1. 現行版の確定（実測 2026-11-14）
| 項目 | 結果 |
|---|---|
| 本ブランチ基点 | `main` 1ba0275（24区ビューア/LOD2/クラウド統合を**含まない**） |
| PR #24 | head `2f68db6`（Mission 37B Cesium POC, OPEN） |
| PR #50 | head `1e56866`（mission152-lod2-parallel, OPEN） |
| PR #61 | head `3a9c72e`（mission206-osaka24-cloud-direct, OPEN） |
| PR #63 | head `95057a5`（mission209 release merge review, OPEN） |
| #64 docs | `origin/claude/issue-64-20261113-1400` 読了。11/13時点で古い（クリック障害は修正済みとの最新報告。再修正しない） |
| 24区の現行配信manifest | **unknown**（統合ブランチ・配信manifest・実SHAの突合は未完。PR #61/#63 が最有力候補だが未確認） |
| private asset repo `livecity-3d-data` | この job のトークンでは **解決不能（not found / 権限なし）→ unknown**。plateau2025-converted の中身・測量年度は不明。タグ名から年度を断定しない |

## 2. 欠損原因の分類と件数
A 変換欠落 / B 配信・LOD・描画で非表示 / C 元データ未収録 / D 時点差 / E 未確認。
**24区別の「元PLATEAU / 変換済み / 配信」ユニーク建物数とID対応は今回 取得不能**（上記 asset repo と配信manifestに到達できないため）。
よって A〜D の件数は **未計測（全件 E 扱い）**。fixtureの数値を実測として載せない。
既存の監査ツール（`tools/audit/plateau-missing-audit.js`, `citywide-missing-buildings.js`, `resolved-vs-runtime-coverage.js`）は
A/B の切り分けに再利用できるが、入力（raw PLATEAU zip / canonical）がこの checkout に無い。**A/B は本体班への修正候補として報告し、別データで隠さない。**
LOD1あり・LOD2未整備は「欠落」に数えない。

## 3. ソース調査
### 3.1 Overture Maps Buildings（**実測済み**）
release `2026-10-21.0`（S3 公開, 無料, DuckDB で bbox 抽出）。小範囲（約 1.7km×1.7km, 参照用の生件数のみ。PLATEAU差分ではない）:

| 範囲 | 建物数 | height有 | num_floors有 | どちらも無 | 名称有 | 主source OSM | Microsoft ML | その他(Esri/Google等) | update_time無 |
|---|---|---|---|---|---|---|---|---|---|
| 北区(梅田) | 5,229 | 2,401 | 1,037 | 1,865 | 957 | 5,145 | 18 | 66 | 18 |
| 中央区(本町) | 6,081 | 3,463 | 989 | 1,705 | 1,099 | 5,992 | 35 | 54 | 35 |
| 住吉区 | 14,416 | 10,177 | 6,288 | 4,148 | 106 | 14,043 | 126 | 247 | 126 |

- 大阪域はほぼ OSM 由来（約96〜97%）。**OSM と Overture は独立二重証拠ではない**。`sources` を必ず保存する。
- height/階数とも無い建物が 約29〜35% → 補完採用時は高さ unknown が多い前提で設計。
- bbox は矩形近似（bbox が範囲内に収まる建物のみ）。ward 境界での抽出は未実施。
- ライセンス: Overture 建物テーマは ODbL。出典別保管のみでは義務を満たすと断定しない。要整理: ①帰属表示（OSM・Overture）②派生データベース提供時の share-alike（補完レイヤーを配信する時点で「派生DB」に該当し得る）③PLATEAU（CC BY 4.0 系・要確認）と同一ジオメトリ内で混ぜない（独立レイヤー・独立manifest・個別ON/OFFで分離）。**権利整理が済むまで公開Git/配信に入れない**（本PRに実データは含めない）。
### 3.2 国土地理院 基盤地図情報「建築物の外周線」
今回 `service.gsi.go.jp`=403、`fgd.gsi.go.jp`=到達不可（job環境）。**取得不能（ブロッカー）**。収録/更新日・閉じた外周の構築可否・利用手続は未確認。位置・形状候補のみで高さではない。既存 `tools/build-gsi-building-outline-tiles.js` / `tools/import-gsi-building-outline.js` が先行実装として存在（再利用候補）。
### 3.3 OSM 直接取得
Overpass は 406（クライアント識別要）。今回は未取得。方針: Overture反映待ちの差分・name/height/building:levels の補完のみ。node(point) の施設を建物形状として扱わない。
### 3.4 PLATEAU 新版・漏れメッシュ / 新築ランドマーク
公式の新しい版との比較は asset repo 不可のため未実施。新築ランドマークは公式情報で現況・高さ・位置形状の権利を個別確認する（未着手）。航空写真/点群差分は将来検討（初手で全市AI推定はしない）。

## 4. 差分判定仕様（実装: `tools/lib/building-supplement-diff.js`）
座標: WGS84 → `latLonToLiveCityWorld`（local-equirect, +X東/−Z北, 1unit=1m）。**建物一律移動で合わせない**。標高基準は扱わない（高さは屋根高の根拠値のみ。地盤DEMは使わない）。
指標: 交差面積/小さい方の面積（格子サンプリング近似 24×24）、包含（重心）、境界距離、複数相手（分棟/合棟）、building_part の親。
| 判定 | 条件 |
|---|---|
| MATCH_EXISTING | 小さい方比≥0.5、または包含（既存が包含/候補が包含）。複数相手は split-or-merged |
| HOLD | 部分重なり(0.15〜0.5)、距離<3m かつ面積比≥0.5（位置ずれ疑い）、面積<9㎡、縦横比>25、不正形状、親が既存に無い building_part |
| NEW_CANDIDATE | 上記に該当せず既存と重ならない |
ポリゴン切り抜きは行わない（採否のみ）。PLATEAUは維持し、建替え/解体は別変更台帳で審査（自動削除しない）。
高さ: 根拠値→`estimated:false`／階数×3.0m→`estimated:true, heightSource:"levels*3m"`／無し→`unknown`。`representation:"supplement-extrusion-not-plateau-lod"`（PLATEAU LOD1/2と称さない）。
レコード: canonicalId/source/sourceId/sourceVersion/surveyDate/acquiredAt/license/geometryConfidence/heightSource/estimated/status（+ sourceDatasets, decisionReason, matchedExistingIds）。権利不明は `candidate-hold-license`。
既存の写真・検索IDとの対応: `canonicalId=supp:{source}:{sourceId}` は PLATEAU ID と衝突しない名前空間。写真/検索側は `matchedExistingIds` で既存IDへ辿る。

## 5. 補完レイヤー接続仕様（将来統合・今回未実装）
- `public/map-data/osaka-city/supplement/manifest.json`（独立）: `{schema, version, enabled:false, license, attribution[], wards:{<ward>:{tiles:[{z,x,y,url,bytes,count}]}}}`
- 区×タイル(例 500m)分割・遅延読込（カメラ近傍タイルのみ）。`enabled:false` が既定。manifest 側フラグ1つ、またはレイヤーON/OFFで即時ロールバック（本体データ無変更）。
- 描画: 1タイル=1マージ済みメッシュ（全棟 Cesium Entity で常時読込しない）。色は既存青灰色を共有、クリックは `canonicalId`→詳細カードに `source/licence/estimated` を表示。
## 6. 容量・読込・クリック性能予算（提案）
現状比較の基準: 統合24区 942.2MiB（#64, run 43425976639）、施設40,585件。補完は **現行配信の +5% 以内（≈47MiB）**、1タイル≤300KB(gzip)、同時読込≤9タイル、初回追加ロード≤3MB、クリックは既存の空間グリッド（MISSION36K）に補完タイルを区単位で追加し、判定追加≤1ms/クリックを目標。候補件数が不明なため、実PLATEAU差分後に再見積り（**数値は目標であり未検証**）。
## 7. 次工程
1. PLATEAU canonical（または asset repo 読取権限）を job に与え、北/中央/住吉で A〜E 件数と ID対応を実測。2. 同範囲でOverture差分を本CLIで分類しレビュー例（誤検出・位置ずれ・分棟）を作成。3. GSI/OSM取得の到達性解決。4. ライセンス整理後に非公開試験。5. 24区展開。
## 8. 再現
```
/tmp venv: pip install duckdb  # 無料・Overture S3 は匿名読取
node --test tests/building-supplement-diff.test.js
node tools/audit/building-supplement-audit.js --candidates c.geojson --existing e.geojson --source overture --source-version 2026-10-21.0 --out out.json
```
