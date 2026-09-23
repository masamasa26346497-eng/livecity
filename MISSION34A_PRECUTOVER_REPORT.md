# MISSION 34A — cutover 前確認

**判定: `MAX_PLATEAU_LOD_READY_FOR_VISUAL_APPROVAL`**

確認の過程で**実害のある不具合を 3 件見つけて直しました**（§6 に詳細）。production / protected は未変更です。

---

## 1. 「616,119 棟」の意味（件数の内訳）

ご指摘のとおり、616,119 は **raw の在庫数**であって表示される建物数ではありません。別々に示します。

| 区分 | 件数 | 説明 |
|---|---|---|
| **raw PLATEAU building inventory** | **616,119** | 配布 CityGML 内の一意な `gml:id`（フォルダ 205 ファイル + ZIP 270 エントリ。うち 584,256 は両方に同内容で重複） |
| **canonical PLATEAU V2 building count** | **574,112** | canonical V2N のうち出所が `plateau-building` のもの |
| **OSM fallback V2 count** | **26,652** | canonical V2N のうち OSM 由来 |
| **current production building total** | **600,764** | = 574,112 + 26,652（canonical V2N の featureCount） |
| **high LOD matched canonical building count** | **10,260** | LOD2/LOD3 を持つ raw のうち canonical V2N に存在するもの |
| ├ うち採用 | **10,223** | LOD2 10,208 / LOD3 15 |
| └ うち妥当性検査で LOD1 へ差し戻し | **37** | 重心ズレ 15 / 異常な高さ 21 / bbox 不一致 1 |
| **raw high LOD buildings that do not map to canonical V2** | **438** | 配布メッシュが市域外を含むため。**描いていません** |
| **duplicate / source-only records** | 重複コピー **584,256** / raw のみ（canonical に無い）**42,007** | 42,007 = 616,119 − 574,112。市域外・N03 でクリップされた棟 |

### 建物総数が増えていないことの確認

高 LOD タイルに入っている canonicalId を全件（10,223）集め、canonical V2N の 600,764 件と突き合わせました。

| 確認 | 結果 |
|---|---|
| 高 LOD の canonicalId で canonical に**存在しない**もの | **0 件** |
| canonical の distinct canonicalId | **600,764** |

高 LOD は**既存 canonicalId の別表現**であり、新しい建物を追加しません。**production の建物総数は 600,764 のまま**です。

## 2. Runtime の representation 切替

実ブラウザ（近景 r=700m）で、高 LOD で描いた棟数と LOD1 から外した棟数を照合しました。

| 地点 | 高 LOD 表示 | LOD1 抑制 | 一致 |
|---|---|---|---|
| 本町 | 2,842 | 2,842 | ✓ |
| 梅田 | 1,221 | 1,221 | ✓ |
| 中之島 | 1,841 | 1,841 | ✓ |
| 大阪城 | 1,268 | 1,268 | ✓ |
| 新大阪 | 1,333 | 1,333 | ✓ |

全地点で**「高 LOD で描いた数 ＝ LOD1 から外した数」**。差し引きゼロなので、描画される棟の総数は canonical と同じままです。

representation の内訳（データ全体）:

| representation | 棟数 |
|---|---|
| **LOD3** | **15** |
| **LOD2** | **10,208** |
| **LOD1（残りの canonical PLATEAU）** | **563,889**（= 574,112 − 10,223） |
| **OSM fallback** | **26,652** |
| 合計 | **600,764** |

> 注: ご提示の「LOD2 = 10,209」は前回ビルドの値です。今回、canonical footprint と bbox が一致しない棟を 1 件追加で弾いたため **10,208** になりました（§6-3）。
> なお LOD2/LOD3 が画面に出るのは近景・中景だけで、遠景（>2,500m）と City Mode では全棟 LOD1 に戻ります。

## 3. 主要 5 地点での LOD 境界往復

