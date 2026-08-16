# AUTOMATION_PIPELINE.md — 行政区追加の全自動パイプライン

手作業による座標入力は不要。区が増えても同じ1コマンドで追加できる。

## 全体フロー

```
                    ┌──────────────────────────────────────────────┐
                    │  node tools/setup-area.js                    │
                    │    --dataset osaka-higashisumiyoshi          │
                    │    --ward 東住吉区                            │
                    │    --citygml data/source/osaka-higashisumiyoshi│
                    └───────────────────┬──────────────────────────┘
                                        │
              ┌─────────────────────────┴───────────────────────────┐
              │ coordinate-config.json は存在するか？                │
              └────────┬──────────────────────────┬─────────────────┘
                 なし  │（都市で初回のみ）          │ あり（2区目以降）
                       ▼                          │
   ┌───────────────────────────────────────────┐  │
   │ STEP1  参照点の自動取得                    │  │
   │  tools/fetch-osm-references.js            │  │
   │  ・landuse.json の OSM way ID を抽出       │  │
   │  ・Overpass API で way ジオメトリ取得      │  │
   │    (2エンドポイント / 3回リトライ /        │  │
   │     40件バッチ / ローカルキャッシュ)       │  │
   │  ・重心で突き合わせ（順序・回転・反転に不変）│  │
   │  → data/buildings/references.auto.json    │  │
   └───────────────────┬───────────────────────┘  │
                       ▼                          │
   ┌───────────────────────────────────────────┐  │
   │ STEP2  原点推定（ロバスト）                │  │
   │  tools/estimate-origin.js                 │  │
   │  ・全19系 × 軸符号4通りを総当り            │  │
   │  ・中央値で初期原点 → 5m超の外れ値を除去   │  │
   │    (OSM編集された地物を自動排除)           │  │
   │  ・残差 ≤20m かつ 距離スケール比 ≈1.0 で合格│  │
   │  → data/buildings/origin-estimation-report │  │
   └───────────────────┬───────────────────────┘  │
                       ▼                          │
   ┌───────────────────────────────────────────┐  │
   │ STEP3  config 自動生成                     │  │
   │  --emit-config                            │  │
   │  ・合格時のみ書き出し（不合格なら中止）     │  │
   │  → data/buildings/coordinate-config.json  │  │
   └───────────────────┬───────────────────────┘  │
                       └──────────┬───────────────┘
                                  ▼
   ┌─────────────────────────────────────────────────────────┐
   │ STEP4  CityGML → 正規化JSON                              │
   │  tools/convert-plateau-buildings.js                     │
   │  ・configの原点・系・軸符号のみで変換（推測変換は不可）    │
   │  ・Footprint: lod0FootPrint → GroundSurface → 最下面リング│
   │  ・高さ: measuredHeight → z範囲 → 階数×3.0m → 既定3.0m    │
   │  → data/processed/{dataset}-buildings.json              │
   └───────────────────┬─────────────────────────────────────┘
                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │ STEP5  500mタイル生成 + manifest登録                     │
   │  tools/split-building-tiles.js                          │
   │  ・重心で1建物1タイル割当（境界重複ゼロ）                 │
   │  → public/data/buildings/{dataset}/tile_{tx}_{tz}.json   │
   │  → public/data/buildings/{dataset}/manifest.json         │
   │  → public/data/buildings/manifest.json（上位へ自動追記）  │
   └───────────────────┬─────────────────────────────────────┘
                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 実行時（HTML変更なし）                                    │
   │  BuildingTileLayer.initDatasets()                       │
   │   → 上位manifestを読み、新datasetを自動登録              │
   │   → カメラ連動で必要タイルのみfetch（近3×3/中5×5+先読み） │
   │   → 建物ID重複除外・形状重複除外・LRUキャッシュ           │
   └─────────────────────────────────────────────────────────┘
```

## 重要な設計判断: 原点較正は「都市に1回」

ローカル座標系は都市共通の単一原点であるため、**区ごとの較正は不要**。
2区目以降は STEP1-3 が自動的にスキップされ、STEP4-5 のみが実行される。
「区が増えるたびに手入力」という運用は構造的に発生しない。

## 使い方

