# MISSION 32G 完了報告 — GROUND FOOTPRINT ROOT AUDIT

> **historical-invalidated-by-v2**（Mission 32P で追記）: このレポートの数値は V1 建物（平面直角座標 第7系由来・地図に対し 0.93° 回転）を前提にしている。梅田の建物底面の判定を V1 建物（第7系・0.93° 回転）で行った。現在の値は `data/reports/v2-final-road-overlap.json` / `v2-final-water-overlap.json` / `v2-placement-policy.json` を参照。ファイルは記録として残す。


AUDIT ONLY。building移動/scale/clip/warp・Road変更・Land Block変更・projection変更・global rebuild は
一切行っていない（validator で 0 を確認）。梅田の問題建物30棟について「現在Runtimeが底面として
使っているgeometryは本当に地面接地footprintなのか」を実データで確定させることだけを行った。

最終判定: **`SOURCE_CONFLICT`** → **`GROUND_FOOTPRINT_NOT_ROOT_CAUSE`**

---

## 結論を先に

**仮説「Runtimeが roof outline / building outer projection / LOD1 projected footprint 等を
底面に使っている」は、pipelineの選択ミスとしては否定されました。**

理由: この大阪市PLATEAU建物データセットには、**選び間違えようがないほど geometry が1種類しかない**ため。

生CityGMLを直接grepした実測値（1メッシュ3,189棟）:

| geometry | 実測件数 |
|---|---|
| `bldg:lod0FootPrint` | **3,189**（= buildingCount、全建物に1つ） |
| `bldg:lod1Solid` | 3,189 |
| `bldg:lod0RoofEdge` | **0** |
| `bldg:GroundSurface` | **0** |
| `bldg:RoofSurface` | **0** |
| `bldg:WallSurface` | **0** |
| `bldg:lod2Solid` / `lod2MultiSurface` | **0** / **0** |

つまり屋根系geometryはデータに存在しないので、pipelineがそれを掴むことは原理的に起こり得ません。

ただし**問題そのものが消えたわけではありません**。問題建物の底面は実際に道路・線路の上へ広がって
おり、その広がりが「実在の高架建築」なのか「PLATEAUのlod0FootPrint自体が地面接地より過大」なのかは、
**本環境のデータでは区別できない**ことも確定しました（後述§15）。

---

## §39相当・報告項目

### 1. 問題建物sample（§1）
梅田PoC範囲(1200m四方)の Canonical Building 1,668棟から、明確な基準で抽出:
`面積 ≥ 300m²` かつ（`ROAD V2 envelope重なり ≥ 25%` または `rail corridor重なり ≥ 15%`）
→ 候補158棟、そのうち「面積 × 最大跨ぎ率」上位 **30棟** をsampleとした。

sampleの実測中央値: road重なり 32.7%、rail重なり 23.1%、Land Block外 35.6%。
最大は 27,126m²。structureType内訳: OVER_TRACK_STRUCTURE 20 / PODIUM_TOWER 5 /
STATION_STRUCTURE 3 / BRIDGE_LIKE_BUILDING 2。

### 2. PLATEAU sourceの追跡（§2）
**正直な制約の開示**: この環境に大阪市24区（Kita区=梅田を含む）のPLATEAU建物生CityGMLは
**存在しません**（`data/raw/plateau/osaka-city/` にあるのは tran=道路のみ。`data:download`系は
ネットワーク不可で実行できない）。唯一利用可能な生CityGMLは住吉区のもの（過去のLOD2調査で取得済み、
4メッシュ×2年度）。

そこで、同一提供元・同一変換パイプラインという前提のもと、住吉区の生データを
**大阪市PLATEAU建物データセット全体の特性を示す代替証拠**として使いました。
Kita区個別の直接確認ではない、という限界を明記します。

保存済みLOD2監査レポート8本すべてで一致: `lod1SolidCount = buildingCount`、
`lod2AnyCount = 0`、`roofSurfaceTotal = 0`、`wallSurfaceTotal = 0`、`groundSurfaceTotal = 0`。
加えて本監査で生GMLを直接grepし、上表の通り `lod0FootPrint` のみが全建物ぶん存在することを確認。

### 3. 現在のRuntime footprint source（§3）
**`LOD0_FOOTPRINT`**。

コード実測（`tools/convert-plateau-buildings.js`）: 優先順位は
`lod0FootPrint → GroundSurface → lod1Solid最下面(lowestRing)` で、
コメントに「屋根面(RoofSurface)はFootprintに使わない」と明記され、実際に
`lod0RoofEdge` / `lod2*` への参照はファイル中に一切ありません（検索して不在を確認）。
`lod0FootPrint` が全建物に存在する以上、常に優先順位1で確定し、フォールバックは発生しません。
Canonical Buildings はこの変換結果をそのまま引き継いでいます
（`tools/build-canonical-buildings.js` は CityGML を再解析せず、変換済みtileを読む）。

