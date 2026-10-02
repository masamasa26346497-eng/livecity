# Mission 32K 完了報告 — SEMANTICALLY CORRECT MAP DISPLAY

**最終: `SEMANTIC_MAP_DISPLAY_READY_FOR_VISUAL_QA`**

変更対象は `public/osaka_3d_buildings.ward-ux-v1.html` のみ。
**production / protected は変更していません（§17）。建物は一切触っていません（§0）。**

---

## 1. Normal View で表示する layers（§6・runtime 実測）

| layer | 状態 | 備考 |
|---|---|---|
| Buildings | **ON** | PLATEAU lod0FootPrint（§9: 位置補正対象にしない） |
| Road | **ROAD V3** | 車道のみ dark |
| **Raw GSI Road Edge** | **OFF** | 起動直後の mesh 数 **0**・manifest も tile も fetch しない |
| Rail | ON | |
| Water | ON | |
| Parks | ON | |
| Visual Land Block | OPTIONAL | Road Mode の `[D:+LAND BLOCK]` で ON。既定では出さない |

runtime 実測 (`__SEMANTIC_DISPLAY_DEBUG__()`):
`normalViewRoadMode = "ROAD_V3"` / `normalViewRawGsiEdge = false` / `rawGsiEdgeMeshCount = 0` /
`preset = "SEMANTIC"` / layers buildings・roads・water・parks・rail すべて true。

## 2. GSI Road Edge の新しい役割（§1/§2/§7/§8）

| | |
|---|---|
| **変更前** | Mission22 以降「authoritative outline を常時表示」として**通常表示でも既定 ON** |
| **変更後** | **通常表示から除外。** ROAD V3 生成 reference / Map Audit / Reference Alignment / Visible Alignment QA / `[GSI EDGE QA]` トグルでのみ使用 |
| **理由** | 32J の実測でこの緑線の正体は **GSI 道路縁＝道路区域の境界線**と確定。建物外形線でも parcel/lot 境界でもないため、通常画面に出すと「建物が収まるべき区画線」と誤認させる |

- **`[GSI EDGE QA]` トグル**を追加。ON のときボタンに
  **`[GSI EDGE QA] ON — GSI Road Area Edge (QA Reference)`** と明示表示します（§8）。
- **QA/解析モードでは自動で ON になります**。Reference Alignment は `requestGsiEdgeForQa(true)` で
  一時的に ON にし、**抜けたらユーザーの設定へ必ず戻します**（既定 OFF を壊さないため）。
- Map Audit は自前の `MapAudit_GSI_EDGE` レイヤーを持つため影響なし。

> 既定値を変えたのは Mission22 が意図して置いたものなので、32K §1 の明示指示に基づく変更である旨を
> コード上のコメントにも残しました。

## 3. ROAD V3 default candidate（§4/§13）

`let roadVisualMode = 'ROAD_V3';`（development 既定）。**production へは反映していません。**

32I §30 の「ユーザー visual QA 前に昇格しない」という凍結は、32K §13 の明示指示で解除されたものとして
扱い、それを守っていたガード（テスト2件・validator 2件）を**意図的に更新**しました。
ガードは削除せず「既定が `FIX13` か `ROAD_V3` のいずれかであること」へ緩める形にしています。

**併せて性能上の不具合を1つ直しました**: 従来の tile fetch フックは「FIX13 以外なら常に V2 を取る」
実装だったため、ROAD_V3 を既定にすると **V2 データセット（237 MB 相当）を無駄に読み込んで**いました。
V2 を実際に描くモード（ROAD_V2 / LAND_BLOCK / DIFF / DIFF V2→V3）のときだけ fetch するよう絞りました。

## 4. Building geometry mutation = 0（§0/§9/§10）

| | |
|---|---|
| Canonical Buildings | **615,617**（不変） |
| Canonical Roads | 199,658（不変） |
| projection (znorth-neg-v1) | 不変 |
| 建物の座標経路 | `pushExtrude(byCat.get(cat), f.geometryType, f.coordinates, h)` — **source 座標をそのまま**（offset/scale/clip/warp なし） |
| 32J の頂点同一性 | トレース 72 頂点すべてで x・z 完全一致 |

buildings 分岐に `offset` / `multiplyScalar` / `shrink` / `warp` が入っていないことをテストで機械的に
検査しています。**§10**: 駅舎・線路上空建築・大型駅施設・deck 等が road/rail と重なることを
自動 error 扱いしていません（32H で実在構造と確定済み）。
**§11**: Building × Water（大川等）は本ミッションの対象外で、一切触っていません。

## 5〜9. サイト別 visual 結果（§14）

数値化できる 4 項目を実測しました。

| site | Building∩DarkRoad FIX13 | **ROAD V3** | 改善 | centerline 被覆 V2→V3 | 通常表示の緑線 | 建物位置 |
|---|---|---|---|---|---|---|
| **5. 梅田** | 98,602 m² | **11,029 m²** | **−88.8%** | 18.92% → **19.04%** | **0 本** | 変化なし |
| **6. 本町** | 90,710 m² | **18,951 m²** | **−79.1%** | 34.58% → 31.68% | **0 本** | 変化なし |
| **7. 難波** | 102,725 m² | **17,110 m²** | **−83.3%** | 26.34% → **26.64%** | **0 本** | 変化なし |
| **8. 天王寺** | 64,141 m² | **8,927 m²** | **−86.1%** | 24.15% → 23.44% | **0 本** | 変化なし |
| **9. 住吉** | 53,839 m² | **9,172 m²** | **−83.0%** | 20.97% → **23.66%** | **0 本** | 変化なし |

