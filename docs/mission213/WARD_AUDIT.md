# Mission213 24区 区別監査表（実測できた行のみ「確認済み」。それ以外は未確認＝合格ではない）

更新: 本ジョブ(平野区調査)時点。SwiftShader/headless Chromium の値。tileset/GLB の HTTP status 全件記録は未実施（--lod は 4xx/5xx の URL を result.httpErrors に出す。LOD0/実tilesetの非2xxは確認した範囲で 0）。出典は全区 PLATEAU 2025 CityGML v5（既存 Preview が配信している範囲と同一。第三者配信権利の判断は管理者）。

| # | 区 | wardId | 状態 | 備考 |
|---|---|---|---|---|
| 1 | 北区 | kita | 確認済み(個別E2E) | 北区の実データで --lod E2E ok=true(740c50b 時点 SHA、tileFail=0、クリック一致)。24区ビルド分割QAも実施済み(置換導入前) |
| 2 | 都島区 | miyakojima | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 3 | 福島区 | fukushima | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 4 | 此花区 | konohana | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 5 | 中央区 | chuo | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 6 | 西区 | nishi | 確認済み(個別E2E) | 個別ビルド+--lod E2E ok=true(run 44512755301)。本ジョブでも bw=27106 で遠景 30km=4/15km=30 タイル選択を再確認 |
| 7 | 港区 | minato | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 8 | 大正区 | taisho | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 9 | 天王寺区 | tennoji | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 10 | 浪速区 | naniwa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 11 | 西淀川区 | nishiyodogawa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 12 | 淀川区 | yodogawa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 13 | 東淀川区 | higashiyodogawa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 14 | 東成区 | higashinari | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 15 | 生野区 | ikuno | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 16 | 旭区 | asahi | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 17 | 城東区 | joto | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 18 | 鶴見区 | tsurumi | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 19 | 阿倍野区 | abeno | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 20 | 住之江区 | suminoe | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 21 | 住吉区 | sumiyoshi | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 22 | 東住吉区 | higashisumiyoshi | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 23 | 平野区 | hirano | 確認済み(個別E2E・北区/西区と同条件) | 根因: lod2-overlay.js が LOD2 収録なしで早期 return し、遠景の粗い親用 SSE 引下げ(installCoarseSse)が未登録 → ward tileset の root(ge=160)が SSE<16 で丸ごとスキップ(visited=0)。修正後 --lod ok=true: 30km=親10(ge40)/15km=葉88/6km=葉88/3km=親5+葉/600m=葉6、tileFail=0、クリック canonicalId 一致。白格子・画像は未目視 |
| 24 | 西成区 | nishinari | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
