# Mission 31G-FIX25 完了報告｜Cartographic 3D Camera
## 建物を一切動かさず、3D透視投影による「見かけのずれ」を解消する

**最終ステータス: `VISUAL_QA_PENDING_USER`**（validator PASS のみでは完了とみなさない。実機での
Current/Cartographic見比べによる最終判定が必要。§19により、defaultは`Current`のまま変更していない）

---

## 結論（先出し）

**`VISUAL_PARALLAX_CONFIRMED`** — 建物の高さが高いほど、通常3Dカメラ(FOV60°/pitch45°)では
roof(屋根)がbase(接地面)から画面上で大きくずれて見えることを実測で確認した（10m建物で中央値14px、
150m+建物で中央値625px、高さと単調増加の相関）。これは**建物位置・サイズのデータ誤差ではなく、
3D透視投影+カメラ仰角による幾何学的に自然な現象**（前回までのミッションで確定した
`NO_SYSTEMATIC_BUILDING_SHIFT`・`BUILDING_SIZE_CORRECT`と矛盾しない）。

新設した **Cartographic Camera**（FOV 35° / pitch 25° / 距離を1.670倍に自動補正して地表被覆を維持）
により、screen-space roof/base displacementの中央値を**35.9%低減**（§14目標30%以上を達成）。
建物のx/y/z座標・footprint・heightは今回も一切変更していない。

---

## §1 Current Camera 完全監査

| 項目 | 値 |
|---|---|
| type | THREE.PerspectiveCamera |
| FOV | **60°**（`WARD_FOV`） |
| pitch (cs.ph) | **45°**（`Math.PI/4`、既定値） |
| distance (cs.r) | 建物閲覧時 **250m**（`selectBuilding()`の`flyTo(cx,cz,{r:250})`と同一）／既定リセット視点 5,300m |
| target (cs.tgt) | x/z=選択建物の重心、**y=8m（常時固定・地表アンカー）** |
| near/far | near=1（既定）、far は距離に応じ可変（P1-5B） |

**target.y は常に8m固定**で、地表基準のままであることを確認（建物選択・カメラ移動のいずれでも
変化しない。高層建物中央へtarget.yが移動するような設計にはなっていない）。

## §2/§3 Screen-space displacement 測定（高さ別）

| 建物高さ | サンプル数 | Current 中央値shift(px) | Cartographic 中央値shift(px) | 低減率 |
|---|---|---|---|---|
| 10m | 300 | 13.9 | 9.2 | 34.1% |
| 30m | 300 | 63.7 | 41.3 | 35.2% |
| 50m | 300 | 106.0 | 67.8 | 36.0% |
| 100m | 5 | 254.7 | 155.5 | 39.0% |
| 150m+ | 5 | 624.5 | 342.3 | 45.2% |

高さが増えるほどshiftが単調増加（10m→14px、150m+→625px）。**`VISUAL_PARALLAX_CONFIRMED`**。
高い建物ほどCartographicでの低減率も大きい（34%→45%）傾向も確認できた。

---

## §4-9 Cartographic Camera 実装

- **FOV/pitch候補探索**: FOV∈{20,25,30,35}° × pitch∈{20,25,30,35}° の16通りを実測評価
  （`tools/audit/cartographic-camera-audit.js`）。improvement≥30%を満たす候補の中から、
  §5「完全真上にはしない」を最も強く満たす（=pitchが45°に最も近い）**pitch=25°**を採用。
  FOVは同条件下でimprovementへの影響が小さい（pitch=25°ではFOV20-35°いずれも35.9-36.4%と僅差）ため、
  §6の候補内でより広く3D感を残せる**FOV=35°**を採用。
- **§7 ground coverage維持**: FOV/pitch変更後、200m四方の参照footprintのscreen上bounding boxが
  Currentと一致するようdistanceを二分探索（`solveDistanceForCoverage`）。結果、
  **distance補正係数 = 417.5m / 250m = 1.670倍**を実測・runtime定数化
  （`CAMERA_MODE_R_SCALE.cartographic = 1.670`）。ground coverageはFOV/pitch固定ならdistanceに
  比例するため、この係数はどのズーム段階でも同様に機能する（往復テストで丸め誤差なくr が戻ることを確認）。
