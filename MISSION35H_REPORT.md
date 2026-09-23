# Mission 35H｜LIVE CITY VISUAL DEPTH & MASS

結論: **`LIVE_CITY_VISUAL_DEPTH_SUCCESS`**

LOD1 の箱の **geometry を 1 mm も変えずに**、面ごとの陰影・接地の陰・高層の量感を与えました。
方式は **頂点カラーを build 時に焼く**もので、shadowMap を使わないため
**draw call も三角形数も増えず、618,749 棟でも性能は変わりません**（実測 0% / −0.3% / −1.6%）。

development だけの変更です。production（`osaka_3d_buildings.html`）と
protected（`fullward-v3.html`）は 1 バイトも触っていません（§28）。

---

## 1. lighting 変更（§4/§5/§18/§21）

canonical 表示中の光の正本は `CR_STYLE` で、`applyCanonicalExposure()` が毎フレーム当て直しています。
35H の変更はここに入れました（`applyTimeOfDay` が書いた値も毎フレーム上書きされるため）。

| | exposure | hemi | sun | fill | sun/hemi |
|---|---|---|---|---|---|
| CURRENT（33A） | 0.93 | 0.74 | 1.28 | 0.26 | 1.73 |
| **DEPTH / STANDARD** | **1.02** | **0.50** | **1.62** | **0.20** | **3.24** |
| DEPTH / LOW | 0.97 | 0.62 | 1.40 | 0.24 | 2.26 |
| DEPTH / STRONG | 1.06 | 0.40 | 1.82 | 0.16 | 4.55 |

**平らに見えていた原因は hemisphere が強すぎたこと**です。hemisphere 0.74 に対し sun 1.28 だと、
太陽に背を向けた壁も環境光だけでかなり明るく、屋根・明るい壁・暗い壁がほぼ同じ調子になります。
hemisphere を 0.74 → 0.50 に下げて主光の比率を 1.73 → 3.24 へ上げ、
落ちた明るさは exposure 0.93 → 1.02 で取り戻しました（§18 白飛びさせない）。

- 光の向きは **34B のまま**（方位 236°＝南西 / 仰角 47°）。§4 の「仰角 35〜55°」を満たします。
- §5 影側を黒く潰さないため hemisphere（0.50）と fill（0.20）は残しています。
- §21 の 3 段階は dev で比べるためのもので、**production 候補は STANDARD**。

---

## 2. material 変更（§6/§7）

LOD1 は従来どおり `MeshLambertMaterial`（lighting が効く）・`DoubleSide`・
用途カテゴリ × band で共有。変えたのは 2 点だけです。

1. `vertexColors: depthEnabled()` — 面ごとの明暗を掛けられるようにした
2. 用途色の彩度と白寄せ

| | 彩度 | 明度 | 白寄せ far / mid / near |
|---|---|---|---|
| CURRENT（33A） | ×1.24 | ×1.03 | 0.46 / 0.20 / 0.06 |
| **DEPTH** | **×1.46**（+18%） | ×1.03（据え置き） | **0.30 / 0.12 / 0.04** |

- **色相は一切動かしていません**（`crVivid` は 33A のまま。彩度と明度だけを持ち上げる関数）。
- 明度を上げないのは、頂点カラーで壁を落とすぶん **屋根＝基準面の明るさを今のまま保つ**ため。
  material 色を持ち上げると白系の用途色が飽和して §8/§18 の白飛びを招きます。
- 白寄せを弱めたのは §8/§19 の対策（下記 §6）。

---

## 3. LOD1 shading 方式（§3/§6/§12）

**geometry は変えていません。** `pushExtrude()` が積む座標の式は 1 文字も変えず、
**同じ並びで頂点カラーを 1 本追加**しただけです（正規化 Uint8・3 byte/頂点）。

| 面 | 倍率 | 出どころ |
|---|---|---|
| 屋根 | **1.00**（基準） | §12 wall より明るい＝基準面 |
| 太陽に正対する壁 | **0.93** | 壁の外向き法線と太陽の水平成分の内積 |
| 真横を向く壁 | **0.815** | 同上（なめらかに補間） |
| 太陽に背を向ける壁 | **0.70** | 同上 |

