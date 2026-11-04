#!/usr/bin/env node
// Mission 109: read-only fetch + integrity verification of stored PLATEAU 2025 archives for any subset of the 24 Osaka wards.
//   LIVECITY_3D_DATA_TOKEN=... node tools/mission109/fetch-verify.mjs --wards ALL|a,b --dest <EMPTY dir> --summary <file.json> [--skip-verified prev-summary.json]
//   offline: --from-archive-dir <dir> (no token). Wards are processed one by one; a failure in one ward never stops the others (exit 1 at the end).
// Reuses the reviewed Mission108 primitives (tar policy, safe extract, tileset/GLB integrity, release GET). Summary = counts/sha256/booleans only.
import fs from 'node:fs';
import path from 'node:path';
import * as L from '../mission108/lib.mjs';
import { parseWards, wardCodeOf } from './wards.mjs';

const a = process.argv.slice(2);
const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
if (!opt('dest') || !opt('summary') || !opt('wards')) { console.error('usage: --wards ALL|a,b --dest <empty dir> --summary <file> [--from-archive-dir dir] [--skip-verified prev.json]'); process.exit(64); }
let wards;
try { wards = parseWards(opt('wards')); } catch (e) { console.error('FAIL: ' + e.message); process.exit(64); }
const dest = path.resolve(opt('dest'));
const summaryPath = path.resolve(opt('summary'));
const fromDir = opt('from-archive-dir');
if (fs.existsSync(dest) && fs.readdirSync(dest).length) { console.error('FAIL: --dest must be empty (nothing is overwritten)'); process.exit(2); }
const token = process.env.LIVECITY_3D_DATA_TOKEN || '';
if (!fromDir && !token) { console.error('FAIL: LIVECITY_3D_DATA_TOKEN missing'); process.exit(3); }
const prev = opt('skip-verified') ? JSON.parse(fs.readFileSync(opt('skip-verified'), 'utf8')) : null;
const scrub = (e) => String((e && e.message) || e).replace(/Bearer\s+\S+/g, 'Bearer ***').replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '<path>').slice(0, 200);
fs.mkdirSync(dest, { recursive: true });
const arch = path.join(dest, '.archives');
fs.mkdirSync(arch);
const summary = { mission: 109, kind: 'private-archive-verify', source: fromDir ? 'local-archive-dir' : 'private-release', requested: wards, wards: {}, containsData: false, acceptance: false };
let failed = 0;
try {
  const release = fromDir ? null : await L.getRelease(token);
  if (release) summary.releaseAssetCount = (release.assets || []).length;
  for (const w of wards) {
    const r = { status: 'failed', wardCode: wardCodeOf(w) };
    try {
      const name = L.assetName(w);
      const file = path.join(arch, name);
      if (fromDir) fs.copyFileSync(path.join(path.resolve(fromDir), name), file, fs.constants.COPYFILE_EXCL);
      else {
        const m = (release.assets || []).filter((x) => x.name === name);
        if (m.length !== 1) throw new Error('expected exactly 1 asset named ' + name + ', found ' + m.length);
        r.assetSize = await L.downloadAsset(token, m[0], file);
      }
      r.archiveSha256 = L.sha256File(file);
      const pv = prev && prev.wards && prev.wards[w];
      // Flag only: the archive is still fully re-verified because QA needs the extracted tree.
      if (pv && pv.status === 'verified' && pv.archiveSha256 === r.archiveSha256) r.previouslyVerifiedSameSha = true;
      const wardDir = path.join(dest, w + '25');
      const tmp = path.join(dest, '.x-' + w);
      r.extract = L.safeExtract(file, tmp);
      fs.renameSync(L.findTilesetRoot(tmp), wardDir);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(file, { force: true }); // free disk early
      const v = L.verifyTilesetDir(wardDir);
      r.tilesetSha256 = L.sha256File(path.join(wardDir, 'tileset.json'));
      Object.assign(r, { tilesets: v.tilesets, glbs: v.glbs, glbBytes: v.glbBytes, sourceWardCode: v.sourceWardCode, integrityErrors: v.errors });
      let ok = v.ok;
      if (String(v.sourceWardCode) !== r.wardCode) { r.integrityErrors = [...r.integrityErrors, 'source.json wardCode != expected ' + r.wardCode].slice(0, 20); ok = false; }
      r.status = ok ? 'verified' : 'failed';
    } catch (e) { r.error = scrub(e); }
    if (r.status !== 'verified') failed++;
    summary.wards[w] = r;
  }
} catch (e) { summary.error = scrub(e); failed++; }
finally { fs.rmSync(arch, { recursive: true, force: true }); }
summary.verifiedWards = Object.keys(summary.wards).filter((w) => summary.wards[w].status === 'verified');
summary.failedWards = wards.filter((w) => !summary.verifiedWards.includes(w));
summary.allVerified = failed === 0 && summary.verifiedWards.length === wards.length;
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ allVerified: summary.allVerified, verified: summary.verifiedWards, failed: summary.failedWards }));
process.exit(summary.allVerified ? 0 : 1);
