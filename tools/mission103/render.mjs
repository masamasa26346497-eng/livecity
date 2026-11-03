#!/usr/bin/env node
// Mission 103: render all-wards.pinned.workflow.yml from template + steps part using the audited pin + hash closure. No network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashLines, PIN_SHA } from '../mission96/pin-audit.mjs';
const dir = path.dirname(fileURLToPath(import.meta.url));
const h = hashLines();
if (h.missing.length) throw new Error('missing: ' + h.missing.join(', '));
const body = h.lines.map((l) => '          ' + l).join('\n');
const steps = fs.readFileSync(path.join(dir, 'steps.part.yml'), 'utf8').replace(/\n$/, '').replace('@@HASHES@@', body);
const tpl = fs.readFileSync(path.join(dir, 'all-wards.pinned.workflow.template.yml'), 'utf8');
const out = tpl.split('@@STEPS@@').join(steps).replaceAll('@@PIN_SHA@@', PIN_SHA);
fs.writeFileSync(path.join(dir, 'all-wards.pinned.workflow.yml'), out);
console.log('rendered, files=' + h.lines.length + ' pin=' + PIN_SHA);
