# Mission 31G-FIX14 完了報告｜Official Road Edge Source Acquisition Audit

生成物: `data/reports/official-road-edge-source-audit.json` / `data/reports/official-road-edge-source-audit-validation.json`
方針: 公式道路縁 source を調査し、利用可能なら FIX13 への接続可否を判定する。**利用可能と確定できなければ FIX13 geometry を維持して STOP**（§0）。

**今回の調査手法について（重要）**: このセッションでは初めて、Claude Code 側の WebSearch/WebFetch ツール（bash サンドボックスのネットワーク制限とは別経路）を用いて、国土地理院・大阪市・G空間情報センター等の公式ページに対する一次情報調査を行った。ただし実 geometry ファイル（Shapefile/GML 等）のダウンロード・解凍・座標変換・重畳計測は本セッションでは実行不能（bash からのネットワークダウンロードは CLAUDE.md により不可）。そのため本ミッションは「メタデータ・利用条件レベルの調査」に留まり、§7〜§9 の実測比較は実施していない（後述）。

---

## §21-1｜調査した source 一覧

| ID | 名称 | 提供元 |
|---|---|---|
| A | GSI 基盤地図情報「道路縁」(RdEdg) | 国土交通省 国土地理院 |
| B | 大阪市 道路台帳 | 大阪市 建設局 総務部管財課 |
| C2 | 大阪市地形図（構造化データ_ESRI Shapefile）※新規発見 | 大阪市 + 一般財団法人道路管理センター |
| D | 大阪府 地図情報システム／オープンデータ | 大阪府 |
| E | 国土数値情報 道路データ（N01等） | 国土交通省（MLIT） |
| F | PLATEAU 大阪市（2024年度版） | Project PLATEAU / 社会基盤情報流通推進協議会 |

計 6 source（§1 の A〜F を網羅。G「その他 authoritative GIS」は今回の調査で A〜F の範囲を超える新規候補を発見できなかった）。
全件 `data/reports/official-road-edge-source-audit.json` の `sourceDetail` に詳細記録（provider / acquisitionMethod / crs / geometryType / coverage / license / commercialUse / apiOrDownload / sources[URL] 等）。

---

## §21-2｜GSI 道路縁の利用可否

**候補として最有力（未取得・未検証）**。

- **coverage**: 大阪市全域が該当（整備範囲＝都市計画区域。大阪市は全域が都市計画区域内 → 1/2,500相当の高精度整備）。
- **geometry**: **line**（道路縁 = 境界線。polygon ではない。車道と歩道の区別は道路縁単体では付かない → 面化には対向する縁同士の pairing 実装が必要・§11 で「単純 buffer 禁止」と明記されている通り非自明）。
- **license**: 国土地理院コンテンツ利用規約。**商用利用可・出典明記が条件**。「測量成果の複製又は使用」に該当する利用形態では測量法に基づく別申請が必要な場合がある、との記載があるが、Web 調査だけでは具体的にどの利用形態が該当するか確定できなかった（個別照会が必要）。
- **update**: 基本項目は年4回（1・4・7・10月）更新。
- **acquisition**: 基盤地図情報ダウンロードサービス（要ユーザー登録・ログイン、無償）。
- **結論**: 技術的（pairing 実装）・手続き的（測量法申請要否の確認）両面で残課題はあるが、本セッションで確認できた範囲では**最も採用条件に近い**。

---

## §21-3｜大阪市道路台帳の利用可否

**不採用**（§5 の分類に従い記録）。

- Web 閲覧: 「マップナビおおさか」で市道の位置・路線名・現況平面図を閲覧可能。
- 窓口: 建設局総務部管財課での閲覧・写しの交付（対面/郵送）。
- **GIS ダウンロード・API・オープンデータとしての公開は確認できなかった**（`www.city.osaka.lg.jp/kensetsu/page/0000370589.html` に明記なし。マップナビおおさかオープンデータ一覧にも道路台帳データ自体は非掲載）。
- 閲覧サイトからの無許可 scraping は §5 の指示通り行っていない。
- 別候補として、大阪市自身が整備する「大阪市地形図（構造化データ）」（G空間情報センター配布、§21-1 の C2）を新規発見したが、こちらは測量法上の申請プロセスが必要で商用利用条件が不明確なため、現時点では採用していない（§21-13 参照）。

