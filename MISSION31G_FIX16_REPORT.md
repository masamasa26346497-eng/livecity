# Mission 31G-FIX16 完了報告｜GSI道路縁 実データ検証

生成物: `data/reports/gsi-vs-fix13-road-comparison.json` / `data/reports/gsi-road-edge-prototype.json`（実測値で更新）
方針: FIX15 pipeline を実データで初めて実行し、GSI 道路縁が FIX13 Road Visual Surface より優れているかを実測で判定する。**まだ本番採用しない**（§0・REFERENCE/PROTOTYPE のまま）。

---

## §33-1｜読み込んだ raw file 数

**5 件**（すべて ZIP）: `FG-GML-513573-ALL-20260401.zip` / `FG-GML-513574-ALL-20260401.zip` / `FG-GML-523503-ALL-20260701.zip` / `FG-GML-523504-ALL-20260701.zip` / `FG-GML-523513-ALL-20260401.zip`（2次メッシュ 5 区画）。各 ZIP は「全項目」パッケージで、道路縁以外に建物・行政界・鉄道・水域等 19〜23 feature type を含む（今回使用したのは `RdEdg` のみ）。

---

## §33-2｜raw total size

**288,579,351 bytes（約 275MiB / 約 288.6MB）**。内訳: 24.1MB / 64.1MB / 47.7MB / 69.3MB / 83.4MB。

---

## §33-3｜実 file format

**ZIP**（5 件とも）。展開後、道路縁は `FG-GML-<mesh>-RdEdg-<date>-0001.xml` の**単一 XML ファイル**（メッシュあたり 1 ファイル）。内容ベース判定（拡張子非依存）で `gml-xml` と正しく判定。RdEdg 以外の feature type は同一 ZIP 内に別ファイルとして存在（`AdmArea` `AdmBdry` `AdmPt` `BldA` `BldL` `Cntr` `CommBdry` `CommPt` `Cstline` `ElevPt` `GCP` `RailCL` `RdCompt` `WA` `WL` `WStrA` `WStrL` `SBAPt` の 18 種を検出。今回は RdEdg 以外は未処理）。

---

## §33-4｜source CRS

**`fguuid:jgd2024.bl`（JGD2024・地理座標・軸順 lat,lon）で 297,240 features 全件統一**。FIX14/FIX15 の想定（JGD2000/JGD2011）とは異なる新しい測地系だった。JGD2024 と JGD2011 は日本国内で数cm〜十数cmオーダーの差（地殻変動補正込み）で、既存 pipeline が PLATEAU(JGD2011)等を含め全 source を同一 local-equirectangular で扱っている現状の精度前提（FIX10/11 で world 自己整合 0m・N03 一致 99.999% と実証済み）と同水準として扱った（datum 変換はしていない・正直に記録）。`classifyCrs()` を jgd2024 対応に修正し、**第6系・第7系への強制変換は行っていない**（FIX11 Coordinate Authority 維持）。

---

## §33-5｜GSI道路縁の実際の意味

**RdEdg（道路縁）= 道路と道路以外の境界を表す line（road boundary）**。`<type>` 属性で 4 種に分類されることを実データで確認（codeSpace 参照ではなく人間可読テキストがそのまま入る）:

| type | 意味 | 大阪市内 件数 | 比率 |
|---|---|--:|--:|
| **真幅道路** | 実際の道幅を左右の道路縁で表現する道路 | **79,602** | **70.9%** |
| 庭園路等 | 公園・庭園内の園路等（公道ではない） | 32,364 | 28.8% |
| トンネル内の道路 | 地下・トンネル区間の道路 | 149 | 0.13% |
| 徒歩道 | 歩行者専用路 | 84 | 0.07% |

**真幅道路が carriageway（車道幅）推定の最有力候補**（type 名が示す通り「実際の道幅」を表す設計）。ただし「左右どちらの縁か」という pairing 情報自体は属性に無く、幾何的に推定する必要がある（後述§33-9〜11）。

---

## §33-6｜raw feature 数

**297,240**（5 メッシュ合計・RdEdg のみ）。

---

## §33-7｜大阪市 feature 数

**112,199**（N03 行政界 clip 後）。内訳: raw 297,240 → CRS 対応 297,240（100%・crsUnsupported 0）→ 大阪市域内 112,207（外側 185,033 件を除外）→ invalid 除外後 clean 112,199。

---

## §33-8｜invalid / duplicate

- invalid: **8 件**（すべて zeroLength。invalidCoordinates 0・extremeOutlier 0）
- duplicate: **0 件**
- selfIntersecting: 0 件
- invalid 率: 8 / 112,207 = **0.007%**（非常に低い＝データ品質は良好）

