# Mission213 24区 区別監査表（実測できた行のみ「確認済み」。それ以外は未確認＝合格ではない）

更新: a4d62ec 上に 残7区(天王寺・浪速・西淀川・東淀川・城東・鶴見・阿倍野)を直列単独ビルド+--lod で追加。全24行が個別E2E済みだが、24区一体WebGL・画像目視・速度A/B・Preview は未確認で完成ではない。6km斜め(mid6kb)の選択0は 天王寺・浪速・淀川・住之江 等で再現(区外着地の疑い、未判定)。 旧: 0f045aa 上に 大正/淀川/生野/旭 を直列単独ビルド+--lod で追加(計17区。残7区=天王寺・浪速・西淀川・東淀川・城東・鶴見・阿倍野は未確認)。以下は旧記述。 2de7915 の次コミット時点(福島/港/西成を追加し計13区。残11区は未確認)。旧: 58b493f 時点(Mission213 区別バッチ: 北・西・平野に加え 都島/此花/中央/東成/住之江/住吉/東住吉 を実ビルド+--lod で確認=計10区。残14区は未確認)。注意: 並列ビルドは temp/lod2-cloud を共有して衝突するため、必ず区ごとに直列でビルドすること(此花/中央/住之江/住吉は直列で再検証済み)。SwiftShader/headless Chromium の値。tileset/GLB の HTTP status 全件記録は未実施（--lod は 4xx/5xx の URL を result.httpErrors に出す。LOD0/実tilesetの非2xxは確認した範囲で 0）。出典は全区 PLATEAU 2025 CityGML v5（既存 Preview が配信している範囲と同一。第三者配信権利の判断は管理者）。

