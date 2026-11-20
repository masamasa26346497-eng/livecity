# 24区一体 QA の実行経路(判定・手順・計測設計)

作成: HEAD 95863b8 の次コミット。**実行はしていません(ラベル未付与)。24区一体の証拠は未取得。**

## 1. 現行 PR HEAD で 24区一体ビルド+区境 sweep は既存経路で実行可能か
- `.github/workflows/mission213-qa.yml` は `docs/mission213/qa-workflow-proposal.yml`(v2)と**同一内容**(diff 差分なし)。適用済み。
- 起動はラベル `run-mission213-qa[:<n>]` の付与のみ(`labeled`)。PR #68 head・同一リポジトリ限定、secrets なし、artifact は集計 JSON のみ。
- したがって**新規の workflow 編集は不要で、ラベル付与だけで実行できる**。ただしラベル付与は課金枠(runner 分数)を消費する操作なので、**この run からは付与していない**。承認があれば管理者がラベルを付ける。
- 現行 workflow が測るもの: 24区一体ビルド(`--all-wards --city-lod0`、実測 590〜890秒)+ `--sweep`(区中心・区境、高度 3000/10000、12点/バッチ)。測らないもの: 親→葉(`--lod`)、クリック、LOD0/tileset/GLB の URL 別 HTTP 集計。
- 想定 runner 分数: 1バッチ ≒ 準備+ビルド 11〜15分+sweep 最大25分 ≒ 最大約45分(ジョブ上限55分)。
  経路 55点なら 0/12/24/36/48 の5バッチ ≒ 最大約225分。private リポジトリの無料枠(月2,000分)内だが、残枠は管理者確認が必要。
- 注意: 既存の 55地点 sweep は置換修正前(364ae1e)の結果。現 SHA の証拠にならない。

## 2. 最小差分案(適用は管理者。Claude は .github/workflows を編集しない)
`mission213-qa.yml` の sweep step の後に追加(区境 2地点でクリック・LOD・HTTP を 24区一体ビルドに対し取る):
```yaml
      - name: LOD/click/HTTP E2E on the 24-ward build (border points; PNG is not uploaded)
        if: always()
        run: |
          # 区境2地点(座標は qa.json の sweep.rows から ward-border 行の lon/lat を使う。下記は西/中央境付近の例)
          node tools/cloud/e2e-city-lod0.mjs --static temp/cloud-all --chrome "$CHROME" --lod \
            --lat 34.6786 --lon 135.4900 --shots temp/shots --out temp/lod-24.json
          node -e "const r=require('./temp/lod-24.json');console.log(JSON.stringify({ok:r.ok,click:r.checks.clickSelectsBuilding,sw:r.checks.lodSwitch,httpStat:r.httpStat}))" | tee -a "$GITHUB_STEP_SUMMARY"
```
- PNG は `temp/shots` に出るが upload-artifact の path に含めない(現行の path は qa.json と summary.md のみ)=原データ由来画像を公開しない。
- 2地点目は別座標で同 step を繰り返す。1 step 約2分。
- `httpStat`(下記)は `qa.json` にも入るので、summary への表示追加は任意。

## 3. HTTP エラーの URL 別・打切りなし集計(今回コードに実装)
`e2e-city-lod0.mjs` に `result.httpStat` を追加。`httpErrors` は先頭50件で打切りだったため別集計:
`lod0Glb` / `lod0Tileset` / `realGlb` / `realTileset` ごとに `n2xx`、`nNon2xx`、非2xx の URL→status。
- 実測(4区同一ビルド、`--lod`、視点は 34.6786,135.4900): `lod0Tileset` 2xx=1 非2xx=0、`lod0Glb` 2xx=15 非2xx=0、`realTileset` 2xx=5 非2xx=0、`realGlb` 2xx=219 非2xx=0。**この4区ビルドに限り、LOD0/tileset/GLB の非2xx は 0(打切りなし)**。`httpErrors` の50件打切り分は stations-24 等の既存 404(LOD0 とは別)。
- `--lod` は ok=true、クリック canonicalId 一致、親→葉=true(30km=親 ge40/近景=葉6)、全視点 tileFail=0。

## 4. 4区ビルド 6km の青い方形の正体(未判定)
- 6km斜め PNG を再度目視: 区域内の北寄りに小さな青白いブロック群が見える(LOD0 の模式セルか実建物かは画像から区別できない)。
- 分かったこと: この4区ビルドの LOD0 は 4区の LOD1 からのみ生成(`wards:4`、754セル)。**未ロードの区(此花など)由来のセルではない**。
- 未実施(必要): ブロックのセル ID(`lod0_<cx>_<cz>`)と画面位置の対応付け。`--compare` の `pix` 方式(セル中心の投影+実建物画素の有無)を 6km 斜めで `--lod` に流用する実装が次の一手。**分類は未完で、穴・白格子の判定もしていない。**

## 5. 速度計測の設計(未実施。warm/CDN 比較の再実施はしない)
3つを分離して記録する(すべて cold、キャッシュ無効化、同一ビルド・同一カメラ):
1. UI 準備: ナビゲーション開始 → viewer 生成+`tilesetReady`(LOD0 を含む)。
2. 初回実建物画素: ナビゲーション開始 → 実LOD1/2 のみを描画したフレームで、LOD0 非表示との画素差が初めて>0(`realShare` 方式)。
3. 周辺詳細完了: 固定視点で、選択された実タイルがすべて ready になるまで(`tilesLoaded` が実タイル選択>0 で連続成立)。
併せて bytes・要求数・tileFail・frame p50/p95(SwiftShader。実機値ではない)。warm は別軸(`--baseline` の既知不具合: viewer 起動24s)で、本設計の対象外。

## 6. 24行監査表への欄追加方針
`WARD_AUDIT.md` の表は「旧SHAの個別単独ビルドE2E」。現SHAの一体表示は別欄とし、現時点は 4区(西・中央・福島・北)のみ確認、残20区は未確認。

## 7. Vercel Preview
この run のツール(`get_ci_status` 等)は Actions のみで Vercel デプロイを返さない。HTTP200/WebGL 確認に必要な情報: (a) 現 SHA に一致する Preview URL(PR の Vercel コメント由来。直近コメントの URL は `364ae1e` 相当の古い可能性)、(b) 認証保護を維持したままのアクセス手段(Shareable Link / bypass トークンの提供は管理者判断。認証は解除しない)。**未確認。**
