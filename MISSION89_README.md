# Mission 89: 道路・水域の独立座標検証（roadWater）

`tools/mission89-roadwater-verify.mjs` は read-only・無通信の検査器です。実行はユーザー PC のみ。fixture / CI の出力は受入になりません。

## 設計
- 建物は動かしません。道路/水域レイヤー側にだけ候補変換（identity / flipX / flipZ / rot180 / swapXZ、平行移動 5〜40m）を当て、「変換なし」が最良かを見ます。
- 信号は「建物重心が道路/水域ポリゴン内に入る率」「向き候補の差」「推定ずれ量」「最寄り外周までの距離の中央値」だけです。
  道路×水域の交差・隣接（橋・暗渠・護岸）は評価しません。誤差として数えないためです。
- 閾値に既定値はありません。`--thresholds` の JSON に `basis`（20 文字以上の根拠）、`approvedBy`、`minSamples`、`minOrientationMargin`、`maxBuildingHitRatePct`、`maxOffsetM` が無ければ、数値は出ても `unverified` です。
- 年版/メッシュ: GML は source-lock の同 kind エントリ（ファイル名・メッシュ）に載っている必要があります。現行 lock は `wtr` を持たないため、water は `unverified` です。road と water の両方が `verified` で初めて `roadWater=verified` になります。
- 水平(x,z)のみです。標高と Cesium 地表の基準は未比較で、`verticalChecked:false` と記録します。
- 報告には入力 sha256、サンプル数、方法、未カバーメッシュ、ダイジェストが入ります。

## Mission 86 / 88 との接続
- 収集器: `--roadwater <報告JSON>`。local-pc、2025 年版、tileset sha256 と lock etag の一致、閾値根拠、ダイジェスト一致、水平のみの明記が揃った場合だけ採用します。
- 受入バリデータ(86)は、方法・年版・水平のみ・閾値根拠・reportDigest・samples・waterChecked が無い `verified` を fail にします。

## ユーザー PC での実行
```
node tools/mission89-roadwater-verify.mjs --ward nishi --tran <tran GML dir> [--wtr <wtr GML dir>] --thresholds <thresholds.json>
node tools/mission88-collect-evidence.mjs --ward nishi --roadwater data/reports/mission89/roadwater/nishi.json
node tools/mission86-acceptance.mjs
```
終了コード: verified=0 / failed=1 / unverified=2。
