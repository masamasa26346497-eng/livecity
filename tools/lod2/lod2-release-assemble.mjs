#!/usr/bin/env node
// Mission 209: private Release の展開済み区アーカイブ(<root>/_x_<ward>/…, Mission129 の fetch ステップの出力)を、
// lod2-cloud-merge.mjs の --base が読む ext-3dtiles 形式(<out>/<ward>/{tileset.json,source.json,build-report.json,...})に整える。
// ネットワーク・トークン不使用(認証は workflow の固定 curl ステップだけ)。入力は読み取り専用、出力は temp/ または RUNNER_TEMP 配下のみ。
//   node tools/lod2/lod2-release-assemble.mjs --root "$RUNNER_TEMP/b21" --out "$RUNNER_TEMP/base24" [--report path] [--max-bytes N]
// 検証: 通常ファイル/ディレクトリのみ(symlink・hardlink 拒否)、パス逸脱なし、総量上限(zip bomb 対策)、tileset の content URI 実在、
// GLB ヘッダ、ids の重複。source.json/build-report.json が無い区は ids から合成し synthesized:true と vintageBasis を明記する(年版は Release タグ由来で、
// GML 由来の確認ではない)。区コード不一致・欠落は missing として残し、成功とは扱わない。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LAYOUT = require('../mission131/layout.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MAX_BYTES_DEFAULT = 4 * 1024 ** 3; // 区ごとではなく全体の展開後上限

/** 展開物を再帰走査して危険要素と総量を数える(純関数に近い。dir を読むだけ)。 */
export function scanTree(dir, { maxBytes = MAX_BYTES_DEFAULT, maxFiles = 200000 } = {}) {
  const r = { files: 0, bytes: 0, problems: [] };
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { r.problems.push('symlink: ' + path.relative(dir, p)); continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile()) { r.problems.push('special file: ' + path.relative(dir, p)); continue; }
      if (st.nlink > 1) r.problems.push('hardlink: ' + path.relative(dir, p));
      r.files++; r.bytes += st.size;
      if (r.files > maxFiles) { r.problems.push('too many files'); return; }
      if (r.bytes > maxBytes) { r.problems.push('size cap exceeded'); return; }
    }
  })(dir);
  return r;
}

