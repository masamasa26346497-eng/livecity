// Mission 210: 公式 PLATEAU 2025 の tran:Road(lod1MultiSurface=道路区域ポリゴン)を、37G ビューアの区レイヤー
//   ext-3dtiles/<ward>/layers/roads.json (kind:'area' の面) に変換する。入力は mission79-run が取得済みの tran GML(work/tran)。
//   - 座標は建物と同一の znorth-neg-v1(config/areas/osaka-city.json の projection。原点・式は変更しない/補正オフセット無し)。
//   - 道路中心線ではなく「道路区域(車道+歩道を含む敷地)」。トンネル区間(uro:sectionType=6)は地表でないため除外。
//   - 区の重複を避けるため、リング重心が区ポリゴン内のものだけを採用(隣接区が共有するメッシュの二重出力を防ぐ)。
//   - 河川/水域: 今回の取得ロック(source-lock.json)に wtr が無く、公開データを取得できないため出力しない(捏造しない)。
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'livecity.mission210.roads-plateau-tran/1';
const r1 = (v) => Math.round(v * 10) / 10;
const project = (lat, lon, p) => [(lon - p.centerLon) * Math.cos(p.centerLat * Math.PI / 180) * p.metersPerDegree, -(lat - p.centerLat) * p.metersPerDegree];

function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; }
function pip(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (((r[i][1] > z) !== (r[j][1] > z)) && (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c;
  }
  return c;
}
export function makeWardTester(polygons) {
  return (x, z) => polygons.some((p) => pip(p.outer, x, z) && !(p.holes || []).some((h) => pip(h, x, z)));
}
/** 近接頂点の間引き(0.5m 未満)+0.1m 丸め+閉リング末尾点の除去。3 点未満になれば null。 */
export function simplifyRing(ring) {
  const out = [];
  for (const q of ring) { const p = [r1(q[0]), r1(q[1])]; const l = out[out.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= 0.5) out.push(p); }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.5) out.pop();
  return out.length >= 3 ? out : null;
}

/** tran GML 文字列 → [{ gmlId, tunnel, rings:[ring...] }]。axis 順序(lat,lon)を検証し、違えば例外(黙って誤配置しない)。 */
export function parseTranRoads(xml, projection) {
  const roads = [];
  const roadRe = /<tran:Road\b([^>]*)>([\s\S]*?)<\/tran:Road>/g;
  let m;
  while ((m = roadRe.exec(xml))) {
    const gmlId = (/gml:id="([^"]+)"/.exec(m[1]) || [])[1] || null;
    const body = m[2];
    const tunnel = /<uro:sectionType[^>]*>\s*6\s*<\/uro:sectionType>/.test(body);
    const lod1 = /<tran:lod1MultiSurface>([\s\S]*?)<\/tran:lod1MultiSurface>/.exec(body);
    if (!lod1) continue;
    const rings = [];
    const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let q;
    while ((q = re.exec(lod1[1]))) {
      const n = q[1].trim().split(/\s+/).map(Number);
      const dim = n.length % 3 === 0 ? 3 : 2;
      const ring = [];
      for (let i = 0; i + dim - 1 < n.length; i += dim) {
        if (!(n[i] > 20 && n[i] < 50 && n[i + 1] > 120 && n[i + 1] < 150)) throw new Error('tran axis order is not lat,lon');
        ring.push(project(n[i], n[i + 1], projection));
      }
      if (ring.length >= 4) rings.push(ring);
    }
    if (rings.length) roads.push({ gmlId, tunnel, rings });
  }
  return roads;
}

/**
 * tranDir の *_tran_*.gml を読み、区ポリゴン内の道路区域を outDir(= ext-3dtiles/<ward>/layers)に roads.json + layers-report.json で書く。
 * maxMB を超える場合は小さい面から落とし、truncated として report に記録する(黙って欠けない)。
 */
