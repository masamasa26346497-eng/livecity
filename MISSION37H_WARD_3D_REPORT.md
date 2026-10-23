# Mission 37H: 住吉区以外の 3D 建物（実 PLATEAU・限定メッシュ）

## 結果（実測）
| 項目 | 値 |
|---|---|
| 3D 建物が見える区 | **3 / 24**（住吉区の一部、北区の一部、中央区の一部）。1/24 から増加 |
| 北区 | PLATEAU メッシュ 2（52350349, 52350359）→ 13 tile・2,698 棟・約 3.7MB |
| 中央区 | PLATEAU メッシュ 2（52350400, 52350410）→ 15 tile・5,629 棟・約 7.1MB |
| 住吉区（既存） | 9 tile・10,546 棟（変更なし） |
| 合計 | 37 tile・18,873 棟（ページの coverage 実測） |
| 追加バイナリ | `public/mission37h-3dtiles/` 計 11MB（GLB 9.5MB、attrs・ids・tileset 残り） |
| 他 21 区 | 3D 未配信（地図と区境界のみ） |

**区全体ではありません。** 各区とも、限定取得した 2 メッシュ（北区は梅田周辺、中央区は心斎橋・難波北側周辺）だけです。

## 出典・手順（再現可能）
- 出典: PLATEAU 3D都市モデル 大阪市 2024（国土交通省）CityGML LOD1。ZIP（約 1.31GB）は全取得せず、既存の HTTP Range 方式（`tools/mission36k-fetch-citygml-ward-range.mjs`）で必要メッシュのエントリだけ取得（北区 2 メッシュ約 56MB、中央区 2 メッシュ約 115MB の非圧縮 GML）。費用ゼロ。
- canonicalId は CityGML の `gml:id`（`bldg_<uuid>`）そのまま。新規採番なし。住吉区 9 tile を含む 18,873 件で衝突 0。
- 区の判定は N03 区ポリゴンの点内判定（重心）。北区のメッシュ 2,837 棟のうち 139 棟は区外のため除外。
- ライセンス: PLATEAU の利用条件はリポジトリ内に記録がなく、**公開前に確認が必要**（`source.json` にも明記）。
- 高さ: `measuredHeight`（北区 2,522 / 2,837、中央区 5,488 / 5,629）、残りは LOD1 の Z 範囲。推測高さは使っていない。

```bash
node tools/mission36k-fetch-citygml-ward-range.mjs --ward kita --meshes=52350349,52350359 --out /tmp/gml-kita
node tools/mission36k-convert-citygml-runtime.mjs --input /tmp/gml-kita --output /tmp/h37/kita.jsonl --ward-hint kita
node tools/mission37h-build-ward-sample.cjs --ward kita --jsonl /tmp/h37/kita.jsonl
# 中央区: --ward chuo --meshes=52350400,52350410
```

## ページ（`public/mission37g-osaka-24ward-mvp.html`）
- 追加 tileset を `EXTRA_SET_DEFS` で読み込み（`?extra=0` で無効）。読み込めた tileset だけが COVERAGE に入る。404 等で失敗した区は「未配信」のまま。
- sidecar（ids/attrs）は tileset ごとの base から取得（tile 名が区をまたいで衝突するため）。パネルの行政区は tileset の出典から表示。

## 実 Chrome QA（`tools/experiments/mission37h_multiward_qa.mjs`、headless・ローカルサーバー）
- 北区・中央区で 3 棟ずつ（高さ 40〜120m の建物）を、投影 API で求めた画面点に **CDP の実マウスクリック**。6/6 で canonicalId が選択され、sidecar 一致、行政区表示一致。
- Google 通信 0、JS 例外 0、404 は favicon のみ。
- 住吉区の回帰（阪和病院・東福寺の実クリック→写真）: `displayed` 2/2。
- スクリーンショット: `data/reports/mission37h-wards/`。
- headless はソフトウェア描画のため、FPS は実機値ではない（実機は未計測）。Vercel Preview は未確認。

## 他 21 区への展開（未実施）
- 全市は 1,097 tile・574,213 棟。この実測（約 1.1KB/棟、GLB のみなら約 1.0KB/棟）から外挿すると約 0.6GB。Git・Vercel 静的配信には不向きで、外部ストレージ/CDN が必要（費用が発生し得るため要承認）。
- 1 区あたりの取得は 40〜70 メッシュ（北区の例: 約 50MB 圧縮）。区単位の tileset にして近傍だけ読む構成が次段階。
- 区全体の変換は、上記 3 コマンドに `--meshes` を付けず実行可能（メモリ・時間は未測定）。

---
## 37H-2（続行）: 天王寺区・西区を追加、tileset の近傍 mount/破棄、PLATEAU 出典表示

