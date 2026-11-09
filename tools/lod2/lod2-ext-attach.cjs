'use strict';
// Mission 170/171: 既存の 24区 LOD1 出力(45D ルート または index.json 付き ext-3dtiles)と、道路・河川・公園の別出力(45I MapLayers)の
// 読み取り専用 検出・互換判定・配信アダプタ。
// - 一切書き込まない/削除しない/コピーしない。リンクは辿らない。配信は tileset.json・tiles/*.glb 等の許可リストのみ。
// - 45D ルートは「元データとの再照合(45E の proof)」を行わないため、必ず verified=false として出典と共に表示する
//   (PR51 の公式2025 LOD1 615,234 棟と同一とは限らない。旧 PC 変換データの可能性がある)。
// - 互換性が判断できないときは 0 件と推測せず、不足ファイル名を reasons に返す。
// - Mission 171: 「tileset.json がある」だけでは接続成功としない。37G が実際に要求する source.json / build-report.json(totals.buildings, selectedTiles) /
//   tileset の content URI(全 GLB が実在し配信許可リストに合う)を満たす区だけを servable にし、満たさない区は brokenWards に理由つきで出す。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKER = '.livecity-45d-root.json';
const LAYERS_MARKER = '.livecity-45i-layers.json';
const LAYERS_SCHEMA = 'livecity.mission45i.layers/1';
const LAYER_FILE = /^(roads|waterways|parks|railways|labels|layers-report)\.json$/;
// 45G/45E (tools/mission43g-local-preview.cjs の ALLOWED) と同一
const ALLOWED = [/^tileset\.json$/, /^source\.json$/, /^build-report\.json$/, /^tiles\/[A-Za-z0-9_.-]+\.glb$/, /^lod\/[A-Za-z0-9_.-]+\.glb$/, /^ids\/[A-Za-z0-9_.-]+\.json$/, /^attrs\/[A-Za-z0-9_.-]+\.json$/];
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const isDir = (p) => { const s = lst(p); return !!(s && s.isDirectory() && !s.isSymbolicLink()); };
const isFile = (p) => { const s = lst(p); return !!(s && s.isFile() && !s.isSymbolicLink()); };
const jsonOf = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const registry = () => jsonOf(path.join(ROOT, 'config/wards/registry.json')).wards;

function collectUris(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (node.content && typeof node.content.uri === 'string') acc.push(node.content.uri);
  if (Array.isArray(node.contents)) for (const c of node.contents) if (c && typeof c.uri === 'string') acc.push(c.uri);
  if (Array.isArray(node.children)) for (const c of node.children) collectUris(c, acc);
  return acc;
}
// 区ディレクトリの健全性。37G の loadExtraMeta / loadCoverage / mountTileset が実際に要求する条件と同じものを確認する。
function wardHealth(dir, wardCode) {
  const problems = [];
  const src = jsonOf(path.join(dir, 'source.json'));
  const rep = jsonOf(path.join(dir, 'build-report.json'));
  const ts = jsonOf(path.join(dir, 'tileset.json'));
  if (!src) problems.push('source.json が無い/読めない(37G が区として登録できません)');
  else if (String(src.wardCode || '') !== String(wardCode)) problems.push('source.json の wardCode(' + src.wardCode + ')が区コード ' + wardCode + ' と一致しません');
  const nb = rep && rep.totals ? rep.totals.buildings : null;
  if (!rep) problems.push('build-report.json が無い/読めない');
  else {
    if (!(nb > 0)) problems.push('build-report.json の totals.buildings が 0/未設定(37G は 0 棟の区を数えません)');
    if (!(rep.selectedTiles > 0)) problems.push('build-report.json の selectedTiles が 0/未設定(37G は 0 タイルの区を数えません)');
  }
  let uris = 0, missing = 0, notServable = 0;
  if (!ts || !ts.root) problems.push('tileset.json が無い/読めない');
  else {
    const list = [...new Set(collectUris(ts.root, []))];
    uris = list.length;
    if (!uris) problems.push('tileset.json に content URI がありません(描くものがありません)');
    for (const u of list) {
      if (/^[a-z]+:/i.test(u) || u.startsWith('/') || u.includes('..') || u.includes('\\')) { notServable++; continue; }
      const rel = path.posix.normalize(u);
      if (!ALLOWED.some((re) => re.test(rel))) { notServable++; continue; }
      if (!isFile(path.join(dir, ...rel.split('/')))) missing++;
    }
    if (missing) problems.push('tileset.json が参照する GLB のうち ' + missing + '/' + uris + ' 件がディスク上に無い');
    if (notServable) problems.push('tileset.json が参照する ' + notServable + '/' + uris + ' 件は配信許可リスト外のパス(tiles/*.glb, lod/*.glb 以外)で 404 になります');
  }
  return { ok: problems.length === 0, problems, buildings: Number.isInteger(nb) ? nb : null, tiles: rep && Number.isInteger(rep.selectedTiles) ? rep.selectedTiles : null, uris, missing, notServable };
}

