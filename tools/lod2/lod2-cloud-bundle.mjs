#!/usr/bin/env node
// Mission 196-cloud: Vercel Preview 用の最小・静的配信バンドル(区限定)を、既存の公式 PLATEAU 2025 生成物から作る。
//   入力(いずれも temp/、Git 管理外):
//     temp/mission79/<ward>-2025-ex/   補完 LOD1(LOD2 の gml:id だけ除外)  ← mission79-build-ward-2025.cjs --exclude-ids
//     temp/lod2-all/                   実 LOD2 (lod2-build-all.mjs)
//   出力: temp/cloud-bundle/ (そのまま静的ホスティングのルートにできる)。public/ には書かない。
// 旧 45D・旧年データは読まない(source.json の vintage:2025 でない区は拒否)。トークン/CLI 認証は一切扱わない。
//   node tools/lod2/lod2-cloud-bundle.mjs --wards kita,chuo [--out temp/cloud-bundle] [--allow-original] [--max-mb 120]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCK_PATH } from '../mission79-plateau2025-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const WARDS = opt('wards', 'kita,chuo').split(',').filter(Boolean);
const OUT = path.resolve(ROOT, opt('out', 'temp/cloud-bundle'));
const LOD2 = path.resolve(ROOT, opt('lod2-dir', 'temp/lod2-all'));
const MAX_MB = Number(opt('max-mb', 120));
const ALLOW_ORIGINAL = argv.includes('--allow-original');
const REPORT_PATH = opt('report', '');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const die = (m) => { console.error('[cloud-bundle] NG:', m); process.exit(2); };
if (OUT === ROOT || OUT.startsWith(path.join(ROOT, 'public'))) die('出力先が public/ またはリポジトリ直下です');
if (!/[\\/]temp[\\/]/.test(OUT + path.sep) && !argv.includes('--force-out')) die('出力先は temp/ 配下のみ(巨大生成物を Git に入れないため)');

const LOD1_ALLOWED = [/^tileset\.json$/, /^source\.json$/, /^build-report\.json$/, /^tiles$/, /^lod$/];
const regs = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const files = [];   // { path, bytes, sha256 }
const put = (rel, buf) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); files.push({ path: rel, bytes: buf.length, sha256: sha(buf) }); };
const copyTree = (src, rel, filter) => { for (const n of fs.readdirSync(src, { withFileTypes: true })) { if (filter && !filter(n.name)) continue; const s = path.join(src, n.name), r = rel + '/' + n.name; if (n.isDirectory()) copyTree(s, r); else if (n.isFile()) put(r, fs.readFileSync(s)); } };

// ---- 1) LOD1(区) ----
const wardInfo = [], regions = {}, EXCL = new Set();   // EXCL: 補完 LOD1 が除外した LOD2 ID(これを含む LOD2 タイルだけ同梱)
for (const id of WARDS) {
  const w = regs.find((x) => x.id === id); if (!w) die('registry に無い区: ' + id);
  const exDir = path.join(ROOT, 'temp/mission79', id + '-2025-ex'), origDir = path.join(ROOT, 'temp/mission79', id + '-2025');
  const variant = fs.existsSync(path.join(exDir, 'tileset.json')) ? 'complement(LOD2 ID除外)' : (ALLOW_ORIGINAL && fs.existsSync(path.join(origDir, 'tileset.json')) ? 'original(LOD2と二重描画あり)' : null);
  if (!variant) die(`${id}: 補完 LOD1 が未生成です(temp/mission79/${id}-2025-ex)。--allow-original で元 LOD1 を許可できます`);
  const src = variant.startsWith('comp') ? exDir : origDir;
  const sj = JSON.parse(fs.readFileSync(path.join(src, 'source.json'), 'utf8'));
  if (String(sj.vintage) !== '2025' || String(sj.wardCode) !== String(w.code)) die(`${id}: source.json が 2025 / wardCode ${w.code} ではありません(vintage=${sj.vintage}, wardCode=${sj.wardCode})。旧データは取り込みません`);
  const rep = JSON.parse(fs.readFileSync(path.join(src, 'build-report.json'), 'utf8'));
  const rel = 'ext-3dtiles/' + id;
  copyTree(src, rel, (n) => LOD1_ALLOWED.some((re) => re.test(n)));
  const ts = JSON.parse(fs.readFileSync(path.join(src, 'tileset.json'), 'utf8'));
  regions[id] = ts.root && ts.root.boundingVolume && ts.root.boundingVolume.region;
  { const ep = path.join(src, 'lod1-excluded-ids.json'); if (fs.existsSync(ep)) for (const x of JSON.parse(fs.readFileSync(ep, 'utf8')).ids) EXCL.add(x); }
  wardInfo.push({ ward: id, code: String(w.code), buildings: rep.totals && rep.totals.buildings, variant, vintage: sj.vintage, excludedLod2Ids: sj.counts && sj.counts.excludedForLod2 });
}
put('ext-3dtiles/index.json', JSON.stringify({ schema: 'livecity.cloud-static/1', kind: 'cloud-static', verified: false, provenance: 'plateau-2025-official-conversion', lod0Wards: [], layersWards: [], wards: wardInfo.map((w) => ({ ward: w.ward, code: w.code, buildings: w.buildings })) }));