export function buildRoadLayer({ tranDir, projection, ward, wardCode, wardPolygons, outDir, maxMB = 20, minAreaM2 = 20 }) {
  if (!fs.existsSync(tranDir)) throw new Error('tran GML ディレクトリが無い: ' + tranDir);
  const files = fs.readdirSync(tranDir).filter((n) => /_tran_.*\.gml$/i.test(n)).sort();
  if (!files.length) throw new Error(ward + ': tran GML が 0 件');
  const inWard = makeWardTester(wardPolygons);
  const seen = new Set(); const feats = [];
  const st = { files: files.length, roads: 0, tunnelSkipped: 0, outsideWard: 0, tinySkipped: 0, duplicate: 0 };
  for (const f of files) {
    for (const rd of parseTranRoads(fs.readFileSync(path.join(tranDir, f), 'utf8'), projection)) {
      st.roads++;
      if (rd.tunnel) { st.tunnelSkipped++; continue; }
      if (rd.gmlId && seen.has(rd.gmlId)) { st.duplicate++; continue; }
      const outer = rd.rings[0];
      const c = outer.reduce((a, p) => [a[0] + p[0] / outer.length, a[1] + p[1] / outer.length], [0, 0]);
      if (!inWard(c[0], c[1])) { st.outsideWard++; continue; }
      if (rd.gmlId) seen.add(rd.gmlId);
      // 面ごとに 1 地物(複数リングは別地物。穴は表現しない: 道路区域の lod1 は外周のみ想定)
      rd.rings.forEach((ring, i) => {
        const p = simplifyRing(ring);
        if (!p) return;
        const area = Math.abs(ringArea(p));
        if (area < minAreaM2) { st.tinySkipped++; return; }
        feats.push({ id: (rd.gmlId || 'road') + (rd.rings.length > 1 ? '#' + i : ''), kind: 'area', p, a: Math.round(area) });
      });
    }
  }
  let truncated = null;
  const sizeOf = (arr) => JSON.stringify(arr).length / 1048576;
  let mb = sizeOf(feats);
  if (mb > maxMB) {
    feats.sort((x, y) => y.a - x.a);   // 大きい面を優先して残す
    let keep = feats.length; while (keep > 0 && sizeOf(feats.slice(0, keep)) > maxMB) keep = Math.floor(keep * 0.9);
    truncated = { before: feats.length, after: keep, limitMB: maxMB };
    feats.length = keep; mb = sizeOf(feats);
  }
  for (const f of feats) delete f.a;
  let b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const f of feats) for (const q of f.p) { b = { minX: Math.min(b.minX, q[0]), maxX: Math.max(b.maxX, q[0]), minZ: Math.min(b.minZ, q[1]), maxZ: Math.max(b.maxZ, q[1]) }; }
  if (!feats.length) throw new Error(ward + ': 道路区域が 0 件(tran の取得/区判定を確認。空レイヤーを成功扱いにしない)');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'roads.json'), JSON.stringify({
    layer: 'roads', mission: '210', schema: SCHEMA, ward, wardCode, coordinateConvention: 'znorth-neg-v1', coordinateSystem: 'local-meters',
    geometry: 'road-area-polygon (PLATEAU tran:Road lod1MultiSurface。道路中心線ではない)', clipped: 'ward-centroid', bboxLocal: b, count: feats.length, features: feats,
  }));
  const report = {
    mission: '210', schema: SCHEMA, ward, wardCode, coordinateConvention: 'znorth-neg-v1 (建物と同一の projection。補正オフセット無し)',
    source: { name: 'PLATEAU 2025 大阪市 CityGML tran:Road lod1MultiSurface', publisher: '国土交通省 Project PLATEAU', license: 'CC BY 4.0 互換(PLATEAU 利用規約。出典表示: 国土交通省 Project PLATEAU)' },
    layers: { roads: { status: 'ok', geometry: 'road-area', features: feats.length, sizeMB: +mb.toFixed(2), ...st, truncated },
              waterways: { status: 'not-delivered', reason: '取得ロックに wtr(水域)が無く公開データ未取得。旧 OSM(ODbL)は人のレビュー前のため配信しない' },
              parks: { status: 'not-delivered' }, railways: { status: 'not-delivered' } },
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'layers-report.json'), JSON.stringify(report));
  return report;
}