---

## §21-4｜大阪府データの利用可否

**不採用**。大阪府地図情報システム（`pref.osaka.lg.jp/o130030/jigyokanri/cals/tizu.html`）は都市計画道路・地形図等の **Web 閲覧システム**のみで、道路縁・道路区域の GIS ファイル配布は確認できなかった。ダウンロード機能の記載なし。

---

## §21-5｜geometry type

| source | geometry type |
|---|---|
| GSI 道路縁 | **line**（境界線。要 pairing） |
| 大阪市道路台帳 | 不明（GIS 配布未確認） |
| 大阪市地形図（道路区画ポリゴン） | **polygon**（ただし車道/歩道の専用区分レイヤーは未確認） |
| 大阪府データ | 不明（Web 閲覧のみ） |
| 国土数値情報 N01 | line（centerline + 幅員2区分属性のみ） |
| PLATEAU 2024年度 | polygon（lod1 道路区域。既存取得分と同構造の見込み） |

---

## §21-6｜coverage

| source | coverage |
|---|---|
| GSI 道路縁 | 大阪市全域（都市計画区域内・高精度整備） |
| 大阪市道路台帳 | 市道のみ（国道・府道は別管理者）・GIS 非公開 |
| 大阪市地形図 | 大阪市全域（H30〜R06年度、継続整備） |
| 大阪府データ | 都市計画道路（表示のみ・データ配布なし） |
| 国土数値情報 N01 | 全国（都道府県単位・粗い） |
| PLATEAU 2024年度 | 大阪市全域（既存取得分と同事業） |

---

## §21-7｜accuracy

| source | 位置精度（推定・未検証） |
|---|---|
| GSI 道路縁 | 概ね 1〜2m オーダー（1/2,500地形図の標準精度からの推定。精度区分 A1〜C2 の大阪市内訳は未確認のため確定値ではない） |
| 大阪市地形図 | 「公共測量成果」と記載あるのみ・詳細仕様書未取得のため不明 |
| 国土数値情報 N01 | 数m〜十数mオーダーと推定（既存 OSM centerline より粗い可能性が高い） |
| PLATEAU 2024年度 | 既存取得分（FIX10/11 で ±1.0-1.5m 相当と評価済み）と同等の見込み |

いずれも**実測検証はしていない**（geometry 未取得のため）。

---

## §21-8｜update date / frequency

| source | 最新版 | 更新頻度 |
|---|---|---|
| GSI 道路縁 | 継続更新 | **年4回**（1・4・7・10月） |
| 大阪市地形図 | R06年度（2024年度） | 年度更新（H30〜R06の複数年度データセットが個別に存在） |
| 国土数値情報 N01 | データセットにより異なる | 不定期改定 |
| PLATEAU | 2024年度版あり（現行取得は2022年度・2年遅れ） | 年度更新 |

---

## §21-9｜license

| source | ライセンス | 商用利用 |
|---|---|---|
| GSI 道路縁 | 国土地理院コンテンツ利用規約 | **可（出典明記条件）**。測量法上の複製・使用申請要否は個別照会が必要 |
| 大阪市道路台帳 | 評価不能（GIS配布自体なし） | 不明 |
| 大阪市地形図 | 独自利用規約（大阪市＋道路管理センター著作権）。測量法43/44条の手続き（測量成果ワンストップサービス）案内あり | **不明・要申請の可能性が高い** |
| 国土数値情報 N01 | 国土数値情報利用規約 | 概ね可（出典明記条件） |
| PLATEAU 2024年度 | PLATEAU標準利用規約（政府標準利用規約2.0準拠） | 可（出典明記・既存取得分と同条件） |

---

## §21-10｜commercial use