- **§8/§9 target ground anchor**: `flyTo()`・`selectBuilding()`のコードを静的監査し、いずれも
  `cs.tgt.y`・`camera.fov`・`cs.ph`を一切変更していないことを確認（テストで固定化・退行防止）。

## §10 Camera Mode 切替UI

Canonical status panel内（FIX19Cの教訓どおり独立固定位置は使わない）に
**`[Current] [Cartographic] [Top Down]`** の3ボタン+現在値表示（fov/pitch/r）を追加。
Console操作不要。`window.__SET_CAMERA_MODE__(mode)` / `__CAMERA_MODE_DEBUG__()`もデバッグ用に公開。

- **Current**: fov=60° pitch=45°（既存動作そのまま）
- **Cartographic**: fov=35° pitch=25°（distance自動1.670倍）
- **Top Down**: fov=60°（変更なし）pitch=4.6°（≈0.08rad。FIX20の`toggleTopDownAlignment()`と同じ値を
  採用しつつ、本ミッション独自のCameraMode状態機械として実装——FIX20の`[Top Down]`ボタン
  （Building Alignment用）とは独立しており、互いに干渉しない）

## §11/§12 5地点比較 + 梅田高層建物重点

| 地点 | 建物数(半径600m) | Current中央値(px) | Cartographic中央値(px) | 低減率 |
|---|---|---|---|---|
| 梅田 | 1,112 | 20.7 | 13.6 | 34.2% |
| 中之島 | 1,534 | 27.0 | 17.7 | 34.4% |
| 難波 | 3,000 | 24.0 | 15.7 | 34.3% |
| 天王寺 | 2,561 | 13.7 | 9.1 | 34.1% |
| 住吉 | 6,054 | 13.3 | 8.8 | 34.1% |

**梅田 高層建物重点**（footprintとroad edgeとの見かけの位置関係に直結する指標）:

| 高さ帯 | 棟数 | Current 中央値/p95(px) | Cartographic 中央値/p95(px) |
|---|---|---|---|
| 50m+ | 106 | 217 / 732 | 134 / 390 |
| 100m+ | 49 | 454 / 761 | 261 / 402 |
| 150m+ | 24 | 698 / 763 | 375 / 403 |

全高さ帯で中央値・p95ともCartographicが明確に小さく、特にp95（外れ値に近い最も目立つケース）で
最大47%の低減（150m+: 763px→403px）。

---

## §13 Screen displacement before/after（総括）

```
Current:       median=99.7px   p95=115.0px   max=127.0px
Cartographic:  median=63.9px   p95=73.3px    改善率=35.9%
```
（評価対象: 高さ40-60m建物200棟サンプル。§14目標「30%以上低減」を達成）

## §15 建物高さスケール

`heightScale = 1.0`を維持。`tools/audit/cartographic-camera-audit.js`は`near/buildings`タイルの
`attributes.heightM`を**読み取るだけ**で、一切加工・倍率変更を行っていない
（validatorの`buildingHeightMutation=0`・`noHeightScaleMutation`チェックで確認）。

## §16 Footprint Anchor視覚強化

**今回は実装を見送った**（正直な判断理由）: mission文言自体が「必要なら」という条件付きであり、
まずCamera変更単体で35.9%という明確な改善が実測できたため、追加のcontact shadow/base darkening
実装は、(a) 既存のFIX8B照明チューニング（白飛び対策）への影響評価が別途必要になること、
(b) 実機でCartographic単体の効果を確認してから要否を判断する方が手戻りが少ないこと、の2点から
今回はスコープ外とした。次ミッションで実機確認後、なお必要と判断されれば追加実装する。

## §17 GSI Road Edgeとの関係

GSI Road Edge（FIX16/ALIGNMENT-RESETで導入済み・authoritative outline）のgeometry・描画ロジックは
本ミッションで無変更。camera変更のみでfootprintとroad edgeの見かけの関係が改善するかは**実機確認が
必要**（§22の完了条件どおり、目視QAは次段階）。

