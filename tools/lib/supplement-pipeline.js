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
import { auditCandidates, DECISION, geomBbox, geomArea, geomValid, normalizeGeometry, toSupplementRecord, licenseConfirmed } from './building-supplement-diff.js';

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

const finitePt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const validFp = (fp) => Array.isArray(fp) && fp.length >= 3 && fp.every(finitePt);

/**
 * 配信タイル dir(manifest.json + tile_*.json) を読む。
 *  - 欠落/不正タイルは missingTiles、不正footprintを含むタイルは degradedTiles に件数・id(最大20)付きで記録。
 *    どちらも coveredTiles に入れない（= 周辺候補は no-existing-coverage で保留。既存形状の欠落を「新規」にしない）。
 *  - tile の原点規則 floor(bbox中心/tileSize) と manifest の tx,tz が合わない棟数を originMismatch に記録（情報用）。
 *  実形式: manifest {tileSize, tiles:[{tx,tz,file,count}]}, tile {tx,tz,tileSize,buildings:[{id,fp:[[x,z]..],h,...}]}（住吉 main 配信で確認）。
 */
export function loadExistingTiles(dir) {
  const { json: manifest, sha256: manifestSha256 } = readJson(path.join(dir, 'manifest.json'), 'existing-manifest');
  if (!Array.isArray(manifest.tiles) || !Number.isFinite(manifest.tileSize)) throw new SupplementInputError('existing-manifest-shape', 'manifest.tiles / tileSize missing', { dir });
  const size = manifest.tileSize;
  const items = [], coveredTiles = new Set(), missingTiles = [], degradedTiles = [];
  let invalidFootprints = 0, originMismatch = 0, countMismatchTiles = 0;
  for (const t of manifest.tiles) {
    const key = `${t.tx},${t.tz}`;
    let tile;
    try { tile = readJson(path.join(dir, String(t.file)), 'existing-tile').json; } catch (e) { if (e instanceof SupplementInputError) { missingTiles.push({ key, file: t.file, code: e.code }); continue; } throw e; }
    if (!tile || !Array.isArray(tile.buildings)) { missingTiles.push({ key, file: t.file, code: 'existing-tile-shape' }); continue; }
    if (Number.isFinite(t.count) && t.count !== tile.buildings.length) countMismatchTiles++;
    const bad = [], tileItems = [];
    for (const b of tile.buildings) {
      if (!b || !validFp(b.fp)) { bad.push(b && b.id != null ? String(b.id) : null); continue; }
      const xs = b.fp.map((p) => p[0]), zs = b.fp.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      if (Math.floor(cx / size) !== t.tx || Math.floor(cz / size) !== t.tz) originMismatch++;
      tileItems.push({ id: String(b.id), ring: b.fp, height: b.h });
    }
    items.push(...tileItems);
    if (bad.length) { invalidFootprints += bad.length; degradedTiles.push({ key, file: t.file, invalidCount: bad.length, ids: bad.slice(0, 20) }); continue; }
    coveredTiles.add(key);
  }
  return { items, coveredTiles, missingTiles, degradedTiles, tileSize: size,
    stats: { invalidFootprints, originMismatch, countMismatchTiles },
    manifestRef: { totalBuildings: manifest.totalBuildings ?? null, generatedAt: manifest.generatedAt ?? null, sha256: manifestSha256, id: manifest.id ?? null } };
}

/**
 * world 座標JSON → 候補。対応形式:
 *  (a) 旧V3/V4 `recovered-index.json`（tools/build-osm-fallback-v3.js:221 / build-final-buildings-v4.js:233 の生成コードの schema）
 *      {version, generatedAt, missionId, generationVersion?, count, note, buildings:[{canonicalId, wardId, areaM2, name, levels(文字列|null), cls, ring:[[x,z]..]}]}
 *      → id=canonicalId を保持。ring は外周のみ（内周なし）。高さは index に無い（levels のみ）ため levels*3m の推定扱い。
 *        元OSM height タグ・heightSource は index に存在せず復元不能（derived 側 attributes にのみ存在）。60m頭打ち後の値は持ち込まない。
 *  (b) 配列、または {buildings:[{id, polys|ring|fp, height, levels, ...}]}（汎用）
 * 壊れた要素は throw せず polys=[] の候補にして invalid-geometry で保留へ回す。
 */