### 結果（実測）
| 項目 | 値 |
|---|---|
| 3D 建物が見える区（一部配信を含む） | **5 / 24**（住吉・北・中央・天王寺・西。いずれも区全体ではない） |
| 天王寺区 | PLATEAU メッシュ 2（51357481, 51357491）→ 6,593 棟・約 7.9MB（取得 GML 約 80MB 非圧縮／ZIP 内圧縮 約 3.1MB） |
| 西区 | PLATEAU メッシュ 2（52350318, 52350319）→ 3,893 棟・約 5.3MB（区内 424 棟除外前の読取 4,317 棟） |
| 追加バイナリ（今回） | 約 13.2MB（`public/mission37h-3dtiles/{tennoji,nishi}-sample/`） |
| 合計（coverage 実測、メタデータ由来） | 64 tile・29,359 棟 |
| 他 19 区 | 3D 未配信 |

メッシュは「5×5 サンプル点の 80% 以上が N03 区ポリゴン内」のものだけを選びました（`temp/pick.cjs` 相当。区外の建物は従来どおり重心の点内判定で除外）。canonicalId は gml:id そのまま、5 データセット間の衝突 0（テスト済み）。

### 近傍 mount / 破棄（最小変更）
- 追加 4 区は `source.json` / `build-report.json`（各 1〜2KB）だけ最初に読み、カメラが **高度 12km 未満かつ元メッシュ中心から 5km 以内**に入ったときだけ `tileset.json` と GLB を取得して mount。**9km 超または高度 20km 超で `primitives.remove`（destroy）**。判定は 1 秒周期。住吉区の基本 tileset は従来どおり常駐。
- 全域ビュー（高度 約 28km）では追加 tileset は 0 件 mount（QA で確認）。4 区を順に訪れて 4 mount、全域へ戻して 4 破棄・残り 0（QA で確認）。
- COVERAGE は mount 状態ではなくメタデータ由来（配信されている範囲の表示）。tileset 読込失敗時は `fail()` ログと再試行抑止のみで、COVERAGE からは自動では外れない（既知の制約）。
- **性能改善とは断定しません**。FPS・ロード時間は未計測（headless はソフトウェア描画）。削減されるのは遠方からの不要な tileset.json/GLB 取得だけです。

### 検証
- `node --test`（37B・37D・37E・37F×3・37G・37H の 8 ファイル）: **95 件中 95 pass**。
- 実 Chrome（`tools/experiments/mission37h_multiward_qa.mjs`、4 区×3 棟）: **12/12 で実クリック→canonicalId 選択、sidecar 一致、行政区名一致**。Google 通信 0、JS 例外 0、404 は favicon のみ。
- 回帰: 課金ガード QA 全項目 true（`kitEnabled=false`, Google 通信 0）、住吉区の実クリック写真表示（阪和病院・東福寺）`displayed` 2/2。
- スクリーンショット: `data/reports/mission37h-wards/`。Vercel Preview は未確認。

### ライセンス／出典（要確認事項）
- この環境では WebFetch が許可されず、PLATEAU 公式の利用規約ページ（MLIT PLATEAU サイトポリシー）を**確認できていません**。したがって「公開に適する」とは断定しません。
- 暫定措置として、ページの出典欄に「出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2024）を加工して作成」を表示しました。PLATEAU は一般に政府標準利用規約／CC BY 4.0 互換として公開されていると理解していますが、未検証です。公式条件を確認のうえ、必要なら文言を修正してください。
- 配信上のリスク: 条件が出典表示のみであれば現状で足りる見込みですが、確認が済むまでは Preview 限定の扱いが安全です。

### 再現
```bash
node tools/mission36k-fetch-citygml-ward-range.mjs --ward tennoji --meshes=51357481,51357491 --out temp/gml-tennoji
node tools/mission36k-convert-citygml-runtime.mjs --input temp/gml-tennoji --output temp/h37/tennoji.jsonl --ward-hint tennoji
node tools/mission37h-build-ward-sample.cjs --ward tennoji --jsonl temp/h37/tennoji.jsonl
# 西区: --ward nishi --meshes=52350318,52350319
```

## 40A: 浪速区（PR#41 由来の PLATEAU 2 メッシュ）を統合

- 取り込み元: `origin/mission38e-parallel-3d-ward-pilot`（`5c8e4d2`）の `public/mission38e-3dtiles/naniwa-mesh`（6 tile・2,466 棟）と `naniwa-mesh2`（9 tile・1,801 棟）だけ。合計 15 tile・4,267 棟・約 5.7MB。PR#41/#42/main は変更していない。hirano-subset は取り込んでいない。
- 出典: PLATEAU 3D都市モデル 大阪市 2024 LOD1（HTTP Range 取得）。**利用条件の最終確認は未了**（`source.json` の licenseNote のとおり）。区全体ではなく 2 メッシュの一部。
- 37G ページ: `EXTRA_SET_DEFS` に 2 tileset を追加。`setBuildingWard` は同じ区コードの全 tileset を並列 mount（`Promise.allSettled`、generation token、一部失敗・古い要求は mount 済み分も remove）。COVERAGE は区ごとに合算。ids/attrs は tileset 別の `_lcBase` から取得（tile 名 `t_-5_-13` 等が 2 tileset で重複するため）。
- canonicalId は 5 区既存分・2 tileset 間とも衝突 0（`tests/mission40a-naniwa-integration.test.cjs`）。
- 3D 建物が見える区: 5 → 6 / 24（いずれも一部）。ページ coverage: 79 tile・33,626 棟。
