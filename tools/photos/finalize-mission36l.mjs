#!/usr/bin/env node
// Mission 36L local finalizer.
// Runs the full local building-facility index build, then the conservative
// exact building -> VERIFIED Google Place preparation and prints a compact summary.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUILDING_INDEX, DEFAULT_OUT } from './build-building-google-place-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPORT = path.join(ROOT, 'data', 'reports', 'mission36l-building-photo-linking', 'building-google-place-index.json');
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');

function help() {
  console.log(`Mission 36L finalizer\n\nUsage:\n  node tools/photos/finalize-mission36l.mjs [--skip-building-index]\n\nOptions:\n  --skip-building-index  Reuse an existing full building-facility index instead of rebuilding it.\n  --help                 Show this help.\n`);
}

function runNode(args, label) {
  console.log(`[36L finalizer] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

export function summarizeFinalOutput() {
  if (!fs.existsSync(DEFAULT_OUT)) {
    throw new Error(`final exact linkage output is missing: ${rel(DEFAULT_OUT)}`);
  }
  const doc = readJson(DEFAULT_OUT);
  const counts = doc?.counts || {};
  const records = Array.isArray(doc?.records) ? doc.records : [];
  if (records.length !== Number(counts.linkedBuildings ?? records.length)) {
    throw new Error(`linkedBuildings count mismatch: records=${records.length}, counts=${counts.linkedBuildings}`);
  }
  if (doc?.policy?.exactOsmSourceIdentityOnly !== true || doc?.policy?.verifiedGooglePlaceOnly !== true) {
    throw new Error('final output does not satisfy Mission 36L exact/VERIFIED policy');
  }
  return {
    linkedBuildings: records.length,
    buildingsScanned: counts.buildingsScanned ?? null,
    rejectedAmbiguous: counts.rejectedAmbiguous ?? 0,
    noExactSource: counts.noExactSource ?? 0,
    exactSourceWithoutVerifiedPlace: counts.exactSourceWithoutVerifiedPlace ?? 0,
  };
}

export function finalizeMission36L({ skipBuildingIndex = false } = {}) {
  if (!skipBuildingIndex) {
    runNode(['tools/build-building-facility-index.js'], 'build full building-facility index');
  } else if (!fs.existsSync(DEFAULT_BUILDING_INDEX)) {
    throw new Error(`--skip-building-index requested but index is missing: ${rel(DEFAULT_BUILDING_INDEX)}`);
  }

  runNode(['tools/photos/prepare-mission36l-building-photo-linking.mjs'], 'build and validate exact building -> Google Place index');

  const summary = summarizeFinalOutput();
  console.log('[36L finalizer] COMPLETE');
  console.log(`[36L finalizer] output: ${rel(DEFAULT_OUT)}`);
  console.log(`[36L finalizer] report: ${rel(REPORT)}`);
  console.log(`[36L finalizer] linked buildings: ${summary.linkedBuildings}`);
  console.log(`[36L finalizer] buildings scanned: ${summary.buildingsScanned}`);
  console.log(`[36L finalizer] rejected ambiguous: ${summary.rejectedAmbiguous}`);
  console.log(`[36L finalizer] no exact source: ${summary.noExactSource}`);
  console.log(`[36L finalizer] exact source without VERIFIED Place: ${summary.exactSourceWithoutVerifiedPlace}`);
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    help();
  } else {
    try {
      finalizeMission36L({ skipBuildingIndex: args.has('--skip-building-index') });
    } catch (err) {
      console.error('[36L finalizer]', err?.stack || String(err));
      process.exitCode = 2;
    }
  }
}
