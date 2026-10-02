# MISSION 34A — MAX AVAILABLE PLATEAU LOD

**判定: `MAX_PLATEAU_LOD_SUCCESS`**（validator PASS・error 0・warning 0）

- リポジトリ内の PLATEAU CityGML を全数走査し、**実データとして存在する最高 LOD** だけを採用しました。
- **推定 LOD は 1 件も作っていません。** LOD1 からの生成・AI 補完・手動補完はしていません。
- canonical building geometry / 建物位置 / projection / canonicalId / ROAD V3 / placement は**不変**。
- **production / protected は未変更**（dev のみ）。

---

## 1. 全 PLATEAU 建物数（§1/§2/§3）

| 走査対象 | 件数 |
|---|---|
| フォルダ内 `*_bldg_*.gml` | **205 ファイル / 7.47 GB** |
| `CityGML_v4.zip` 内の建物エントリ | **270 / 7.86 GB（展開後）** |
| OneDrive の conflict copy（`-DESKTOP-`） | **0 件**（正本として読まない規則を実装） |
| **一意な建物（gml:id）** | **616,119** |
| うち複数コピーに重複 | 584,256（ZIP はフォルダと同内容） |

走査は 475 ソース・241 秒。**geometry を持たない建物は 0 件**（全棟が LOD0 + LOD1 を持つ）。

## 2〜4. LOD1 only / LOD2 / LOD3 の件数

| 区分 | 棟数 | 割合 |
|---|---|---|
| **LOD1 まで** | **605,421** | **98.26%** |
| **LOD2 あり（最高）** | **10,683** | **1.73%** |
| **LOD3 あり（最高）** | **15** | **0.00%** |
| geometry 無し | 0 | 0% |

**LOD2 は LOD1 と同じ形ではありません。** 1 メッシュ（1,536 棟）で検証したところ:

| | 値 |
|---|---|
| 屋根形状を持つ（屋根面の標高が 2 種類以上） | **1,167 棟 / 76.0%**（中央値 3 段・p90 8 段・最大 50 段） |
| 陸屋根（標高 1 種類） | 369 棟 / 24.0% |
| 1 棟あたりのポリゴン数 | LOD1 14.0 → **LOD2 35.7（2.54 倍）** |

全市の semantic surface 実数: **RoofSurface 36,457 / WallSurface 159,115 / GroundSurface 21,152 / Window 146 / Door 44 / BuildingInstallation 180 / BuildingPart 90**。

> 過去ミッション（32H）の「LOD2 でも独立した外形は得られない」という記録は **footprint（平面外形）についての結論**で、今回の結果と矛盾しません。32H は LOD2 の GroundSurface / RoofSurface を真上から投影すると lod0FootPrint と同一（被覆率 0.9999）だと実測しており、それは今も正しいはずです。**今回新たに分かったのは「平面は同じでも、屋根面は複数の標高を持つ＝立体形状がある」**という点です（接地形状の検証には依然として使えません）。

## 5. 24 区別 LOD カバレッジ

| 区 | 全棟 | LOD1 only | LOD2 | LOD3 |
|---|---|---|---|---|
| 中央区 | 15,709 | 11,509 | **4,196** | 4 |
| 淀川区 | 26,994 | 24,689 | **2,305** | 0 |
| 北区 | 14,131 | 12,684 | **1,437** | 10 |
| 東淀川区 | 26,383 | 26,044 | 339 | 0 |
| 西区 | 11,090 | 10,857 | 233 | 0 |
| 城東区 | 25,321 | 25,212 | 109 | 0 |
| 都島区 | 14,104 | 14,060 | 44 | 0 |
| 東成区 | 19,551 | 19,513 | 38 | 0 |
| 此花区 | 12,680 | 12,647 | 33 | 0 |
| 福島区 | 10,703 | 10,689 | 14 | 0 |
| 浪速区 | 8,208 | 8,204 | 4 | 0 |
| （区名属性なし） | 139,187 | 137,255 | 1,931 | 1 |

**LOD2/LOD3 が 1 棟も無い 13 区**: 生野・平野・東住吉・西成・住吉・阿倍野・旭・西淀川・住之江・鶴見・大正・港・天王寺

## 6. 主要地点別カバレッジ（半径 800m の PLATEAU 棟に対する比率）

| 地点 | PLATEAU 棟 | LOD2 | LOD3 | 高LOD率 |
|---|---|---|---|---|
| **大阪城** | 836 | 596 | 0 | **71.3%** |
| 中之島 | 2,619 | 1,235 | 0 | 47.2% |
| 梅田 | 1,966 | 920 | 0 | 46.8% |
| 本町 | 4,058 | 1,880 | 6 | 46.5% |
| 新大阪 | 4,207 | 1,378 | 0 | 32.8% |
| 難波 | 5,947 | 571 | 0 | 9.6% |
| 天王寺 | 5,526 | 0 | 0 | **0.0%** |

