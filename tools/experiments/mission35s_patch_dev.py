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
  // [Mission 35T] 照合は **IoU（共通部分 / 和集合）** を主判定にする。
  //   35S は「重心が近い + 面積比が範囲内 + 内包点が 1 つ」で採用していたが、
  //   これでは隣の棟や、大きな建物の一部を掴んでも通ってしまう。
  //   しきい値を満たさないときは、現行の canonicalId であっても採用しない（nearest fallback は持たない）。
  const CANDIDATE_RADIUS_M = 100;
  const MATCH_RULES = {
    HIGH: { iou: 0.75, centroidM: 10, areaRatio: [0.80, 1.25] },
    MEDIUM: { iou: 0.60, centroidM: 15, areaRatio: [0.70, 1.40] },
    AMBIGUOUS: { iouGap: 0.10, centroidGapM: 3 },
  };
  // [Mission 35S QA] 試作の 1 棟だけ、どれか一目で分かる色にする。周りの建物の色は変えない。
  const QA_COLOR = { roof: 0x2f9bff, wall: 0x10399c, ground: 0x8b949c };
  // 対象棟が画面中央に大きく入る距離（650m では遠すぎて判別できなかった）
  const FOCUS_R = 150;
  const LABEL_TEXT = '35S CUSTOM LOD2';
  let group = null, mesh = null, label = null, loaded = false, loading = null, enabled = true, data = null;
  let canonicalId = null, visible = false, suppressActive = false, lastSuppress = false;
  let mats = null;
  const stats = { loaded: false, matched: false, matchDistanceM: null, areaRatio: null, triangles: 0,
    error: null, visible: false, lod1SuppressedCount: 0,
    // [Mission 35T §8]
    matchConfidence: 'UNMATCHED', bestCandidate: null, secondCandidate: null,
    iou: null, sourceCoveredRatio: null, candidateCoveredRatio: null,
    centroidDistanceM: null, heightDeltaM: null, candidateCount: 0,
    ambiguousReason: null, lod1SuppressionAllowed: false, matchReason: null };

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
  function ringBboxOf(ring) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1]; }
    return { minX, maxX, minZ, maxZ };
  }
  /**
   * [Mission 35T] 共通部分 / 和集合を格子サンプルで測る。
   *   厳密なポリゴンクリッピングは自己交差・穴で壊れやすいので、両者の bbox を覆う格子で数える。
   */
  function overlapMetrics(ringA, ringB) {
    const ba = ringBboxOf(ringA), bb = ringBboxOf(ringB);
    const zero = { iou: 0, aCovered: 0, bCovered: 0 };
    const minX = Math.min(ba.minX, bb.minX), maxX = Math.max(ba.maxX, bb.maxX);
    const minZ = Math.min(ba.minZ, bb.minZ), maxZ = Math.max(ba.maxZ, bb.maxZ);
    const w = maxX - minX, h = maxZ - minZ;
    if (!(w > 0) || !(h > 0)) return zero;
    const small = Math.max(1, Math.min(ba.maxX - ba.minX, ba.maxZ - ba.minZ, bb.maxX - bb.minX, bb.maxZ - bb.minZ));
    let cell = Math.max(0.5, small / 12);
    let nx = Math.ceil(w / cell), nz = Math.ceil(h / cell);
    while (nx * nz > 40000) { cell *= 1.5; nx = Math.ceil(w / cell); nz = Math.ceil(h / cell); }
    let inA = 0, inB = 0, both = 0;
    for (let i = 0; i < nx; i++) {
      const x = minX + cell * (i + 0.5);
      for (let j = 0; j < nz; j++) {
        const z = minZ + cell * (j + 0.5);
        const a = pointInRing(x, z, ringA), b = pointInRing(x, z, ringB);
        if (a) inA++;
        if (b) inB++;
        if (a && b) both++;
      }
    }
    const union = inA + inB - both;
    return { iou: union > 0 ? both / union : 0, aCovered: inA > 0 ? both / inA : 0, bCovered: inB > 0 ? both / inB : 0 };
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
  /** 対象棟の 500m タイルキー（invalidateBuildingTiles はこの粒度で受け取る）。 */
  function targetTileKeys() {
    if (!data || !data.match || !Array.isArray(data.match.sourceCentroid)) return [];
    const [x, z] = data.match.sourceCentroid;
    const tx = Math.floor(x / 500), tz = Math.floor(z / 500);
    const keys = [];
    // 建物が隣のタイルにまたがることがあるので、周囲 1 枚ぶんも一緒に落とす
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) keys.push((tx + dx) + '_' + (tz + dz));
    return keys;
  }
  function invalidateBuildings() {
    // invalidateBuildingTiles(tileKeys) は渡されたキーに当たるタイルだけを捨てる。
    //   引数なしで呼ぶと空集合になり 1 枚も落ちず、抑制が画面に反映されない（実機で確認）。
    try {
      if (typeof CanonicalRuntime !== 'undefined' && CanonicalRuntime.invalidateBuildingTiles) {
        CanonicalRuntime.invalidateBuildingTiles(targetTileKeys());
      }
    } catch (e) { /* noop */ }
  }
  /** 候補 1 件の指標。 */
  function evaluateCandidate(srcRing, srcArea, srcC, fp) {
    const id = candidateId(fp), ring = fpRing(fp);
    if (!id || !ring || ring.length < 3) return null;
    const c = fpCentroid(fp, ring);
    if (!c) return null;
    const centroidDistanceM = Math.hypot(c[0] - srcC[0], c[1] - srcC[1]);
    if (centroidDistanceM > CANDIDATE_RADIUS_M) return null;
    const area = ringArea(ring);
    if (!(area > 0)) return null;
    const o = overlapMetrics(srcRing, ring);
    return {
      canonicalId: id,
      centroidDistanceM: +centroidDistanceM.toFixed(2),
      areaRatio: +(area / srcArea).toFixed(3),
      candidateAreaM2: +area.toFixed(1),
      iou: +o.iou.toFixed(4),
      sourceCoveredRatio: +o.aCovered.toFixed(4),
      candidateCoveredRatio: +o.bCovered.toFixed(4),
    };
  }
  const inRange = (v, r) => v >= r[0] && v <= r[1];
  /**
   * [Mission 35T §3/§4] best / second から判定を出す。
   *   しきい値を満たさないときに現行 canonicalId へ寄せることはしない。
   */
  function decideMatch(best, second) {
    if (!best) return { matchConfidence: 'UNMATCHED', lod1SuppressionAllowed: false,
      matchReason: '候補が 1 つも無い', ambiguousReason: null };
    const H = MATCH_RULES.HIGH, M = MATCH_RULES.MEDIUM, A = MATCH_RULES.AMBIGUOUS;
    const meetsHigh = best.iou >= H.iou && best.centroidDistanceM <= H.centroidM && inRange(best.areaRatio, H.areaRatio);
    const meetsMedium = best.iou >= M.iou && best.centroidDistanceM <= M.centroidM && inRange(best.areaRatio, M.areaRatio);
    let ambiguousReason = null;
    if (second) {
      const iouGap = best.iou - second.iou;
      const cGap = second.centroidDistanceM - best.centroidDistanceM;
      if (iouGap < A.iouGap && cGap < A.centroidGapM) {
        ambiguousReason = 'best と second が僅差（IoU 差 ' + iouGap.toFixed(3) + ' / 重心差 ' + cGap.toFixed(2) + 'm）';
      } else if (best.sourceCoveredRatio < 0.75 && second.sourceCoveredRatio >= 0.15) {
        ambiguousReason = 'source polygon が複数の建物にまたがっている疑い（best '
          + best.sourceCoveredRatio + ' / second ' + second.sourceCoveredRatio + '）';
      }
    }
    if (ambiguousReason) return { matchConfidence: 'AMBIGUOUS', lod1SuppressionAllowed: false,
      matchReason: 'best を断定できない', ambiguousReason };
    if (meetsHigh) return { matchConfidence: 'HIGH', lod1SuppressionAllowed: true,
      matchReason: 'IoU ' + best.iou + ' / 重心 ' + best.centroidDistanceM + 'm / 面積比 ' + best.areaRatio,
      ambiguousReason: null };
    if (meetsMedium) return { matchConfidence: 'MEDIUM', lod1SuppressionAllowed: false,
      matchReason: 'HIGH に届かない（IoU ' + best.iou + ' / 重心 ' + best.centroidDistanceM + 'm / 面積比 ' + best.areaRatio + '）',
      ambiguousReason: null };
    return { matchConfidence: 'UNMATCHED', lod1SuppressionAllowed: false,
      matchReason: '基準未達（IoU ' + best.iou + ' / 重心 ' + best.centroidDistanceM + 'm / 面積比 ' + best.areaRatio + '）',
      ambiguousReason: null };
  }
  /**
   * [Mission 35T §2/§3] 候補を **全部** 見て、IoU 主体で判定する。
   *   最寄り 1 棟だけを選ぶ実装は使わない。
   */
  function tryMatch() {
    if (!data || typeof CanonicalRuntime === 'undefined' || !CanonicalRuntime.visibleBuildingFootprints) return false;
    if (stats.matchConfidence === 'HIGH' && canonicalId) return true;   // 確定済みなら測り直さない
    const srcC = data.match && data.match.sourceCentroid;
    const srcRing = data.match && data.match.sourceRing;
    const srcArea = +(data.match && data.match.sourceFootprintAreaM2) || ringArea(srcRing);
    if (!srcC || !srcRing || !srcArea) return false;
    let fps = [];
    try { fps = CanonicalRuntime.visibleBuildingFootprints() || []; } catch (e) { return false; }
    if (!fps.length) return false;
    // タイル境界をまたぐ建物は複数回返ってくる。canonicalId で畳まないと
    //   best と second が同じ建物になり「僅差だから AMBIGUOUS」と誤判定する（実機で確認）。
    const byId = new Map();
    for (const fp of fps) {
      const e = evaluateCandidate(srcRing, srcArea, srcC, fp);
      if (!e) continue;
      const prev = byId.get(e.canonicalId);
      if (!prev || e.iou > prev.iou) byId.set(e.canonicalId, e);
    }
    const evaluated = [...byId.values()];
    if (!evaluated.length) return false;
    // 高さは footprint 一覧に入っていないので、建物データから引く（QA の材料）
    for (const e of evaluated) {
      if (e.heightM !== undefined) continue;
      let h = null;
      try {
        const bd = CanonicalRuntime.buildingDataById ? CanonicalRuntime.buildingDataById(e.canonicalId) : null;
        if (bd && typeof bd.h === 'number' && bd.h > 0) h = +bd.h.toFixed(2);
      } catch (err) { /* noop */ }
      e.heightM = h;
    }
    evaluated.sort((a, b) => (b.iou - a.iou) || (a.centroidDistanceM - b.centroidDistanceM));
    const best = evaluated[0], second = evaluated[1] || null;
    const d = decideMatch(best, second);
    stats.candidateCount = evaluated.length;
    stats.bestCandidate = best; stats.secondCandidate = second;
    stats.iou = best.iou;
    stats.sourceCoveredRatio = best.sourceCoveredRatio;
    stats.candidateCoveredRatio = best.candidateCoveredRatio;
    stats.centroidDistanceM = best.centroidDistanceM;
    stats.areaRatio = best.areaRatio;
    stats.matchDistanceM = best.centroidDistanceM;
    stats.matchConfidence = d.matchConfidence;
    stats.lod1SuppressionAllowed = d.lod1SuppressionAllowed;
    stats.matchReason = d.matchReason;
    stats.ambiguousReason = d.ambiguousReason;
    stats.matched = d.matchConfidence === 'HIGH';
    // 表示・QA のために best は覚えるが、LOD1 を消してよいのは HIGH のときだけ（§7）
    const prevId = canonicalId;
    canonicalId = best.canonicalId;
    if (mesh) mesh.userData.customLod2 = { canonicalId, mission: '35S', experimental: true, matchConfidence: d.matchConfidence };
    if (prevId !== canonicalId) invalidateBuildings();
    console.log('[CustomLod2Layer 35T] ' + d.matchConfidence + ' best=' + canonicalId
      + ' IoU=' + best.iou + ' 重心=' + best.centroidDistanceM + 'm 面積比=' + best.areaRatio
      + ' / suppression=' + (d.lod1SuppressionAllowed ? '許可' : '不許可'));
    return true;
  }
  function materials() {
    if (mats) return mats;
    // QA 用の配色。roof = 明るい青 / wall = 濃い青 / ground = グレー。
    //   試作であることを画面で示すための一時的な色で、通常の建物マテリアルとは別物。
    mats = [
      new THREE.MeshStandardMaterial({ color: QA_COLOR.roof, roughness: 0.55, metalness: 0.02, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: QA_COLOR.wall, roughness: 0.70, metalness: 0.02, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: QA_COLOR.ground, roughness: 0.92, metalness: 0.00, side: THREE.DoubleSide }),
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
    buildLabel(g, verts);
  }
  /** [Mission 35S QA] 対象棟の上に「35S CUSTOM LOD2」を常時出す。 */
  function buildLabel(g, verts) {
    let cx = 0, cz = 0, top = -Infinity;
    for (const v of verts) { cx += v[0]; cz += v[2]; if (v[1] > top) top = v[1]; }
    cx /= verts.length; cz /= verts.length;
    if (!Number.isFinite(top)) top = 0;
    const cv = document.createElement('canvas');
    const fontPx = 64;
    const probe = cv.getContext('2d');
    probe.font = '700 ' + fontPx + 'px system-ui, sans-serif';
    cv.width = Math.ceil(probe.measureText(LABEL_TEXT).width) + 48;
    cv.height = fontPx + 40;
    const c2 = cv.getContext('2d');
    c2.font = '700 ' + fontPx + 'px system-ui, sans-serif';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillStyle = 'rgba(16,57,156,0.92)';
    c2.strokeStyle = '#2f9bff'; c2.lineWidth = 6;
    const rr = 14, W = cv.width - 8, H = cv.height - 8;
    c2.beginPath();
    c2.moveTo(4 + rr, 4); c2.lineTo(4 + W - rr, 4); c2.quadraticCurveTo(4 + W, 4, 4 + W, 4 + rr);
    c2.lineTo(4 + W, 4 + H - rr); c2.quadraticCurveTo(4 + W, 4 + H, 4 + W - rr, 4 + H);
    c2.lineTo(4 + rr, 4 + H); c2.quadraticCurveTo(4, 4 + H, 4, 4 + H - rr);
    c2.lineTo(4, 4 + rr); c2.quadraticCurveTo(4, 4, 4 + rr, 4);
    c2.closePath(); c2.fill(); c2.stroke();
    c2.fillStyle = '#ffffff';
    c2.fillText(LABEL_TEXT, cv.width / 2, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    label.name = 'CR_customLod2_35S_label';
    // world 固定サイズ。FOCUS_R(150m) で確実に読める大きさにする。
    const hW = 46, hH = hW * (cv.height / cv.width);
    label.scale.set(hW, hH, 1);
    label.position.set(cx, top + 22, cz);
    label.renderOrder = 10030;
    label.frustumCulled = false;
    g.add(label);
    stats.labelText = LABEL_TEXT;
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
      // 試作メッシュ自体は判定によらず出す（QA で形を比べるため）。
      //   LOD1 を消してよいかは別で、HIGH のときだけ（§7）。
      visible = !!(canonicalId && !conflict && near && sourceTileWanted());
      ensureGroup().visible = visible;
      suppressActive = visible && stats.lod1SuppressionAllowed === true;
    }
    stats.visible = visible;
    if (suppressActive !== lastSuppress) { lastSuppress = suppressActive; invalidateBuildings(); }
  }
  // ── [Mission 35T §6] footprint 比較 overlay ───────────────────────
  //   赤 = OSM source / 青 = best canonical / 黄 = second candidate。
  //   dev の QA 専用。既定は OFF で、通常表示には出さない。
  let overlayGroup = null, overlayOn = false;
  const OVERLAY_Y = 3.0;
  const OVERLAY_COLOR = { source: 0xff2d2d, best: 0x2f6bff, second: 0xffc400 };

  function ringLine(ring, color, y, width) {
    // world 幅の帯で描く（WebGL の linewidth はほとんどの環境で 1 固定）
    const n = ring.length, half = width / 2, pos = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len * half, nz = dx / len * half;
      pos.push(a[0] - nx, y, a[1] - nz, a[0] + nx, y, a[1] + nz, b[0] + nx, y, b[1] + nz);
      pos.push(a[0] - nx, y, a[1] - nz, b[0] + nx, y, b[1] + nz, b[0] - nx, y, b[1] - nz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.computeBoundingSphere();
    const mm = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide });
    const mesh2 = new THREE.Mesh(g, mm);
    mesh2.renderOrder = 10040;
    mesh2.frustumCulled = false;
    return mesh2;
  }
  function centroidMarker(x, z, color, y) {
    const g = new THREE.SphereGeometry(2.2, 12, 8);
    const mk = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, depthTest: false }));
    mk.position.set(x, y + 1, z);
    mk.renderOrder = 10041;
    mk.frustumCulled = false;
    return mk;
  }
  function overlayLabel(text, x, y, z, color) {
    const cv = document.createElement('canvas');
    const probe = cv.getContext('2d');
    probe.font = '700 48px system-ui, sans-serif';
    cv.width = Math.ceil(probe.measureText(text).width) + 36;
    cv.height = 78;
    const c2 = cv.getContext('2d');
    c2.font = '700 48px system-ui, sans-serif';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillStyle = 'rgba(12,18,30,0.90)';
    c2.fillRect(0, 0, cv.width, cv.height);
    c2.strokeStyle = '#' + color.toString(16).padStart(6, '0');
    c2.lineWidth = 6; c2.strokeRect(3, 3, cv.width - 6, cv.height - 6);
    c2.fillStyle = '#' + color.toString(16).padStart(6, '0');
    c2.fillText(text, cv.width / 2, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    const hw = 30, hh = hw * (cv.height / cv.width);
    sp.scale.set(hw, hh, 1);
    sp.position.set(x, y, z);
    sp.renderOrder = 10042; sp.frustumCulled = false;
    return sp;
  }
  function clearOverlay() {
    if (!overlayGroup) return;
    for (const o of [...overlayGroup.children]) {
      overlayGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    }
  }
  function buildOverlay() {
    if (!data || !data.match) return;
    if (!overlayGroup) {
      overlayGroup = new THREE.Group();
      overlayGroup.name = 'CR_customLod2_35T_overlay';
      (typeof canonicalRoot !== 'undefined' ? canonicalRoot : scene).add(overlayGroup);
      if (typeof tagRuntimeOwnerRecursive === 'function' && typeof RUNTIME_OWNER !== 'undefined') {
        try { tagRuntimeOwnerRecursive(overlayGroup, RUNTIME_OWNER.CANONICAL); } catch (e) { /* noop */ }
      }
    }
    clearOverlay();
    const srcRing = data.match.sourceRing, srcC = data.match.sourceCentroid;
    if (srcRing) {
      overlayGroup.add(ringLine(srcRing, OVERLAY_COLOR.source, OVERLAY_Y, 2.4));
      overlayGroup.add(centroidMarker(srcC[0], srcC[1], OVERLAY_COLOR.source, OVERLAY_Y));
      overlayGroup.add(overlayLabel('OSM source', srcC[0], OVERLAY_Y + 34, srcC[1], OVERLAY_COLOR.source));
    }
    let fps = [];
    try { fps = CanonicalRuntime.visibleBuildingFootprints() || []; } catch (e) { fps = []; }
    const byId = new Map();
    for (const fp of fps) { const id = candidateId(fp); if (id) byId.set(id, fp); }
    const draw = (cand, color, text, dy) => {
      if (!cand) return;
      const fp = byId.get(cand.canonicalId); if (!fp) return;
      const ring = fpRing(fp); if (!ring) return;
      const c = fpCentroid(fp, ring);
      overlayGroup.add(ringLine(ring, color, OVERLAY_Y + 0.4, 2.0));
      if (c) {
        overlayGroup.add(centroidMarker(c[0], c[1], color, OVERLAY_Y));
        overlayGroup.add(overlayLabel(text, c[0], OVERLAY_Y + dy, c[1], color));
      }
    };
    draw(stats.bestCandidate, OVERLAY_COLOR.best, 'BEST canonical', 22);
    draw(stats.secondCandidate, OVERLAY_COLOR.second, 'SECOND canonical', 10);
    overlayGroup.visible = overlayOn;
  }
  /** §6 QA overlay の ON/OFF。ON の間は試作メッシュを半透明にして形を比べやすくする。 */
  function setOverlay(on) {
    overlayOn = on !== false;
    if (overlayOn) buildOverlay();
    if (overlayGroup) overlayGroup.visible = overlayOn;
    if (mesh && mesh.material) {
      for (const mt of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
        mt.transparent = overlayOn; mt.opacity = overlayOn ? 0.45 : 1; mt.needsUpdate = true;
      }
    }
    return overlayOn;
  }
  function setEnabled(on) { enabled = on !== false; update(); return enabled; }
  function isSuppressedBuilding(id) {
    // [Mission 35T §7] HIGH のときだけ LOD1 を消す。
    //   MEDIUM / AMBIGUOUS / UNMATCHED では既存 LOD1 を絶対に消さない。
    const hit = !!(enabled && suppressActive && visible && canonicalId && id === canonicalId
      && stats.lod1SuppressionAllowed === true && stats.matchConfidence === 'HIGH');
    // §6 の実証値。canonical runtime は LOD1 の箱を積む直前にここを呼び、
    //   true なら continue する。つまりこの数がそのまま「LOD1 を出さなかった回数」。
    if (hit) stats.lod1SuppressedCount++;
    return hit;
  }
  function pick(rayObj) {
    if (!visible || !mesh || !canonicalId) return null;
    const hits = rayObj.intersectObject(mesh, false); if (!hits.length) return null;
    return { canonicalId, lod: 2, experimental: true, source: 'Live City point cloud prototype', distance: hits[0].distance };
  }
  function getDebug() {
    const m = (data && data.measurement) || {};
    const mm = (data && data.match) || {};
    const src = (data && data.source) || {};
    return { enabled, loaded, canonicalId, visible, suppressActive, url: URL_, maxCameraR: MAX_CAMERA_R,
      officialPlateauLod2: false, status: data && data.status, ...stats,
      // [Mission 35S §5] QA で必要な値をここだけで確認できるようにする
      heightMedianM: (m.heightMedianM != null) ? m.heightMedianM : null,
      heightP90M: (m.heightP90M != null) ? m.heightP90M : null,
      roofType: m.roofType || null,
      sourceFootprintAreaM2: (mm.sourceFootprintAreaM2 != null) ? mm.sourceFootprintAreaM2 : null,
      osmWayId: (src.osmWayId != null) ? src.osmWayId : null,
      // §6 公式側が同じ棟を持っていたら、そちらを優先して自分は出さない
      officialOwnsCanonical: canonicalId ? officialOwns(canonicalId) : false,
      landmarkOwnsCanonical: canonicalId ? landmarkOwns(canonicalId) : false,
      // [Mission 35T §8] 照合の根拠。IoU が主で、重心距離は従。
      heightDeltaM: (stats.bestCandidate && stats.bestCandidate.heightM != null && m.heightMedianM != null)
        ? +(stats.bestCandidate.heightM - m.heightMedianM).toFixed(2) : null,
      matchRules: MATCH_RULES, candidateRadiusM: CANDIDATE_RADIUS_M,
      focusR: FOCUS_R, labelText: LABEL_TEXT,
      labelWorld: label ? { x: +label.position.x.toFixed(2), y: +label.position.y.toFixed(2), z: +label.position.z.toFixed(2) } : null,
      labelVisible: !!(label && label.visible),
      qaColors: { roof: '#' + QA_COLOR.roof.toString(16).padStart(6, '0'),
        wall: '#' + QA_COLOR.wall.toString(16).padStart(6, '0'),
        ground: '#' + QA_COLOR.ground.toString(16).padStart(6, '0') } };
  }
  /** [Mission 35S §4] QA カード用のまとめ。 */
  function getQaSummary() {
    const d = getDebug();
    return {
      mission: '35S',
      type: 'Experimental point-cloud LOD2',
      officialPlateauLod2: false,
      osmWay: d.osmWayId,
      heightMedianM: d.heightMedianM,
      triangles: d.triangles,
      canonicalId: d.canonicalId,
      matchDistanceM: d.matchDistanceM,
      areaRatio: d.areaRatio,
      sourceFootprintAreaM2: d.sourceFootprintAreaM2,
      suppressActive: d.suppressActive,
      // [Mission 35T]
      matchConfidence: d.matchConfidence,
      iou: d.iou,
      sourceCoveredRatio: d.sourceCoveredRatio,
      candidateCoveredRatio: d.candidateCoveredRatio,
      candidateCount: d.candidateCount,
      lod1SuppressionAllowed: d.lod1SuppressionAllowed,
      ambiguousReason: d.ambiguousReason,
      matchReason: d.matchReason,
      secondCandidate: d.secondCandidate,
    };
  }
  function focus() {
    if (!data || !data.match || !Array.isArray(data.match.sourceCentroid)) { load().then(focus); return false; }
    const [fx, fz] = data.match.sourceCentroid;
    // 対象棟のある区へ切り替える。区が違うと建物タイルが読まれず、
    //   canonical との突き合わせが成立しないので試作メッシュが出ない（実機で確認）。
    try {
      if (typeof WardModeManager !== 'undefined' && WardModeManager.detectWardAt) {
        const wid = WardModeManager.detectWardAt(fx, fz);
        if (wid) {
          if (typeof CityModeManager !== 'undefined' && CityModeManager.isActive && CityModeManager.isActive()) {
            CityModeManager.exit(wid);
          }
          const cur = WardModeManager.getCurrentWard ? WardModeManager.getCurrentWard() : null;
          if (!cur || cur.id !== wid) WardModeManager.switchWard(wid);
        }
      }
    } catch (e) { /* 区切替に失敗してもカメラは動かす */ }
    if (typeof cs !== 'undefined') {
      cs.tgt.x = fx; cs.tgt.z = fz; cs.tgt.y = 0;
      // 対象棟が画面中央に大きく入る距離まで寄せる（650m では判別できなかった）
      cs.r = FOCUS_R; cs.ph = Math.max(0.45, Math.min(1.15, cs.ph || 0.8));
      if (typeof camUpd === 'function') camUpd();
    }
    // タイルが届いたところで突き合わせ直す
    for (const ms of [600, 1500, 3000, 6000, 10000]) setTimeout(() => { try { update(); } catch (e) { /* noop */ } }, ms);
    return true;
  }
  ensureGroup(); load();
  return { load, update, setEnabled, isEnabled: () => enabled, isSuppressedBuilding, pick, getDebug, getQaSummary, focus,
    setOverlay, isOverlayOn: () => overlayOn, rebuildOverlay: buildOverlay,
    getCanonicalId: () => canonicalId };
})();
if (typeof window !== 'undefined') {
  window.__CUSTOM_LOD2_LAYER__ = CustomLod2Layer;
  window.__CUSTOM_LOD2_DEBUG__ = () => CustomLod2Layer.getDebug();
  window.__CUSTOM_LOD2_TOGGLE__ = (on) => CustomLod2Layer.setEnabled(on !== false);
  window.__CUSTOM_LOD2_FOCUS__ = () => CustomLod2Layer.focus();
  // [Mission 35T §6] footprint 比較 overlay（赤=OSM source / 青=best / 黄=second）
  window.__CUSTOM_LOD2_OVERLAY__ = (on) => CustomLod2Layer.setOverlay(on !== false);
__MISSION35S_FOCUS_BUTTON__
}
__MISSION35U_LAYER__
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

  // [Mission 35S §4] 試作 LOD2 をクリックしたとき、通常の建物属性カードとは別に
  //   「これは公式 PLATEAU LOD2 ではない」ことと、突き合わせの根拠を出す。
  function showMission35SQaCard() {
    const q = (CustomLod2Layer.getQaSummary && CustomLod2Layer.getQaSummary()) || null;
    if (!q) return;
    let el = document.getElementById('mission35s-qa-card');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mission35s-qa-card';
      el.style.cssText =
        'position:fixed;left:20px;bottom:150px;z-index:99998;max-width:330px;' +
        'padding:12px 14px;border:2px solid #2f9bff;background:rgba(9,20,44,.94);' +
        'border-radius:10px;font:500 12px/1.65 system-ui;color:#e8f2ff;' +
        'box-shadow:0 4px 16px #0006;';
      document.body.appendChild(el);
    }
    const row = (k, v) => '<div style="display:flex;gap:8px"><span style="color:#9fc4ff;min-width:132px">'
      + k + '</span><span style="word-break:break-all">' + v + '</span></div>';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
      + '<b style="color:#2f9bff">35S CUSTOM LOD2（試作）</b>'
      + '<span id="mission35s-qa-close" style="cursor:pointer;color:#9fc4ff;padding:0 4px">×</span></div>'
      + row('Mission', q.mission)
      + row('Type', q.type)
      + row('officialPlateauLod2', String(q.officialPlateauLod2))
      + row('OSM way', q.osmWay == null ? '—' : q.osmWay)
      + row('高さ（中央値）', q.heightMedianM == null ? '—' : q.heightMedianM + ' m')
      + row('三角形数', q.triangles == null ? '—' : q.triangles)
      + row('canonicalId', q.canonicalId || '（未一致）')
      + row('matchDistanceM', q.matchDistanceM == null ? '—' : q.matchDistanceM)
      + row('areaRatio', q.areaRatio == null ? '—' : q.areaRatio)
      + row('LOD1 抑制', q.suppressActive ? 'ON（元 LOD1 は非表示）' : 'OFF');
    el.style.display = 'block';
    const c = document.getElementById('mission35s-qa-close');
    if (c) c.addEventListener('click', () => { el.style.display = 'none'; });
  }
  window.__MISSION35S_QA_CARD__ = showMission35SQaCard;

  // DOMContentLoaded を撃ち終えたあとに読み込まれても必ず作る。
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', createMission35SFocusButton);
  } else {
    createMission35SFocusButton();
  }'''

MARK_35U = '// [Mission 35U] PlanarRoofLayer'

# [Mission 35U] building part の平面屋根レイヤー。35S の RAW と見比べるために足す。
LAYER_35U = r'''
// ══════════════════════════════════════════════════════════════════════════════
// [Mission 35U] PlanarRoofLayer — building part の範囲だけを平面分割で作り直した実験的な屋根。
//   35S の RAW（点群をそのまま三角形化したギザギザ）と見比べるための層。
//   これは公式 PLATEAU LOD2 ではない。canonical 建物全体を置き換えるものでもないので、
//   canonical 全体の LOD1 は **絶対に消さない**（§7）。
// ══════════════════════════════════════════════════════════════════════════════
const PlanarRoofLayer = (function () {
  const URL_ = 'map-data/osaka-city/experimental/mission35u/part-roof-planes-267613423.json';
  const MAX_CAMERA_R = 2500;
  const LABEL_TEXT = '35U PLANAR ROOF';
  // 35S の青（roof 0x2f9bff / wall 0x10399c）と見分けられる色にする。
  const QA_COLOR = { roof: 0x35d17a, wall: 0x1b7a4b };
  // RAW = 35S だけ / PLANAR = 35U だけ / BOTH = 両方
  const MODES = ['RAW', 'PLANAR', 'BOTH'];
  let mode = 'PLANAR';
  let group = null, mesh = null, label = null, data = null;
  let loaded = false, loading = null, enabled = true, visible = false;
  const stats = { loaded: false, error: null, visible: false, triangles: 0, roofTriangles: 0,
    wallTriangles: 0, planeCount: 0, roofType: null, partVerdict: null, mode: mode };

  function ensureGroup() {
    if (group) return group;
    group = new THREE.Group();
    group.name = 'CR_planarRoof_35U';
    group.visible = false;
    (typeof canonicalRoot !== 'undefined' ? canonicalRoot : scene).add(group);
    if (typeof tagRuntimeOwnerRecursive === 'function' && typeof RUNTIME_OWNER !== 'undefined') {
      try { tagRuntimeOwnerRecursive(group, RUNTIME_OWNER.CANONICAL); } catch (e) { /* noop */ }
    }
    return group;
  }
  function materials() {
    return [
      new THREE.MeshStandardMaterial({ color: QA_COLOR.roof, roughness: 0.55, metalness: 0.02, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: QA_COLOR.wall, roughness: 0.72, metalness: 0.02, side: THREE.DoubleSide }),
    ];
  }
  function buildLabel(g, verts) {
    let cx = 0, cz = 0, top = -Infinity;
    for (const v of verts) { cx += v[0]; cz += v[2]; if (v[1] > top) top = v[1]; }
    cx /= verts.length; cz /= verts.length;
    if (!Number.isFinite(top)) top = 0;
    const cv = document.createElement('canvas');
    const probe = cv.getContext('2d');
    const fontPx = 60;
    probe.font = '700 ' + fontPx + 'px system-ui, sans-serif';
    cv.width = Math.ceil(probe.measureText(LABEL_TEXT).width) + 44;
    cv.height = fontPx + 36;
    const c2 = cv.getContext('2d');
    c2.font = '700 ' + fontPx + 'px system-ui, sans-serif';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillStyle = 'rgba(12,64,40,0.92)';
    c2.strokeStyle = '#35d17a'; c2.lineWidth = 6;
    c2.fillRect(4, 4, cv.width - 8, cv.height - 8);
    c2.strokeRect(4, 4, cv.width - 8, cv.height - 8);
    c2.fillStyle = '#ffffff';
    c2.fillText(LABEL_TEXT, cv.width / 2, cv.height / 2 + 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    label.name = 'CR_planarRoof_35U_label';
    const hW = 44, hH = hW * (cv.height / cv.width);
    label.scale.set(hW, hH, 1);
    // 35S のラベルと重ならないよう、少し低い位置に出す
    label.position.set(cx, top + 10, cz);
    label.renderOrder = 10031;
    label.frustumCulled = false;
    g.add(label);
  }
  function build(doc) {
    const g = ensureGroup();
    if (!doc || doc.coordinateConvention !== 'znorth-neg-v1'
      || doc.officialPlateauLod2 !== false || doc.status !== 'EXPERIMENTAL_POINT_CLOUD_PLANAR_ROOF') {
      throw new Error('35U planar roof provenance/coordinate contract mismatch');
    }
    const gg = doc.geometry || {}, verts = gg.vertices || [], idx = gg.indices || [];
    if (!verts.length || !idx.length) throw new Error('35U planar roof geometry empty');
    const flat = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) { flat[i*3] = verts[i][0]; flat[i*3+1] = verts[i][1]; flat[i*3+2] = verts[i][2]; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    geom.setIndex(idx);
    geom.clearGroups();
    const mi = { roof: 0, wall: 1 };
    for (const r of (gg.groups || [])) geom.addGroup(r.start || 0, r.count || 0, mi[r.kind] ?? 1);
    geom.computeVertexNormals(); geom.computeBoundingSphere();
    mesh = new THREE.Mesh(geom, materials());
    mesh.name = 'CR_planarRoof_35U_mesh';
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.planarRoof = { mission: '35U', experimental: true,
      canonicalId: (doc.match && doc.match.canonicalId) || null };
    g.add(mesh);
    buildLabel(g, verts);
    stats.triangles = Math.floor(idx.length / 3);
    stats.roofTriangles = gg.roofTriangles || 0;
    stats.wallTriangles = gg.wallTriangles || 0;
    stats.planeCount = (doc.roof && doc.roof.planeCount) || 0;
    stats.roofType = (doc.roof && doc.roof.type) || null;
    stats.partVerdict = (doc.buildingPart && doc.buildingPart.verdict) || null;
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
        stats.error = String(e && e.message || e);
        console.warn('[PlanarRoofLayer 35U] load failed:', stats.error); return false;
      } finally { loading = null; }
    })();
    return loading;
  }
  function wanted() {
    if (!enabled || !loaded) return false;
    if (mode === 'RAW') return false;              // 35S だけを見るモード
    const near = typeof cs !== 'undefined' ? cs.r <= MAX_CAMERA_R : true;
    return near;
  }
  function update() {
    visible = wanted();
    if (group) group.visible = visible;
    stats.visible = visible;
    stats.mode = mode;
    if (!loaded && enabled) load();
  }
  /** §6 表示モード。RAW=35S / PLANAR=35U / BOTH=両方。 */
  function setMode(next) {
    if (MODES.indexOf(next) < 0) return mode;
    mode = next;
    // 35S 側は RAW / BOTH のときだけ出す
    try {
      if (window.__CUSTOM_LOD2_LAYER__) window.__CUSTOM_LOD2_LAYER__.setEnabled(mode !== 'PLANAR');
    } catch (e) { /* noop */ }
    update();
    return mode;
  }
  function getDebug() {
    const p = (data && data.buildingPart) || {};
    const rf = (data && data.roof) || {};
    const pc = (data && data.pointCloud) || {};
    const ct = (data && data.containment) || {};
    return { enabled, loaded, visible, mode, modes: MODES.slice(), url: URL_,
      officialPlateauLod2: false, status: data && data.status, ...stats,
      partVerdict: p.verdict || null, partChecks: p.checks || null, partFailed: p.failed || null,
      canonicalId: (data && data.match && data.match.canonicalId) || null,
      // §7 building part なので canonical 全体の LOD1 は消さない
      lod1SuppressionAllowed: false,
      roofType: rf.type || null, planeCount: rf.planeCount || 0,
      planes: (rf.planes || []).map((x) => ({ index: x.index, support: x.support, slopeDeg: x.slopeDeg,
        rmsErrorM: x.rmsErrorM, triangles: x.triangles, polygonAreaM2: x.polygonAreaM2 })),
      roofCandidatePoints: pc.roofCandidatePoints || null,
      containment: ct, labelText: LABEL_TEXT,
      qaColors: { roof: '#' + QA_COLOR.roof.toString(16).padStart(6, '0'),
        wall: '#' + QA_COLOR.wall.toString(16).padStart(6, '0') } };
  }
  /** §7 canonical 建物全体の LOD1 は絶対に消さない。 */
  function isSuppressedBuilding() { return false; }
  function focus() {
    if (!data || !data.match || !Array.isArray(data.match.sourceCentroid)) { load().then(focus); return false; }
    try { if (window.__CUSTOM_LOD2_LAYER__) window.__CUSTOM_LOD2_LAYER__.focus(); } catch (e) { /* noop */ }
    return true;
  }
  ensureGroup(); load();
  return { load, update, setMode, getMode: () => mode, setEnabled: (on) => { enabled = on !== false; update(); return enabled; },
    isEnabled: () => enabled, isSuppressedBuilding, getDebug, focus };
})();
if (typeof window !== 'undefined') {
  window.__PLANAR_ROOF_LAYER__ = PlanarRoofLayer;
  window.__PLANAR_ROOF_DEBUG__ = () => PlanarRoofLayer.getDebug();
  window.__PLANAR_ROOF_MODE__ = (m) => PlanarRoofLayer.setMode(m);
}
'''

LAYER = LAYER.replace('__MISSION35S_FOCUS_BUTTON__', FOCUS_BUTTON)
LAYER = LAYER.replace('__MISSION35U_LAYER__', LAYER_35U)


def one_replace(s: str, old: str, new: str, label: str) -> str:
    n = s.count(old)
    if n != 1:
        raise RuntimeError(f'{label}: expected exactly 1 anchor, got {n}')
    return s.replace(old, new, 1)


FOCUS_ANCHOR = "  window.__CUSTOM_LOD2_FOCUS__ = () => CustomLod2Layer.focus();"
FOCUS_END = chr(10) + "}" + chr(10) + chr(10) + "// " + "═" * 3


QA_CARD_HOOK = ("        // [Mission 35S §4] 通常の property card に加えて、試作であることが分かる QA カードも出す。"
                + chr(10) + "        try { if (window.__MISSION35S_QA_CARD__) window.__MISSION35S_QA_CARD__(); } catch (e2) { /* noop */ }")
QA_CARD_ANCHOR = "        const d = CanonicalRuntime.buildingDataById(cl.canonicalId);"


def refresh_pick_hook(s: str) -> str:
    """pick 経路は 35S ブロックの外にあるので、ブロック貼り直しでは直らない。ここだけ別に足す。"""
    if '__MISSION35S_QA_CARD__()' in s:
        return s
    i = s.find(QA_CARD_ANCHOR)
    if i < 0:
        raise RuntimeError('pick hook refresh: anchor missing')
    end = i + len(QA_CARD_ANCHOR)
    return s[:end] + chr(10) + QA_CARD_HOOK + s[end:]


def refresh_layer_block(s: str) -> str:
    """既にパッチ済みの dev HTML の 35S ブロックを、今の LAYER で丸ごと貼り替える。

    パッチ全体は MARK で冪等にしているので、レイヤーの中身（QA 配色・ラベル・focus 距離・
    debug 値）を直しても「もう入っている」と判断されて反映されない。実際、dev HTML は
    DOMContentLoaded だけの古い形のまま残っていた。CI が再生成しても直りが残るよう、
    35S が自分で入れたブロックだけは毎回上書きする。

    差し替えるのは MARK から window ブロックの閉じ括弧までで、
    その外側（canonical runtime 側のフック）は触らない。
    """
    i = s.find(MARK)
    if i < 0:
        raise RuntimeError('layer refresh: MARK missing')
    j = s.find(FOCUS_END, i)
    if j < 0:
        raise RuntimeError('layer refresh: end marker missing')
    end = j + len(chr(10) + '}')
    wanted = LAYER[LAYER.index(MARK):].rstrip(chr(10))
    if s[i:end] == wanted:
        return s
    return s[:i] + wanted + s[end:]


def main():
    s = DEV.read_text(encoding='utf-8')
    if MARK in s:
        updated = refresh_pick_hook(refresh_layer_block(s))
        if updated == s:
            print('[35S patch] already patched; layer block current; no-op')
            return
        DEV.write_text(updated, encoding='utf-8', newline=chr(10))
        print('[35S patch] already patched; layer block refreshed (QA colors + label + focus + debug)')
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
        // [Mission 35S §4] 通常の property card に加えて、試作であることが分かる QA カードも出す。
        try { if (window.__MISSION35S_QA_CARD__) window.__MISSION35S_QA_CARD__(); } catch (e2) { /* noop */ }
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