§16「利用条件が不明なら採用しない」に照らし判定:

- **GSI 道路縁**: 商用利用は許容と明記されているが、測量法上の申請要否という残課題があるため「確定的に採用可」とは言い切らず、次ミッションでの個別照会が必要と記録。
- **大阪市地形図**: 測量法申請が必要と明記されており、単純なオープンデータではない → 現時点では不採用。
- **その他**: 大阪市道路台帳（データ非公開）・大阪府データ（データ非公開）・国土数値情報（情報量不足）はいずれも別理由で不採用。

---

## §21-11｜sample を取得したか

**取得していない（NOT_PERFORMED）**。本セッションは bash からのネットワークダウンロードが不可であり、WebSearch/WebFetch はページ内容の要約取得はできるが、Shapefile/GML のバイナリをダウンロード・解凍して geometry を解析することはできない。梅田・本町・難波・天王寺・十三・住吉（§6）での試験取得は実施できなかった。

---

## §21-12｜PLATEAU との差

実測比較は未実施（§21-11 と同じ理由）。判明した事実のみ:
- 現在ローカルに取得済みの PLATEAU tran GML の `creationDate` は **2023-03-22**（令和4年度＝2022年度相当、`uro` スキーマ 3.2）。
- G空間情報センターには **2024年度版**（`plateau-27100-osaka-shi-2024`、標準製品仕様書 v4 ベース）が別途存在し、現行データより2年度新しい。
- TrafficArea（FIX12/13 で「市域858件・0.4%のみ」と確認済み）の収録率が2024年度版で向上しているかどうかは、今回は未確認（別途ダウンロード・差分比較が必要）。

---

## §21-13｜FIX13 との差

**geometry・runtime とも無変更**（今回は調査ミッションであり、Road Visual Surface の再構築は行っていない）。
`official-road-edge-source-audit-validation.json` で以下を確認済み:
- canonical roads featureCount: 199,658（FIX12/13 と一致・不変）
- canonical buildings featureCount: 615,617（不変）
- `refined-road-surface.json` の `indexedCount`: 30,190（FIX13 時点と一致・不変）
- `official-road-edge-source-audit.js` に一律 negative buffer・建物基準 clip 等のコードなし
- production / protected HTML 不変

---

## §21-14｜幹線道路幅比較

**実施していない（NOT_PERFORMED）**。§21-11 と同じ理由（official geometry 未取得）で、御堂筋・新御堂筋・中央大通・玉造筋・今里筋・あびこ筋・松虫通・国道1号・国道25号・国道43号（§8）の official width 計測はできなかった。
参考として、FIX13 §24-10 で実施済みの「PLATEAU polygon 実効幅 vs OSM lanes advisory 幅」比較（既存データのみ）を `official-road-edge-source-audit.json` からも参照できるようにした（同レポートは `data/reports/refined-road-visual-surface.json` の `majorRoadWidths` に記録済み・本ミッションでは再計算していない）。

---

## §21-15｜building overlap 比較

**実施していない（NOT_PERFORMED）**。official edge が無いため、official width ベースの carriageway 再構成ができず、Building∩OfficialCarriageway の計測は不可能。FIX13 §24-9 の 3 段階比較（CanonicalRoad 15.44 km² → FIX12 13.06 km² → FIX13 12.40 km²）が現時点での最新値のまま。

---

## §21-16｜recommended source

`official-road-edge-source-audit.json.recommendedSource`:

```json
{
  "primary": "gsi-kiban-road-edge",
  "reason": "全国統一 authoritative・商用利用可（出典明記）・大阪市全域を高精度区分でカバー・更新頻度も明確（四半期）。line geometry の pairing 実装が唯一の技術的ハードル。",
  "secondary": "osaka-city-topo-map（測量法申請プロセスを確認できれば）",
  "note": "いずれも本セッションでは未取得・未検証。ローカル PC でのアカウント登録・ダウンロード・pairing実装・sample alignment 検証が次の実務ステップ。"
}
```

---

## §21-17｜採用 / 不採用

