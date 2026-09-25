#!/usr/bin/env python3
"""Mission 35S — patch the dev HTML with a custom point-cloud high-LOD layer.

This script is intentionally dev-only and idempotent. It refuses to patch if
expected anchors drift, rather than guessing a location in the 5MB runtime.
"""
from pathlib import Path
import sys

DEV = Path('public/osaka_3d_buildings.ward-ux-v1.html')
PROD = Path('public/osaka_3d_buildings.html')
PROT = Path('public/osaka_3d_buildings.fullward-v3.html')
MARK = '// [Mission 35S] CustomLod2Layer'

LAYER = r'''

// [Mission 35S] CustomLod2Layer — 実測点群 + 実在 building footprint から作った Live City 独自高 LOD。
// これは公式 PLATEAU LOD2 ではない。公式 LOD3/LOD2・LandmarkHD が存在する場合は必ずそちらを優先する。
const CustomLod2Layer = (function () {
  const URL_ = 'map-data/osaka-city/experimental/mission35s/custom-lod2-267613423.json';
  const MAX_CAMERA_R = 2500;
  const MATCH_MAX_SHIFT_M = 20;
  let group = null, mesh = null, loaded = false, loading = null, enabled = true, data = null;
  let canonicalId = null, visible = false, suppressActive = false, lastSuppress = false;
  let mats = null;
  const stats = { loaded: false, matched: false, matchDistanceM: null, areaRatio: null, triangles: 0, error: null, visible: false };

  function ensureGroup() {
    if (group) return group;
    group = new THREE.Group();
    group.name = 'CR_customLod2_35S';
    group.visible = false;
    (typeof canonicalRoot !== 'undefined' ? canonicalRoot : scene).add(group);
    if (typeof tagRuntimeOwnerRecursive === 'function' && typeof RUNTIME_OWNER !== 'undefined') {
      try { tagRuntimeOwnerRecursive(group, RUNTIME_OWNER.CANONICAL); } catch (e) { /* noop */ }
    }
    return group;
  }
  function ringArea(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(a) / 2;
  }
  function pointInRing(x, z, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi)) inside = !inside;
    }
    return inside;
  }
  function fpRing(fp) { return fp && (fp.ring || fp.fp || (fp.coordinates && fp.coordinates[0])) || null; }
  function fpCentroid(fp, ring) {
    if (fp && Number.isFinite(fp.cx) && Number.isFinite(fp.cz)) return [fp.cx, fp.cz];
    if (fp && Array.isArray(fp.centroid) && fp.centroid.length >= 2) return [fp.centroid[0], fp.centroid[1]];
    if (!ring || !ring.length) return null;
    let sx = 0, sz = 0; for (const p of ring) { sx += p[0]; sz += p[1]; }
    return [sx / ring.length, sz / ring.length];
  }
  function candidateId(fp) { return fp && (fp.canonicalId || fp.id) || null; }
  function officialOwns(id) {
    try { return !!(id && window.__BUILDING_LOD_LAYER__ && window.__BUILDING_LOD_LAYER__.isSuppressedBuilding(id)); }
    catch (e) { return false; }
  }
  function landmarkOwns(id) {
    try { return !!(id && window.__LANDMARK_HD_LAYER__ && window.__LANDMARK_HD_LAYER__.isSuppressedBuilding(id)); }
    catch (e) { return false; }
  }
  function sourceTileWanted() {
    if (!data || !data.match || !Array.isArray(data.match.sourceCentroid)) return false;
    try {
      if (typeof CanonicalRuntime === 'undefined' || !CanonicalRuntime.buildingTileKeys) return true;
      const [x, z] = data.match.sourceCentroid;
      return CanonicalRuntime.buildingTileKeys().has(Math.floor(x / 500) + '_' + Math.floor(z / 500));
    } catch (e) { return true; }
  }
  function invalidateBuildings() {
    try { if (typeof CanonicalRuntime !== 'undefined' && CanonicalRuntime.invalidateBuildingTiles) CanonicalRuntime.invalidateBuildingTiles(); }
    catch (e) { /* noop */ }
  }
  function tryMatch() {
    if (canonicalId || !data || typeof CanonicalRuntime === 'undefined' || !CanonicalRuntime.visibleBuildingFootprints) return !!canonicalId;
    const srcC = data.match && data.match.sourceCentroid;
    const srcRing = data.match && data.match.sourceRing;
    const srcArea = +(data.match && data.match.sourceFootprintAreaM2) || ringArea(srcRing);
    if (!srcC || !srcRing || !srcArea) return false;
    let fps = [];
    try { fps = CanonicalRuntime.visibleBuildingFootprints() || []; } catch (e) { return false; }
    let best = null;
    for (const fp of fps) {
      const id = candidateId(fp), ring = fpRing(fp); if (!id || !ring) continue;
      const c = fpCentroid(fp, ring); if (!c) continue;
      const d = Math.hypot(c[0] - srcC[0], c[1] - srcC[1]);
      if (d > MATCH_MAX_SHIFT_M) continue;
      const a = ringArea(ring); if (!(a > 0)) continue;
      const ratio = a / srcArea;
      if (ratio < 0.45 || ratio > 2.2) continue;
      const spatialEvidence = pointInRing(srcC[0], srcC[1], ring) || pointInRing(c[0], c[1], srcRing);
      if (!spatialEvidence) continue;
      const score = d + Math.abs(Math.log(ratio)) * 8;
      if (!best || score < best.score) best = { id, d, ratio, score };
    }
    if (!best) return false;
    canonicalId = best.id;
    stats.matched = true; stats.matchDistanceM = +best.d.toFixed(2); stats.areaRatio = +best.ratio.toFixed(3);
    if (mesh) mesh.userData.customLod2 = { canonicalId, mission: '35S', experimental: true };
    invalidateBuildings();
    console.log('[CustomLod2Layer 35S] matched', canonicalId, 'shift=' + stats.matchDistanceM + 'm areaRatio=' + stats.areaRatio);
    return true;
  }
  function materials() {
    if (mats) return mats;
    mats = [
      new THREE.MeshStandardMaterial({ color: 0xd9b980, roughness: 0.72, metalness: 0.02, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: 0xc9d7df, roughness: 0.84, metalness: 0.01, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: 0xaeb9bd, roughness: 0.90, metalness: 0.00, side: THREE.DoubleSide }),
    ];
    return mats;
  }
  function build(doc) {
    const g = ensureGroup();
    if (!doc || doc.coordinateConvention !== 'znorth-neg-v1' || doc.officialPlateauLod2 !== false || doc.status !== 'EXPERIMENTAL_POINT_CLOUD_ROOF') {
      throw new Error('35S custom LOD2 provenance/coordinate contract mismatch');
    }
    const gg = doc.geometry || {}, verts = gg.vertices || [], idx = gg.indices || [];
    if (!verts.length || !idx.length) throw new Error('35S custom LOD2 geometry empty');
    const flat = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) { flat[i*3] = verts[i][0]; flat[i*3+1] = verts[i][1]; flat[i*3+2] = verts[i][2]; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    geom.setIndex(idx);
    geom.clearGroups();
    const mi = { roof: 0, wall: 1, ground: 2 };
    for (const r of (gg.groups || [])) geom.addGroup(r.start || 0, r.count || 0, mi[r.kind] ?? 1);
    geom.computeVertexNormals(); geom.computeBoundingSphere();
    mesh = new THREE.Mesh(geom, materials());
    mesh.name = 'CR_customLod2_35S_mesh';
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.customLod2 = { canonicalId: null, mission: '35S', experimental: true };
    g.add(mesh);
    stats.triangles = Math.floor(idx.length / 3);
  }
  async function load() {
    if (loaded) return true; if (loading) return loading;
    loading = (async () => {
      try {
        const r = await fetch(URL_); if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json(); build(data); loaded = true; stats.loaded = true;
        setTimeout(() => { try { update(); } catch (e) { /* noop */ } }, 0);
        return true;
      } catch (e) {
        stats.error = String(e && e.message || e); console.warn('[CustomLod2Layer 35S] load failed:', stats.error); return false;
      } finally { loading = null; }
    })();
    return loading;
  }
  function update() {
    if (!enabled) {
      visible = false; if (group) group.visible = false; suppressActive = false;
    } else {
      if (!loaded) { load(); return; }
      tryMatch();
      const conflict = canonicalId && (officialOwns(canonicalId) || landmarkOwns(canonicalId));
      const near = typeof cs !== 'undefined' ? cs.r <= MAX_CAMERA_R : true;
      visible = !!(canonicalId && !conflict && near && sourceTileWanted());
      ensureGroup().visible = visible;
      suppressActive = visible;
    }
    stats.visible = visible;
    if (suppressActive !== lastSuppress) { lastSuppress = suppressActive; invalidateBuildings(); }
  }
  function setEnabled(on) { enabled = on !== false; update(); return enabled; }
  function isSuppressedBuilding(id) { return !!(enabled && suppressActive && visible && canonicalId && id === canonicalId); }
  function pick(rayObj) {
    if (!visible || !mesh || !canonicalId) return null;
    const hits = rayObj.intersectObject(mesh, false); if (!hits.length) return null;
    return { canonicalId, lod: 2, experimental: true, source: 'Live City point cloud prototype', distance: hits[0].distance };
  }
  function getDebug() {
    return { enabled, loaded, canonicalId, visible, suppressActive, url: URL_, maxCameraR: MAX_CAMERA_R,
      officialPlateauLod2: false, status: data && data.status, ...stats };
  }
  function focus() {
    if (!data || !data.match || !Array.isArray(data.match.sourceCentroid)) { load().then(focus); return false; }
    if (typeof cs !== 'undefined') {
      cs.tgt.x = data.match.sourceCentroid[0]; cs.tgt.z = data.match.sourceCentroid[1]; cs.tgt.y = 0;
      cs.r = 650; cs.ph = Math.max(0.45, Math.min(1.15, cs.ph || 0.8));
      if (typeof camUpd === 'function') camUpd();
    }
    return true;
  }
  ensureGroup(); load();
  return { load, update, setEnabled, isEnabled: () => enabled, isSuppressedBuilding, pick, getDebug, focus,
    getCanonicalId: () => canonicalId };
})();
if (typeof window !== 'undefined') {
__MISSION35S_FOCUS_BUTTON__
}
'''

