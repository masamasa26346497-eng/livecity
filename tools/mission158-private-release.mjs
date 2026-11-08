#!/usr/bin/env node
// Mission 158: private GitHub Release store for generated 3D Tiles. READ-ONLY by default.
//   node tools/mission158-private-release.mjs auth-test
//   node tools/mission158-private-release.mjs audit [--tag plateau2025-converted] [--inspect <ward>|all] [--out temp/mission158]
//   node tools/mission158-private-release.mjs put --ward sumiyoshi --dir temp/mission156/sumiyoshi/tiles --tag m158-<id>   (dry-run unless --confirm-write)
//   node tools/mission158-private-release.mjs get --tag m158-<id> --ward sumiyoshi --out temp/mission158/restore
// Credential: env LIVECITY_3D_DATA_TOKEN (fine-grained PAT limited to the private repo: Contents read [+write for put]) — falls back to
// GITHUB_TOKEN, which in the public repo's Actions cannot see the private repo (expected 404). The token is never printed or written.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  PRIVATE_REPO, PROTECTED_TAGS, assertWritableTag, assertWritableRepo, classifyAuth, summarizeAssets, inspectEntries,
  buildStoreManifest, sha256, verifyRoundTrip, wardFromAsset,
} from './mission158/lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d = null) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : d; };
const flag = (k) => rest.includes('--' + k);
const TOKEN = process.env.LIVECITY_3D_DATA_TOKEN || process.env.GITHUB_TOKEN || '';
const tokenSource = process.env.LIVECITY_3D_DATA_TOKEN ? 'LIVECITY_3D_DATA_TOKEN' : (process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'none');
const repo = opt('repo', PRIVATE_REPO);
const API = 'https://api.github.com';
const H = (extra = {}) => Object.assign({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'livecity-m158' }, TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}, extra);
const WARDS = Object.keys(JSON.parse(fs.readFileSync(new URL('../data/reports/mission156/plan.json', import.meta.url), 'utf8')).wards);

async function api(p, init = {}) { return fetch(p.startsWith('http') ? p : API + p, Object.assign({ headers: H() }, init)); }
const out = (o) => console.log(JSON.stringify(o, null, 1));

async function authTest() {
  const r = await api('/repos/' + repo);
  let body = null; try { body = await r.json(); } catch (e) { /* ignore */ }
  // facts only; token value never printed. PASS is claimed only if the private repo AND its Release are really readable.
  const secretConfigured = !!process.env.LIVECITY_3D_DATA_TOKEN; // boolean only
  const res = { repo, tokenSource, secretConfigured, status: r.status, ...classifyAuth(r.status, body) };
  if (r.status === 200) {
    const rr = await api(`/repos/${repo}/releases/tags/plateau2025-converted`);
    res.releaseReadStatus = rr.status;
    res.releaseReadable = rr.status === 200;
    if (rr.status === 200) res.releaseAssets = ((await rr.json()).assets || []).length;
  }
  res.verdict = !secretConfigured ? 'NOT-TESTED: LIVECITY_3D_DATA_TOKEN is not set (GITHUB_TOKEN cannot see the private repo). Run: node tools/mission158-private-release.mjs setup'
    : (res.releaseReadable ? 'READ-OK' : 'READ-FAILED (see status / releaseReadStatus)');
  out(res);
  return res.verdict === 'READ-OK';
}

function setup() {
  console.log(`LIVECITY_3D_DATA_TOKEN setup (one-time, by the repo owner; these tools never print the value)
1. GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token.
2. Resource owner: the account owning ${PRIVATE_REPO}. Repository access: "Only select repositories" -> ${PRIVATE_REPO} ONLY.
3. Repository permissions: Contents = Read-only (enough for audit/get/preview). Add Read and write only when you want 'put' (new m158-* tags).
   Metadata (read) is added automatically. Nothing else. Short expiry (e.g. 30 days).
4. Public repo masamasa26346497-eng/livecity > Settings > Secrets and variables > Actions > New repository secret: LIVECITY_3D_DATA_TOKEN.
   Never paste the token in a comment, issue, commit, or workflow file.
5. Verify (read-only): node tools/mission158-private-release.mjs auth-test   -> must print verdict READ-OK.
   Then: node tools/mission158-private-release.mjs audit --inspect all --out temp/mission158
Notes: fork PRs do not receive secrets (expected). These tools never overwrite or delete existing releases.`);
}

