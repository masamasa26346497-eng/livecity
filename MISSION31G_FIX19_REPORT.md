# Mission 31G-FIX19 完了報告｜Hybrid GSI Road Surface Prototype

GSI corridor v3（31G-FIX18・`READY_FOR_HYBRID_GSI_ROAD_PROTOTYPE`）の高信頼面と FIX13 primary fallback を、
10 sample エリア（900m四方）限定で**実 geometry として合成**した。比率のみだった FIX18 の `hybridCoverage`
から一歩進め、実際に描画・重なり判定ができる polygon 群を生成し、runtime トグルで目視比較可能にした。

## §48-1｜Hybrid surface 数

- sample エリア近傍（GSI_CORRIDOR_HIGH/MEDIUM のみ・非spike・非switch境界）: **5,788 件**
- city-wide の corridor pair pool（参考値・publicには出さない）: 122,289 件

## §48-2｜GSI HIGH coverage

sample エリア合計面積: **1,645,825 m²**（10エリア平均 GSI_HIGH_pct ≈ 52.5%、範囲 36.5%〜62.8%）

## §48-3｜GSI MEDIUM coverage

sample エリア合計面積: **220,775 m²**（10エリア平均 GSI_MEDIUM_pct ≈ 7.0%、範囲 2.9%〜11.8%）

## §48-4｜FIX13-fallback coverage

sample エリア合計面積: **863,175 m²**（10エリア平均 FIX13_FALLBACK_pct ≈ 28.0%、範囲 18.3%〜48.3%）

## §48-5｜unresolved 率

10エリア平均 UNRESOLVED_pct ≈ **12.7%**（範囲 6.7%〜15.9%）。「8近傍のうち2セル以上が道路セルなのに自身が
未分類」という簡易ヒューリスティックで検出した穴で、5m grid の量子化誤差を含む。

## §48-6〜9｜multi-carriageway 分類

（corridor track 単位・named-road スコープに限らず city-wide corridor 全体から集計。理由は scopeNote 参照）

| 分類 | 件数 |
|---|---:|
| SINGLE_CARRIAGEWAY | 78,377 |
| DUAL_CARRIAGEWAY | 12,361 |
| MULTI_CARRIAGEWAY | 16,366 |
| AMBIGUOUS | 16,518 |

## §48-10〜12｜service road 分離結果

| 分類 | 件数 |
|---|---:|
| MAIN | 2,096 |
| SERVICE | 1,514 |
| UNKNOWN | 142,472 |

**正直な注記**: MAIN/SERVICE 判定は「9路線の名前付き幹線道路に bbox マッチした pair」のみを対象にした
分離幅クラスタリングであり、それ以外の全 corridor pair（都市部の無名街路等）は UNKNOWN のまま。
UNKNOWN が MAIN+SERVICE の約 40 倍という結果は「ほとんどの道路で判定に失敗した」のではなく、
「named road 以外は元々判定対象にしていない」ことを示す。city-wide 全street のservice-road分類は未実装。

## §48-13｜median 分離数

**別 surface としては未実装**。DUAL_CARRIAGEWAY（12,361件）の判定ロジックが「近い partner track（中央帯候補）
+ 遠い partner track（対向車線候補）の2層構造」を検出してはいるが、median 単体の polygon・面積・件数を
個別出力する仕組みは今回作っていない。次ミッションで DUAL_CARRIAGEWAY の内訳（narrow cluster vs wide cluster）
を明示的に分離すれば実装できる見込み。

## §48-14｜ramp 分離数

**未実装（0）**。MULTI_CARRIAGEWAY（16,366件・3つ以上の partner track を持つ track）の中にランプ相当の
構造が混在している可能性はあるが、ランプを他の分岐と区別する専用ロジックは無い。

## §48-15｜intersection 再構成結果

**未実装**。GSI closed surface による polygonization（Strategy A）は FIX17/18 から継続して未実装のまま
（誤った polygon を作らない、という §0 の原則を優先）。交差点は FIX13 primary polygon が担当領域のまま
（intersection zone 自体を GSI 起源で再構成する処理はしていない）。

## §48-16〜20｜seam 分類結果

