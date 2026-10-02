#!/usr/bin/env node
// tools/audit/canonical-road-intersection-compare.js
// [Mission 31C2 §15] 交差点表現の before / after を同一地点で比較する。
//   before = OSM centerline + 幅推定の ribbon（31C までの canonical / 現行 RoadLayer と同じ作り方）
//   after  = PLATEAU tran 道路区域 polygon（31C2 の canonical）
//
//   ribbon 方式は交差点で「各道路の帯を重ねる」ため、同じ路面が何枚も重なって団子状に膨らむ。
//   その重なり量（overlap pair 数 / 重複面積）を実測し、polygon 方式でどれだけ解消したかを示す。
//   ※ 描画は切り替えない（§0）。ここで測るのは canonical geometry の性質のみ。
//
// 実行: node tools/audit/canonical-road-intersection-compare.js
// 出力: data/reports/canonical-road-intersection-compare.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { resolveRoadWidth } from '../lib/road-network.js';
import { buildRoadRibbon } from '../lib/road-ribbon.js';
import { polygonAreaM2 } from '../lib/canonical-geometry-schema.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const ROADS_DIR = P('public', 'map-data', 'osaka-city', 'roads');
const CANON_DIR = P('data', 'processed', 'osaka-city', 'canonical', 'roads');
const OUT = P('data', 'reports', 'canonical-road-intersection-compare.json');

// 比較対象の交差点サンプル（znorth-neg-v1 の局所座標。半径 120m の円内を見る）。
// 御堂筋・中央大通など、幹線同士が交わる代表地点を市内から散らして取る。
const SAMPLE_RADIUS_M = 120;
const SAMPLES = [
  { name: '梅田新道（御堂筋×国道2号）', x: -170, z: -9860 },
  { name: '本町（御堂筋×中央大通）', x: -180, z: -8180 },
  { name: '難波（御堂筋×千日前通）', x: -240, z: -6300 },
  { name: '天王寺（あべの筋×国道25号）', x: 430, z: -4560 },
  { name: '森ノ宮（中央大通×玉造筋）', x: 1600, z: -8180 },
  { name: '西九条（此花通×国道43号）', x: -3200, z: -9600 },
  { name: '長居（長居公園通×あびこ筋）', x: 300, z: -1200 },
  { name: '十三（十三筋×新御堂筋）', x: -1450, z: -12500 },
];

function loadRoadFeatures() {
  const byId = new Map();
  for (const f of fs.readdirSync(ROADS_DIR)) {
    if (!/^tile_.*\.json$/.test(f)) continue;
    const t = JSON.parse(fs.readFileSync(path.join(ROADS_DIR, f), 'utf-8'));
    for (const ft of (t.features || [])) {
      if (ft.kind !== 'line' || !Array.isArray(ft.p) || ft.p.length < 2) continue;
      if (!byId.has(ft.id)) byId.set(ft.id, ft);
    }
  }
  return [...byId.values()];
}