# 確認用ボタン。右側のデバッグパネルの裏に隠れないよう **左下** に出す。
#   この文字列は LAYER の中と、既にパッチ済みの dev HTML を貼り直すときの
#   両方で使う（どちらか片方だけ直すと、CI の再生成で元へ戻ってしまう）。
FOCUS_BUTTON = r'''  // [Mission 35S] 表示確認用ボタン。右側のデバッグパネルと重ならないよう左下へ置く。
  function createMission35SFocusButton() {
    if (document.getElementById('mission35s-focus')) return;

    const b = document.createElement('button');
    b.id = 'mission35s-focus';
    b.textContent = '35S 点群LOD2へ';
    b.title = '新高のLive City独自点群LOD2プロトタイプへ移動';

    b.style.cssText =
      'position:fixed;left:20px;bottom:90px;z-index:99999;' +
      'padding:12px 16px;border:2px solid #1677ff;' +
      'background:white;border-radius:8px;' +
      'font:700 14px system-ui;color:#1677ff;box-shadow:0 3px 12px #0004;';

    b.addEventListener('click', () => CustomLod2Layer.focus());
    document.body.appendChild(b);
  }

  // DOMContentLoaded を撃ち終えたあとに読み込まれても必ず作る。
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', createMission35SFocusButton);
  } else {
    createMission35SFocusButton();
  }'''