| 分類 | 件数 |
|---|---:|
| CLEAN | 2,662 |
| SMALL_GAP（孤立1セル= 5m） | 625 |
| OVERLAP | 0（構造上） |
| WIDTH_JUMP | 4,097 |
| TOPOLOGY_BREAK | 0（未実装のため評価対象外） |
| AMBIGUOUS | 0（本実装では GAP/AMBIGUOUS の閾値が交わらず全て WIDTH_JUMP or CLEAN に分岐） |
| **critical（OVERLAP+TOPOLOGY_BREAK）** | **0** |

**重要な留保（`seamMethodologyCaveat`）**: WIDTH_JUMP 判定に使う「seam 位置の FIX13 側実効幅」は、
最寄りの FIX13 primary polygon 全体の `2×面積/周長` という近似値であり、単純な矩形道路には妥当だが、
交差点を含む・枝分かれした・湾曲した polygon では実際の局所幅より小さく出やすい。そのため WIDTH_JUMP
優勢（4,097 対 2,662）という結果は「境界が実際に荒れていることの確証」ではなく「自動READY判定はできない
という保守的シグナル」として扱う（§7 精度>coverage 方針）。より正確な局所断面幅測定（seam点での道路進行
方向に垂直な実測）は本ミッション時間内では未実装。

## §48-21｜invalid polygon 数

sample スコープ 5,788 surface 中: **invalidQuads = 59 件**（自己交差・ゼロ面積を検出時に除外済みの残数）、
**sliverQuads = 496 件**（面積 0.5m² 未満・削除はせず VALID_SMALL_FEATURE として保持、§19 方針通り）。

## §48-22｜FIX13 area（比較の分母）

**1,666,625 m²**（GSI 採否に関係ない、window 内の元の FIX13 primary 面積）。
※実装の途中で「GSI に置換されず残った FIX13 面積のみ」を誤って分母にしていたバグ（差分が常に
過大な正の値=+216%になっていた）を発見し、正しい「window 内の元の総 FIX13 面積」を分母に修正した。

## §48-23｜Hybrid area

**2,729,775 m²**（GSI_HIGH + GSI_MEDIUM + FIX13_FALLBACK の合計）。
差分 **+63.8%**（元の FIX13 primary 面積比）。「小さい＝成功」ではなく、GSI が FIX13 の primary
分類に含まれていなかった道路面も拾えているかの目安として読む（§27 の指示通り、数値の大小だけで
成否を判定しない）。

## §48-24｜Building overlap 比較

| 指標 | 値 |
|---|---:|
| チェックした建物数（sample近傍・footprint 5点サンプリング） | 18,813 |
| 主に FIX13 上 | 3,002 |
| 主に GSI v3(Hybrid採用面) 上 | 5,179 |
| 主に Hybrid（FIX13∪GSI の和集合）上 | 6,689 |

Building は road geometry の ground truth として使っていない（§28）。GSI/FIX13 双方に重なる建物（境界付近）
があるため、和集合(6,689)は単純合計(8,181)より少ない。

## §48-25｜Water overlap 比較

GSI trusted surface（sample近傍 5,788件）のうち水面と重なるもの: **147件（≈2.5%）**。橋区間では正常に
水面と重なるため、件数のみ記録し「橋以外で不自然に増えていないか」は目視QA対象とする（§29の指示通り、
数値だけで断定しない）。

## §48-26｜Park overlap 比較

GSI trusted surface のうち公園と重なるもの: **78件（≈1.3%）**。

## §48-27〜35｜9路線の幹線道路結果（御堂筋〜国道43号）

（国道1号は該当する canonical road 名が無く sampleCount=0 のため FIX16以来「測定不能」として除外。
9路線が「9 measurable major roads」に対応）

| 路線 | pair数 | median幅(m) | p10 | p90 | MAINペア | SERVICE候補ペア |
|---|---:|---:|---:|---:|---:|---:|
| 御堂筋 | 75 | 22.08 | 10.68 | 42.74 | 40 | 35 |
| 新御堂筋 | 295 | 20.64 | 10.16 | 32.90 | 176 | 119 |
| 中央大通 | 666 | 20.84 | 10.11 | 33.77 | 392 | 274 |
| 玉造筋 | 259 | 26.37 | 7.96 | 40.32 | 155 | 104 |
| 今里筋 | 348 | 26.28 | 10.47 | 38.52 | 224 | 124 |
| あびこ筋 | 221 | 19.84 | 6.30 | 39.97 | 91 | 130 |
| 松虫通 | 256 | 25.16 | 8.29 | 38.34 | 146 | 110 |
| 国道25号 | 574 | 25.27 | 10.22 | 40.39 | 334 | 240 |
| 国道43号 | 916 | 18.78 | 8.53 | 32.26 | 538 | 378 |