const bboxOfRing = (r) => { let a = 1e18, b = -1e18, c = 1e18, d = -1e18; for (const [x, z] of r) { if (x < a) a = x; if (x > b) b = x; if (z < c) c = z; if (z > d) d = z; } return { minX: a, maxX: b, minZ: c, maxZ: d }; };
const bboxHit = (a, b) => !(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ);
function pip(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
/** 重なり面積をモンテカルロではなく格子サンプリングで測る（1m 格子・決定的）。 */
function overlapStats(rings, sample) {
  const step = 1;
  const boxes = rings.map(bboxOfRing);
  let covered = 0, overlapped = 0, overlapPairs = 0;
  const seenPairs = new Set();
  for (let x = sample.x - SAMPLE_RADIUS_M; x <= sample.x + SAMPLE_RADIUS_M; x += step) {
    for (let z = sample.z - SAMPLE_RADIUS_M; z <= sample.z + SAMPLE_RADIUS_M; z += step) {
      if ((x - sample.x) ** 2 + (z - sample.z) ** 2 > SAMPLE_RADIUS_M ** 2) continue;
      const pt = [x, z];
      let hits = null;
      for (let i = 0; i < rings.length; i++) {
        if (pt[0] < boxes[i].minX || pt[0] > boxes[i].maxX || pt[1] < boxes[i].minZ || pt[1] > boxes[i].maxZ) continue;
        if (!pip(pt, rings[i])) continue;
        if (!hits) hits = [];
        hits.push(i);
      }
      if (!hits) continue;
      covered++;
      if (hits.length > 1) {
        overlapped++;
        for (let a = 0; a < hits.length; a++) for (let b = a + 1; b < hits.length; b++) {
          const k = hits[a] + ':' + hits[b];
          if (!seenPairs.has(k)) { seenPairs.add(k); overlapPairs++; }
        }
      }
    }
  }
  return { coveredAreaM2: covered, overlappedAreaM2: overlapped, overlapPairs, overlapRatio: covered ? +(overlapped / covered).toFixed(4) : 0 };
}

function loadCanonicalRings() {
  const out = [];
  const seen = new Set();
  for (const tf of fs.readdirSync(CANON_DIR).filter((f) => /^tile_.*\.json$/.test(f))) {
    const t = JSON.parse(fs.readFileSync(path.join(CANON_DIR, tf), 'utf-8'));
    for (const f of (t.features || [])) {
      if (seen.has(f.canonicalId)) continue;
      seen.add(f.canonicalId);
      const polys = f.geometryType === 'Polygon' ? [f.coordinates] : f.coordinates;
      for (const p of polys) if (p[0] && p[0].length >= 3) out.push({ ring: p[0], gs: f.source.geometrySource, bbox: f.bbox });
    }
  }
  return out;
}

async function main() {
  console.log('[intersection-compare] 読込中...');
  const roads = loadRoadFeatures();
  const canon = loadCanonicalRings();

  const rows = [];
  for (const s of SAMPLES) {
    const box = { minX: s.x - SAMPLE_RADIUS_M, maxX: s.x + SAMPLE_RADIUS_M, minZ: s.z - SAMPLE_RADIUS_M, maxZ: s.z + SAMPLE_RADIUS_M };
    // before: 同じ centerline から ribbon を作る（31C と同じ手順）
    const beforeRings = [];
    for (const r of roads) {
      const rb = bboxOfRing(r.p);
      if (!bboxHit(rb, box)) continue;
      const wr = resolveRoadWidth({ highway: r.highway, width: r.width, lanes: r.lanes, service: r.service, tracktype: r.tracktype });
      const rib = buildRoadRibbon(r.p, wr.width);
      if (!rib || !rib.ok || !rib.left || rib.left.length < 2) continue;
      const ring = [...rib.left, ...rib.right.slice().reverse()];
      if (ring.length >= 3) beforeRings.push(ring);
    }
    // after: canonical（PLATEAU polygon 中心）
    const afterRings = canon.filter((c) => bboxHit(c.bbox, box)).map((c) => c.ring);
    const afterPolygonShare = (() => {
      const inBox = canon.filter((c) => bboxHit(c.bbox, box));
      return inBox.length ? +(inBox.filter((c) => c.gs === 'plateau-tran-road').length / inBox.length).toFixed(3) : 0;
    })();

    const before = overlapStats(beforeRings, s);
    const after = overlapStats(afterRings, s);
    rows.push({
      name: s.name, x: s.x, z: s.z, radiusM: SAMPLE_RADIUS_M,
      before: { pieces: beforeRings.length, ...before },
      after: { pieces: afterRings.length, polygonShare: afterPolygonShare, ...after },
      overlapAreaReductionM2: before.overlappedAreaM2 - after.overlappedAreaM2,
      overlapRatioBefore: before.overlapRatio, overlapRatioAfter: after.overlapRatio,
      improved: after.overlapRatio < before.overlapRatio,
    });
    console.log('  ' + s.name + ': overlap ' + before.overlapRatio + ' → ' + after.overlapRatio
      + ' (重複面積 ' + before.overlappedAreaM2 + 'm² → ' + after.overlappedAreaM2 + 'm²)');
  }

  const sumBefore = rows.reduce((a, r) => a + r.before.overlappedAreaM2, 0);
  const sumAfter = rows.reduce((a, r) => a + r.after.overlappedAreaM2, 0);
  const improvedCount = rows.filter((r) => r.improved).length;
  const report = {
    generatedAt: new Date().toISOString(),
    method: '交差点サンプル半径' + SAMPLE_RADIUS_M + 'm を 1m 格子で走査し、道路面が 2 枚以上重なった面積を数える。'
      + 'before は OSM centerline+幅推定 ribbon（31C までの方式）、after は canonical roads（PLATEAU tran polygon 中心）。',
    sampleCount: rows.length,
    totalOverlapAreaBeforeM2: sumBefore,
    totalOverlapAreaAfterM2: sumAfter,
    overlapAreaReductionM2: sumBefore - sumAfter,
    overlapAreaReductionRatio: sumBefore ? +((sumBefore - sumAfter) / sumBefore).toFixed(4) : null,
    improvedSamples: improvedCount + '/' + rows.length,
    samples: rows,
    note: '重なりゼロが正解ではない（高架と地表が平面上で重なるのは正常）。ribbon 特有の「同一路面の多重帯」がどれだけ減ったかを見る指標。',
    RESULT: improvedCount >= Math.ceil(rows.length * 0.6) ? 'IMPROVED' : 'REVIEW',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, report);
  console.log('  合計重複面積 ' + sumBefore + 'm² → ' + sumAfter + 'm²（削減率 ' + report.overlapAreaReductionRatio + '）');
  console.log('保存: ' + toProjectRelativePath(OUT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[intersection-compare] 失敗:', e && e.stack || e); process.exit(1); });