各地点で `700 → 1,500 → 2,400 → 2,600 → 3,200 → 2,600 → 2,400 → 1,500 → 700m` と往復し、各段でタイル読み込みの整定を待ってから 12 棟を追跡しました。

| 地点 | position pop | 最大位置差 | 最大頂部差 | LOD 変化 | canonicalId 変化 | card 引き当て失敗 |
|---|---|---|---|---|---|---|
| 本町 | **0** | **0.000 m** | **0.000 m** | **0** | **0** | **0** |
| 梅田 | **0** | **0.000 m** | **0.000 m** | **0** | **0** | **0** |
| 中之島 | **0** | **0.000 m** | **0.000 m** | **0** | **0** | **0** |
| 大阪城 | **0** | **0.000 m** | **0.000 m** | **0** | **0** | **0** |
| 新大阪 | **0** | **0.000 m** | **0.000 m** | **0** | **0** | **0** |

**duplicate / temporary disappearance について（正直な報告）**

往復チェックの `duplicate` / `temporaryDisappearance` は 0 になりませんでした（例: 新大阪 24 / 大阪城 24）。ただしこれは**計測方法の限界**です。判定に使った「真上から ray を撃って `pickBuilding` が同じ id を返すか」は、密集地では**隣の高い建物に当たって別の棟と判定される**ためです。

これを確かめるために **高 LOD を完全に OFF にした対照**を同じ手順で測ったところ、本町 11/12・中之島 10/12 が同じく「none」と判定されました。**高 LOD と無関係に出る計測上の誤りです。**

そこで、カメラを止めて 22 秒整定させた状態で、同じ棟が高 LOD と LOD1 の両方で描かれていないかを直接調べ直しました。

| 地点 | 定常状態の二重表示 |
|---|---|
| 本町 | **0 / 30** |
| 新大阪 | **0 / 30** |
| 大阪城 | **0 / 30** |

**残る既知の挙動**: カメラを大きく動かした直後、高 LOD タイルが届いてから canonical 側のタイルが作り直されるまでの間に、一部の棟が一瞬二重に描かれることがあります。同期化（§6-2）で大半は消えましたが、レイヤーが重なる大阪城では収束に最大 15 秒程度かかる場合があります。位置は動かないため、見た目は面のちらつきです。

## 4. 高 LOD の位置差（median 以外も）

### 4-1. 重心ベース（頂点平均）

| | 値 |
|---|---|
| median | 0.85 m |
| p90 | 4.31 m |
| p95 | 6.09 m |
| **p99** | **11.17 m** |
| **max** | **28.09 m** |

### 4-2. bbox 中心ベース（位置の正否はこちらが正本）

重心は「頂点の平均」なので、地面が細かく分割された棟では平面形が同じでも大きくぶれます。**同じ建物かどうか**は bbox 中心で測るのが正しく、その結果は次のとおりです。

| | 値 |
|---|---|
| median | **0.00 m** |
| p90 | **0.01 m** |
| p95 | **0.01 m** |
| **p99** | **0.01 m** |
| **max** | **2.66 m** |
| 2m 超 | **1 棟** |
| 5m 超 | **0 棟** |

### 4-3. 「15m 超で fallback した棟」との関係（ご指摘の確認）

- 差し戻した 15 棟は **重心ズレ 30m 超**で弾いたものです（15m ではありません）。
- **採用した棟のうち重心ズレ 15m 超は 46 棟**ありました。これを canonical の footprint と直接照合したところ、**45 棟は高 LOD の重心が canonical footprint の内側**にあり、位置ズレではなく重心定義の差でした。残る 1 棟も footprint の縁から 11.3 m です。
- さらに bbox で調べ直した結果、**本当に位置がずれていた棟が 1 件**見つかりました（canonical 24.2×23.6m に対し高 LOD が 99.9×202.6m、bbox 中心が 25.3m ずれ）。この 1 件は**今回新たに弾きました**（§6-3）。
- その結果、**目立つ位置差は残っていません**（bbox 中心 2m 超は 1 棟・最大 2.66m、その棟も 110×196m の大型建物で相対 1.4%）。