**倍率の上限を 1.0 にした理由**: 頂点カラーは 0..1 しか表せず、
「屋根を今より明るく」しようとすると material 色を持ち上げることになり白飛びします。
そこで **屋根を基準（1.0）にして壁を暗くする**設計にしました。
全体の明るさは exposure と palette で作ります。§6 の目安（屋根 1.08–1.15 / 明壁 0.95–1.05 /
暗壁 0.72–0.88）と同じ比率関係を、基準を屋根側に置き換えて実現しています。

### ここで 1 つバグを見つけました

最初の実装は壁の向きと `CR_SUN_DIR`（3 次元）の内積を取っていました。
太陽は仰角 47° なので水平成分が cos47°=0.68 しかなく、内積が ±1 に届かず
**どの壁も wallLit / wallDark に到達しません**でした（実測 0.89 / 0.74 で、差が 0.15 しか開かない）。
壁の向きは水平面の話なので、太陽も **水平成分だけを単位化**して比べるよう直し、
0.93 / 0.815 / 0.70 と意図どおりの 3 段階になりました。

---

## 4. contact shadow 方式（§9/§10/§22/§26）

**shadowMap は使いません。** 618,749 棟に dynamic shadow を掛けると性能が壊れるため、
§9 の候補のうち **「E. ground proximity darkening」＋「B. height-based gradient」** を採りました。
どちらも頂点カラーに焼くので **描画負荷がゼロ**です。

| 効果 | 式 | 値 |
|---|---|---|
| 接地の陰 | 地面から `baseM` まで `baseDarken` へ落とす | 9 m まで / 0.80 |
| 量感 | 高い棟ほど下半分を追加で落とす | 最大 −10%（高さ 120 m で最大） |

- 30 m の棟: 足元 0.78 → 上端 1.00
- 180 m の棟: 足元 **0.72** → 上端 1.00（高いほど足元が沈み、量感が出る）
- 上端では両方の補正が消えるので、**屋根は常に基準のまま**です。

canonical の建物 mesh は従来から `castShadow = false; receiveShadow = false` で、
real shadow は元々掛かっていません。§10 の「全建物 dynamic shadow は禁止」は
アーキテクチャとして既に満たされており、35H はそこへ触れていません。

---

## 5. building color 変更（§7/§8）

上記 §2 のとおり彩度 +18%・明度据え置き。色相は不変。

§8 の「白系建物が背景へ溶ける」問題には 2 方向から効きます。

1. **壁が 0.70〜0.93 に落ちる**ので、地表（0xebede6）より明確に暗くなる
2. **白寄せを 0.46 → 0.30 に弱めた**ので、灰色・白系の用途色（industrial / other）が
   遠景でも用途色を保つ

完全な `#ffffff` は使っていません（建物白の基準は 0xeef0ec のまま）。

---

## 6. ground / road / water / green 変更（§14/§15/§16/§17/§19）

| 対象 | CURRENT | DEPTH | 狙い |
|---|---|---|---|
| 水域（河川） | `0x63bfe4` | **`0x3fb3e8`** | §14 明確な cyan-blue。彩度を上げ、色相は動かさない |
| 水域（港湾） | `0x55a9d0` | **`0x2f9cd2`** | 同上 |
| 公園（実公園） | `0x9bd589` | **`0x86cf6d`** | §15 彩度を上げる。建物より目立たせない |
| 公園（緑地） | `0x8fcd7b` | **`0x79c65d`** | 同上 |
| 草地 | `0xc9e7b6` | **`0xbfe3a6`** | 同上 |
| 道路 | `0x979ea9` | **`0x8b929e`** | §16 blue-gray 寄りに落として建物との差を作る |
| 鉄道 | 変更なし | 変更なし | 既に道路と明確に別 |
| 背景 / 地表 | 変更なし | 変更なし | 下記 |

**ground / 背景は変えていません**（背景 `0xf6f7f3` / 地表 `0xebede6`）。
§17 は「背景を明るくする。ただし white building との contrast が残ること」ですが、
現状すでにほぼ白に近く、これ以上明るくすると白系建物との差が消えます。
明るさは exposure（0.93 → 1.02）で全体に足し、建物側は壁を落として差を作る方針にしました。

**§19 の「遠景で白い塊にならない」は、白寄せを 0.46 → 0.30 にしたのが主因の対策です。**
City Mode の before/after を見ると差は明確で、CURRENT ではほぼ真っ白だった市域が、
DEPTH では街区の密度・河川・緑・道路網が読めるようになっています。