// <ward>-aN の候補から、健全な最新の attempt を選ぶ。verify-report.json が ok:false の attempt(変換失敗の残骸)は採用しない。
function pickAttempt(parent, ward, wardCode) {
  const skipped = [];
  let names = []; try { names = fs.readdirSync(parent); } catch (e) { return { dir: null, skipped }; }
  const cands = [];
  for (const n of names) {
    const m = new RegExp('^' + ward + '-a([0-9]+)$').exec(n);
    if (m) cands.push({ n: Number(m[1]), top: path.join(parent, n) });
  }
  cands.sort((a, b) => b.n - a.n);
  for (const c of cands) {
    const d = isFile(path.join(c.top, 'tileset.json')) ? c.top : (isFile(path.join(c.top, ward, 'tileset.json')) ? path.join(c.top, ward) : null);
    if (!d) { skipped.push({ attempt: c.n, reason: 'tileset.json なし' }); continue; }
    const vr = jsonOf(path.join(c.top, 'verify-report.json')) || jsonOf(path.join(d, 'verify-report.json'));
    if (vr && vr.ok === false) { skipped.push({ attempt: c.n, reason: 'verify-report.json が ok:false(変換検証に失敗した残骸)' }); continue; }
    const h = wardHealth(d, wardCode);
    if (!h.ok) { skipped.push({ attempt: c.n, reason: h.problems.join(' / ') }); continue; }
    return { dir: d, health: h, attempt: c.n, skipped };
  }
  return { dir: null, skipped };
}

