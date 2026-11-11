#!/usr/bin/env node
// Mission 166: LOD2 GLB を private GitHub Release へ「新しいタグで」永続化する(既定 dry-run)。
//   node tools/lod2/lod2-persist.mjs plan   [--dir temp/lod2-all] [--tag lod2-osaka2025-YYYYMMDD]
//   node tools/lod2/lod2-persist.mjs upload --execute   (LIVECITY_3D_DATA_TOKEN が必要。無ければ何も読み書きせず終了コード 3)
// 安全条件: 対象リポジトリが private であることを API で確認、タグが既存なら拒否(上書き禁止)、公開 repo / --allow-public は不可。
// トークン値は出力しない。GLB は 1 アーカイブ(tar.gz)に固めて 2GiB 未満を検証、sha256 を manifest に記録する。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PRIVATE_REPO = 'masamasa26346497-eng/livecity-3d-data';
export const MAX_ASSET = 2 * 1024 * 1024 * 1024 - 1;
export const defaultTag = (d = new Date()) => 'lod2-osaka2025-' + d.toISOString().slice(0, 10).replace(/-/g, '');
export function validateTag(tag, existing = []) {
  if (!/^lod2-osaka2025-[0-9A-Za-z._-]{1,40}$/.test(tag)) throw new Error('tag must match lod2-osaka2025-*');
  if (existing.includes(tag)) throw new Error('tag already exists; refusing to overwrite: ' + tag);
  return tag;
}
export function planUpload(dir) {
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error('manifest.json not found in ' + dir);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const files = [];
  for (const a of m.assets || []) {
    const p = path.join(dir, a.glb.path);
    if (path.relative(dir, p).startsWith('..')) throw new Error('path escapes dir: ' + a.glb.path);
    if (!fs.existsSync(p)) throw new Error('missing GLB: ' + a.glb.path);
    const b = fs.readFileSync(p), sha = crypto.createHash('sha256').update(b).digest('hex');
    if (sha !== a.glb.sha256) throw new Error('sha256 mismatch: ' + a.glb.path);
    files.push({ path: a.glb.path, bytes: b.length, sha256: sha });
  }
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_ASSET) throw new Error('asset exceeds 2GiB; split per mesh');
  return { manifest: m, files, totalBytes: total, count: files.length };
}
const gh = (args, token) => spawnSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token } });
function main() {
  const a = process.argv.slice(2), cmd = a[0], g = (k, d = null) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : d);
  const dir = path.resolve(g('--dir', 'temp/lod2-all')), tag = g('--tag', defaultTag());
  const plan = planUpload(dir);
  console.log(JSON.stringify({ cmd, tag, repo: PRIVATE_REPO, count: plan.count, totalBytes: plan.totalBytes, dryRun: !a.includes('--execute') }));
  if (cmd !== 'upload' || !a.includes('--execute')) return 0;
  const token = process.env.LIVECITY_3D_DATA_TOKEN;
  if (!token) { console.error('LIVECITY_3D_DATA_TOKEN が未設定のため、private repo へは何も読み書きしません。'); return 3; }
  const info = gh(['api', 'repos/' + PRIVATE_REPO, '--jq', '.private'], token);
  if (info.status !== 0) { console.error('private repo に認証できません(HTTP 404/403)。書き込みは行いません。'); return 3; }
  if (info.stdout.trim() !== 'true') { console.error('対象 repo が private ではありません。拒否。'); return 4; }
  const tags = gh(['api', 'repos/' + PRIVATE_REPO + '/releases', '--jq', '.[].tag_name'], token).stdout.split('\n').filter(Boolean);
  validateTag(tag, tags);
  const arc = path.join(dir, tag + '.tar.gz');
  const t = spawnSync('tar', ['-czf', arc, '-C', dir, 'manifest.json', 'tiles'], { encoding: 'utf8' });
  if (t.status !== 0) { console.error('tar failed'); return 5; }
  const r = gh(['release', 'create', tag, arc, '--repo', PRIVATE_REPO, '--title', tag, '--notes', 'PLATEAU Osaka 2025 LOD2 GLB tiles (private). See manifest.json.'], token);
  if (r.status !== 0) { console.error('release create failed'); return 5; }
  console.log('uploaded ' + tag + ' sha256=' + crypto.createHash('sha256').update(fs.readFileSync(arc)).digest('hex'));
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { process.exitCode = main(); } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
}