export function loadWorldCandidates(file) {
  const { json, sha256: h } = readJson(file, 'candidates');
  const arr = Array.isArray(json) ? json : json && json.buildings;
  if (!Array.isArray(arr)) throw new SupplementInputError('candidates-shape', 'expected array or {buildings:[]}', { file });
  const isIndex = !Array.isArray(json) && json.missionId != null;
  const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : undefined; };
  const out = arr.map((b, i) => {
    b = b && typeof b === 'object' ? b : {};
    const id = String(b.canonicalId ?? b.id ?? `w${i}`);
    const polys = Array.isArray(b.polys) ? b.polys : [[Array.isArray(b.ring) ? b.ring : Array.isArray(b.fp) ? b.fp : []]];
    return {
      id, polys,
      height: num(b.height), levels: num(b.levels ?? b.num_floors),
      heightSource: b.heightSource, heightEstimated: b.heightEstimated, heightAccuracy: b.heightAccuracy,
      surveyDate: b.surveyDate, buildingPartOf: b.buildingPartOf,
      sourceDatasets: b.sourceDatasets ?? (isIndex ? [`osm-recovered-index:${json.missionId}`] : []),
      legacy: isIndex ? { canonicalId: b.canonicalId ?? null, wardId: b.wardId ?? null, cls: b.cls ?? null, areaM2: b.areaM2 ?? null, name: b.name ?? null, missionId: json.missionId, generationVersion: json.generationVersion ?? null } : undefined,
    };
  });
  return { candidates: out, sha256: h, format: isIndex ? 'recovered-index' : 'generic', declaredCount: isIndex ? json.count ?? null : null, countMismatch: isIndex && Number.isFinite(json.count) ? json.count !== arr.length : false };
}

const tileOf = (polys, size) => { const b = geomBbox(polys); return [Math.floor((b.minX + b.maxX) / 2 / size), Math.floor((b.minZ + b.maxZ) / 2 / size)]; };

/**
 * 判定本体。existing={items,coveredTiles,degradedTiles?,tileSize}, candidates=[{id,polys,...}], ctx={source,sourceVersion,license,licenseVerified,attribution,acquiredAt}
 * - 候補の属するタイルとその8近傍のいずれかが 欠落/未収録/不正footprint含み なら HOLD(no-existing-coverage)。
 * - 入力内の同一IDは先頭のみ判定、後続は HOLD(duplicate-candidate-id)。
 * - レコードと元候補は「入力位置(inputIndex)」で結び付ける。同一IDの別形状が判定済み形状を上書きしない。
 */
export function buildSupplement({ existing, candidates, ctx }) {
  const seen = new Set(), toAudit = [], pre = [];
  candidates.forEach((c0, inputIndex) => {
    const id = String(c0 && c0.id != null ? c0.id : `idx${inputIndex}`);
    let polys; try { polys = normalizeGeometry(c0); } catch { polys = []; }
    let valid = false; try { valid = polys.length > 0 && geomValid(polys); } catch { valid = false; }
    const cand = { ...c0, id, polys: valid ? polys : [], _inputIndex: inputIndex };
    const hold = (reason, metrics = {}) => pre.push({ cand, valid, verdict: { decision: DECISION.HOLD, reason, metrics, partners: [] }, inputIndex });
    if (seen.has(id)) return hold('duplicate-candidate-id');
    seen.add(id);
    if (!valid) return hold('invalid-geometry');
    const [tx, tz] = tileOf(polys, existing.tileSize);
    let covered = true;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!existing.coveredTiles.has(`${tx + dx},${tz + dz}`)) covered = false;
    if (!covered) return hold('no-existing-coverage', { tile: `${tx},${tz}` });
    toAudit.push(cand);
  });
  const audit = auditCandidates(toAudit, existing.items, ctx);
  const auditCand = new Map(toAudit.map((c) => [c.id, c])); // toAudit 内の id は一意（上で重複を除外済み）
  const records = audit.records.map((r) => { const c = auditCand.get(r.sourceId); return { ...r, _cand: c, _inputIndex: c._inputIndex, _valid: r.decisionReason !== 'invalid-geometry' }; });
  const summary = audit.summary;
  for (const p of pre) {
    records.push({ ...toSupplementRecord(p.cand, p.verdict, ctx), metrics: p.verdict.metrics, _cand: p.cand, _inputIndex: p.inputIndex, _valid: p.valid });
    summary.total++;
    summary.byDecision.HOLD = (summary.byDecision.HOLD || 0) + 1;
    summary.byReason[p.verdict.reason] = (summary.byReason[p.verdict.reason] || 0) + 1;
  }
  records.sort((a, b) => a._inputIndex - b._inputIndex);
  return { records, summary };
}

