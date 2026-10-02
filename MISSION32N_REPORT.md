# MISSION 32N — CORRECTED BUILDING CANONICAL V2

**判定: `CORRECTED_BUILDING_CANONICAL_SUCCESS`**（validator PASS・§30 の成功条件 10/10）
**ただし Visual QA 前に要確認の既知課題が 1 件あり（§A: OSM fallback との二重建物）。**
V1 は削除していない。V2 は production へ昇格していない（development HTML の既定も V1 のまま）。

---

## 1. 何をしたか

Mission 32M で特定した原因（建物だけが `latLonToJPRect(zone 7)` を経由し、地図に対して時計回りに 0.93° 回転していた）を、**回転補正ではなく経路の作り直し**で解消した。

```
生 CityGML (lat, lon)  →  latLonToLiveCityWorld()  →  canonical/buildings-v2-corrected
                          （config の local-equirectangular・道路/水域/鉄道/区界と同じ式）
```

- 平面直角座標（第7系・第6系とも）は中間 basis に使っていない。`rotate(-0.93°)` のような処理もない（§0/§3）。
- 共通座標系は [tools/lib/livecity-coordinate-system.js](tools/lib/livecity-coordinate-system.js) の 1 か所だけで定義した（§4）。
- footprint の選び方は V1 と同じ規則（lod0FootPrint の最大外周 → 無ければ GroundSurface、0.01 m 丸め、閉じ点除去）。その結果、**PLATEAU 574,112 棟すべてで頂点数が V1 と一致した**。形・高さ・属性は変えておらず、変わったのは位置と向きだけ（§6）。
- OSM fallback 41,505 棟は元から equirect なので、座標をそのまま複製した。
- 区は corrected 座標から N03 で判定し直した（representativePoint + classifyPointToWard）。旧ラベルは `wardIdV1` として残しただけで、判定には使っていない（§11）。

### 生データの読み込み

- 最初のビルドでは 12,692 棟が欠落した。原因は、住吉側アーカイブ `data/raw/osaka-sumiyoshi/plateau/buildings-lod2/2024/archive/CityGML_v4.zip` の中にだけある **73 メッシュ**。
- zip も読むように直し、フォルダ 197 ファイル + zip 73 ファイルから再構築した。

| 項目 | 値 |
|---|---|
| 生建物（全 270 ファイル） | 616,119 |
| V1 に存在し再構築した PLATEAU | **574,112 / 574,112**（欠落 0） |
| うち zip のみのメッシュ由来 | 12,692 |
| footprint の出所 | lod0FootPrint 572,712 / GroundSurface 1,400 |
| 頂点数が V1 と一致 | 574,112（不一致 0） |
| 丸め後の自己交差 | 7 棟（qaFlags `v2-self-intersect-after-rounding`） |
| V1 に無い生建物（対象外） | 42,007 |

---

## 2. 結果（`data/reports/building-canonical-v2-corrected.json`）

### 件数・ID・座標（§7/§5/§8/§9）

| 項目 | V1 | V2 |
|---|---|---|
| 件数 | 615,617 | **615,617** |
| canonicalId | — | **全件一致**（欠落 0・追加 0） |
| 生 lat/lon との誤差（PLATEAU 574,112 棟・全頂点） | — | **最大 0.000 m**（574,112 棟すべて 5 mm 以内） |
| 回転（生の重心 → 各版の重心、n = 82,016） | **0.9356°** | **0.0000°** |
| scale | 0.99790 | **1.0000000** |
| 平行移動 | (−2.46, 25.37) m | **(0, 0)** |
| 相似変換後の残差（中央値 / p95） | 9.15 / 15.93 m | 0 / 0 m |

**生 lat/lon との照合方法（§8）:** 期待座標は、ビルダーとは別に評価スクリプト内で書いた式で計算した（config の数値だけを使う）。逆変換した値は truth に使っていない。評価スクリプトは共通座標 module を import していないことを validator が確認している。

### OSM 建物との重なり（§10/§17）

建物ごとの被覆率の中央値。各サイトの中心から 350 m 以内の PLATEAU 建物を、同じ ID で V1 と V2 について比べた。

| サイト | V1 | V2 |
|---|---|---|
| 梅田 | 0.507 | **0.839** |
| 住吉 | 0.359 | **1.000** |
| 中之島 | 0.276 | 0.925 |
| 本町（中央区） | 0.490 | 0.943 |
| 難波 | 0.668 | 0.922 |
| 天王寺 | 0.426 | 0.863 |
| 東淀川 | 0 | 0 |

東淀川が 0 なのは、OSM PBF が北緯 34.735 付近で切れていて、この範囲に OSM 建物が無いためで、比較できない（既知の SOURCE-MISSING）。

