# PR#68 へ渡す小さな接続変更（案・未適用・未検証）
PR#68（`claude/issue-67-20261114-1354`、報告 HEAD `364ae1e`）および main の HTML は本 PR で変更していない。
**PR#68 の実ビューア/loader/座標系は本 run では読めていない**（本 checkout は PR#66 ブランチ。PR#68 ブランチは fetch していない）。下記は main の HTML には触れない独立モジュールを前提にした案で、接続時に以下 3 点を PR#68 側で確認すること:
1. 既存建物の world→Three 変換（本モジュールは `Shape(x,-z)` → `rotateX(-90°)` で world(x, h, z) を想定。`geoToThree()` と一致するか）。
2. 既存の建物マテリアル/色/高さ単位（本モジュールは m、色は heightClass 別の識別色）。
3. 可視判定・ピック処理（補完は別 Group・別ピック。既存 raycast 対象に入れない）。

## 追加（HTML 末尾付近、既存コードの削除/改変なし）
```html
<script type="module">
import { createSupplementLayer, createThreeMeshBuilder } from './supplement-layer/supplement-layer.js';
const supGroup = new THREE.Group(); supGroup.name = 'supplement-layer'; scene.add(supGroup);
const params = new URLSearchParams(location.search);
const supplement = createSupplementLayer({
  baseUrl: 'map-data/osaka-city/buildings-supplement/osaka-sumiyoshi/',   // データ未配置なら enable は error になるだけで地図は影響を受けない
  buildMesh: createThreeMeshBuilder(THREE), group: supGroup,
  allowUnpublishable: params.get('supplementPreview') === '1',            // ローカル検証のみ。本番では指定しない
});
window.__supplement = supplement;
// UI トグル（既定OFF）。明示操作でのみ enable。
// toggle.onchange = () => toggle.checked ? supplement.enable() : supplement.disable();
// 既存のカメラ更新ループ内（移動量が閾値を超えたときだけ）: supplement.update(cam.x, cam.z, 600);
</script>
```
- 取得失敗・manifest 不在: `supplement.state === 'error'`、既存地図は無変更。
- 実データを Git/Preview に置かない: `public/map-data/.../buildings-supplement/` は利用条件確認まで未コミット（`publishable:false` は既定で読込拒否）。