LAYER = LAYER.replace('__MISSION35S_FOCUS_BUTTON__', FOCUS_BUTTON)


def one_replace(s: str, old: str, new: str, label: str) -> str:
    n = s.count(old)
    if n != 1:
        raise RuntimeError(f'{label}: expected exactly 1 anchor, got {n}')
    return s.replace(old, new, 1)


FOCUS_ANCHOR = "  window.__CUSTOM_LOD2_FOCUS__ = () => CustomLod2Layer.focus();"
FOCUS_END = chr(10) + "}" + chr(10) + chr(10) + "// " + "═" * 3


def refresh_focus_button(s: str) -> str:
    """既にパッチ済みの dev HTML のボタン定義だけを今の FOCUS_BUTTON に貼り替える。

    パッチ全体は MARK で冪等にしているので、ボタンの見た目や生成タイミングを直しても
    「もう入っている」と判断されて反映されない。実際、dev HTML は
    DOMContentLoaded だけの古い形のまま残っていた。CI が再生成しても直りが残るよう、
    ここだけは毎回上書きする。
    """
    i = s.find(FOCUS_ANCHOR)
    if i < 0:
        raise RuntimeError('focus button refresh: anchor missing')
    start = i + len(FOCUS_ANCHOR)
    j = s.find(FOCUS_END, start)
    if j < 0:
        raise RuntimeError('focus button refresh: end marker missing')
    current = s[start:j]
    wanted = chr(10) + FOCUS_BUTTON
    if current == wanted:
        return s
    return s[:start] + wanted + s[j:]


