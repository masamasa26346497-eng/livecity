# Mission 31G-FIX23C 完了報告｜FIX13 Road Ownership Final Fix

ユーザーが実機で`[Residual details]`（FIX23Bで追加）を開き、`unknown`の実体が
`userData.roadKey`を持つ`Mesh`（`MeshPhongMaterial`・`BufferGeometry`・`renderOrder:0`・
owner無し）であることを特定してくれた、極めて価値の高い実証情報をもとに作業した。

**結論を先に正直に書く**: `roadKey`の生成箇所は`RoadLayer`（Legacy Road・OSM由来）の1箇所のみと
確定できた。しかし`RoadLayer.hide()`は`scene.remove(group)`による完全なscene離脱であり、
静的コードレビュー・harness動的実測のいずれでも「なぜ実機で18件も残存するのか」を示す
**具体的なraceやガード漏れを再現することはできなかった**。そのため、mission が要求する
「creation source を確認してownershipを正しく付与する」を、実際に発見できた箇所（RoadLayer側・
CanonicalRuntime自身のFIX13 Road側の両方）へ確実に実施した上で、**§0禁止事項（roadKeyだけで
CANONICAL判定しない）を明確に満たす形でownership継承の正しさを実証**した。実機で0になるかは
次回確認が必要（§20で正直に記載）。

---

## 1. roadKeyのcreation path一覧

repo全体（`public/*.html`, `tools/`）を検索した結果、`.userData.roadKey =`という**実際の代入は
`ward-ux-v1.html`内`RoadLayer.build()`の1箇所のみ**（1906行目付近）:

```js
mesh.userData.roadKey = key; // [フェーズ4] モード切替で色を差し替えるため種別を記録
```

- file: `public/osaka_3d_buildings.ward-ux-v1.html`
- function: `RoadLayer`（IIFE）内の`build()`
- object: `THREE.Mesh`（`buffersByType[key]`＝highway種別ごとに1個、`MeshPhongMaterial`）
- parent group: `RoadLayer`の`group`（**`.name`未設定・`runtimeOwner`未設定だった**）
- scene attach path: `RoadLayer.show()` → `scene.add(group)`（起動時に無条件で1回呼ばれる）
- runtime system: OSM道路（住吉区・東住吉区・平野区の3区分。`OSM_ROADS`埋め込みデータ、
  `OSM_ROAD_TILES = { all: OSM_ROADS }`）を描画する**Legacy Road**システム

（同名`roadKey`という文字列は他の複数html派生ファイル・2つのaudit toolにも出現するが、いずれも
同一のRoadLayer実装のコピーであり、今回のscene runtime residualとは無関係と確認済み）。

## 2. スクショ#1/#2に一致した生成元

`RoadLayer.build()`が生成するhighway種別ごとのmerged mesh（`type=Mesh`・`BufferGeometry`・
`MeshPhongMaterial`・`renderOrder`未設定=0・`userData.roadKey`あり・**parent groupに`.name`も
`runtimeOwner`も無い**）が、報告されたsignatureと完全に一致する。

## 3. unknown 18のうちroadKey件数

**実機の18件全ての内訳は未取得**（前回FIX23Bと同じ制約：実機ブラウザが無い）。ただし
`__LEGACY_RESIDUAL_DETAIL__()`（および新設の`[Residual details]`パネル）へ、今回
`keySignatureCounts`集計（roadKey/usageCategory/wardId/cityBuildingLOD/key無し の件数）を
追加した（§11）ため、**次回実機で開けば即座に「18件中何件がroadKeyか」が判明する**。

## 4. その他signature件数

同上（未取得。ただし集計機構は用意済み）。

## 5. FIX13 parent group名

CanonicalRuntime自身が生成するroad tile group（`buildGroup(layer='roads', ...)`が返す`g`。
`drainBuild()`内で`layerGroup['roads'].add(gb.group)`によって`rtRoot > CR_roads > (tile group)`
という階層に組み込まれる）には、依然として個別の`.name`は付けていない（既存の`layerGroup['roads']`
自体は`'CR_roads'`という名前を既に持つ）。今回は**名前ではなく明示的な`runtimeOwner`タグ**で
identity を確定させる方針を採った（§6参照）。