## 7〜8. 採用結果と fallback（§4/§5）

| 項目 | 件数 |
|---|---|
| 抽出対象（LOD2/LOD3 保有） | 10,698 |
| **高 LOD を採用** | **10,224**（LOD2 **10,209** / LOD3 **15**） |
| **妥当性検査で LOD1 へ差し戻し** | **36** |
| canonical に居ないため対象外（メッシュが市域外を含む） | 438 |

差し戻しの内訳（**地域一括ではなく building 単位**）:

| 理由 | 件数 |
|---|---|
| `centroid-shift`（canonical LOD1 重心から 30m 超） | 15 |
| `absurd-height`（高さが 1〜320m の範囲外） | 21 |

検査項目（§5）: 有限座標 / リング頂点数 ≥3 / 閉じ点除去 / 退化三角形の除去 / 高さ 1〜320m / bbox ≤500m / 標高絶対値 ≤3,000m / surface 3 面以上 / canonical 重心との距離。**退化三角形は 0 件**（earcut 前に法線で射影軸を選び、分割後に同一頂点の三角形を除去）。

## 9. geometry の増加

| 項目 | 値 |
|---|---|
| 三角形 | **675,766** |
| 頂点 | **1,322,700** |
| surface 内訳 | 屋根 91,895 / 壁 219,916 / 地面 12,351 |
| 内周リング（穴） | 766（保持） |
| タイル | 86（500m グリッド・既存 buildings タイルと同じ区切り） |
| 配信サイズ | **39.5 MB** |

画面上の増分（本町・近景）: 三角形 **727,105 → 904,080（+177k）**、draw call **335 → 351（+16）**。

## 10. 性能（§20・各 15 秒・カメラ静止）

| 地点 | FPS（高LOD OFF → ON） | p5 | frame p95 | 三角形 | draw call | JS heap | 表示 LOD2 / LOD3 |
|---|---|---|---|---|---|---|---|
| 梅田 | 42.8 → **51.2** | 29.9 | 33.4ms | 613,460 → 671,066 | 396 → 405 | 558 MB | 2,129 / 1 |
| 本町 | 39.6 → **43.1** | 29.9 | 33.5ms | 727,105 → 904,080 | 335 → 351 | 671 MB | 5,286 / 5 |
| 難波 | 44.3 → 43.2 | 29.9 | 33.5ms | 806,785 → 983,813 | 290 → 318 | 701 MB | 2,619 / 0 |
| 天王寺 | 49.6 → 46.9 | 29.9 | 33.5ms | 789,663 → 789,663 | 229 → 229 | 763 MB | 0 / 0 |
| 大阪城 | 54.4 → 55.0 | 30.0 | 33.3ms | 539,036 → 566,664 | **203 → 166** | 555 MB | 1,371 / 0 |
| 住吉 | 43.1 → 41.7 | 29.8 | 33.6ms | 863,684 → 863,684 | 306 → 306 | 614 MB | 0 / 0 |
| City Mode | 30.7 FPS | — | — | 1,785,292 | 1,275 | — | 0 / 0（遠景は LOD1） |

- **高 LOD が無い地点（天王寺・住吉）は三角形数も draw call も完全に同一**です（高 LOD が余計なコストを持ち込んでいない証拠）。FPS 差 2〜3 は計測ノイズです。
- 大阪城は draw call が **減って**います（LOD1 は用途カテゴリごとに mesh を分けるため、高 LOD へ置き換わると mesh 数が減る）。
- ラベル色は **頂点カラー**へ焼き込み、material を surface 種別ごとの 1 枚に抑えています。これをやる前は用途別 material で draw call が 342 まで増えていました（現在 84）。

## 11. Visual QA（§21）

6 地点 + City Mode + 距離スイープで確認（`data/reports/building-lod-qa/*.jpg`）。

| 地点 | 高LOD表示 | LOD1 抑制 | 三角形 | draw call | **二重表示** | 隣接LOD1誤検出 | legacy residual |
|---|---|---|---|---|---|---|---|
| 梅田 | 2,130 | 2,130 | 174,278 | 66 | **0** | 0 | 0 |
| 本町 | 5,291 | 5,291 | 368,548 | 84 | **0** | 0 | 0 |
| 難波 | 2,619 | 2,619 | 177,110 | 30 | **0** | 0 | 0 |
| 天王寺 | 0 | 0 | 0 | 0 | **0** | 0 | 0 |
| 大阪城 | 1,371 | 1,371 | 82,374 | 60 | **0** | 0 | 0 |
| 住吉 | 0 | 0 | 0 | 0 | **0** | 0 | 0 |

