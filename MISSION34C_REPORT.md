# MISSION 34C — BUILDING COVERAGE + CLICK INTENT UX

**判定: `BUILDING_COVERAGE_CLICK_UX_SUCCESS`**

建物位置 / 投影 / ROAD V3 / canonicalId / production / protected は変更していません。V2N（600,764 棟）は 1 件も書き換えず、新しい namespace `derived-v2-osmv3` へ**足すだけ**にしました。**cutover はしていません。**

先に要点を 2 行で:

- **Brillia Tower Dojima が出ていなかったのはデータが無いからではなく、fallback の「候補の選び方」で評価される前に落ちていたから**でした。同じ理由で落ちていた実在建物が市内に **13,829 棟**あり、回収しました（600,764 → **614,593**）。
- **地図を動かしただけでカードが出ていたのは、ガードが一度も効いていなかったから**でした（`mouseup` は `click` より先に発火するため）。押下〜離上を 1 つの操作として判定し直し、**pan / rotate / wheel 100 回ずつで誤表示 0・単発クリック 100/100 成功**になりました。

---

# PART A — BUILDING COVERAGE

## 1. Brillia Tower Dojima の欠落原因（§2/§3）

### 1-1. 追跡結果

OSM を「名前」と「位置」の両方から探し、堂島の該当地点の建物 92 棟を raw → canonical → derived → placement → ward index と辿りました。

| 段階 | 結果 |
|---|---|
| OSM（raw） | **存在する**。way **1241852536** / `building=hotel` / **`building:levels=49`** / 2,412 m² / 北区 |
| canonical V2（PLATEAU） | **無い** |
| canonical V2（OSM fallback） | **無い** |
| derived tile（near / mid / far） | **すべて無い** |
| placement で SUPPRESS されたか | **いいえ**（そもそも収録されていない） |
| ward index | 収録なし |
| 周辺の canonical 建物 | 半径 220m に **221 棟あり**（＝その区画のデータが欠けているわけではない） |

> OSM には**名前が付いていません**（`ブリリア` / `Brillia` の名前一致は 0 件）。同定の根拠は「位置（北緯 34.6960 / 東経 135.4936 = 堂島浜）」「49 階建て」「新しい way id」の 3 点です。念のため way id を残しますので、現地名との突き合わせはご確認ください。

### 1-2. 原因（§3 の分類では **G: 重複排除ロジック（正確にはその前段の候補フィルタ）で誤除外**）

32O の fallback 選定（`tools/build-osm-fallback-v2.js`）は、OSM 建物のうち

- **hole**: 50m セル + 8 近傍に V2 PLATEAU が 1 棟も無い
- **sparse-mismatch**: 100m セルで OSM 面積が PLATEAU の 2.5 倍以上 かつ OSM が 5 棟以上

のどちらかに入るものだけを候補にしていました。**再開発で新しく建った 1 棟は、周囲が既存 PLATEAU 建物で埋まっているためどちらにも入らず、重複判定に掛けられる前に落ちていました。**

重複判定そのものに掛けると、この棟は次のとおり「別建物」と出ます。

| 計測（32O の判定器をそのまま使用） | way 1241852536 | 本町ガーデンシティテラス(way 1012677291) |
|---|---|---|
| PLATEAU との重なり率 | **0** | **0** |
| 最大 IoU | **0** | **0** |
| 重心が PLATEAU の内側か | **いいえ** | **いいえ** |
| 重なった PLATEAU の棟数 | **0** | **0** |
| 最寄り PLATEAU までの距離 | 2.63 m | 0.76 m |
| 判定 | **VALID_FALLBACK（no-overlap）** | **VALID_FALLBACK（no-overlap）** |

つまり**判定器は正しく「別建物」と答えるのに、そこへ渡されていなかった**、というのが原因です。

## 2. 市内全域の監査（§4/§8/§9）

前段の場所フィルタを外し、**市内の OSM 建物 全件**を 32O の重複判定へ掛け直しました（判定器は変更していません）。

| | 件数 |
|---|---|
| OSM の建物 way（大阪周辺） | 1,030,838 |
| footprint が無効（小さすぎ/大きすぎ/自己交差） | 9,703 |
| 市域外 / bbox 外 | 526,927 |
| **市内の有効な OSM 建物** | **494,208** |

