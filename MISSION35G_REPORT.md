# Mission 35G｜CITYWIDE V4 PRODUCTION CUTOVER

結論: **`CITYWIDE_V4_PRODUCTION_CUTOVER_SUCCESS`**

production の建物を **600,764 → 618,749（V4 REBUILT FINAL）** へ昇格しました。
35E / 35F で復旧した道路・鉄道・駅・水域・公園・地名ラベルは **共有データなので cutover 前から
production も読んでいました**（§2 の但し書きどおり「未変更」ではありません）。
protected（`fullward-v3.html`）は 1 バイトも変えていません。

cutover の前に **building-facts が V4 名前空間に無い** ことを見つけて塞ぎました。
そのまま切り替えていたら、property card の高さと階数が **全棟で消えて**いました（§3 の詳細）。

---

## 1. shared derived-data inventory（§2）

`tools/audit/production-shared-data-inventory.js` → `data/reports/production-shared-data-inventory.json`

production は 32U 以降 dev（`ward-ux-v1.html`）から **ビルドプロファイル 1 行だけ** 変えて生成されます。
つまり読む配信データのパスは HTML のリテラルで決まり、同じリテラルを持つ 2 つの HTML は同じファイルを読みます。

| 項目 | 区分 | dev | production | 備考 |
|---|---|---|---|---|
| buildings | **separate（namespace）** | 618,749 | 600,764 → **618,749** | `derived-v4-final` / `derived-v2-osmv2` |
| placement | **separate（namespace）** | 618,749 | 600,764 → **618,749** | 同上 |
| building-facts | **separate（namespace）** | 1,000 tile | 996 tile → **1,000 tile** | §3 で V4 用を新規生成 |
| roads | **shared** | 199,840 | 199,840 | 35E の復旧版 |
| rail | **shared** | 3,216 | 3,216 | 35F の復旧版 |
| stations | **shared** | 253 | 253 | 35F の復旧版 |
| water | **shared** | 823 | 823 | 35F の復旧版 |
| parks | **shared** | 4,194 | 4,194 | 35F の復旧版 |
| place labels | **shared** | 872 | 872 | 35F の復旧版 |
| highLOD | dev-only → **shared** | 10,223 | （無）→ **10,223** | パスは `derived-v2-osmv2/building-lod-high` 固定 |
| label datasets（33C） | dev-only → **shared** | 253 | （無）→ **253** | `labels/*-labels.json` |

**重要（§2）**: roads / rail / stations / water / parks / place labels は **cutover 前から production が
新しいデータを読んでいました**。35E・35F のレポートにもこの状態は記録済みです。
今回の cutover で新しく production に入ったのは **建物 V4・高 LOD・33C のラベル一式**、
および 33/34/35 系で dev に入っていた表示機能です。

---

## 2. pre-cutover snapshot（§3）

`tools/audit/production-cutover-snapshot.js --phase=pre|post`

| 項目 | cutover 前 | cutover 後 |
|---|---|---|
| 建物 namespace | `derived-v2-osmv2` | **`derived-v4-final`** |
| 建物数 | 600,764 | **618,749** |
| placement policy | DISPLAY 600,567 / SUPPRESS 1 / REVIEW 100 / EXEMPT 96 | DISPLAY 616,693 / SUPPRESS 553 / REVIEW 1,246 / EXEMPT 257 |
| building-facts | 996 tile | **1,000 tile** |
| roads | 199,840 | 199,840 |
| rail | 3,216 | 3,216 |
| stations | 253 | 253 |
| water | 823 | 823 |
| parks | 4,194 | 4,194 |
| place labels | 872 | 872 |
| highLOD | 10,223 | 10,223 |
| refined road surface | 29,942 | 29,942 |
| build profile | production | production |
| 駅ラベルの source | `derived/rail-stations.json` | `labels/station-labels.json`（33C の整理） |
| production sha256 | `21561f27acd37bef…` | **`9e50e4f952809355…`** |
| **protected sha256** | `85ca253f09ff839d…` | **`85ca253f09ff839d…`（不変）** |

**建物以外の配信データは cutover の前後で 1 件も動いていません。**

---

## 3. production building cutover（§4）

`tools/build-production-html.js`（変換は `LIVECITY_BUILD_PROFILE` の 1 行だけ）