def main():
    s = DEV.read_text(encoding='utf-8')
    if MARK in s:
        updated = refresh_focus_button(s)
        if updated == s:
            print('[35S patch] already patched; focus button current; no-op')
            return
        DEV.write_text(updated, encoding='utf-8', newline=chr(10))
        print('[35S patch] already patched; focus button refreshed (left-bottom + readyState)')
        return

    maxlod_anchor = '// [Mission 34D §34/§35/§36] MAX LOD QA'
    pos = s.find(maxlod_anchor)
    if pos < 0:
        raise RuntimeError('35S layer insertion anchor missing')
    # Insert before the section divider immediately preceding MAX LOD QA.
    divider = '// ══════════════════════════════════════════════════════════════════════════════\n' + maxlod_anchor
    s = one_replace(s, divider, LAYER + '\n// ══════════════════════════════════════════════════════════════════════════════\n' + maxlod_anchor, 'layer insertion')

    decl = "let inferredRoofSuppressed = 0; // [Mission 35A] 推定屋根で描くため LOD1 を出さなかった棟数"
    s = one_replace(s, decl, "let customLod2Suppressed = 0; // [Mission 35S] 点群由来独自高LODで抑制\n      " + decl, 'counter declaration')

    inf_anchor = "// [Mission 35A §23/§24] INFERRED_ROOF（推定屋根）を出している棟も LOD1 の箱を出さない。"
    custom_suppress = r'''// [Mission 35S] 実測点群由来の独自高LODを表示中の1棟だけLOD1を抑制する。
            // 公式PLATEAU高LODは直前のBuildingLODLayer判定が優先される。
            if (window.__CUSTOM_LOD2_LAYER__ && window.__CUSTOM_LOD2_LAYER__.isSuppressedBuilding(f.canonicalId)) {
              customLod2Suppressed++;
              if (outer && f.centroid) landmarkHdFp.set(f.canonicalId, { canonicalId: f.canonicalId, ring: outer, cx: f.centroid[0], cz: f.centroid[1], h, attributes: a, placement: pp ? pp.policy : 'DISPLAY' });
              continue;
            }
            '''
    s = one_replace(s, inf_anchor, custom_suppress + inf_anchor, 'canonical suppression')

    ret = 'highLodSuppressed, inferredRoofSuppressed };'
    s = one_replace(s, ret, 'highLodSuppressed, customLod2Suppressed, inferredRoofSuppressed };', 'buildGroup return counter')

    cam = "if (window.__BUILDING_LOD_LAYER__) window.__BUILDING_LOD_LAYER__.update();"
    s = one_replace(s, cam, cam + "\n    // [Mission 35S] 点群由来独自高LODの表示/抑制もカメラ距離へ追従\n    if (window.__CUSTOM_LOD2_LAYER__) window.__CUSTOM_LOD2_LAYER__.update();", 'camera update')

    pick_anchor = "// [Mission 31G] Canonical Runtime 有効時は canonical 建物へ raycast（旧 bMesh は hidden）。"
    custom_pick = r'''// [Mission 35S] 独自点群LOD2をクリックしても同じcanonical建物のproperty cardを開く。
  if (window.__CUSTOM_LOD2_LAYER__) {
    try {
      const cl = window.__CUSTOM_LOD2_LAYER__.pick(ray);
      if (cl && cl.canonicalId && typeof CanonicalRuntime !== 'undefined' && CanonicalRuntime.buildingDataById) {
        const d = CanonicalRuntime.buildingDataById(cl.canonicalId);
        if (d) return { d: { ...d, displayLod: 2, displayLodSource: 'Live City experimental point cloud' }, distance: cl.distance };
      }
    } catch (err) { /* 独自高LODが拾えなければ通常建物pickへ */ }
  }
  '''
    s = one_replace(s, pick_anchor, custom_pick + pick_anchor, 'pick integration')

    DEV.write_text(s, encoding='utf-8')
    if MARK not in s:
        raise RuntimeError('35S marker missing after patch')
    print('[35S patch] dev patched:', DEV)
    # Guardrails: never mutate prod/protected in this script.
    if not PROD.exists() or not PROT.exists():
        raise RuntimeError('prod/protected guard file missing')

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print('[35S patch] ERROR:', e, file=sys.stderr)
        raise