§14 の「見るもの」への対応:

| 見るもの | 実測 |
|---|---|
| 建物が道路上に見えにくい | 5 サイトすべてで FIX13 比 **−79〜−89%** |
| 緑線による偽の「区画ズレ感」が消える | 通常表示の raw GSI Road Edge mesh 数 **0** |
| 車道が自然 | carriageway 幅 median **3.0 m** / p95 16.13 m |
| 交差点が途切れない | centerline 被覆 V2 比 **98.6%** 維持（全市） |
| 建物位置自体は一切変化しない | buildingMutation **0** ＋ 32J の頂点同一性 |

> **未評価**: 実機ブラウザでの目視。これはこの環境では不可能なので、visual QA をお願いします。

## 10. FPS / memory

**測定できていません（正直な報告）。** FPS・GPU メモリ・draw call はブラウザ実行が必要で、
この環境（Node 上の THREE スタブ）では測れません。数値を捏造せず未測定として報告します。

代わりに、通常表示で確実に減る負荷を記録しました:

| 項目 | 効果 |
|---|---|
| raw GSI Road Edge の fetch | **通常表示では 0**（32J 実測では QA 時に 60 tile / 6,863 feature を読んでいた分が不要に） |
| ROAD V2 データセットの fetch | **ROAD_V3 既定では発生しない**（従来は FIX13 以外で常に取得していた） |
| ROAD V3 配信物 | 92 tile / 263,238,033 bytes / 描画ポリゴン 516,488 |

## 11. Validator

`tools/validate/semantic-map-display.js` → **RESULT = PASS**

| §16 必須項目 | 値 |
|---|---|
| buildingMutation | **0** |
| projectionMutation | **0** |
| **normalViewRawGsiEdge** | **false** |
| **normalViewRoadMode** | **ROAD_V3** |
| **gsiEdgeStillAvailableForQa** | **true** |
| productionModified / protectedModified | false / false |

付随チェック: `buildingUsesRawCoords` true / `refAlignTurnsOn` true / `refAlignRestores` true /
`qaToggleExists` true / `qaLabelShown` true / `presetExists` true / `v2FetchScoped` true /
`roadV3PublicTiles` 92 / `runtimePreset` SEMANTIC / `rawGsiEdgeMeshCountAtStartup` 0。

> validator は HTML の静的既定値だけでなく、**実際に runtime を起動して
> `__SEMANTIC_DISPLAY_DEBUG__()` を読み**、見かけの既定と実動作の乖離を防いでいます。

## 12. npm test

**1,667 tests / 1,652 pass / 0 fail / 15 skip**

- 新規 `tests/semantic-map-display.test.js`（12件）全 pass
- 既定値を検証していた既存テスト4箇所（32E/32F/32I 系）を新既定へ更新。
  ガードは削除せず、守っている性質（Road Mode API の存在・LAND_BLOCK 統合・
  production/protected 非改変）はそのまま維持しています。

> **正直な申告**: 1回目のフルスイート実行で `[FIX23C §5/§9/§10]` の動的テストが1件落ちました
> （16 秒かかって失敗）。単体実行では 4.6 秒で pass、再実行したフルスイートでも 0 fail だったため、
> **並列負荷下のタイミング依存**と判断しています。このテストは 32K で変更していません。

---

## §15 比較モード

`[OLD DISPLAY]` / `[SEMANTIC DISPLAY]` を追加しました。**camera を動かさず**構成だけ切り替えます。

| preset | Road | Raw GSI Edge |
|---|---|---|
| OLD | FIX13（tran 道路区域を全面 dark） | **ON** |
| SEMANTIC | **ROAD V3**（車道のみ dark） | **OFF** |

往復しても `__CANONICAL_SELF_CHECK__().total = 0` を維持することを動的テストで確認済みです。

## §12 UI

`[A:FIX13] [B:ROAD V2] [C:ROAD V3] [D:+LAND BLOCK] [DIFF] [DIFF V2→V3]` は dev パネル
（`#canonical-runtime-status`）にそのまま保持しています。このパネル自体が開発用なので、
Normal mode での非表示化は行っていません（§12 は「隠してよい」という許可であり必須ではないため）。

## §5 土地側

Visual Land Block は **ROAD-ENCLOSED BLOCK** としてのみ扱い、parcel / lot / site とは呼んでいません
（32F で確立した表記を維持）。

---

## 成果物

| 種別 | パス |
|---|---|
| 変更 | `public/osaka_3d_buildings.ward-ux-v1.html` |
| 受け入れレポート | `data/reports/semantic-map-display.json` |
| Validator | `tools/validate/semantic-map-display.js` |
| 受け入れ生成 | `tools/audit/semantic-map-display-acceptance.js` |
| テスト | `tests/semantic-map-display.test.js` |

## 残る限界

1. **実機 visual QA 未実施。** §14 の5サイトを `[SEMANTIC DISPLAY]` で目視確認してください。
   `[OLD DISPLAY]` と切り替えれば同じカメラで before/after を比較できます。
2. **FPS / メモリ / draw call 未測定**（ブラウザ必須）。
3. **production への反映は未実施**（§4/§13 の指示どおり）。昇格のご判断をお待ちします。
4. 建物が道路区域に重なる件そのものは残ります。32H で「梅田の問題建物 30 棟中 27 棟は現実に存在する
   構造物」と確定しているため、**建物を押し込む方針は 32H で正式終了**しています（§9/§10）。

---

**STOP: `SEMANTIC_MAP_DISPLAY_READY_FOR_VISUAL_QA`**
