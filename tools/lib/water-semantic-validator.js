// tools/lib/water-semantic-validator.js
// P1-6F: 水域 area フィーチャの「意味的」健全性チェック。earcut の area 比だけでは
//   「独立 outer の誤連結」「暗黙 closure」「疎ノードで巨大三角形になるポリゴン」を検出できない。
//
// ここでは tile 出力（build-city-layer-tiles.js の feature。source metadata つき）を対象に:
//   - outer ring の最大辺長（wrap 辺を含む）> maxEdgeWarnM        → WARN
//   - 最大辺 / 中央値辺 > edgeRatioWarn                            → WARN
//   - relation 由来で outerWayCount >> outerRingCount かつ巨大bbox → WARN（独立 outer 誤連結の疑い）
//   - 点が3未満・非有限                                            → ERROR
// を返す。WARN は描画を止めない（実データの大河川は OSM 側が粗いため WARN が出るのが正しい）。

function ringEdges(ring) {
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    edges.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return edges;
}
function ringBbox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ, diag: Math.hypot(maxX - minX, maxZ - minZ) };
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a / 2);
}

export function analyzeWaterFeature(f) {
  const outer = f.p || [];
  const edges = ringEdges(outer);
  edges.sort((x, y) => x - y);
  const median = edges.length ? edges[Math.floor(edges.length / 2)] : 0;
  const maxEdge = edges.length ? edges[edges.length - 1] : 0;
  const bb = ringBbox(outer);
  let area = ringArea(outer);
  for (const h of (f.holes || [])) area -= ringArea(h);
  return {
    points: outer.length,
    holes: (f.holes || []).length,
    maxEdge,
    medianEdge: median,
    edgeRatio: median > 0 ? maxEdge / median : 0,
    bboxDiag: bb.diag,
    area: Math.max(area, 0),
  };
}

export function validateWaterSemantics(features, opts = {}) {
  const maxEdgeWarnM = opts.maxEdgeWarnM ?? 1000;
  const edgeRatioWarn = opts.edgeRatioWarn ?? 20;
  const mergeBboxWarnM = opts.mergeBboxWarnM ?? 4000;

  const warnings = [];
  const errors = [];
  let areaCount = 0;

  for (const f of features) {
    if (f.kind !== 'area') continue;
    areaCount++;
    if (!Array.isArray(f.p) || f.p.length < 3 || f.p.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
      errors.push({ id: f.id, name: f.name || '', reason: 'degenerate-or-nonfinite-ring' });
      continue;
    }
    const a = analyzeWaterFeature(f);
    const base = { id: f.id, name: f.name || '', source: f.source || null, maxEdge: Math.round(a.maxEdge), edgeRatio: +a.edgeRatio.toFixed(1), bboxDiag: Math.round(a.bboxDiag), points: a.points };

    if (a.maxEdge > maxEdgeWarnM) warnings.push({ ...base, reason: `maxEdge ${Math.round(a.maxEdge)}m > ${maxEdgeWarnM}m（疎ノードの巨大三角形になりうる）` });
    else if (a.edgeRatio > edgeRatioWarn) warnings.push({ ...base, reason: `edgeRatio ${a.edgeRatio.toFixed(1)} > ${edgeRatioWarn}` });

    const src = f.source;
    if (src && src.type === 'relation' && src.relationOuterWayCount >= 3 && src.relationOuterRingCount === 1 && a.bboxDiag > mergeBboxWarnM) {
      warnings.push({ ...base, reason: `relation ${src.id}: ${src.relationOuterWayCount} outer ways → 1 ring, bboxDiag ${Math.round(a.bboxDiag)}m（独立 outer 誤連結の可能性。要目視）` });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: { areaFeatures: areaCount, errorCount: errors.length, warnCount: warnings.length },
  };
}
