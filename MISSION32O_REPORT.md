# MISSION 32O — REBUILD OSM BUILDING FALLBACK AGAINST CORRECTED V2

**判定: `OSM_FALLBACK_V2_REBUILD_SUCCESS`**（validator PASS・error 0）

- V2 PLATEAU（574,112 棟）は 1 件も変えていない。
- V1 と V2（旧 OSM）の出力は残してある。production への昇格はしていない。development HTML の既定も V1 のまま。

| | 棟数 |
|---|---|
| PLATEAU（V2 corrected） | **574,112**（feature・属性とも V2 と完全一致） |
| 旧 OSM fallback（V1 基準で選定） | 41,505 |
| **新 OSM fallback（V2 PLATEAU 基準で再選定）** | **26,652** |
| **新 total** | **600,764**（旧 615,617。減少はエラー扱いにしない §10） |

---

## 1. 旧選定ルール（§2・実コードから確認）

旧ルールは `tools/build-osm-building-fallback.js` と `tools/lib/osm-building-fallback.js`（Mission 21B/29）にある。

| 観点 | 旧ルール |
|---|---|
| 基準 | V1 PLATEAU（`public/map-data/osaka-city/buildings/<ward>/` の `fp`）。つまり回転していた位置 |
| 場所（bbox/grid） | **hole**: 50 m セルとその 8 近傍に PLATEAU footprint が無い。**sparse-mismatch**: 100 m セルで OSM 面積 ≥ 2.5 × PLATEAU 面積、かつ OSM ≥ 5 棟 |
| 重複（centroid / IoU） | OSM の重心が PLATEAU polygon の内側、または bbox IoU ≥ 0.22（build 時）/ 0.30（canonical 化時） |
| 距離 | **使っていない**（「近接距離では判定しない」と明記されている） |
| 面積の重なり（overlap） | 使っていない |
| 区（ward scope） | 重心が区の内側（`public/.../ward-classification-polygons.json`） |
| 品質フィルタ | roof / construction / ruins などを除外。面積 8〜60,000 m²。自己交差なし |

## 2. 新しい選定（§3〜§9）

- **基準:** V2 PLATEAU だけを使う（`canonical/buildings-v2-corrected` の `plateau-building`）。V1 footprint は一切読まない（validator で確認）。
- **座標:** OSM の座標は共通 module `latLonToLiveCityWorld()` で変換した。
- **場所の条件:** 旧ルールと同じ（hole / sparse-mismatch）。基準を V2 PLATEAU に替えただけ。
- **重なりの計測:** OSM 1 棟ごとに、[tools/lib/osm-fallback-v2-classify.js](tools/lib/osm-fallback-v2-classify.js) で次の値を測った。
  - intersectionArea / osmArea / plateauArea / IoU（PLATEAU 1 棟ごと）
  - PLATEAU の和集合による被覆率
  - 重心の包含
  - OSM の中に PLATEAU が入っている割合（逆方向の包含）
  - 重なる PLATEAU の棟数（one-to-many）
  - 最短距離（参考値。分類には使わない）

**分類:**

| 分類 | 条件 | 扱い |
|---|---|---|
| CLEAR_DUPLICATE | 被覆率 ≥ 0.5、または PLATEAU 1 棟との IoU ≥ 0.5 | 除外 |
| LIKELY_DUPLICATE | 被覆率 ≥ 0.2、または重心が PLATEAU 内、または OSM が PLATEAU を包む、または旧基準の bbox IoU ≥ 0.3 | 除外 |
| AMBIGUOUS | 被覆率 0.02〜0.2。または LIKELY の条件に当たるが、重ならない部分が 60 m² 以上かつ被覆率 0.35 未満（別の建物を誤って落とさないため §7） | **採用**・別計上 |
| VALID_FALLBACK | 被覆率 < 0.02 | 採用 |

**区（§12）:** N03 2026 から、V2 PLATEAU と同じ方法（representativePoint + classifyPointToWard）で判定し直した。旧ラベルは使っていない。区が付かない fallback は 0 件。

**canonicalId（§11）:**
- 残した旧 fallback は、ID も geometry もそのまま（`cg_bldg_osm_<way>`）。
- 新しく追加した fallback も同じ規則で ID を付けた。
- 除外した 24,842 ID は `data/processed/osaka-city/osm-fallback-v2/deprecated-ids.json` に、理由と重なる PLATEAU の ID を付けて記録した。