- **600,764 → 618,749**（+17,985 = 35D で回収した棟数ちょうど）
- 既存 canonicalId の喪失 **0**（V2N の 600,764 件すべてが V4 に存在）
- 既存 geometry の書き換え **0**（16,237 件を標本抽出して厳密比較）
- 建物の重複 **0**（タイル行数と一意 canonicalId 数が一致）
- PLATEAU canonical 574,112 棟は V2N と V4 で完全に同一

### cutover 前に塞いだ欠陥: V4 に building-facts が無かった

property card の高さ・階数は `building-facts` が根拠（32S）で、
`CanonicalRuntime.getBuildingDataBase()` の下から読みます。つまり V4 へ切り替えると
`derived-v4-final/building-facts/` を見に行きますが、**そこには何もありませんでした**
（facts は 32S 以来 `derived-v2-osmv2` にしか無く、35D で V4 を作ったときに作られていない）。

`applyBuildingFacts()` は根拠を確かめられない値を出さない設計なので、
このまま切り替えると **全棟で高さと階数が消えます**（エラーにはならず、静かに欠ける）。

`tools/build-building-source-facts.js` を namespace 指定できるようにして V4 用を生成しました。
判定規則（`factOf`）は 32S のまま変えていません。

| | V2N | V4 |
|---|---|---|
| 棟数 | 600,764 | 618,749 |
| PLATEAU | 574,112 | **574,112（同一）** |
| OSM | 26,652 | **44,637（+17,985）** |
| measuredHeight | 523,923 | **523,923（同一）** |
| 階数あり | 466,818 | **466,818（同一）** |

PLATEAU 側の数値が 1 つも動いていないことが、判定規則を変えていない裏付けです。

---

## 4. recovered layer state（§6）

35E / 35F で検証済みの derived を **そのまま** production の正式 baseline として扱いました。
再生成はしていません（必要が無いため）。

| レイヤー | 件数 | 由来 |
|---|---|---|
| ROAD V3（canonical roads） | 199,840 / refined 29,942 | 35E（広域 PBF へ移行） |
| rail | 3,216 | 35F |
| stations | 253 | 35F |
| water | 823 | 35F |
| parks | 4,194 | 35F |
| place labels | 872（+ PLATEAU 町丁目で 974） | 35F |

値はすべて `tools/lib/canonical-baseline.js` の正本と一致しています。

---

## 5. 12 地点の production browser QA（§7/§14）

Edge headless + 実 GPU。`public/osaka_3d_buildings.html` を開くだけで取得（DevTools 操作なし）。
各地点で半径 350 m の正方形に 2,601 本の下向きレイを撃ち、被覆率を測りました。
スクリーンショット: `data/reports/v4-production-qa/*.jpg`

| 地点 | 建物 | 道路 | 鉄道 | 水域 | 公園 | ラベル | 駅 | card 高さ | card 階数 | 表示建物数 |
|---|---|---|---|---|---|---|---|---|---|---|
| 梅田 | 43% | 29% | 19% | 0% | 6% | 15 | 1 | ○ | × | 17,059 |
| 中之島 | 22% | 22% | 4% | 18% | 0% | 13 | 3 | ○ | ○ | 9,877 |
| 本町 | 35% | 33% | 5% | 0% | 0% | 8 | 1 | ○ | ○ | 17,284 |
| 難波 | 38% | 28% | 8% | 2% | 0% | 8 | 2 | ○ | ○ | 18,129 |
| 天王寺 | 33% | 22% | 13% | 0% | 4% | 11 | 1 | ○ | ○ | 14,860 |
| **新大阪** | 31% | 28% | **21%** | 0% | 0% | 2 | 1 | ○ | ○ | 13,537 |
| **東三国** | 38% | 26% | 2% | 0% | 1% | 2 | 1 | ○ | ○ | 14,439 |
| **淡路** | 40% | 21% | 4% | 0% | 0% | 3 | 1 | ○ | ○ | 21,946 |
| **上新庄** | 37% | 18% | 1% | 0% | 0% | 4 | 1 | ○ | ○ | 19,800 |
| **十三** | 44% | 20% | 5% | 0% | 0% | 6 | 1 | ○ | ○ | 21,855 |
| **柴島** | 27% | 18% | 3% | 6% | 0% | 4 | 2 | ○ | ○ | 18,326 |
| **旭区内** | 8% | 13% | 2% | 24% | 17% | 2 | 0 | × | × | 6,917 |