// dir を検査する。kind: 'ext-index'(index.json あり=45E 配信形式) | '45d-root' | 'unknown'
function inspect(dir) {
  const out = { kind: 'unknown', name: path.basename(dir || ''), wards: [], missingWards: [], brokenWards: [], reasons: [], verified: false, servable: [] };
  if (!dir || !isDir(dir)) { out.reasons.push('フォルダが存在しません'); return out; }
  const idx = isFile(path.join(dir, 'index.json')) ? jsonOf(path.join(dir, 'index.json')) : null;
  if (idx && Array.isArray(idx.wards)) {
    out.kind = 'ext-index'; out.verified = idx.verified === true;
    out.wards = idx.wards.map((w) => ({ ward: w.ward, wardCode: w.wardCode, buildings: w.buildings == null ? null : w.buildings }));
    out.reasons.push('index.json あり(45E 形式)' + (out.verified ? '・検証済み' : '・未検証'));
    return out;
  }
  if (isFile(path.join(dir, MARKER))) {
    out.kind = '45d-root';
    const reg = registry();
    const pc = path.join(dir, 'pc23');
    if (!isDir(pc)) out.reasons.push('pc23/ がありません(23区ぶんの変換結果が見つかりません)');
    for (const w of reg) {
      let d = null, health = null, skipped = [];
      if (w.id === 'sumiyoshi') {
        const st = jsonOf(path.join(dir, 'state.json'));
        const a = st && st.sumiyoshi && Number.isInteger(st.sumiyoshi.attempt) ? st.sumiyoshi.attempt : null;
        const cands = a != null ? [path.join(dir, 'sumiyoshi-a' + a)] : [];
        try { for (const n of fs.readdirSync(dir)) if (/^sumiyoshi-a[0-9]+$/.test(n) && !cands.includes(path.join(dir, n))) cands.push(path.join(dir, n)); } catch (e) { /* none */ }
        for (const c of cands) {
          const cd = isFile(path.join(c, 'sumiyoshi', 'tileset.json')) ? path.join(c, 'sumiyoshi') : (isFile(path.join(c, 'tileset.json')) ? c : null);
          if (!cd) continue;
          const h = wardHealth(cd, w.code);
          if (h.ok) { d = cd; health = h; break; }
          skipped.push({ attempt: path.basename(c), reason: h.problems.join(' / ') });
        }
      } else { const pk = pickAttempt(pc, w.id, w.code); d = pk.dir; health = pk.health; skipped = pk.skipped; }
      if (d) out.servable.push({ ward: w.id, wardCode: w.code, dir: d, buildings: health.buildings, tiles: health.tiles, uris: health.uris });
      else if (skipped.length) out.brokenWards.push({ ward: w.id, reasons: skipped });
      else out.missingWards.push(w.id);
    }
    out.wards = out.servable.map((s) => ({ ward: s.ward, wardCode: s.wardCode, buildings: s.buildings }));
    out.reasons.push('45D 出力ルート: ' + out.servable.length + '/' + reg.length + ' 区が 37G で読める状態(source.json・build-report.json・tileset.json・全GLBを確認)'
      + (out.missingWards.length ? '(出力なし: ' + out.missingWards.join(',') + ')' : '')
      + (out.brokenWards.length ? '(使えない出力: ' + out.brokenWards.map((x) => x.ward).join(',') + ')' : ''));
    out.reasons.push('元データとの照合(45E proof)は行っていません=未検証。PR51 の公式2025 LOD1(615,234棟)と同一とは限りません');
    return out;
  }
  out.reasons.push('index.json も ' + MARKER + ' も無いため、24区 LOD1 の形式と判断できません(0件とは判断していません)');
  return out;
}

// 既定の探索場所(存在確認と読み取りのみ)
function defaultCandidates(env = process.env) {
  const c = [];
  if (env.LOCALAPPDATA) c.push(path.join(env.LOCALAPPDATA, 'LiveCity-3DTiles-Out-24'));
  c.push(path.join(ROOT, 'ext-3dtiles'), path.join(ROOT, 'temp', 'ext-3dtiles'), path.join(ROOT, '..', 'ext-3dtiles'));
  return c;
}
// 最初に「1区以上を配信できる」候補を採用。無ければ all の検査結果(理由つき)を返す。
function discover(explicit, env = process.env) {
  const list = (explicit ? [path.resolve(explicit)] : defaultCandidates(env).filter((p) => isDir(p)));
  const inspected = list.map((d) => ({ dir: d, ...inspect(d) }));
  const chosen = inspected.find((x) => x.kind !== 'unknown' && x.wards.length > 0) || null;
  return { chosen, inspected };
}