### 4-4. 高さ差（参考）

| | 高 LOD 全高 − canonical heightM |
|---|---|
| median | **0.00 m** |
| p05 / p95 | −4.08 m / +4.39 m |
| min / max | −65.17 m / +97.24 m |

## 5. production / protected

| | 結果 |
|---|---|
| `public/osaka_3d_buildings.html` | **未変更**（ビルド記録の sha256 と一致） |
| `public/osaka_3d_buildings.fullward-v3.html` | **未変更**（baseline hash と一致） |
| validator `productionModified` / `protectedModified` | **false / false** |

## 6. この確認で見つけて直した不具合

### 6-1. 遠景で建物が消えていた（重大）

`band === 'far'` で高 LOD レイヤーの親グループを隠していましたが、**LOD1 の抑制が解除されていませんでした**。その結果、**カメラ距離 2,500m を超えると対象の 1,200〜5,300 棟が丸ごと表示されなくなっていました**（実測: 本町で 5,291 棟が消失）。
→ 抑制の集計で親グループの可視も見るよう修正。往復チェックで遠景ステップが全て `lod1` に戻ることを確認しました。

### 6-2. カメラ移動直後の二重表示

高 LOD タイルを scene に足してから抑制を反映するまでに 1 フレーム以上あり、その間は高 LOD と LOD1 が同時に描かれていました。
→ タイル構築と同じ同期ブロック内で抑制を反映するよう修正。本町・新大阪では二重が出なくなりました。

### 6-3. クリックしても property card が出ない棟があった（§19 違反）

card 用データを canonical 側のタイル状態から引いていたため、**画面に見えている高 LOD 建物のうち card を出せるのは 本町 90.9% / 大阪城 79.6% / 新大阪 51.6%** でした。
→ 高 LOD タイル自身に canonical の footprint と属性を同梱し、タイルの読み込み順に依存しないよう変更。

| 地点 | 修正前 | 修正後 |
|---|---|---|
| 本町 | 90.9%（141 棟が不可） | **100%（0 棟）** |
| 新大阪 | 51.6%（415 棟が不可） | **100%（0 棟）** |
| 大阪城 | 79.6%（77 棟が不可） | **100%（0 棟）** |

あわせて、高 LOD の描画範囲が canonical の建物タイル範囲（近景 900m）より広かったため、範囲外の棟で抑制も card も効かなくなっていた点も修正しました（canonical が読もうとしている範囲に合わせる）。

データ量は 40.2MB → **44.2MB**（footprint と属性の同梱分）。

## 7. Validator / テスト

| | 結果 |
|---|---|
| validator | **PASS `MAX_PLATEAU_LOD_SUCCESS`**（errors 0 / warnings 0） |
| zoneVIIProjectionUsed | false |
| canonicalIdChanged / buildingPositionMutation / roadMutation / placementMutation | false / false / false / false |
| highestAvailableLodSelected / perBuildingFallbackWorks | true / true |
| lod2UsesRealPlateauOnly / lod3UsesRealPlateauOnly | true / true |
| productionModified / protectedModified | false / false |
| `npm test` | **1,833 / pass 1,818 / fail 0 / skip 15** |
| lifestyle-tab | 38 / pass 27 / **fail 0** / skip 11 |

## 8. 成果物（この確認で追加したもの）

| 種別 | パス |
|---|---|
| cutover 前チェック | `tools/audit/building-lod-precutover.js` → `data/reports/building-lod-precutover.json` |
| 更新したデータ | `public/map-data/osaka-city/derived-v2-osmv2/building-lod-high/`（44.2MB・footprint と card 属性を同梱） |
| 変更したファイル | `public/osaka_3d_buildings.ward-ux-v1.html`（development のみ）、`tools/build-plateau-high-lod.js`、`tools/validate/max-plateau-lod.js` |

`MAX_PLATEAU_LOD_READY_FOR_VISUAL_APPROVAL`