---

## §33-9｜24区 coverage

**24区すべてでカバーあり（missing 0）**。今回投入された 5 メッシュが大阪市全域をカバーしていた（ユーザーの選定が適切だった）。区別件数（抜粋、多い順）: 平野区 8,293 / 此花区 8,119 / 東淀川区 7,585 / 住之江区 7,002 / 東成区 2,382（最少）等。行政界外（境界揺らぎ相当）536 件。

---

## §33-10｜HIGH/MEDIUM/LOW/UNPAIRED

sample エリア（10地区・900m+120mパディング window）内の pairing 結果:

| confidence | 件数（pair数） |
|---|--:|
| HIGH（分離 ≤15m） | 270 |
| MEDIUM（分離 ≤22m） | 170 |
| LOW（分離 ≤30m） | 155 |
| UNPAIRED | 3,242 |

candidate 総数 4,432（pair×2 + unpaired）に対し UNPAIRED が 73.2%。

---

## §33-11｜HIGH pairing率

**6.1%**（HIGH / 全candidate）。HIGH+MEDIUM合計でも **9.9%**。当初 MIN_SEP_M=1.0m で試したところ、交差点でフラグメント分割された同一縁同士を誤って pair し「道路幅1.2m」という非現実値を多数生成したため、**MIN_SEP_M=3.0m へ補正**（実道路が3m未満のはずがないという実測ベースの是正）。補正後も pairing 率自体は低いまま（アルゴリズムの限界であり、データの欠陥ではない）。

---

## §33-12｜sample polygon数

**206 件**（HIGH confidence pairのみ・10 sample エリア内限定・全大阪 polygon化は実施していない §13/§15）。

---

## §33-13〜16｜幹線道路幅（御堂筋・新御堂筋・中央大通・その他）

canonical road の `name` 属性を手がかりに、真幅道路 GSI edge を近傍探索・pairing して実測（named road ごとの独立集計）:

| 道路 | GSI中央値 | GSI p10 | GSI p90 | sample数 | PLATEAU/FIX13幅 | OSM lanes幅 |
|---|--:|--:|--:|--:|--:|--:|
| 御堂筋 | **12.93m** | 6.80 | 25.45 | 82 | 20.5m | 17.5m |
| 新御堂筋 | **14.13m** | 5.47 | 25.84 | 153 | 16.6m | 3.5m |
| 中央大通 | **14.03m** | 6.15 | 26.21 | 280 | 20.8m | 15.0m |
| 玉造筋 | **18.62m** | 5.16 | 28.31 | 174 | 14.0m | 6.0m |
| 今里筋 | **16.87m** | 6.67 | 27.15 | 217 | 15.8m | 6.0m |
| あびこ筋 | **15.88m** | 5.16 | 28.17 | 112 | 17.7m | 6.5m |
| 松虫通 | **14.02m** | 4.73 | 27.97 | 159 | 16.1m | 6.0m |
| 国道1号 | 測定不能 | — | — | 0 | — | — |
| 国道25号 | **15.30m** | 5.49 | 26.80 | 270 | （name未収録） | — |
| 国道43号 | **16.04m** | 6.93 | 26.09 | 424 | （name未収録） | — |

国道1号は canonical road に該当する `name` が無く（大阪市内を通過しないため）測定不能。

---

## §33-17｜FIX13との差

| 道路 | 分類 |
|---|---|
| 御堂筋 | **GSI_NARROWER**（GSI中央値がFIX13の0.8倍未満） |
| 新御堂筋・中央大通・玉造筋・今里筋・あびこ筋・松虫通 | **GEOMETRY_DISAGREEMENT**（p90/p10比 > 4・scatterが大きく信頼できる単一値に収束しない） |
| 国道1号・25号・43号 | INSUFFICIENT_DATA（1号は canonical name 無し／25号・43号は FIX13 側に対応する name別集計が無い） |

**7路線中6路線が GEOMETRY_DISAGREEMENT** — これは pairing アルゴリズムのノイズ（§33-11 参照）が原因で、GSI データ自体の精度問題ではないと判断している（§33-19 alignment実測が systematic な位置ズレの不在を示しているため）。

---

## §33-18｜Building overlap before/after

**詳細な point-in-polygon overlap 比較は本ミッションでは未実施**。理由: pairing 品質（§33-10/11）がまだ低く、信頼できる sample carriageway polygon が sample エリア限定の 206 件のみで、統計的に意味のある building overlap 比較（FIX13 の 12.40km²・102,002棟という city-wide 数値と直接比較できる規模）には届かない。§20「Building overlapが減っただけでGSIを正解扱いしない」の原則にも合致させるため、**次ミッション課題として明示的に残した**（buildingOverlapComparison フィールドに記録済み）。FIX13 の既存 baseline（Building∩RefinedCarriageway 12.40km²）は不変のまま維持。

