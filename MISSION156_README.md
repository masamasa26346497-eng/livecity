# Mission 156: PLATEAU 公式データからの 24区 建物 全面再取得（PC 旧データ非依存）

出典: 国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025 / CityGML v5、`plateau-27100-osaka-shi-2025`）。PLATEAU サイトポリシー（商用可・出典表示）。27999（万博）は権利ゲートで拒否。

## コマンド（空の runner で動作。Windows/旧キャッシュ不要）
```
node tools/mission156-run-all.mjs --plan                         # 権利ゲート + 24区の mesh/容量計画（オフライン）
node tools/mission156-run-all.mjs --wards sumiyoshi              # 1区: Range取得→CityGML→LOD1→3D Tiles（mission79 を無変更で再利用）
node tools/mission156-run-all.mjs --all --budget-mb 3000         # 中断再開可（ETag一致かつ出力ありの区はskip）
node tools/mission156-verify-served.mjs --dir temp/mission156/<ward>/tiles --ward <ward> --chrome --record
```
出力は `temp/mission156/`（gitignore、commit/公開しない）。`data/reports/mission156/` に小さな progress / plan / id-duplicates のみ記録。
Workflow は `.github/workflows` へ書けないため `tools/mission156/mission156-fresh-plateau.workflow.yml.txt` にテンプレート（人が配置）。区ごと matrix（max-parallel 3、20分、artifact 3日）。

## 区ごとの指標（別々に記録。全て揃うまで `complete` にならない）
pending → partial → converted → served（HTTP200＋bounds）→ complete（実Chrome/Cesium）。`failed` は理由付き。

## 実測（2026-11-08, GitHub runner, 無料）
- 計画: 24区 / 270 mesh / 圧縮 約922MB / 展開 約20GB（区別合計、mesh は区間で共有）。全区に mesh あり。
- **住吉区（27120）全 19 mesh**: 取得 34.4MB 圧縮、読込 62,553 棟 → 区内 **35,032 棟**（区外 27,521 は除外）、ID重複 0、52 tile、出力 51.1MB、約58〜75秒。向き検査 identity（反転/回転なし）。
- ローカル配信 HTTP200: 117 URI 全て 200、region は住吉区内（135.487–135.524E, 34.587–34.625N）。
- 実 Chrome(headless) + CesiumJS 1.121.1: tileset ロード成功、tilesLoaded=true、JS 例外 0、WebGL 有効、中心 (135.5056E, 34.6062N)。
- 西区: 2 mesh で 2,491 棟・ID一意（前段の動作確認）。
- 全体の測定値合計は **35,032 棟（宣言 574,213 の 6.1%）**。残り23区は未取得。「24区完成」ではない。

## 未達 / 次
1. 残り23区の取得（workflow テンプレートを配置して `wards=all`、または `--all` を複数回）。
2. 正規 Live City ビューアへの接続（本PRでは未実施。mission37b/38 系の ward manifest 形式への出力アダプタ）。ビューア HTML は触っていない。
3. 道路・河川との重ね比較は tran 向き検査（mission79 流用）のみ。ビューア上の目視比較は未実施。
4. LOD2: PR #50 と衝突するため未編集。ID は gml:id 無変更なので、将来 LOD2 を同 ID で結合可能。LOD2 が無い建物は LOD1 のまま。
5. 非公開保存先: PLATEAU は公開データのため権利上は問題ないが、配信先（Vercel/Git）への公開は承認待ち。現状は temp + 短期 artifact のみ。