この 494,208 棟を、現在表示している 600,764 棟（PLATEAU + 既存 fallback）と突き合わせた結果:

| 判定 | 件数 |
|---|---|
| CLEAR_DUPLICATE（同一建物） | 476,230 |
| LIKELY_DUPLICATE（同一の可能性が高い） | 4,146 |
| AMBIGUOUS（一部重なるが別建物として残す） | 1,853 |
| **VALID_FALLBACK（どの表示建物とも重ならない）** | **11,979** |
| **→ 表示されていない実在建物（AMBIGUOUS + VALID）** | **13,832** |

※ 内訳の処理: 早期に同一と判定（重心が内側 かつ bbox IoU ≥ 0.5）419,146 / bbox が 1 つも重ならない 5,963 / 全面サンプリングで判定 69,099。早期判定は「重複側」へ倒しているので、欠落建物を多めに数えることはありません。

### 2-1. 二重建物を増やしていないこと（§9）

| 確認 | 結果 |
|---|---|
| 回収分の判定が VALID / AMBIGUOUS 以外 | **0 件** |
| 回収分の canonicalId が V2N に既にある | **0 件** |
| **回収分どうしの重複**（OSM が同じ建物を 2 本の way で持っている） | **3 組 6 棟 → 各組 1 棟を落として 3 棟除外** |

残した方の選び方: 名前あり > 階数あり > 面積が大きい。落とした 3 棟は `ファミリーマート`(181m²) / 無名(98m²) / `THE RISE 大阪ユニバーサルベイサイド` の重複側です。

## 3. 回収結果（§10/§11/§12）

**新 namespace `derived-v2-osmv3`**（既存 `derived-v2-osmv2` はそのまま残す）。

| | 棟数 |
|---|---|
| V2N（現行 production 相当） | **600,764** |
| ＋ PLATEAU から回収 | 0（§7 参照） |
| ＋ **OSM から回収** | **13,829** |
| − 重複除去 | 3 |
| **V3 合計** | **614,593** |

### 区別の回収数

| 区 | 回収 | 区 | 回収 | 区 | 回収 |
|---|---|---|---|---|---|
| 鶴見 | 1,015 | 城東 | 934 | 北 | 892 |
| 中央 | 782 | 平野 | 746 | 西淀川 | 743 |
| 淀川 | 671 | 生野 | 628 | 東成 | 603 |
| 天王寺 | 601 | 西成 | 588 | 旭 | 580 |
| 住吉 | 569 | 住之江 | 525 | 大正 | 513 |
| 福島 | 488 | 東住吉 | 480 | 此花 | 429 |
| 都島 | 420 | 阿倍野 | 419 | 西 | 416 |
| 港 | 370 | 浪速 | 367 | 東淀川 | 50 |

**24 区すべて**で回収しています。

### 回収した建物の内訳

| | |
|---|---|
| 面積 p10 / p50 / p90 | 22 / 55 / 231 m² |
| 名前あり | 548 棟 |
| 階数タグあり | 1,143 棟 |
| `building` タグ | yes 11,320 / detached 949 / house 642 / apartments 291 / retail 107 / … |

### 回収された高層建物（10 階以上・抜粋）

| 階数 | 名称 | 区 |
|---|---|---|
| **49F** | （無名・堂島 = Brillia Tower Dojima と同定） | 北 |
| 43F | ブランズタワー大阪本町 | 中央 |
| 40F | アパホテル＆リゾート 大阪難波駅タワー | 浪速 |
| 37F | MJR 堺筋本町タワー | 中央 |
| 36F | グランドメゾン上町台レジデンスタワー | 中央 |
| 35F | リバーガーデンタワー 上町台筆ヶ崎 | 天王寺 |
| 34F | アパホテル&リゾート 大阪梅田駅タワー | 北 |
| 34F | センタラグランドホテル大阪 | 浪速 |
| 30F | ローレルタワー御堂筋本町 / クレヴィアタワー御堂筋本町 / ピアッツァタワー上本町EAST | 中央・天王寺 |
| 29F | ザ・ファインタワーウエストコースト | 港 |

### 3-1. 途中で見つけて直したこと（高さの頭打ち）

32O の fallback は高さを **60m で頭打ち**にしていました（`MAX_FALLBACK_HEIGHT_M = 60`、コメントに「超高層は PLATEAU 側にある想定」）。34C が回収するのは**まさに PLATEAU に無い棟**なので、その前提が成り立ちません。実際、最初のビルドでは 49 階建てが **60m** で描かれていました。