// ---- 2) LOD2(区の範囲に交わるタイルだけ) ----
const man = JSON.parse(fs.readFileSync(path.join(LOD2, 'manifest.json'), 'utf8'));
const lod2Ts = JSON.parse(fs.readFileSync(path.join(LOD2, 'tileset.json'), 'utf8'));
const lod2Rep = JSON.parse(fs.readFileSync(path.join(LOD2, 'report.json'), 'utf8'));
const box = Object.values(regions).filter(Boolean).map((r) => ({ w: r[0], s: r[1], e: r[2], n: r[3] }));
const hit = (b) => box.some((r) => b.west * Math.PI / 180 <= r.e && b.east * Math.PI / 180 >= r.w && b.south * Math.PI / 180 <= r.n && b.north * Math.PI / 180 >= r.s);
const keep = new Map();   // glb name -> tile(full)
const fps = [];
for (const mesh of man.sourceGml.map((g) => g.mesh)) {
  const p = path.join(LOD2, 'mesh-reports', mesh + '.json'); if (!fs.existsSync(p)) continue;
  for (const t of JSON.parse(fs.readFileSync(p, 'utf8')).tilesFull || []) if (hit(t.bbox) && (EXCL.size === 0 || t.ids.some((x) => EXCL.has(x)))) { keep.set(t.name, t); fps.push(...t.footprints); }
}
if (!keep.size) die('指定区に交わる LOD2 タイルがありません');
const nodes = (lod2Ts.root.children || []).map((m) => ({ ...m, children: (m.children || []).filter((c) => keep.has(path.basename(c.content.uri))) })).filter((m) => m.children.length);
const prunedTs = { ...lod2Ts, root: { ...lod2Ts.root, children: nodes } };
const keptNames = new Set(nodes.flatMap((m) => m.children.map((c) => path.basename(c.content.uri))));
for (const n of keptNames) put('lod2-preview/tiles/' + n, fs.readFileSync(path.join(LOD2, 'tiles', n)));
put('lod2-preview/tileset.json', JSON.stringify(prunedTs));
put('lod2-preview/footprints.json', JSON.stringify({ ids: [...keep.values()].flatMap((t) => t.ids), footprints: fps }));
const lod2Ids = [...keptNames].flatMap((n) => keep.get(n).ids);
const lod2Bytes = [...keptNames].reduce((n, k) => n + keep.get(k).bytes, 0);
put('lod2-preview/report.json', JSON.stringify({ ...lod2Rep, scope: 'cloud-bundle subset: ' + WARDS.join(','), converted: lod2Ids.length, lod1Remaining: null, glbBytes: lod2Bytes, meshes: [...new Set([...keptNames].map((n) => n.slice(0, 8)))], failed: [] }));
for (const [src, dst] of [['lod2-overlay.js', 'overlay.js'], ['lod2-clip-near.cjs', 'clipnear.js'], ['lod2-diagnose.js', 'diagnose.js']]) put('lod2-preview/' + dst, fs.readFileSync(path.join(__dirname, src)));