### 区判定（§11/§12）

正解データは生 CityGML の「区名」属性（座標とは独立）。

| | 旧（V1 ラベル） | corrected |
|---|---|---|
| 全市（n = 459,185） | 96.76% | **99.30%** |
| 北区（n = 11,037） | 97.96% | **99.97%** |

- corrected で区が変わった建物: 19,950 棟
- どの区にも入らない建物: 232 棟
- 区名属性を持たない PLATEAU: 114,927 棟（分母から除外）

### Building ∩ DarkRoad（§18）

各サイトの 1 km 四方で、V1・V2 とも今回測り直した（32I の値は流用していない）。単位は m²。

| 道路 | V1 建物 | V2 建物 |
|---|---|---|
| FIX13 | 539,543 | **23,795** |
| ROAD V2 | 206,160 | **5,966** |
| ROAD V3 | 104,508 | **890** |

梅田だけで見ると、V3 は 11,029 → 531、FIX13 は 98,602 → 10,302。

### 水域（§19）

| | V1 | V2 |
|---|---|---|
| 7 サイト合計 | 21,769 m² | **646 m²** |
| 中之島・大川 | 16,477 m² | **31 m²** |

### GSI 建物（§20）

建物ごとの被覆率の中央値は、V1 が 0.29〜0.71 だったのに対し、V2 は全サイトで 1.00。
FIX20〜22 の値は過去の記録として扱い、今回は測り直した。

### Land Block（§21・梅田）

建物面積のうち ROAD-ENCLOSED BLOCK の内側にある割合は、V1 73.5% → **V2 96.5%**。

### Placement policy（§22）

V2 の policy は corrected 座標から作り直した。31E の索引は V1 座標から作られているため、使っていない。

| | DISPLAY | SUPPRESS | REVIEW | EXEMPT |
|---|---|---|---|---|
| V1 | 549,241 | 4,549 | 55,440 | 6,387 |
| V2 | 613,833 | **479** | **1,115** | **190** |

V1 の SUPPRESS / REVIEW の大半は、建物の位置ずれによる見かけ上の道路・水域の重なりだった。

### Runtime（§16/§23）と性能（§24）

**Runtime:** development HTML に `[BUILDINGS V1] / [BUILDINGS V2 CORRECTED]` を追加した。

- 切り替わるのは、建物 tile・placement・ward index の読み込み先だけ。camera は動かさない。
- V2 のとき、buildings group の scale は [1,1,1]、rotation は [0,0,0]。canonical residual は 0 のまま。
- V1 に戻せることもハーネスで確認済み。

**near(exact):** V2 の頂点は V2 canonical と完全に一致した（46,769 / 46,769）。

**性能:** V1 と V2 はほぼ同じ。draw call の区分（usageCategory × band）も同じ。

| LOD | V1 features / vertices / bytes | V2 features / vertices / bytes |
|---|---|---|
| far | 17,776 / 76,136 / 14.02 MB | 17,777 / 76,185 / 14.02 MB |
| mid | 73,234 / 325,560 / 55.63 MB | 73,253 / 325,757 / 55.62 MB |
| near | 615,617 / **3,494,617** / 461.99 MB | 615,617 / **3,494,617** / 461.99 MB |

---

## 3. Validator（§26）— `data/reports/building-canonical-v2-corrected-validation.json`

| 項目 | 値 |
|---|---|
| canonicalV1Mutation | 0 |
| canonicalV2Count | 615617 |
| canonicalIdPreserved | true |
| zone7UsedInCorrectedPipeline | false |
| commonCoordinateSystemUsed | true（import・manifest・数値 basis の 3 点で確認） |
| rawLatLonTruthUsed | true |
| inverseDerivedTruthUsed | false |
| wardReassignedFromCorrectedCoordinates | true |
| productionModified / protectedModified | false / false |
| 単純 rotation 補正 | 無し |
| 既定の建物版 | V1 |
| RESULT | **PASS**（警告 1 件 = §A） |

---

## A. 既知課題: OSM fallback と V2 PLATEAU の二重建物（要判断）

OSM fallback（Mission 21B）は、「V1 PLATEAU（回転していた位置）が無い場所」を基準に選ばれていた。PLATEAU が正しい位置に移った V2 では、その一部が PLATEAU と重なる。判定には、fallback を作ったときと同じ基準（重心が PLATEAU の内側、または bbox IoU ≥ 0.3）を使った。

| | 重複する fallback | 面積 |
|---|---|---|
| V1 PLATEAU に対して | 104 棟 | 0.08 万 m² |
| **V2 PLATEAU に対して** | **22,758 棟**（fallback の 55%） | **333 万 m²** |