→ **実測タグ（`height` / `building:levels`）がある棟に限り**、上限を市内最高（あべのハルカス 300m）まで緩めました。タグが無い棟は 32O と同じ扱い（class default・60m）のままです。属性に `heightRelaxed` / `heightCapM` / `heightSource` を残しています。

| 高さの出所（回収 13,829 棟） | 件数 |
|---|---|
| `osm-height`（OSM の実測高さ） | 2,071 |
| `osm-levels`（階数 × 3.2m） | 502 |
| `class-default`（用途別の既定・`heightUnknown=true`） | 1,345 |
| `generic-default`（8m・`heightUnknown=true`） | 9,911 |
| **60m の頭打ちを外した棟** | **31** |
| 最大高さ | **156.8 m**（堂島の 49 階建て） |

実ブラウザでも確認済み: **runtime に存在・156.8m・クリックで property card が開く**。

## 4. 捏造していないこと（§1/§6）

| 確認 | 結果 |
|---|---|
| 回収分の `geometrySource` が `osm-building` 以外 | **0 件** |
| `sourceIds`（`way/<id>`）が無い / canonicalId と不一致 | **0 件** |
| 監査時に OSM から読んだ footprint と形が違う | **0 件** |
| 頂点 3 未満（= point からの押し出し） | **0 件** |
| ビルドスクリプトに POI / 施設 / 住所点 の経路 | **無し**（入力は必ず OSM way の ring） |

各棟に `recoveredBy: mission-34C` / `recoveredReason` / `overlapMetrics`（何を根拠に「別建物」と判定したか）を記録しています。

## 5. V2N を壊していないこと（§1）

| 確認 | 結果 |
|---|---|
| V2N の建物数 | **600,764**（不変） |
| V2N → V3 で消えた建物 | **0 件** |
| V2N → V3 で座標が変わった建物 | **0 件**（タイル抽出照合） |
| `derived-v2-osmv2`（production が読む namespace） | **そのまま残置** |
| 投影 | local-equirectangular / 34.604208 / 135.52502 / 111320（不変） |
| Zone VII 変換 | 復活していない |

## 6. raw PLATEAU との差（§7）— **未解決として報告します**

raw PLATEAU 616,119 件（一意 gml:id）と canonical の 574,112 件の差 42,007 件を分類しました。

| 区分 | 件数 |
|---|---|
| raw の重複コピー（同じ id が別ファイルにある） | 612,378 セグメント分 |
| canonical に入っている | **574,112**（= canonical の PLATEAU 全件。id 照合は完全一致） |
| canonical に無い | **42,007** |
| ├ 市域外 | 646 |
| ├ 既存 canonical 建物の中（年度違いの再収録の疑い） | 4 |
| └ **市内にあって canonical に無い** | **41,357** |

さらに、この 41,357 棟が既存の表示建物からどれだけ離れているかを測りました。

| 最寄り canonical 建物までの距離 | 件数 |
|---|---|
| < 1 m | 7 |
| 1–3 m | 115 |
| 3–10 m | 1,734 |
| 10–25 m | 3,596 |
| 25–75 m | 3,928 |
| **> 75 m（周囲に建物が 1 つも無い）** | **31,977** |

**つまり重複ではなく、本当に表示されていない実在建物です。** 区別では 住之江 5,578 / 鶴見 5,137 / 北 3,902 / 此花 3,467 / 平野 2,706 … に集中しています。サンプル 12 件を個別に見ると、最寄り canonical は 0.6〜53m 離れており、その多くが **OSM fallback で埋められた疎な区画**でした。

**34C では取り込んでいません。** 理由:

1. 取り込みには CityGML からの geometry 再抽出が必要で、建物位置に触れる工程になります（§1 の最上位の禁止事項に最も近い作業）。
2. 一部は既存の OSM fallback と重なるため、**足すだけでは二重建物が増えます**（§9 違反）。PLATEAU を優先（§6）するなら該当 fallback を**外す**判断が要り、これは「表示を足す」ではなく「表示を入れ替える」変更です。

→ **次のミッションで扱うべき最大の coverage 改善**として記録します。§16 のとおり、**現時点のカバー率を 100% とは主張しません。**

