// ══════════════════════════════════════════════════════════════
// tools/verify-parking-console.js
// ══════════════════════════════════════════════════════════════
// ParkingLayer表示検証用のワンショット診断スクリプト。
//
// 使い方:
//   1. ローカルHTTPサーバーで対象ページを開く（file://不可）
//        正規版:  http://localhost:8000/osaka_3d_buildings.html?v=parking11
//        debug版: http://localhost:8000/osaka_3d_buildings.debug.html?v=parking-debug
//   2. DevTools(F12)のConsoleへ、このファイルの内容を丸ごと貼り付けてEnter
//   3. 出力された [Parking検証] のJSONブロックを丸ごとコピーして報告する
//
// このスクリプトはページの状態を一切変更しない（読み取りのみ）。
// HTML本体には何も追加しないため、検証後の後始末は不要。
(() => {
  const out = { url: location.href, when: new Date().toISOString() };

  // ── 2. build識別子 ──
  out.build = (typeof LIVE_CITY_BUILD_ID !== 'undefined') ? LIVE_CITY_BUILD_ID : 'UNDEFINED(旧ファイルの可能性)';

  // ── 3. ParkingLayer実行時統計 ──
  out.parkingLayerDefined = (typeof ParkingLayer !== 'undefined');
  out.stats = (out.parkingLayerDefined && ParkingLayer.getStats) ? ParkingLayer.getStats() : null;

  // ── 5C/6/7. scene登録・Mesh状態・frustum ──
  // ParkingLayerのGroupは非公開のため、舗装色（正規版0xb9b9b4 / debug版0xff00ff、
  // および将来の調整候補色）でscene直下から特定する。
  const PAVE_COLORS = [0x969b99, 0xb9b9b4, 0xff00ff, 0x9da3a2, 0x8f9699];
  const candidates = (typeof scene !== 'undefined')
    ? scene.children.filter(o => o.type === 'Group' && o.children.length >= 1 &&
        o.children[0].isMesh && o.children[0].material && o.children[0].material.color &&
        PAVE_COLORS.includes(o.children[0].material.color.getHex()))
    : [];
  out.sceneDefined = (typeof scene !== 'undefined');
  out.parkingGroupFound = candidates.length;

  if (candidates.length) {
    const g = candidates[0];
    out.groupInScene = scene.children.includes(g);
    out.groupVisible = g.visible;
    out.meshes = g.children.map(m => {
      m.geometry.computeBoundingBox();
      m.geometry.computeBoundingSphere();
      const bs = m.geometry.boundingSphere, bb = m.geometry.boundingBox;
      return {
        meshVisible: m.visible,
        materialVisible: m.material.visible,
        color: '0x' + m.material.color.getHex().toString(16),
        opacity: m.material.opacity,
        transparent: m.material.transparent,
        depthTest: m.material.depthTest,
        depthWrite: m.material.depthWrite,
        renderOrder: m.renderOrder,
        positionCount: m.geometry.attributes.position.count,
        boundingBoxY: [+bb.min.y.toFixed(3), +bb.max.y.toFixed(3)],
        boundingSphere: {
          center: [+bs.center.x.toFixed(1), +bs.center.y.toFixed(2), +bs.center.z.toFixed(1)],
          radius: +bs.radius.toFixed(1)
        }
      };
    });
    // 現在のカメラfrustum内にあるか（実カメラ行列で判定）
    if (typeof camera !== 'undefined' && typeof THREE !== 'undefined') {
      camera.updateMatrixWorld();
      const fr = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      out.inCameraFrustum = g.children.map(m =>
        fr.intersectsSphere(m.geometry.boundingSphere.clone().applyMatrix4(m.matrixWorld)));
      out.cameraPosition = [+camera.position.x.toFixed(0), +camera.position.y.toFixed(0), +camera.position.z.toFixed(0)];
    }
  }

  // ── 参考: 座標範囲（OSM_PARKING vs BLDGS）──
  function bbox(pts) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
    return [+a.toFixed(0), +b.toFixed(0), +c.toFixed(0), +d.toFixed(0)];
  }
  if (typeof OSM_PARKING !== 'undefined') {
    const pts = []; OSM_PARKING.forEach(l => l.polygons.forEach(pg => pg.outer.forEach(p => pts.push(p))));
    out.parkingBBox_XminXmaxZminZmax = bbox(pts);
  }
  if (typeof BLDGS !== 'undefined') {
    const pts = []; BLDGS.forEach(b => b.fp && b.fp.forEach(p => pts.push(p)));
    out.bldgsBBox_XminXmaxZminZmax = bbox(pts);
  }

  // ── 簡易verdict ──
  if (!out.parkingLayerDefined) out.verdict = 'NG: ParkingLayer未定義 → 古いHTMLを開いています（キャッシュ/配信パスを確認）';
  else if (!out.stats) out.verdict = 'NG: stats=null → build()未実行またはdispose済み。Console上部の[ParkingLayer]エラーを確認';
  else if (!out.parkingGroupFound) out.verdict = 'NG: sceneにGroupなし → scene registration OKログと初期化エラーを確認';
  else if (out.meshes && out.meshes.every(m => m.meshVisible && m.materialVisible && m.opacity === 1)) {
    out.verdict = 'OK: Geometry/scene登録/可視性すべて正常。これで画面に見えなければ色・照明の同化（判定B相当）';
  } else out.verdict = '要確認: meshesの各プロパティを参照';

  console.log('[Parking検証] ' + JSON.stringify(out, null, 1));
  return out;
})();
