// tools/lib/supplement-pipeline.js  [Issue #65 / 第4段階]
// 小範囲の建物補完パイプライン: 既存 footprint(配信タイル等) + 補完候補(明示入力) → 新規/既存一致/保留
//   → 既存と独立した「区/タイル manifest」へ出力する。判定は building-supplement-diff.js（厳密交差面積）。
//   * 入力は必ず明示指定。入力が無い/壊れている場合は SupplementInputError（fixture で代替しない）。
//   * 既存データは読むだけ。出力先が既存タイルdirと重なる/非空なら書かない。
//   * 座標(world {x,z} m)・元ID・高さ根拠(heightSource/estimated/heightAccuracy)・一致した既存IDを保存。
//   * 既定OFF・遅延読込・別manifest の接続仕様は docs/supplement/SUPPLEMENT_LAYER_INTEGRATION_SPEC.md。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { auditCandidates, DECISION, geomBbox, geomArea, normalizeGeometry, toSupplementRecord } from './building-supplement-diff.js';

export const OUTPUT_SCHEMA = 'livecity-supplement-layer-v1';

export class SupplementInputError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'SupplementInputError'; this.code = code; this.detail = detail ?? null; }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const r2 = (v) => Math.round(v * 100) / 100;

function readJson(file, code) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { throw new SupplementInputError(code, `cannot read ${file}: ${e.code || e.message}`, { file }); }
  try { return { json: JSON.parse(buf.toString('utf-8')), sha256: sha256(buf) }; }
  catch (e) { throw new SupplementInputError(`${code}-parse`, `invalid JSON: ${file}`, { file }); }
}

/** 配信タイル dir(manifest.json + tile_*.json) を読む。欠落タイルは missingTiles に記録（黙って無視しない）。 */
export function loadExistingTiles(dir) {
  const { json: manifest, sha256: manifestSha256 } = readJson(path.join(dir, 'manifest.json'), 'existing-manifest');
  if (!Array.isArray(manifest.tiles) || !Number.isFinite(manifest.tileSize)) throw new SupplementInputError('existing-manifest-shape', 'manifest.tiles / tileSize missing', { dir });
  const items = [], coveredTiles = new Set(), missingTiles = [];
  for (const t of manifest.tiles) {
    const key = `${t.tx},${t.tz}`;
    let tile;
    try { tile = readJson(path.join(dir, t.file), 'existing-tile').json; } catch (e) { if (e instanceof SupplementInputError) { missingTiles.push({ key, file: t.file, code: e.code }); continue; } throw e; }
    coveredTiles.add(key);
    for (const b of tile.buildings || []) {
      if (!Array.isArray(b.fp) || b.fp.length < 3) continue; // 不正footprintは比較対象外（件数をreportに残す）
      items.push({ id: String(b.id), ring: b.fp, height: b.h });
    }
  }
  return { items, coveredTiles, missingTiles, tileSize: manifest.tileSize, manifestRef: { totalBuildings: manifest.totalBuildings ?? null, generatedAt: manifest.generatedAt ?? null, sha256: manifestSha256, id: manifest.id ?? null } };
}

/** 旧V3/V4 `recovered-index.json` 等の world 座標JSON → 候補。高さは「根拠未確認」扱い（実測にしない）。 */
export function loadWorldCandidates(file) {
  const { json, sha256: h } = readJson(file, 'candidates');
  const arr = Array.isArray(json) ? json : json.buildings;
  if (!Array.isArray(arr)) throw new SupplementInputError('candidates-shape', 'expected array or {buildings:[]}', { file });
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const out = arr.map((b, i) => ({
    id: String(b.id ?? `w${i}`),
    ...(b.polys ? { polys: b.polys } : { polys: [[b.ring ?? b.fp ?? []]] }),
    height: num(b.height ?? b.h), levels: num(b.levels ?? b.num_floors),
    heightSource: b.heightSource, heightEstimated: b.heightEstimated, heightAccuracy: b.heightAccuracy,
    surveyDate: b.surveyDate, buildingPartOf: b.buildingPartOf, sourceDatasets: b.sourceDatasets ?? [],
  }));
  return { candidates: out, sha256: h };
}

const tileOf = (polys, size) => { const b = geomBbox(polys); return [Math.floor((b.minX + b.maxX) / 2 / size), Math.floor((b.minZ + b.maxZ) / 2 / size)]; };

/**
 * 判定本体。existing={items,coveredTiles,tileSize}, candidates=[{id,polys,...}], ctx={source,sourceVersion,license,acquiredAt}
 * - 候補の属するタイル(bbox中心)とその8近傍のいずれかが既存タイル欠落/未収録なら HOLD(no-existing-coverage)。
 *   比較相手が無い所を「新規」にしない。
 * - 候補ID重複(入力内)は先頭のみ判定、後続は HOLD(duplicate-candidate-id)。
 */