---

## 7. exposure / tone mapping（§18）

`ACESFilmicToneMapping` は変更せず、exposure だけを **0.93 → 1.02** に上げました。

白飛びしていないことを実測で確認しています（near band・全 10 用途カテゴリ）:

| 指標 | 値 |
|---|---|
| 飽和（どれかのチャンネルが 1.0）した用途色 | **0 / 10** |
| 最大チャンネル値 | **0.953**（commercial の R） |

`commercial` が 0.953 で最も高く、それでも 1.0 には達していません。

---

## 8. CURRENT vs 35H DEPTH（§23/§24/§29）

7 地点 × 2 視点（俯瞰 52° / 斜め 34°）+ City Mode を、**完全に同じカメラ**で撮っています。
`data/reports/visual-depth-qa/<site>.<view>.<profile>.jpg`（全 30 枚）

| 地点 | CURRENT 色付き mesh | DEPTH 色付き mesh | DEPTH の明暗 min / mean / max |
|---|---|---|---|
| 梅田 | 0 / 633 | **514 / 514** | 129 / 197.4 / 255 |
| 中之島 | 0 / 614 | **492 / 492** | 129 / 197.8 / 255 |
| 本町 | 0 / 786 | **752 / 752** | 129 / 197.6 / 255 |
| 難波 | 0 / 806 | **772 / 772** | 129 / 197.4 / 255 |
| 天王寺 | 0 / 992 | **958 / 958** | 129 / 197.3 / 255 |
| 新大阪 | 0 / 1,185 | **1,185 / 1,185** | 129 / 197.2 / 255 |
| 東淀川 | 0 / 1,206 | **1,185 / 1,185** | 131 / 196.9 / 255 |
| City Mode | 0 | **2,456 / 2,456** | 129 / 199.1 / 255 |

- **DEPTH では建物 mesh の 100% に明暗が入り、CURRENT では 1 つも入りません。**
- 明暗の幅は **129〜255**（0.51〜1.00）。屋根が基準、最も暗いのは高層の足元。
- 分布（梅田・俯瞰）は `[0,0,0,0,0, 28182, 30668, 38523, 18708, 44817]` で、
  5 段階以上に散っています＝1 色のベタ塗りになっていません。

§24 の比較項目:

| 見る項目 | 結果 |
|---|---|
| building depth | 壁が向きで 3 段階に分かれ、隣り合う棟の面が区別できる |
| building separation | 暗い壁と明るい壁が接するので、重なった棟の境界が読める |
| roof readability | 屋根が常に最も明るい面になり、上面が識別できる |
| high-rise mass | 足元 0.72（180 m 級）→ 上端 1.00 の階調で、長い箱に見えない |
| street readability | 道路を暗くし、建物の足元を落としたので街路が溝として読める |
| water contrast | 彩度を上げ、City Mode でも河川が一目で追える |
| green contrast | 彩度を上げたが建物より前に出ない |
| overall brightness | exposure +0.09 で全体は明るいまま |
| white clipping | 飽和した用途色 **0 件**（最大 0.953） |

---

## 9. performance（§25/§26）

| 地点 | CURRENT | DEPTH | 低下 | draw calls | 三角形 |
|---|---|---|---|---|---|
| 梅田 | 32.1 fps | **32.1 fps** | **0%** | 270 → 270 | 471,289 → 471,289 |
| 新大阪 | 34.2 fps | **34.3 fps** | **−0.3%** | 183 → 183 | 406,981 → 406,981 |
| City Mode | 25.6 fps | **26.0 fps** | **−1.6%** | 469 → 462 | 1,821,571 → 1,821,271 |

**draw call も三角形数も 1 つも増えていません。**
頂点カラーは attribute を 1 本足すだけで、mesh も geometry も増やさないためです。
メモリは +3 byte/頂点（position の 12 byte に対して +25%）。

§25 の目標（低下 ≤10%、理想 ≤5%）に対し **最大 0%**。理想値を満たしています。

### City Mode は測り直しました

最初の一連の QA では City Mode が **−11.4%** と出ました。
ただし同時に **draw call が 2,917 と 3,012 で 95 も違い**、三角形も違っていました。
2 つのプロファイルが別のタイミングで測られ、**読み込み済みタイル数が揃っていなかった**ためです。

