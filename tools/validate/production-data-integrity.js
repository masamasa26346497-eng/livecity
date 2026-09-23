#!/usr/bin/env node
// tools/validate/production-data-integrity.js
// [Mission 32S §14] PRODUCTION DATA INTEGRITY CLEANUP の検証。
//   fakeYieldVisible = false / fakeRentVisible = false / fakeNoteVisible = false / fakeFloorCountVisible = false
//   unsupportedTownChomeVisible = false / propertyCardFieldsHaveRealSource = true
//   buildingV2Mutation = 0 / roadV3Mutation = 0 / projectionMutation = 0
//   productionModified = false / protectedModified = false
//   → PRODUCTION_DATA_INTEGRITY_READY / PRODUCTION_DATA_INTEGRITY_FAILED
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveProjectPath, isMainModule } from '../lib/paths.js';
import { writeJson } from '../lib/area.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const F = {
  html: P('public', 'osaka_3d_buildings.ward-ux-v1.html'),
  area: P('config', 'areas', 'osaka-city.json'),
  qa: P('data', 'reports', 'production-data-integrity-qa.json'),
  provenance: P('data', 'reports', 'property-card-provenance.json'),
  facts: P('data', 'reports', 'building-source-facts.json'),
  prev32r: P('data', 'reports', 'final-ui-cleanup-validation.json'),
  canon: P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2'),
  factTiles: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-facts'),
  placement: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-placement', 'manifest.json'),
  wardIndex: P('public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-ward-index.json'),
  out: P('data', 'reports', 'production-data-integrity-validation.json'),
};
const FROZEN = [
  'data/processed/osaka-city/canonical/buildings-v2-osmv2/manifest.json',
  'data/processed/osaka-city/canonical/buildings-v2-corrected/manifest.json',
  'data/processed/osaka-city/canonical/buildings-v2-osm-fallback/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/near/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/mid/buildings/manifest.json',
  'public/map-data/osaka-city/derived-v2-osmv2/far/buildings/manifest.json',
];
const ROAD_V3 = ['data/processed/osaka-city/derived/road-visual-v3', 'public/map-data/osaka-city/derived/road-visual-v3'];
const rj = (p) => { try { return JSON.parse(readFileRetry(p)); } catch { return null; } };
function gitClean(rel) {
  try { return execFileSync('git', ['status', '--porcelain', '--', rel], { cwd: resolveProjectPath('.'), encoding: 'utf-8' }).trim() === ''; } catch { return null; }
}
function newestMtime(dir) {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return m;
}
const tileOf = (x, z) => `tile_${Math.floor(x / 500)}_${Math.floor(z / 500)}.json`;
/** コメント（<!-- -->, 行頭 //, ブロック）を取り除いた本文。削除の説明コメント自体を検出しないため。 */
export function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/[^'"`]*$/, ''))).join('\n');
}

