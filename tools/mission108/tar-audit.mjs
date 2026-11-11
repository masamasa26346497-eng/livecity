#!/usr/bin/env node
// Mission 113: offline, read-only, NAME-FREE audit of a .tar.gz. Prints counts / formats / extension histogram only
// (no entry names, no data, no coordinates), so the output is safe to paste into a PR comment.
//   node tools/mission108/tar-audit.mjs <archive.tar.gz>
import path from 'node:path';
import fs from 'node:fs';
import { auditTarGz } from './tar-reader.mjs';
import { sha256File } from './lib.mjs';

const f = process.argv[2];
if (!f) { console.error('usage: tar-audit.mjs <archive.tar.gz>'); process.exitCode = 64; }
else {
  const out = { node: process.version, platform: process.platform, bytes: null, sha256: null };
  try {
    const file = path.resolve(f);
    out.bytes = fs.statSync(file).size; out.sha256 = sha256File(file);
    const head = Buffer.alloc(2); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    out.gzipMagic = head.toString('hex');
    out.audit = await auditTarGz(file);
    out.ok = true;
  } catch (e) { out.ok = false; out.error = String(e && e.message || e).slice(0, 300); out.code = e && e.code || null; }
  console.log(JSON.stringify(out, null, 1));
  process.exitCode = out.ok ? 0 : 1;
}
