import fs from 'node:fs';
import path from 'node:path';

const packageId = process.env.PLATEAU_PACKAGE_ID || 'plateau-27100-osaka-shi-2024';
const api = `https://www.geospatial.jp/ckan/api/3/action/package_show?id=${encodeURIComponent(packageId)}`;
const out = path.resolve('data/reports/mission36k-building-source-discovery.json');

const response = await fetch(api, {
  headers: { 'user-agent': 'LiveCity-Mission36K/1.0' },
  signal: AbortSignal.timeout(120000),
});
if (!response.ok) throw new Error(`CKAN package_show failed: HTTP ${response.status}`);
const payload = await response.json();
if (!payload?.success || !payload?.result) throw new Error('CKAN response is invalid');

const resources = (payload.result.resources || []).map((r) => ({
  id: r.id || null,
  name: r.name || null,
  format: r.format || null,
  size: Number(r.size) || null,
  url: r.url || null,
  created: r.created || null,
  lastModified: r.last_modified || null,
}));

function rankResource(r) {
  const s = `${r.name || ''} ${r.format || ''} ${r.url || ''}`.toLowerCase();
  let score = 0;
  if (s.includes('citygml')) score += 100;
  if (s.includes('3dtiles') || s.includes('3d tiles')) score += 90;
  if (s.includes('geojson')) score += 80;
  if (s.includes('building') || s.includes('bldg')) score += 35;
  if (s.includes('.zip')) score += 10;
  if (s.includes('lod1')) score += 25;
  if (s.includes('lod2')) score += 15;
  return score;
}

const relevant = resources
  .map((r) => ({ ...r, score: rankResource(r) }))
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score || (a.size || Infinity) - (b.size || Infinity));

const citygml = relevant.filter((r) => `${r.name || ''} ${r.format || ''} ${r.url || ''}`.toLowerCase().includes('citygml'));
const lightCandidates = relevant.filter((r) => {
  const s = `${r.name || ''} ${r.format || ''} ${r.url || ''}`.toLowerCase();
  return s.includes('3dtiles') || s.includes('3d tiles') || s.includes('geojson') || s.includes('lod1');
});

const report = {
  mission: '36K',
  packageId,
  packageTitle: payload.result.title || null,
  generatedAt: new Date().toISOString(),
  totalResources: resources.length,
  citygmlCandidates: citygml,
  lighterRuntimeCandidates: lightCandidates,
  relevantResources: relevant,
  recommendation: lightCandidates.length
    ? 'Prefer a runtime-friendly lighter resource when it preserves building footprint coverage; keep CityGML as the authoritative regeneration source.'
    : 'Use CityGML as authoritative source and generate Live City ward/tile runtime assets from it.',
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  packageId,
  totalResources: resources.length,
  citygmlCandidates: citygml.length,
  lighterRuntimeCandidates: lightCandidates.length,
  top: relevant.slice(0, 8).map((r) => ({ name: r.name, format: r.format, size: r.size, score: r.score })),
}, null, 2));