- **12 地点すべてで建物・道路・鉄道が出ています。** property card も 12/12 で出ます。
- 北側 7 地点（新大阪〜旭区内）が 35E / 35F の復旧の成果です。
- 旭区内は淀川の河川敷に面した地点なので水域 24% / 公園 17% で建物が少ないのが正しい姿です。
  card の高さ・階数が出ないのは、その地点で掴んだ棟が **根拠のある高さを持たない**ため
  （数値を作らない設計どおりの挙動）。
- fetch 監査: V4 tile 2,660 / **V1 建物 0 / V2N 建物 0** / 高 LOD（V2N 固定パス）52。
  古い建物 namespace を 1 度も読んでいません。

### 計測を 2 回直しました

1. **`offsetParent` で可視判定していた** — `#lc-topbar` は `position:fixed` なので
   見えていても `offsetParent` が null になり、「通常 UI が出ていない」と誤判定した。
   `getBoundingClientRect()` の大きさで見るよう修正。
2. **高 LOD の棟を建物として数えていなかった** — 高 LOD 棟と HD ランドマークは
   `usageCategory` を持たず別 group（`CR_buildingLodHigh` / `LandmarkHDLayer`）に入り、
   その棟の LOD1 の箱は抑制されます。祖先の group 名を見ていなかったため、
   **高 LOD が多い場所ほど建物が少なく見えて**いました
   （梅田 16% → **43%**、中之島 7% → **22%**、本町 6% → **35%**）。

---

## 6. Brillia の結果（§8）

`data/reports/v4-production-brillia.json` / `data/reports/v4-production-qa/brillia-target.jpg`

堂島のアンカー（34.69466 / 135.49236）から 177 m の位置に、**35D で回収した棟**があります。

| 項目 | 値 |
|---|---|
| canonicalId | `cg_bldg_osm_1241852536` |
| 出所 | OSM（35D の回収分・`VALID_FALLBACK`） |
| 高さ | **156.8 m** |
| 底面積 | 2,431.2 m² |
| OSM の `building:levels` | **49** |
| 区 | **大阪市北区** |
| 最寄駅 | 渡辺橋駅（直線距離 約250m） |
| 用途 | 宿泊施設（OSM の `building=hotel`） |

- geometry 表示: **あり**（スクリーンショットの橙色の塔）
- duplicate: **なし**（同一 canonicalId は 1 件のみ、重複 geometry 0）
- click / card / 区: **すべて正常**
- **名称は付けていません。** OSM に名前が無いので card の見出しは用途（宿泊施設）です。
  §8 のとおり名称を作り出すことはしていません。

ブリリアタワー堂島は 49 階・約 158.8 m なので、階数・高さ・位置のいずれも一致します。

---

## 7. duplicate audit（§11）

| 対象 | 増加 | 数え方 |
|---|---|---|
| 建物 | **0** | タイル行数と一意 canonicalId 数の差（建物はタイルを跨がない） |
| rail | **0** | 35F の監査（canonicalId で畳んでから比較） |
| water | **0** | 同上 |
| park | **0** | 同上 |

既存 canonicalId の喪失 **0** / 既存 geometry の書き換え **0** / 足した棟 **17,985**（35D と一致）。

---

## 8. 性能（§10）

| 地点 | FPS | frame p95 | draw calls | 三角形 | tiles | 35F dev |
|---|---|---|---|---|---|---|
| 梅田 | **52.4** | 33.5 ms | 239 | 460,374 | 240 | 52.4 |
| 新大阪 | **54.8** | 33.4 ms | 158 | 404,841 | 231 | 55.1 |
| 東淀川 | **59.9** | 16.8 ms | 202 | 351,211 | 240 | 59.9 |
| 淀川 | **55.3** | 33.3 ms | 198 | 414,929 | 240 | 49.8 |
| City Mode | **37.1** | 33.6 ms | 1,635 | 1,887,152 | 547 | 37.7 |

35F の dev 実測と**ほぼ同一**（最大差 City Mode の −0.6 fps、淀川は +5.5 fps）。
建物が 17,985 棟増えても描画負荷が変わらないのは、tile ごとに用途カテゴリで
mesh を統合しているためです。

---

## 9. regression（§9）

実ブラウザで全項目 OK・**JS 例外 0**。