### 旧 fallback 41,505 棟の行き先

| 行き先 | 棟数 |
|---|---|
| 残す（V2 基準でも空白地帯にあり、重複なし） | 16,663 |
| 除外: CLEAR_DUPLICATE | 22,612 |
| 除外: LIKELY_DUPLICATE | 297 |
| 除外: V2 PLATEAU の空白地帯ではなくなった（重なりはない） | 1,933 |
| 除外: OSM から再現できない | 0 |

- 新しく追加した fallback は 9,989 棟（V2 で初めて空白地帯になった場所）。
- one-to-many: 複数の PLATEAU にまたがる OSM は 6,825 棟。除外した旧 fallback のうち 6,526 棟がこれに当たり、単純な最近傍の判定では拾えなかったもの。
- 閾値の感度（§7）: CLEAR の閾値を 0.4 / 0.6 に変えても除外数は変わらない（±0）。LIKELY の閾値を 0.1 / 0.3 に変えても ±10 棟以内。

---

## 3. 結果（`data/reports/osm-fallback-v2-rebuild.json`）

### 重複 KPI（§15）— 32N と同じ基準（重心が PLATEAU 内 / bbox IoU ≥ 0.3）

| | before（旧 fallback） | after（新 fallback） |
|---|---|---|
| PLATEAU と重なる fallback | **22,758**（頂点平均の重心。32N と完全一致）/ 22,771（面積重心） | **5**（**5 棟とも AMBIGUOUS**。AMBIGUOUS を除けば **0**） |
| 面積の 50% 以上が重なる | — | 0 |

### Coverage（§16）と Visual fixture（§18）

各サイト 1 km 四方。被覆率は、OSM 建物の面積のうち PLATEAU ∪ fallback で覆われる割合。

| サイト | fallback 旧→新 | OSM 被覆率 旧→新 | PLATEAU×fallback の二重面積 旧→新 | duplicate picking 旧→新 |
|---|---|---|---|---|
| 梅田 | 71 → 153 | 0.802 → **0.879** | 12,483 → **0** m² | 75 → 6 |
| 本町 | 126 → 15 | 0.894 → **0.918** | 27,748 → 116 m² | 242 → 11 |
| 難波 | 92 → 0 | 0.920 → 0.905 | 27,200 → **0** m² | 184 → 8 |
| 天王寺 | 39 → 1 | 0.947 → 0.947 | 4,297 → 147 m² | 98 → 20 |
| 住吉 | 37 → 0 | 0.962 → 0.962 | 4,161 → **0** m² | 84 → 13 |
| 東淀川 | 0 → 0 | —（OSM が無い: PBF は北緯 34.735° 以北を含まない） | 0 → 0 | 13 → 13 |
| 中之島 | 106 → 1 | 0.915 → 0.908 | 24,611 → **0** m² | 205 → 6 |

- **難波の低下（−1.5 ポイント・7,024 m²）の内訳:**
  - 6,673 m² は、重複として除外した OSM 輪郭のうち PLATEAU からはみ出していた部分。同じ建物の輪郭の差で、建物そのものは失っていない。
  - 351 m² は、空白地帯でなくなった小さな fallback（36〜89 m²、PLATEAU から約 1 m の位置）。
  - 中之島の低下も同じ構成（1,544 / 872 m²）。
  - いずれも許容値（2 ポイント）以内。
- **梅田では fallback が増えた。** 追加されたのは大阪富国生命ビル、OIT梅田タワー、梅田ゲートタワー、東阪急ビル、梅田ナナイロなどで、V2 PLATEAU に存在しない実在の建物。V1 では、回転した PLATEAU がたまたまそのセルを覆っていたため選ばれていなかった。
- **duplicate picking の「新」に残る点**は、PLATEAU 同士の重なりと AMBIGUOUS によるもの。東淀川は fallback が 0 なので、13 点はすべて PLATEAU 同士。

### Picking / property（§19）

- 新 fallback の property card 用属性（usageCategory / usageLabel / normalizedUsage / wardId / source / confidence）に欠けは 0 件、"null" を含むラベルも 0 件。
- `pickBuilding` の経路は変えていない。