## 7. landmark に建物表現があるか（§14）

registry の 19 件すべてを調べました（**registry の点から建物は作っていません**。その場所に building geometry の source があるかを見ただけです）。

| 状態 | 件数 |
|---|---|
| 建物の内側に位置がある | 13 |
| 60m 以内に建物がある | 6 |
| **建物表現が無い** | **0** |

## 8. COVERAGE QA（§15）

dev 専用の `[COVERAGE QA]` を追加しました。34C で回収した建物の footprint を **magenta** で重ねます（production には出しません）。

| | |
|---|---|
| 読み込み | `map-data/osaka-city/derived-v2-osmv3/recovered-index.json`（3.1MB） |
| 描画 | **13,829 棟**（`dataError: null`） |
| 置き場所 | `canonicalRoot` 直下（legacy residual を出さない） |

### スクリーンショット（`data/reports/coverage-qa/`）

| ファイル | 内容 |
|---|---|
| `dojima-v2n.jpg` | 堂島・現行 V2N。**Brillia Tower Dojima の場所が空き地** |
| `dojima-v3.jpg` | 堂島・V3。**同じ場所に 156.8m のタワーが立つ**（表示建物 11,507 → 11,951） |
| `dojima-v3-coverage-qa.jpg` | 同上 + `[COVERAGE QA]`（回収分を magenta で表示） |
| `honmachi-v2n.jpg` / `honmachi-v3.jpg` / `honmachi-v3-coverage-qa.jpg` | 本町の同じ 3 枚（19,211 → 19,641） |

**まず `dojima-v2n.jpg` と `dojima-v3.jpg` を見比べてください。**

---

# PART B — CLICK INTENT UX

## 9. 原因（§17）

```js
canvas.addEventListener('mousedown', e => { cs.drag = true; … });
window.addEventListener('mouseup',  () => { cs.drag = false; … });
window.addEventListener('click', e => {
  if (cs.drag) return;   // ← 一度も効いていない
  …pickHit → selectBuilding → property card
});
```

**`mouseup` は `click` より先に発火します。** `click` が走る時点で `cs.drag` は必ず `false` なので、このガードは**一度も働いていませんでした**。その結果、pan / rotate を終えるたびに picking が走り、property card が開いていました。

## 10. 直し方（§18–§26）

押下から離上までを 1 つの操作として記録し、**「ほとんど動いていない・短時間・カメラが動いていない・直前にホイールを回していない」ときだけ** click として扱います。

| 判定条件 | 値 |
|---|---|
| 移動量のしきい値（マウス） | **6 px**（DPI で自動補正） |
| 移動量のしきい値（タッチ） | **12 px** |
| クリックとみなす最大時間 | 700 ms |
| ホイール直後の抑制 | **220 ms** |
| カメラが動いたか | **押した時点の `cs.tgt / r / th / ph` と離した時点を比較** |
| マルチタッチ（ピンチ） | 2 本目が触れた時点で tap ではないと確定 |

touch は `touchstart` / `touchmove` / `touchend` / `touchcancel` に繋いであり、**tap だけ通り、swipe / pinch では開きません**。

### 10-1. 実装中に見つけた 2 つ目の落とし穴

最初は「`camUpd()` が呼ばれたらカメラが動いた」と判定していましたが、**`camUpd()` はタイルの整定・リサイズ・検索アニメからも呼ばれる**ため、指を動かしていなくても誤判定し、**本物のクリックの 7 割が弾かれました**（成功率 40%）。→ 呼び出しではなく**カメラの値**で判定するよう変更。

さらに、**建物をクリックすると `selectBuilding` が最後に `flyTo` でその建物へ寄る**（既存仕様・900ms）ため、その最中の次のクリックが「カメラが動いた」と見えて弾かれていました（成功率 72%）。→ `flyTo` の各フレームで「これはユーザー操作ではない」と基準を取り直すようにしました（`clickIntentNoteProgrammaticCamera`）。

## 11. 実測（§27）

梅田 / 堂島 / 本町 / 難波 / 新大阪 の 5 地点で、**CDP から本物のマウスイベント**を送って各操作 20 回ずつ（計 400 操作）。