// ---- 3) 37G HTML: 配信用コピーのみ書き換える(public/ の原本は無変更) ----
let html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
const GATE = "/^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname)";
const patchGate = (anchor) => { const i = html.indexOf(anchor); if (i < 0) die('37G HTML の想定箇所が見つかりません: ' + anchor.slice(0, 40)); const j = html.lastIndexOf(GATE, i); if (j < 0 || i - j > 200) die('ゲート位置が想定と違います: ' + anchor.slice(0, 40)); html = html.slice(0, j) + 'true' + html.slice(j + GATE.length); };
patchGate("q.get('lod2') === '1'"); patchGate("get('nobuiltin') === '1'"); patchGate("get('ext45') !== '1'");
const DEF = "<script>(function(){var s=new URLSearchParams(location.search);if(!s.has('ext45')){var d={ext45:'1',nobuiltin:'1',lod2:'1',lod2ov:'1',lod2auto3d:'0',lod2fly:'0'};for(var k in d)if(!s.has(k))s.set(k,d[k]);history.replaceState(null,'',location.pathname+'?'+s.toString());}window.__lcCloud={bundle:'cloud-static',wards:" + JSON.stringify(WARDS) + "};})();</script>";
html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + DEF) : DEF + html;
put('mission37g-osaka-24ward-mvp.html', Buffer.from(html));
put('index.html', Buffer.from('<!doctype html><meta charset="utf-8"><title>Live City LOD2 preview</title><meta http-equiv="refresh" content="0;url=mission37g-osaka-24ward-mvp.html"><a href="mission37g-osaka-24ward-mvp.html">Live City</a>'));
// HTML が <script src> で参照する同梱 JS(コードのみ。データ JSON は含めない)
const srcs = [...html.matchAll(/<script[^>]+src="(?:\.\/)?([^":]+?\.js)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
const missing = [];
for (const s of new Set(srcs)) { const f = path.resolve(ROOT, 'public', s); if (!f.startsWith(path.join(ROOT, 'public') + path.sep)) continue; if (/local-config\.js$/.test(s)) continue; if (fs.existsSync(f)) put(s, fs.readFileSync(f)); else missing.push(s); }
// 区境界(国土数値情報 N03。出典明記が条件・ファイル内に source/license を保持)。37G の全域3D(allTick)が必須とするため同梱。
//   駅(OSM/ODbL)・地名・施設・Google Place ID 等は権利未確認のため同梱しない(画面では「未接続」になる)。
put('mission37g-data/osaka-24-wards.json', fs.readFileSync(path.join(ROOT, 'public/mission37g-data/osaka-24-wards.json')));
const EXCLUDED_DATA = ['mission145-data/stations-24.json (OSM/ODbL: 再配布条件を人が確認するまで除外)', 'mission145-data/towns-24.json (リポジトリに無い)', 'mission37d-data/* (施設・Google Place ID)', 'mission49/50-data (道路縁・河川: 出典未確認)', 'mission37c-layers (住吉サンプル)'];
{ const b = fs.readFileSync(path.join(OUT, 'mission37g-osaka-24ward-mvp.html'), 'utf8');
  const credit = '<div id="lc-cloud-credit" style="position:fixed;right:8px;bottom:4px;z-index:2147483000;font:11px/1.4 sans-serif;color:#cfd8e3;background:rgba(10,18,32,.7);padding:3px 8px;border-radius:4px;max-width:60vw">出典：国土交通省 Project PLATEAU（3D都市モデル 大阪市 2025）を加工して作成 / 行政区域：国土数値情報（国土交通省） / 検証用プレビュー（北区・中央区のみ）</div>';
  put('mission37g-osaka-24ward-mvp.html', Buffer.from(b.replace(/<\/body>/i, credit + '</body>'))); files.splice(files.findIndex((f, i, a) => f.path === 'mission37g-osaka-24ward-mvp.html'), 1); }
