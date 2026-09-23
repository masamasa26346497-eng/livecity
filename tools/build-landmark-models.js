#!/usr/bin/env node
// tools/build-landmark-models.js
// [Mission 33E §2/§4] ランドマーク高精細モデル（PoC: 大阪城）の設定 + geometry を生成する。
// ══════════════════════════════════════════════════════════════════════════════════
// ネットワーク不要。入力はすべてリポジトリ内の実データ:
//   data/reports/osaka-castle-source-scan.json  ← tools/audit/osaka-castle-source-scan.js が作る
//     - OSM way/34619038「大阪城」= 天守閣の実 footprint（9 頂点 / height=58 / building:levels=8）
//     - OSM historic=city_gate の 4 門（大手門・桜門・青屋門・北仕切門）の実 footprint
//     - OSM way/1550234049 historic=castle = 城域の外郭ライン（36 頂点）
//     - canonical V2N の天守閣相当棟（PLATEAU 実測 heightM）と、その footprint
//
// 出力:
//   public/map-data/osaka-city/landmarks/landmark-models.json   （HTML が fetch）
//   data/processed/osaka-city/landmarks/landmark-models.json     （確認用・同内容）
//   data/reports/landmark-models-build.json                      （生成レポート）
//
// ■ どこまでが実データで、どこからが様式化か（§4 の「silhouette 重視」の設計判断）
//   実データ: 平面形（OSM/PLATEAU の実 footprint）・全高（PLATEAU 実測 53.2m）・門の位置と平面・城域ライン
//   様式化  : 全高を「天守台 : 天守」へ分ける比率と、5 層の積み方・軒の出・屋根勾配
//             （これらの実測値はリポジトリ内に無い。測量値として主張しない）
//   OSM building:levels=8（8 階）/ 5 層天守という構成に合わせ、見える屋根の段数を 5 とする。
// ══════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SCAN = P('data', 'reports', 'osaka-castle-source-scan.json');
const OUT_PUBLIC = P('public', 'map-data', 'osaka-city', 'landmarks', 'landmark-models.json');
const OUT_PROCESSED = P('data', 'processed', 'osaka-city', 'landmarks', 'landmark-models.json');
const OUT_REPORT = P('data', 'reports', 'landmark-models-build.json');

// ── 様式化パラメータ（実測値ではない。ここに集約して根拠を明示する）────────────────
export const CASTLE_STYLE = {
  baseRatio: 0.27,        // 全高のうち天守台（石垣）が占める割合。残りが天守本体
  tiers: 5,               // 見える屋根の段数（5 層天守）
  tierTopScale: 0.48,     // 最上層の平面が最下層の何倍か（各層は等比で絞る）
  eaveOut: 0.20,          // 軒の出（各層の平面に対する比率）。小さいと段が読めず寸胴に見える
  eaveDrop: 0.042,        // 軒先の垂れ下がり（全高比）
  eaveRise: 0.020,        // 軒の厚み（全高比）
  ridgeRise: 0.160,       // 最上層の屋根の立ち上がり（全高比）。浅いと平板に見える
  basePad: 0.06,          // 天守台の平面を天守平面から広げる率（canonical 実 footprint が無いときのみ使う）
  gateHeightM: 9,         // 城門の高さ（OSM に高さタグが無いため既定値。§既知の制約で明記）
  gateRoofRise: 3.2,      // 城門の屋根の立ち上がり（m）
  outlineWidthM: 12,      // 城域ラインの帯幅。構造物ではなく「範囲」なので低く平らに保つ
  outlineHeightM: 0.25,   // 壁に見えない高さ（OSM historic=castle は城域の境界であって石垣ではない）
};
// 材質キー（HTML 側で色を持つ。ここでは意味だけ持たせる）
export const MATERIALS = ['stone', 'wall', 'roof', 'trim', 'outline'];

// ── 幾何ヘルパー（XZ リング + Y の押し出し。座標系は znorth-neg-v1 のまま触らない）──
export function dedupeRing(ring) {
  const r = ring.map((p) => [p[0], p[1]]);
  if (r.length > 1 && Math.abs(r[0][0] - r[r.length - 1][0]) < 1e-6 && Math.abs(r[0][1] - r[r.length - 1][1]) < 1e-6) r.pop();
  return r;
}
export function centroidOf(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (!a) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}
export function scaleRing(ring, c, k) { return ring.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]); }
export function ringIsCCW(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a > 0;
}