async function getRelease(tag) {
  const r = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`release lookup HTTP ${r.status}`);
  return r.json();
}

async function downloadAsset(a, dest) {
  const r = await fetch(`${API}/repos/${repo}/releases/assets/${a.id}`, { headers: H({ accept: 'application/octet-stream' }), redirect: 'follow' });
  if (!r.ok) throw new Error(`asset ${a.name} HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { size: buf.length, sha256: sha256(buf) };
}

async function audit() {
  const tag = opt('tag', 'plateau2025-converted');
  const rel = await getRelease(tag);
  if (!rel) { out({ tag, repo, error: 'release not found or repository not accessible with this credential', tokenSource }); process.exit(3); }
  const sum = summarizeAssets(rel.assets, WARDS);
  const res = { repo, tag: rel.tag_name, name: rel.name, draft: rel.draft, prerelease: rel.prerelease, updated: rel.published_at, protected: PROTECTED_TAGS.includes(rel.tag_name), tokenSource, assets: sum.count, totalBytes: sum.totalBytes, unrecognised: sum.unrecognised, notUploaded: sum.notUploaded, rows: sum.rows };
  const ins = opt('inspect');
  if (ins) {
    const targets = ins === 'all' ? rel.assets.filter((a) => wardFromAsset(a.name)) : rel.assets.filter((a) => wardFromAsset(a.name) === ins);
    res.inspected = [];
    for (const a of targets) {
      // each archive in its own new empty directory; tar run with args only (no shell); nothing is extracted except tileset.json
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm158-' + wardFromAsset(a.name) + '-'));
      const file = path.join(dir, 'a.tar.gz');
      try {
        const dl = await downloadAsset(a, file);
        const names = execFileSync('tar', ['-tzf', file], { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean);
        const tsName = names.find((n) => /(^|\/)tileset\.json$/.test(n) && !/\/.+\/.+\/tileset\.json$/.test(n)) || names.find((n) => /tileset\.json$/.test(n));
        let ts = null;
        if (tsName) ts = JSON.parse(execFileSync('tar', ['-xzOf', file, tsName], { maxBuffer: 1 << 28 }).toString());
        const info = inspectEntries(names, ts);
        const digestOk = a.digest ? a.digest === 'sha256:' + dl.sha256 : null;
        res.inspected.push({ ward: wardFromAsset(a.name), size: dl.size, sha256: dl.sha256, digestMatchesGitHub: digestOk, tileset: tsName || null, ...info, missingCount: info.missing.length, missing: info.missing.slice(0, 5) });
      } catch (e) { res.inspected.push({ ward: wardFromAsset(a.name), error: String(e.message || e).slice(0, 200) }); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
  const o = opt('out'); if (o) { fs.mkdirSync(o, { recursive: true }); fs.writeFileSync(path.join(o, 'audit.json'), JSON.stringify(res, null, 1)); }
  out(res);
}

function listFiles(dir) { const o = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? w(p) : o.push(p); } })(dir); return o; }

async function put() {
  const ward = opt('ward'), dir = opt('dir'), tag = opt('tag');
  if (!ward || !dir || !tag) throw new Error('need --ward --dir --tag');
  assertWritableTag(tag); assertWritableRepo(repo);
  if (!fs.existsSync(path.join(dir, 'tileset.json'))) throw new Error('no tileset.json in ' + dir);
  const files = listFiles(dir);
  const tgz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm158-put-')), `m158-${ward}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.']);
  const buf = fs.readFileSync(tgz);
  const prog = JSON.parse(fs.readFileSync('data/reports/mission156/progress.json', 'utf8')).wards[ward] || {};
  const man = buildStoreManifest({ ward, wardCode: prog.wardCode, sourceVersion: 'plateau-27100-osaka-shi-2025', sourceEtag: prog.sourceEtag, buildings: prog.convertedBuildings, tiles: prog.tiles, ids: prog.convertedBuildings,
    files: [{ name: path.basename(tgz), size: buf.length, sha256: sha256(buf) }] });
  const plan = { mode: flag('confirm-write') ? 'WRITE' : 'dry-run', repo, tag, ward, localFiles: files.length, archiveBytes: buf.length, archiveSha256: man.files[0].sha256, manifest: man };
  if (!flag('confirm-write')) { out(plan); return; }
  if (!TOKEN || tokenSource === 'GITHUB_TOKEN') throw new Error('write requires LIVECITY_3D_DATA_TOKEN (private-repo fine-grained PAT with Contents: write)');
  const existing = await getRelease(tag);
  let rel = existing;
  if (existing && existing.assets.some((a) => a.name === path.basename(tgz))) throw new Error('check-before-write: asset already exists in ' + tag + ' (no overwrite)');
  if (!rel) {
    const r = await api(`/repos/${repo}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag, body: 'Mission 158 generated LOD1 3D Tiles (PLATEAU, private store, not published)', prerelease: true }) });
    if (!r.ok) throw new Error('create release HTTP ' + r.status);
    rel = await r.json();
  }
  const uploaded = [];
  try {
    for (const [name, data, type] of [[path.basename(tgz), buf, 'application/gzip'], [`m158-${ward}.manifest.json`, Buffer.from(JSON.stringify(man, null, 1)), 'application/json']]) {
      const u = rel.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name);
      const r = await fetch(u, { method: 'POST', headers: H({ 'content-type': type, 'content-length': String(data.length) }), body: data });
      if (!r.ok) throw new Error(`upload ${name} HTTP ${r.status}`);
      uploaded.push((await r.json()).id);
    }
    // re-read and compare hash
    const rel2 = await getRelease(tag);
    const a = rel2.assets.find((x) => x.name === path.basename(tgz));
    const tmp = path.join(path.dirname(tgz), 'back.tar.gz');
    const back = await downloadAsset(a, tmp);
    const bad = verifyRoundTrip(man.files, { [path.basename(tgz)]: back });
    if (bad.length) throw new Error('round-trip mismatch ' + JSON.stringify(bad));
    out({ ...plan, manifest: undefined, result: 'written+verified', assets: uploaded.length, roundTrip: 'sha256 identical' });
  } catch (e) {
    // partial abort: remove ONLY assets uploaded by this run in this new m158 tag
    for (const id of uploaded) await api(`/repos/${repo}/releases/assets/${id}`, { method: 'DELETE' }).catch(() => {});
    out({ result: 'aborted', cleaned: uploaded.length, error: String(e.message).slice(0, 200) }); process.exit(4);
  }
}

async function get() {
  const tag = opt('tag'), ward = opt('ward'), o = opt('out', 'temp/mission158/restore');
  const rel = await getRelease(tag);
  if (!rel) throw new Error('release not accessible: ' + tag);
  const a = rel.assets.find((x) => x.name === `m158-${ward}.tar.gz`) || rel.assets.find((x) => wardFromAsset(x.name) === ward);
  const m = rel.assets.find((x) => x.name === `m158-${ward}.manifest.json`);
  if (!a) throw new Error('ward asset not found');
  const dir = path.join(o, ward); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(o, ward + '.tar.gz'); const dl = await downloadAsset(a, tgz);
  if (a.digest && a.digest !== 'sha256:' + dl.sha256) throw new Error('digest mismatch vs GitHub');
  if (m) { const mt = path.join(o, ward + '.manifest.json'); await downloadAsset(m, mt); const man = JSON.parse(fs.readFileSync(mt, 'utf8')); const bad = verifyRoundTrip(man.files, { [a.name]: dl }); if (bad.length) throw new Error('manifest mismatch ' + JSON.stringify(bad)); }
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  out({ restored: dir, size: dl.size, sha256: dl.sha256 });
}

try {
  if (cmd === 'setup') setup();
  else if (cmd === 'auth-test') process.exit((await authTest()) ? 0 : 3);
  else if (cmd === 'audit') await audit();
  else if (cmd === 'put') await put();
  else if (cmd === 'get') await get();
  else { console.error('usage: setup | auth-test | audit | put | get'); process.exit(2); }
} catch (e) { console.error(JSON.stringify({ error: String(e.message || e).slice(0, 300) })); process.exit(1); }