put('vercel.json', JSON.stringify({ cleanUrls: false, trailingSlash: false, headers: [
  { source: '/(.*)\\.glb', headers: [{ key: 'Content-Type', value: 'model/gltf-binary' }, { key: 'Cache-Control', value: 'public, max-age=3600' }] },
  { source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }] }, null, 1));

// ---- 4) 監査: サイズ・秘密情報・出典・権利 ----
const total = files.reduce((n, f) => n + f.bytes, 0);
const SECRET = [/AIza[0-9A-Za-z_-]{20,}/, /sk-[A-Za-z0-9]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /LIVECITY_3D_DATA_TOKEN\s*[:=]\s*['"]?\w{10,}/, /[A-Za-z]:\\\\Users\\\\/];
const secretHits = [];
for (const f of files) if (/\.(html|js|json|cjs)$/.test(f.path)) { const t = fs.readFileSync(path.join(OUT, f.path), 'utf8'); for (const re of SECRET) if (re.test(t)) secretHits.push({ file: f.path, pattern: String(re) }); }
const legacyHits = wardInfo.filter((w) => String(w.vintage) !== '2025');
const sizeByKind = (re) => files.filter((f) => re.test(f.path)).reduce((n, f) => n + f.bytes, 0);
const manifest = {
  schema: 'livecity-cloud-bundle/1', generatedAt: new Date().toISOString(), scope: { wards: WARDS, note: '梅田(北区)・中央区に限定。LOD2 は PLATEAU 2025 の 33 メッシュ(10,698 棟)のうち区に交わるタイルのみ。全棟 LOD2 ではない' },
  source: { package: lock.package?.name, license: lock.license?.title, attribution: lock.attribution, etag: lock.http?.etag, vintage: '2025', note: 'PLATEAU 公式配布 CityGML を Range 取得して変換。旧 45D / 旧年データは非使用' },
  rights: { status: 'attribution-required', basis: 'source-lock の license/attribution 欄(PLATEAU サイトポリシー: 商用可・出典表示)', confirmedByHuman: false, note: '公開前に出典表示(画面内)と 37G HTML 側の他データ(OSM/駅/写真等)の権利を人が確認すること。本バンドルは 37G HTML と同梱 JS のみで、data JSON(駅/地名/道路)は含めない' },
  wards: wardInfo, lod2: { tiles: keptNames.size, buildings: lod2Ids.length, glbBytes: lod2Bytes, idsUnique: new Set(lod2Ids).size === lod2Ids.length },
  sizes: { totalBytes: total, lod1Bytes: sizeByKind(/^ext-3dtiles\//), lod2Bytes: sizeByKind(/^lod2-preview\/tiles\//), fileCount: files.length, maxMb: MAX_MB },
  audit: { excludedData: EXCLUDED_DATA, includedNonPlateau: ['mission37g-data/osaka-24-wards.json (国土数値情報 N03, 出典明記)'], secretHits, legacyHits: legacyHits.length, missingScripts: missing, localOnlyDiag: '/__lod2/diag.json は静的配信では 404(オーバーレイは失敗を無視する想定。E2E で確認)' },
  env: { required: [], note: '環境変数・トークン不要。Vercel 側は Framework=Other、Build Command なし、Output Directory= このバンドルのルート' },
  files,
};
fs.writeFileSync(path.join(OUT, 'BUNDLE_MANIFEST.json'), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify({ ...manifest, files: undefined }, null, 1));
if (secretHits.length) die('秘密情報らしき文字列を検出: ' + JSON.stringify(secretHits));
if (total > MAX_MB * 1048576) die(`合計 ${(total / 1048576).toFixed(1)}MB が上限 ${MAX_MB}MB 超過`);
if (REPORT_PATH) { const slim = { ...manifest, files: files.length, filesSample: undefined }; fs.mkdirSync(path.dirname(path.resolve(ROOT, REPORT_PATH)), { recursive: true }); fs.writeFileSync(path.resolve(ROOT, REPORT_PATH), JSON.stringify(slim, null, 1)); }
console.log('[cloud-bundle] OK', (total / 1048576).toFixed(1) + 'MB', files.length + ' files');