### 区別（§17）

「除外」は旧 fallback の区、「新 fallback」は N03 2026 での新しい区で数えている。

| 区 | 旧 fallback | 新 fallback | 重複で除外 | 空白地帯外で除外 | 残した | 新規追加 | AMBIGUOUS |
|---|---|---|---|---|---|---|---|
| kita | 4787 | 3328 | 1716 | 232 | 2839 | 489 | 6 |
| nishiyodogawa | 4206 | 1516 | 2726 | 219 | 1261 | 255 | 2 |
| suminoe | 3495 | 2711 | 762 | 201 | 2532 | 179 | 0 |
| tsurumi | 3393 | 4237 | 2155 | 170 | 1068 | 3169 | 8 |
| hirano | 3288 | 2078 | 1670 | 191 | 1427 | 651 | 1 |
| konohana | 3085 | 2203 | 1245 | 102 | 1738 | 465 | 4 |
| miyakojima | 3035 | 1192 | 1761 | 83 | 1191 | 1 | 1 |
| fukushima | 2200 | 2118 | 713 | 77 | 1410 | 708 | 3 |
| taisho | 1709 | 845 | 950 | 95 | 664 | 181 | 1 |
| minato | 1627 | 827 | 757 | 46 | 824 | 3 | 0 |
| yodogawa | 1595 | 596 | 1270 | 55 | 270 | 326 | 1 |
| nishinari | 1590 | 1040 | 432 | 149 | 1009 | 31 | 3 |
| asahi | 1574 | 1396 | 1507 | 57 | 10 | 1386 | 3 |
| joto | 1364 | 620 | 1280 | 59 | 25 | 595 | 0 |
| nishi | 1059 | 233 | 799 | 53 | 207 | 26 | 0 |
| chuo | 652 | 18 | 615 | 31 | 6 | 12 | 1 |
| naniwa | 640 | 0 | 606 | 34 | 0 | 0 | 0 |
| tennoji | 521 | 4 | 493 | 27 | 1 | 3 | 1 |
| higashiyodogawa | 492 | 33 | 453 | 12 | 27 | 6 | 0 |
| ikuno | 356 | 609 | 251 | 7 | 98 | 511 | 4 |
| higashisumiyoshi | 275 | 78 | 261 | 11 | 3 | 75 | 3 |
| higashinari | 249 | 931 | 221 | 9 | 19 | 912 | 4 |
| sumiyoshi | 189 | 39 | 142 | 13 | 34 | 5 | 1 |
| abeno | 124 | 0 | 124 | 0 | 0 | 0 | 0 |
| **計** | **41,505** | **26,652** | **22,909** | **1,933** | **16,663** | **9,989** | **47** |

**鶴見（+3,169）・旭（+1,386）・東成（+912）・生野（+511）は新規追加が多い。** V2 基準で sparse-mismatch / hole になった場所で、V1 では回転した PLATEAU がそのセルを覆っていたため選ばれていなかった。梅田と同じ理由と考えられるが、**実機で見てほしい場所**。

### Runtime（§13/§14）・派生（§20）・placement（§21）・性能

- **UI:** development HTML の切替を `[BLDG V1] [V2 + OLD OSM] [V2 + NEW OSM]` の 3 つにした（一時追加。既定は V1）。
  - V2N（V2 + NEW OSM）は `derived-v2-osmv2` だけを読む。
  - V2N の公開 tile（far/mid/near）に、除外した旧 ID や旧 fallback だけが持つ ID は **0 件**。
  - V2N の状態: scale [1,1,1]、rotation 0、placement と ward index は V2N namespace から読込、residual 0。
- **派生:** `derived-v2-osmv2/{far,mid,near}/buildings`、placement、ward index を新しく生成した（data と public）。V1 の `derived/` と 32N の `derived-v2-corrected/` はそのまま残している。
- **placement:** 新しい建物集合から作り直した。31E の索引は使っていない。
  - V2 + OLD OSM: SUPPRESS 479 / REVIEW 1,115 / EXEMPT 190
  - V2 + NEW OSM: SUPPRESS 456 / REVIEW 1,102 / EXEMPT 192
- **性能（near 頂点数）:** 3,494,617 → 3,415,215（−2.3%）。far / mid も同程度減った。

