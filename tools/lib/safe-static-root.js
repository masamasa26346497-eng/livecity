// tools/lib/safe-static-root.js
// Mission 116 (第3段階): 「リポジトリ外のローカル出力ディレクトリ」を 127.0.0.1 から安全に配信するための解決関数。
//
// 目的: ユーザーの Windows ローカルにある 24区の変換済み出力を、コピー/再ダウンロード/アップロード無しで
//       `http://127.0.0.1:PORT/map-data/osaka-city/...` として配信する（public/ を汚さない）。
//
// 安全方針（allowlist 方式）:
//   - マウントは URL 接頭辞 1 つだけ（既定 /map-data/osaka-city/）。それ以外の URL は一切この経路に入らない。
//   - 拡張子 .json のみ。ドットファイル/ドットディレクトリ、NUL 文字、バックスラッシュ、`..` は拒否。
//   - 正規化後のパスがルート配下であること + realpath で symlink/junction によるルート外脱出も拒否。
//   - ディレクトリ列挙は行わない。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MOUNT = '/map-data/osaka-city/';
const ALLOWED_EXT = new Set(['.json']);

/** ルートディレクトリを検証して realpath を返す。失敗時は Error。 */
export function validateDataRoot(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('data-root が指定されていません');
  const abs = path.resolve(dir);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`data-root が存在しません: ${abs}`); }
  if (!st.isDirectory()) throw new Error(`data-root がディレクトリではありません: ${abs}`);
  // ファイルシステムのルートそのものは拒否（任意パス公開の防止）
  if (path.parse(abs).root === abs) throw new Error('data-root にドライブ/ファイルシステムのルートは指定できません');
  return fs.realpathSync(abs);
}

/**
 * @param {string} rootReal  validateDataRoot() の戻り値
 * @param {string} urlPath   リクエスト URL（クエリ込み可）
 * @param {{mount?:string}} [opts]
 * @returns {{ok:true,file:string}|{ok:false,reason:string}}  reason: 'not-mounted'|'forbidden'|'not-found'
 */
export function resolveDataRootFile(rootReal, urlPath, opts = {}) {
  const mount = opts.mount || DEFAULT_MOUNT;
  const raw = String(urlPath || '').split('?')[0].split('#')[0];
  if (!raw.startsWith(mount)) return { ok: false, reason: 'not-mounted' };
  let rel;
  try { rel = decodeURIComponent(raw.slice(mount.length)); } catch { return { ok: false, reason: 'forbidden' }; }
  if (!rel || rel.includes('\0') || rel.includes('\\')) return { ok: false, reason: 'forbidden' };
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || /^[a-zA-Z]:/.test(s))) {
    return { ok: false, reason: 'forbidden' };
  }
  if (!ALLOWED_EXT.has(path.extname(rel).toLowerCase())) return { ok: false, reason: 'forbidden' };
  const abs = path.join(rootReal, ...segs);
  if (!abs.startsWith(rootReal + path.sep)) return { ok: false, reason: 'forbidden' };
  let real;
  try { real = fs.realpathSync(abs); } catch { return { ok: false, reason: 'not-found' }; }
  if (!real.startsWith(rootReal + path.sep)) return { ok: false, reason: 'forbidden' }; // symlink/junction 脱出
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, reason: 'not-found' }; }
  if (!st.isFile()) return { ok: false, reason: 'not-found' };
  return { ok: true, file: real };
}