export async function validateProductionDataIntegrity() {
  const errors = [], warnings = [];
  const qa = rj(F.qa), prov = rj(F.provenance), facts = rj(F.facts), prev = rj(F.prev32r);
  if (!qa || !prov || !facts) {
    const out = { RESULT: 'FAIL', classification: 'PRODUCTION_DATA_INTEGRITY_FAILED', errors: ['QA / provenance / facts レポートが無い'] };
    await writeJson(F.out, out); return out;
  }
  // 32R の validator を書いた時刻を mission 開始とみなす（それ以降に変わった frozen ファイルを検出する）
  const missionStart = Date.parse((prev && prev.generatedAt) || qa.generatedAt);
  const html = fs.readFileSync(F.html, 'utf-8');
  const code = stripComments(html);   // 「削除した」と書いたコメント自体を検出しないため
  const sites = qa.sites || [];

  // ── §0 変更禁止 ──
  const touched = FROZEN.filter((r) => { try { return fs.statSync(P(r)).mtimeMs > missionStart; } catch { return true; } });
  const merged = rj(path.join(F.canon, 'manifest.json')) || {};
  const buildingV2Mutation = touched.length + (merged.featureCount === 600764 ? 0 : 1);
  if (buildingV2Mutation) errors.push('§0: Building V2 / OSM fallback V2 が変わっている ' + JSON.stringify(touched));
  const roadV3Mutation = ROAD_V3.filter((d) => newestMtime(P(d)) > missionStart).length;
  if (roadV3Mutation) errors.push('§0: ROAD V3 が変わっている');
  const proj = (rj(F.area) || {}).projection || {};
  const projectionMutation = proj.type === 'local-equirectangular' && proj.centerLat === 34.604208 && proj.centerLon === 135.52502 && proj.metersPerDegree === 111320 ? 0 : 1;
  if (projectionMutation) errors.push('§0: projection / origin が変わっている');
  const placementMutation = [F.placement, F.wardIndex].filter((p) => fs.statSync(p).mtimeMs > missionStart).length;
  if (placementMutation) errors.push('§0: placement policy / ward index が変わっている');

  // ── §1/§4/§5/§6 仮値の生成コードと DOM が残っていない ──
  const gone = (re) => !re.test(code);
  const codeGone = [/function pseudoRand\(/, /function estimateFloors\(/, /function estimateRentPerTsubo\(/, /function fmtYen\(/, /yieldRate/, /rentLow|rentHigh/, /const memos\s*=/].every(gone);
  const domGone = [/id="pc-yield"/, /id="pc-rent"/, /id="pc-memo"/, /推定利回り/, /想定賃料/, /pc-disclaimer/].every(gone);
  const qaHits = (id) => sites.flatMap((s) => [s.plateau, s.osmUnknown].filter(Boolean)).filter((r) => (r.forbiddenTextHits || []).includes(id));
  const fakeYieldVisible = !codeGone || !gone(/推定利回り/) || qaHits('yield').length > 0;
  const fakeRentVisible = !domGone || qaHits('rent').length > 0;
  const fakeNoteVisible = !gone(/id="pc-memo"/) || qaHits('memo').length > 0 || qaHits('disclaimer').length > 0;
  // §3: 階数は PLATEAU の実属性のときだけ。高さ ÷ 階高 の推定は残っていないこと
  const fakeFloorCountVisible = !gone(/推定階数/) || !gone(/dz\s*\/\s*3\.2/) || qaHits('estimated-floors').length > 0;
  if (fakeYieldVisible) errors.push('§4: 推定利回りが残っている');
  if (fakeRentVisible) errors.push('§5: 想定賃料が残っている');
  if (fakeNoteVisible) errors.push('§6: 自動生成メモ / 仮値の注記が残っている');
  if (fakeFloorCountVisible) errors.push('§3: 高さから推定した階数が残っている');

  // ── §7 町丁目 ──
  const unsupportedTownChomeVisible = sites.some((s) => s.plateau.townSectionDisplay !== 'none')
    || qaHits('town-no-data').length > 0 || /textContent = townKey \|\| 'データなし'/.test(code);
  if (unsupportedTownChomeVisible) errors.push('§7: 町丁目データが無いのに行/セクションを出している');

  // ── §2/§3/§8/§13 出している値がすべて実データか（canonical / facts と突き合わせる） ──
  const fieldChecks = [];
  // 建物の重心（facts tile を引くのに使う）は QA レポートの targets 側にある
  const centroids = new Map();
  for (const t of qa.targets || []) for (const k of ['plateau', 'osmUnknown']) if (t[k]) centroids.set(t[k].id, t[k].c);
  for (const s of sites) {
    for (const r of [s.plateau, s.osmUnknown].filter(Boolean)) {
      if (!r.pickedExpected) { warnings.push(`${s.site}: 狙った建物を選べなかった（picked=${r.pick}）`); continue; }
      const c = centroids.get(r.target) || [0, 0];
      const ft = rj(path.join(F.factTiles, tileOf(c[0], c[1])));
      const fact = ft && ft.facts ? ft.facts[r.target] : null;
      const shownHeight = r.debug && r.debug.heightVisible;
      const shownFloors = r.debug && r.debug.floorsVisible;
      const basis = fact ? fact[0] : null;
      const storeys = fact && fact[1] ? fact[1] : 0;
      const heightOk = shownHeight === (basis === 1 || basis === 2 || basis === 4);
      const floorsOk = shownFloors === (storeys > 0)
        && (!shownFloors || parseInt(String(r.debug.fields.floors).replace(/[^\d]/g, ''), 10) === storeys);
      const wardOk = (r.debug.wardRowVisible === !!r.attr.wardId);
      const usageOk = !!r.debug.fields.usage && r.debug.fields.usage.startsWith(r.attr.usageLabel);
      // hover の「建物属性」も同じ基準（facts が届いた後の状態で判定する）
      const tipText = (r.tipAfter && r.tipAfter.text) || '';
      const tipShowsHeight = /高さ/.test(tipText);
      const tipOk = tipShowsHeight === (basis === 1 || basis === 2 || basis === 4);
      if (!tipOk) errors.push(`§2/§8: ${s.site} の hover tooltip の高さ表示が根拠（heightBasis=${basis}）と一致しない`);
      fieldChecks.push({ site: s.site, id: r.target, basis, storeys, shownHeight, shownFloors, heightOk, floorsOk, wardOk, usageOk, tipShowsHeight, tipOk, height: r.debug.fields.height, floors: r.debug.fields.floors, ward: r.debug.fields.ward, station: r.debug.fields.station });
      if (!heightOk) errors.push(`§2/§10: ${s.site} の高さ表示が根拠（heightBasis=${basis}）と一致しない`);
      if (!floorsOk) errors.push(`§3: ${s.site} の階数表示が実データ（storeys=${storeys}）と一致しない`);
      if (!wardOk) errors.push(`§8: ${s.site} の区の行が wardId と一致しない`);
      if (!usageOk) errors.push(`§8: ${s.site} の用途が canonical の usageLabel と一致しない`);
    }
  }
  // facts tile が canonical の全建物をカバーしている（§13）
  const factsCoverAll = facts.stat.buildings === merged.featureCount && facts.stat.tiles > 0
    && fs.existsSync(F.factTiles) && fs.readdirSync(F.factTiles).filter((f) => /^tile_/.test(f)).length === facts.stat.tiles;
  if (!factsCoverAll) errors.push('§13: building-facts が canonical の全建物をカバーしていない');
  const provReal = (prov.provenance || []).filter((p) => p.kind !== 'removed');
  const provRemoved = (prov.provenance || []).filter((p) => p.kind === 'removed').map((p) => p.field);
  const cardFieldsDocumented = ['用途', '高さ', '階数', '底面積', '区', '最寄駅', '建物 ID'].every((k) => provReal.some((p) => p.field.startsWith(k)));
  const propertyCardFieldsHaveRealSource = fieldChecks.length > 0 && fieldChecks.every((c) => c.heightOk && c.floorsOk && c.wardOk && c.usageOk && c.tipOk)
    && cardFieldsDocumented && factsCoverAll
    && !fakeYieldVisible && !fakeRentVisible && !fakeNoteVisible && !fakeFloorCountVisible;
  if (!propertyCardFieldsHaveRealSource) errors.push('§13: card の表示項目に実データの裏付けが揃っていない');

  // ── §12 6 地点で禁止表示が無い ──
  const qaSitesOk = sites.length === 6 && sites.every((s) => (s.plateau.forbiddenTextHits || []).length === 0 && s.plateau.cardDisplay === 'block')
    && (qa.consoleErrors || []).length === 0 && qa.finalResidual === 0;
  if (!qaSitesOk) errors.push('§12: 6 地点の実ブラウザ確認に失敗 ' + JSON.stringify(sites.map((s) => [s.site, s.plateau.forbiddenTextHits])));

  // ── production / protected ──
  // [Mission 33B] production は tools/build-production-html.js が生成する成果物。git の汚れではなく
  //   「最後に昇格したビルドと一致するか」で判定する（cutover 後も各 mission の validator を再実行できる）。
  const prodBuildRecord = rj(resolveProjectPath(path.join('data', 'reports', 'production-cutover-build.json')));
  const productionModified = (prodBuildRecord && prodBuildRecord.productionSha256)
    ? crypto.createHash('sha256').update(fs.readFileSync(resolveProjectPath(path.join('public', 'osaka_3d_buildings.html')))).digest('hex') !== prodBuildRecord.productionSha256
    : gitClean('public/osaka_3d_buildings.html') === false;
  const protectedModified = gitClean('public/osaka_3d_buildings.fullward-v3.html') === false;
  if (productionModified) errors.push('§0: production HTML が変更されている');
  if (protectedModified) errors.push('§0: protected HTML が変更されている');

  const RESULT = errors.length ? 'FAIL' : 'PASS';
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32S', RESULT,
    classification: errors.length ? 'PRODUCTION_DATA_INTEGRITY_FAILED' : 'PRODUCTION_DATA_INTEGRITY_READY',
    fakeYieldVisible, fakeRentVisible, fakeNoteVisible, fakeFloorCountVisible,
    unsupportedTownChomeVisible, propertyCardFieldsHaveRealSource,
    buildingV2Mutation, roadV3Mutation, projectionMutation, placementMutation,
    productionModified, protectedModified,
    qaSitesOk, factsCoverAll, cardFieldsDocumented, removedFields: provRemoved,
    heightBasisCounts: facts.stat.byBasis, storeysAvailable: facts.stat.withStoreys,
    fieldChecks, errors, warnings,
  };
  await writeJson(F.out, out);
  return out;
}

if (isMainModule(import.meta.url)) {
  validateProductionDataIntegrity().then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o.RESULT === 'PASS' ? 0 : 1); })
    .catch((e) => { console.error(e); process.exit(1); });
}