export function buildSupplement({ existing, candidates, ctx }) {
  const seen = new Set(), toAudit = [], pre = [];
  candidates.forEach((c, inputIndex) => {
    const polys = normalizeGeometry(c);
    if (seen.has(c.id)) { pre.push({ cand: { ...c, polys }, verdict: { decision: DECISION.HOLD, reason: 'duplicate-candidate-id', metrics: {}, partners: [] }, inputIndex }); return; }
    seen.add(c.id);
    if (!polys.length) { pre.push({ cand: { ...c, polys }, verdict: { decision: DECISION.HOLD, reason: 'invalid-geometry', metrics: {}, partners: [] }, inputIndex }); return; }
    const [tx, tz] = tileOf(polys, existing.tileSize);
    let covered = true;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!existing.coveredTiles.has(`${tx + dx},${tz + dz}`)) covered = false;
    // 既存タイルが無いのは「既存が空」ではなく「比較不能」。端のタイルは保守的に保留される。
    if (!covered) pre.push({ cand: { ...c, polys }, verdict: { decision: DECISION.HOLD, reason: 'no-existing-coverage', metrics: { tile: `${tx},${tz}` }, partners: [] }, inputIndex });
    else toAudit.push({ ...c, polys });
  });
  const audit = auditCandidates(toAudit, existing.items, ctx);
  const byId = new Map([...toAudit, ...pre.map((p) => p.cand)].map((c) => [c.id, c]));
  const records = audit.records.map((r) => ({ ...r, _cand: byId.get(r.sourceId) }));
  const summary = audit.summary;
  for (const p of pre) {
    const rec = { ...toSupplementRecord(p.cand, p.verdict, ctx), metrics: p.verdict.metrics, _cand: p.cand };
    records.push(rec);
    summary.total++;
    summary.byDecision.HOLD = (summary.byDecision.HOLD || 0) + 1;
    summary.byReason[p.verdict.reason] = (summary.byReason[p.verdict.reason] || 0) + 1;
  }
  records.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return { records, summary };
}

const geomOut = (polys) => ({ fp: polys[0][0].map(([x, z]) => [r2(x), r2(z)]), polys: polys.map((p) => p.map((r) => r.map(([x, z]) => [r2(x), r2(z)]))) });

function tileRecord(rec, size) {
  const polys = rec._cand.polys, g = geomOut(polys), [tx, tz] = tileOf(polys, size);
  return {
    tile: [tx, tz],
    rec: {
      id: rec.canonicalId, sourceId: rec.sourceId, source: rec.source, sourceVersion: rec.sourceVersion, ...g,
      z0: 0, dz: rec.heightM, h: rec.heightM, // null = 高さ根拠なし。表示側が既定値を使う場合は「未確認」と明示すること
      heightSource: rec.heightSource, heightEstimated: rec.estimated, heightAccuracy: rec.heightAccuracy,
      surveyDate: rec.surveyDate, license: rec.license, status: rec.status, representation: rec.representation,
      decisionReason: rec.decisionReason, matchedExistingIds: rec.matchedExistingIds, area: r2(geomArea(polys)),
    },
  };
}

const isInside = (child, parent) => { const rel = path.relative(path.resolve(parent), path.resolve(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** 出力。既存dirとの重なり・非空出力先は拒否（上書きしない）。 */
export function writeSupplement({ outDir, result, meta }) {
  if (meta.existingDir && (isInside(outDir, meta.existingDir) || isInside(meta.existingDir, outDir))) throw new SupplementInputError('out-overlaps-existing', 'out-dir must not overlap existing tile dir', { outDir });
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new SupplementInputError('out-not-empty', 'out-dir exists and is not empty (no overwrite)', { outDir });
  fs.mkdirSync(outDir, { recursive: true });
  const size = meta.tileSize, tiles = new Map(), hold = [], matched = [];
  for (const rec of result.records) {
    if (rec.status === 'candidate' || rec.status === 'candidate-hold-license') {
      const { tile, rec: out } = tileRecord(rec, size), k = `${tile[0]}_${tile[1]}`;
      (tiles.get(k) || tiles.set(k, { tx: tile[0], tz: tile[1], buildings: [] }).get(k)).buildings.push(out);
    } else if (rec.status === 'hold') hold.push({ ...tileRecord(rec, size).rec, metrics: rec.metrics });
    else matched.push({ sourceId: rec.sourceId, reason: rec.decisionReason, matchedExistingIds: rec.matchedExistingIds });
  }
  const tileList = [];
  for (const [k, t] of [...tiles].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const file = `tile_${k}.json`;
    fs.writeFileSync(path.join(outDir, file), JSON.stringify({ tx: t.tx, tz: t.tz, tileSize: size, layer: 'supplement', count: t.buildings.length, buildings: t.buildings }));
    tileList.push({ tx: t.tx, tz: t.tz, file, count: t.buildings.length });
  }
  fs.writeFileSync(path.join(outDir, 'hold.json'), JSON.stringify({ count: hold.length, buildings: hold }));
  fs.writeFileSync(path.join(outDir, 'matched-existing.json'), JSON.stringify({ count: matched.length, items: matched }));
  const manifest = {
    schema: OUTPUT_SCHEMA, layer: 'supplement', defaultEnabled: false, lazyLoad: true,
    coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', tileSize: size,
    note: '補完レイヤー。既存PLATEAU配信データを上書き/変更しない。件数は入力範囲での照合結果で、網羅率ではない。',
    publishable: !!(meta.ctx.license && meta.ctx.license !== 'unknown'), license: meta.ctx.license ?? 'unknown',
    source: { name: meta.ctx.source, version: meta.ctx.sourceVersion, acquiredAt: meta.ctx.acquiredAt ?? null },
    inputs: meta.inputs, existingRef: meta.existingRef, existingMissingTiles: meta.missingTiles,
    counts: { ...result.summary, newTiles: tileList.length, newBuildings: tileList.reduce((s, t) => s + t.count, 0), hold: hold.length, matchedExisting: matched.length },
    tiles: tileList, generatedAt: meta.generatedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}