### Validator（§23）— `data/reports/osm-fallback-v2-rebuild-validation.json`

| 項目 | 値 |
|---|---|
| plateauV2Mutation | 0 |
| plateauCanonicalIdPreserved | true |
| oldFallbackNotUsedInV2Runtime | true |
| duplicateOverlapMeasured | true |
| newFallbackSelectedAgainstCorrectedV2 | true |
| productionModified / protectedModified | false / false |

- 警告 5 件は §16 の被覆率低下（すべて許容内。内訳は上記）と、東淀川の OSM 欠落。

### Test（§24）

- `npm test`: **1,706 tests / pass 1,691 / fail 0 / skip 15**
- 追加: `tests/osm-fallback-v2-rebuild.test.js`（11 件）
- 大量の出力は、すべて synced-dir-writer で書いた。rmSync は使っていない。共有の親ディレクトリも消していない。

## 4. 作業中の問題と対処

- **`writeFilesVerified` が作業ファイルを消した。**
  - 何が起きたか: 期待外ファイルを消す既定動作のため、同じフォルダの `candidates.json` が `deprecated-ids.json` の書き込み時に消えた。
  - 対処: `removeStray: false` オプションを追加し、共有する作業フォルダではそれを使うようにした。全段階を再実行し、結果は同一だった。
- **32N の V2 フォルダに競合コピーが戻ってきた。** OneDrive が、32N で消した `-DESKTOP-ORA500N` の競合コピー（9/16 22:03 付けの同じ 3,163 件）をクラウド側から戻した。正規ファイル（989 / 988）と中身（615,617 件、生成時刻一致）は無事。どのツールも厳密なファイル名判定で読むので実害はない。消しても戻る可能性が高いので、今回は触っていない。
- **残した旧 fallback のうち 1 棟**（`cg_bldg_osm_896542555`）は、PBF から計算し直した座標と 1 頂点だけ 0.01 m 違う（丸めの差）。ID と geometry を安定させるため、旧 geometry をそのまま使った。

## 5. 生成物

| 種別 | パス |
|---|---|
| fallback 単独（§1） | `data/processed/osaka-city/canonical/buildings-v2-osm-fallback/` |
| PLATEAU + 新 fallback | `data/processed/osaka-city/canonical/buildings-v2-osmv2/` |
| 派生 / 公開 | `data/processed/osaka-city/derived-v2-osmv2/`、`public/map-data/osaka-city/derived-v2-osmv2/` |
| 候補の計測値 / 除外 ID | `data/processed/osaka-city/osm-fallback-v2/{candidates,deprecated-ids}.json` |
| レポート | `data/reports/osm-fallback-v2-rebuild.json`、`…-validation.json`、`osm-fallback-v2-build.json`、`building-placement-policy-v2-osmv2.json`、`ward-building-index-v2-osmv2.json` |
| LIKELY サンプルの図 | `data/reports/osm-fallback-v2-likely-samples.html`（除外した LIKELY 60 件と、残した AMBIGUOUS 30 件。赤 = OSM、青 = PLATEAU） |
| ツール | `tools/build-osm-fallback-v2.js`（`--stage=analyze\|write\|derived\|all`）、`tools/lib/osm-fallback-v2-classify.js`、`tools/audit/osm-fallback-v2-rebuild.js`、`tools/validate/osm-fallback-v2-rebuild.js` |
| 変更 | `tools/lib/synced-dir-writer.js`（removeStray）、`public/osaka_3d_buildings.ward-ux-v1.html`（V2N 追加のみ） |

## 6. Visual QA のお願い

`public/osaka_3d_buildings.ward-ux-v1.html` で `[V2 + OLD OSM]` と `[V2 + NEW OSM]` を切り替えて、次を確認してください。

- **梅田:** 二重建物、Z-fighting、色の重なり、duplicate picking が消えているか。新たに入った大阪富国生命ビルなどが自然に見えるか。
- **本町・難波・天王寺・住吉・東淀川:** 必要な建物が消えていないか。
- **鶴見・旭・東成:** 新規追加の多い区で、不自然な OSM 建物が入っていないか。
- **LIKELY の除外:** 目視確認には `data/reports/osm-fallback-v2-likely-samples.html` を使ってください。

`VISUAL_QA_PENDING_USER`