```bash
# 1区目（原点較正込み・自動）
node tools/setup-area.js --dataset osaka-higashisumiyoshi --ward 東住吉区 \
  --citygml data/source/osaka-higashisumiyoshi

# 2区目以降（較正はスキップされる）
node tools/setup-area.js --dataset osaka-abeno --ward 阿倍野区 \
  --citygml data/source/osaka-abeno

# 原点を再較正（OSMデータ更新時など）
node tools/setup-area.js --dataset ... --citygml ... --recalibrate

# 事前チェック（go/no-go）
node tools/check-phase-b-ready.js
```

npmスクリプト化する場合の推奨（既存の data:import:* / data:process:* と同じ命名系）:
```json
{
  "data:calibrate:origin": "node tools/fetch-osm-references.js --landuse data/landuse.json --out data/buildings/references.auto.json && node tools/estimate-origin.js --refs data/buildings/references.auto.json --out data/buildings/origin-estimation-report.json --emit-config data/buildings/coordinate-config.json",
  "data:import:buildings": "node tools/setup-area.js"
}
```

## 検証済みの動作（合成データ・実landuse座標で確認）

| 検証 | 結果 |
|---|---|
| 外れ値（OSM編集を模擬）2件混入 | 55m/73mの2点を自動除去し、原点を厳密復元（残差0m） |
| 系・軸符号の自動判定 | 全19系×4符号から正解を選択 |
| スケール検証 | 投影距離/ローカル距離 = 1.00000 |
| 残差超過時 | config生成を拒否（exit 3）。不正な原点が下流へ流れない |
| 2区目のスキップ | 既存configを検出し STEP1-3 を自動スキップ |
| ネットワーク不通時 | 明確なエラーで停止（推測値を生成しない） |

## ファイルの役割

- `data/buildings/references.auto.json` … **本番で使用**（自動生成・コミット対象外推奨）
- `data/buildings/references.template.json` … 開発者向けサンプル（手入力の参考。本番不使用）
- `data/buildings/coordinate-config.json` … **自動生成**（都市共通・1回）
- `data/buildings/coordinate-config.template.json` … スキーマ説明用サンプル
- `.cache/osm-ways.json` … Overpass取得結果のキャッシュ（再実行時の負荷軽減）

## 開発モード（表示最適化の一時無効化）

エンジン検証・データ投入フェーズでは、タイルの自動アンロードや視錐台カリングによる
建物消失と、実際の表示不具合との区別が難しいため、既定で最適化を無効化している。

`BUILDING_TILE_CONFIG`（HTML内）の3フラグで制御する:

| フラグ | 既定(開発) | 本番 | 効果 |
|---|---|---|---|
| `enableTileCulling` | `false` | `true` | falseで距離別リング判定とLRU disposeを停止。読み込み済みタイルは表示を維持 |
| `enableFrustumCulling` | `false` | `true` | falseで建物Mesh（壁・天井・エッジ）の視錐台カリングを停止 |
| `devLoadAllTiles` | `true` | 無関係 | 開発モードでenabledなremote datasetのmanifest記載タイルを全件先読み（`devMaxTiles`で上限） |

本番向け最適化コード（リング判定・先読み・LRU・frustumCulled）は**削除しておらず**、
フラグ分岐で温存されている。ブラウザのConsoleから即時に切り替えて比較できる:

```js
// 本番挙動へ（3×3/5×5リング + LRU + 視錐台カリング）
BUILDING_TILE_CONFIG.enableTileCulling = true;
BuildingTileLayer.updateByCamera(camera);

// 開発モードへ戻す（全タイル表示維持）
BUILDING_TILE_CONFIG.enableTileCulling = false;
BuildingTileLayer.updateByCamera(camera);
```
※ `enableFrustumCulling` はMesh生成時に適用されるため、切替後に読み込まれるタイルから反映される
（既存Meshへ即時反映したい場合は `scene.traverse(o => { if (o.isMesh) o.frustumCulled = true; })`）。

段階的な再有効化の推奨順序: ①住吉区+東住吉区の検証完了 → `enableFrustumCulling=true`
→ ②大阪市全域データ投入 → `enableTileCulling=true`（この時点でLRUとリング判定が効き、
全域でもメモリ・Draw Callが一定に保たれる）。