`lod0FootPrint` はCityGML/PLATEAU仕様上「建物の地表面投影」を表すgeometryで、
`lod0RoofEdge`（屋根投影）とは別概念です。

### 4-6. GroundSurface / lod0FootPrint / RoofEdge 比較（§4/§5/§6）
**実施不能。** GroundSurface と RoofEdge がデータに0件のため、比較対象が存在しません。
§18が想定した「Current ≈ RoofEdge かつ Current ≠ GroundSurface」というテストは、
このデータセットでは原理的に実行できません。これ自体が本監査の中心的な発見です。

### 7. GSI BldL/BldA比較（§7・ground truthとしては扱わない）
sample30棟のGSI BldA被覆率中央値 **26.9%**。
ただし**対照群（問題建物でない通常建物1,503棟）でも中央値42.9%**でした。
差はわずか16ポイントです。

これは重要な歯止めです。梅田ではGSIが多くのPLATEAU建物を裏付けない（Mission 32Cでも
unmatched 1,017棟という既知の傾向）ため、**「GSIが裏付けない＝底面がおかしい」という推論は
そのままでは成立しません**。対照群を取っていなければ誤った断定をしていました。

### 8-9. Rail / Road crossing（§8/§9）
sample30棟: rail corridor（中心線±5m の概算）重なり中央値23.1%、最大96.3%。
ROAD V2 envelope 重なり中央値32.7%、最大100%。

### 10-11. Ground-contact candidate / wall-ground intersection（§10/§11）
- A. `lod0FootPrint` → **現在採用中**。データセットに存在する唯一のfootprint系geometry。
- B. `GroundSurface` → **存在しない（0件）**ので採用不可。
- C. wall-ground intersection 復元 → `WallSurface` も **0件** のため、このデータセットでは
  復元の材料自体がありません（§11のPoCは実施不能）。
- D. 現行fallback → 上記の通り発生していません。

### 12. 特殊ケース分類（§12）
OVER_TRACK_STRUCTURE 20 / PODIUM_TOWER 5 / STATION_STRUCTURE 3 / BRIDGE_LIKE_BUILDING 2
（NORMAL_BUILDING 0。sampleが跨ぎ基準で選ばれているため当然の結果であり、これ自体は発見ではありません）。

### 13. 現実の高架建築との区別（§13）
**区別できませんでした。** これが本監査の最も重要な限界です（詳細は§15）。
したがって「はみ出し」として自動修正してよい建物は、今回1棟も特定できていません。

### 14. Top Down overlay（§14）
開発UIに `[GROUND FP QA]` トグルを追加（既定OFF・read-only）。
ON時: CURRENT=黄 / GSI BldA=白 / ROAD V2=灰 / rail=黒 を真上から重ね、
**建物の3D extrusionは自動的に非表示**（OFFで必ず復元）。
指定色のうち GroundSurface=cyan・RoofEdge=magenta は**該当データが0件のため出せない**ことを
凡例に明示しています（lod0FootPrint=blue はCURRENTと同一geometryのため別レイヤー化していません）。

### 15. 最重要質問「現在の底面はGround Footprintなのか？」（§15）
30棟の内訳: **YES 2 / NO 0 / UNKNOWN 28**。

そして、UNKNOWN 28棟のうち **22棟は "UNRESOLVABLE"** と明示的に分類しました。理由:

当初、私は「底面のうちGSIが裏付けない部分に道路/線路が集中しているか」を判別指標にしました
（sample群では GSI裏付け部分の道路/線路率 1.7% に対し、非裏付け部分は **76.7%**、差+61.7pt）。
数字としては非常に強いコントラストです。

**しかしこの指標は無効です。** GSIは道路・線路の上に建物を描きません。したがって底面が道路上へ
はみ出していれば、その部分が非GSIになるのは、
- H1（実在の高架建築：本当にそこに構造物がある）でも、
- H2（source側のlod0FootPrintが地面接地より過大）でも、

**まったく同じように発生します**。両仮説が同一の観測を生む以上、この指標でH1/H2は区別できません。
自分の指標の誤りとして報告に明記し、分類も「roof-like」ではなく UNRESOLVABLE へ修正しました。

補助的に「複合施設のenvelope重複」仮説も検証しましたが、**30棟中25棟で他建物との重なり0%**
（最大11.7%）で、これは否定されました。各問題建物は独立した単一ポリゴンです。

### 16. 集計（§16）
| 分類 | 件数 |
|---|---|
| CURRENT_IS_GROUND | 0 |
| CURRENT_IS_ROOF_LIKE | **0** |
| CURRENT_IS_PROJECTION | **0** |
| SPECIAL_STRUCTURE | 2 |
| UNKNOWN | 28（うちH1/H2判別不能 22） |

