# Mission213 24区 区別監査表（実測できた行のみ「確認済み」。それ以外は未確認＝合格ではない）

更新: 2de7915 の次コミット時点(福島/港/西成を追加し計13区。残11区は未確認)。旧: 58b493f 時点(Mission213 区別バッチ: 北・西・平野に加え 都島/此花/中央/東成/住之江/住吉/東住吉 を実ビルド+--lod で確認=計10区。残14区は未確認)。注意: 並列ビルドは temp/lod2-cloud を共有して衝突するため、必ず区ごとに直列でビルドすること(此花/中央/住之江/住吉は直列で再検証済み)。SwiftShader/headless Chromium の値。tileset/GLB の HTTP status 全件記録は未実施（--lod は 4xx/5xx の URL を result.httpErrors に出す。LOD0/実tilesetの非2xxは確認した範囲で 0）。出典は全区 PLATEAU 2025 CityGML v5（既存 Preview が配信している範囲と同一。第三者配信権利の判断は管理者）。

| # | 区 | wardId | 状態 | 備考 |
|---|---|---|---|---|
| 1 | 北区 | kita | 確認済み(個別E2E) | 北区の実データで --lod E2E ok=true(740c50b 時点 SHA、tileFail=0、クリック一致)。24区ビルド分割QAも実施済み(置換導入前) |
| 2 | 都島区 | miyakojima | 確認済み(個別E2E) | 個別ビルド(単独実行)+--lod ok=true。LOD2 895棟(除外65)、ID監査OK/doubleDrawn=0。30km=親(ge40)/近景=葉5、tileFail=0、クリック一致、LOD0/実tileの非404エラー0 |
| 3 | 福島区 | fukushima | 確認済み(個別E2E) | 直列単独ビルド46秒+--lod ok=true。LOD1 13,412(LOD2同ID除外10)、LOD2 1,561、ID監査OK/doubleDrawn=0、道路4,158、LOD0 187セル/5タイル。30km=親(ge40)/15km,6km=葉27/近景=葉6、tileFail=0、クリック一致。画像未目視 |
| 4 | 此花区 | konohana | 確認済み(個別E2E) | 単独ビルド再実行+--lod ok=true。LOD2 575棟、ID監査OK。親→葉(ge40→0)、tileFail=0、クリック一致。初回は選択採取の競合で一度 ok=false(再実行で ok、E2E側に再採取を追加) |
| 5 | 中央区 | chuo | 確認済み(個別E2E) | 単独ビルド+--lod ok=true。LOD2 6,212(区内除外4,764)、ID監査OK。親→葉、tileFail=0、クリック一致 |
| 6 | 西区 | nishi | 確認済み(個別E2E) | 個別ビルド+--lod E2E ok=true(run 44512755301)。本ジョブでも bw=27106 で遠景 30km=4/15km=30 タイル選択を再確認 |
| 7 | 港区 | minato | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド+--lod ok=true。LOD1 17,200、LOD2収録なし(除外0)、ID監査OK/doubleDrawn=0、道路4,520、LOD0 200セル/8タイル。30km=親8/15km,6km=葉44/近景=葉9、tileFail=0、クリック一致。画像未目視 |
| 8 | 大正区 | taisho | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 9 | 天王寺区 | tennoji | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 10 | 浪速区 | naniwa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 11 | 西淀川区 | nishiyodogawa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 12 | 淀川区 | yodogawa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 13 | 東淀川区 | higashiyodogawa | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 14 | 東成区 | higashinari | 確認済み(個別E2E) | 個別ビルド+--lod ok=true。LOD2 291(除外51)、ID監査OK。親→葉、tileFail=0、クリック一致 |
| 15 | 生野区 | ikuno | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 16 | 旭区 | asahi | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 17 | 城東区 | joto | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 18 | 鶴見区 | tsurumi | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 19 | 阿倍野区 | abeno | 未確認 | この表の作成時点で個別ビルド・E2E 未実施 |
| 20 | 住之江区 | suminoe | 確認済み(個別E2E) | 単独ビルド再実行+--lod ok=true。LOD2 9棟、ID監査OK。親→葉、tileFail=0、クリック一致。6km斜め(mid6kb)視点は選択tile 0(視点が区外に着地した可能性。穴かは未判定) |
| 21 | 住吉区 | sumiyoshi | 確認済み(個別E2E・LOD2なし) | 単独ビルド再実行+--lod ok=true。LOD2 収録なし(footprints=0, noLod2)で ID監査OK(除外0)。親→葉、tileFail=0、クリック一致 |
| 22 | 東住吉区 | higashisumiyoshi | 確認済み(個別E2E・LOD2なし) | 根因: overlay の no-lod2 早期returnが全域3D自動有効化(autoAll)を飛ばし実タイル0件(58b493f で修正)。修正後 --lod ok=true: 選択 8/60/60/4/7、30km=親(ge40)/近景=葉7、tileFail=0、クリック一致 |
| 23 | 平野区 | hirano | 確認済み(個別E2E・北区/西区と同条件) | 根因: lod2-overlay.js が LOD2 収録なしで早期 return し、遠景の粗い親用 SSE 引下げ(installCoarseSse)が未登録 → ward tileset の root(ge=160)が SSE<16 で丸ごとスキップ(visited=0)。修正後 --lod ok=true: 30km=親10(ge40)/15km=葉88/6km=葉88/3km=親5+葉/600m=葉6、tileFail=0、クリック canonicalId 一致。白格子・画像は未目視 |
| 24 | 西成区 | nishinari | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド+--lod ok=true。LOD1 32,032、LOD2収録なし、ID監査OK/doubleDrawn=0、道路7,338、LOD0 208セル/7タイル。30km=親7/15km,6km=葉42/近景=葉6、tileFail=0、クリック一致。画像未目視 |
