# Mission 35J｜35I VISUAL PRODUCTION CUTOVER

結論: **`LIVE_CITY_VISUAL_35I_PRODUCTION_SUCCESS`**

35I で検証した方向非依存の visual を production へ反映しました。
**変わったのは見た目だけ**で、配信データは cutover の前後で 1 項目も動いていません。
protected（`fullward-v3.html`）は 1 バイトも変えていません。

---

## 1. production visual cutover の内容（§1/§11）

既存のビルド構成をそのまま使いました。
`tools/build-production-html.js` が dev（`ward-ux-v1.html`）から
**`LIVECITY_BUILD_PROFILE` の 1 行だけ**を書き換えて production を生成します。手作業の別実装はありません。

production へ入った差分は **35H + 35I の visual 実装のみ**です。差分 445 行のキーワード内訳:

`CR_DEPTH` 22 / `heightShade` 9 / `wallShade` 6 / `DEPTH_TUNINGS` 6 / `applyLightStyle` 5 /
`shadeByte` 4 / `__VISUAL_*` 4 / `setVisualProfile`・`setLightLevel`・`setDepthTuning` 各 3 /
`buildRoadStyles` 3 / `CR_VIVID_DEPTH` 3 / `CR_USAGE_WHITEN_DEPTH` 3 / `CR_FILL_COLOR_DEPTH` 3 /
`COL_DEPTH` 2 / `vertexColors` 1 / 開発用トグル 3

差分に `map-data` のパスは **0 件**、`canonicalId` / `projection` / `placement` を変える行も
ありません（`positions.push` に出た差分は屋根ループの改行のみで、引数 `(v.x, h, v.y)` は同一）。

---

## 2. 反映した 35I のパラメータ（§2）

§2 で指定された値を **再調整せずそのまま**使っています。
production の式を実際に呼んで確かめた実効値:

| 項目 | 値 | §2 の指定 |
|---|---|---|
| 壁（太陽に正対） | **0.960** | 0.96 ✓ |
| 壁（真横） | **0.885** | 0.885 ✓ |
| 壁（背面） | **0.810** | 0.81 ✓ |
| 屋根（基準） | 1.000 | — |
| 接地（30 m の棟） | **0.815** | ≈0.815 ✓ |
| 接地（180 m の棟） | **0.772** | ≈0.772 ✓ |
| hemisphere | **0.58** | 0.58 ✓ |
| sun | **1.45** | 1.45 ✓ |
| fill | **0.55** | 0.55 ✓ |
| fill の色 | **0xc6ced6** | 0xc6ced6 ✓ |
| exposure | **1.01** | 1.01 ✓ |

起動時の実ブラウザ実測も `{"exposure":1.01,"hemi":0.58,"sun":1.45,"fill":0.55}` / `DEPTH` / `35I` で一致。

---

## 3. dev / production の差分（§5/§11）

| | dev | production |
|---|---|---|
| `LIVECITY_BUILD_PROFILE` | `development` | **`production`** |
| visual profile | DEPTH | DEPTH |
| 調整 | 35I | 35I |
| LIGHT | STANDARD | STANDARD |
| 建物 | V4（618,749） | V4（618,749） |
| `[VISUAL]` / `[LIGHT]` / `[TUNE]` トグル | 表示 | **非表示** |

差分はビルドプロファイルの 1 行だけです。開発用の切替（CURRENT / 35H へ戻す入口）はコード上に残りますが、
`#canonical-runtime-road-v2-controls` の中にあるため production の CSS
（`html[data-livecity-build="production"] [id^="canonical-runtime-"]{display:none !important}`）で隠れます。
実ブラウザで 15 個の開発用 ID を確認し、**表示されているものは 0 件**、通常 UI（top bar・検索）は表示。

### 検査を 1 つ厳しくしました

`devUiIsGated()` は「開発用トグルの箱の中にあるか」しか見ておらず、
**見つからない id を黙って通していました**。35J で `#canonical-runtime-status` が
「箱の外」と判定されたのを機に、隠れ方 3 通り（接頭辞の CSS 規則 / 名指しの CSS / 箱の中）を
すべて見るよう直したところ、`visual-*-toggle` の 3 つが
**id を変数で渡していたため静的には確認できていない**ことが分かりました（実際には隠れています）。
id を直書きに変えて、検査が実際に効くようにしています。

---

## 4. direction QA（§6/§7/§13）

5 地点・主要 3 地点は 4 方向（0° / 90° / 180° / 270°）から確認。
描画直後に `gl.readPixels` で **実際に描かれた画素**を読んでいます。
スクリーンショット: `data/reports/visual-production-qa/*.jpg`

