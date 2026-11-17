// public/supplement-layer/supplement-cesium-adapter.js  [Issue #65 / 第7段階]
// 補完建物レイヤーの Cesium アダプタ（PR#68 の実ビューアは Cesium。Three.js は使わない）。
//  * 既存の createSupplementLayer（遅延取得/abort/重複抑制）を作り直さず、buildMesh と group だけ Cesium 用に差し替える。
//  * 既定OFF。connectSupplement は ?supplement=1 のときだけ呼ぶ想定で、enable() するまで通信しない。
//  * 未確認データの公開許可（allowUnpublishable）は URL パラメータ等からは変更できない（引数に露出しない）。
//  * 取得失敗/manifest 不在でも例外を外へ出さず、既存の地図に触れない。
import { createSupplementLayer, COLORS } from './supplement-layer.js';
import { makeProjection } from './projection.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/** Cesium 用 buildMesh。1 タイル = 1 Primitive。内周=PolygonHierarchy の holes、MultiPolygon=複数 GeometryInstance。 */
export function createCesiumMeshBuilder({ Cesium, toCart, alpha = 0.9 }) {
  return (prepared, { tx, tz }) => {
    const instances = [], pickMap = new Map();
    for (const b of prepared.buildings) {
      const color = Cesium.Color.fromCssColorString(hex(COLORS[b.heightClass] ?? COLORS.unknown)).withAlpha(alpha);
      const id = { layer: 'supplement', featureId: b.id, heightClass: b.heightClass, heightSource: b.heightSource, tile: `${tx},${tz}` };
      pickMap.set(id, b);
      for (const poly of b.polys) {
        const holes = poly.slice(1).map((r) => new Cesium.PolygonHierarchy(r.map((p) => toCart(p[0], p[1], 0))));
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(poly[0].map((p) => toCart(p[0], p[1], 0)), holes),
            height: b.z0, extrudedHeight: b.z0 + b.height, perPositionHeight: false,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
          id,
        }));
      }
    }
    const prim = new Cesium.Primitive({
      geometryInstances: instances, releaseGeometryInstances: true, asynchronous: false,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: true }),
    });
    return { object: prim, pickMap, dispose() { /* destroy は group.remove（scene.primitives.remove）が行う */ } };
  };
}

/** scene.primitives を createSupplementLayer の group 契約（add/remove）に合わせ、変更ごとに requestRender する。 */
export function createCesiumGroup({ scene, requestRender }) {
  const owned = new Set();
  return {
    add(p) { scene.primitives.add(p); owned.add(p); requestRender(); },
    remove(p) { if (owned.delete(p)) { try { scene.primitives.remove(p); } catch { /* 破棄済み */ } } requestRender(); },
    get size() { return owned.size; },
  };
}

/**
 * 実ビューア（PR#68 の IIFE 内）から呼ぶ。戻り値の layer.enable() を明示操作で呼ぶまで通信しない。
 * @param {object} o  { Cesium, viewer, PROJ?, baseUrl, fetchImpl?, debounceMs?, radiusOf? }
 */
export function connectSupplement({ Cesium, viewer, PROJ, baseUrl, fetchImpl, debounceMs = 200, radiusOf, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  const P = makeProjection(PROJ);
  const toCart = (x, z, h) => Cesium.Cartesian3.fromDegrees(P.toLon(x), P.toLat(z), h || 0);
  const scene = viewer.scene;
  const requestRender = () => { try { scene.requestRender && scene.requestRender(); } catch { /* ignore */ } };
  const group = createCesiumGroup({ scene, requestRender });
  const layer = createSupplementLayer({
    baseUrl, fetchImpl, group, buildMesh: createCesiumMeshBuilder({ Cesium, toCart }),
    allowUnpublishable: false,                       // 固定。外部入力で緩めない
    onStatus: requestRender,
  });
  const radius = radiusOf || ((h) => Math.min(1500, Math.max(300, h * 1.5)));
  let timer = null, listening = false;
  function syncView() {
    if (layer.state !== 'ready') return;
    const c = viewer.camera.positionCartographic;
    const l = P.toLocal(Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude));
    layer.update(l.x, l.z, radius(c.height));
    // タイル取得完了後の表示更新は group.add 内で requestRender される
  }
  const onMoveEnd = () => { clearTimeoutImpl(timer); timer = setTimeoutImpl(syncView, debounceMs); };
  async function enable() {
    const s = await layer.enable();
    if (s === 'ready' && !listening) { viewer.camera.moveEnd.addEventListener(onMoveEnd); listening = true; }
    syncView(); requestRender(); return s;
  }
  function disable() {
    clearTimeoutImpl(timer);
    if (listening) { viewer.camera.moveEnd.removeEventListener(onMoveEnd); listening = false; }
    layer.disable(); requestRender();
  }
  /** 拾った Cesium の picked.id から補完建物のレコードを返す（既存のピック処理とは混ぜない）。 */
  function pickRecord(picked) {
    const id = picked && picked.id;
    return id && id.layer === 'supplement' ? layer.pick(id) : null;
  }
  return { layer, group, enable, disable, syncView, pickRecord, toCart, projection: P,
    dispose() { disable(); } };
}
