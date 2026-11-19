#!/usr/bin/env node
// Mission 87: 24 区 PLATEAU 2025 変換済み建物成果物の GitHub Releases 永続保管（pack / upload / verify / status）。
//   node tools/mission87-persist.mjs status
//   node tools/mission87-persist.mjs pack   --ward fukushima [--root temp/mission80]
//   node tools/mission87-persist.mjs upload --ward fukushima --execute [--allow-public]   (既定は dry-run。公開リポジトリは --allow-public が無いと拒否)
//   node tools/mission87-persist.mjs verify --ward fukushima        (Release から再取得して sha256 と tar 内容を検証)
// 通常 Git には一切追加しない（アーカイブは temp/mission87、gitignore 済み）。区別 manifest のみ data/reports/mission87/ に残す。
// 対象は公式大阪市 27100 / 2025 の建物変換物（tileset/glb/ids/attrs/source/build-report）のみ。万博 27999・写真・秘密情報は拒否。
// 変換済みであることの記録であり、実ブラウザ受入（Mission86）ではない。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TAG = 'plateau2025-converted';
export const MANIFEST = 'data/reports/mission87/storage-manifest.json';
export const ARCHIVE_DIR = 'temp/mission87/archives';
export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024 - 1; // GitHub release asset 上限 2GiB 未満
export const ALLOWED_TOP = new Set(['tileset.json', 'source.json', 'build-report.json']);
export const ALLOWED_DIRS = new Set(['ids', 'attrs']);
// Mission 100: alignment.json is written by tools/mission79-build-ward-2025.cjs (road-vs-building orientation scan; numbers only).
// Exact-name, schema-validated optional file (NOT a wildcard). crosswalk.* / legacy-only-ids.json stay "unexpected".
export const VALIDATED_TOP = new Set(['alignment.json']);
const ALIGN_KEYS = new Set(['roadPolygons', 'buildingPoints', 'skipped', 'candidates', 'bestTransform', 'orientationOk', 'margin']);
const ALIGN_TRANSFORMS = ['identity', 'flipX', 'flipZ', 'rot180', 'swapXZ'];
export function validateAlignment(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > 65536) throw new Error('alignment.json invalid size');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('alignment.json not an object');
  for (const k of Object.keys(j)) if (!ALIGN_KEYS.has(k)) throw new Error('alignment.json unexpected key: ' + k);
  if (j.skipped !== undefined && typeof j.skipped !== 'string') throw new Error('alignment.json skipped invalid');
  for (const k of ['roadPolygons', 'buildingPoints', 'margin']) if (j[k] !== undefined && !Number.isFinite(j[k])) throw new Error('alignment.json ' + k + ' invalid');
  if (j.skipped === undefined) {
    if (!j.candidates || typeof j.candidates !== 'object') throw new Error('alignment.json candidates missing');
    for (const [n, c] of Object.entries(j.candidates)) {
      if (!ALIGN_TRANSFORMS.includes(n) || !c || !Number.isFinite(c.hits) || !Number.isFinite(c.hitRatePct) || Object.keys(c).length !== 2) throw new Error('alignment.json candidate invalid: ' + n);
    }
    if (!ALIGN_TRANSFORMS.includes(j.bestTransform) || typeof j.orientationOk !== 'boolean') throw new Error('alignment.json result invalid');
  }
  return j;
}
export const DENY = /(\.env|secret|token|apikey|api_key|photo|google|\.pem|\.key)/i;

export function validWard(w) { return typeof w === 'string' && /^[a-z]+$/.test(w); }
export function assetName(ward) { return 'plateau2025-' + ward + '.tar.gz'; }
export function sha256File(f) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(f)); return h.digest('hex'); }

