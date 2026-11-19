# Mission 210 - 24区 Cloud Preview への道路(PLATEAU 2025)統合 / 河川は未配信

## 監査結果(実ファイルで確認)
- リポジトリ内の道路/河川データは `public/mission37c-layers/osaka-sumiyoshi-9tile/{roads,waterways}.json`(OSM 由来・住吉区のみ)だけ。24区分の OSM 変換済みタイルはオーナーPCのみ(Mission115/116 README)。
- ビューアの区レイヤー機構(`ext-3dtiles/<ward>/layers/*.json`、`index.json` の `layersWards`、`layers-report.json` プローブ)は既存。Cloud 版は `layersWards: []` だったため道路は一切出ていなかった。
- ユーザーが見た橙/青の線は、旧住吉区の束(OSM, `mission37c-layers`)や GSI 道路縁など開発用の旧レイヤーで、24区の道路・河川レイヤーとは未接続だった。

## 今回の実装
- 道路: 各区ビルドが既に取得している公式 PLATEAU 2025 `tran:Road` の lod1MultiSurface(道路区域ポリゴン)を `tools/cloud/tran-to-layers.mjs` で `ext-3dtiles/<区>/layers/roads.json`(kind:'area')に変換。新規ダウンロード無し、旧OSM不使用、権利は建物と同じ PLATEAU(出典: 国土交通省 Project PLATEAU)。
- 座標: 建物と同一の `config/areas/osaka-city.json` projection(znorth-neg-v1)。補正オフセット無し。lat,lon 軸順を検証。
- 道路区域は車道+歩道を含む敷地で、中心線ではない。トンネル区間除外、区重心判定で隣接区との重複を排除、0.1m 丸め、20m² 未満除外、20MB/区 超過時は小さい面から落とし report に記録。
- ビューア: 落ち着いたグレー(#8d9298)の面。`roads:major`(全域モード)/`roads`(1区モード)に 1 回だけ載せる。面を線として描かない。
- 失敗時は道路だけ省略し建物ビルドは壊さない(`index.json.layersReport.roads.failed`)。`--no-roads` で無効化可。

## 未配信 / 未検証
- 河川・水域: 取得ロック(source-lock.json)は bldg/tran のみで、PLATEAU wtr は未取得 → **未配信**。旧 OSM(ODbL)は帰属・share-alike の人のレビュー前なので載せない。次の段階: wtr のソースロック生成(ネットワーク必要)。
- 公園・鉄道: 未配信。
- 実ブラウザでの道路表示・位置整合・Z-fighting・クリック退行は未検証(Vercel ビルド結果待ち)。tran の実サイズ(ward あたり)も未実測。