| # | 区 | wardId | 状態 | 備考 |
|---|---|---|---|---|
| 1 | 北区 | kita | 確認済み(個別E2E) | 北区の実データで --lod E2E ok=true(740c50b 時点 SHA、tileFail=0、クリック一致)。24区ビルド分割QAも実施済み(置換導入前) |
| 2 | 都島区 | miyakojima | 確認済み(個別E2E) | 個別ビルド(単独実行)+--lod ok=true。LOD2 895棟(除外65)、ID監査OK/doubleDrawn=0。30km=親(ge40)/近景=葉5、tileFail=0、クリック一致、LOD0/実tileの非404エラー0 |
| 3 | 福島区 | fukushima | 確認済み(個別E2E) | 直列単独ビルド46秒+--lod ok=true。LOD1 13,412(LOD2同ID除外10)、LOD2 1,561、ID監査OK/doubleDrawn=0、道路4,158、LOD0 187セル/5タイル。30km=親(ge40)/15km,6km=葉27/近景=葉6、tileFail=0、クリック一致。画像未目視 |
| 4 | 此花区 | konohana | 確認済み(個別E2E) | 単独ビルド再実行+--lod ok=true。LOD2 575棟、ID監査OK。親→葉(ge40→0)、tileFail=0、クリック一致。初回は選択採取の競合で一度 ok=false(再実行で ok、E2E側に再採取を追加) |
| 5 | 中央区 | chuo | 確認済み(個別E2E) | 単独ビルド+--lod ok=true。LOD2 6,212(区内除外4,764)、ID監査OK。親→葉、tileFail=0、クリック一致 |
| 6 | 西区 | nishi | 確認済み(個別E2E) | 個別ビルド+--lod E2E ok=true(run 44512755301)。本ジョブでも bw=27106 で遠景 30km=4/15km=30 タイル選択を再確認 |
| 7 | 港区 | minato | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド+--lod ok=true。LOD1 17,200、LOD2収録なし(除外0)、ID監査OK/doubleDrawn=0、道路4,520、LOD0 200セル/8タイル。30km=親8/15km,6km=葉44/近景=葉9、tileFail=0、クリック一致。画像未目視 |
| 8 | 大正区 | taisho | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド65秒+--lod ok=true(0f045aa)。中心 34.64664,135.46502(tileset region算出)。LOD1 19,459、LOD2収録なし、ID監査OK/doubleDrawn=0、道路5,156、LOD0 230セル/6タイル。30km=親6(ge40)/15km,6km=葉52/3km=親(ge40)/近景=葉4、tileFail=0、クリック一致、tileset/GLB非2xx0。画像未目視 |
| 9 | 天王寺区 | tennoji | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.66062,135.52005(tileset region算出)。LOD1 14,235(除外0)、LOD2 2,578、道路3,774、LOD0 209セル/8タイル。ID監査OK/doubleDrawn=0。30km=親4(ge40)/15km=葉29/6km斜め=選択0/3km=葉9+親/近景=葉7、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 10 | 浪速区 | naniwa | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.65898,135.49594(tileset region算出)。LOD1 10,278(LOD2同ID除外5)、LOD2 1,777、道路3,165、LOD0 154セル/5タイル。ID監査OK/doubleDrawn=0。30km=親5/15km=葉28/6km斜め=選択0/3km=葉10+親/近景=葉6、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 11 | 西淀川区 | nishiyodogawa | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.70800,135.43968(tileset region算出)。LOD1 27,381、LOD2収録なし、道路8,090、LOD0 312セル/10タイル。ID監査OK/doubleDrawn=0。30km=親10/15km,6km=葉67/3km=親のみ6/近景=葉6、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 12 | 淀川区 | yodogawa | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(0f045aa)。中心 34.73037,135.47631。LOD1 35,296(LOD2同ID除外2,874)、LOD2 3,863、ID監査OK/doubleDrawn=0、道路10,722、LOD0 358セル/11タイル。30km=親10/15km=葉65/近景=葉5、tileFail=0、クリック一致、非2xx0。**6km斜め(mid6kb)は選択tile 0**(視点が区外着地の疑い、未判定)。画像未目視 |
| 13 | 東淀川区 | higashiyodogawa | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.74507,135.53039(tileset region算出)。LOD1 34,825(除外511)、LOD2 785、道路11,488、LOD0 317セル/11タイル。ID監査OK/doubleDrawn=0。30km=親10/15km,6km=葉62/3km=親のみ6/近景=葉6、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 14 | 東成区 | higashinari | 確認済み(個別E2E) | 個別ビルド+--lod ok=true。LOD2 291(除外51)、ID監査OK。親→葉、tileFail=0、クリック一致 |
| 15 | 生野区 | ikuno | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド+--lod ok=true(0f045aa)。中心 34.64952,135.54428。LOD1 45,427、LOD2収録なし、ID監査OK/doubleDrawn=0、道路9,935、LOD0 246セル/7タイル。30km=親7/15km,6km=葉51/近景=葉6、tileFail=0、クリック一致、非2xx0。画像未目視 |
| 16 | 旭区 | asahi | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド+--lod ok=true(0f045aa)。中心 34.72772,135.54763。LOD1 24,962、LOD2収録なし、ID監査OK/doubleDrawn=0、道路6,117、LOD0 166セル/5タイル。30km=親5/15km,6km=葉40/近景=葉7、tileFail=0、クリック一致、非2xx0。画像未目視 |
| 17 | 城東区 | joto | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.69669,135.54987(tileset region算出)。LOD1 32,192(除外188)、LOD2 615、道路8,384、LOD0 267セル/6タイル。ID監査OK/doubleDrawn=0。30km=親6/15km,6km=葉46/3km=葉8+親/近景=葉6、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 18 | 鶴見区 | tsurumi | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.70531,135.57898(tileset region算出)。LOD1 25,309、LOD2収録なし、道路8,131、LOD0 241セル/8タイル。ID監査OK/doubleDrawn=0。30km=親8/15km,6km=葉51/3km=親のみ6/近景=葉7、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 19 | 阿倍野区 | abeno | 確認済み(個別E2E) | 直列単独ビルド+--lod ok=true(a4d62ec 時点、run 44571078211)。中心 34.63228,135.51270(tileset region算出)。LOD1 26,498、LOD2収録なし、道路6,017、LOD0 177セル/6タイル。ID監査OK/doubleDrawn=0。30km=親6/15km,6km=葉37/3km=親のみ5/近景=葉6、tileFail=0、クリック一致、tileset/GLB/_city-lod0 の非2xx 0(4xx 50件打切りは stations-24 等の既存404のみ確認)。画像未目視 |
| 20 | 住之江区 | suminoe | 確認済み(個別E2E) | 単独ビルド再実行+--lod ok=true。LOD2 9棟、ID監査OK。親→葉、tileFail=0、クリック一致。6km斜め(mid6kb)視点は選択tile 0(視点が区外に着地した可能性。穴かは未判定) |
| 21 | 住吉区 | sumiyoshi | 確認済み(個別E2E・LOD2なし) | 単独ビルド再実行+--lod ok=true。LOD2 収録なし(footprints=0, noLod2)で ID監査OK(除外0)。親→葉、tileFail=0、クリック一致 |
| 22 | 東住吉区 | higashisumiyoshi | 確認済み(個別E2E・LOD2なし) | 根因: overlay の no-lod2 早期returnが全域3D自動有効化(autoAll)を飛ばし実タイル0件(58b493f で修正)。修正後 --lod ok=true: 選択 8/60/60/4/7、30km=親(ge40)/近景=葉7、tileFail=0、クリック一致 |
| 23 | 平野区 | hirano | 確認済み(個別E2E・北区/西区と同条件) | 根因: lod2-overlay.js が LOD2 収録なしで早期 return し、遠景の粗い親用 SSE 引下げ(installCoarseSse)が未登録 → ward tileset の root(ge=160)が SSE<16 で丸ごとスキップ(visited=0)。修正後 --lod ok=true: 30km=親10(ge40)/15km=葉88/6km=葉88/3km=親5+葉/600m=葉6、tileFail=0、クリック canonicalId 一致。白格子・画像は未目視 |
| 24 | 西成区 | nishinari | 確認済み(個別E2E・LOD2なし) | 直列単独ビルド+--lod ok=true。LOD1 32,032、LOD2収録なし、ID監査OK/doubleDrawn=0、道路7,338、LOD0 208セル/7タイル。30km=親7/15km,6km=葉42/近景=葉6、tileFail=0、クリック一致。画像未目視 |

