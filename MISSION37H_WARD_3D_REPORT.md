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