| 地点 | 0° | 90° | 180° | 270° | 建物の方向差 比 |
|---|---|---|---|---|---|
| 梅田 | 0.661 | 0.645 | **0.590** | 0.663 | **1.110** |
| 本町 | 0.725 | 0.702 | **0.689** | 0.725 | **1.097** |
| 難波 | 0.697 | 0.705 | **0.685** | 0.722 | **1.108** |
| 新大阪 | — | — | 0.697 | — | — |
| 東淀川 | — | — | 0.692 | — | — |
| City Mode | 0.857（建物 0.769） | | | | |

§7 の確認項目:

| 項目 | 結果 |
|---|---|
| dark-facing view readable | **true**（最暗 0.590、建物 0.568。下限 0.35） |
| bright-facing view not washed out | **true** |
| white clipping | **0.0000**（実質ゼロ） |
| building color retained | **true**（建物の最小彩度 0.174、無彩色に潰れていない） |
| contact depth retained | **true**（`baseDarken` 0.83 / 30 m 0.815 / 180 m 0.772） |
| high-rise mass retained | **true**（`massDarken` 0.07、屋根は基準 1.00） |
| 暗い方向で青へ寄らない | 青寄り 0.207（35I dev と同値） |

**§13 の指定どおり、本町は 35H で最も暗かった南向き（180°）を含めています。**
dev（35I）の同地点・同方向が 0.689、production も **0.689** で一致しました。
梅田 180° も dev 0.568 / production 0.568 と同値です。

---

## 5. performance（§9）

| 地点 | FPS | frame p95 | draw calls | 三角形 |
|---|---|---|---|---|
| 梅田 | 46.1 | 33.5 ms | 303 | 589,002 |
| 新大阪 | 53.7 | 33.4 ms | 219 | 395,963 |
| City Mode | 33.6 | 33.7 ms | 1,686 | 1,895,959 |

dev（35I）の梅田は 49.8 fps で、production は 46.1 fps（**−7.4%**）。
ただし読み込み済みタイルが違い（三角形 445,988 と 589,002 で production のほうが 32% 多い）、
同じ場面を比べたものではありません。**三角形あたりで見ると production のほうが軽い**ので、
visual による負荷増ではなく測定時のタイル状態の差です。

35H → 35I の調整自体は、同一条件で測った 35I の実測で
FPS −0.6%（むしろ速い）・draw call と三角形は完全に同数であることを確認済みです。

---

## 6. regression（§8）

実ブラウザで全項目 OK・**JS 例外 0**。

| 項目 | 結果 |
|---|---|
| buildings / LOD1 | **962 mesh すべてに明暗が入っている**（962/962） |
| LOD2 / LOD3（高 LOD） | **129 mesh** 描画 |
| LandmarkHD | **5 mesh** 描画 |
| roads | ROAD_V3 |
| rail / water / parks | 描画あり |
| labels | ok（18 個表示） |
| search / hover | ok |
| click / property card / 区名 | ok |
| ward switching | 5 地点・計 12 方向すべてで実施 |
| City Mode | 出入り・全市表示 ok |
| canonical self check | **0** |

---

## 7. data integrity（§10）

| 項目 | 値 |
|---|---|
| `buildingCount` | **618,749** |
| `canonicalGeometryMutation` | **0** |
| `canonicalIdMutation` | **0** |
| `projectionMutation` | **0** |
| `placementMutation` | **0**（DISPLAY 616,693 / SUPPRESS 553 / REVIEW 1,246 / EXEMPT 257） |
| `roadMutation` | **0**（199,840） |
| `railMutation` | **0**（3,216） |
| `waterMutation` | **0**（823） |
| `parkMutation` | **0**（4,194） |
| `stationMutation` | **0**（253） |
| `protectedModified` | **false** |

cutover の前後スナップショットを比較して、**配信データは 1 項目も動いていない**ことを確認しました
（`dataUnchanged: true`）。建物 namespace・facts tile 数・高 LOD 棟数・refined road surface も同値です。

validator: `tools/validate/visual-production-cutover.js` → **RESULT: PASS / errors 0 / warnings 0**

---

## 8. protected hash before / after（§14-8）

| | sha256 |
|---|---|
| cutover 前 | `85ca253f09ff839d9b4682441a65333511b31c53b38b0db9af504f007e8b0176` |
| cutover 後 | `85ca253f09ff839d9b4682441a65333511b31c53b38b0db9af504f007e8b0176` |

**完全に同一**。protected に `DEPTH_TUNINGS` / `CR_DEPTH` / `CR_FILL_COLOR_DEPTH` は入っていません。

production HTML の hash: `9e50e4f952809355…`（35G 版）→ **`27e7813abf89…`**（35J 版）

---

## 9. npm test（§12）

**2,166 tests / 2,151 pass / 0 fail / 15 skip**

35J 用に 15 件を追加。cutover により 3 件が落ちたので、意図に戻して直しました。