City Mode に入ったまま profile を `DEPTH → CURRENT → DEPTH → CURRENT` と交互に切り替えて
同じ場面で測り直した結果が上表で、**−1.6%（DEPTH のほうがわずかに速い＝誤差範囲）**でした。
条件を揃えない測定も `uncontrolled` として記録に残しています。

---

## 10. highLOD regression（§13）

| 項目 | 結果 |
|---|---|
| 高 LOD（PLATEAU LOD2/LOD3）の mesh | **133 枚**（描画されている） |
| LandmarkHD の mesh | **5 枚** |
| LOD1 用の補正が高 LOD へ漏れた数 | **0** |
| `__BUILDING_LOD_DEBUG__` | 応答あり |

高 LOD と HD ランドマークは `CR_buildingLodHigh` / `LandmarkHDLayer` という別 group にあり、
LOD1 用の頂点カラーは `usageCategory` を持つ mesh にしか付きません。
§13 のとおり「LOD2/3 は surface normal が既に細かいので LOD1 用補正を掛けない」を満たしています。

---

## 11. data integrity（§27）

| 項目 | 値 |
|---|---|
| `buildingCount` | **618,749** |
| `canonicalGeometryMutation` | **0** |
| `canonicalIdMutation` | **0** |
| `projectionMutation` | **0** |
| `placementMutation` | **0**（DISPLAY 616,693 / SUPPRESS 553 / REVIEW 1,246 / EXEMPT 257） |
| `roadGeometryMutation` | **0**（199,840） |
| `railGeometryMutation` | **0**（3,216） |
| `waterGeometryMutation` | **0**（823） |
| `parkGeometryMutation` | **0**（4,194） |
| `productionModified` | **false** |
| `protectedModified` | **false** |

validator: `tools/validate/visual-depth.js` → **RESULT: PASS / errors 0 / warnings 0**

配信データは 1 ファイルも生成し直していません。変更したのは dev HTML の描画部分だけです。

---

## 12. npm test（§30）

**2,135 tests / 2,120 pass / 0 fail / 15 skip**

最初は 13 件落ちました。内訳は 2 種類です。

**(a) 変えたコードの「形」を見ていた検査（10 件）** — 意図は保ったまま新しい形へ更新しました。

| 検査 | 守りたかったこと | 直し方 |
|---|---|---|
| `[FIX24 §9/§10]` 壁の base/top が一致 | 押し出しの座標式が不変 | 関数名の抽出を `, colors` 付きに対応（式の検査はそのまま） |
| `[31G-FIX8B §0/§21]` geometry/mesh 数不変 | 同上 + mesh 数不変 | 引数が増えた形へ。mesh 数の検査は維持 |
| `[31G-FIX8B §7/§14]` lighting 対応 material | Lambert を使っている | `vertexColors` 付きの形へ |
| `[31G-FIX5]` material 共有 | feature ごとに new しない | 複数行になった呼び出しへ |
| `[33A] 配色 v2` `[32K §0/§9]` | 座標をそのまま押し出す | `bucket.pos` へ渡す形へ |
| `[FIX12]` `[FIX13]` road style | 車道と歩道が別 style | `mix()` へまとめた形へ（色と比率は不変） |

**(b) 「production は dev と 1 行違い」を常時条件にしていた検査（3 件）**

これは 35G で私が作った `productionIsDevWithProfileOnly()` の使い方を誤っていました。
この条件は **cutover した直後にだけ成り立つ**もので、次のミッションが dev を進めれば
dev が先行するのが正常です。35H は dev だけを変えるミッションなので一斉に落ちました。

常時守れる条件は「**production が自分のビルド記録（sha256）と一致していること**」で、
これは cutover と cutover のあいだも成り立ち、手作業での書き換えも検出できます。
`productionMatchesBuildRecord()` へ置き換え、ヘルパーにも使い分けを書きました。

---

## 13. known limitations

1. **§22 の SHADOW 切替（OFF / LIGHT / FULL）は作っていません。** §22 は「してよい」（任意）で、
   FULL は性能確認用です。canonical の建物は元から `castShadow = false` で、
   618,749 棟へ real shadow を掛ける経路は存在しません。§26 の「見た目より安定動作を優先」に従い、
   実装しても採用しない選択肢のための UI は作らない判断をしました。
   近距離だけの real shadow（§10 の 0〜500m 案）も同じ理由で見送っています。
