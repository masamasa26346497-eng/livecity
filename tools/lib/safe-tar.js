// 依存なし・fail-closed の tar.gz 展開。外部 tar コマンドは使わない（symlink/hardlink/PAX/GNU拡張経由の
// ルート外書き込みを構造的に排除するため）。許可: 通常ファイル('0'/NUL)・ディレクトリ('5')・PAX 'x'(path等の安全キーのみ)。
// それ以外（hardlink '1', symlink '2', device, GNU 'L'/'K', PAX 'g', 未知type）は全体を拒否。
// 展開は staging ディレクトリへ行い、全検査・全書込み成功後にだけ最終先へ rename（原子的）。失敗時は staging を削除。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function isUnsafeTarMember(name) {
  const n = String(name).replace(/\\/g, '/');
  return n === '' || n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..');
}

const PAX_SAFE = new Set(['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'size']);
const str = (b) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString('utf8'); };
const oct = (b) => { const s = str(b).trim(); return s === '' ? 0 : parseInt(s, 8); };

function parsePax(buf) {
  const rec = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp < 0) throw new Error('bad pax record');
    const len = parseInt(buf.subarray(p, sp).toString(), 10);
    if (!(len > 0) || p + len > buf.length) throw new Error('bad pax length');
    const kv = buf.subarray(sp + 1, p + len - 1).toString('utf8');
    const eq = kv.indexOf('=');
    if (eq < 0) throw new Error('bad pax record');
    const k = kv.slice(0, eq);
    if (!PAX_SAFE.has(k)) throw new Error(`unsafe pax key: ${k}`);
    rec[k] = kv.slice(eq + 1);
    p += len;
  }
  return rec;
}

/** tar バッファ(非圧縮)を検査して [{name,type,data}] を返す。危険要素があれば throw。 */
export function parseTar(buf, { maxEntries = 200000, maxTotalBytes = 4 * 1024 ** 3 } = {}) {
  const out = [];
  let off = 0, total = 0, pax = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    if (sum !== oct(h.subarray(148, 156))) throw new Error('tar checksum mismatch');
    const type = String.fromCharCode(h[156] || 48);
    const size = oct(h.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0) throw new Error('bad size');
    const body = buf.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new Error('truncated tar');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(body); continue; }
    let name = str(h.subarray(0, 100));
    const prefix = str(h.subarray(345, 500));
    if (prefix) name = `${prefix}/${name}`;
    if (pax && pax.path) name = pax.path;
    pax = null;
    if (type !== '0' && type !== '5') throw new Error(`unsupported tar entry type '${type}': ${name}`);
    if (isUnsafeTarMember(name)) throw new Error(`unsafe member name: ${name}`);
    if (type === '0') { total += size; if (total > maxTotalBytes) throw new Error('archive too large'); }
    if (out.length >= maxEntries) throw new Error('too many entries');
    out.push({ name, type, data: type === '0' ? body : null });
  }
  return out;
}

/** tgz バッファを destFinal へ原子的に展開。destFinal は存在しないこと。戻り値: {files,dirs,tilesets}。 */
export function extractTarGzSafe(tgzBuf, destFinal, opts = {}) {
  if (fs.existsSync(destFinal)) throw new Error('destination already exists');
  const staging = `${destFinal}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    const tar = zlib.gunzipSync(tgzBuf, { maxOutputLength: opts.maxTotalBytes ?? 4 * 1024 ** 3 - 1 });
    const entries = parseTar(tar, opts);
    fs.mkdirSync(staging, { recursive: true });
    const root = path.resolve(staging);
    let files = 0, dirs = 0, tilesets = 0;
    for (const e of entries) {
      const rel = e.name.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel === '.') continue;
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`escapes root: ${e.name}`);
      if (e.type === '5') { fs.mkdirSync(abs, { recursive: true }); dirs++; continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // 既存エントリ(重複メンバー等)の上書きや symlink 辿りを避ける: 'wx' で排他作成
      fs.writeFileSync(abs, e.data, { flag: 'wx', mode: 0o644 });
      files++;
      if (rel.endsWith('tileset.json')) tilesets++;
    }
    fs.renameSync(staging, destFinal);
    return { files, dirs, tilesets };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}
