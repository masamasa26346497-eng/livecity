'use strict';
// Mission 170: 既存の 24区 LOD1 出力(45D ルート または index.json 付き ext-3dtiles)の読み取り専用 検出・互換判定・配信アダプタ。
// - 一切書き込まない/削除しない/コピーしない。リンクは辿らない。配信は tileset.json・tiles/*.glb 等の許可リストのみ。
// - 45D ルートは「元データとの再照合(45E の proof)」を行わないため、必ず verified=false として出典と共に表示する
//   (PR51 の公式2025 LOD1 615,234 棟と同一とは限らない。旧 PC 変換データの可能性がある)。
// - 互換性が判断できないときは 0 件と推測せず、不足ファイル名を reasons に返す。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKER = '.livecity-45d-root.json';
const ALLOWED = [/^tileset\.json$/, /^source\.json$/, /^build-report\.json$/, /^tiles\/[A-Za-z0-9_.-]+\.glb$/, /^lod\/[A-Za-z0-9_.-]+\.glb$/, /^ids\/[A-Za-z0-9_.-]+\.json$/, /^attrs\/[A-Za-z0-9_.-]+\.json$/];
const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const isDir = (p) => { const s = lst(p); return !!(s && s.isDirectory() && !s.isSymbolicLink()); };
const isFile = (p) => { const s = lst(p); return !!(s && s.isFile() && !s.isSymbolicLink()); };
const jsonOf = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const registry = () => jsonOf(path.join(ROOT, 'config/wards/registry.json')).wards;

// attempt 番号が最大で tileset.json を持つディレクトリ(<ward>-aN)。
function latestAttemptDir(parent, ward) {
  let best = null;
  let names = []; try { names = fs.readdirSync(parent); } catch (e) { return null; }
  for (const n of names) {
    const m = new RegExp('^' + ward + '-a([0-9]+)$').exec(n);
    if (!m) continue;
    const d = path.join(parent, n);
    const cand = isFile(path.join(d, 'tileset.json')) ? d : (isFile(path.join(d, ward, 'tileset.json')) ? path.join(d, ward) : null);
    if (cand && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), dir: cand };
  }
  return best ? best.dir : null;
}
function buildingsOf(dir) {
  const r = jsonOf(path.join(dir, 'build-report.json')) || jsonOf(path.join(dir, 'source.json'));
  const n = r && (r.buildings != null ? r.buildings : r.buildingCount != null ? r.buildingCount : r.converted != null ? r.converted : null);
  return Number.isInteger(n) ? n : null;
}

// dir を検査する。kind: 'ext-index'(index.json あり=45E 配信形式) | '45d-root' | 'unknown'
function inspect(dir) {
  const out = { kind: 'unknown', name: path.basename(dir || ''), wards: [], missingWards: [], reasons: [], verified: false, servable: [] };
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
      let d = null;
      if (w.id === 'sumiyoshi') {
        const st = jsonOf(path.join(dir, 'state.json'));
        const a = st && st.sumiyoshi && Number.isInteger(st.sumiyoshi.attempt) ? st.sumiyoshi.attempt : null;
        const cands = a != null ? [path.join(dir, 'sumiyoshi-a' + a)] : [];
        try { for (const n of fs.readdirSync(dir)) if (/^sumiyoshi-a[0-9]+$/.test(n)) cands.push(path.join(dir, n)); } catch (e) { /* none */ }
        for (const c of cands) { if (isFile(path.join(c, 'sumiyoshi', 'tileset.json'))) { d = path.join(c, 'sumiyoshi'); break; } if (isFile(path.join(c, 'tileset.json'))) { d = c; break; } }
      } else d = latestAttemptDir(pc, w.id);
      if (d) out.servable.push({ ward: w.id, wardCode: w.code, dir: d, buildings: buildingsOf(d) });
      else out.missingWards.push(w.id);
    }
    out.wards = out.servable.map((s) => ({ ward: s.ward, wardCode: s.wardCode, buildings: s.buildings }));
    out.reasons.push('45D 出力ルート: ' + out.servable.length + '/' + reg.length + ' 区の tileset.json を検出' + (out.missingWards.length ? '(欠落: ' + out.missingWards.join(',') + ')' : ''));
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

function indexJsonFor(ins) {
  return JSON.stringify({
    schema: 'livecity.mission170.autoattach/1', kind: 'local-only', verified: ins.verified === true, lod0Wards: [], layersWards: [],
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

module.exports = { inspect, discover, defaultCandidates, indexJsonFor, resolveFromServable, ALLOWED };
