# 建物補完レイヤー設計（Issue #65）— 初版 2026-11-14

> 範囲: 調査・設計・差分監査CLI（fixture検証）。**本体HTML・配信設定・main・本番は未変更。** 全量公開ではない。
> 用語: 「網羅率」は使わない。真の建物総数は不明で、数値はすべて「参照データに対する照合率」。

## 1. 現行版の確定（実測 2026-11-14）
| 項目 | 結果 |
|---|---|
| 本ブランチ基点 | `main` 1ba0275（24区ビューア/LOD2/クラウド統合を**含まない**） |
| PR #24 | head `2f68db6`（Mission 37B Cesium POC, OPEN） |
| PR #50 | head `1e56866`（mission152-lod2-parallel, OPEN） |
| PR #61 | head `b56e979`（2026-11-14 再確認。初版記載の `3a9c72e` は古い。mission206-osaka24-cloud-direct, OPEN, MERGEABLE） |
| PR #63 | head `95057a5`（mission209 release merge review, OPEN） |
| #64 docs | `origin/claude/issue-64-20261113-1400` 読了。11/13時点で古い（クリック障害は修正済みとの最新報告。再修正しない） |
| 24区の現行配信manifest | **unknown**（統合ブランチ・配信manifest・実SHAの突合は未完。PR #61/#63 が最有力候補だが未確認） |
| private asset repo `livecity-3d-data` | この job のトークンでは **解決不能（not found / 権限なし）→ unknown**。plateau2025-converted の中身・測量年度は不明。タグ名から年度を断定しない |

### 1b. 第2段階: 実データ入手経路の調査結果（2026-11-14）
| 経路 | 結果 |
|---|---|
| `origin/main` の `public/map-data/osaka-city/buildings/osaka-sumiyoshi/`（tile 52件＋manifest） | **git 追跡済みの配信データ（既に公開済みのリポジトリ内）**。住吉のみ。`fp`=[x,z] world(m, znorth-neg-v1)、`id`=`bldg_<uuid>`(PLATEAU gml:id 由来と推定)、`h`。**これは「配信データ」であり元PLATEAUではない**。住吉の既存 footprint として比較に使える唯一の経路 |
| PR #61 `b56e979` の同 path（tile 520件・住吉のみ） | main と同じく住吉のみ。北/中央のタイルは git に無い |
| 北/中央（24区配信） | git に無し。private asset repo `masamasa26346497-eng/livecity-3d-data`(tag `plateau2025-converted`) にあると #64 文書は記述。本 job のトークンでは `gh repo view` が not found（権限なし）。取得 workflow は `mission127-private-read-check.yml`/`mission129-fetch-21.yml`（`LIVECITY_3D_DATA_READ_TOKEN` 等のsecret・owner限定・Claude の App は `.github/workflows` 書込不可で起動不可） |
| ネットワーク系（curl/Overture S3/GSI）、python/duckdb、`node --test`、`npm test` | 本 job の権限で**実行を拒否された**（allowedTools 不足）。第2段階の job では Overture 再取得・テスト実行ができていない |
**必要な最小権限**: ① `Bash(node --test:*)`/`Bash(npm test)` の許可（テスト実行）、② 比較対象の取得: owner が (a) `livecity-3d-data` の `contents:read`（fine-grained read-only token を本 job の secret に追加）または (b) 北/中央/住吉の小範囲タイルだけを artifact として出す workflow を `.github/workflows` に owner が配置、③ Overture 再取得用の外向き HTTPS（`overturemaps-us-west-2.s3.amazonaws.com`）許可。
**比較の位置づけ**: 住吉を `main` の配信タイルと比較する場合も「配信データとの比較」であり、PLATEAU 元データ未収録とは断定しない（A 変換欠落 / B 配信側除外 の可能性が残る）。北・中央は未入手。

## 2. 欠損原因の分類と件数
A 変換欠落 / B 配信・LOD・描画で非表示 / C 元データ未収録 / D 時点差 / E 未確認。
**24区別の「元PLATEAU / 変換済み / 配信」ユニーク建物数とID対応は今回 取得不能**（上記 asset repo と配信manifestに到達できないため）。
よって A〜D の件数は **未計測（全件 E 扱い）**。fixtureの数値を実測として載せない。
既存の監査ツール（`tools/audit/plateau-missing-audit.js`, `citywide-missing-buildings.js`, `resolved-vs-runtime-coverage.js`）は
A/B の切り分けに再利用できるが、入力（raw PLATEAU zip / canonical）がこの checkout に無い。**A/B は本体班への修正候補として報告し、別データで隠さない。**
LOD1あり・LOD2未整備は「欠落」に数えない。

## 3. ソース調査
### 3.1 Overture Maps Buildings（初版で実測。**再現条件は一部未記録**）
release `2026-10-21.0`（S3 公開, 無料, DuckDB で bbox 抽出）。小範囲（約 1.7km×1.7km, 参照用の生件数のみ。PLATEAU差分ではない）。

