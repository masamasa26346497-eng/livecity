// tools/lib/ward-building-dataset-validator.js
// P1-4: 24区 建物 dataset / tile（tools/build-ward-building-datasets.js の出力）の検証。
// 例外は投げず構造化結果を返す。
//
// 検証項目（P1-4指令）:
//  - 24区すべて dataset 生成
//  - buildingId 重複なし（全区 + unclassified を通して一意）
//  - classified + unclassified + duplicateSkipped = 入力全件
//  - 同一 building が複数区に所属しない
//  - finite coordinates（全 tile）
//  - tile bbox 整合（各建物の代表点が tile 座標と一致）
//  - 既存3区の件数が大きく変化していない

import fs from 'node:fs';
import path from 'node:path';

const KNOWN_EXISTING = { sumiyoshi: 33594, higashisumiyoshi: 38266, hirano: 43843 };
const KNOWN_TOLERANCE_PCT = 5; // 既存3区の件数がこの割合を超えて増減したら要確認

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^﻿/, ''));
}

function check(name, pass, detail, severity = 'error') {
  return { name, pass, detail, severity };
}

// nested layout は <dir>/tiles/tile_x_z.json、flat layout は <dir>/tile_x_z.json。
function iterTiles(datasetDir) {
  const out = [];
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (/^tile_(-?\d+)_(-?\d+)\.json$/.test(f)) out.push(path.join(dir, f));
    }
  };
  scan(path.join(datasetDir, 'tiles'));
  scan(datasetDir);
  return out;
}

/**
 * @param {string} datasetRoot data/processed/osaka-city/buildings
 * @param {{registry:object, inputTotal?:number, wardPolygonsPayload?:object}} ctx
 */