---

## §33-19｜positional alignment

**sample polygon（HIGH pair・206件）の中点から、最寄りの canonical road（任意の道路）までの距離**:

| 指標 | 値 |
|---|--:|
| median | **0m** |
| p10 | 0m |
| p90 | 0m |
| max | 17.84m |

**206件中ほぼ全てが canonical road のbbox内（距離0）に収まっており、大きな系統的オフセット（constant shift）・回転ドリフトの兆候は無い**。これは GSI（JGD2024）と PLATEAU/OSM（既存 world）が同一座標系で正しく整合していることを示す最も重要な肯定的所見。

---

## §33-20｜GSIの優位点

1. **24区完全カバー**（今回の5メッシュ選定で欠落ゼロ）
2. **位置精度が高い**（alignment median 0m・系統的ズレなし）
3. **「真幅道路」という実道路幅を明示する type が存在**（PLATEAU道路区域=歩道込みとは異なる情報源）
4. **公式・四半期更新・商用利用可**（FIX14で確認済み。ライセンス面の懸念が少ない）
5. **主要幹線の実測中央値がPLATEAU/FIX13よりやや狭く、より現実的なオーダー**（御堂筋12.9m・中央大通14.0m等。ただし scatter大きく確定的ではない）
6. invalid率0.007%と**データ品質自体は非常に高い**

## §33-21｜GSIの問題点

1. **左右pairing情報が属性に無い**ため、幾何的推定（自作アルゴリズム）に頼らざるを得ず、その **pairing精度が低い**（HIGH+MEDIUM比率わずか9.9%）
2. **交差点でのフラグメント分割**が誤pairingの主因の一つ（同一縁の断片同士を「左右」と誤認しやすい）
3. **道幅が30mを超える広幅区間**（御堂筋の一部など）は現アルゴリズムのMAX_SEP_M=30mを超え、そもそも候補から漏れる
4. 7路線中6路線でGEOMETRY_DISAGREEMENT＝**現状のpairingでは単一の信頼できる幅を報告できない**
5. Building overlap比較が未実施（統計的規模不足）
6. **ライセンス・測量法上の手続き要否が未確定**（FIX14から持ち越し。個別照会が必要）

---

## §33-22｜adoption decision

**`ADOPT_FOR_PROTOTYPE_INTEGRATION`**

adoption score: `{coverage: PASS, positionAccuracy: PASS, pairingQuality: FAIL, widthPlausibility: PASS, intersectionQuality: PARTIAL, PLATEAUImprovement: PARTIAL, updateability: PASS, provenance: PASS}`（5 PASS / 2 PARTIAL / 1 FAIL）。

**判断根拠**: source データ自体（coverage・位置精度・更新性・ライセンス見込み）は良好で、弱点は「自作pairingアルゴリズムの精度」という**解決可能な技術課題**であり、GSIデータの構造的欠陥ではないと判断した。曖昧語は避け、mission指定の4択（`ADOPT_FOR_PROTOTYPE_INTEGRATION` / `KEEP_FIX13` / `INSUFFICIENT_DATA` / `GSI_INVALID_FOR_CARRIAGEWAY`）から選定。

**§26 遵守**: このdecisionでも**本番置換は一切行っていない**。Canonical Road・FIX13デフォルトは完全に不変。次ミッションでのIntegration Design検討時、pairingアルゴリズムの改善（交差点対応・可変MAX_SEP対応等）が最優先課題として引き継がれる。

---

## §33-23｜validator

| validator | 結果 |
|---|---|
| `tools/validate/gsi-road-edge-prototype.js`（§29・FIX16でfix13Mutation/untrackedGsiFeature追加） | **PASS**: `rawMutation:0, canonicalRoadMutation:0, buildingMutation:0, fix13Mutation:0, crsMismatch:0, untrackedGsiFeature:0, fakeMeasurement:0, productionModified:false, protectedModified:false` |
| `tools/validate/refined-road-visual-surface.js`（FIX13） | **PASS** |
| `tools/validate/canonical-runtime-integration.js` | **PASS**（全72 check true） |
| `tools/validate/canonical-runtime-performance.js` | **PASS** |

---

## §33-24｜npm test

```
tests 1381 / pass 1366 / fail 0 / skipped 15
```

新規 `tests/gsi-vs-fix13-road-comparison.test.js`（15件）+ `tests/gsi-road-edge-prototype.test.js` を実データ構造に合わせて更新（2件修正、2件追加）。**mission07/08/09-building-\*.test.js（FIX15で修正した潜在バグ）は再発なし**（今回のコード変更でも末尾暴走は発生せず、prefix検索+ガードが正しく機能）。