// ---- 道路・河川・公園・鉄道・名称(45I MapLayers)。<root>/<ward>/layers/{roads,waterways,parks,railways,labels,layers-report}.json ----
function layersDefaultCandidates(env = process.env) {
  const c = [];
  if (env.LOCALAPPDATA) c.push(path.join(env.LOCALAPPDATA, 'LiveCity-MapLayers-Out-24'));
  c.push(path.join(ROOT, 'temp', 'map-layers'), path.join(ROOT, '..', 'map-layers'));
  return c;
}
function inspectLayers(dir) {
  const out = { dir, name: path.basename(dir || ''), ok: false, wards: [], reasons: [] };
  if (!dir || !isDir(dir)) { out.reasons.push('フォルダが存在しません'); return out; }
  const m = isFile(path.join(dir, LAYERS_MARKER)) ? jsonOf(path.join(dir, LAYERS_MARKER)) : null;
  if (!m) { out.reasons.push(LAYERS_MARKER + ' がありません(45I の MapLayers 出力と判断できないため配信しません)'); return out; }
  if (m.schema !== LAYERS_SCHEMA) { out.reasons.push('マーカーの schema が ' + LAYERS_SCHEMA + ' ではありません(' + String(m.schema).slice(0, 40) + ')'); return out; }
  let names = []; try { names = fs.readdirSync(dir); } catch (e) { /* none */ }
  for (const n of names) {
    if (!/^[a-z0-9-]+$/.test(n)) continue;
    if (!isFile(path.join(dir, n, 'layers', 'layers-report.json'))) continue;
    const have = ['roads', 'waterways', 'parks', 'railways', 'labels'].filter((k) => isFile(path.join(dir, n, 'layers', k + '.json')));
    out.wards.push({ ward: n, files: have });
  }
  out.ok = out.wards.length > 0;
  out.reasons.push(out.ok ? out.wards.length + ' 区のレイヤー(道路・河川・公園・鉄道・名称)を検出' : 'マーカーはありますが <区>/layers/layers-report.json を持つ区がありません');
  return out;
}
function discoverLayers(explicit, env = process.env) {
  const list = explicit ? [path.resolve(explicit)] : layersDefaultCandidates(env).filter((p) => isDir(p));
  const inspected = list.map((d) => inspectLayers(d));
  return { chosen: inspected.find((x) => x.ok) || null, inspected };
}
// <ward>/layers/<file> → 実ファイル。マーカー検証済みの区・既知 6 ファイルのみ・通常ファイル・realpath が root 内。
function resolveLayers(layers, rest) {
  let dec; try { dec = decodeURIComponent(rest); } catch (e) { return null; }
  const mm = /^([a-z0-9-]+)\/layers\/([A-Za-z-]+\.json)$/.exec(dec);
  if (!layers || !mm || !LAYER_FILE.test(mm[2]) || !layers.wards.some((w) => w.ward === mm[1])) return null;
  const file = path.join(layers.dir, mm[1], 'layers', mm[2]);
  try {
    if (!isFile(file)) return null;
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(layers.dir) + path.sep)) return null;
  } catch (e) { return null; }
  return file;
}

function indexJsonFor(ins, layers) {
  return JSON.stringify({
    schema: 'livecity.mission170.autoattach/1', kind: 'local-only', verified: ins.verified === true, lod0Wards: [],
    layersWards: layers && layers.ok ? layers.wards.map((w) => ({ ward: w.ward })) : [],
    provenance: ins.kind === '45d-root' ? 'unverified-45d-root' : 'ext-index', wards: ins.wards,
  });
}
// <ward>/<rel> を 45D ルート内の実ディレクトリへ。許可リスト・通常ファイルのみ・realpath が区ディレクトリ内に留まること。
function resolveFromServable(servable, rest) {
  let dec; try { dec = decodeURIComponent(rest); } catch (e) { return null; }
  if (dec.includes('\0') || dec.includes('\\') || dec.includes('..')) return null;
  const i = dec.indexOf('/'); if (i < 1) return null;
  const s = servable.find((x) => x.ward === dec.slice(0, i)); const rel = dec.slice(i + 1);
  if (!s || !ALLOWED.some((re) => re.test(rel))) return null;
  const file = path.join(s.dir, ...rel.split('/'));
  try {
    if (!isFile(file)) return null;
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(s.dir) + path.sep)) return null;
  } catch (e) { return null; }
  return file;
}

module.exports = { inspect, discover, defaultCandidates, indexJsonFor, resolveFromServable, ALLOWED, wardHealth, inspectLayers, discoverLayers, layersDefaultCandidates, resolveLayers, LAYERS_MARKER, LAYERS_SCHEMA };
