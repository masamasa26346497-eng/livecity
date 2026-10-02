# Mission 35P｜大阪市 PLATEAU LOD2/LOD3 全数リモート監査

実行環境: GitHub Actions  
ブランチ: `feature/mission-35p-lod2-audit`  
対象: 2025年度 大阪市 3D都市モデル（Project PLATEAU）CityGML v5  
production / protected: **未変更**

## 結論

Live CityでLOD2以上を使う現実的な方法は存在する。2025年度大阪市PLATEAUの公式CityGMLを建物単位で全数監査した結果、**完全なLOD2が10,698棟、完全なLOD3が15棟**確認できた。

外部有料LOD制作サービスは使用していない。今回の調査は公式公開データ + GitHub Actionsのみ。

## 実測結果

- CityGML ZIP: 1,507.2 MB
- building GML圧縮合計: 354.5 MB
- building GML files: 270
- 建物: **616,119棟**
- LOD2 present: **10,698棟（1.74%）**
- LOD2 complete: **10,698棟（1.74%）**
- LOD3 present: **15棟**
- LOD3 complete: **15棟**

complete判定はMission 34Dの既存基準を再利用し、単に`lod2`タグがあるだけでは採用していない。RoofSurface + WallSurface + GroundSurface/ClosureSurface + 最低polygon/posList数を満たす建物のみをcompleteとした。

## 代表地点

| 地点 | 高LOD 500m以内 | 高LOD 1km以内 | LOD3 1km以内 | 最近傍高LOD |
|---|---:|---:|---:|---:|
| 梅田 | 240 | 1,225 | 0 | 67m |
| 新大阪 | 812 | 1,339 | 0 | 70m |
| 十三 | 1,399 | 2,052 | 0 | 5m |
| 本町 | 913 | 2,345 | 5 | 26m |
| 難波 | 634 | 1,715 | 0 | 164m |
| 天王寺 | 0 | 0 | 0 | 2,360m |
| 中之島 | 109 | 1,172 | 3 | 28m |
| 住吉 | 0 | 0 | 0 | 6,197m |

## 区属性から確認できた主な高LOD

- 中央区: LOD2 4,200 / LOD3 4
- 淀川区: LOD2 2,305
- 北区: LOD2 1,447 / LOD3 10
- 東淀川区: LOD2 339
- 西区: LOD2 233
- 此花区: LOD2 125
- 城東区: LOD2 109
- 都島区: LOD2 44
- 東成区: LOD2 38
- 福島区: LOD2 14
- 浪速区: LOD2 4

ただしCityGMLソース内で区名属性が直接取れなかった建物が115,178棟あり、その中にもLOD2 1,840棟 / LOD3 1棟が含まれる。よってこの区別集計は最終的な24区coverageではない。35Lの公式区・町丁目境界と位置照合すれば再分類可能。

## 技術方式

`tools/audit/mission35p-remote-lod-audit.js` を追加。

1. G空間情報センターCKAN APIから最新の大阪市PLATEAU CityGMLを自動検出
2. HTTP RangeでZIP中央ディレクトリだけを取得
3. ZIP内のbuilding GMLだけを抽出対象にする
4. テクスチャ・道路・その他レイヤーは取得しない
5. 各building GMLをRange取得し、建物単位でMission 34Dの`judgeBuilding()`を適用
6. LOD2/LOD3の存在と完全性、代表地点周辺coverageを集計
7. JSON/MarkdownをGitHub Actions artifactへ保存

## GitHub Actions

Run: `36099781001`

- npm ci: PASS
- Mission 35P LOD parser regression: **4/4 PASS**
- latest Osaka PLATEAU remote audit: **PASS**
- artifact upload: **PASS**

Artifact: `mission35p-lod-audit`（JSON + SUMMARY.md）

## 費用条件

今回利用したもの:

- PLATEAU公式公開データ: 無償
- GitHub Actions: リポジトリ上の監査実行
- 外注: なし
- 有料測量: なし
- 有料LOD生成: なし

50万円以上の案は採用していない。

## Live Cityへの意味

大阪市24区を全部LOD2へ置換するだけの公式coverageはない。しかし、梅田・新大阪・十三・本町・難波・中之島周辺では公式LOD2を実用的な密度で利用できる。

したがって次段階は、全域置換ではなく、

`公式LOD2/3が存在する建物 → 高LOD`  
`存在しない建物 → 現行LOD1`  

という混在方式を採るのが現実的。

## 次の推奨作業

### Mission 35Q候補｜公式LOD2の試験導入

まず1地区（梅田を推奨）で、公式LOD2をLive City座標へ変換し、同一建物のLOD1を抑制してLOD2へ差し替える。

確認するもの:

- `znorth-neg-v1`位置一致
- canonical ID / 空間照合
- LOD1との二重表示なし
- テクスチャ利用可否
- draw call / FPS / memory
- 建物クリック・施設名sidecarとの互換性
- production / protected未変更

本Missionでは調査のみで、production cutoverは行っていない。