**RESULT: `OFFICIAL_SOURCE_NOT_USABLE`**

- `usableSources`: **0 件**（§17 の採用条件 — geometry precision 実測比較・building alignment 改善実証等 — を満たすかどうかを判定するための実データ検証ができなかったため）。
- `rejectedSources`: 4 件（大阪市道路台帳・大阪市地形図・大阪府データ・国土数値情報 N01）— それぞれ「GIS 非公開」「ライセンス不明確」「情報量不足」の理由で不採用。
- `pendingFurtherVerification`: 2 件（GSI 道路縁・PLATEAU 2024年度版）— 有望だが本セッションでは検証不能。
- **これは「official source が存在しない」という結論ではない**。GSI 基盤地図情報のように全国 authoritative かつ大阪市を高精度でカバーし商用利用可能な source は実在するが、**本セッション（Claude Code サンドボックス）では bash からのネットワークダウンロードができないため、実 geometry を取得・検証できず、採用条件を満たすかどうかを確定できなかった**、というのが正確な結論。

---

## §21-18｜次工程が必要か

**必要（ただしローカル PC 側の作業）**。本ミッションでは §19 の Integration Design も作成していない（§18 の指示通り：採用できない場合は代替 geometry を無理に作らず、FIX13 を維持して STOP）。

次工程の候補（ユーザー判断・ローカル PC 実行が前提）:
1. GSI 基盤地図情報ダウンロードサービスにアカウント登録し、大阪市域の「道路縁」を実際にダウンロード（メッシュ単位）。
2. 取得データで §7 sample alignment（梅田・本町・難波・天王寺・十三・住吉）、§8 幹線道路比較、§9 official width 計測を実施。
3. line→polygon の pairing 実装可否を検証（§11: 単純 buffer 禁止のため、対向縁の対応付けロジックが必要）。
4. 大阪市地形図（G空間情報センター）についても、測量成果ワンストップサービスでの利用申請要否・可否を確認。
5. 上記が完了し「採用可能」と判定できた場合のみ、次ミッション（31G-FIX15 相当）で Official Road Surface Integration の設計・実装に着手する。

---

## 完了条件（§20 report 要件）チェック

- [x] `data/reports/official-road-edge-source-audit.json` 作成（sourcesChecked / usableSources / rejectedSources / coverage / license / commercialUse / geometryType / accuracy / updateFrequency / sampleResults / majorRoadWidths / recommendedSource / adoptionDecision すべて含む）
- [x] GSI・大阪市道路台帳・大阪府データ・国土数値情報・PLATEAU新版・大阪市地形図（新規発見）を調査
- [x] sample alignment は実施不能である旨を NOT_PERFORMED として正直に記録（捏造データなし）
- [x] building 位置不変・canonical road 不変・FIX13 refined-road-surface 不変（validator で確認）
- [x] 一律 negative buffer・建物基準 clip 等のコード追加なし
- [x] production/protected unchanged
- [x] validator PASS（`tools/validate/official-road-edge-source-audit.js`）
- [x] npm test fail 0（1337 pass）
- [x] 次工程（Integration Design）は作成せず、FIX13 を baseline として維持して STOP

## 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `tools/audit/official-road-edge-source-audit.js` | 新規 | 6 source の調査結果を構造化して記録 |
| `tools/validate/official-road-edge-source-audit.js` | 新規 | 検証 validator |
| `tests/official-road-edge-source-audit.test.js` | 新規 | 8 件 |
| `package.json` | 変更 | scripts.test に `tests/official-road-edge-source-audit.test.js` |
| `data/reports/official-road-edge-source-audit.json` | 生成 | §20 report |
| `data/reports/official-road-edge-source-audit-validation.json` | 生成 | validator 結果 |

`public/osaka_3d_buildings.ward-ux-v1.html`・production・protected はいずれも**本ミッションでは無変更**。

---

**次工程（Official Road Surface Integration）へは進まず、Source Acquisition Audit のみ完了。FIX13 を正式 baseline として維持。ユーザー確認待ち。**
