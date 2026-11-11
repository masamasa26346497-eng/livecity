#!/usr/bin/env node
// Mission 108: read-only fetch + integrity verification of stored PLATEAU 2025 archives (nishi / fukushima / yodogawa).
//   LIVECITY_3D_DATA_TOKEN=... node tools/mission108/fetch-verify.mjs --wards nishi,fukushima,yodogawa --dest <EMPTY dir> --summary <file.json>
//   node tools/mission108/fetch-verify.mjs --wards nishi --from-archive-dir <dir> --dest <EMPTY dir> --summary s.json   (no token, offline)
// Output layout: <dest>/<ward>25/... (what ?ext=<ward>25 reads). Archives live in <dest>/.archives only while running and are deleted.
// The summary holds counts / sha256 / booleans only: no data, no token.
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
if (!opt('dest') || !opt('summary') || !opt('wards')) { console.error('usage: --wards a,b --dest <empty dir> --summary <file> [--from-archive-dir dir]'); process.exit(64); }
let wards;
try { wards = L.validateWards(opt('wards').split(',').filter(Boolean)); } catch (e) { console.error('FAIL: ' + e.message); process.exit(64); }
const dest = path.resolve(opt('dest'));
const summaryPath = path.resolve(opt('summary'));
const fromDir = opt('from-archive-dir');
if (fs.existsSync(dest) && fs.readdirSync(dest).length) { console.error('FAIL: --dest must be empty (nothing is overwritten)'); process.exit(2); }
const token = process.env.LIVECITY_3D_DATA_TOKEN || '';
if (!fromDir && !token) { console.error('FAIL: LIVECITY_3D_DATA_TOKEN missing'); process.exit(3); }
fs.mkdirSync(dest, { recursive: true });
const arch = path.join(dest, '.archives');
fs.mkdirSync(arch);
const summary = { mission: 108, kind: 'private-archive-verify', source: fromDir ? 'local-archive-dir' : 'private-release', wards: {}, containsData: false };
const safeMsg = (e) => String(e && e.message || e).replace(/Bearer\s+\S+/g, 'Bearer ***').replace(/\b(?:gh[pousr]_|github_pat_)\w+/g, '***').slice(0, 200);
let exit = 0;
try {
  const release = fromDir ? null : await L.getRelease(token);
  if (release) summary.releaseAssetCount = (release.assets || []).length;
  for (const w of wards) {
    const r = { status: 'failed' };
    try {
      const name = L.assetName(w);
      const file = path.join(arch, name);
      if (fromDir) fs.copyFileSync(path.join(path.resolve(fromDir), name), file, fs.constants.COPYFILE_EXCL);
      else {
        const m = (release.assets || []).filter((x) => x.name === name);
        if (m.length !== 1) throw new L.FetchDiag('asset-not-found', 'release', null, 'found ' + m.length);
        r.assetSize = await L.downloadAsset(token, m[0], file);
      }
      r.archiveSha256 = L.sha256File(file);
      r.audit = await L.auditTarGz(file); // name-free counts; throws a coded TarError before anything is written
      const wardDir = path.join(dest, w + '25');
      const tmp = path.join(dest, '.x-' + w);
      r.extract = await L.safeExtract(file, tmp);
      fs.renameSync(L.findTilesetRoot(tmp), wardDir);
      fs.rmSync(tmp, { recursive: true, force: true });
      const v = L.verifyTilesetDir(wardDir);
      r.tilesetSha256 = L.sha256File(path.join(wardDir, 'tileset.json'));
      Object.assign(r, { tilesets: v.tilesets, glbs: v.glbs, glbBytes: v.glbBytes, sourceWardCode: v.sourceWardCode, integrityErrors: v.errors });
      r.status = v.ok ? 'verified' : 'failed';
    } catch (e) { r.error = safeMsg(e); r.diagnostic = L.diagnose(e); console.error('FAIL(' + w + '): ' + r.diagnostic.message + '\n  対処: ' + r.diagnostic.remediation); }
    if (r.status !== 'verified') exit = 1;
    summary.wards[w] = r;
  }
} catch (e) {
  summary.error = safeMsg(e);
  summary.diagnostic = L.diagnose(e);
  console.error('FAIL: ' + summary.diagnostic.message + '\n  対処: ' + summary.diagnostic.remediation + '\n  詳細(秘密情報・応答本文は含まれません): ' + summaryPath);
  exit = 1;
} finally {
  // Mission 113: on failure KEEP the downloaded archives so they can be audited offline (no re-download):
  //   node tools/mission108/tar-audit.mjs <dest>/.archives/plateau2025-<ward>.tar.gz
  if (exit === 0) fs.rmSync(arch, { recursive: true, force: true });
  else console.error('Archives kept for offline audit (no re-download needed): ' + arch);
}
summary.allVerified = exit === 0;
// ASCII-safe JSON (non-ASCII escaped as \uXXXX) so Windows PowerShell 5.1 parses it regardless of BOM/codepage.
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 1).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
console.log(JSON.stringify({ allVerified: summary.allVerified, wards: Object.fromEntries(Object.entries(summary.wards).map(([k, v]) => [k, v.status])) }));
// No process.exit(): on Windows Node 24 it can tear down live undici/libuv handles (UV_HANDLE_CLOSING assertion). Let the loop drain.
process.exitCode = exit;