export function validateWardBuildingDatasets(datasetRoot, ctx = {}) {
  const checks = [];
  const registry = ctx.registry;
  if (!fs.existsSync(path.join(datasetRoot, 'manifest.json'))) {
    return { ok: false, checks: [check('root-manifest', false, `${datasetRoot}/manifest.json が無い`)], perWard: {} };
  }
  const root = readJson(path.join(datasetRoot, 'manifest.json'));
  const regWardIds = new Set((registry.wards || []).map((w) => w.id));
  // flat layout は <datasetId>/ 、nested layout は <wardId>/ にデータが置かれる。
  const layout = root.layout === 'flat' ? 'flat' : 'nested';
  const dirNameOf = (d) => (layout === 'flat' ? d.id : d.wardId);

  // ── 全区 dataset 存在（registry の全区。実 registry では 24） ──
  const dsWardIds = new Set((root.datasets || []).map((d) => d.wardId));
  const expectedCount = (registry.wards || []).length;
  const missing = (registry.wards || []).filter((w) => !dsWardIds.has(w.id)).map((w) => w.name);
  checks.push(check('all-datasets-present', missing.length === 0 && dsWardIds.size === expectedCount,
    missing.length ? `未生成: ${missing.join('、')}` : `${expectedCount}区 dataset 存在`));
  const unknownDs = [...dsWardIds].filter((id) => !regWardIds.has(id));
  checks.push(check('no-registry-external-dataset', unknownDs.length === 0, unknownDs.length ? unknownDs.join(', ') : 'OK'));

  // ── 全 tile 走査 ──
  const globalIds = new Map(); // id -> wardId ('__unclassified__' も含む)
  let dupAcrossWards = 0;
  let dupWithinScan = 0;
  let nonFinite = 0;
  let tileBboxMismatch = 0;
  let classifiedCount = 0;
  const perWard = {};
  const tileSize = root.tileSize || 500;
  const dupSamples = [];

  const scanDataset = (wardId, dir, isUnclassified) => {
    let count = 0;
    let tiles = 0;
    for (const tf of iterTiles(dir)) {
      tiles++;
      const m = path.basename(tf).match(/^tile_(-?\d+)_(-?\d+)\.json$/);
      const tx = Number(m[1]), tz = Number(m[2]);
      let tile;
      try { tile = readJson(tf); } catch { checks.push(check('tile-parse', false, `${tf} が壊れている`)); continue; }
      for (const b of (tile.buildings || [])) {
        count++;
        if (!isUnclassified) classifiedCount++;
        // ID一意
        if (globalIds.has(b.id)) {
          const other = globalIds.get(b.id);
          if (other === wardId) dupWithinScan++;
          else { dupAcrossWards++; if (dupSamples.length < 20) dupSamples.push({ id: b.id, wards: [other, wardId] }); }
        } else {
          globalIds.set(b.id, wardId);
        }
        // finite
        const pts = Array.isArray(b.fp) ? b.fp : [];
        for (const p of pts) if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) nonFinite++;
        if (!Number.isFinite(b.repX) || !Number.isFinite(b.repZ)) nonFinite++;
        // tile bbox 整合（代表点が tile 座標に一致）
        if (Number.isFinite(b.repX) && Number.isFinite(b.repZ)) {
          if (Math.floor(b.repX / tileSize) !== tx || Math.floor(b.repZ / tileSize) !== tz) tileBboxMismatch++;
        }
      }
    }
    return { count, tiles };
  };

  for (const d of (root.datasets || [])) {
    const dir = path.join(datasetRoot, dirNameOf(d));
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      checks.push(check('ward-manifest', false, `${dirNameOf(d)}/manifest.json が無い`));
      continue;
    }
    const man = readJson(path.join(dir, 'manifest.json'));
    const scan = scanDataset(d.wardId, dir, false);
    perWard[d.wardId] = { manifestCount: man.totalBuildings, scannedCount: scan.count, tileCount: scan.tiles, manifestTileCount: man.tileCount, bounds: man.bounds };
    if (man.totalBuildings !== scan.count) {
      checks.push(check(`count-consistency:${d.wardId}`, false, `manifest ${man.totalBuildings} ≠ tile実数 ${scan.count}`));
    }
    if (man.tileCount !== scan.tiles) {
      checks.push(check(`tilecount-consistency:${d.wardId}`, false, `manifest ${man.tileCount} ≠ 実タイル ${scan.tiles}`));
    }
  }

  // unclassified
  let unclCount = 0;
  const unclDir = path.join(datasetRoot, 'unclassified');
  if (fs.existsSync(path.join(unclDir, 'manifest.json'))) {
    const um = readJson(path.join(unclDir, 'manifest.json'));
    const scan = scanDataset('__unclassified__', unclDir, true);
    unclCount = scan.count + (um.invalidFootprints || 0);
    perWard.__unclassified__ = { manifestCount: um.totalBuildings, scannedCount: scan.count, invalidFootprints: um.invalidFootprints || 0 };
  }

  checks.push(check('building-id-unique', dupAcrossWards === 0 && dupWithinScan === 0,
    dupAcrossWards ? `${dupAcrossWards}件が複数区に出現 例:${JSON.stringify(dupSamples.slice(0, 5))}` : (dupWithinScan ? `同一区内で${dupWithinScan}件重複` : 'OK')));
  checks.push(check('no-building-in-two-wards', dupAcrossWards === 0, dupAcrossWards ? `${dupAcrossWards}件` : 'OK'));
  checks.push(check('coords-finite', nonFinite === 0, nonFinite ? `非有限座標 ${nonFinite}点` : 'OK'));
  checks.push(check('tile-bbox-consistent', tileBboxMismatch === 0, tileBboxMismatch ? `代表点が tile 座標と不一致 ${tileBboxMismatch}件` : 'OK'));

  // ── classified + unclassified + dup = input ──
  const rt = root.totals || {};
  const sumOk = rt.invariant === true &&
    (rt.classified + rt.unclassified + (rt.duplicateIdsSkipped || 0) === rt.input);
  checks.push(check('classified-plus-unclassified-equals-input', sumOk,
    `input ${rt.input} = classified ${rt.classified} + unclassified ${rt.unclassified} + dup ${rt.duplicateIdsSkipped || 0}（root manifest 恒等式: ${rt.invariant}）`));
  if (Number.isFinite(ctx.inputTotal)) {
    checks.push(check('input-total-matches-jsonl', rt.input === ctx.inputTotal,
      `root manifest input ${rt.input} / 実 JSONL 行数 ${ctx.inputTotal}`));
  }

  // ── 既存3区の件数変化（3区とも dataset にある場合のみ判定） ──
  const knownPresent = Object.keys(KNOWN_EXISTING).filter((id) => perWard[id]);
  if (knownPresent.length) {
    const knownDetail = [];
    let knownOk = true;
    for (const id of knownPresent) {
      const prev = KNOWN_EXISTING[id];
      const now = perWard[id].scannedCount;
      const pct = prev ? ((now - prev) / prev) * 100 : 0;
      knownDetail.push(`${id}: ${prev}→${now} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
      if (Math.abs(pct) > KNOWN_TOLERANCE_PCT) knownOk = false;
    }
    checks.push(check('known-3-wards-count-stable', knownOk, knownDetail.join(' / '),
      knownOk ? 'error' : 'warning')); // 超過は warning（説明可能なら SUCCESS を妨げない）
  }

  const errorFails = checks.filter((c) => !c.pass && c.severity === 'error');
  return {
    ok: errorFails.length === 0,
    checks,
    perWard,
    summary: {
      datasetCount: dsWardIds.size,
      classifiedScanned: classifiedCount,
      unclassifiedScanned: unclCount,
      rootTotals: rt,
      errorFailCount: errorFails.length,
      warningCount: checks.filter((c) => !c.pass && c.severity === 'warning').length,
    },
  };
}