// メッシュ蓄積器。material ごとに positions/indices を分けて持つ（HTML 側で material 別 merge する）
export function createMeshBuilder() {
  const buf = {};
  const of = (m) => (buf[m] = buf[m] || { positions: [], indices: [] });
  const vert = (m, x, y, z) => { const b = of(m); b.positions.push(x, y, z); return b.positions.length / 3 - 1; };
  const tri = (m, a, b2, c) => { of(m).indices.push(a, b2, c); };
  return {
    buf, vert, tri,
    // ring を y0→y1 で押し出した側面（+ 必要なら上面）
    prism(m, ring, y0, y1, { cap = true, floor = false } = {}) {
      const ccw = ringIsCCW(ring);
      const n = ring.length;
      const lo = ring.map((p) => vert(m, p[0], y0, p[1]));
      const hi = ring.map((p) => vert(m, p[0], y1, p[1]));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (ccw) { tri(m, lo[i], hi[i], hi[j]); tri(m, lo[i], hi[j], lo[j]); }
        else { tri(m, lo[i], hi[j], hi[i]); tri(m, lo[i], lo[j], hi[j]); }
      }
      if (cap) {
        const c = centroidOf(ring);
        const ci = vert(m, c[0], y1, c[1]);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          if (ccw) tri(m, ci, hi[i], hi[j]); else tri(m, ci, hi[j], hi[i]);
        }
      }
      if (floor) {
        const c = centroidOf(ring);
        const ci = vert(m, c[0], y0, c[1]);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          if (ccw) tri(m, ci, lo[j], lo[i]); else tri(m, ci, lo[i], lo[j]);
        }
      }
      return { lo, hi };
    },
    // 軒: 内側 ring(yTop) から外側 ring(yEave) へ広がる傘状の面 + 軒先の小口
    eave(m, ring, c, outK, yTop, yEave, thick) {
      const inner = ring, outer = scaleRing(ring, c, outK);
      const ccw = ringIsCCW(ring);
      const n = ring.length;
      const ai = inner.map((p) => vert(m, p[0], yTop, p[1]));
      const ao = outer.map((p) => vert(m, p[0], yEave, p[1]));
      const bo = outer.map((p) => vert(m, p[0], yEave - thick, p[1]));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (ccw) { tri(m, ai[i], ao[i], ao[j]); tri(m, ai[i], ao[j], ai[j]); tri(m, ao[i], bo[i], bo[j]); tri(m, ao[i], bo[j], ao[j]); }
        else { tri(m, ai[i], ao[j], ao[i]); tri(m, ai[i], ai[j], ao[j]); tri(m, ao[i], bo[j], bo[i]); tri(m, ao[i], ao[j], bo[j]); }
      }
      return outer;
    },
    // 寄棟の頂部: ring から棟（centroid 方向へ潰した短い稜線）へ立ち上げる
    hipRoof(m, ring, c, y0, rise) {
      const ccw = ringIsCCW(ring);
      const n = ring.length;
      const lo = ring.map((p) => vert(m, p[0], y0, p[1]));
      // 棟は centroid を通る長辺方向の短い線分にする（完全な四角錐だとピラミッドに見えるため）
      let bestI = 0, bestLen = -1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const L = Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1]);
        if (L > bestLen) { bestLen = L; bestI = i; }
      }
      const jj = (bestI + 1) % n;
      let dx = ring[jj][0] - ring[bestI][0], dz = ring[jj][1] - ring[bestI][1];
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const half = bestLen * 0.22;
      const r0 = vert(m, c[0] - dx * half, y0 + rise, c[1] - dz * half);
      const r1 = vert(m, c[0] + dx * half, y0 + rise, c[1] + dz * half);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        // 各辺 → 稜線の近い端点へ。辺の中点がどちらの棟端に近いかで割り当てる
        const mx = (ring[i][0] + ring[j][0]) / 2, mz = (ring[i][1] + ring[j][1]) / 2;
        const d0 = (mx - (c[0] - dx * half)) ** 2 + (mz - (c[1] - dz * half)) ** 2;
        const d1 = (mx - (c[0] + dx * half)) ** 2 + (mz - (c[1] + dz * half)) ** 2;
        const apex = d0 <= d1 ? r0 : r1;
        if (ccw) tri(m, lo[i], apex, lo[j]); else tri(m, lo[i], lo[j], apex);
      }
      tri(m, r0, r1, r1);   // 稜線は面を持たない（退化三角形は後で除去）
      return [r0, r1];
    },
    // 線分列 → 帯状の低い壁（石垣・城域ライン）
    ribbon(m, line, widthM, y0, y1) {
      const half = widthM / 2;
      for (let i = 1; i < line.length; i++) {
        const [x0, z0] = line[i - 1], [x1, z1] = line[i];
        let dx = x1 - x0, dz = z1 - z0;
        const L = Math.hypot(dx, dz);
        if (L < 0.5) continue;
        dx /= L; dz /= L;
        const nx = -dz * half, nz = dx * half;
        const quad = [[x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x0 - nx, z0 - nz]];
        this.prism(m, quad, y0, y1, { cap: true });
      }
    },
  };
}
// 退化三角形（同一頂点を含む）を落とす
export function pruneDegenerate(buf) {
  for (const m of Object.keys(buf)) {
    const idx = buf[m].indices, out = [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      if (a !== b && b !== c && a !== c) out.push(a, b, c);
    }
    buf[m].indices = out;
  }
  return buf;
}

