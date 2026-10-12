// tools/experiments/mission37g_regression_qa.mjs
// [Mission 37G] 24 区ページで、住吉区の既存機能（3D 建物の実クリック→写真、課金ガード）が退行していないことを確かめる。
//   37E の QA スクリプトを、37G ページの URL に向けて再利用する（本体は変更しない）。
//   結果は 37E のレポート場所に書かれるため、実行後に data/reports/mission37g-wards/ へ複製する。
//   使い方: node tools/experiments/mission37g_regression_qa.mjs [photo|billing]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' };
const root = path.resolve('public');
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(8139, r));
process.env.MISSION37E_URL = 'http://localhost:8139/mission37g-osaka-24ward-mvp.html' + (process.argv[3] || process.env.MISSION37G_QUERY || '');
process.env.MISSION37E_ONLY = '東福寺,阪和病院';
const kind = process.argv[2] || 'photo';
try {
  await import(kind === 'billing' ? './mission37e_billing_guard_qa.mjs' : './mission37e_photo_display_qa.mjs');
} finally { srv.close(); }
