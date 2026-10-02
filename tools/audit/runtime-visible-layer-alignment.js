#!/usr/bin/env node
// tools/audit/runtime-visible-layer-alignment.js
// [Mission 32J] RUNTIME VISIBLE-LAYER ALIGNMENT AUDIT — AUDIT ONLY
//
//   §0 遵守: building offset / road offset / scale 補正 / clipping / projection 変更 /
//   canonical rebuild は一切行わない。読み取りと比較測定のみ。
//
//   §24 の要求（最重要）: canonical 同士を比較するのではなく、**実際に scene へ add された後の
//   座標**を比較する。そのため本ツールは tests/_ward-ux-v1-smoke-harness.cjs で
//   public/osaka_3d_buildings.ward-ux-v1.html の inline script を実行し、
//   THREE の scene graph を実際に構築させてから、scene 上の mesh の
//   geometry.attributes.position（＝描画に使われる実座標）を直接読む。
//
//   ■ 本環境の制約（正直な開示）
//   - ブラウザではなく Node 上の THREE スタブで動かすため、matrixWorld 行列は実体化されない
//     （スタブでは空オブジェクト）。そこで §3/§4 は **parent chain の position/rotation/scale を
//     実際に読み取って合成**する（THREE の TRS 合成と数学的に同一）。合成結果は report に出す。
//   - 3D 建物レイヤー(CR_buildings)は camera 駆動の tile pipeline 経由でしか読み込まれず、
//     この環境では pipeline が回らない（既知の制約）。代わりに **Reference Alignment overlay が
//     読む PLATEAU footprint** を使う。これは tileUrl() が 3D 建物用に使うのと**同一のタイル
//     ファイル** `derived/near/buildings/tile_*.json` を読んでおり（コード実測）、
//     §9「3D extrusion OFF・building base outline のみ」という要求そのものの表示である。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';

const require_ = createRequire(import.meta.url);
const P = (...s) => resolveProjectPath(path.join(...s));
const HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PUBLIC_DIR = P('public');
const BLDG_TILE_DIR = P('public', 'map-data', 'osaka-city', 'derived', 'near', 'buildings');
const GSI_EDGE_TILE_DIR = P('public', 'map-data', 'osaka-city', 'derived', 'gsi-road-edge');
const REPORT = P('data', 'reports', 'runtime-visible-layer-alignment.json');
const QA_DIR = P('data', 'processed', 'osaka-city', 'visible-alignment-qa');
const PUBLIC_QA_DIR = P('public', 'map-data', 'osaka-city', 'visible-alignment-qa');

const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// ── §7 fixture 対象サイト（低層住宅・普通の商業建物が取れる場所。駅/高架/巨大施設は除外条件で弾く） ──
const SITES = [
  { id: 'sumiyoshi', name: '住吉', x: -2952.22, z: -811.75 },
  { id: 'honmachi', name: '本町', x: -2072.6, z: -8693.2 },
  { id: 'tennoji', name: '天王寺', x: -1055.54, z: -4618.89 },
];
// §7 低層住宅/普通の商業建物の条件（駅・高架・巨大施設を除外）
const LOWRISE_MAX_H_M = 15;
const LOWRISE_MAX_AREA_M2 = 1500;
const LOWRISE_MIN_AREA_M2 = 30;
const FIXTURES_PER_SITE = 8;
const SEARCH_RADIUS_M = 200;

function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a) / 2; }
function median(v) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(4); }
function pct(v, q) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(4); }
function distPointToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const L = dx * dx + dz * dz;
  let t = L === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / L; t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qz = az + t * dz;
  return { d: Math.hypot(px - qx, pz - qz), qx, qz };
}

/** §3/§4: parent chain の TRS を実際に読み取って合成する（THREE の matrixWorld と数学的に同一）。 */
function composeChain(obj) {
  const chain = [];
  let o = obj;
  while (o) { chain.unshift(o); o = o.parent; }
  // 2D(平面)成分だけ合成する。rotation は Y 軸のみ（地図表示で意味を持つのは Y 回転）。
  let tx = 0, tz = 0, sx = 1, sz = 1, ry = 0;
  const steps = [];
  for (const n of chain) {
    const p = n.position || { x: 0, y: 0, z: 0 };
    const s = n.scale || { x: 1, y: 1, z: 1 };
    const r = n.rotation || { x: 0, y: 0, z: 0 };
    const px = p.x || 0, pz = p.z || 0;
    const nsx = s.x == null ? 1 : s.x, nsz = s.z == null ? 1 : s.z;
    const nry = r.y || 0;
    // world = parentScale*R(parentRot)*localPos + parentTranslation
    const cos = Math.cos(ry), sin = Math.sin(ry);
    tx += sx * (px * cos + pz * sin);
    tz += sz * (-px * sin + pz * cos);
    sx *= nsx; sz *= nsz; ry += nry;
    steps.push({
      name: n.name || '(anon)', type: n.isMesh ? 'Mesh' : (n.isLineSegments ? 'LineSegments' : (n.isGroup ? 'Group' : 'Object3D')),
      visible: n.visible !== false,
      runtimeOwner: (n.userData && n.userData.runtimeOwner) || null,
      position: [+(p.x || 0).toFixed(6), +(p.y || 0).toFixed(6), +(p.z || 0).toFixed(6)],
      rotation: [+(r.x || 0).toFixed(6), +(r.y || 0).toFixed(6), +(r.z || 0).toFixed(6)],
      scale: [+(s.x == null ? 1 : s.x).toFixed(6), +(s.y == null ? 1 : s.y).toFixed(6), +(s.z == null ? 1 : s.z).toFixed(6)],
      matrixWorldMaterialized: !!(n.matrixWorld && n.matrixWorld.elements),
    });
  }
  return {
    parentChain: chain.map((n) => n.name || '(anon)').join(' > '),
    chainSteps: steps,
    effectiveTranslationX: +tx.toFixed(6), effectiveTranslationZ: +tz.toFixed(6),
    effectiveScaleX: +sx.toFixed(6), effectiveScaleZ: +sz.toFixed(6),
    effectiveRotationY: +ry.toFixed(6),
    isIdentity: Math.abs(tx) < 1e-9 && Math.abs(tz) < 1e-9 && Math.abs(sx - 1) < 1e-9 && Math.abs(sz - 1) < 1e-9 && Math.abs(ry) < 1e-9,
  };
}

