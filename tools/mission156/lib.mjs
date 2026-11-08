// Mission 156 pure helpers (no network). Used by tools/mission156-run-all.mjs and tests/mission156.test.cjs.
export const DECLARED_24WARD_BUILDINGS = 574213; // Mission155 declared (past record, NOT a measurement)

// Rights gate: only PLATEAU Osaka-shi (27100) official package under the PLATEAU site policy, hosted on the official CMS.
// Expo site (27999) and anything unlicensed is refused.
export function rightsGate(lock) {
  const reasons = [];
  const name = (lock && lock.package && lock.package.name) || '';
  const url = (lock && lock.resource && lock.resource.url) || '';
  if (!/^plateau-27100-osaka-shi-\d{4}$/.test(name)) reasons.push('package is not plateau-27100-osaka-shi-YYYY: ' + name);
  if (/27999/.test(name) || /27999/.test(url)) reasons.push('27999 (Expo site, non-commercial) refused');
  if (!lock || !lock.license || lock.license.id !== 'plateau') reasons.push('license id is not plateau');
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { reasons.push('resource url invalid'); }
  if (host && host !== 'assets.cms.plateau.reearth.io') reasons.push('unofficial host: ' + host);
  if (!lock || !lock.attribution) reasons.push('attribution missing');
  if (!lock || !lock.http || !lock.http.etag) reasons.push('etag missing (cannot detect source drift)');
  return { ok: reasons.length === 0, reasons };
}

// Detects the same canonical id appearing in more than one ward (or twice in one). idsByWard: {ward: string[]}
export function findDuplicateIds(idsByWard) {
  const seen = new Map();
  const dups = [];
  for (const [ward, ids] of Object.entries(idsByWard)) {
    for (const id of ids) {
      if (seen.has(id)) dups.push({ id, wards: [seen.get(id), ward] });
      else seen.set(id, ward);
    }
  }
  return dups;
}

// Separate indicators per ward. 'complete' needs ALL: full mesh coverage, buildings>0, orientation ok, HTTP200 verified, browser verified.
export function wardStatus(p) {
  if (!p) return 'pending';
  if (p.error) return 'failed';
  if (!p.sourceBuildings && !p.convertedBuildings) return 'pending';
  const full = p.meshesFetched === p.meshesPlanned && p.meshesPlanned > 0;
  if (!full || !(p.convertedBuildings > 0)) return 'partial';
  if (p.orientationOk !== true) return 'converted-orientation-unverified';
  if (!p.http200Verified) return 'converted';
  if (!p.browserVerified) return 'served';
  return 'complete';
}

export function summarize(progress, planned) {
  const wards = Object.keys(Object.assign({}, planned || {}, progress));
  const rows = wards.map((w) => Object.assign({ ward: w, status: wardStatus(progress[w]) }, progress[w] || {}));
  const total = rows.reduce((n, r) => n + (r.convertedBuildings || 0), 0);
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  return {
    wardsTotal: rows.length, byStatus: by, convertedBuildingsTotal: total,
    declaredPast: DECLARED_24WARD_BUILDINGS, measuredVsDeclaredPct: +(total / DECLARED_24WARD_BUILDINGS * 100).toFixed(2),
    allComplete: rows.length === 24 && rows.every((r) => r.status === 'complete'),
    rows,
  };
}

// Resume: skip a ward only if recorded as fully converted, same source ETag, and the output dir still exists.
export function shouldSkip(p, etag, outExists) {
  return !!(p && !p.error && p.sourceEtag === etag && p.meshesFetched === p.meshesPlanned && p.convertedBuildings > 0 && outExists);
}