const geomOut = (polys) => ({ fp: polys[0][0].map(([x, z]) => [r2(x), r2(z)]), polys: polys.map((p) => p.map((r) => r.map(([x, z]) => [r2(x), r2(z)]))) });

function baseOut(rec) {
  return {
    id: rec.canonicalId, sourceId: rec.sourceId, inputIndex: rec._inputIndex, source: rec.source, sourceVersion: rec.sourceVersion,
    heightSource: rec.heightSource, heightEstimated: rec.estimated, heightAccuracy: rec.heightAccuracy,
    surveyDate: rec.surveyDate, license: rec.license, status: rec.status, representation: rec.representation,
    decisionReason: rec.decisionReason, matchedExistingIds: rec.matchedExistingIds,
    ...(rec._cand && rec._cand.legacy ? { legacy: rec._cand.legacy } : {}),
  };
}

/** 形状つきレコード。形状が不正なら null を返さず throw しない診断レコード（geometry:null）にする。 */
function tileRecord(rec, size) {
  const polys = rec._cand.polys;
  if (!rec._valid || !polys.length) return { tile: null, rec: { ...baseOut(rec), geometry: null, diagnostic: true, vertexCounts: null } };
  const g = geomOut(polys), [tx, tz] = tileOf(polys, size);
  return { tile: [tx, tz], rec: { ...baseOut(rec), ...g, z0: 0, dz: rec.heightM, h: rec.heightM, area: r2(geomArea(polys)) } };
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
      const { tile, rec: out } = tileRecord(rec, size);
      if (!tile) { hold.push({ ...out, metrics: rec.metrics, note: 'new-candidate-without-valid-geometry' }); continue; }
      const k = `${tile[0]}_${tile[1]}`;
      (tiles.get(k) || tiles.set(k, { tx: tile[0], tz: tile[1], buildings: [] }).get(k)).buildings.push(out);
    } else if (rec.status === 'hold') hold.push({ ...tileRecord(rec, size).rec, metrics: rec.metrics });
    else matched.push({ sourceId: rec.sourceId, inputIndex: rec._inputIndex, reason: rec.decisionReason, matchedExistingIds: rec.matchedExistingIds });
  }
  const tileList = [];
  for (const [k, t] of [...tiles].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const file = `tile_${k}.json`;
    fs.writeFileSync(path.join(outDir, file), JSON.stringify({ tx: t.tx, tz: t.tz, tileSize: size, layer: 'supplement', count: t.buildings.length, buildings: t.buildings }));
    tileList.push({ tx: t.tx, tz: t.tz, file, count: t.buildings.length });
  }
  fs.writeFileSync(path.join(outDir, 'hold.json'), JSON.stringify({ count: hold.length, buildings: hold }));
  fs.writeFileSync(path.join(outDir, 'matched-existing.json'), JSON.stringify({ count: matched.length, items: matched }));
  const confirmed = licenseConfirmed(meta.ctx);
  const manifest = {
    schema: OUTPUT_SCHEMA, layer: 'supplement', defaultEnabled: false, lazyLoad: true,
    coordinateSystem: 'meters-local', coordinateConvention: 'znorth-neg-v1', tileSize: size,
    note: '補完レイヤー。既存PLATEAU配信データを上書き/変更しない。件数は入力範囲での照合結果で、網羅率ではない。',
    publishable: confirmed, license: meta.ctx.license ?? 'unknown',
    licenseStatus: { verified: meta.ctx.licenseVerified === true, attribution: meta.ctx.attribution ?? null, note: 'publishable は licenseVerified=true かつ license≠unknown かつ attribution 非空のときのみ true' },
    source: { name: meta.ctx.source, version: meta.ctx.sourceVersion, acquiredAt: meta.ctx.acquiredAt ?? null },
    inputs: meta.inputs, existingRef: meta.existingRef, existingMissingTiles: meta.missingTiles,
    existingDegradedTiles: meta.degradedTiles ?? [], existingStats: meta.existingStats ?? null,
    counts: { ...result.summary, newTiles: tileList.length, newBuildings: tileList.reduce((s, t) => s + t.count, 0), hold: hold.length, matchedExisting: matched.length },
    tiles: tileList, generatedAt: meta.generatedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}