## 6km斜め(mid6kb)選択0 の原因(淀川区で実測・修正)
- 画面中心レイの着地点は tileset 根の境界球の内側(距離 0〜32m)で、区外着地ではなかった。根は visible・cullOk=1(視錐台で除外されていない)。
- 実原因: 空コンテンツの中間タイル(ge120/160)の SSE が 8.5/13.9 で上限(16/32)未満となり、descend も描画もされず選択0(実建物寄与 0)。遠景用 SSE 引下げが「高度>6000m」のみで、高度6000m・斜めでは未発動だった。
- 修正: lod2-overlay.js で tileset 境界球までの距離>6000m(`?lod2coarsed`)でも引下げ。淀川区: 選択 0→65(葉65)、realShare 0→0.041、tileFail 0、クリック一致、他視点は不変。
- 住之江・此花・中央・天王寺・浪速は未再測定(同原因かは未確認)。

## 追記(cd856dd 時点・住之江区の再測定)
- `--lod --lat 34.6080 --lon 135.4760`(住之江中心) ok=true。6km斜め(mid6kb)は選択116/葉116、親→葉=true、クリック一致、tileFail=0、全視点held。以前の「選択0」は SSE穴修正後は再現せず。
- 注意: `--lat/--lon` を省くと既定の北区座標で撮るため、他区では選択0になる(実行ミスであり穴ではない)。必ず区の座標を渡すこと。
- 3km視点は選択5/葉0(LOD2/親の混在の可能性。未調査)。画像目視・他4区(此花/中央/天王寺/浪速)・24区一体・速度・Previewは未実施。

