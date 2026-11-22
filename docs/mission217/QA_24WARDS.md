# Mission217 第7段階 24区QA 状況（基準 HEAD 5739fa2）

## 結果の区分
- PASS = 現SHAで実測 / HISTORICAL = 旧SHAの証拠 / NOT_TESTED = 未実施

## 今回の run（現SHA 5739fa2）で実測できたこと
- Actions の queued/in_progress は 0 件。作業ツリーはクリーン。
- 北区・西区の単独ビルド（`--wards kita|nishi --single-pass --city-lod0`）は、取得段階で `mission79-plateau2025-fetch` が `fetch failed` となり失敗（北区2回・西区1回。北区は1〜2ファイル目の取得後に失敗）。geospatial.jp への HEAD は 200 だが、大容量 GML の Range 取得が runner から安定しない。原因（一時的なネットワーク/取得元側の切断）は未特定。
- よってビルド不能 → `--lod` E2E、P0のラベル画素比較、クリック→カード→Escape、検索/区選択、390x844・1366x768 は**すべて NOT_TESTED**（今回は実行していない）。fixture/静的テストのみ実行: syntax・city-lod0・mobile-ux・color-gate の静的テストを実行（結果はPRコメント参照）。
- ラベル最終画素: NOT_TESTED。`__lblGate.open/pending` は表示PASSの根拠にしない。既定の `lblidle` はOFFのまま。実GPU採用判定は PENDING。

## 24区×ゲート（参照元 docs/mission213/WARD_AUDIT.md）
| ゲート | 24区の状態 |
|---|---|
| 区別 単独ビルド+`--lod`(ok, クリック一致, tileFail0, 親→葉) | HISTORICAL（各区、a4d62ec〜740c50b 等の旧SHA）。現SHA: NOT_TESTED（今回 北・西は取得失敗） |
| LOD2=0 区の正常フォールバック（minato, taisho, nishiyodogawa, ikuno, asahi, tsurumi, abeno, sumiyoshi, higashisumiyoshi, hirano, nishinari） | HISTORICAL。LOD1のみでクリック一致を旧SHAで確認 |
| tileset/GLB HTTP 2xx | HISTORICAL（個別・4区一体）。現SHA NOT_TESTED |
| 道路/河川 | 道路件数は個別ビルドの旧記録あり。見た目・交差は NOT_TESTED |
| 24区一体 | 24区ビルドは HISTORICAL（1023MB, 5393セル）。sweep は 55点中12点のみ・SHAが混在。**現SHA統一の合格ではない** |
| Vercel 認証付き Preview / 実GPU | NOT_TESTED |

## 低負荷バッチ計画（未実行）
1. 取得失敗が再現するか、ローカル/runnerで北区1区のビルドを再試行（リトライ付き取得の追加を検討。要コード変更の場合は別commit）。
2. 区単独ビルド（約30〜100秒）+ `--lod --lat/--lon` を区ごとに。LOD2ありの区を先に。
3. 55地点は既存ラベル `run-mission213-qa:<n>` で順次（各回 all-wards 約1GB を再作成。無料枠残量は不明）。ビルドのキャッシュは権利/容量未確認で未採用。
4. 省コスト順: (a) 北区ビルド+lblidle 0/1 画素比較（`--shots` の同一カメラ、ラベル近傍の差分）→ (b) 区単独E2E → (c) sweep。