| 操作 | 期待 | 結果 |
|---|---|---|
| **単発クリック**（建物上） | card が開く ≥ 95% | **100 / 100（100%）** |
| **pan**（右ドラッグ） | 誤表示 0 | **0 / 100** |
| **rotate**（左ドラッグ） | 誤表示 0 | **0 / 100** |
| **wheel zoom** | 誤表示 0 | **0 / 100** |

地点別はすべて 20/20・誤表示 0 です。gesture が空振りしていないことも確認しています（pan / rotate / wheel とも 100/100 でカメラが実際に動いた）。

### card の維持（§24）

5 地点すべてで、カードを開いたあと **pan → rotate → wheel** を続けても

| | 結果 |
|---|---|
| card が開いたまま | **5 / 5** |
| 同じ建物のまま（別建物へ切り替わらない） | **5 / 5** |

card を開く経路は `selectBuilding` の 1 本だけで、そこへは gesture 判定を通った click しか来ません。`✕` / **Escape** / 別建物の明確なクリック でだけ変わります。

### 空白クリックで閉じる（§25）

何も無いところを**明確にクリック**したときだけ card を閉じます。drag の後には閉じません。

---

# 共通

## 12. 性能（§30）

V2N と V3 を同じ camera で 30 秒ずつ測定。

| 地点 | FPS (V2N → V3) | 差 | 三角形 | draw call | 表示建物 |
|---|---|---|---|---|---|
| 梅田 | 39.5 → **38.1** | −3.5% | 519,943 → 729,099 | 420 → 447 | 16,473 → 17,058 |
| 堂島 | 38.8 → **36.7** | −5.4% | 552,587 → 746,941 | 410 → 442 | 12,706 → 13,171 |
| 本町 | 36.0 → **34.1** | −5.3% | 586,804 → 762,566 | 358 → 390 | 19,211 → 19,641 |
| City Mode | 30.1 → **28.1** | −6.6% | 1,890,303 → 1,898,925 | — | 16,196 → 16,895 |

frame p95 は全地点で 33.5 → 33.6 ms（ほぼ不変）。JS heap は 318–448MB → 511–564MB に増えています（建物 13,829 棟ぶん）。**最大でも −6.6% で、大幅悪化はありません。**

## 13. 回帰確認（§28）

V2N / V3 の両方で確認しました。

| 項目 | V2N | V3 |
|---|---|---|
| 建物 hover / click（picking） | ✓ | ✓ |
| property card | ✓ | ✓ |
| ラベル表示数 | 20 | 20 |
| LOD2/LOD3（高 LOD） | 1,221 表示 / 1,221 抑制 | 1,221 / 1,221 |
| LandmarkHD | loaded・エラー無し | loaded・エラー無し |
| ROAD V3 | classMap 読み込み済み | classMap 読み込み済み |
| 道路 feature 数 | 3,492 | **3,492**（不変） |
| water / rail / parks（legacy residual） | **0** | **0** |
| ward 切替 | ✓（residual 0） | ✓（residual 0） |
| JS 例外 | 0 | 0 |

**検索について（正直な報告）**: 検索は V2N / V3 で**まったく同じ挙動**で、34C による回帰はありません。ただし確認の過程で**既存の仕様上の癖**が分かったので記録します。

`doSearch()` は固定リスト `OSAKA_SPOTS`（**梅田 / 大阪駅 / 難波 / なんば / 天王寺 / 本町 / 南港 / コスモスクエア の 8 件のみ**）に対して `findSpot()` で部分一致を取ります。一致規則が `s.name.includes(q) || q.includes(s.name)` のため:

| 入力 | 結果 |
|---|---|
| `新大阪駅` | **`大阪駅` に一致**（`'新大阪駅'.includes('大阪駅')` が true）→ **梅田へ飛ぶ** |
| `大阪城` | リストに無いため「該当する場所が見つかりません」 |
| `あべのハルカス` | 同上 |

34C では検索コードに一切触れていません（V2N / V3 とも同じ動作）。**建物 13,829 棟を回収しても検索対象は増えません**（検索はこの 8 件固定リストだけを見ているため）。改善は別ミッションの対象として §18 に挙げます。

## 14. 高 LOD との整合（§29）

回収した建物は OSM 由来なので、PLATEAU の LOD2/LOD3 はそもそも存在しません（**高 LOD geometry は 1 件も作っていません**）。既存 PLATEAU 建物の高 LOD は V3 でもそのまま機能します（上表の 1,221 / 1,221）。