## 追記(30e7f9a 時点・此花区の6km斜め再測定)
- `build-cloud-preview.mjs --wards konohana --single-pass --city-lod0`(98秒、LOD1 17,040、LOD2 575、doubleDrawn=0、LOD0 343セル/12タイル)後、`--lod --lat 34.6836 --lon 135.4500` ok=true。
- 6km斜め(mid6kb): 選択60/葉60、realShare 0.036、tileFail 0。着地点は根の境界球の内側(距離約50m)。**選択0の穴は再現せず**。30km=親12(ge40)/15km=葉66/近景600m=葉6、クリック一致。
- 3km視点: 選択6/葉0(親ge40のみ)だが realShare 0.357 で実建物は描画されており、穴ではない(他区の「3km=親のみ」と同傾向)。
- PNG(--shots)は未採取・未目視。中央・天王寺・浪速の6km斜め、24区一体、速度、Previewは未再測定。

## 追記(e51f3be の次コミット・西区の PNG と baseline 再計測)
- 西区 `--lod --shots`: 118秒で完走(300秒 timeout は `--compare` の多条件一括が原因で、1視点ずつ/`--lod` なら収まる)。ok=true、全5視点 held、tileFail 0、クリック一致。
- PNG 目視(3km/6km斜め/15km): 3kmは青灰色建物・灰色道路・水色河川が読め白格子なし。6km/15kmは西区ポリゴン内に実建物が描かれ、北東に 200m 模式セルの帯が残る(西区のみのビルドで隣区実タイルが無いための fallback と推測。24区ビルドでの消失は未確認)。LOD2 重複の定量(21セル問題)は未実施。UI パネルが画面を覆う。
- baseline: 旧版は固定視点が無く実タイル選択前の tilesLoaded=true で cold が早期終了していた。固定視点(3000m -60°)+「実タイル選択>0 が連続成立」で再計測(西区): cold 15.5MB/183req/完了28.2s、warm 10.1MB/175req/完了47.5s、frame p50/p95 74.4/97.3 vs 73.6/95.3、tileFail 0。**warm の viewer 起動が 24s かかる原因は未解決**(cold は 1.9s)。SwiftShader 値で実機ではない。北区ではなく西区で測定。

## 追記(29ee12b 時点・西区+隣接3区の同一ビルド小規模WebGL)
- `build-cloud-preview.mjs --wards nishi,chuo,fukushima,kita --single-pass --city-lod0 --out temp/nec`: 101秒、167MB。4区合計 元LOD1 64,271 = 補完57,848 + LOD2同ID除外6,423、LOD2 8,268、全区 doubleDrawn=0、LOD0 754セル/15タイル。
- `e2e-city-lod0.mjs --static temp/nec --lod --lat 34.6786 --lon 135.4900 --shots temp/shots-nec`: ok=true、クリック canonicalId 一致。4区が同一画面で読み込まれる(UI: 4/24区、kita/fukushima/chuo/nishi が tileVisible>0・GLB 200)。
- 目視(15km): 西区北東の 200m 模式セル帯は、隣区(中央・福島・北)を同一ビルドに含めると見えない=単独ビルドの fallback と整合。6km斜めは画面左上に小さな青い方形が数個残るが、LOD0 か実建物かは未判定。画面は UI パネルが大半を覆う。konohana は4区ビルドに含めていないため未読込(想定)。
- 24区一体・速度・Preview は未確認。

