// Mission218F: qa.json の sweep.rows から ward-border の実座標を "lat lon" 行で出力する(読み取りのみ)。
//   node qa-border-points.mjs <qa.json> [N=2]   → 重複(同一 ward ペア)を除いた先頭 N 点。無ければ exit 3(握りつぶさない)
import fs from 'node:fs';
export function borderPoints(qa, n = 2) {
  const seen = new Set(), out = [];
  for (const r of (qa && qa.sweep && qa.sweep.rows) || []) {
    if (r.kind !== 'ward-border' || !Number.isFinite(r.lat) || !Number.isFinite(r.lon) || seen.has(r.ward)) continue;
    seen.add(r.ward); out.push({ ward: r.ward, lat: r.lat, lon: r.lon });
    if (out.length >= n) break;
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [f, n] = process.argv.slice(2); let qa = null; try { qa = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const pts = borderPoints(qa, Number(n) || 2);
  if (!pts.length) { console.error('ward-border 行なし(sweep が区境に到達していない)'); process.exit(3); }
  for (const p of pts) console.log(`${p.lat} ${p.lon} ${p.ward}`);
}