## 15. production / protected（§31）

| | 結果 |
|---|---|
| `public/osaka_3d_buildings.html` | **未変更**（ビルド記録の sha256 と一致） |
| `public/osaka_3d_buildings.fullward-v3.html` | **未変更**（baseline hash と一致） |
| production に QA 用の仕組み | 入っていない |

## 16. Validator / テスト（§32/§33）

| フィールド | 値 |
|---|---|
| `brilliaTowerDojimaInvestigated` | **true** |
| `validMissingBuildingsRecovered` | **true** |
| `fabricatedBuildingCount` | **0** |
| `duplicateIncrease` | **0** |
| `buildingPositionMutation` | **0** |
| `projectionMutation` | **0** |
| `dragOpensCard` | **false** |
| `rotateOpensCard` | **false** |
| `wheelOpensCard` | **false** |
| `explicitClickOpensCard` | **true** |
| `productionModified` / `protectedModified` | **false / false** |
| 判定 | **PASS `BUILDING_COVERAGE_CLICK_UX_SUCCESS`** |

warning は §7 の「canonical に入っていない市内 PLATEAU 建物 41,357 棟（34C では未取り込み）」の 1 件です。

| テスト | 結果 |
|---|---|
| `npm test` | **1,891 / pass 1,876 / fail 0 / skip 15** |
| lifestyle-tab | 38 / pass 27 / **fail 0** / skip 11 |

### 既存テストの更新（2 件）

V3 を追加したことで、`BUILDINGS_VERSION_BASE` / `BUILDINGS_VERSION_LABEL` の行を完全一致で見ていた 2 件が落ちたため更新しました。**どちらも主旨（既定は V2N・V2N は `derived-v2-osmv2` だけを読む）は維持**し、その 2 点を明示的に assert し直しています。

| テスト | 変更 |
|---|---|
| `osm-fallback-v2-rebuild.test.js` §13/§14 | V3 を含む形へ。加えて `BASE_V2_OSMV2` の定義そのものを assert |
| `v2-dev-promotion.test.js` §1/§2/§24 | V3 を含む形へ。`['V3', 'V3 + RECOVERED'` の存在も assert |

## 17. 成果物

| 種別 | パス |
|---|---|
| 変更した HTML | `public/osaka_3d_buildings.ward-ux-v1.html`（**development のみ**） |
| fixture 追跡 | `tools/audit/building-fixture-trace.js` → `data/reports/building-fixture-trace.json` |
| 市内全域監査 | `tools/audit/building-coverage-citywide.js` → `data/reports/building-coverage-citywide.json` |
| PLATEAU 差分監査 | `tools/audit/plateau-missing-audit.js` → `data/reports/plateau-missing-audit.json` |
| landmark 監査 | `tools/audit/landmark-building-coverage.js` → `data/reports/landmark-building-coverage.json` |
| 回収ビルド | `tools/build-osm-fallback-v3.js` → `canonical/buildings-v2-osmv3/`・`derived-v2-osmv3/` |
| click QA | `tools/audit/click-intent-qa.js` → `data/reports/click-intent-qa.json` |
| 性能・回帰 | `tools/audit/coverage-click-perf.js` → `data/reports/coverage-click-perf.json` |
| validator | `tools/validate/building-coverage-click-ux.js` |
| テスト | `tests/building-coverage-click-ux.test.js`（`npm test` に登録済み） |

## 18. 次にやるべきこと（提案）

1. **raw PLATEAU の 41,357 棟の取り込み**（§7）。住之江・鶴見・北・此花に集中し、31,977 棟は周囲 75m に建物がありません。**今回の 13,829 棟より大きな改善**になりますが、既存 OSM fallback との入れ替え判断が必要です。
2. **検索の対象を広げる**（§13 の確認で判明）。現在は固定 8 件のリストで、`新大阪駅` が `大阪駅` に一致して梅田へ飛びます。建物名・駅名・ランドマーク名（回収した 548 棟の名前を含む）を引けるようにする価値があります。
3. V3 を production へ上げるかの判断（本ミッションでは cutover していません）。

---

**production / protected は変更していません。cutover もしていません。**
`[V3 + RECOVERED]` ボタンと `[COVERAGE QA]` で dev 上でご確認のうえ、production 反映をご判断ください。

`BUILDING_COVERAGE_CLICK_UX_SUCCESS`