- **高 LOD を出した棟数と LOD1 を消した棟数が完全に一致**しています（地図に穴が空いていないことの直接の証拠）。
- 二重表示の判定は「高 LOD の頂点の真上から下向きに ray を撃ち、その棟の高さ範囲に LOD1 の面があるか」。全地点 0 件です。
- 屋根形状・外形・道路/水域との位置関係・浮き沈みをスクリーンショットで目視確認。屋根が段状に読め、周囲の LOD1 建物と色・スケールが揃っています。

### §16 LOD 切替で跳ばないこと

| カメラ距離 | band | 表示 | 抑制 | bbox minX | bbox minY |
|---|---|---|---|---|---|
| 600m | near | 5,291 | 5,291 | −3452.4 | −0.15 |
| 900m | mid | 5,291 | 5,291 | −3452.4 | −0.15 |
| 2,000m | mid | 5,291 | 5,291 | −3452.4 | −0.15 |
| 2,400m | mid | 5,291 | 5,291 | −3452.4 | −0.15 |
| 2,600m | far | 0 | 5,291 | — | — |

位置（minX）はどの距離でも同一、床は **−0.15m**（GroundSurface が最低点よりわずかに下がる分）で浮き沈みなし。

### §14/§15 距離 LOD

| カメラ距離 | band | 高LOD表示 | 三角形 | draw call |
|---|---|---|---|---|
| 300 / 600 / 800m | near | 5,291 | 368,548 | 84 |
| 1,200 / 2,000 / 2,500m | mid | 5,291 | **345,311** | **56** |
| 3,000 / 5,000m | far | **0** | **0** | **0** |

中景では地面 surface を落とすため三角形 −23k・draw call −28。遠景（>2,500m）では高 LOD を完全に停止し LOD1 に戻ります。

## 12. Picking QA（§19）

本町の LOD2 建物 `cg_bldg_bldg_dd52269f-…` で確認:

| | 高 LOD（LOD2）をクリック | 高 LOD OFF で LOD1 の箱をクリック |
|---|---|---|
| card 表示 | **block** | **block** |
| canonicalId | `cg_bldg_bldg_dd52269f-…` | **同一** |
| 見出し | 官公庁 ／ 大阪市中央区 | **同一** |
| 高さ | 19.3 m | **19.3 m（同一）** |
| 仮の値 | **0 件** | 0 件 |

真上からの ray による同定（`pickBuilding`）でも同じ canonicalId を返します。**LOD を切り替えても属性は変わりません**（card のデータは canonical 属性から引くため）。

> 補足: 当初の QA は「同じ画面座標をもう一度クリック」で比較しており失敗していました。低い屋根の隣に高い建物があると、LOD1 に戻した瞬間その画素は別の棟に覆われるためです。判定を「同じ canonicalId の棟を狙う」へ直しました（実装側の不具合ではありません）。

## 13. 座標の整合（§6/§7/§8）

- 変換は `tools/lib/livecity-coordinate-system.js` の **`latLonToLiveCityWorld()` のみ**（local-equirectangular・原点 34.604208/135.52502・znorth-neg-v1）。**平面直角座標系（第6系/第7系）は一切経由していません**（validator がコードのみを見て検査。manifest にも `zone7Used: false`）。
- **位置保存（§7）**: canonical LOD1 の重心と高 LOD の重心のズレ

| | 値 |
|---|---|
| 中央値 | **0.85 m** |
| p95 | 6.09 m |
| 最大 | 28.09 m（30m 超の 15 棟は採用せず LOD1 のまま） |

- **高さの差（§8）**: 高 LOD の全高 − canonical LOD1 の heightM

| | 値 |
|---|---|
| 中央値 | **0.00 m** |
| p05 / p95 | −4.08 m / +4.40 m |
| 最小 / 最大 | −65.17 m / +97.24 m |

- **地面合わせ**: GroundSurface の最低標高を 0 に合わせて平行移動（無い場合は全 surface の最低標高）。実測の bbox 底は −0.15 m で、浮きも沈みもありません。

## 14. 既知の制約