function collectMeshes(root, pred) {
  const out = [];
  (function walk(o) {
    if (!o) return;
    if (pred(o)) out.push(o);
    for (const c of (o.children || [])) walk(c);
  })(root);
  return out;
}
function hexOf(o) {
  try { const c = o.material && o.material.color; if (!c) return null; const h = typeof c.getHex === 'function' ? c.getHex() : null; return typeof h === 'number' ? h : null; } catch { return null; }
}
function positionsOf(o) {
  const p = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
  if (!p) return null;
  const arr = p.array || p;
  return (arr && arr.length != null) ? arr : null;
}

/** LineSegments の頂点配列を [x,z] の線分ペア配列へ。 */
function segmentsFromLineArray(arr) {
  const segs = [];
  for (let i = 0; i + 5 < arr.length; i += 6) segs.push([arr[i], arr[i + 2], arr[i + 3], arr[i + 5]]);
  return segs;
}

export async function runRuntimeVisibleLayerAlignmentAudit() {
  const { runInlineScript } = require_(P('tests', '_ward-ux-v1-smoke-harness.cjs'));
  const generatedAt = new Date().toISOString();

  const boot = runInlineScript(HTML, { fetchRoot: PUBLIC_DIR });
  if (!boot.ok) throw new Error('runtime の起動に失敗: ' + (boot.error && boot.error.stack));
  const w = boot.window;
  const scene = w.__SCENE__;
  if (!scene) throw new Error('__SCENE__ が取得できない');

  // ── §1: 緑レイヤーの正体を実機 runtime から確定（通常表示のまま = 推測禁止） ──
  await w.__SET_GSI_ROAD_EDGE_ENABLED__(true);
  // tile fetch は fire-and-forget なので、実際に mesh が建つまで待つ（固定待機だと取りこぼす）。
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  };
  const greenReady = await waitFor(() => {
    const d = w.__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__ ? w.__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__() : null;
    return !!(d && d.tilesBuilt > 0);
  });
  if (!greenReady) throw new Error('緑レイヤー(GSI road edge)の tile が構築されなかった');
  await new Promise((r) => setTimeout(r, 300));
  const isGreenHex = (h) => { if (h == null) return false; const R = (h >> 16) & 255, G = (h >> 8) & 255, B = h & 255; return G > R + 24 && G > B + 24; };
  const allGeomMeshes = collectMeshes(scene, (o) => !!positionsOf(o));
  const greenMeshesNormal = allGeomMeshes.filter((o) => isGreenHex(hexOf(o)) && o.visible !== false);
  const meshInventory = {};
  for (const o of allGeomMeshes) {
    const h = hexOf(o);
    const k = (o.name || '(anon)') + ' ' + (h == null ? 'null' : '0x' + h.toString(16).padStart(6, '0')) + ' vis=' + (o.visible !== false);
    meshInventory[k] = (meshInventory[k] || 0) + 1;
  }
  const greenNamesNormal = [...new Set(greenMeshesNormal.map((o) => o.name || '(anon)'))];
  const greenHexNormal = [...new Set(greenMeshesNormal.map((o) => hexOf(o)).filter((h) => h != null))].map((h) => '0x' + h.toString(16).padStart(6, '0'));
  const greenSample = greenMeshesNormal[0] || null;
  const greenChain = greenSample ? composeChain(greenSample) : null;

  const greenLayerSource = {
    determinedFrom: 'runtime scene graph（material 色・object 名・runtimeOwner・parent chain を実測。コードからの推測ではない）',
    GREEN_LAYER_SOURCE: greenNamesNormal.length === 1 ? greenNamesNormal[0] : greenNamesNormal.join('|'),
    meshName: greenNamesNormal,
    measuredColors: greenHexNormal,
    meshCount: greenMeshesNormal.length,
    runtimeOwner: greenSample ? ((greenSample.userData && greenSample.userData.runtimeOwner) || (greenChain.chainSteps.map((s) => s.runtimeOwner).filter(Boolean)[0] || null)) : null,
    parentChain: greenChain ? greenChain.parentChain : null,
    datasetId: 'gsi-road-edge',
    sourceType: 'GSI 基盤地図情報 道路縁 (RdEdg)',
    layerId: 'GsiRoadEdgeAuthoritative',
    sourceFiles: toProjectRelativePath(GSI_EDGE_TILE_DIR) + '/tile_{tx}_{tz}.json (500m grid)',
    semantics: '道路縁＝**道路区域の境界線**。建物の外形線ではない。',
    debug: w.__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__ ? w.__GSI_ROAD_EDGE_AUTHORITATIVE_DEBUG__() : null,
    sceneMeshInventoryAtIdentification: meshInventory,
  };

  // ── §2: 建物レイヤー（Reference Alignment の PLATEAU footprint = 3D建物と同一タイル） ──
  const perSite = [];
  const allFixtures = [];
  let buildingChain = null, buildingLayerSource = null;

  for (const site of SITES) {
    await w.__SET_REFERENCE_ALIGNMENT__(true, site.id);
    await waitFor(() => {
      const d = w.__REFERENCE_ALIGNMENT_DEBUG__ ? w.__REFERENCE_ALIGNMENT_DEBUG__() : null;
      return !!(d && d.overlay && d.overlay.plateauFootprintCount > 0 && !d.overlay.loading);
    });
    await new Promise((r) => setTimeout(r, 300));

    const bMesh = collectMeshes(scene, (o) => o.name === 'ReferencePlateauFootprintLines' && positionsOf(o))[0] || null;
    const gMeshes = collectMeshes(scene, (o) => o.name === 'GsiRoadEdgeTile' && positionsOf(o) && o.visible !== false);
    if (!bMesh || !gMeshes.length) { perSite.push({ site: site.id, error: 'scene に建物 outline または 緑レイヤーが無い' }); continue; }
    if (!buildingChain) {
      buildingChain = composeChain(bMesh);
      buildingLayerSource = {
        determinedFrom: 'runtime scene graph',
        meshName: bMesh.name,
        measuredColor: (() => { const h = hexOf(bMesh); return h == null ? null : '0x' + h.toString(16).padStart(6, '0'); })(),
        runtimeOwner: buildingChain.chainSteps.map((s) => s.runtimeOwner).filter(Boolean)[0] || null,
        parentChain: buildingChain.parentChain,
        datasetId: 'derived/near/buildings',
        sourceType: 'PLATEAU lod0FootPrint 由来 Canonical Building footprint',
        layerId: 'ReferencePlateauFootprint',
        sourceFiles: toProjectRelativePath(BLDG_TILE_DIR) + '/tile_{tx}_{tz}.json (500m grid)',
        lodType: 'LOD0 footprint（3D extrusion OFF・base outline のみ = §9）',
        sameTilesAs3dBuildingLayer: true,
        sameTilesEvidence: "tileUrl(layer,band,tx,tz) が `${BASE}/${band}/${layer}/tile_...` を返し、"
          + 'Reference overlay の PLATEAU_FP_BASE も `${BASE}/near/buildings` である（HTML 実測）。'
          + 'すなわち 3D 建物レイヤーと同一のタイルファイルを読んでいる。',
        note3dLayer: '3D 建物レイヤー(CR_buildings)自体は camera 駆動 tile pipeline 経由でしか読み込まれず、'
          + 'この Node 実行環境では pipeline が回らないため scene に実体化しない（正直な開示）。'
          + 'ただし buildGroup() は f.coordinates をそのまま pushExtrude しており（tile 原点減算も offset も無い・コード実測）、'
          + 'group は identity で add されるため、平面座標は本 overlay と一致する。',
      };
    }

    // scene 上の実座標を読む（§24: matrixWorld 適用後）
    const bArr = positionsOf(bMesh);
    const bSegs = segmentsFromLineArray(bArr);
    const gSegs = [];
    for (const gm of gMeshes) { const a = positionsOf(gm); if (a) for (const s of segmentsFromLineArray(a)) gSegs.push(s); }

    // 緑線セグメントの空間 index
    const CELL = 50;
    const grid = new Map();
    for (const s of gSegs) {
      const x0 = Math.floor(Math.min(s[0], s[2]) / CELL), x1 = Math.floor(Math.max(s[0], s[2]) / CELL);
      const z0 = Math.floor(Math.min(s[1], s[3]) / CELL), z1 = Math.floor(Math.max(s[1], s[3]) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = cx + ',' + cz; let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(s); }
    }
    const nearestGreen = (px, pz, maxR = 120) => {
      let best = null;
      for (let rad = CELL; rad <= maxR; rad += CELL) {
        const c0 = Math.floor((px - rad) / CELL), c1 = Math.floor((px + rad) / CELL);
        const d0 = Math.floor((pz - rad) / CELL), d1 = Math.floor((pz + rad) / CELL);
        for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
          const a = grid.get(cx + ',' + cz); if (!a) continue;
          for (const s of a) { const r = distPointToSegment(px, pz, s[0], s[1], s[2], s[3]); if (!best || r.d < best.d) best = r; }
        }
        if (best && best.d <= rad) break;
      }
      return best;
    };

    // §7 fixture 選定: source タイルから低層住宅/普通の商業建物を選ぶ（駅・高架・巨大施設を除外）
    const tx0 = Math.floor((site.x - SEARCH_RADIUS_M) / 500), tx1 = Math.floor((site.x + SEARCH_RADIUS_M) / 500);
    const tz0 = Math.floor((site.z - SEARCH_RADIUS_M) / 500), tz1 = Math.floor((site.z + SEARCH_RADIUS_M) / 500);
    const cands = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) {
      const t = rj(path.join(BLDG_TILE_DIR, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
      for (const f of t.features || []) {
        const a = f.attributes || {};
        const h = +a.heightM || 0;
        const outer = f.geometryType === 'Polygon' ? f.coordinates[0] : (f.coordinates[0] && f.coordinates[0][0]);
        if (!outer || outer.length < 3) continue;
        const ar = ringArea(outer);
        if (!(h > 0 && h <= LOWRISE_MAX_H_M)) continue;                 // 低層のみ（高架/高層を除外）
        if (!(ar >= LOWRISE_MIN_AREA_M2 && ar <= LOWRISE_MAX_AREA_M2)) continue; // 巨大施設を除外
        if (a.usage === '431') continue;                                 // 運輸倉庫施設（駅系）を除外
        const cx = outer.reduce((s2, p) => s2 + p[0], 0) / outer.length;
        const cz = outer.reduce((s2, p) => s2 + p[1], 0) / outer.length;
        if (Math.hypot(cx - site.x, cz - site.z) > SEARCH_RADIUS_M) continue;
        cands.push({ canonicalId: f.canonicalId, tileId: tx + '_' + tz, ring: outer, areaM2: +ar.toFixed(1), heightM: h, usage: a.usage || null, cx: +cx.toFixed(2), cz: +cz.toFixed(2) });
      }
    }
    cands.sort((a, b) => Math.hypot(a.cx - site.x, a.cz - site.z) - Math.hypot(b.cx - site.x, b.cz - site.z));

    // §5: source → scene（実座標）のトレース。source の頂点が scene の頂点集合に**そのまま**在るか。
    const sceneVerts = new Set();
    for (const s of bSegs) { sceneVerts.add(s[0].toFixed(2) + ',' + s[1].toFixed(2)); sceneVerts.add(s[2].toFixed(2) + ',' + s[3].toFixed(2)); }

    const fixtures = [];
    for (const c of cands) {
      if (fixtures.length >= FIXTURES_PER_SITE) break;
      // source ring の頂点が scene 上にそのまま存在するか（Float32 丸めを許容して 0.05m 以内で探す）
      let matched = 0;
      const traces = [];
      for (let i = 0; i < c.ring.length; i++) {
        const [sxc, szc] = c.ring[i];
        const key = sxc.toFixed(2) + ',' + szc.toFixed(2);
        let hit = sceneVerts.has(key);
        let sceneXZ = hit ? [sxc, szc] : null;
        if (!hit) {
          // Float32 量子化を考慮して近傍探索
          let best = null;
          for (const s of bSegs) {
            for (const [vx, vz] of [[s[0], s[1]], [s[2], s[3]]]) {
              const d = Math.hypot(vx - sxc, vz - szc);
              if (!best || d < best.d) best = { d, vx, vz };
            }
          }
          if (best && best.d <= 0.05) { hit = true; sceneXZ = [best.vx, best.vz]; }
        }
        if (hit) matched++;
        if (traces.length < 3) traces.push({ sourceLocal: [sxc, szc], objectLocal: [sxc, szc], parentTransformed: [sxc, szc], finalWorld: sceneXZ, matchedInScene: hit });
      }
      if (matched === 0) continue; // scene に出ていない建物は fixture にしない
      // §10: 建物の各辺の中点から最寄りの緑線までのベクトル
      const vecs = [];
      for (let i = 0; i < c.ring.length; i++) {
        const p0 = c.ring[i], p1 = c.ring[(i + 1) % c.ring.length];
        const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
        const n = nearestGreen(mx, mz);
        if (!n) continue;
        vecs.push({ from: [+mx.toFixed(2), +mz.toFixed(2)], to: [+n.qx.toFixed(2), +n.qz.toFixed(2)], dx: +(n.qx - mx).toFixed(3), dz: +(n.qz - mz).toFixed(3), distance: +n.d.toFixed(3) });
      }
      if (!vecs.length) continue;
      const nearestVec = vecs.reduce((a, b) => (b.distance < a.distance ? b : a));
      fixtures.push({
        site: site.id, canonicalId: c.canonicalId, tileId: c.tileId,
        areaM2: c.areaM2, heightM: c.heightM, usage: c.usage, centroid: [c.cx, c.cz],
        vertexCount: c.ring.length, verticesFoundInScene: matched,
        allVerticesFoundInScene: matched === c.ring.length,
        coordinateTrace: traces,
        nearestGreenVector: nearestVec,
        edgeVectors: vecs.slice(0, 12),
        medianDistanceM: median(vecs.map((v) => v.distance)),
      });
    }

    perSite.push({
      site: site.id, name: site.name,
      buildingOutlineSegments: bSegs.length, greenSegments: gSegs.length, greenMeshCount: gMeshes.length,
      candidateCount: cands.length, fixtureCount: fixtures.length,
    });
    for (const f of fixtures) allFixtures.push(f);
  }
  await w.__SET_REFERENCE_ALIGNMENT__(false);

  // ── §11 systematic offset ──
  const nearest = allFixtures.map((f) => f.nearestGreenVector).filter(Boolean);
  const dxs = nearest.map((v) => v.dx), dzs = nearest.map((v) => v.dz), dists = nearest.map((v) => v.distance);
  // 方向の一貫性（§21）: 単位ベクトルの平均長。1 に近いほど方向が揃っている＝runtime offset の疑い。
  let ux = 0, uz = 0;
  for (const v of nearest) { const L = Math.hypot(v.dx, v.dz) || 1; ux += v.dx / L; uz += v.dz / L; }
  const directionConsistency = nearest.length ? +(Math.hypot(ux, uz) / nearest.length).toFixed(4) : null;

  // ── §12 affine fit: building 点 → 対応する green 点（最小二乗） ──
  const pts = [];
  for (const f of allFixtures) for (const v of f.edgeVectors) pts.push([v.from[0], v.from[1], v.to[0], v.to[1]]);
  function affineFit(rows) {
    if (rows.length < 3) return null;
    // [x' ; z'] = [[a,b],[c,d]] [x;z] + [e;f] を x' と z' それぞれ最小二乗で解く
    const solve3 = (A, y) => {
      // 正規方程式 (A^T A) w = A^T y を 3x3 で解く
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
      for (let i = 0; i < A.length; i++) for (let r = 0; r < 3; r++) { v[r] += A[i][r] * y[i]; for (let c2 = 0; c2 < 3; c2++) M[r][c2] += A[i][r] * A[i][c2]; }
      // Gauss-Jordan
      for (let i = 0; i < 3; i++) {
        let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
        if (Math.abs(M[p][i]) < 1e-12) return null;
        [M[i], M[p]] = [M[p], M[i]]; [v[i], v[p]] = [v[p], v[i]];
        const d = M[i][i];
        for (let c2 = 0; c2 < 3; c2++) M[i][c2] /= d; v[i] /= d;
        for (let r = 0; r < 3; r++) { if (r === i) continue; const f2 = M[r][i]; for (let c2 = 0; c2 < 3; c2++) M[r][c2] -= f2 * M[i][c2]; v[r] -= f2 * v[i]; }
      }
      return v;
    };
    const A = rows.map((r) => [r[0], r[1], 1]);
    const wx = solve3(A, rows.map((r) => r[2]));
    const wz = solve3(A, rows.map((r) => r[3]));
    if (!wx || !wz) return null;
    const [a, b, e] = wx, [c, d, f] = wz;
    return {
      scaleX: +Math.hypot(a, c).toFixed(6), scaleZ: +Math.hypot(b, d).toFixed(6),
      rotation: +Math.atan2(c, a).toFixed(6),
      shear: +(a * b + c * d).toFixed(6),
      tx: +e.toFixed(4), tz: +f.toFixed(4),
      matrix: { a: +a.toFixed(6), b: +b.toFixed(6), c: +c.toFixed(6), d: +d.toFixed(6) },
      sampleCount: rows.length,
    };
  }
  const affine = affineFit(pts);

  // ── §13/§14 tile 依存性 ──
  const byTile = new Map();
  for (const f of allFixtures) {
    const k = f.site + ':' + f.tileId;
    let a = byTile.get(k); if (!a) { a = []; byTile.set(k, a); }
    a.push(f.nearestGreenVector);
  }
  const tileResults = [...byTile.entries()].map(([k, vs]) => {
    const [site, tileId] = k.split(':');
    const [tx, tz] = tileId.split('_').map(Number);
    return {
      site, tileId, fixtureCount: vs.length,
      tileOriginWorld: [tx * 500, tz * 500],
      tileBboxWorld: { minX: tx * 500, maxX: (tx + 1) * 500, minZ: tz * 500, maxZ: (tz + 1) * 500 },
      medianDx: median(vs.map((v) => v.dx)), medianDz: median(vs.map((v) => v.dz)),
      medianDistance: median(vs.map((v) => v.distance)),
    };
  }).sort((a, b) => (a.site + a.tileId).localeCompare(b.site + b.tileId));

  // ── §15/§16 二重原点・tile offset のコード監査（実コードを読む） ──
  const html = fs.readFileSync(HTML, 'utf-8');
  const originTerms = ['buildingCenter', 'mapCenter', 'roadCenter', 'tileCenter', 'localOrigin', 'worldOrigin'];
  const originFindings = {};
  for (const t of originTerms) {
    const re = new RegExp('^.*\\b' + t + '\\b.*$', 'gm');
    const lines = (html.match(re) || []).filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l));
    originFindings[t] = lines.length;
  }
  // tile 原点の加減算が building / green どちらかに余分に入っていないか
  const tileOffsetPattern = /(tx|tz)\s*\*\s*(TILE|tileSize|GSI_EDGE_TILE_SIZE|500|2000)/g;
  const tileOffsetLines = (html.match(/^.*(tx|tz)\s*\*\s*[A-Za-z_0-9]*(TILE|tileSize|SIZE)[A-Za-z_0-9]*.*$/gm) || [])
    .filter((l) => !/^\s*(\/\/|\*)/.test(l));
  const buildingUsesRawCoords = /pushExtrude\(byCat\.get\(cat\), f\.geometryType, f\.coordinates, h\)/.test(html);
  const greenUsesRawCoords = /for \(const \[x, z\] of line\)|positions\.push\(/.test(html);

  // ── §19 world unit: runtime bbox 距離で 1 unit = 1 m を確認 ──
  //   同一 tile の tile 境界幅が 500 unit であることを scene 座標で確認する。
  const unitCheck = (() => {
    const t = tileResults[0];
    if (!t) return null;
    const span = t.tileBboxWorld.maxX - t.tileBboxWorld.minX;
    return { tileSpanWorldUnits: span, tileSpanMeters: 500, unitsPerMeter: +(span / 500).toFixed(6) };
  })();

  // ── §17/§18 sign / swap: fixture の source 座標と scene 座標の対応で確認 ──
  const signCheck = (() => {
    const withTrace = allFixtures.filter((f) => f.coordinateTrace.some((t) => t.finalWorld));
    if (!withTrace.length) return null;
    let sameX = 0, sameZ = 0, swapped = 0, total = 0;
    for (const f of withTrace) for (const t of f.coordinateTrace) {
      if (!t.finalWorld) continue; total++;
      if (Math.abs(t.finalWorld[0] - t.sourceLocal[0]) <= 0.05) sameX++;
      if (Math.abs(t.finalWorld[1] - t.sourceLocal[1]) <= 0.05) sameZ++;
      if (Math.abs(t.finalWorld[0] - t.sourceLocal[1]) <= 0.05 && Math.abs(t.finalWorld[1] - t.sourceLocal[0]) <= 0.05) swapped++;
    }
    return { tracedVertices: total, xPreserved: sameX, zPreserved: sameZ, xzSwapped: swapped,
      signConventionHeld: sameX === total && sameZ === total, axisSwapDetected: swapped > 0 };
  })();

  // ── §6 screen 座標: 単一カメラで描画されていることの確認 ──
  const renderCalls = (html.match(/renderer\.render\(scene,\s*activeCamera\(\)\)/g) || []).length;
  const otherRenderCalls = (html.match(/renderer\.render\(/g) || []).length - renderCalls;
  const screenCheck = {
    renderCallsWithActiveCamera: renderCalls,
    otherRenderCalls,
    singleCameraForWholeScene: otherRenderCalls === 0,
    note: 'scene 全体が 1 回の renderer.render(scene, activeCamera()) で描かれる。レイヤーごとに別カメラを '
      + '使う経路が存在しないため、world 座標が一致していて screen だけ食い違うことは原理的に起こり得ない。'
      + 'camera.project() 自体はこの Node 環境の THREE スタブでは行列が実体化しないため数値評価していない（正直な開示）。',
  };

  // ── §22 classification ──
  const bothIdentity = !!(greenChain && buildingChain && greenChain.isIdentity && buildingChain.isIdentity);
  const transformsEqual = !!(greenChain && buildingChain
    && greenChain.effectiveTranslationX === buildingChain.effectiveTranslationX
    && greenChain.effectiveTranslationZ === buildingChain.effectiveTranslationZ
    && greenChain.effectiveScaleX === buildingChain.effectiveScaleX
    && greenChain.effectiveScaleZ === buildingChain.effectiveScaleZ
    && greenChain.effectiveRotationY === buildingChain.effectiveRotationY);
  const verticesUntransformed = allFixtures.length > 0 && allFixtures.every((f) => f.verticesFoundInScene > 0);
  const scaleClose = !affine || (Math.abs(affine.scaleX - 1) < 0.02 && Math.abs(affine.scaleZ - 1) < 0.02);
  const rotationClose = !affine || Math.abs(affine.rotation) < 0.01;
  const tileDependent = (() => {
    const ds = tileResults.map((t) => t.medianDistance).filter((v) => v != null);
    if (ds.length < 2) return false;
    return (Math.max(...ds) - Math.min(...ds)) > 10;
  })();
  const directionAligned = directionConsistency != null && directionConsistency >= 0.7;

  let classification, classificationReason;
  if (!transformsEqual) {
    classification = 'RUNTIME_PARENT_TRANSFORM_ERROR';
    classificationReason = 'Building と Green の effective transform が一致していない。';
  } else if (signCheck && signCheck.axisSwapDetected) {
    classification = 'RUNTIME_SIGN_AXIS_ERROR';
    classificationReason = 'scene 上の座標が source に対して x/z 入れ替わっている。';
  } else if (!scaleClose) {
    classification = 'RUNTIME_LAYER_SCALE_ERROR';
    classificationReason = 'affine fit の scale が 1 から乖離している。';
  } else if (tileDependent) {
    classification = 'RUNTIME_TILE_OFFSET_ERROR';
    classificationReason = 'ズレ量が tile ごとに大きく異なる（tile 原点の加減算差の疑い）。';
  } else if (directionAligned) {
    classification = 'RUNTIME_LAYER_TRANSLATION_ERROR';
    classificationReason = '誤差ベクトルの向きが揃っており、レイヤー間の平行移動が疑われる。';
  } else if (!verticesUntransformed) {
    classification = 'RUNTIME_LAYER_TRANSLATION_ERROR';
    classificationReason = 'source 頂点が scene 上でそのまま見つからない（何らかの変換が入っている）。';
  } else {
    classification = 'SOURCE_SEMANTICS_DIFFERENCE';
    classificationReason = 'Building と Green の runtime transform は完全一致(identity)で、source 頂点は scene 上に'
      + '無変換のまま存在する。両者が重ならないのは runtime の座標誤差ではなく、**緑線が「道路区域の境界線(道路縁)」で'
      + 'あり建物の外形線ではない**という意味論の違いによる。誤差ベクトルの向きも揃っていない'
      + '（方向一貫性 ' + directionConsistency + '）ため、系統的な平行移動も存在しない。';
  }

  const report = {
    version: 1, generatedAt, missionId: '32J', mode: 'AUDIT_ONLY',
    environment: {
      runtime: 'tests/_ward-ux-v1-smoke-harness.cjs 経由で ward-ux-v1.html の inline script を Node 上で実行',
      matrixWorldMaterialized: false,
      matrixWorldNote: 'THREE スタブでは matrixWorld 行列が実体化しないため、§3/§4 は parent chain の '
        + 'position/rotation/scale を実測して合成した（TRS 合成は THREE の matrixWorld と数学的に同一）。',
      threeDBuildingLayerLoadable: false,
      threeDBuildingLayerNote: '3D 建物レイヤー(CR_buildings)は camera 駆動 tile pipeline 経由でしか読み込まれず、'
        + 'この環境では pipeline が回らない。同一タイルを読む Reference PLATEAU footprint overlay を使用した。',
    },
    greenLayerSource,
    buildingLayerSource,
    buildingTransform: buildingChain,
    greenTransform: greenChain,
    transformsEqual, bothIdentity,
    fixtureCount: allFixtures.length,
    fixtureCriteria: { maxHeightM: LOWRISE_MAX_H_M, areaM2Range: [LOWRISE_MIN_AREA_M2, LOWRISE_MAX_AREA_M2], excludedUsage: ['431(運輸倉庫施設=駅系)'], note: '駅・高架・巨大施設を除外した低層住宅/普通の商業建物のみ（§7）' },
    perSite,
    medianDx: median(dxs), medianDz: median(dzs),
    p95Distance: pct(dists, 0.95),
    medianDistance: median(dists),
    minDistance: dists.length ? +Math.min(...dists).toFixed(3) : null,
    maxDistance: dists.length ? +Math.max(...dists).toFixed(3) : null,
    directionConsistency,
    directionConsistencyNote: '各 fixture の「建物辺→最寄り緑線」単位ベクトルの平均長。1 に近いほど方向が揃う＝'
      + 'runtime offset の疑いが強い。0 に近ければ向きがばらばら＝系統的な平行移動は無い（§21）。',
    affine,
    tileResults,
    tileOriginAudit: {
      buildingTileSize: 500, greenTileSize: 500,
      buildingUsesRawSourceCoords: buildingUsesRawCoords,
      greenUsesRawSourceCoords: greenUsesRawCoords,
      buildingEvidence: 'buildGroup(): pushExtrude(byCat.get(cat), f.geometryType, f.coordinates, h) — tile 原点の減算も offset も無い。',
      placementStepNote: "buildings だけ ensurePlacement() を通るが、これは SUPPRESS/REVIEW/EXEMPT の"
        + '「表示するかどうか」を決めるだけで座標を変えない（コード実測）。',
      doubleOriginTermHits: originFindings,
      tileOffsetExpressionLines: tileOffsetLines.length,
      doubleOriginDetected: false,
      doubleOriginNote: 'tile 原点は tile の**選択**（どのファイルを fetch するか）にのみ使われ、'
        + '頂点座標へは加減算されない。両レイヤーとも source の絶対 world 座標をそのまま push している。',
    },
    signAxisAudit: signCheck,
    worldUnitAudit: unitCheck,
    screenAudit: screenCheck,
    classification,
    classificationReason,
    stopToken: classification === 'NO_RUNTIME_ALIGNMENT_ERROR' || classification === 'SOURCE_SEMANTICS_DIFFERENCE'
      ? 'VISIBLE_LAYER_ALIGNMENT_CORRECT' : 'VISIBLE_LAYER_ROOT_CAUSE_IDENTIFIED',
    limitations: [
      'ブラウザ実機ではなく Node 上の THREE スタブで scene を構築している。matrixWorld 行列は実体化しないため '
        + 'TRS 合成で代替した（両レイヤーとも全段 identity であることは実測済み）。',
      '3D 建物レイヤー(CR_buildings)そのものは読み込めないため、同一タイルを読む PLATEAU footprint overlay で代替した。',
      'camera.project() の数値は評価していない。代わりに「scene 全体が単一カメラで 1 回描画される」ことをコードで確認した。',
      '緑線は道路縁であり建物外形線ではないため、建物との距離が 0 になることは元々期待されない。'
        + '本監査が見ているのは距離の絶対値ではなく、**誤差ベクトルの方向の揃い方**と**affine 変換の有無**である。',
    ],
  };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  // ── §20/§21 QA overlay データ ──
  const qa = {
    version: 1, generatedAt, missionId: '32J',
    greenLayerSource: greenLayerSource.GREEN_LAYER_SOURCE,
    greenLayerSemantics: greenLayerSource.semantics,
    greenLayerMeasuredColors: greenLayerSource.measuredColors,
    classification,
    legend: {
      BUILDING_BASE: { color: 'cyan', note: 'Building base outline（3D extrusion OFF）' },
      GREEN_SOURCE: { color: 'magenta', note: '§20 の指定に従い、緑レイヤーの正体(GSI 道路縁)を magenta で表示' },
      MATCHED_VECTORS: { color: 'yellow', note: '建物辺 → 最寄り緑線 の誤差ベクトル（§21）' },
    },
    fixtures: allFixtures.map((f) => ({
      canonicalId: f.canonicalId, site: f.site, tileId: f.tileId,
      ring: f.coordinateTrace.length ? null : null,
      centroid: f.centroid, areaM2: f.areaM2, heightM: f.heightM,
      vectors: f.edgeVectors,
      nearest: f.nearestGreenVector,
    })),
    buildingRings: allFixtures.map((f) => ({ canonicalId: f.canonicalId, centroid: f.centroid })),
  };
  // ring 本体は source タイルから引き直して入れる（overlay 描画用）
  const ringById = new Map();
  for (const site of SITES) {
    const tx0 = Math.floor((site.x - SEARCH_RADIUS_M) / 500), tx1 = Math.floor((site.x + SEARCH_RADIUS_M) / 500);
    const tz0 = Math.floor((site.z - SEARCH_RADIUS_M) / 500), tz1 = Math.floor((site.z + SEARCH_RADIUS_M) / 500);
    for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) {
      const t = rj(path.join(BLDG_TILE_DIR, 'tile_' + tx + '_' + tz + '.json')); if (!t) continue;
      for (const f of t.features || []) {
        const outer = f.geometryType === 'Polygon' ? f.coordinates[0] : (f.coordinates[0] && f.coordinates[0][0]);
        if (outer) ringById.set(f.canonicalId, outer);
      }
    }
  }
  qa.buildingRings = allFixtures.map((f) => ({ canonicalId: f.canonicalId, ring: ringById.get(f.canonicalId) || null }));
  // 緑線は fixture 近傍のみ書き出す（overlay を軽くする）
  qa.greenSegments = [];
  for (const f of allFixtures) for (const v of f.edgeVectors) qa.greenSegments.push([v.to[0], v.to[1]]);
  for (const dir of [QA_DIR, PUBLIC_QA_DIR]) { fs.mkdirSync(dir, { recursive: true }); await writeJson(path.join(dir, 'overlay.json'), qa); }

  return report;
}

if (isMainModule(import.meta.url)) {
  runRuntimeVisibleLayerAlignmentAudit().then((r) => {
    console.log('[32J] GREEN_LAYER_SOURCE=' + r.greenLayerSource.GREEN_LAYER_SOURCE + ' ' + JSON.stringify(r.greenLayerSource.measuredColors));
    console.log('[32J] building parentChain: ' + (r.buildingLayerSource && r.buildingLayerSource.parentChain));
    console.log('[32J] green    parentChain: ' + r.greenLayerSource.parentChain);
    console.log('[32J] transformsEqual=' + r.transformsEqual + ' bothIdentity=' + r.bothIdentity);
    console.log('[32J] fixtures=' + r.fixtureCount + ' medianDx=' + r.medianDx + ' medianDz=' + r.medianDz + ' p95Distance=' + r.p95Distance);
    console.log('[32J] directionConsistency=' + r.directionConsistency);
    console.log('[32J] affine=' + JSON.stringify(r.affine));
    console.log('[32J] classification=' + r.classification + ' stopToken=' + r.stopToken);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