// 成果物ディレクトリの内容を検査し、同梱ファイル一覧を返す。違反は throw（黙って除外しない）。
export function inspectOut(dir) {
  if (!fs.existsSync(path.join(dir, 'tileset.json'))) throw new Error('tileset.json not found: ' + dir);
  const src = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
  if (String(src.wardCode).startsWith('27999')) throw new Error('expo (27999) is excluded');
  if (String(src.vintage) !== '2025') throw new Error('vintage is not 2025: ' + src.vintage);
  const files = []; let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DENY.test(e.name)) throw new Error('denied name: ' + e.name);
    if (e.isDirectory()) {
      if (!ALLOWED_DIRS.has(e.name) && !/^(glb|tiles|lod|content)$/.test(e.name)) throw new Error('unexpected dir: ' + e.name);
      const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, x.name); if (DENY.test(x.name)) throw new Error('denied name: ' + p); if (x.isDirectory()) walk(p); else { files.push(path.relative(dir, p)); bytes += fs.statSync(p).size; } } };
      walk(path.join(dir, e.name));
    } else if (VALIDATED_TOP.has(e.name) && e.isFile()) { validateAlignment(path.join(dir, e.name)); files.push(e.name); bytes += fs.statSync(path.join(dir, e.name)).size; }
    else if (ALLOWED_TOP.has(e.name) || /\.glb$/.test(e.name)) { files.push(e.name); bytes += fs.statSync(path.join(dir, e.name)).size; }
    else throw new Error('unexpected file: ' + e.name);
  }
  return { wardCode: String(src.wardCode), vintage: src.vintage || null, files: files.length, bytes };
}

export function loadManifest() { return fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { tag: TAG, wards: {} }; }
export function saveManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  const tmp = MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 2)); fs.renameSync(tmp, MANIFEST); // atomic
}