/** tar -t の一覧テキスト(workflow 側で保存)に危険なメンバ名が無いか。 */
export function unsafeMembers(listText) {
  return listText.split(/\r?\n/).filter((l) => l && (/^\//.test(l) || /(^|\/)\.\.(\/|$)/.test(l) || /\\/.test(l)));
}

function idsOf(dir) {
  const seen = new Set(); let dup = 0, bad = 0;
  const idsDir = path.join(dir, 'ids');
  let names = []; try { names = fs.readdirSync(idsDir).filter((n) => /\.json$/.test(n) && !/^g_/.test(n)).sort(); } catch { /* none */ }
  for (const n of names) {
    let a; try { a = JSON.parse(fs.readFileSync(path.join(idsDir, n), 'utf8')); } catch { bad++; continue; }
    if (!Array.isArray(a)) { bad++; continue; }
    for (const id of a) { if (typeof id !== 'string' || !/^bldg_/.test(id)) bad++; else if (seen.has(id)) dup++; else seen.add(id); }
  }
  return { count: seen.size, dup, bad };
}

function glbProblems(dir) {
  const uris = (LAYOUT.contentUris(dir) || []).filter((u) => /\.glb$/i.test(u));
  let missing = 0, invalid = 0;
  for (const u of uris) {
    let b; try { b = fs.readFileSync(path.join(dir, ...u.split('/'))); } catch { missing++; continue; }
    if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) invalid++;
  }
  return { glbs: uris.length, missing, invalid };
}

export function assemble({ root, out, registry, maxBytes = MAX_BYTES_DEFAULT, tag = 'plateau2025-converted', rootDir = ROOT }) {
  const OUT = path.resolve(out);
  const allowed = [process.env.RUNNER_TEMP, path.join(rootDir, 'temp')].filter(Boolean).map((x) => path.resolve(x) + path.sep);
  if (!allowed.some((a) => (OUT + path.sep).startsWith(a))) throw new Error('出力先は RUNNER_TEMP または temp/ 配下のみ');
  const tree = scanTree(root, { maxBytes });
  const dirs = LAYOUT.findTilesetDirs(root);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const w of registry) {
    const row = { ward: w.id, code: String(w.code), status: 'missing', problems: [] };
    rows.push(row);
    const d = LAYOUT.discoverWard(root, w.id, dirs);
    if (!d || !d.dir) { row.problems.push(d ? 'ambiguous layout' : 'no tileset.json for this ward'); continue; }
    row.layout = d.layout;
    const ids = idsOf(d.dir), g = glbProblems(d.dir);
    Object.assign(row, { ids: ids.count, duplicateIds: ids.dup, invalidIds: ids.bad, glbs: g.glbs, glbMissing: g.missing, glbInvalid: g.invalid });
    if (!g.glbs) row.problems.push('no GLB tiles'); if (g.missing) row.problems.push(g.missing + ' GLB missing'); if (g.invalid) row.problems.push(g.invalid + ' GLB invalid');
    if (ids.dup) row.problems.push(ids.dup + ' duplicate ids'); if (ids.bad) row.problems.push(ids.bad + ' invalid ids');
    let src = null, rep = null;
    try { src = JSON.parse(fs.readFileSync(path.join(d.dir, 'source.json'), 'utf8')); } catch { /* none */ }
    try { rep = JSON.parse(fs.readFileSync(path.join(d.dir, 'build-report.json'), 'utf8')); } catch { /* none */ }
    if (src && src.wardCode != null && String(src.wardCode) !== String(w.code)) row.problems.push(`wardCode mismatch (${src.wardCode})`);
    const n = (rep && rep.totals && rep.totals.buildings) || ids.count;
    if (!(n > 0)) row.problems.push('no buildings');
    if (row.problems.length) { row.status = 'data-problem'; continue; }
    const dst = path.join(OUT, w.id);
    fs.cpSync(d.dir, dst, { recursive: true, dereference: false });
    row.synthesized = [];
    if (!src) {
      fs.writeFileSync(path.join(dst, 'source.json'), JSON.stringify({ wardCode: String(w.code), ward: w.id, vintage: '2025', vintageBasis: `private Release tag ${tag} (GML 由来の確認ではない)`, synthesized: true }));
      row.synthesized.push('source.json');
    } else if (!src.vintage) row.vintageNote = 'source.json に vintage なし(2025 とは断定しない)';
    if (!rep) {
      fs.writeFileSync(path.join(dst, 'build-report.json'), JSON.stringify({ totals: { buildings: n, selectedTiles: g.glbs }, synthesized: true, basis: 'ids/*.json の件数' }));
      row.synthesized.push('build-report.json');
    }
    row.buildings = n; row.status = 'ok';
    row.vintage = (src && src.vintage) ? String(src.vintage) : (src ? null : '2025');
  }
  const report = {
    schema: 'livecity-release-assemble/1', generatedAt: new Date().toISOString(),
    tree: { files: tree.files, bytes: tree.bytes, problems: tree.problems.slice(0, 20) },
    counts: { ok: rows.filter((r) => r.status === 'ok').length, missing: rows.filter((r) => r.status === 'missing').length, problem: rows.filter((r) => r.status === 'data-problem').length, buildings: rows.reduce((s, r) => s + (r.buildings || 0), 0) },
    wards: rows, rights: { confirmedByHuman: false },
  };
  report.allOk = report.counts.ok === registry.length && !tree.problems.length;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), o = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  if (!o('root') || !o('out')) { console.error('usage: --root <extracted> --out <dir under RUNNER_TEMP|temp> [--report path] [--max-bytes N]'); process.exit(2); }
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/wards/registry.json'), 'utf8')).wards;
    const r = assemble({ root: path.resolve(o('root')), out: o('out'), registry, maxBytes: Number(o('max-bytes', MAX_BYTES_DEFAULT)) });
    if (o('report')) fs.writeFileSync(path.resolve(o('report')), JSON.stringify(r, null, 1));
    console.log(JSON.stringify({ ...r, wards: r.wards.map((w) => `${w.ward}:${w.status}${w.problems.length ? ':' + w.problems.join('|') : ''}`) }, null, 1));
    if (!r.allOk) { console.error('[release-assemble] 24区そろっていない、または問題あり。成功とは扱いません'); process.exit(3); }
  } catch (e) { console.error('[release-assemble] NG:', e.message); process.exit(2); }
}