1. **高 LOD があるのは全体の 1.73% です。** 13 区には 1 棟もありません（天王寺・住吉・阿倍野など）。これは配布データの実態であり、無い場所に作ることはしていません。
2. **LOD3 は 15 棟のみ**（北区 10・中央区 4・区名なし 1）。§15 は「近景 LOD3 / 中景 LOD2」という段階を求めていますが、**LOD3 の棟に LOD2 は併存しない**ため、棟ごとに段を切り替えると 800m 境界で 15 棟だけが LOD1 へ落ちて目立つ跳びになります。代わりに **「近景＝全 surface / 中景＝屋根+壁（地面を落とす）/ 遠景＝LOD1」** という段階にしました。コストの階段は実現しつつ（中景で −23k 三角形）、跳びを作らない判断です。
3. **テクスチャは使っていません**（§10 の方針どおり）。色は LOD1 と同じ用途色で、屋根だけ同色相のまま 12% 暗くしています。
4. **Window / Door（LOD3 の 190 面）は geometry として取り込んでいますが、surface 種別は `other` に落としています。** 個別の material は付けていません。
5. **canonical に存在しない 438 棟は描いていません。** 配布メッシュは市域外も含むため、LOD1 でも描いていない棟を高 LOD だけ描くと市域外に建物が生えてしまいます。
6. **重心ズレの最大は 28.09m** です。しきい値 30m 以内なので採用していますが、canonical の footprint（lod0FootPrint 由来）と LOD2 の GroundSurface で外形の取り方が違う棟が少数あります。
7. **City Mode では高 LOD は出ません**（遠景のため §14 どおり）。カバレッジは QA 表示で確認できます。
8. 高 LOD タイルは **カメラ視点から半径 1,500m・最大 90 タイル**までしか読みません。大きく移動した直後は数百 ms かけて順に読み込まれます。

## 15. Validator — `data/reports/max-plateau-lod-validation.json`

| 項目 | 値 |
|---|---|
| **zoneVIIProjectionUsed** | **false** |
| **canonicalIdChanged** | **false** |
| **buildingPositionMutation** | **false** |
| **roadMutation** | **false** |
| **placementMutation** | **false** |
| **highestAvailableLodSelected** | **true** |
| **perBuildingFallbackWorks** | **true** |
| **lod2UsesRealPlateauOnly** | **true** |
| **lod3UsesRealPlateauOnly** | **true** |
| **productionModified / protectedModified** | **false / false** |
| projectionMutation / usesCanonicalProjection | false / true |
| runtimeLayer / distanceLod / landmarkPriority / lod1Suppression / pickingWired / sameUsageColor / qaCoverage | すべて true |
| doubleDisplay / noHoles / distanceSwitchWorks / pickingSameId | 0 / true / true / true |
| errors / warnings | **0 / 0** |

## 16. npm test

- `npm test`: **1,833 tests / pass 1,818 / fail 0 / skip 15**（新規 `tests/max-plateau-lod.test.js` 20 件）。
- lifestyle-tab 系（`npm test` 対象外）: 38 / pass 27 / **fail 0** / skip 11。
- 既存テストの更新は `tests/canonical-runtime-cutover.test.js` の 1 か所のみ（buildings 分岐を固定幅 2,600 字でスライスしていたため、高 LOD の抑制分岐を足したら範囲外になった。分岐の終端で切るよう修正）。

## 17. 生成物

| 種別 | パス |
|---|---|
| 変更したファイル | `public/osaka_3d_buildings.ward-ux-v1.html`（development のみ） |
| データ | `public/map-data/osaka-city/derived-v2-osmv2/building-lod-high/`（86 タイル + manifest・39.5MB。`data/processed/…` にも同内容）、`data/processed/osaka-city/canonical/plateau-lod-index.json` |
| ツール | `tools/audit/plateau-lod-availability.js`（在庫調査）、`tools/build-plateau-high-lod.js`（抽出・検査・タイル化）、`tools/audit/building-lod-qa.js`（実ブラウザ QA・`--only pick`） |
| Validator | `tools/validate/max-plateau-lod.js` |
| テスト | `tests/max-plateau-lod.test.js`（npm test に登録） |
| レポート | `data/reports/{plateau-lod-availability,plateau-high-lod-build,building-lod-qa,max-plateau-lod-validation}.json`、`data/reports/building-lod-qa/*.jpg` |
| デバッグ API | `window.__BUILDING_LOD_DEBUG__()` / `__BUILDING_LOD_TOGGLE__(bool)` / `__BUILDING_LOD_QA__(bool)`（LOD2=青・LOD3=金のカバレッジ表示） |

## 18. 実装で直した不具合（記録）

1. **在庫調査が 22 万件で OOM**（6GB）。V8 では**正規表現の捕獲文字列も親文字列を参照する SlicedString** になるため、`gml:id` をそのまま Map のキーにすると 1 件あたり数 MB のチャンクが保持され続けていました（実測 26KB/件）。`Buffer` 経由で平坦化して **166B/件**に。
2. **`update()` がカメラ操作からしか呼ばれない**ため、manifest 取得完了後にカメラを動かすまで高 LOD が出ず、タイルも同時 4 件で読み込みが止まっていました。manifest 到着時と 1 タイル完了ごとに自分で次を促すよう修正。
3. **統計が早期リターンで更新されず**、「LOD1 は消えているのに高 LOD 0 枚」という誤った値が出ていました（表示自体は正常）。集計を毎回やり直すよう分離。
4. **用途別 material で draw call が 342 に膨張**。頂点カラーへ焼き込み **84** に。

production へはまだ反映していません。

`MAX_PLATEAU_LOD_SUCCESS`
