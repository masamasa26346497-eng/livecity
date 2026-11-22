#!/usr/bin/env node
// Mission 137: owner 限定 workflow（Mission129）または restore-release-assets.js が展開した建物 3D Tiles の一時ディレクトリを検査し、
// Mission135 ビューア/E2E にそのまま渡せるか（--buildings-root）を区ごとに報告する。読み取り専用・ネットワークなし・コピー/symlink なし。
//   node tools/mission137/link-restored-buildings.js --root <展開先dir> [--out new.json]
// 検査（区ごと）: 配置規約の解決(resolveBuildingDir) / tileset.json の JSON 妥当性 / 全 content uri(.glb) の実在 /
//   各 GLB に ids/<glb basename>.json sidecar があるか（無ければ canonicalId クリックは「未解決」になる）/ GLB が glTF 2.0 ヘッダか。
// 出力に秘密値は含めない。private データそのものは出力しない（件数・ファイル名・状態のみ）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWards } from '../lib/ward-layer-adapter.js';
import { resolveBuildingDir, safeFile } from '../mission135/server.js';
import { DEFAULT_POLYGONS } from '../mission135/build-ward-layers.js';

const MAX_TILES = 100000;

function contentUris(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 64 || out.length > MAX_TILES) return out;
  const c = node.content || (Array.isArray(node.contents) ? null : null);
  if (c && typeof c.uri === 'string') out.push(c.uri);
  if (c && typeof c.url === 'string') out.push(c.url);
  for (const k of node.contents || []) if (k && typeof k.uri === 'string') out.push(k.uri);
  for (const ch of node.children || []) contentUris(ch, out, depth + 1);
  return out;
}

export function inspectWard(root, wardId) {
  const dir = resolveBuildingDir(root, wardId);
  if (!dir) return { wardId, state: 'not-acquired', reason: 'tileset.json not found under any accepted layout' };
  const ts = safeFile(root, `${dir}/tileset.json`);
  let json;
  try { json = JSON.parse(fs.readFileSync(ts, 'utf8')); } catch (e) { return { wardId, state: 'rejected', dir, reason: 'tileset.json invalid JSON' }; }
  if (!json.root) return { wardId, state: 'rejected', dir, reason: 'tileset.json has no root' };
  const uris = contentUris(json.root), glbs = [], problems = [], noSidecar = [];
  for (const u of uris) {
    if (/^[a-z]+:|^\/|\.\./.test(u)) { problems.push(`unsafe-uri:${u.slice(0, 40)}`); continue; }
    if (u.endsWith('.json')) { problems.push(`external-tileset-not-supported:${u.slice(0, 40)}`); continue; }
    if (!u.endsWith('.glb')) { problems.push(`unsupported-content:${u.slice(0, 40)}`); continue; }
    const f = safeFile(root, `${dir}/${u}`);
    if (!f) { problems.push(`missing-glb:${u}`); continue; }
    const head = Buffer.alloc(12); const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1', 0, 4) !== 'glTF' || head.readUInt32LE(4) !== 2) { problems.push(`bad-glb-header:${u}`); continue; }
    glbs.push(u);
    const base = path.posix.basename(u).replace(/\.[^.]+$/, '');
    if (!safeFile(root, `${dir}/ids/${base}.json`)) noSidecar.push(u);
  }
  // サーバー allowlist: GLB/ids は ^[A-Za-z0-9_.-]+$ （サブディレクトリ付き content uri は配信されない）
  const unservable = glbs.filter((u) => !/^[A-Za-z0-9_.-]+\.glb$/.test(u));
  const state = problems.length || !glbs.length ? 'rejected' : 'ready';
  return { wardId, state, dir, glbCount: glbs.length, withoutIdSidecar: noSidecar.length, unservableByViewerServer: unservable.length, canonicalIdClick: glbs.length && !noSidecar.length ? 'available' : 'unresolved(no sidecar)', problems: problems.slice(0, 10), reason: !glbs.length && !problems.length ? 'no glb content' : undefined };
}

export function inspectAll(root, polygons = DEFAULT_POLYGONS) {
  const wards = loadWards(polygons).map((w) => inspectWard(root, w.wardId));
  return { schema: 'livecity.mission137.restored-buildings/1', root: path.basename(path.resolve(root)), ready: wards.filter((w) => w.state === 'ready').length, total: wards.length, wards };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  if (!opt('root')) { console.error('usage: --root <restored buildings dir> [--out new.json]'); process.exit(2); }
  const rep = inspectAll(path.resolve(opt('root')));
  if (opt('out')) { fs.mkdirSync(path.dirname(path.resolve(opt('out'))), { recursive: true }); fs.writeFileSync(opt('out'), JSON.stringify(rep, null, 1), { flag: 'wx' }); }
  for (const w of rep.wards) console.log(`${w.wardId}: ${w.state}${w.glbCount != null ? ` glb=${w.glbCount} sidecar-missing=${w.withoutIdSidecar}` : ''}${w.reason ? ' (' + w.reason + ')' : ''}${w.problems && w.problems.length ? ' problems=' + w.problems.join(';') : ''}`);
  console.log(`ready ${rep.ready}/${rep.total}. 表示: npm run wards:viewer -- --buildings-root ${opt('root')} --layers-root <layers>`);
  process.exit(0);
}
