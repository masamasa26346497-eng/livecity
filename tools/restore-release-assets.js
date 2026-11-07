#!/usr/bin/env node
// Mission 133: private Release asset（plateau2025-<ward>.tar.gz）を READ のみで取得し、空の一時ディレクトリへ安全に展開する。
//   LIVECITY_3D_DATA_READ_TOKEN=... node tools/restore-release-assets.js --out <空ディレクトリ> [--wards kita,chuo] [--dry-run]
// 厳守: GET のみ / トークンは環境変数のみ（ログ・ファイルに出さない）/ 展開先は --out 配下の _x_<ward>/ のみ /
//       絶対パス・".." を含むアーカイブは拒否 / アップロード・artifact・cache なし / 既定は --dry-run 相当の一覧のみ(--fetch で取得)。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DATA_REPO = 'masamasa26346497-eng/livecity-3d-data';
export const TAG = 'plateau2025-converted';

export function isUnsafeTarMember(name) {
  const n = String(name).replace(/\\/g, '/');
  return n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..');
}
export function assetNameFor(ward) { return `plateau2025-${ward}.tar.gz`; }
export function validWardKey(w) { return /^[a-z0-9-]+$/.test(w); }

async function api(url, token, accept) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'follow' });
  return res;
}

async function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const out = get('--out');
  const wards = (get('--wards') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const doFetch = a.includes('--fetch');
  const token = process.env.LIVECITY_3D_DATA_READ_TOKEN;
  if (!token) { console.error('LIVECITY_3D_DATA_READ_TOKEN が未設定です（READ専用トークン。値は出力しません）'); process.exit(2); }
  if (!out) { console.error('--out <空ディレクトリ> が必要です'); process.exit(2); }
  if (wards.some((w) => !validWardKey(w))) { console.error('不正な --wards 値'); process.exit(2); }
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  if (fs.readdirSync(outAbs).length) { console.error('--out は空のディレクトリである必要があります'); process.exit(2); }

  const rel = await api(`https://api.github.com/repos/${DATA_REPO}/releases/tags/${TAG}`, token, 'application/vnd.github+json');
  console.log(`release GET -> HTTP ${rel.status}`);
  if (!rel.ok) process.exit(1);
  const assets = (await rel.json()).assets || [];
  console.log(`assets: ${assets.length} / 合計 ${(assets.reduce((s, x) => s + (x.size || 0), 0) / 1e6).toFixed(1)} MB`);
  const targets = wards.length ? wards.map(assetNameFor) : assets.map((x) => x.name).filter((n) => /^plateau2025-[a-z0-9-]+\.tar\.gz$/.test(n));
  for (const name of targets) {
    const as = assets.find((x) => x.name === name);
    if (!as) { console.log(`[${name}] asset missing`); continue; }
    console.log(`[${name}] ${as.size} bytes${doFetch ? '' : ' (一覧のみ。--fetch で取得)'}`);
    if (!doFetch) continue;
    const ward = name.replace(/^plateau2025-/, '').replace(/\.tar\.gz$/, '');
    const tgz = path.join(outAbs, `${ward}.tgz`);
    const res = await api(as.url, token, 'application/octet-stream');
    if (!res.ok) { console.log(`[${ward}] download failed HTTP ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (as.size && buf.length !== as.size) { console.log(`[${ward}] size mismatch ${buf.length}/${as.size}`); continue; }
    fs.writeFileSync(tgz, buf);
    const list = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const members = (list.stdout || '').split('\n').filter(Boolean);
    if (list.status !== 0 || members.some(isUnsafeTarMember)) { console.log(`[${ward}] REFUSED: unreadable or unsafe members`); fs.rmSync(tgz); continue; }
    const dest = path.join(outAbs, `_x_${ward}`);
    fs.mkdirSync(dest);
    const ex = spawnSync('tar', ['-xzf', tgz, '--no-same-owner', '-C', dest]);
    fs.rmSync(tgz);
    console.log(`[${ward}] members=${members.length} extract=${ex.status === 0 ? 'ok' : 'FAILED'} tileset.json=${members.filter((m) => m.endsWith('tileset.json')).length}`);
  }
  console.log(`\n展開先(ローカルのみ・未公開): ${outAbs}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch((e) => { console.error(e.message); process.exit(1); });
