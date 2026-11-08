// Mission 158 pure helpers (no network, no secrets). Used by tools/mission158-private-release.mjs and tests.
import crypto from 'node:crypto';

export const PROTECTED_TAGS = ['plateau2025-converted']; // existing private Release: never written, overwritten or deleted
export const PRIVATE_REPO = 'masamasa26346497-eng/livecity-3d-data';
export const PUBLIC_REPO = 'masamasa26346497-eng/livecity';
export const NEW_TAG_PREFIX = 'm158-'; // generated tilesets go only to tags like m158-<runId>-<ward>

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// Write guard: a tag is writable only if it uses the m158- prefix and is not protected. Pure + synchronous so tests can pin it.
export function assertWritableTag(tag) {
  if (PROTECTED_TAGS.includes(tag)) throw new Error('refused: protected tag ' + tag);
  if (!/^m158-[A-Za-z0-9._-]{1,80}$/.test(tag || '')) throw new Error('refused: tag must match m158-<id> (got ' + tag + ')');
  return true;
}

// Never allow writes to the public repo, and never when the target is not exactly the private data repo.
export function assertWritableRepo(repo) {
  if (repo === PUBLIC_REPO) throw new Error('refused: public repo');
  if (repo !== PRIVATE_REPO) throw new Error('refused: write only allowed to ' + PRIVATE_REPO);
  return true;
}

// Authorization test outcome → facts only (never includes the token). status: HTTP status of GET /repos/{repo}.
export function classifyAuth(status, body) {
  if (status === 200) {
    const perm = (body && body.permissions) || {};
    return { ok: true, read: true, write: !!(perm.push || perm.admin), private: body && body.private === true };
  }
  if (status === 401) return { ok: false, reason: '401 bad/expired credential' };
  if (status === 403) return { ok: false, reason: '403 credential lacks permission or rate limited' };
  if (status === 404) return { ok: false, reason: '404 repo not visible to this credential (or no credential)' };
  return { ok: false, reason: 'HTTP ' + status };
}

// ward from plateau2025-<ward>.tar.gz
export function wardFromAsset(name) {
  const m = /^plateau2025-([a-z0-9-]+)\.tar\.gz$/.exec(name || '');
  return m ? m[1] : null;
}

// Summarise a release asset list (GitHub REST release.assets[]).
export function summarizeAssets(assets, expectedWards = []) {
  const rows = (assets || []).map((a) => ({ name: a.name, ward: wardFromAsset(a.name), size: a.size, digest: a.digest || null, updated: a.updated_at, state: a.state }));
  const have = new Set(rows.map((r) => r.ward).filter(Boolean));
  return {
    count: rows.length, totalBytes: rows.reduce((n, r) => n + (r.size || 0), 0), rows,
    missingWards: expectedWards.filter((w) => !have.has(w)),
    unrecognised: rows.filter((r) => !r.ward).map((r) => r.name),
    notUploaded: rows.filter((r) => r.state && r.state !== 'uploaded').map((r) => r.name),
  };
}

// Archive inspection from a list of entry names (tar listing) + parsed tileset: counts tiles, flags missing tile files.
export function inspectEntries(entryNames, tilesetJson) {
  const have = new Set(entryNames.map((n) => n.replace(/^\.\//, '')));
  const refs = [];
  const walk = (t) => { if (!t) return; const c = t.content && (t.content.uri || t.content.url); if (c) refs.push(c); (t.children || []).forEach(walk); };
  walk(tilesetJson && tilesetJson.root);
  const glb = [...have].filter((n) => /\.(glb|b3dm)$/.test(n));
  return { entries: have.size, glbFiles: glb.length, tileRefs: refs.length, missing: refs.filter((r) => !have.has(r) && !have.has('tiles/' + r)) };
}

// Store manifest written next to uploaded assets.
export function buildStoreManifest({ ward, wardCode, sourceEtag, sourceVersion, files, buildings, tiles, ids, lod = 1 }) {
  return {
    schema: 'livecity-mission158-store/1', ward, wardCode,
    source: { package: sourceVersion, etag: sourceEtag, host: 'assets.cms.plateau.reearth.io' },
    license: { id: 'plateau', attribution: '国土交通省 Project PLATEAU', commercial: true, attributionRequired: true },
    lod: { level: lod, lod2: false }, buildings, tiles, canonicalIds: ids ? { scheme: 'gml:id', count: ids } : null,
    files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })), published: false,
  };
}

// Strict browser verdict: the tileset must really draw. drawCommands===0/null is NOT ok (Kita regression from Mission 157).
export function strictBrowserOk(b) {
  // Mission 160: when the page reports tileset-only counters they must be > 0 (globe/skybox commands do not prove buildings are drawn)
  const tsOk = b && b.tilesetCommandsMax !== undefined ? Number(b.tilesetCommandsMax) > 0 && Number(b.selectedTilesMax) > 0 : true;
  return !!(b && b.status === 'ok' && b.gl && (b.jsErrors || []).length === 0 && b.tilesLoaded && Number(b.drawCommands) > 0 && tsOk);
}

// Compare re-downloaded asset to the manifest record. Returns list of mismatches (empty = identical).
export function verifyRoundTrip(manifestFiles, downloaded) {
  const bad = [];
  for (const f of manifestFiles) {
    const d = downloaded[f.name];
    if (!d) bad.push({ name: f.name, why: 'missing' });
    else if (d.size !== f.size) bad.push({ name: f.name, why: 'size', expected: f.size, got: d.size });
    else if (d.sha256 !== f.sha256) bad.push({ name: f.name, why: 'sha256' });
  }
  return bad;
}
