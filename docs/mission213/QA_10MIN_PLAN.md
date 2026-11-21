# 10分以内 QA の可否調査と次バッチ手順(HEAD 8556b4f 時点。調査のみ・実行なし・ラベル操作なし)

## 1. 10分以内にできるか(コード/ログからの結論)
- 現行 `mission213-qa.yml` は毎バッチ「24区一体ビルド(603〜890秒, 約1023MB)→ sweep(最大25分)」。**ビルドだけで約10分**なので、現構成のまま10分以内は不可能。
- `--sweep` は `planRoute()` が24区分の attrs(ビルド出力)を要求し、`wardsFound===24` でないと `result.ok=false`(e2e-city-lod0.mjs:102,126)。区サブセットのビルドでは index 体系も判定も変わるため、**部分ビルドで index36〜54 を代替することはできない**(やると別物の経路を合格にしてしまう)。今回コードは変更していない。
- 実現可能な短縮は2つで、どちらも workflow 編集(管理者作業)が必要:
  - A) `actions/cache` で `temp/cloud-all` を復元(キー = build 入力のハッシュ: tools/cloud/**, tools/mission37b-build-3dtiles.cjs, config/wards/registry.json, vercel.json の buildCommand)。2バッチ目以降はビルド0分、sweep のみ(約5〜25分)になる見込み。**未検証**: 約1GBが cache 上限(10GB)に収まるか、cache の権利/アクセス境界(同一リポジトリ内限定。PLATEAU 派生物を外部に出さない)。初回は cache ミスで従来どおり。
  - B) 1 job 内で build→sweep を複数 step にして `--start-point 36 --max-points 12`(36〜47)と `48〜`(48〜54)を**同一ビルドで連続実行**(ビルド1回+sweep 2回)。ジョブ上限55分内(ビルド10+sweep 25+15程度)。ラベル2回=ビルド2回、を1回に減らせる。
- 推奨: B を先に(ラベル `run-mission213-qa:36` の挙動を「36〜54を連続」に変える。差分は sweep step を2回呼ぶだけ)。A は検証後。

## 2. 次バッチの実行手順(現 workflow のまま・追加編集なし)
1. 既存ラベル付与は管理者の操作。`run-mission213-qa:36`(36〜47)→完了後に外して `run-mission213-qa:48`(48〜54)。各 約9〜15分ビルド+sweep。ジョブは直列。**この run では付与していない**。
2. 各バッチ summary の `hole / not-loaded / camera-not-held` と `truncated` を確認。`partial` は未完了であって合格ではない。
3. 全55点(0〜54)が現 SHA で揃うまで「24区区境 sweep 完了」と書かない。HEAD が進んだ(アプリ本体変更)場合は旧バッチを合格流用しない。

## 3. 現SHAで未確認(優先順位つき)
| 優先 | 項目 | ブロッカー |
|---|---|---|
| 1 | sweep index 36〜54(19点) | ラベル付与(管理者) |
| 2 | 平野区など LOD2ゼロ区の LOD1 フォールバック(単独ビルドは「LOD2 収録メッシュなし」で失敗、24区一体では未確認)。24区一体ビルド出力で `--lod --ward hirano` が走るか | 24区ビルド出力が要る(`--static` 24区。workflow に --lod step 追加 = docs/mission213/QA_24WARD_PATH.md §2 の差分) |
| 3 | 24行監査(LOD1/LOD2/クリック/道路/水路/共通LOD0/区境/色/白格子/穴/tileFail/HTTP200) | qa-ward-matrix-proposal.yml の適用(管理者)。部分的に北・西・中央・福島・天王寺・浪速の単独E2Eのみ実測済み |
| 4 | cold/warm 速度 | warm 計測の既知不具合(起動24〜30秒)。cold のみ SwiftShader 値で、実機値ではない |
| 5 | 保護付き Vercel Preview の現 SHA での HTTP200 / WebGL | この run の CI ツールは Actions のみで Vercel を参照不可。Preview URL(現SHA一致)と認証を維持したアクセス手段(管理者提供)が必要。**URL・完成は未確認** |

LC_COARSE_MERGE は既定OFF・不採用のまま。24区完成の証拠ではない。