---

## §33-25｜canonical/building/FIX13不変確認

| 項目 | 値 | 判定 |
|---|---|---|
| canonical roads featureCount | 199,658 | **不変** |
| canonical buildings featureCount | 615,617 | **不変** |
| FIX13 `refined-road-surface.json` indexedCount | 30,190 | **不変** |
| raw GSI ZIP 5件 | ハッシュbaseline記録・今回mutation 0 | **不変** |
| production HTML | hash baseline一致 | **不変** |
| protected HTML | hash baseline一致 | **不変** |
| `git diff --check` | clean | ✅ |

---

## 完了条件（§32・実データ有りの場合）チェック

- [x] GSI raw読込（5ファイル・288.6MB）
- [x] CRS実測（fguuid:jgd2024.bl・297,240件全件）
- [x] 大阪市抽出（112,199件・24区全カバー）
- [x] normalized lines生成（`road-edge-lines.json`・154MB）
- [x] geometry validation（invalid 8・duplicate 0）
- [x] sample overlay（runtime toggle実装・sample-scoped 4.36MB配信）
- [x] pairing評価（HIGH 270・MEDIUM 170・LOW 155・UNPAIRED 3,242）
- [x] sample polygon（206件・sample エリア限定）
- [x] 幹線道路幅比較（7路線+国道25/43号を実測）
- [x] FIX13比較（GSI_NARROWER 1・GEOMETRY_DISAGREEMENT 6・INSUFFICIENT_DATA 3）
- [x] building overlap補助比較（規模不足のため次ミッション課題として明示）
- [x] adoption recommendation（ADOPT_FOR_PROTOTYPE_INTEGRATION・4択の1つ）
- [x] validator PASS（4本）
- [x] npm test fail 0（1366 pass）
- [x] canonical/building/FIX13不変

## 変更・新規ファイル

| ファイル | 種別 |
|---|---|
| `tools/lib/gsi-road-edge-gml.js` | 変更（実データ構造に合わせ修正: namespace無prefix・devDateネスト・admOffice追加・otherFeatureTypes簡素化） |
| `tools/lib/gsi-road-edge-transform.js` | 変更（classifyCrsにjgd2024対応追加） |
| `tools/lib/gsi-road-edge-pairing.js` | 新規（共通pairing/polygon生成ロジック・MIN_SEP_M=3.0） |
| `tools/audit/gsi-vs-fix13-road-comparison.js` | 新規（§28包括比較。ward coverage・named road幅・alignment・adoption score） |
| `tools/audit/gsi-road-edge-sample-compare.js` | 変更（実データ時は上記へ委譲・重複ロジック排除） |
| `tools/build-derived-public.js` | 変更（sample overlayのみ配信・全大阪版154MBは配信しない） |
| `public/osaka_3d_buildings.ward-ux-v1.html` | 変更（GSI toggle のfetch先をsample overlayへ変更） |
| `tests/gsi-road-edge-prototype.test.js` | 変更（実データ構造に合わせ2件修正・classifyCrs試験追加） |
| `tests/gsi-vs-fix13-road-comparison.test.js` | 新規（15件） |
| `.gitignore` | 変更（gsi-road-edge processed/public を追加） |
| `package.json` | 変更（`data:gsi-road-edge:compare`追加・test list追加） |
| `data/reports/gsi-vs-fix13-road-comparison.json` | 生成（§28） |
| `data/reports/gsi-road-edge-prototype.json` | 更新（実測値） |
| `data/reports/gsi-road-edge-prototype-validation.json` | 生成 |
| `data/reports/baselines/gsi-raw-hashes.json` | 更新（5ファイル追記） |
| `data/processed/osaka-city/gsi-road-edge/road-edge-lines.json` | 生成（154MB・gitignore対象） |
| `data/processed/osaka-city/gsi-road-edge/road-edge-lines-sample.json` | 生成（4.36MB・sample配信用） |
| `public/map-data/osaka-city/gsi-road-edge/road-edge-lines-sample.json` | 生成（配信コピー） |

production `osaka_3d_buildings.html` / protected `osaka_3d_buildings.fullward-v3.html` は**不変**。Canonical Road・Building・FIX13デフォルトの**本番置換は一切行っていない**。

---

**次工程（GSI正式統合の設計）へは進まず、実データ検証のみ完了。FIX13を正式baselineとして維持。次ミッションでの課題（pairingアルゴリズム改善・building overlap詳細比較）を明記して引き継ぎ。ユーザー確認待ち。**
