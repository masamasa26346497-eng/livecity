// Mission 108: read-only helpers for verifying PRIVATE PLATEAU 2025 archives. No writes outside the caller-given empty dir.
// Nothing here prints, logs, or serialises the token. Token is only ever put in an Authorization header sent to api.github.com.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const DATA_REPO = 'masamasa26346497-eng/livecity-3d-data';
export const TAG = 'plateau2025-converted';
export const ALLOWED_WARDS = ['nishi', 'fukushima', 'yodogawa']; // Mission108 scope; widening requires a new reviewed mission
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024 - 1;
export const MAX_ENTRIES = 20000;
export const MAX_UNPACKED_BYTES = 1500 * 1024 * 1024;

export const assetName = (ward) => 'plateau2025-' + ward + '.tar.gz';
export const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
export function sha256File(f) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n;
  try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export function validateWards(list) {
  const seen = new Set();
  for (const w of list) {
    if (!/^[a-z]+$/.test(w)) throw new Error('invalid ward token');
    if (!ALLOWED_WARDS.includes(w)) throw new Error('ward not in Mission108 scope: ' + w);
    if (seen.has(w)) throw new Error('duplicate ward: ' + w);
    seen.add(w);
  }
  if (!list.length) throw new Error('no wards');
  return list;
}

// Entry-name policy: relative, no "..", no NUL/backslash, no drive letters.
export function unsafeName(name) {
  if (typeof name !== 'string' || !name.length) return 'empty name';
  if (name.includes('\0') || name.includes('\\')) return 'NUL/backslash';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  if (name.split('/').some((s) => s === '..')) return 'path traversal';
  return null;
}

// Parse `tar -tzvf` (GNU) verbose lines. Only regular files and directories are accepted: symlinks, hardlinks, devices, fifos are refused.
export function parseTarListing(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([-dlhcbps])[rwxsStT-]{9}\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/);
    if (!m) throw new Error('unparseable tar listing line');
    const name = m[3];
    if (m[1] === 'l' || m[1] === 'h' || / -> | link to /.test(name)) throw new Error('link entry refused');
    entries.push({ type: m[1], size: Number(m[2]), name });
  }
  return entries;
}
export function checkEntries(entries) {
  if (entries.length === 0) throw new Error('empty archive');
  if (entries.length > MAX_ENTRIES) throw new Error('too many entries');
  let total = 0;
  for (const e of entries) {
    if (e.type !== '-' && e.type !== 'd') throw new Error('special entry type refused: ' + e.type);
    const bad = unsafeName(e.name);
    if (bad) throw new Error('unsafe entry name (' + bad + ')');
    total += e.size;
  }
  if (total > MAX_UNPACKED_BYTES) throw new Error('unpacked size too large');
  return { count: entries.length, bytes: total };
}
export function tarList(file) {
  const r = spawnSync('tar', ['-tzvf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('tar listing failed');
  return r.stdout;
}
// Extract into an EMPTY directory only. After extraction, re-walk and reject any symlink / escape.
export function safeExtract(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length) throw new Error('destination not empty');
  const info = checkEntries(parseTarListing(tarList(file)));
  const r = spawnSync('tar', ['-xzf', file, '-C', dest, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tar extract failed');
  const root = fs.realpathSync(dest);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new Error('symlink after extract');
      if (e.isDirectory()) walk(p); else if (!e.isFile()) throw new Error('special file after extract');
      if (!fs.realpathSync(p).startsWith(root)) throw new Error('escaped destination');
    }
  };
  walk(dest);
  return info;
}
export function findTilesetRoot(dest) {
  if (fs.existsSync(path.join(dest, 'tileset.json'))) return dest;
  const subs = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (subs.length === 1 && fs.existsSync(path.join(dest, subs[0].name, 'tileset.json'))) return path.join(dest, subs[0].name);
  throw new Error('tileset.json not found at archive root');
}

// tileset.json / GLB integrity. Content URIs must be relative, stay inside root, exist, and be valid GLB (magic glTF v2, header length == file length).
export function verifyTilesetDir(root) {
  const out = { ok: true, errors: [], tilesets: 0, glbs: 0, glbBytes: 0 };
  const err = (m) => { out.ok = false; if (out.errors.length < 20) out.errors.push(m); };
  const rootReal = fs.realpathSync(root);
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const bad = unsafeName(rel);
    if (bad) return err('unsafe uri: ' + bad);
    const p = path.resolve(rootReal, rel);
    if (!p.startsWith(rootReal + path.sep)) return err('uri escapes root');
    if (!fs.existsSync(p)) return err('missing: ' + rel);
    if (/\.json$/.test(rel)) {
      let j;
      try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return err('bad json: ' + rel); }
      if (!j.asset || !j.root) return err('not a tileset: ' + rel);
      out.tilesets++;
      const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
      const walk = (t) => {
        const u = t.content && (t.content.uri || t.content.url);
        if (u) { if (/^[a-z]+:/i.test(u)) err('absolute uri'); else visit(path.posix.normalize(path.posix.join(dir, u))); }
        for (const c of t.children || []) walk(c);
      };
      walk(j.root);
    } else if (/\.glb$/.test(rel)) {
      const b = fs.readFileSync(p);
      if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) return err('invalid glb: ' + rel);
      out.glbs++;
      out.glbBytes += b.length;
    }
  };
  visit('tileset.json');
  const srcP = path.join(root, 'source.json');
  if (fs.existsSync(srcP)) {
    const s = JSON.parse(fs.readFileSync(srcP, 'utf8'));
    if (String(s.vintage) !== '2025') err('source vintage != 2025');
    if (String(s.wardCode).startsWith('27999')) err('expo ward refused');
    out.sourceWardCode = s.wardCode;
  } else err('source.json missing');
  for (const d of ['attrs', 'ids']) if (!fs.existsSync(path.join(root, d))) err(d + '/ missing');
  if (out.glbs === 0) err('no GLB content');
  return out;
}

// ---- GitHub release access (read-only GET). The token only goes to api.github.com in an Authorization header. ----
export async function ghGet(url, token, accept = 'application/vnd.github+json') {
  if (!/^https:\/\/api\.github\.com\//.test(url)) throw new Error('refusing non-api URL');
  return fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: accept, 'User-Agent': 'livecity-mission108' }, redirect: 'manual' });
}
export async function getRelease(token, repo = DATA_REPO, tag = TAG) {
  const rr = await ghGet('https://api.github.com/repos/' + repo, token);
  if (rr.status !== 200) throw new Error('repo GET HTTP ' + rr.status);
  const rj = await rr.json();
  if (rj.visibility !== 'private') throw new Error('data repo is not private');
  const r = await ghGet('https://api.github.com/repos/' + repo + '/releases/tags/' + tag, token);
  if (r.status !== 200) throw new Error('release GET HTTP ' + r.status);
  return r.json();
}
// Download one asset to file. The redirect target (signed URL on another host) is fetched WITHOUT the Authorization header.
export async function downloadAsset(token, asset, file, repo = DATA_REPO) {
  if (asset.size > MAX_ARCHIVE_BYTES) throw new Error('asset too large');
  let res = await ghGet('https://api.github.com/repos/' + repo + '/releases/assets/' + asset.id, token, 'application/octet-stream');
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc || !/^https:\/\//.test(loc)) throw new Error('bad redirect');
    res = await fetch(loc, { headers: { 'User-Agent': 'livecity-mission108' } });
  }
  if (res.status !== 200) throw new Error('asset GET HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== asset.size) throw new Error('asset size mismatch');
  fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
  return buf.length;
}