## 追記(95863b8 の次コミット・4区一体の HTTP 打切りなし集計)
- `temp/nec`(西・中央・福島・北、101〜165秒)で `--lod`: ok=true、クリック一致、親→葉、全視点 tileFail=0。新設 `result.httpStat`(打切りなし): LOD0 tileset 1/GLB 15、実 tileset 5/実 GLB 219 がすべて 2xx、非2xx 0。
- 6km斜めの青い方形は未判定(4区ビルドの LOD0 は 4区由来で、未ロード区由来ではないことのみ判明)。詳細は `QA_24WARD_PATH.md`。
- 24区一体・速度・Preview は未確認。個別E2E(旧SHA)と 4区一体(現SHA)は別欄で扱い、20区は一体では未確認。

## 追記(現SHA=本コミット・中央+天王寺+浪速 3区一体の --cells、3x3/9x9 分離)  ※旧SHA(d5054a6以前)の4区一体の値とは別欄
- `build-cloud-preview.mjs --wards chuo,tennoji,naniwa --single-pass --city-lod0 --out temp/ctn`: 125秒、118MB、LOD0 538セル/13タイル、全区 doubleDrawn=0。
- `e2e-city-lod0.mjs --static temp/ctn --lod --cells --ward tennoji`(各約3分、2回): ok=true、クリック一致、LOD0/実tileset/GLBの非2xx 0、全視点 held。
- セル分類(非表示/表示/画面外 | 表示中のうち 3x3で実建物あり / 9x9のみ / 実建物なし):
  - 30km: 496/42/0 | 0 / 1 / 41 (親のみ選択。LOD0 が代替表示=設計どおり)
  - 15km: 436/102/6 | 1 / 1 / 94(前回別実行では 319/219 と不安定。選択tile数は同一で、置換の球集合が実行ごとに変わる=原因未調査)
  - **6km斜め: 436/102/0 | 3x3で実建物あり 102 / 0 / 0**。選択は葉28/43/29(実タイル描画済み)。表示中セル全102が実建物の上にあり、9x9の隣接拾いではない(3x3でも差あり)=**二重描画の疑いが強い**。前報告「82中76は実建物なし」は4区一体・旧SHAの値で、この3区ビルドでは再現せず。
  - 3km/近景: 画面外のみ(置換済み・問題なし)。
- 分類: 6km斜めの残留は「SSE/視錐台で実タイルが未選択」ではなく、実タイルが選択・描画済みなのに `tileVisible` の球に中心が入らないセルが残る型(置換判定の取りこぼし)と推測。**球と各セル中心の距離を取っていないため未確定**。セルID・画面座標は temp/cells2.json(ローカル、非commit)。
- 住之江3kmの「親のみ」: 今回未再測定。
- 24区一体・速度・Preview は未確認。

## 追記(同一3区ビルド chuo,tennoji,naniwa・同一SHA 5ec2948 上・天王寺6km斜め(pitch -30, aim)の矛盾調査)
- 同一ビルド(59秒)に `--lod --cells --ward tennoji`(約2分)と `--compare --resid-detail --ward tennoji --variants swapOn --views mid6kb`(約52秒)を連続実行。カメラ式は両モードとも lat=lat0-h/tan(pitch)/111320, h=6000, pitch=-30 で同一(コード比較)。
- `--cells` 6km: 置換で非表示 436 / 表示 102 / 画面外 0。9x9 realUnder 15、**3x3 realUnder 1**、noRealUnder 87。→ 今回の「1/102」を再現。前回の「102/102」は再現せず。
- `--compare --resid-detail` mid6kb: **非表示 0 / 表示 538**(置換がセルを隠していない状態で診断)。realUnder 396、lod0Front 0(実建物が手前=二重表示ではない)。
- 結論(確定範囲): 102 と 1 の差は、診断の画素差分そのものより、**診断時点で置換が適用済みか(非表示セル数 436 vs 0)** と判定窓に依存して見える可能性が高い。前回「102/102」がどの状態の値かは記録が無く、断定不可。`--compare` では置換が効いていない理由は未調査。表示コードは変更していない。
- e2e に rdetail.hidden(診断時の非表示セル数)を追加し、状態の違いを結果から判別できるようにした。