**再現条件（記録できた範囲と未記録の範囲）**
- release: `2026-10-21.0` / theme=`buildings` / type=`building`（`building_part` は含めない想定。初版で含めたかは未記録）
- 取得: DuckDB `httpfs`+`spatial`、`read_parquet('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/*', hive_partitioning=1)`、`WHERE bbox.xmin >= :W AND bbox.xmax <= :E AND bbox.ymin >= :S AND bbox.ymax <= :N`（建物 bbox が範囲内に**完全に収まるもののみ**。境界跨ぎは除外）
- 集計条件: height有=`height IS NOT NULL`、num_floors有=`num_floors IS NOT NULL`、どちらも無=両方 NULL、名称有=`names.primary IS NOT NULL`、source別=`sources[1].dataset`（先頭 source）、update_time無=`sources[1].update_time IS NULL`
- **bbox の W/E/S/N 実座標は初版で記録されておらず、今回（第2段階）の job ではネットワーク系コマンドが拒否され再取得できなかった。よって下表の件数は現時点で第三者が再現できない（要再取得）。** 座標を推測で書かない。再取得時に `docs/supplement/overture-queries.sql`（未作成）へ座標・実行日時・件数を記録すること。
- 本PRに実データ（parquet/GeoJSON）は含めない（権利未確認）。


| 範囲 | 建物数 | height有 | num_floors有 | どちらも無 | 名称有 | 主source OSM | Microsoft ML | その他(Esri/Google等) | update_time無 |
|---|---|---|---|---|---|---|---|---|---|
| 北区(梅田) | 5,229 | 2,401 | 1,037 | 1,865 | 957 | 5,145 | 18 | 66 | 18 |
| 中央区(本町) | 6,081 | 3,463 | 989 | 1,705 | 1,099 | 5,992 | 35 | 54 | 35 |
| 住吉区 | 14,416 | 10,177 | 6,288 | 4,148 | 106 | 14,043 | 126 | 247 | 126 |

- 大阪域はほぼ OSM 由来（約96〜97%）。**OSM と Overture は独立二重証拠ではない**。`sources` を必ず保存する。
- height/階数とも無い建物（表の「どちらも無」/建物数）: 北区 1,865/5,229 = 35.7%、中央区 1,705/6,081 = 28.0%、住吉区 4,148/14,416 = 28.8%（約28〜36%）。補完採用時は高さ unknown が多い前提で設計。
- 表の整合チェック（北区）: height有 2,401 ＋ 階数のみ有 ＋ どちらも無 1,865 = 5,229 となるはずで、階数のみ有は逆算で 963。num_floors有 1,037 は height との重複を含む。他2区も同様に再取得時に検算すること。
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
ジオメトリ: MultiPolygon/内周（中庭）を保持（polys=[polygon=[外周,内周…]]）。**交差面積は厳密計算**（辺を相手境界との交点で分割し、相手内部にある部分をグリーンの定理で積分。凹形状・内周・共線辺に対応）。格子近似は廃止。
指標: 交差面積/小さい方の面積、包含（交差/面積≥1−1e-6。**重心包含は使わない**）、境界距離（全リング）、複数相手（分棟/合棟）、building_part の親、候補同士の重複（id 順先勝ち、後続は `candidate-duplicate` で保留）。
保留に回す数値条件: 境界が相手と 1mm 未満で近接し内外が数値的に曖昧（`numerically-ambiguous-boundary`）、重なり比が閾値(0.05/0.15/0.5)の±0.001 以内（`threshold-borderline`）、自己交差/不正形状（候補は `invalid-geometry`、近傍既存が不正なら `neighbor-invalid-geometry`）。
注意: 交差面積の厳密性は「入力座標が正しい」前提。入力丸め(cm〜)・座標変換誤差・PLATEAU と他ソースの位置ずれはここで吸収されない（位置ずれ疑いは別途保留）。パート同士が重なる不正 MultiPolygon は想定外。
| 判定 | 条件 |
|---|---|
| MATCH_EXISTING | 小さい方比≥0.5、または包含（既存が包含/候補が包含）。複数相手は split-or-merged |
| HOLD | 部分重なり(0.15〜0.5)、距離<3m かつ面積比≥0.5（位置ずれ疑い）、面積<9㎡、縦横比>25、不正形状、親が既存に無い building_part |
| NEW_CANDIDATE | 上記に該当せず既存と重ならない |
ポリゴン切り抜きは行わない（採否のみ）。PLATEAUは維持し、建替え/解体は別変更台帳で審査（自動削除しない）。
高さ: **height 属性が在るだけでは実測扱いしない**。明示的に `heightEstimated:false` かつ `heightSource` 指定 → `estimated:false`（measured）／`heightEstimated:true` → `estimated:true`／素の height（Overture/OSM 等）→ 数値は保持し `estimated:null`・`heightSource:"source-height-attribute-unverified"`（未検証）／階数×3.0m → `estimated:true, heightSource:"levels*3m"`／無し → `unknown`。`heightAccuracy`（元ソースの精度情報）を保持。入力は `levels|num_floors|numFloors|building:levels` を階数として受理（Overture `num_floors` 対応）、数値文字列も解釈。集計は measured/estimated/unverified/unknown に分離。`representation:"supplement-extrusion-not-plateau-lod"`（PLATEAU LOD1/2と称さない）。
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
/tmp venv: pip install duckdb  # 無料・Overture S3 は匿名読取（§3.1 の bbox 座標は未記録→要再取得）
# 注: 第2段階 job ではテスト実行が許可されず、下記テストは作成者側で未実行。実行して結果を確認すること
node --test tests/building-supplement-diff.test.js
node tools/audit/building-supplement-audit.js --candidates c.geojson --existing e.geojson --source overture --source-version 2026-10-21.0 --out out.json
```