## 6. FIX13 owner設定箇所

`drainBuild()`内、`layerGroup[job.layer].add(gb.group);`の直後に追加:

```js
gb.group.userData.runtimeOwner = RUNTIME_OWNER.CANONICAL;
gb.group.userData.creationPath = 'CANONICAL_' + job.layer.toUpperCase();
if (job.layer === 'roads') {
  gb.group.userData.runtimeSubsystem = 'FIX13_ROAD';
  gb.group.userData.runtimeSource = 'REFINED_ROAD_SURFACE';
  gb.group.userData.roadRenderMode = roadRenderMode;
}
```

roads/water/parks/buildings/railの**全layer共通**で自己タグを付与した（§9で確認を求められた
5layer全てに対応）。これは`underRt()`（rtRoot配下という構造的な除外）に加えた**二重の保険**であり、
mission §8が要求する優先順位「1. explicit self owner」を明示的に満たす。

## 7. child inheritance結果

`findRuntimeOwner()`/`coexist()`は自身→親→祖父...と根まで辿る設計（FIX23から不変）のため、
tile group自身にのみタグを付ければ、その配下の全mesh（壁・歩道・パッチ・帯等）は自動的に
CANONICALと判定される。動的fixtureテスト（§9/§10で新規追加）で以下を実証:

- `runtimeOwner=CANONICAL`タグ済みgroup配下に`roadKey`付きmeshを置く → **residual 0**（正しく除外）
- タグ無しgroup配下に同じ`roadKey`付きmeshを置く → **residual 1**（正しく検出。roadKeyの有無だけで
  CANONICAL扱いしていない証跡）

## 8. Legacy Roadとの区別方法

`RoadLayer.build()`の末尾（`return group;`直前）で:

```js
tagRuntimeOwnerRecursive(group, RUNTIME_OWNER.LEGACY);
for (const m of group.children) { m.userData.creationPath = 'LEGACY_ROAD_LAYER'; }
group.name = 'RoadLayer';
```

を追加。`roadKey`というuserDataの**値や有無では一切判定せず**、creation path（どの関数が
生成したか）だけを根拠にCANONICAL/LEGACYを分けている（§0/§5禁止事項の遵守）。

## 9. cache restore結果

`RoadLayer`は`OSM_ROADS`という埋め込み静的データを使い、`build()`は起動時に1回だけ呼ばれる
設計（`dispose()`は一切呼ばれておらず、`group`変数はプロセス生存中ずっと同一インスタンスを
保持）。fetchベースのcache/restore機構（BuildingTileLayerのような）は存在しないため、
「cache restoreでownerを失う」という経路自体が構造的に存在しないことを確認した。

## 10. camera NEAR結果

`RoadLayer`のデータは`OSM_ROAD_TILES`という静的embedded objectから同期的に構築され、
camera距離に応じた再生成・tile分割は行っていない（1回のbuild()で全道路を1種別1 Draw Callに
統合済み）。そのため「camera NEARでtile再生成→owner喪失」という経路もRoadLayerには存在しない
と判断した。CanonicalRuntime側のtile system（`buildGroup`/`drainBuild`）は camera距離に応じて
tileを生成するため、今回そちらへ明示的な自己タグ付与を追加したことが直接効く（§6）。

## 11. FIX13 residual

**0**（harness実測。startup直後・Road mode FIX13維持）。

## 12. HYBRID residual

**0**（FIX23Bで修正済みのgN(CANONICAL)タグを再確認。今回のRoad mode cycle testでも0を維持）。

## 13. DIFF residual

**0**（同上。gD(DEBUG)タグ経由でdebugCountへ正しく分離）。

## 14. building select時residual

**未検証**（FIX23Bから変わらず。selectBuilding()の完全再現はharnessでは依然困難）。

## 15. Alignment ON時residual

**0**（既存test再確認・回帰なし）。

## 16. actual Legacy数

harness実測範囲では**0**（RoadLayerの実際のscene leakを再現できなかった）。

## 17. unknown数

harness実測範囲では**0**（startup・ward切替・Alignment・Road mode cycle全て）。実機での
最終確認が必要（§20）。

