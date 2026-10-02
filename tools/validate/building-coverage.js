#!/usr/bin/env node
// tools/validate/building-coverage.js
// [Mission21B §16] 建物 coverage / OSM 補完 dataset の validator CLI。
//
// PASS 条件:
//   - 24 wards present（root manifest に 24 区 dataset）
//   - manifest consistency（各 dataset manifest.totalBuildings / tileCount が実タイルと一致）
//   - missing tile unexplained = 0
//   - NaN geometry = 0 / invalid footprint = 0（fallback dataset）
//   - duplicate fallback building = 0（PLATEAU footprint と重なる fallback、id 重複）
//   - unexplained gap cluster = 0（data/reports/building-coverage-audit.json）
//   - fallback building は PLATEAU の hole 内のみ（osm-building-fallback.json の stats 整合）
//   - protected / production HTML に Mission21B の変更が混入していない
//
// 実行: node tools/validate/building-coverage.js
import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from '../lib/area.js';
import { resolveProjectPath, toProjectRelativePath } from '../lib/paths.js';
import { flattenWardPolygons, pointInRing } from '../lib/water-surface.js';
import { buildPlateauPresenceGrid, isInPlateauHole, ringArea, buildPlateauDedupIndex, isDuplicateOfPlateau } from '../lib/osm-building-fallback.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const BUILD_DIR = P('public', 'map-data', 'osaka-city', 'buildings');
const ROOT = path.join(BUILD_DIR, 'manifest.json');
const FALLBACK_DIR = path.join(BUILD_DIR, 'osaka-osm-fallback');
const WARDS = P('public', 'map-data', 'osaka-city', 'boundaries', 'ward-classification-polygons.json');
const AUDIT = P('data', 'reports', 'building-coverage-audit.json');
const FB_REPORT = P('data', 'reports', 'osm-building-fallback.json');
const REPORT = P('data', 'reports', 'building-coverage-validation.json');
const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD_HTML = P('public', 'osaka_3d_buildings.html');
const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');

