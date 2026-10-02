// tools/lib/ward-mode-integration-validator.js
// P1-5: 24区 建物 dataset を Live City 本体 HTML(ward-ux-v1) の Ward Mode へ接続した状態の検証。
// 例外は投げず構造化結果を返す。
//
// 検証（P1-5指令 #8）:
//  - 24区すべて manifest 存在 / tileCount > 0 / manifest buildingCount == tile 合計
//  - registry wardId ↔ dataset 一致（wardId/code/datasetId/name）
//  - servable path（public/map-data/osaka-city/buildings）配下に配置されている
//  - HTML WARD_DEFS が registry と一致し、24区とも dataReady:true
//  - HTML BUILDING_TILE_CONFIG.basePath / rootManifest が servable path を指す
//  - N03 区境界 polygon(ward-classification-polygons.json) が servable path に配置されている

import fs from 'node:fs';
import path from 'node:path';
import { validateWardBuildingDatasets } from './ward-building-dataset-validator.js';

function check(name, pass, detail, severity = 'error') {
  return { name, pass, detail, severity };
}

// HTML から `const WARD_DEFS = [ ... ];` の配列を抜き出し、各エントリの
// id / name / datasetId / code / dataReady を素朴にパースする（JS実行はしない）。
export function parseWardDefs(html) {
  const start = html.indexOf('const WARD_DEFS = [');
  if (start < 0) return null;
  const open = html.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = html.slice(open + 1, end);
  const entries = [];
  for (const m of body.matchAll(/\{[^{}]*\}/g)) {
    const obj = m[0];
    const get = (key) => {
      const mm = obj.match(new RegExp(`${key}\\s*:\\s*('([^']*)'|"([^"]*)"|(true|false)|(0x[0-9a-fA-F]+))`));
      if (!mm) return undefined;
      if (mm[2] !== undefined) return mm[2];
      if (mm[3] !== undefined) return mm[3];
      if (mm[4] !== undefined) return mm[4] === 'true';
      return mm[5];
    };
    entries.push({ id: get('id'), name: get('name'), datasetId: get('datasetId'), code: get('code'), dataReady: get('dataReady') });
  }
  return entries;
}

export function parseBuildingTileConfig(html) {
  const start = html.indexOf('const BUILDING_TILE_CONFIG = {');
  if (start < 0) return null;
  const seg = html.slice(start, start + 2000);
  const bp = seg.match(/basePath:\s*'([^']+)'/);
  const rm = seg.match(/rootManifest:\s*'([^']+)'/);
  return { basePath: bp ? bp[1] : null, rootManifest: rm ? rm[1] : null };
}

/**
 * @param {object} opts
 * @param {string} opts.datasetRoot   public/map-data/osaka-city/buildings（servable）
 * @param {string} opts.htmlPath      public/osaka_3d_buildings.ward-ux-v1.html
 * @param {string} opts.wardPolygonsPath  public/map-data/osaka-city/boundaries/ward-classification-polygons.json
 * @param {object} opts.registry
 */