// ── 大阪城のモデルを組む ───────────────────────────────────────────────
export function buildOsakaCastle(scan) {
  const osmWays = scan.osm.ways;
  const keepWay = osmWays.find((w) => w.id === 'way/34619038');
  if (!keepWay) throw new Error('OSM way/34619038（天守閣）が scan に無い');
  const groundsWay = osmWays.find((w) => w.id === 'way/1550234049');
  const gates = osmWays.filter((w) => w.tags && w.tags.historic === 'city_gate');
  const keepBld = (scan.canonicalBuildings.keepCandidates || [])[0];
  if (!keepBld) throw new Error('canonical V2N に天守閣相当の棟が見つからない');

  const totalH = keepBld.heightM;                       // PLATEAU 実測（= 市内の他の建物と同じ高さの出所）
  const baseH = +(totalH * CASTLE_STYLE.baseRatio).toFixed(2);
  const towerH = +(totalH - baseH).toFixed(2);

  const keepRing = dedupeRing(keepWay.ring);            // OSM 実 footprint（天守閣）
  const c = centroidOf(keepRing);
  const B = createMeshBuilder();

  // 1) 天守台（石垣）: canonical V2N の実 footprint をそのまま使う。
  //    この棟は PLATEAU の LOD1 の箱で、天守台を含んだ外形（1,756m²）なので、天守台の平面として使える。
  //    canonical が取れないときだけ OSM 天守平面を basePad だけ広げて代用する。
  const baseRing = (keepBld.ring && keepBld.ring.length >= 3)
    ? dedupeRing(keepBld.ring)
    : scaleRing(keepRing, c, 1 + CASTLE_STYLE.basePad);
  const baseSource = (keepBld.ring && keepBld.ring.length >= 3) ? 'canonical-v2n-footprint' : 'osm-keep-scaled';
  B.prism('stone', baseRing, 0, baseH, { cap: true });

  // 2) 天守 5 層。各層 = 白壁の胴 + 軒（屋根）+ 軒先の金の縁取り
  const n = CASTLE_STYLE.tiers;
  const bodyTotal = towerH * (1 - CASTLE_STYLE.ridgeRise);
  const tierH = bodyTotal / n;
  const eaveDrop = totalH * CASTLE_STYLE.eaveDrop;
  const eaveThick = totalH * CASTLE_STYLE.eaveRise;
  let topRing = keepRing;
  for (let i = 0; i < n; i++) {
    const k0 = 1 + (CASTLE_STYLE.tierTopScale - 1) * (i / n);
    const k1 = 1 + (CASTLE_STYLE.tierTopScale - 1) * ((i + 1) / n);
    const y0 = baseH + tierH * i, y1 = baseH + tierH * (i + 1);
    const ringLo = scaleRing(keepRing, c, k0);
    const ringHi = scaleRing(keepRing, c, k1);
    // 胴（下すぼまり: 下の平面 → 上の平面）
    B.prism('wall', ringLo, y0, y0 + tierH * 0.62, { cap: false });
    B.prism('wall', ringHi, y0 + tierH * 0.62, y1, { cap: i === n - 1 });
    // 軒（屋根）。上の平面から外へ広がって少し垂れる
    const eaveOuter = B.eave('roof', ringHi, c, 1 + CASTLE_STYLE.eaveOut, y1, y1 - eaveDrop, eaveThick);
    // 軒先の金の縁取り（大阪城の特徴。薄い帯）
    B.prism('trim', eaveOuter, y1 - eaveDrop - eaveThick, y1 - eaveDrop - eaveThick * 0.45, { cap: false });
    topRing = ringHi;
  }
  // 3) 最上層の寄棟屋根 + 棟の金飾り
  const roofY = baseH + bodyTotal;
  B.hipRoof('roof', topRing, c, roofY, totalH * CASTLE_STYLE.ridgeRise);
  const ridgeRing = scaleRing(topRing, c, 0.18);
  B.prism('trim', ridgeRing, roofY + totalH * CASTLE_STYLE.ridgeRise * 0.72, roofY + totalH * CASTLE_STYLE.ridgeRise * 0.98, { cap: true });

  // 4) 城門 4 棟（OSM historic=city_gate の実 footprint）。高さタグが無いので既定値。
  const gateRecords = [];
  for (const g of gates) {
    const ring = dedupeRing(g.ring);
    if (ring.length < 3) continue;
    const gc = centroidOf(ring);
    B.prism('stone', ring, 0, CASTLE_STYLE.gateHeightM * 0.45, { cap: false });
    B.prism('wall', ring, CASTLE_STYLE.gateHeightM * 0.45, CASTLE_STYLE.gateHeightM, { cap: false });
    const eaveOuter = B.eave('roof', ring, gc, 1.22, CASTLE_STYLE.gateHeightM, CASTLE_STYLE.gateHeightM - 1.1, 0.5);
    B.hipRoof('roof', eaveOuter, gc, CASTLE_STYLE.gateHeightM - 0.6, CASTLE_STYLE.gateRoofRise);
    gateRecords.push({ osmId: g.id, name: g.name, areaM2: g.areaM2, vertices: ring.length });
  }

  // 5) 城域ライン（OSM historic=castle の範囲）。構造物ではなく「範囲」を示す低い帯。
  let outline = null;
  if (groundsWay) {
    const ring = dedupeRing(groundsWay.ring);
    const closed = ring.concat([ring[0]]);
    B.ribbon('outline', closed, CASTLE_STYLE.outlineWidthM, 0, CASTLE_STYLE.outlineHeightM);
    outline = { osmId: groundsWay.id, vertices: ring.length, areaM2: groundsWay.areaM2 };
  }

  pruneDegenerate(B.buf);
  const parts = MATERIALS.filter((m) => B.buf[m] && B.buf[m].indices.length).map((m) => ({
    material: m,
    triangleCount: B.buf[m].indices.length / 3,
    vertexCount: B.buf[m].positions.length / 3,
    positions: B.buf[m].positions.map((v) => +v.toFixed(3)),
    indices: B.buf[m].indices,
  }));

  const xs = [], zs = [], ys = [];
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) { xs.push(p.positions[i]); ys.push(p.positions[i + 1]); zs.push(p.positions[i + 2]); }
  const extent = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), maxY: Math.max(...ys) };

  return {
    landmarkId: 'osaka-castle',
    name: '大阪城',
    nameEn: 'Osaka Castle',
    anchor: { x: +c[0].toFixed(2), z: +c[1].toFixed(2) },
    extent: { minX: +extent.minX.toFixed(1), maxX: +extent.maxX.toFixed(1), minZ: +extent.minZ.toFixed(1), maxZ: +extent.maxZ.toFixed(1), maxY: +extent.maxY.toFixed(1) },
    sourceType: 'procedural-from-osm-and-plateau',
    // §7 出所。どの寸法がどこから来たかを配信データ自身に持たせる
    sources: {
      footprint: { source: 'osm', id: keepWay.id, vertices: keepRing.length, areaM2: keepWay.areaM2, tags: { height: keepWay.tags.height, 'building:levels': keepWay.tags['building:levels'], historic: keepWay.tags.historic } },
      stoneBaseFootprint: { source: baseSource, canonicalId: keepBld.canonicalId, vertices: baseRing.length, areaM2: keepBld.areaM2 },
      totalHeightM: { value: totalH, source: 'plateau-building（canonical V2N 実測 measuredHeight）', canonicalId: keepBld.canonicalId, crossCheckOsmHeightM: +keepWay.tags.height || null },
      gates: gateRecords.map((g) => ({ ...g, source: 'osm historic=city_gate' })),
      grounds: outline ? { ...outline, source: 'osm historic=castle' } : null,
      stylized: { ...CASTLE_STYLE, note: '縦方向の分割比・軒の出・屋根勾配・城門の高さは実測値ではない（リポジトリ内に該当データが無い）。平面形と全高は実データ。' },
    },
    heights: { totalM: totalH, stoneBaseM: baseH, towerM: towerH },
    // §3 切替条件
    swapRadiusM: 900,          // これより近いと LOD1 の天守箱を抑制して HD を出す
    visibleDistanceM: 2600,    // これより近いと HD を読み込む / 表示する
    // §6 picking: HD を押したとき既存 property card へ渡す canonicalId
    pickCanonicalId: keepBld.canonicalId,
    // §3 二重表示の抑制対象（canonical V2N の天守箱）
    suppressBuildingIds: [keepBld.canonicalId],
    suppressExtent: { minX: +(keepBld.bbox.minX - 2).toFixed(1), maxX: +(keepBld.bbox.maxX + 2).toFixed(1), minZ: +(keepBld.bbox.minZ - 2).toFixed(1), maxZ: +(keepBld.bbox.maxZ + 2).toFixed(1) },
    parts,
  };
}

