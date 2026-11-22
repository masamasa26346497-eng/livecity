#!/usr/bin/env node
// Mission 135: 24区 Cesium ビューア用の「127.0.0.1 専用・読み取り専用」サーバー。
//   node tools/mission135/server.js --buildings-root <dir> --layers-root <dir> [--port 8135]
//   buildings-root: <ward>25/{tileset.json,*.glb,ids/*.json}（PR #24 の ext-3dtiles 配置と同じ）
//   layers-root   : <ward>/layers/{roads,waterways,water-surface}.json（build-ward-layers.js の出力）
// 公開しない: loopback bind、Host/Origin 検査、GET/HEAD のみ、許可ファイル名の allowlist、symlink 拒否、public/ には何も書かない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWards } from '../lib/ward-layer-adapter.js';
import { DEFAULT_POLYGONS } from './build-ward-layers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC = new Map([['/', 'mission135-ward-viewer.html'], ['/mission135-ward-viewer.html', 'mission135-ward-viewer.html'], ['/mission135-ward-viewer.js', 'mission135-ward-viewer.js']]);
const NAME = /^[a-z0-9-]+$/;
const BUILDING_FILE = /^(tileset\.json|[A-Za-z0-9_.-]+\.glb|ids\/[A-Za-z0-9_.-]+\.json|attrs\/[A-Za-z0-9_.-]+\.json)$/;
const FOOTPRINT_FILE = /^(manifest\.json|tile_-?\d+_-?\d+\.json)$/;
const LAYER_FILE = /^(roads|waterways|water-surface)\.json$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary' };

export function hostOk(host, port) { return host === `127.0.0.1:${port}` || host === `localhost:${port}`; }
export function originOk(origin, port) { return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`; }

const lst = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
/** root 配下の通常ファイルのみ（symlink・root 外は null）。 */
export function safeFile(root, rel) {
  if (!root || rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) return null;
  const f = path.join(root, ...rel.split('/')), st = lst(f);
  if (!st || !st.isFile() || st.isSymbolicLink()) return null;
  try { const rr = fs.realpathSync(root); return fs.realpathSync(f).startsWith(rr + path.sep) ? f : null; } catch { return null; }
}

/**
 * 建物 3D Tiles の置き場の規約差を吸収する。tileset.json を含む次のいずれかの相対ディレクトリを返す:
 *   <ward>25 / _x_<ward> / _x_<ward>/<ward>25 / _x_<ward>/<単一サブディレクトリ>（restore-release-assets.js の展開結果）
 * 見つからなければ null（空ディレクトリへの偽成功を返さない）。tileset.json は通常ファイル必須（safeFile）。
 */
export function resolveBuildingDir(root, ward) {
  if (!root || !NAME.test(ward || '')) return null;
  const cands = [`${ward}25`, `_x_${ward}`, `_x_${ward}/${ward}25`];
  try {
    const sub = fs.readdirSync(path.join(root, `_x_${ward}`), { withFileTypes: true }).filter((d) => d.isDirectory() && NAME.test(d.name));
    if (sub.length === 1) cands.push(`_x_${ward}/${sub[0].name}`);
  } catch { /* none */ }
  for (const c of cands) if (safeFile(root, `${c}/tileset.json`)) return c;
  return null;
}
/** 実フットプリント（public/map-data/osaka-city/buildings/osaka-<ward>/）の有無と宣言棟数。 */
export function footprintInfo(root, ward) {
  const f = safeFile(root, `osaka-${ward}/manifest.json`); if (!f) return null;
  try { const m = JSON.parse(fs.readFileSync(f, 'utf8')); return { totalBuildings: m.totalBuildings, tileCount: m.tileCount }; } catch { return null; }
}

/** 区一覧 + 各区のデータ有無（存在確認のみ。内容は読まない）。 */
export function wardIndex({ buildingsRoot, layersRoot, footprintsRoot, polygons = DEFAULT_POLYGONS }) {
  return loadWards(polygons).map((w) => ({
    wardId: w.wardId, wardCode: w.wardCode, wardName: w.wardName, bbox: w.bbox,
    available: {
      buildings: !!resolveBuildingDir(buildingsRoot, w.wardId),
      buildingFootprints: !!footprintInfo(footprintsRoot, w.wardId),
      roads: !!safeFile(layersRoot, `${w.wardId}/layers/roads.json`),
      waterways: !!safeFile(layersRoot, `${w.wardId}/layers/waterways.json`),
      waterSurface: !!safeFile(layersRoot, `${w.wardId}/layers/water-surface.json`),
    },
  }));
}

export function createServer({ buildingsRoot, layersRoot, footprintsRoot, polygons, getPort, log }) {
  return http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method');
    if (!hostOk(req.headers.host, getPort()) || !originOk(req.headers.origin, getPort())) return send(403, 'forbidden');
    let u; try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return send(404, 'not found'); }
    let file = null, status = 404;
    if (STATIC.has(u)) file = safeFile(PUBLIC_DIR, STATIC.get(u));
    else if (u === '/index.json') {
      status = 200; if (log) log({ u, s: 200 });
      return send(200, JSON.stringify({ wards: wardIndex({ buildingsRoot, layersRoot, footprintsRoot, polygons }) }), MIME['.json']);
    } else if (u.startsWith('/ext-3dtiles/')) {
      const parts = u.slice('/ext-3dtiles/'.length).split('/'), name = parts.shift(), rel = parts.join('/');
      if (NAME.test(name || '')) {
        if (name.endsWith('25') && BUILDING_FILE.test(rel)) { const dir = resolveBuildingDir(buildingsRoot, name.slice(0, -2)); if (dir) file = safeFile(buildingsRoot, `${dir}/${rel}`); }
        else if (!name.endsWith('25') && rel.startsWith('footprints/') && FOOTPRINT_FILE.test(rel.slice(11))) file = safeFile(footprintsRoot, `osaka-${name}/${rel.slice(11)}`);
        else if (!name.endsWith('25') && rel.startsWith('layers/') && LAYER_FILE.test(rel.slice(7))) file = safeFile(layersRoot, `${name}/${rel}`);
      }
    }
    if (log && u.startsWith('/ext-3dtiles/')) log({ u, s: file ? 200 : 404 });
    if (!file) return send(status, 'not found'); // 欠落は必ず 404（偽の 200/空 JSON を返さない）
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

export async function listen(opts, port = 0) {
  let actual = port;
  const srv = createServer({ ...opts, getPort: () => actual });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r)); // loopback のみ
  actual = srv.address().port;
  return { srv, port: actual, url: `http://127.0.0.1:${actual}/` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
  if (!opt('layers-root') || !(opt('buildings-root') || opt('footprints-root'))) { console.error('usage: --layers-root <dir> [--buildings-root <dir>] [--footprints-root <public/map-data/osaka-city/buildings>] [--port 8135]'); process.exit(2); }
  const s = await listen({ buildingsRoot: opt('buildings-root') ? path.resolve(opt('buildings-root')) : null, layersRoot: path.resolve(opt('layers-root')), footprintsRoot: opt('footprints-root') ? path.resolve(opt('footprints-root')) : null }, Number(opt('port') || 8135));
  console.log(`Mission135 viewer (127.0.0.1 only, read-only): ${s.url}`);
}