このミッションでは FIX18 の scatter 改善結果を前提とし、路線ごとの再測定は行っていない（FIX18 の
`gsi-road-reconstruction-v3.json.scatter` を正本とする）。ここでの median/p10/p90 は Hybrid 採用対象
（HIGH+MEDIUM）に限定した分離幅の分布であり、参考値。

## §48-36｜residential QA（住吉/阿倍野/平野/十三）

| エリア | GSI_HIGH+MEDIUM% | CLEAN seam | WIDTH_JUMP seam |
|---|---:|---:|---:|
| 阿倍野 | 51.0% | 249 | 316 |
| 十三 | 63.0% | 281 | 587 |
| 住吉 | 66.3% | 101 | 604 |
| 平野 | 68.0% | 202 | 611 |

4地区とも GSI 比率50%超を維持し regression なし（§44 stop condition `residentialRegression` = false）。
ただし住吉/平野は WIDTH_JUMP 比率が高く、§48-16〜20 の留保がそのまま当てはまる。

## §48-37｜runtime payload

| ファイル | サイズ |
|---|---:|
| `hybrid-surfaces-sample.json`（public配信） | 5.53 MB |
| `seams-sample.json`（public配信） | 0.89 MB |
| `provenance.json`（data/processed のみ・全大阪） | 45.26 MB |
| `manifest.json` | <1 KB |

publicへの配信は sample 2ファイル合計 6.42MB のみ（各10MB未満、validator `samplePayloadExcessive` 両方 false）。

## §48-38｜draw call への影響

`[Hybrid v1]` トグルは source 別（GSI_CORRIDOR_HIGH / GSI_CORRIDOR_MEDIUM）に BufferGeometry を1つずつ
（最大2 mesh）にまとめて描画しており、「1 pair = 1 mesh」にはしていない（§35 準拠）。`[Hybrid Seams]`
トグルも classification 別（最大4種）にまとめて最大4 mesh。両トグルとも遅延ロード・既定 OFF・`animate()`
ループ内には一切関与しない（フレーム毎コストなし）。

## §48-39｜validator 結果

`tools/validate/gsi-road-hybrid-v1.js` 実行結果:

```
canonicalRoadMutation=0  buildingMutation=0  fix13Mutation=0  invalidHybridPolygon=0
untrackedSurface=0  illegalSourcePriority=0  criticalSeamGap=0  criticalSeamOverlap=0
serviceRoadMergeViolation=0  medianCarriagewayMergeViolation=0
finalDecisionValid=true  neverReadyForProduction=true
productionModified=false  protectedModified=false
hybridToggleDefaultOff=true  hybridToggleUiPresent=true
publicHasOnlySample=true  samplePayloadExcessive=false
RESULT: PASS（エラー0・警告0）
```

## §48-40｜npm test 結果

```
tests 1419
pass 1404
fail 0
skipped 15
duration ≈ 40秒
```
mission07/08/09 prefix guard（FIX15で発見した `indexOf` 罠の再発防止）を含め全て pass。`git diff --check`
もクリーン（改行コード警告のみ・既存ファイル分・エラーなし）。

## §48-41｜visual QA 状態・最終判定

- **visualQaStatus: `VISUAL_QA_PENDING_USER`**（このセッションではブラウザを操作できないため、実機での
  目視確認は未実施。§41 の指示通り、この状態を「正式統合完了」とはしない）
- `[Hybrid v1]`（アンバー色・HIGH/MEDIUM 色分け）・`[Hybrid Seams]`（問題箇所のみ表示）の2トグルは実装済みで、
  ユーザーがローカルで `public/osaka_3d_buildings.ward-ux-v1.html` を開けば確認可能

# 最終判定：**`HYBRID_V1_NOT_READY`**

### 判定根拠（§44 stop condition のうち発火したもの）

| stop condition | 値 | 発火 |
|---|---|---|
| seamsMostlyBroken（clean比率<50%） | clean 2,662 / (2,662+4,097+0) = 39.4% | **true（発火）** |
| criticalSeamsPresent | 0 | false |
| multiCarriagewayMisclassifiedHeavily | AMBIGUOUS(16,518) vs SINGLE+DUAL(90,738)の比率 | false |
| invalidGeometryExcessive | 59/5,788 ≈ 1.0% | false |
| residentialRegression | 4地区とも50%超維持 | false |