2. **地表・背景の色は変えていません。** §17 は背景を明るくする方針ですが、
   既に `0xf6f7f3` とほぼ白で、これ以上明るくすると白系建物との差が消えます（§8 と競合）。
   白系建物のほうを壁の陰影で沈める方針を採りました。
3. **屋根の warm / cool シフトは入れていません（§12 の「必要なら」）。**
   頂点カラーを無彩色に保つことで色相を守る設計にしたため、屋根だけ色味を変えるには
   別の仕組み（カテゴリ別の屋根 material）が要ります。明度差だけで屋根は識別できています。
4. **QA のスクリーンショットに dev のトグルが写っています。** 画面下の
   `[GSI Road Edge] OFF` などは body 直下にあり、QA の UI 非表示処理の正規表現から漏れました。
   production ではビルドプロファイルの CSS で隠れるので実害はありませんが、
   比較画像としては余分です。
5. **性能の絶対値はこのセッションの実測で、35G の値より低く出ています**
   （梅田 35G 52.4 fps → 35H 32.1 fps）。長時間ブラウザを動かし続けた状態での測定のためで、
   35H が遅くしたわけではありません（同一セッション内の CURRENT vs DEPTH は 0%）。
   絶対値を比べる場合は測り直しが要ります。
6. **CURRENT プロファイルは残したままです。** §20 のとおりユーザー確認後に削除 / legacy 化します。

---

## 14. 成果物

**新規**

| ファイル | 役割 |
|---|---|
| `tools/audit/visual-depth-qa.js` | §23/§24/§25/§29 CURRENT / DEPTH を同じカメラで撮り比べ、明暗分布と性能を測る |
| `tools/validate/visual-depth.js` | §27/§28/§30 データ不変・production 未変更・性能の検証 |
| `tests/visual-depth.test.js` | 明暗の式・geometry 不変・影の方針・dev 限定（22 件） |
| `data/reports/visual-depth-citymode-ab.json` | City Mode を同一タイル状態で交互に測った結果 |

**変更（すべて dev HTML の描画部分）**

| 箇所 | 変更 |
|---|---|
| `VISUAL_PROFILES` / `CR_DEPTH` / `wallShade` / `heightShade` | 35H の明暗の式（新規ブロック） |
| `pushExtrude()` | 任意引数 `colors` を追加。**positions の式は不変** |
| `meshFromPositions()` | `opts.colors` を正規化 Uint8 の color attribute に |
| `crBuildingMaterial()` | profile 別 material / `vertexColors` / DEPTH の彩度・白寄せ |
| `COL_DEPTH` / `buildRoadStyles()` | §14/§15/§16 の配色を profile で切り替え |
| `CR_STYLE` / `LIGHT_PRESET` / `applyLightStyle()` | §4/§5/§18/§21 の光と露出 |
| `setVisualProfile()` / `setLightLevel()` / `getDepthDebug()` | §20/§21 の切替と状態取得 |
| dev トグル `visual-profile-toggle` / `visual-light-toggle` | §20/§21（production では非表示の箱の中） |
| `tools/lib/production-invariants.js` | cutover 直後の条件と常時条件の使い分けを明記 |
| `tests/` 10 ファイル | 上記 §12 |

---

## 15. STOP

§33 のとおりここで止まります。production へ cutover していません。

スクリーンショット（`data/reports/visual-depth-qa/`）:

| 見どころ | before | after |
|---|---|---|
| 梅田・斜め 34°（壁の 3 段階・高層の量感） | `umeda.low.CURRENT.jpg` | **`umeda.low.DEPTH.jpg`** |
| 本町・斜め（街区の分離） | `honmachi.low.CURRENT.jpg` | **`honmachi.low.DEPTH.jpg`** |
| 新大阪・斜め | `shin-osaka.low.CURRENT.jpg` | **`shin-osaka.low.DEPTH.jpg`** |
| City Mode（§19 白い塊にならない） | `city-mode.CURRENT.jpg` | **`city-mode.DEPTH.jpg`** |

dev で `[VISUAL] 35H DEPTH` / `[VISUAL] CURRENT` を切り替えて見比べられます
（`#canonical-runtime-road-v2-controls` の中。production では非表示）。

**`LIVE_CITY_VISUAL_DEPTH_SUCCESS`**