| テスト | 旧 | 新 |
|---|---|---|
| `35H production / protected を触っていない` | 「production に visual が入っていない」 | 「production がビルド記録のまま」＋「protected に入っていない」 |
| `35I production に 35I の調整が入っていない（dev 限定）` | 同上 | 「production が **35I の値そのもの**で動いている」 |
| `35G 実測: cutover の前後で変わったのは建物だけ` | generic な `-pre/-post` を参照 | ミッション名付きファイルを参照 |

3 件目は実装側の問題でした。`production-cutover-snapshot-{pre,post}.json` は
**「直近の cutover」の 1 枠しか無く**、次の cutover が上書きすると過去のミッションの検査が
参照先を失います。スナップショットに `--mission=` を付けて
`production-cutover-snapshot-35g-pre.json` のように残すようにし、35G の記録も復元しました。

---

## 10. 最終的な production の状態（§14-10）

| 項目 | 値 |
|---|---|
| build profile | `production` |
| 建物 | **618,749**（V4 REBUILT FINAL） |
| 建物の出所 | PLATEAU canonical V2 **574,112** + V4 rebuilt fallback **44,637** |
| north-source recovery | **ACTIVE**（roads 199,840 / rail 3,216 / stations 253 / water 823 / parks 4,194 / 地名 872） |
| visual profile | **DEPTH** |
| visual 調整 | **35I** |
| LIGHT | **STANDARD** |
| 壁 | 0.960 / 0.885 / 0.810（屋根 1.000） |
| 接地 | 30 m 0.815 / 180 m 0.772 |
| 光 | hemi 0.58 / sun 1.45 / fill 0.55（0xc6ced6）/ exposure 1.01 |
| 高 LOD | 10,223 棟（実 LOD2/LOD3） |
| 影 | 建物への dynamic shadow なし（頂点カラーで接地・量感を表現） |
| 開発用 UI | 非表示 |
| protected | 未変更 |

---

## 11. known limitations

1. **性能の絶対値は dev と直接比べられません。** production 46.1 fps / dev 49.8 fps ですが、
   読み込み済みタイルが違います（三角形 589,002 と 445,988）。
   同一条件の比較は 35I で実施済み（−0.6%・draw call と三角形は同数）。
2. **CURRENT / 35H へ戻す入口はコードに残しています。** production では既定にならず UI も出ませんが、
   バイトとしては含まれます。整理するなら別ミッションで行うのが安全です。
3. **`production-cutover-snapshot-{pre,post}.json` は今後も「直近の 1 枠」です。**
   今回からミッション名付きも書くようにしましたが、`--mission=` を付け忘れると
   generic な枠だけが残ります。
4. **City Mode は 1 方向のみ測定**（真上に近い俯瞰では方位を変えても壁の見え方がほぼ変わらないため）。
   §6 の必須地点としては撮影・確認済みです。
5. **夕方・夜モードには 35I の調整は効きません。** canonical の露出制御（`applyCanonicalExposure`）が
   昼の模型スタイル専用のため、時間帯を変えると従来の見え方に戻ります。

---

## 12. 成果物

**新規**

| ファイル | 役割 |
|---|---|
| `tools/audit/visual-production-qa.js` | §6〜§9 production の方向 QA・回帰・性能 |
| `tools/validate/visual-production-cutover.js` | §10/§12 検証 |
| `tests/visual-production-cutover.test.js` | 35I の値・データ不変・protected（15 件） |

**変更**

| ファイル | 変更 |
|---|---|
| `public/osaka_3d_buildings.html` | **cutover**（dev からプロファイル 1 行だけ変えて再生成） |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 開発用トグルの id を直書きに（静的検査を効かせるため）/ コメント更新 |
| `tools/lib/production-invariants.js` | `devUiIsGated` が隠れ方 3 通りを見るように。見つからない id を黙って通さない |
| `tools/audit/production-cutover-snapshot.js` | visual の記録を追加 / `--mission=` でミッション別に保存 |
| `tests/` 3 ファイル | cutover 後の意図へ更新 |

---

## 13. STOP

§16 のとおりここで止まります。追加機能は実装していません。

production のスクリーンショット（`data/reports/visual-production-qa/`）:

| 見どころ | ファイル |
|---|---|
| **本町・南向き**（35H で最も暗かった方向） | `honmachi.az180.jpg` |
| 本町・他 3 方向 | `honmachi.az0.jpg` / `az90.jpg` / `az270.jpg` |
| 梅田・4 方向 | `umeda.az0.jpg` / `az90.jpg` / `az180.jpg` / `az270.jpg` |
| 難波・4 方向 | `namba.az*.jpg` |
| 新大阪 / 東淀川 | `shin-osaka.az180.jpg` / `higashiyodogawa.az180.jpg` |
| City Mode | `city-mode.jpg` |

**`LIVE_CITY_VISUAL_35I_PRODUCTION_SUCCESS`**