- 区別の内訳は、西淀川 2,694、鶴見 2,120、都島 1,752、**北区 1,702**、平野 1,671 など。全 24 区に分布している。
- §7（615,617 件・欠落禁止）と §5（ID 維持）を守るため、今回は**除外していない**。そのため V2 の表示では、この場所で PLATEAU と OSM の建物が重なって見えるはず。梅田の Visual QA でも見える可能性が高い。
- 対応案（別 mission）: fallback を V2 PLATEAU 基準で選び直し、件数の期待値を改める。または placement policy で重複する fallback を SUPPRESS する。どちらにするかはユーザーの判断。

## B. 作業中に見つけた問題と対処

- **OneDrive の同期競合で出力ファイルが失われた。**
  - 何が起きたか: 出力ディレクトリを消して作り直すと、OneDrive が `tile_x_z-DESKTOP-ORA500N(-2).json` という競合コピーを作り、正規ファイルを競合名へリネームした。V2 canonical では 988 tile 中 101 が消えた。同期中のファイルは `UNKNOWN: read` で読めなかった。
  - 対処: [tools/lib/synced-dir-writer.js](tools/lib/synced-dir-writer.js) を追加した。ディレクトリは消さずに上書きし、期待外のファイルだけを消し、読み戻して一致するまで検証する。V2 の出力はすべてこの方法で書いた（競合コピー 3,163 件を除去）。
  - あわせて `processLayer` のタイル名判定を厳密にした（`STRICT_TILE_RE`）。
- **V1 側にも同じ競合コピーが 1,847 件ある（未対処）。**
  - 場所: `data/processed/osaka-city/derived/far/buildings` など、および public 側。いずれも 2026-09-09 付けで、今回より前からある。
  - V1 の出力なので触っていない。runtime は manifest に載ったファイルしか読まないので表示への影響はないが、容量の無駄。
- **ランタイムの修正:**
  - 32N のパッチで、道路 classMap の読み込みが建物側の関数に入ってしまっていたのを `ensureManifest` に戻した。
  - V2 の付帯データが無いとき、404 の応答を空データとして採用しないようにした。
- **`npm test`:** 1,695 tests / pass 1,680 / **fail 0** / skip 15。
  - 途中で 2 件失敗した。原因は、32N の意図的な変更（tile key への版追加、ward index の読込先）に対してソースパターンで確認する guard が古いままだったこと。その 2 件の guard を新しい形に更新した（[tests/canonical-runtime-cutover.test.js](tests/canonical-runtime-cutover.test.js)）。
  - 重いハーネス系テストは並列実行時に時々失敗することがある（過去 mission で観測）。今回の全体実行では起きなかった。**serial runner の導入は別課題として提案する。**

## 4. 生成物

| 種別 | パス |
|---|---|
| Canonical V2 | `data/processed/osaka-city/canonical/buildings-v2-corrected/`（+ `attributes/`） |
| Derived V2 | `data/processed/osaka-city/derived-v2-corrected/{far,mid,near}/buildings`、`building-placement/`、`building-ward-index.json` |
| 公開 | `public/map-data/osaka-city/derived-v2-corrected/`（V1 の `derived/` とは別 namespace） |
| レポート | `data/reports/building-canonical-v2-corrected.json`、`…-validation.json`、`canonical-building-v2-build.json`、`building-placement-policy-v2-corrected.json`、`ward-building-index-v2-corrected.json` |
| ツール | `tools/lib/livecity-coordinate-system.js`、`tools/lib/synced-dir-writer.js`、`tools/build-canonical-buildings-v2-corrected.js`（`--derived-only` あり）、`tools/build-buildings-v2-corrected-sidecars.js`、`tools/audit/building-canonical-v2-corrected.js`（`--fallback-only` あり）、`tools/validate/building-canonical-v2-corrected.js` |
| 既存ツールの追加分（既定動作は不変） | `build-derived-geometry.js`（outRoot / layerDir / syncedWrite、export 追加）、`build-building-placement-policy.js`（PLACEMENT_* env）、`build-ward-building-index.js`（WARD_INDEX_* env） |
| テスト | `tests/building-canonical-v2-corrected.test.js`（10 件・npm test に追加） |
| HTML | `public/osaka_3d_buildings.ward-ux-v1.html` のみ（production / protected は未変更） |

## 5. Visual QA のお願い（§17）

`public/osaka_3d_buildings.ward-ux-v1.html` を開き、`[BUILDINGS V1]` と `[BUILDINGS V2 CORRECTED]` を切り替えて、次の場所を確認してください。

- 梅田
- 東淀川
- 中央区（本町）
- 難波
- 天王寺
- 住吉

特に見てほしい点:

- 道路・水域・区界との位置関係
- §A の二重建物がどの程度目立つか

`VISUAL_QA_PENDING_USER`