**seamsMostlyBroken のみが発火**。これは §48-16〜20 で述べた通り、GSI/FIX13 境界の width 比較に使った
「FIX13 primary polygon 全体の area/perimeter 近似」が粗く、複雑形状のFIX13 polygonでWIDTH_JUMPを過剰計上
している可能性が高いための、**保守的側に倒れた判定**である。critical（OVERLAP/TOPOLOGY_BREAK）は0件、
residential regressionも0件、invalid geometryも僅少（1.0%）——「Hybrid統合の骨格（GSI優先→FIX13
fallback・provenance・LOW不採用・multi-carriageway粗分類・residential安全性）自体は機能しているが、
seam品質を自動でREADYと言い切るだけの精度がまだ無い」という結果である。

### 次ミッションへの引き継ぎ課題

1. **最優先**: seam の局所幅測定を「FIX13 polygon全体のarea/perimeter近似」から「seam点で道路進行方向に
   垂直な実測断面幅」へ改善する。これだけで `seamsMostlyBroken` の判定が覆る可能性が高い。
2. 広域 GAP 検出（現在は孤立1セルのみ）の実装。
3. median / ramp の個別 surface 分離（現在は DUAL_CARRIAGEWAY / MULTI_CARRIAGEWAY の粗い件数のみ）。
4. multi-carriageway (MAIN/SERVICE/MEDIAN/RAMP) の視覚的デバッグ overlay（現状は `__HYBRID_V1_DEBUG__()`
   のテキスト集計のみ）。
5. **実際のユーザー目視QA**（このセッションではブラウザ実行不可のため必須の未完了項目）。

## 完了条件（§44/§45）チェック

- [x] Canonical Road / Building / FIX13 default は完全不変（§37確認・validator PASS）
- [x] production / protected HTML 不変
- [x] GSI LOW confidence は geometry source として一切不採用（validator `illegalSourcePriority=0`・テスト確認済み）
- [x] critical seam（OVERLAP/TOPOLOGY_BREAK）0件
- [x] residential regression なし
- [x] finalDecision は `READY_FOR_USER_VISUAL_QA` / `HYBRID_V1_NOT_READY` の2択のみ（`READY_FOR_PRODUCTION`は絶対不使用）
- [x] visualQaStatus = `VISUAL_QA_PENDING_USER` を正直に記録
- [x] npm test 全 pass（1404/1404、15 skip）
- [x] public には sample-scoped のみ配信（各10MB未満）

## 変更・新規ファイル

**新規**:
- `tools/audit/gsi-road-hybrid-v1.js`（メイン。corridor v3再構成→GSI surface抽出→5m grid rasterize→
  seam検出→multi-carriageway/service-road heuristic→building/water/park QA→report生成）
- `tools/validate/gsi-road-hybrid-v1.js`（§42 validator）
- `tests/gsi-road-hybrid-v1.test.js`（11 tests）
- `data/processed/osaka-city/gsi-road-hybrid-v1/{samples/,seams.json,provenance.json,manifest.json,
  hybrid-surfaces-sample.json}`（gitignore対象・provenance.jsonのみ45MB級）
- `public/map-data/osaka-city/gsi-road-hybrid-v1/{hybrid-surfaces-sample.json, seams-sample.json}`
  （sample限定・6.42MB・ただし過去のFIX15-18のpublic sample群と同様 gitignore対象＝git未コミット、
  validatorはローカル存在のみ確認）

**変更**:
- `public/osaka_3d_buildings.ward-ux-v1.html`（`[Hybrid v1]`・`[Hybrid Seams]` トグル追加、既定OFF）
- `package.json`（`data:gsi-road-edge:hybrid-v1` / `data:gsi-road-edge:validate-hybrid-v1` スクリプト追加、
  `scripts.test` に `tests/gsi-road-hybrid-v1.test.js` 追加）
- `.gitignore`（`data/processed/osaka-city/gsi-road-hybrid-v1/`・`public/map-data/osaka-city/gsi-road-hybrid-v1/`・
  進捗ログファイル追加）

**セッション内の教訓（メモリに記録）**: 初回実装が28分超ハングした（bbox事前判定の欠如＋ループ内での
配列再構築の複合。性能修正後は同一計算が約7秒）。この教訓は
`point-in-polygon-loop-performance-trap.md` として記録し、今後の同種実装に活かす。
