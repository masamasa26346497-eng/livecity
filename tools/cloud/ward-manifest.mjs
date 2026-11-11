// Mission 202: 区ごと manifest.json(出典/vintage/ward/asset sha256+bytes/contentVersion)の生成と検証。
// 区ディレクトリ内の配信ファイル(tileset.json, tiles/ lod/ ids/ attrs/ 配下)を走査する。ネットワーク不使用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('./data-resolver.cjs');

const SUBDIRS = ['tiles', 'lod', 'ids', 'attrs'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function listAssets(dir) {
  const out = [];
  const add = (rel) => { const b = fs.readFileSync(path.join(dir, rel)); out.push({ path: rel, sha256: sha(b), bytes: b.length }); };
  (function walk(d, relBase) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = relBase ? relBase + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (rel === 'tileset.json' || SUBDIRS.some((s) => rel.startsWith(s + '/'))) add(rel);
    }
  })(dir, '');
  return out;
}

export async function writeWardManifest(dir, { ward, name, code, source, synthetic = false }) {
  if (Number(source && source.vintage) !== 2025) throw new Error(ward + ': source.vintage != 2025 (fail closed)');
  const assets = listAssets(dir).sort((a, b) => (a.path < b.path ? -1 : 1));
  const m = {
    schema: 'livecity.mission202.ward-manifest/1', ward, name, wardCode: code, vintage: 2025,
    source: { attribution: source.attribution, license: source.license, sourceEtag: source.sourceEtag, vintage: 2025 },
    synthetic: synthetic === true,
    contentVersion: await R.contentVersionOf(assets),
    totalBytes: assets.reduce((n, a) => n + a.bytes, 0), fileCount: assets.length, assets,
  };
  const v = R.validateWardManifest(m, ward);
  if (!v.ok) throw new Error('manifest 不正: ' + v.problems.join(';'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return m;
}

// 実ファイルが manifest と一致するか(欠落/改変/余剰)を検査。ward 不一致(他区の混入)も不合格。
export async function verifyWardDir(dir, ward) {
  const problems = [];
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  problems.push(...R.validateWardManifest(m, ward).problems);
  const have = new Map(listAssets(dir).map((a) => [a.path, a]));
  for (const a of m.assets) {
    const h = have.get(a.path);
    if (!h) problems.push('欠落: ' + a.path);
    else if (h.sha256 !== a.sha256 || h.bytes !== a.bytes) problems.push('不一致: ' + a.path);
    have.delete(a.path);
  }
  for (const p of have.keys()) problems.push('manifest に無い余剰ファイル: ' + p);
  if ((await R.contentVersionOf(m.assets)) !== m.contentVersion) problems.push('contentVersion 不一致');
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'tileset.json'), 'utf8'));
    (function walk(n) {
      if (!n) return;
      const u = n.content && (n.content.uri || n.content.url);
      if (u) {
        const r = R.resolveContentUri('b/', ward, u);
        if (!r.ok) problems.push('tileset uri 不正: ' + u);
        else if (!fs.existsSync(path.join(dir, r.rel))) problems.push('tileset uri 実体なし: ' + u);
      }
      (n.children || []).forEach(walk);
    })(t.root);
  } catch (e) { problems.push('tileset.json 読込失敗'); }
  return { ok: problems.length === 0, problems, contentVersion: m.contentVersion };
}

// 区をまたいだ一意性: 同一 contentVersion があれば区の取り違え/コピー混入とみなす。
export function checkWardsDistinct(manifests) {
  const problems = [];
  const vs = new Map();
  for (const m of manifests) {
    if (vs.has(m.contentVersion)) problems.push(m.ward + ' と ' + vs.get(m.contentVersion) + ' の contentVersion が同一');
    vs.set(m.contentVersion, m.ward);
  }
  return { ok: problems.length === 0, problems };
}
