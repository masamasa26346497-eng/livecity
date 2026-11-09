// Issue #52: 公開写真候補の検証・重複除去・保留（純関数・外部通信なし）。
// 入力の候補は fixture / 既存キャッシュ / 将来の取得結果のいずれでもよい。取得そのものはこのモジュールの責務外。
import { classifyLicense } from './photo-license.mjs';

// route: 'wikidata-p18' | 'commons-category' | 'commons-p180' | 'osm-explicit' | 'name-search' | 'geosearch'
const DIRECT_ROUTES = new Set(['wikidata-p18', 'commons-category', 'commons-p180', 'osm-explicit']);
const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const commonsFile = (c) => {
  const m = String(c.sourcePageUrl || '').match(/File:([^?#]+)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/_/g, ' '); } catch (e) { return m[1].replace(/_/g, ' '); }
};

// 照合根拠: 距離だけでは確定しない。建物IDの直接リンク、または 名称 + (住所|被写体) の二つ以上が必要。
export function evaluateEvidence(c) {
  const ev = c.evidence || {};
  const direct = DIRECT_ROUTES.has(c.route) && ev.explicitLink === true; // Wikidata/OSM の明示リンクで建物と結ばれている
  const signals = ['name', 'address', 'subject'].filter((k) => ev[k] === true);
  if (ev.nameConflict === true) return { ok: false, reason: 'name-conflict' };
  if (direct && ev.subject !== false) return { ok: true, basis: 'explicit-link' };
  if (signals.includes('name') && signals.length >= 2) return { ok: true, basis: signals.join('+') };
  if (!signals.length && typeof ev.distanceM === 'number') return { ok: false, reason: 'distance-only' };
  return { ok: false, reason: 'insufficient-evidence' };
}

// existing: 既存索引 { byCanonicalId }。relocated: { canonicalId: [除外ファイル名] }。
export function importCandidates(candidates, existing, opts) {
  const o = opts || {};
  const relocated = o.relocated || {};
  const seenFiles = new Map(); // file -> canonicalId（既存 + 今回採用）
  for (const [id, e] of Object.entries((existing && existing.byCanonicalId) || {})) {
    for (const p of e.photos || []) { const f = commonsFile(p); if (f) seenFiles.set(f, id); }
  }
  const existingFiles = new Set(seenFiles.keys());
  const adopted = [];
  const held = [];
  const dup = [];
  // 同名施設: 同じ名称で異なる canonicalId に同一ファイルが向く場合は、どちらにも確定しない
  const claimants = new Map();
  for (const c of candidates) { const f = commonsFile(c); if (!f) continue; if (!claimants.has(f)) claimants.set(f, new Set()); claimants.get(f).add(c.canonicalId); }

  for (const c of candidates) {
    const f = commonsFile(c);
    const hold = (reason) => held.push({ canonicalId: c.canonicalId, file: f, route: c.route, reason });
    if (!c.canonicalId) { hold('no-canonical-id'); continue; }
    if (!f) { hold('no-commons-file'); continue; }
    if (!https(c.thumbnailUrl) || !https(c.sourcePageUrl)) { hold('non-https-or-missing-url'); continue; }
    const lic = classifyLicense(c.license);
    if (!lic.ok) { hold('license-' + lic.kind); continue; }
    if (lic.attribution && !String(c.author || '').trim()) { hold('attribution-required-author-missing'); continue; }
    if ((relocated[c.canonicalId] || []).includes(f)) { hold('relocation-excluded'); continue; }
    if (claimants.get(f).size > 1) { hold('same-file-multiple-buildings'); continue; }
    const ev = evaluateEvidence(c);
    if (!ev.ok) { hold(ev.reason); continue; }
    if (seenFiles.has(f)) {
      // 同じ Commons ファイルを複数経路・既存と二重計上しない
      if (seenFiles.get(f) === c.canonicalId) { dup.push({ canonicalId: c.canonicalId, file: f, route: c.route, duplicateOf: existingFiles.has(f) ? 'existing-index' : 'earlier-candidate' }); }
      else hold('file-already-assigned-to-other-building');
      continue;
    }
    seenFiles.set(f, c.canonicalId);
    const dateOk = /^\d{4}(-\d{2})?(-\d{2})?$/.test(String(c.takenAt || '')) && https(c.dateEvidenceUrl);
    adopted.push({
      canonicalId: c.canonicalId, file: f, route: c.route, evidenceBasis: ev.basis, kind: c.kind || 'unclassified',
      photo: { thumbnailUrl: c.thumbnailUrl, imageUrl: c.imageUrl, width: c.width, height: c.height, source: 'wikimedia-commons',
        title: 'File:' + f, sourcePageUrl: c.sourcePageUrl, license: c.license, licenseUrl: c.licenseUrl, author: c.author, kind: c.kind },
      takenAt: dateOk ? c.takenAt : null, dateEvidenceUrl: dateOk ? c.dateEvidenceUrl : null, // アップロード日は撮影日にしない
      fetchedAt: c.fetchedAt || null
    });
  }
  const buildingsBefore = new Set(Object.entries((existing && existing.byCanonicalId) || {}).filter(([, e]) => (e.photos || []).length).map(([k]) => k));
  const buildingsAfter = new Set([...buildingsBefore, ...adopted.map((a) => a.canonicalId)]);
  const byReason = {};
  held.forEach((h) => { byReason[h.reason] = (byReason[h.reason] || 0) + 1; });
  return {
    adopted, held, duplicates: dup,
    stats: { candidates: candidates.length, adopted: adopted.length, held: held.length, duplicates: dup.length, heldByReason: byReason,
      buildingsWithPhotoBefore: buildingsBefore.size, buildingsWithPhotoAfter: buildingsAfter.size, netNewBuildings: buildingsAfter.size - buildingsBefore.size,
      adoptedWithKnownDate: adopted.filter((a) => a.takenAt).length }
  };
}
