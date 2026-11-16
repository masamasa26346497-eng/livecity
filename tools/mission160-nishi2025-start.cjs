#!/usr/bin/env node
// Mission 160: one command. Static-audit the locally built Nishi 2025 tileset, then serve it read-only on 127.0.0.1 only.
//   node tools/mission160-nishi2025-start.cjs --root temp/mission79 [--port 8137]      (<root>/nishi-2025/tileset.json)
// Nothing is copied, moved, re-fetched or written inside <root>. Reports go to data/reports/mission160-nishi2025/.
'use strict';
const fs = require('fs'), path = require('path');
const { audit } = require('./mission160/nishi2025-audit.cjs');
const { makeServer } = require('./mission40f-serve-local.cjs');
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const rootArg = get('--root') || path.join('temp', 'mission79');
const root = path.resolve(rootArg), port = +(get('--port') || 8137), NAME = 'nishi-2025';
if (!fs.existsSync(path.join(root, NAME, 'tileset.json'))) {
  console.error('not found: ' + path.join(root, NAME, 'tileset.json'));
  console.error('Build it first on your PC (read-only source fetch): node tools/mission79-run.mjs --ward nishi');
  process.exit(2);
}
const r = audit(path.join(root, NAME));
const out = path.join('data', 'reports', 'mission160-nishi2025', 'static-audit-local.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(r, null, 1));
for (const c of r.checks) console.log((c.ok ? 'OK   ' : 'FAIL ') + c.id);
console.log('static audit: ' + (r.pass ? 'PASS' : 'FAIL') + ' -> ' + out + '  (file-level only; not a browser acceptance)');
if (!r.pass && !a.includes('--serve-anyway')) { console.error('audit failed; not serving (use --serve-anyway to inspect anyway)'); process.exit(1); }
makeServer({ publicDir: path.join(__dirname, '..', 'public'), extDir: root }).listen(port, '127.0.0.1', () => {
  console.log('serving 127.0.0.1:' + port + ' (read-only, loopback only)');
  console.log('open: http://127.0.0.1:' + port + '/mission37g-osaka-24ward-mvp.html?ext=' + NAME + '&bw=27106&qa=1&fac=0');
  console.log('browser acceptance (another shell): node tools/experiments/mission160_nishi2025_browser.mjs --root ' + rootArg);
});