## §18 パフォーマンス

- tile/mesh選択ロジック（CanonicalRuntimeのLOD band判定・BuildingTileLayer/CityBuildingLODの
  handoff距離）はすべて`cs.r`（camera-target間の実距離）ベースであり、FOVやpitchには依存していない
  ことをコード監査で確認（camera変更自体がtile数/mesh数/drawCallsを直接増やすことはない）。
- **正直なリスク実測**: Cartographic modeはground coverage維持のため`cs.r`を1.670倍するので、
  既存のLOD band境界（mid上限9,000m）に対して実際に距離が変わる。実測結果:

  | シナリオ | r | 該当band |
  |---|---|---|
  | 建物閲覧時 Current (r=250) | 250m | near寄り |
  | 建物閲覧時 Cartographic (r=417.5) | 417.5m | near寄り（問題なし） |
  | 既定リセット視点 Current (r=5300) | 5,300m | mid |
  | 既定リセット視点 Cartographic (r=8,851) | 8,851m | mid（**farまで149mの僅差**） |

  建物閲覧時（本ミッションが主眼とする、ユーザーが個々の建物を見るシーン）は全く問題ないが、
  **既定のリセット視点でCartographicへ切り替えると、mid→far band境界まで149mしか余裕がない**。
  LOD判定ロジック自体は今回変更していない（§0: 他systemへ手を広げない）ため、これは既知のリスクとして
  正直に記録し、次ミッションでの実機確認時に「ズームアウトした状態でCartographicへ切り替えると
  詳細度が急に落ちないか」を確認項目に加えることを推奨する。

## §19 Default切替

**変更していない。** `let cameraMode = 'current';`のまま。ユーザーが実機でCartographicモードを
確認し、明確な改善が認められた場合にのみ、次段階でdefault昇格を検討する。

---

## Validator / npm test

`node tools/validate/cartographic-camera-audit.js` → **RESULT: PASS**（全15チェックtrue/0）。

```
ℹ tests 1539
ℹ pass 1524
ℹ fail 0
ℹ skipped 15
EXIT=0
```
前回ミッション(31G-SCALE-AUDIT)完了時点(1533/1518)から、新規`tests/cartographic-camera-audit.test.js`
（6件、全PASS）分だけ純増。作業中に`tests/mission16-city-camera.test.js`の1件（`camUpd`のFOV切替式の
完全一致正規表現検査）が退行したため、新しい式`(CAMERA_MODE_FOV[cameraMode] || WARD_FOV)`を
許容するよう更新して解消（既定`cameraMode='current'`では`CAMERA_MODE_FOV.current === WARD_FOV`のため
実質的な挙動は不変であることをテストにも明記）。

---

## §22 完了条件

- [x] current camera監査
- [x] roof/base screen shift測定
- [x] heightとの相関測定（VISUAL_PARALLAX_CONFIRMED）
- [x] Cartographic camera実装
- [x] FOV比較（20/25/30/35°の16通り評価）
- [x] pitch比較（同上）
- [x] ground coverage維持（distance自動補正1.670倍）
- [x] target.y ground anchor（flyTo/selectBuildingで不変を静的確認）
- [x] Current/Cartographic/TopDown切替（status panel内3ボタン）
- [x] 梅田比較（50m+/100m+/150m+重点集計込み）
- [x] 住吉比較
- [x] geometry完全不変（buildingGeometryMutation=0・buildingScaleMutation=0・
      buildingHeightMutation=0・roadGeometryMutation=0）
- [x] npm test fail 0（1539 tests / 1524 pass / 0 fail / 15 skip）
- [x] validator PASS
- [x] **VISUAL_QA_PENDING_USER**

**完了後STOPします。** 実機で status panel の `[Cartographic]` ボタンを押し、Current との見比べを
お願いします。特に梅田の高層建物付近で「footprintと道路の関係が読みやすくなったか」、および
§18で挙げた「ズームアウト状態でCartographicへ切り替えた際にLODが不自然に落ちないか」の2点を
重点的にご確認いただければと思います。