export function validateWardModeIntegration(opts) {
  const { datasetRoot, htmlPath, wardPolygonsPath, registry } = opts;
  const checks = [];

  // ── 建物 dataset 側（P1-4 validator を servable path に対して実行） ──
  const dsResult = validateWardBuildingDatasets(datasetRoot, { registry });
  for (const c of dsResult.checks) checks.push({ ...c, name: `dataset:${c.name}` });

  // servable path 判定
  checks.push(check('servable-path',
    /public[\\/]map-data[\\/]osaka-city[\\/]buildings/.test(datasetRoot) && fs.existsSync(path.join(datasetRoot, 'manifest.json')),
    fs.existsSync(path.join(datasetRoot, 'manifest.json')) ? datasetRoot : `${datasetRoot}/manifest.json が無い`));

  // flat layout（ward-ux-v1 ローダが期待する <datasetId>/tile_x_z.json）
  let flatOk = true;
  const flatDetail = [];
  if (fs.existsSync(path.join(datasetRoot, 'manifest.json'))) {
    const root = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'manifest.json'), 'utf-8'));
    for (const d of (root.datasets || [])) {
      const dir = path.join(datasetRoot, d.id);
      const manOk = fs.existsSync(path.join(dir, 'manifest.json'));
      if (!manOk) { flatOk = false; flatDetail.push(`${d.id}/manifest.json 無し`); continue; }
      const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
      const firstTile = (man.tiles || [])[0];
      if (firstTile) {
        const tp = path.join(dir, firstTile.file);
        if (!fs.existsSync(tp) || /[\\/]tiles[\\/]/.test(firstTile.file)) { flatOk = false; flatDetail.push(`${d.id}: tile path が flat でない (${firstTile.file})`); }
      }
      if (man.coordinateConvention !== 'znorth-neg-v1') { flatOk = false; flatDetail.push(`${d.id}: coordinateConvention=${man.coordinateConvention}`); }
    }
  }
  checks.push(check('flat-layout-servable', flatOk, flatOk ? '<datasetId>/tile_x_z.json 形式・znorth-neg-v1' : flatDetail.join(' / ')));

  // ── HTML WARD_DEFS ↔ registry ──
  let wardDefs = null, btConfig = null;
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    wardDefs = parseWardDefs(html);
    btConfig = parseBuildingTileConfig(html);
  }
  if (!wardDefs) {
    checks.push(check('html-ward-defs', false, `${htmlPath} から WARD_DEFS を読めない`));
  } else {
    const regIds = new Set(registry.wards.map((w) => w.id));
    const defIds = new Set(wardDefs.map((d) => d.id));
    const missing = registry.wards.filter((w) => !defIds.has(w.id)).map((w) => w.name);
    const extra = wardDefs.filter((d) => !regIds.has(d.id)).map((d) => d.id);
    checks.push(check('html-ward-defs-24', wardDefs.length === registry.wards.length && missing.length === 0 && extra.length === 0,
      missing.length ? `不足: ${missing.join('、')}` : extra.length ? `registry外: ${extra.join(', ')}` : `${wardDefs.length}区`));

    const idMismatch = [];
    const regByIdMap = new Map(registry.wards.map((w) => [w.id, w]));
    for (const d of wardDefs) {
      const reg = regByIdMap.get(d.id);
      if (!reg) continue;
      if (reg.name !== d.name) idMismatch.push(`${d.id}: name ${d.name}≠${reg.name}`);
      if (reg.code !== d.code) idMismatch.push(`${d.id}: code ${d.code}≠${reg.code}`);
      if (reg.datasetId !== d.datasetId) idMismatch.push(`${d.id}: datasetId ${d.datasetId}≠${reg.datasetId}`);
    }
    checks.push(check('html-ward-defs-match-registry', idMismatch.length === 0, idMismatch.length ? idMismatch.join(' / ') : 'name/code/datasetId 一致'));

    const notReady = wardDefs.filter((d) => d.dataReady !== true).map((d) => d.id);
    checks.push(check('html-ward-defs-all-dataReady', notReady.length === 0, notReady.length ? `dataReady≠true: ${notReady.join(', ')}` : '24区とも dataReady:true'));

    // WARD_DEFS.datasetId が servable dataset として存在するか
    if (fs.existsSync(path.join(datasetRoot, 'manifest.json'))) {
      const root = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'manifest.json'), 'utf-8'));
      const servableIds = new Set((root.datasets || []).map((d) => d.id));
      const noData = wardDefs.filter((d) => !servableIds.has(d.datasetId)).map((d) => d.datasetId);
      checks.push(check('html-ward-defs-have-datasets', noData.length === 0, noData.length ? `dataset 無し: ${noData.join(', ')}` : 'WARD_DEFS 全区に servable dataset あり'));
    }
  }

  if (!btConfig) {
    checks.push(check('html-building-tile-config', false, 'BUILDING_TILE_CONFIG を読めない'));
  } else {
    const bpOk = btConfig.basePath === 'map-data/osaka-city/buildings';
    const rmOk = btConfig.rootManifest === 'map-data/osaka-city/buildings/manifest.json';
    checks.push(check('html-basePath', bpOk && rmOk, `basePath=${btConfig.basePath} rootManifest=${btConfig.rootManifest}`));
  }

  // ── N03 区境界 polygon が servable path にあるか ──
  let wp = null;
  if (wardPolygonsPath && fs.existsSync(wardPolygonsPath)) {
    try { wp = JSON.parse(fs.readFileSync(wardPolygonsPath, 'utf-8').replace(/^﻿/, '')); } catch { /* noop */ }
  }
  checks.push(check('n03-ward-polygons-servable',
    !!(wp && Array.isArray(wp.wards) && wp.wards.length === registry.wards.length && wp.coordinateConvention === 'znorth-neg-v1'),
    wp ? `${wp.wards ? wp.wards.length : 0}区 / ${wp.coordinateConvention}` : `${wardPolygonsPath} が無い`));

  const errorFails = checks.filter((c) => !c.pass && c.severity === 'error');
  return {
    ok: errorFails.length === 0,
    checks,
    wardDefs,
    btConfig,
    datasetSummary: dsResult.summary,
    summary: { errorFailCount: errorFails.length, warningCount: checks.filter((c) => !c.pass && c.severity === 'warning').length },
  };
}
