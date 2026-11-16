// Mission 106: 24-ward progress matrix (offline, read-only; writes only --out). Anything without evidence is "unverified".
//   node tools/mission106/progress-matrix.cjs [--out data/reports/mission106/progress-matrix.json]
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const J = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return null; } };
const gap = J('data/reports/mission105/acceptance-gap.json');
const e2e80 = J('data/reports/mission80-ward2025/e2e.json');
const e2e81 = J('data/reports/mission81/e2e.json');
const chain = require('./coord-chain.cjs').run();
// Per Mission103/104/105 docs: 21 stored privately (Mission103), ikuno/abeno/yodogawa added by Mission105 (owner-reported success, run 41762805159; not verifiable from this checkout).
const M105 = new Set(['ikuno', 'abeno', 'yodogawa']);
const U = 'unverified';
function headless(wardId) {
  const rows = [];
  for (const e of [e2e80, e2e81]) for (const w of (e && e.wards) || []) if (w.ward === wardId) rows.push({ file: e === e2e80 ? 'mission80-ward2025/e2e.json' : 'mission81/e2e.json', buildings: w.expectedBuildings || null, tilesets: w.tilesets || null });
  return rows;
}
function build() {
  const wards = (gap ? gap.wards : []).map((w) => {
    const c = chain.find((x) => x.wardId === w.wardId);
    const hl = headless(w.wardId);
    const st = (k) => (w.items[k] ? w.items[k].status : U);
    return {
      wardId: w.wardId, wardCode: w.wardCode,
      source2025Verified: st('sourceLock2025') === 'pass' ? 'pass' : U,
      privateStored: M105.has(w.wardId) ? 'owner-reported (Mission105 run 41762805159), not verifiable here' : 'per Mission103 docs (21 wards), not verifiable here',
      sha256: U,
      http200: st('http200') === 'pass' ? 'pass' : U,
      canvasPixelDelta: st('pixelDiff') === 'pass' ? 'pass' : U,
      withinWardPolygons: st('n03Inside') === 'pass' ? 'pass' : U,
      roadWaterAlignment: st('roadWater') === 'pass' ? 'pass' : U,
      coordChainFixture: c ? { status: 'pass-offline', maxAbsEastErrM: +c.maxAbsEastErrM.toFixed(3), maxAbsNorthErrM: +c.maxAbsNorthErrM.toFixed(3), maxAbsUpErrM: +c.maxAbsUpErrM.toFixed(3) } : U,
      headlessEvidence: hl.length ? { class: 'headless-software-render, NOT acceptance', sources: hl.map((h) => h.file) } : 'none',
      browserCiAccepted: false,
      ownerDeviceAccepted: false,
    };
  });
  return { mission: '106', generatedFrom: ['mission105/acceptance-gap.json', 'mission80-ward2025/e2e.json', 'mission81/e2e.json', 'coord-chain fixture'], wardsEvaluated: wards.length, browserCiAccepted: 0, ownerDeviceAccepted: 0, wards };
}
module.exports = { build };
if (require.main === module) {
  const i = process.argv.indexOf('--out'), m = build();
  if (i > 0) { fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true }); fs.writeFileSync(process.argv[i + 1], JSON.stringify(m, null, 1) + '\n'); }
  else console.log(JSON.stringify(m, null, 1));
}