| 項目 | 結果 |
|---|---|
| buildings | ○（V4 / 12 地点で描画） |
| highLOD | ○（`__BUILDING_LOD_DEBUG__` 応答あり） |
| labels | ○（12 地点で 2〜15 個） |
| roads | ○（ROAD V3・全地点） |
| rail | ○（全 12 地点） |
| water | ○ |
| parks | ○ |
| search | ○（`findSpot` あり） |
| hover | ○（`pickHit` あり） |
| click / property card | ○（12/12・区名も正常） |
| ward switching | ○（12 地点すべてで区を切り替えて描画） |
| City Mode | ○（出入り・全市表示） |
| canonical self check | **0**（不整合なし） |

**開発用 UI は production で 12 個すべて非表示**、通常 UI（top bar・検索）は表示。
`devUiVisible: []` / `productionUiMissing: []`。

---

## 10. validator（§11）

`tools/validate/v4-production-cutover.js` → **RESULT: PASS / errors 0 / warnings 0**

| 項目 | 値 |
|---|---|
| `canonicalPlateauGeometryMutation` | **0** |
| `existingCanonicalIdLoss` | **0** |
| `projectionMutation` | **false** |
| `roadV3LogicMutation` | **false** |
| `duplicateBuildingIncrease` | **0** |
| `duplicateRailIncrease` | **0** |
| `duplicateWaterIncrease` | **0** |
| `duplicateParkIncrease` | **0** |
| `protectedModified` | **false** |
| `productionMatchesDev` | **true**（プロファイル 1 行だけの差分） |
| `recoveredLayersPreserved` | **true** |
| `buildingFactsTilesV4` | **1,000** |

---

## 11. npm test（§13）

**2,113 tests / 2,098 pass / 0 fail / 15 skip**

最初は 13 件落ちました。**すべて「まだ cutover していない」という一時的な状態を
仕様として固定していた検査**で、実装の不具合ではありません。

32U 以降 production は dev からプロファイル 1 行だけ変えて作るので、
dev に入った機能のコードは cutover した瞬間に production のバイトにも入ります。
「production に `<機能名>` の文字列が無いこと」を検査していた 9 本はここで一斉に落ちました。

数字や文字列を書き換えて通すのではなく、**その検査が何を守りたかったのか** に戻しました。
判定は `tools/lib/production-invariants.js` に集約しています。

| 守りたかったこと | 直し方 |
|---|---|
| production に勝手な差分が入っていない | `productionIsDevWithProfileOnly()`（dev + プロファイル 1 行と完全一致） |
| 開発用 UI が production で見えない | `devUiIsGated()`（非表示 CSS 規則 + トグルが `canonical-runtime-*` の箱の中） |
| QA モードが既定で動いていない | `let qaMode = false` / `let viewMode = 'high'` / 推定屋根 `enabled = false` |
| protected は 1 バイトも変わらない | そのまま（hash 比較を維持） |

落ちた 13 件の内訳:

| テスト | 旧 | 新 |
|---|---|---|
| `[32U] production の既定構成` | `buildingsVersion = 'V2N'` | `'V4'` + `BASE_V4_FINAL` |
| `[33D §23]` `[33E]` `[34A]` production 未変更 | 「33D/33E/34A のコードが無い」 | 「勝手な差分が無い」＋ 開発用トグルが箱の中 |
| `[34A §22]` `[34B §22]` `[34C §15]` `[34D §34]` QA は dev だけ | 「QA の入口の文字列が無い」 | 「既定 off」＋「トグルが箱の中」 |
| `35A §33 推定屋根` | 「コードが無い」 | 「既定 off・明示的に選んだときだけ有効」 |
| `35D` / `35E §14` / `35F` production は V2N | 「V2N のまま」 | 「V4 へ昇格」＋ V2N の 600,764 が今も不変 |
| `[33B §5/§6/§7] ラベル規則` | 下記 | 下記 |

### 33B のラベル規則は **dev でも既に合っていませんでした**

`LABEL_RULES_33A` の 5 本のうち 1 本
（`item.importance === 'MAJOR'` でランドマークの優先度を決める式）が、
**dev に対しても production に対しても不一致**でした。
33D §15 で「優先度は名前や importance ではなく tier で決める」に変わっていたためです。

production が 32U 版で凍結されていたので、**この検査だけが古い production を見て通り続けて**いました。
cutover で production が dev と同じになった結果、初めて表面化したものです。
現在の式（`item.tier === 'S' ? 0 : item.tier === 'A' ? 2.5 : 3`）へ更新しました。

---

## 12. protected hash before / after（§11）