ROOF_LIKE と PROJECTION が **0件であること自体が結論の裏付け**です。sourceに屋根系geometryが
存在しない以上、そこに分類され得る建物は原理的に存在しません。

### 17. 改善予測（§17・仮想計算のみ、Runtime未適用）
sample30棟でGSI裏付け部分のみを底面とみなした場合の概算:
総面積 183,717m² → 73,585m²、road重なり 62,371 → 21,482m²、rail重なり 43,981 → 18,134m²。

**この数値は採用判断に使えません。** H1（実在の高架建築）を巻き込んで削っているだけの可能性が
排除できておらず、§13の「現実の高架建築を誤修正しない」に抵触するためです。参考値として記載します。

### 18-19. 原因分類（§18/§19）
- §18の `GROUND_FOOTPRINT_SEMANTICS_ERROR`（Current ≈ RoofEdge, Current ≠ GroundSurface）
  → **成立しない**。RoofEdge も GroundSurface もデータに存在しないため、前提が満たせません。
- §19の `REAL_OVERHEAD_STRUCTURE` / `SOURCE_GEOMETRY_CONFLICT`
  → GSIが地面レベルの建物として裏付けている（被覆率87%・100%）のに線路を大きく跨ぐ建物が
  **2棟**あり、これらは §19 の別扱いに該当します。

### 20. 最終classification（§22）
**`SOURCE_CONFLICT`**。

pipelineの選択ミスは否定された一方で、PLATEAU footprint・GSI建物・道路・線路という
複数ソースが「その場所の地面に何があるか」について食い違っており、本環境のデータでは
どれが正しいかを裁定できない状態です。

---

## 今回確定したこと / できなかったこと

**確定（一次証拠あり）**
1. 現在の底面source = `lod0FootPrint`（コード実測＋生CityGML実測の両方で確認）
2. このデータセットには GroundSurface / RoofEdge / RoofSurface / WallSurface / LOD2 が**1件も無い**
3. ⇒ 「pipelineが屋根geometryを掴んでいる」型の根本原因は**否定**
4. 問題建物の底面は実際に道路(中央値33%)・線路(中央値23%)へ広がっている
5. 問題建物どうしの重なりはほぼ0 ⇒ envelope重複仮説も否定

**できなかった（正直な限界）**
1. Kita区（梅田）の生CityGML直接確認 — 環境に存在しない（住吉区で代替）
2. H1（実在の高架建築）と H2（source側footprintが過大）の区別 — 利用可能データでは原理的に不能
3. したがって「どの建物を直すべきか」は1棟も確定できていない

---

## 次に本当に必要なこと（提案）

H1/H2を区別するには、今の環境に無いものが要ります。優先順に:
1. **Kita区（梅田）のPLATEAU建物生CityGMLをローカルPCで取得**し、同じgrepを直接当てる
   （本監査の代替証拠を一次証拠に格上げする。ネットワークのあるPCで実行が必要）
2. **LOD2データの有無を梅田で再確認** — LOD2があれば GroundSurface/WallSurface から
   真の接地形状を復元でき、H1/H2が決定的に区別できる（住吉区では0件だった）
3. それらが無い場合は、`[GROUND FP QA]` の真上表示と航空写真等での**目視照合**が
   現実的な唯一の判別手段になります

---

## Canonical/Building保護の確認
- Canonical Buildings 615,617 / Canonical Roads 199,658 / refined-road-surface 30,190 /
  ROAD V2 169,468 / Visual Land Block 178 — **すべて不変**
- production / protected HTML 無変更
- npm test: **1603 tests / 1588 pass / 0 fail / 15 skip**
- validator `tools/validate/umeda-ground-footprint-audit.js` = **PASS**
  （buildingMutation=0 / roadMutation=0 / landBlockMutation=0 / projectionMutation=0 /
  sourceGeometryTraced=true / groundSurfaceChecked=true / roofEdgeChecked=true /
  runtimeSourceIdentified=true）

## 新規ファイル
- `tools/audit/umeda-ground-footprint-audit.js` / `tools/validate/umeda-ground-footprint-audit.js`
- `tests/umeda-ground-footprint-audit.test.js`（10テスト、package.json登録済み）
- `data/reports/umeda-ground-footprint-audit.json` / `-validation.json`
- `data/processed/osaka-city/ground-footprint-qa/umeda/overlay.json`（+ public配信コピー）
- `public/osaka_3d_buildings.ward-ux-v1.html`（`[GROUND FP QA]`トグル追加・既定OFF・read-only）

---

**GROUND_FOOTPRINT_NOT_ROOT_CAUSE でSTOP**（提示された仮説＝pipelineのgeometry選択ミス、は否定
されました。source側footprintの過大さについては未解決のまま残しています。次Missionへは進みません）。