## 18. validator

`tools/validate/legacy-residual-guard.js`へ5項目追加（計28項目）。

```
RESULT: PASS
roadKeyNotUsedAsBlindCanonicalHeuristic, legacyRoadOwnerTagged, fix13RoadOwnerTagged,
fix13RoadChildInheritance, residualSignatureAggregation: 全てtrue
geometryMutation: 0 / productionModified: false / protectedModified: false
```

## 19. npm test

**1498 tests / 1483 pass / 0 fail / 15 skip**（新規7test中2件が動的fixture test。roadKeyの
ownership inheritance/false-positive-not-heuristic を直接実証する最重要テスト）。

## 20. visual QA status

`VISUAL_QA_PENDING_USER`。**次ミッションへの引き継ぎ（重要）**:

1. 実機ブラウザをreloadし、`Legacy residual`の値を確認する。
   - **0になっていれば**: 今回の防御的タグ付け（RoadLayer=LEGACY・FIX13 Road=CANONICALの
     明示的自己タグ）が、私が特定できなかった何らかのタイミング依存の経路を偶然にも塞いだ
     ことになる。この場合も「なぜ直ったか」を完全には説明できていない点は正直に申し添える。
   - **18のままであれば**: `[Residual details]`を開き、今回追加した`keySignatureCounts`
     （roadKey件数の内訳）を確認していただきたい。18件全てが引き続き`roadKey`であれば、
     `RoadLayer.hide()`の`scene.remove()`が実機では何らかの理由で機能していない、
     という新しい仮説（例えば`toggleOldLayers`の`try_()`が例外を握りつぶしている等）を
     次ミッションで深掘りする必要がある。
2. いずれの場合も、`[Residual details]`パネルの出力をそのまま次のご指示に含めていただければ、
   今回整備した分類基盤（uuid/name/parent/owner/creationPath/keySignatureCounts）を使って
   確実に次の一手を判断できる。

---

## §0 遵守確認

- Canonical Building/Road geometry: 無変更（615,617棟 / 199,658本）
- FIX13/GSI/Hybrid geometry: 無変更（座標・データは一切触っていない。追加したのは
  `userData`へのownership markerのみ）
- residual thresholdは変更していない（`>0`のまま）
- `unknown`を一律ignoreしていない
- `roadKey`があるだけで全部CANONICAL扱いにしていない（§7/§9の動的fixtureで直接実証）
- cleanupで18 Meshを削除するような対応はしていない（タグ付けのみ）
- production/protected HTML: 無変更

---

## 完了条件チェックリスト

- [x] roadKey生成箇所全監査 → 1箇所（RoadLayer.build()）と確定
- [x] 実機signatureのcreation path特定 → RoadLayer.build()の道路種別mergeメッシュと特定
- [x] FIX13 Road root owner CANONICAL → tile group生成箇所(drainBuild)で自己タグ付与
- [x] FIX13 children owner継承 → 動的fixtureで実証
- [x] Legacy RoadはLEGACY → RoadLayer.build()末尾でtagRuntimeOwnerRecursive付与
- [x] Hybrid ownership維持 → 再確認済み（FIX23Bの修正が継続して有効）
- [x] DIFF ownership維持 → 同上
- [x] cache restore owner維持 → RoadLayerにはcache/restore機構自体が無いことを確認
- [x] NEAR tile生成owner維持 → CanonicalRuntimeのtile system全layerへ自己タグ追加
- [ ] unknown 18再分類 → **実機データ未取得のため未達成**
- [ ] Legacy residual 0 → **実機での再確認が必要**
- [ ] unknown residual 0 → 同上
- [x] non-vacuous test維持 → FIX23Bのdummy注入テストは変更なく維持
- [x] validator PASS
- [x] npm test fail 0（1498 tests / 1483 pass / 0 fail / 15 skip）
- [x] geometry不変

**次工程へ自動で進まずSTOPします。実機ブラウザでのreload後の`Legacy residual`値と、
（0でない場合は）`[Residual details]`の`keySignatureCounts`内訳を、可能であれば次のご指示に
含めていただけると、確実に完了へ近づけます。**