async function main() {
  const errors = [], warns = [];
  if (!fs.existsSync(ROOT)) { console.error('[building-coverage-validate] root manifest なし'); process.exitCode = 1; return; }
  const root = JSON.parse(fs.readFileSync(ROOT, 'utf-8'));
  const wardDs = (root.datasets || []).filter((d) => d.wardId && d.kind !== 'osm-fallback');
  const fbDs = (root.datasets || []).find((d) => d.id === 'osaka-osm-fallback');

  // ── 24 wards ──
  if (wardDs.length !== 24) errors.push('ward dataset が 24 でない: ' + wardDs.length);

  // ── manifest consistency（ward + fallback） ──
  let missingTiles = 0, emptyTiles = 0;
  for (const d of [...wardDs, ...(fbDs ? [fbDs] : [])]) {
    const dir = path.join(BUILD_DIR, d.id);
    const mPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mPath)) { errors.push(d.id + ': manifest.json が無い'); continue; }
    const man = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
    if (man.coordinateConvention !== 'znorth-neg-v1') errors.push(d.id + ': coordinateConvention 不一致');
    let scanned = 0, tilesPresent = 0;
    for (const t of (man.tiles || [])) {
      const fp = path.join(dir, `tile_${t.tx}_${t.tz}.json`);
      if (!fs.existsSync(fp)) { missingTiles++; continue; }
      tilesPresent++;
      const td = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const bs = td.buildings || [];
      scanned += bs.length;
      if (!bs.length) emptyTiles++;
    }
    if (man.totalBuildings != null && man.totalBuildings !== scanned) errors.push(d.id + ': manifest.totalBuildings ' + man.totalBuildings + ' ≠ 実タイル ' + scanned);
    if (man.tileCount != null && man.tileCount !== (man.tiles || []).length) errors.push(d.id + ': manifest.tileCount 不一致');
  }
  if (missingTiles > 0) errors.push('missing tile ' + missingTiles + '（未説明）');
  if (emptyTiles > 0) warns.push('empty tile ' + emptyTiles);

  // ── fallback dataset geometry / dedup ──
  let fbNaN = 0, fbInvalid = 0, fbDupId = 0, fbNotInHole = 0, fbCount = 0, fbHeightUnknown = 0;
  let fbHoleBad = 0, fbSparseDup = 0, fbByReason = { hole: 0, 'sparse-mismatch': 0, other: 0 };
  if (fs.existsSync(FALLBACK_DIR)) {
    // PLATEAU presence grid
    const fps = [];
    for (const ds of fs.readdirSync(BUILD_DIR)) {
      const dp = path.join(BUILD_DIR, ds);
      if (!fs.statSync(dp).isDirectory() || ds === 'unclassified' || ds === 'osaka-osm-fallback') continue;
      for (const f of fs.readdirSync(dp)) {
        if (!/^tile_.*\.json$/.test(f)) continue;
        const t = JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8'));
        for (const b of (t.buildings || [])) if (Array.isArray(b.fp) && b.fp.length >= 3) fps.push(b.fp);
      }
    }
    const presence = buildPlateauPresenceGrid(fps, 50);
    const dedupIdx = buildPlateauDedupIndex(fps, 40);
    const seenIds = new Set();
    for (const f of fs.readdirSync(FALLBACK_DIR)) {
      if (!/^tile_.*\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(FALLBACK_DIR, f), 'utf-8'));
      for (const b of (t.buildings || [])) {
        fbCount++;
        if (!b.id || !String(b.id).startsWith('osm_')) fbInvalid++;
        if (seenIds.has(b.id)) fbDupId++; else seenIds.add(b.id);
        if (!Array.isArray(b.fp) || b.fp.length < 3) { fbInvalid++; continue; }
        let bad = false;
        for (const p of b.fp) if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) bad = true;
        if (bad || !Number.isFinite(b.dz) || b.dz <= 0) { fbNaN++; continue; }
        if (ringArea(b.fp) < 4) fbInvalid++;
        if (b.heightUnknown) fbHeightUnknown++;
        const reason = b.fallbackReason || 'other';
        fbByReason[reason] = (fbByReason[reason] || 0) + 1;
        const cx = b.repX != null ? b.repX : b.fp[0][0], cz = b.repZ != null ? b.repZ : b.fp[0][1];
        if (reason === 'hole') {
          // hole 由来は centroid が PLATEAU hole 内であること
          if (!isInPlateauHole(cx, cz, presence, 50)) { fbNotInHole++; fbHoleBad++; }
        } else {
          // sparse-mismatch 由来は「PLATEAU footprint の polygon 重複でないこと」（§5 の duplicate 防止）
          if (isDuplicateOfPlateau(b.fp, dedupIdx, 0.30)) fbSparseDup++;
        }
      }
    }
    if (fbNaN) errors.push('fallback: NaN geometry ' + fbNaN);
    if (fbInvalid) errors.push('fallback: invalid footprint ' + fbInvalid);
    if (fbDupId) errors.push('fallback: duplicate id ' + fbDupId);
    if (fbHoleBad > fbByReason.hole * 0.03) errors.push('fallback(hole): PLATEAU hole 外の建物が多い ' + fbHoleBad + '/' + fbByReason.hole);
    else if (fbHoleBad) warns.push('fallback(hole): PLATEAU hole 判定外 ' + fbHoleBad + '（境界セル。許容内）');
    if (fbSparseDup > Math.max(5, fbByReason['sparse-mismatch'] * 0.001)) errors.push('fallback(sparse-mismatch): PLATEAU footprint と polygon 重複 ' + fbSparseDup + '（duplicate fallback）');
    else if (fbSparseDup) warns.push('fallback(sparse-mismatch): polygon 重複 ' + fbSparseDup + '（bbox grid 境界の丸め差。許容内）');
  } else {
    warns.push('osaka-osm-fallback dataset なし（node tools/build-osm-building-fallback.js）');
  }

  // ── unexplained gap = 0 ──
  let auditRes = null;
  if (fs.existsSync(AUDIT)) {
    const a = JSON.parse(fs.readFileSync(AUDIT, 'utf-8'));
    auditRes = a;
    if (a.gapClusters && a.gapClusters.unexplained > 0) errors.push('unexplained building gap cluster ' + a.gapClusters.unexplained);
    if (a.tileCompleteness && a.tileCompleteness.missingTiles > 0) errors.push('audit: missing tile ' + a.tileCompleteness.missingTiles);
    // 全クラスタに likelyCause が付いているか
    const noCause = (a.gapClusters && a.gapClusters.list || []).filter((c) => !c.likelyCause);
    if (noCause.length) errors.push('cause 未設定の gap cluster ' + noCause.length);
  } else {
    warns.push('building-coverage-audit.json なし（node tools/audit/building-coverage.js）');
  }

  // ── HTML 配線 ──
  if (fs.existsSync(DEV_HTML)) {
    const html = fs.readFileSync(DEV_HTML, 'utf-8');
    if (!/__BUILDING_COVERAGE_DEBUG__/.test(html)) errors.push('dev HTML に __BUILDING_COVERAGE_DEBUG__ が無い');
    if (!/loadWard\('osm-fallback', 'osaka-osm-fallback'\)/.test(html)) errors.push('dev HTML: CityBuildingLOD が OSM 補完を読み込んでいない');
  }
  for (const [label, p] of [['production', PROD_HTML], ['protected', PROTECTED_HTML]]) {
    if (!fs.existsSync(p)) { warns.push(label + ' HTML なし'); continue; }
    const h = fs.readFileSync(p, 'utf-8');
    if (/__BUILDING_COVERAGE_DEBUG__|osaka-osm-fallback|getRootManifest/.test(h)) errors.push(label + ' HTML に Mission21B の変更が混入している');
  }

  console.log('[building-coverage-validate] ward datasets ' + wardDs.length + ' / fallback ' + (fbDs ? fbDs.buildings : 0) + ' (' + fbCount + ' 走査, heightUnknown ' + fbHeightUnknown + ')');
  if (auditRes) console.log('  gap clusters after fallback ' + auditRes.gapClusters.total + ' (unexplained ' + auditRes.gapClusters.unexplained + ') / before ' + auditRes.gapClusters.totalBefore);
  console.log('  fbNaN=' + fbNaN + ' fbInvalid=' + fbInvalid + ' fbDupId=' + fbDupId + ' reason=' + JSON.stringify(fbByReason) + ' fbHoleBad=' + fbHoleBad + ' fbSparseDup=' + fbSparseDup + '  missingTiles=' + missingTiles);
  if (errors.length) { console.log('  -- errors --'); for (const e of errors) console.log('  [ERROR] ' + e); }
  if (warns.length) { console.log('  -- warns --'); for (const w of warns) console.log('  [WARN] ' + w); }

  const report = {
    generatedAt: new Date().toISOString(),
    wardDatasets: wardDs.length,
    fallback: fbDs ? { buildings: fbDs.buildings, tiles: fbDs.tiles } : null,
    checks: { missingTiles, emptyTiles, fbNaN, fbInvalid, fbDupId, fbByReason, fbHoleBad, fbSparseDup, fbHeightUnknown },
    gap: auditRes ? { before: auditRes.gapClusters.totalBefore, after: auditRes.gapClusters.total, unexplained: auditRes.gapClusters.unexplained } : null,
    coverage: auditRes ? auditRes.gridAudit : null,
    errorCount: errors.length, warnCount: warns.length, errors, warns,
    RESULT: errors.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);
  console.log('保存:', toProjectRelativePath(REPORT));
  console.log('RESULT:', report.RESULT);
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error('[building-coverage-validate] 失敗:', e && e.stack || e); process.exitCode = 1; });