## 追記(統一診断: --compare の「hidden 0 / 表示 538」の原因特定・SHA は本コミット、efc4e52 上)
- 同一3区ビルド(chuo,tennoji,naniwa、50秒)で `--compare --resid-detail --ward tennoji --variants swapOn --views mid6kb` を4回実行。置換は常に有効(`swapEnabled=true`、安定待機後 hidden 436 / visible 102 / spheres 100、camH 6000 held、tileFail 0、HTTP 4xx は既存404のみ)。
- **`--compare` が置換OFFだったわけではない。** 診断(`pix`/`rdetail`)内で `T.show` や実tilesetの `show` を切り替えて撮るため、その後の `c.f.show` を読むと全セルが「表示」に見える(pix直後の生スナップショットが 0/538 になる実行があり、待機後は 436/102 に戻る。4回中3回で再現、1回は崩れず=非決定的)。崩れる機構自体は未特定。
- 修正: `rdetail`/`pix`/`--cells` は撮影前に H0(セル→show)を採取し、その値で hidden を判定する。修正後の rdetail は hidden 436 / shown 102 / 3x3 realUnder 1 / lod0Front 0 で、`--cells`(436/102/3x3=1)と一致。
- 新規出力 `swapState`(`pre`/`atDetailRaw`/`atDetail`/`rawVsPre`/`rdetailHiddenMatchesPre`、`--lod` 各行にも): swapEnabled・hidden・visible・total・selected/selectedLeaf・camH・viewport・tileFail・httpNon2xx・待機時間。純関数 `swapStable`/`comparableDiag`(sweep-plan.mjs)でfixtureテスト済み。
- 102 セル ID の同一性の突合、境界セル `lod0_-18_-37` の再確認(優先2)、住之江/中央/浪速(優先3)は未実施。表示コード(HTML)は変更していない。二重描画件数の断定はしない(3x3 実建物あり 1/102 は 6km・天王寺・この1ビルドの値)。

## 追記(f924a39 上・同一3区ビルドでの 102 セル ID 突合。ローカル実測、SwiftShader)
- `build-cloud-preview.mjs --wards chuo,tennoji,naniwa --single-pass --city-lod0 --out temp/ctn`: 78秒、118MB、元LOD1 43,173、doubleDrawn=0、LOD0 538セル/13タイル。
- `--compare --resid-detail --ward tennoji --variants swapOn --views mid6kb`(約1分)と `--lod --cells --ward tennoji`(約3分)を同一ビルドで実行。出力に表示中セルの全 ID(`shownIds`、上限なし)を追加して突合。
- 6km斜め(held=true): `--resid-detail` 非表示436/表示102/3x3 realUnder 1、`--cells` 非表示436/表示102/画面外0/3x3 realUnder 1/noRealUnder 87。**表示102セルの ID 集合は完全一致**(共通102、片側のみ0)。swapState の rdetailHiddenMatchesPre=true。
- 唯一の realUnder3 セルは `lod0_-18_-37`(境界セル。最寄り選択球の外 11m、葉タイル)。lod0Front=0・realUnderLod0Front=0 のため、LOD0 が実建物の前面に出ている証拠はない(=二重表示の確証なし)。表示コードは変更しない。
- HTTP(`--lod --cells` 実行): LOD0 tileset 1/GLB 13、実 tileset 4/実 GLB 131 がすべて 2xx、非2xx 0(外部 404 は towns-24/stations-24/favicon/旧 mission の build-report 等で LOD0・実建物と無関係)。クリック canonicalId 一致、親→葉 true、全視点 held・tileFail 0。
- 非決定的な状態崩れ(pix 直後に 0/538 になる現象)は、今回の2実行では再現せず。機構は未特定のまま。fixture での再現は未実施。
- 未実施: 住之江3km親、中央・浪速6km、24行監査表の更新、cold/warm 分離計測、24区一体、現SHAの認証付き Preview。