| | sha256 |
|---|---|
| cutover 前 | `85ca253f09ff839d9b4682441a65333511b31c53b38b0db9af504f007e8b0176` |
| cutover 後 | `85ca253f09ff839d9b4682441a65333511b31c53b38b0db9af504f007e8b0176` |

**完全に同一**。最終更新は 2026-08-08 で、このミッションでは開いてもいません。

---

## 13. final production state（§12）

| 項目 | 値 |
|---|---|
| production final building count | **618,749** |
| build source | **PLATEAU canonical V2（574,112）+ V4 rebuilt fallback（44,637）** |
| build profile | `production` |
| 建物 namespace | `map-data/osaka-city/derived-v4-final` |
| north-source recovery | **ACTIVE**（roads / rail / stations / water / parks / place labels） |
| placement | DISPLAY 616,693 / SUPPRESS 553 / REVIEW 1,246 / EXEMPT 257 |
| 高 LOD | 10,223 棟（実 LOD2/LOD3） |
| 道路 | ROAD V3（canonical 199,840 / refined 29,942） |
| protected | 未変更 |

---

## 14. known limitations

1. **回収した棟の階数が card に出ません。** 35D の回収 index は OSM の `building:levels`
   （ブリリア相当なら 49）を持っていますが、canonical の属性には渡っておらず、
   facts の階数は 0 のままです。高さは OSM の `height` タグから出ています。
   card は「根拠のある値しか出さない」設計なので欠けても嘘は出ませんが、
   出せる情報を取りこぼしています。直すなら回収時に levels を canonical 属性へ渡す必要があります。
2. **高 LOD は V2N 名前空間に固定です**（`derived-v2-osmv2/building-lod-high`）。
   建物版に依存しないパスなので V4 でもそのまま読めていますが、
   名前空間の意味としては整理されていません。
3. **35F の known gaps はそのまま引き継いでいます**: 市域外のラベル（地名 387 件 / 駅 13 件）、
   車両基地を canonical で区別できないこと、プラットフォームを取り込んでいないこと。
4. **旭区内の QA 地点は河川敷寄り**で、建物 8% と低く出ます。区内の市街地を測りたい場合は
   別の地点を足す必要があります（区ポリゴンの中であることは確認済み）。
5. **検査の作りに 1 つ弱点が残っています。** 「production に文字列が無いこと」型の検査は、
   dev と production が乖離している間だけ通り、cutover で一斉に落ちます。
   今回 `production-invariants.js` へ寄せましたが、同じ書き方の検査が新しく足されると
   また同じことが起きます。

---

## 15. 成果物

**新規**

| ファイル | 役割 |
|---|---|
| `tools/audit/production-shared-data-inventory.js` | §2 dev / production の共有データ一覧 |
| `tools/audit/production-cutover-snapshot.js` | §3/§12 cutover 前後を同じ関数で記録 |
| `tools/audit/v4-production-qa.js` | §7/§8/§9/§10/§14 production の実ブラウザ QA |
| `tools/validate/v4-production-cutover.js` | §11 検証 |
| `tools/lib/production-invariants.js` | production の不変条件の正本 |
| `tests/v4-production-cutover.test.js` | §13 テスト（19 件） |

**変更**

| ファイル | 変更 |
|---|---|
| `public/osaka_3d_buildings.html` | **cutover**（dev からプロファイル 1 行だけ変えて再生成） |
| `tools/build-building-source-facts.js` | namespace 指定に対応（V4 用 facts を生成） |
| `tools/validate/city-labels-production-cutover.js` | 33D で変わったラベル優先度の式へ更新 |
| `tests/` 10 ファイル | 「cutover 前の状態」を固定していた検査を不変条件へ |
| `package.json` | テストを登録 |

**データ**

`derived-v4-final/building-facts/`（1,000 tile・新規）

---

## 16. STOP

§17 のとおりここで止まります。追加機能は実装していません。

production 画面のスクリーンショット:

- `data/reports/v4-production-qa/umeda.jpg` — 梅田（property card に高さ 162.7 m・最寄駅・区）
- `data/reports/v4-production-qa/city-mode.jpg` — City Mode（北部の神崎川・新大阪まで表示）
- `data/reports/v4-production-qa/brillia-target.jpg` — 堂島の回収棟（156.8 m・49 階相当）
- ほか 12 地点ぶん

**`CITYWIDE_V4_PRODUCTION_CUTOVER_SUCCESS`**