export function pack(ward, root) {
  if (!validWard(ward)) throw new Error('invalid ward');
  const dir = path.join(root, 'out', ward + '-2025');
  const info = inspectOut(dir);
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const out = path.join(ARCHIVE_DIR, assetName(ward));
  if (fs.existsSync(out)) throw new Error('archive exists, not overwriting: ' + out);
  const r = spawnSync('tar', ['-czf', out, '-C', dir, '.'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar failed');
  const bytes = fs.statSync(out).size;
  if (bytes > MAX_ASSET_BYTES) throw new Error('archive exceeds release asset limit: ' + bytes);
  const m = loadManifest();
  m.wards[ward] = { ...(m.wards[ward] || {}), ward, wardCode: info.wardCode, vintage: info.vintage, files: info.files, srcBytes: info.bytes, asset: assetName(ward), archiveBytes: bytes, sha256: sha256File(out), status: 'packed', browserAccepted: false };
  saveManifest(m); return m.wards[ward];
}

export const TOKEN_ENV = 'LIVECITY_3D_DATA_TOKEN';
export function validRepo(r) { return typeof r === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r); }
// 明示 repo のときは専用 token (fine-grained PAT) だけを gh に渡す。token 値はログに出さない。
function gh(args, repo) {
  const env = Object.assign({}, process.env);
  if (repo) {
    if (!process.env[TOKEN_ENV]) throw new Error(TOKEN_ENV + ' is not set: refusing (no fallback to other credentials)');
    env.GH_TOKEN = process.env[TOKEN_ENV]; delete env.GITHUB_TOKEN;
  }
  const r = spawnSync('gh', args, { encoding: 'utf8', env });
  const scrub = (t) => (repo ? String(t || '').split(env.GH_TOKEN).join('***') : String(t || ''));
  return { code: r.status === null ? 1 : r.status, out: scrub(r.stdout) + scrub(r.stderr) };
}

export function upload(ward, { execute = false, allowPublic = false, repo = null } = {}) {
  if (repo !== null && !validRepo(repo)) throw new Error('invalid --repo (owner/name)');
  if (repo && allowPublic) throw new Error('--allow-public cannot be combined with an explicit --repo: private is mandatory');
  const m = loadManifest(); const e = m.wards[ward];
  if (!e || !fs.existsSync(path.join(ARCHIVE_DIR, e.asset))) throw new Error('pack first: ' + ward);
  const f = path.join(ARCHIVE_DIR, e.asset);
  if (sha256File(f) !== e.sha256) throw new Error('local archive hash changed since pack');
  if (!execute) { console.log('[87] dry-run: would upload ' + e.asset + ' (' + e.archiveBytes + ' bytes) to release ' + TAG); return { dryRun: true }; }
  const R = repo ? ['--repo', repo] : [];
  const vis = gh(['repo', 'view'].concat(repo ? [repo] : [], ['--json', 'visibility']), repo);
  if (vis.code !== 0) throw new Error('gh repo view failed: ' + vis.out.slice(0, 200));
  const visibility = JSON.parse(vis.out).visibility;
  if (visibility !== 'PRIVATE' && !allowPublic) throw new Error('repository visibility is ' + visibility + ': upload would publish data. Owner approval required (--allow-public).');
  const rel = gh(['release', 'view', TAG, '--json', 'assets'].concat(R), repo);
  if (rel.code !== 0) {
    const c = gh(['release', 'create', TAG, '--prerelease', '--title', 'PLATEAU 2025 converted building artifacts', '--notes', 'Official Osaka City (27100) PLATEAU 2025 converted 3D Tiles. Not browser-accepted. Source: MLIT Project PLATEAU.'].concat(R), repo);
    if (c.code !== 0) throw new Error('release create failed: ' + c.out.slice(0, 200));
  } else {
    const a = (JSON.parse(rel.out).assets || []).find((x) => x.name === e.asset);
    // Mission 95: 同サイズ一致だけでは再開済みと判定しない。再取得した実体の sha256 が一致した場合だけスキップ。
    if (a) {
      fs.mkdirSync('temp/mission87/resume', { recursive: true }); const rd = fs.mkdtempSync(path.join('temp/mission87/resume', ward + '-'));
      const dl = gh(['release', 'download', TAG, '--pattern', e.asset, '--dir', rd].concat(R), repo);
      if (dl.code === 0 && fs.existsSync(path.join(rd, e.asset)) && sha256File(path.join(rd, e.asset)) === e.sha256) { console.log('[87] already uploaded (sha256 matches), skip; run verify'); e.status = 'uploaded'; saveManifest(m); return { skipped: true, by: 'sha256' }; }
      console.log('[87] remote asset exists but sha256 differs or is unreadable: re-uploading');
    }
  }
  const u = gh(['release', 'upload', TAG, f, '--clobber'].concat(R), repo);
  if (u.code !== 0) throw new Error('upload failed: ' + u.out.slice(0, 200));
  e.status = 'uploaded'; e.visibility = visibility; e.repo = repo || null; e.uploadedAt = new Date().toISOString(); saveManifest(m);
  return { uploaded: true };
}

export function verify(ward, { repo = null } = {}) {
  if (repo !== null && !validRepo(repo)) throw new Error('invalid --repo (owner/name)');
  if (repo) { const v = gh(['repo', 'view', repo, '--json', 'visibility'], repo); if (v.code !== 0 || JSON.parse(v.out).visibility !== 'PRIVATE') throw new Error('target repo is not verified PRIVATE'); }
  const m = loadManifest(); const e = m.wards[ward];
  if (!e) throw new Error('not in manifest: ' + ward);
  const d = path.join('temp/mission87/verify', ward); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, e.asset);
  if (fs.existsSync(f)) throw new Error('verify dir not empty, remove it first: ' + d);
  const g = gh(['release', 'download', TAG, '--pattern', e.asset, '--dir', d].concat(repo ? ['--repo', repo] : []), repo);
  if (g.code !== 0) throw new Error('download failed: ' + g.out.slice(0, 200));
  const h = sha256File(f); if (h !== e.sha256) throw new Error('sha256 mismatch: ' + h);
  const t = spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }); if (t.status !== 0 || !/tileset\.json/.test(t.stdout)) throw new Error('archive content check failed');
  e.status = 'verified'; e.verifiedAt = new Date().toISOString(); saveManifest(m); return { ward, sha256: h };
}

export function status() {
  const m = loadManifest(); const w = Object.values(m.wards);
  return { stored: w.filter((x) => x.status === 'verified').length, uploaded: w.filter((x) => x.status === 'uploaded' || x.status === 'verified').length, packed: w.length, of: 24, browserAccepted: 0 };
}

function main() {
  const a = process.argv.slice(2); const cmd = a[0];
  const opt = (k, d = null) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const root = opt('root', 'temp/mission80'); const ward = opt('ward');
  if (cmd === 'status') console.log(JSON.stringify(status()));
  else if (cmd === 'pack') console.log(JSON.stringify(pack(ward, root)));
  else if (cmd === 'upload') console.log(JSON.stringify(upload(ward, { execute: a.includes('--execute'), allowPublic: a.includes('--allow-public'), repo: opt('repo') })));
  else if (cmd === 'verify') console.log(JSON.stringify(verify(ward, { repo: opt('repo') })));
  else { console.error('usage: status|pack|upload|verify --ward <id>'); process.exit(2); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