export async function build() {
  if (!fs.existsSync(SCAN)) throw new Error('先に node tools/audit/osaka-castle-source-scan.js を実行してください: ' + SCAN);
  const scan = JSON.parse(fs.readFileSync(SCAN, 'utf-8'));
  const castle = buildOsakaCastle(scan);
  const doc = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '33E',
    projection: 'znorth-neg-v1（既存と同一。座標変換はしていない）',
    materials: MATERIALS,
    landmarks: [castle],
  };
  await writeJson(OUT_PUBLIC, doc);
  await writeJson(OUT_PROCESSED, doc);
  const report = {
    version: 1, generatedAt: doc.generatedAt, missionId: '33E',
    landmarks: doc.landmarks.map((l) => ({
      landmarkId: l.landmarkId, name: l.name, anchor: l.anchor, extent: l.extent,
      heights: l.heights, swapRadiusM: l.swapRadiusM, visibleDistanceM: l.visibleDistanceM,
      pickCanonicalId: l.pickCanonicalId, suppressBuildingIds: l.suppressBuildingIds,
      triangles: l.parts.reduce((s, p) => s + p.triangleCount, 0),
      vertices: l.parts.reduce((s, p) => s + p.vertexCount, 0),
      partsByMaterial: l.parts.map((p) => ({ material: p.material, triangles: p.triangleCount })),
      sources: l.sources,
    })),
    outputBytes: fs.statSync(OUT_PUBLIC).size,
  };
  await writeJson(OUT_REPORT, report);
  return report;
}

if (isMainModule(import.meta.url)) {
  build().then((r) => {
    for (const l of r.landmarks) {
      console.log('[landmark-models]', l.name, JSON.stringify({ tri: l.triangles, vtx: l.vertices, parts: l.partsByMaterial, heights: l.heights, extent: l.extent }));
      console.log('[landmark-models] pick', l.pickCanonicalId, 'suppress', l.suppressBuildingIds.length, 'gates', l.sources.gates.length);
    }
    console.log('[landmark-models] out', OUT_PUBLIC, r.outputBytes + ' bytes');
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
