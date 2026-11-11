#!/usr/bin/env node
// Mission 101: render tools/mission101/persist-wards.pinned.workflow.yml from the template using the audited pin + hash closure.
// Reuses tools/mission96/pin-audit.mjs (closure/hashes). Writes only that one file. No network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashLines, PIN_SHA } from '../mission96/pin-audit.mjs';
const dir = path.dirname(fileURLToPath(import.meta.url));
const h = hashLines();
if (h.missing.length) throw new Error('missing: ' + h.missing.join(', '));
const tpl = fs.readFileSync(path.join(dir, 'persist-wards.pinned.workflow.template.yml'), 'utf8');
const body = h.lines.map((l) => '          ' + l).join('\n');
fs.writeFileSync(path.join(dir, 'persist-wards.pinned.workflow.yml'), tpl.replaceAll('@@PIN_SHA@@', PIN_SHA).replace('@@HASHES@@', body));
console.log('rendered, files=' + h.lines.length + ' pin=' + PIN_SHA);
