// Mission 113: pure-Node, streaming tar.gz reader/extractor. It never runs an external `tar` and never parses `tar -tv` text, so it
// does not depend on the OS / locale / GNU-vs-bsdtar output format. It reads the 512-byte tar headers directly
// (USTAR prefix, PAX x/g records, GNU 'L'/'K' long names, base-256 numbers) and fails CLOSED on anything unusual.
// Error messages carry a machine-readable code plus numeric diagnostics only: never entry names, never data.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const LIMITS = {
  maxEntries: 20000,
  maxUnpackedBytes: 1500 * 1024 * 1024,
  maxMetaBytes: 1024 * 1024, // PAX / GNU long-name record payload
  maxPathChars: 1024,
  maxComponentChars: 255,
};

export class TarError extends Error {
  constructor(code, detail) {
    super('tar:' + code + (detail ? ' (' + detail + ')' : ''));
    this.kind = 'tar'; this.step = 'tar'; this.http = null; this.code = code;
  }
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Normalise an archive entry name to safe relative path components. Returns {parts} or {bad: code}.
export function normalizeEntryName(raw) {
  if (typeof raw !== 'string' || !raw.length) return { bad: 'empty-name' };
  if (raw.includes('\0')) return { bad: 'nul-in-name' };
  if (raw.includes('\\')) return { bad: 'backslash-in-name' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { bad: 'absolute-path' }; // POSIX, drive letter; UNC starts with '/'
  if (raw.length > LIMITS.maxPathChars) return { bad: 'path-too-long' };
  const parts = [];
  for (const s of raw.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') return { bad: 'path-traversal' };
    if (s.length > LIMITS.maxComponentChars) return { bad: 'component-too-long' };
    if (BAD_CHARS.test(s)) return { bad: 'windows-unsafe-char' };
    if (/[. ]$/.test(s)) return { bad: 'trailing-dot-or-space' };
    if (WIN_RESERVED.test(s)) return { bad: 'windows-reserved-name' };
    parts.push(s);
  }
  return { parts };
}

const cstr = (b) => { const i = b.indexOf(0); return i < 0 ? b : b.subarray(0, i); };
function parseNum(field, what) {
  if (field[0] & 0x80) { // GNU base-256: only non-negative, must fit in 2^53
    if (field[0] !== 0x80) throw new TarError('bad-number', what + ' negative-or-flagged');
    let v = 0;
    for (let i = 1; i < field.length; i++) { v = v * 256 + field[i]; if (v > Number.MAX_SAFE_INTEGER) throw new TarError('bad-number', what + ' overflow'); }
    return v;
  }
  const s = Buffer.from(field).toString('latin1').replace(/^[ \0]+|[ \0]+$/g, '');
  if (s === '') return null;
  if (!/^[0-7]+$/.test(s)) throw new TarError('bad-number', what + ' not-octal');
  return parseInt(s, 8);
}
function parsePax(buf) {
  const rec = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp < 0) throw new TarError('bad-pax', 'no-length');
    const lenStr = buf.subarray(p, sp).toString('latin1');
    if (!/^[1-9]\d{0,9}$/.test(lenStr)) throw new TarError('bad-pax', 'length');
    const len = Number(lenStr);
    if (p + len > buf.length || len < sp - p + 4 || buf[p + len - 1] !== 0x0a) throw new TarError('bad-pax', 'record-bounds');
    const body = buf.subarray(sp + 1, p + len - 1);
    const eq = body.indexOf(0x3d);
    if (eq <= 0) throw new TarError('bad-pax', 'no-equals');
    const key = body.subarray(0, eq).toString('latin1');
    let val;
    try { val = utf8.decode(body.subarray(eq + 1)); } catch { throw new TarError('bad-pax', 'invalid-utf8'); }
    rec[key] = val;
    p += len;
  }
  return rec;
}
const decodeName = (b, what) => { try { return utf8.decode(b); } catch { throw new TarError('invalid-utf8', what); } };

// Incremental parser. onEntry({type:'-'|'d', size, parts}) returns null (skip data) or a sink {write(buf), end(), abort()}.
export class TarParser {
  constructor(onEntry, limits = LIMITS) {
    this.onEntry = onEntry; this.lim = limits;
    this.state = 'header'; this.hbuf = Buffer.alloc(512); this.hlen = 0;
    this.pos = 0; this.zero = 0; this.ended = false;
    this.remaining = 0; this.pad = 0; this.sink = null; this.meta = null; this.cur = null;
    this.longName = null; this.longLink = null; this.pax = null;
    this.entries = 0; this.index = 0; this.bytes = 0;
    this.seen = new Map(); // case-folded path -> {t:'f'|'d', explicit}
    this.stats = { entries: 0, files: 0, dirs: 0, bytes: 0, maxDepth: 0, maxPathLen: 0, ext: {}, typeflags: {}, formats: {}, metaRecords: 0, endMarker: false };
  }
  fmt(k) { this.stats.formats[k] = (this.stats.formats[k] || 0) + 1; }
  feed(chunk) {
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      if (this.state === 'header') {
        const take = Math.min(512 - this.hlen, n - i);
        chunk.copy(this.hbuf, this.hlen, i, i + take); this.hlen += take; i += take;
        if (this.hlen === 512) { this.hlen = 0; this.block(); this.pos += 512; }
      } else if (this.state === 'data') {
        const take = Math.min(this.remaining, n - i);
        const piece = chunk.subarray(i, i + take);
        if (this.meta) this.meta.push(piece); else if (this.sink) this.sink.write(piece);
        this.remaining -= take; i += take; this.pos += take;
        if (this.remaining === 0) { this.finishData(); }
      } else if (this.state === 'pad') {
        const take = Math.min(this.pad, n - i); i += take; this.pad -= take; this.pos += take;
        if (this.pad === 0) this.state = 'header';
      } else { // 'end': only zero bytes may follow the end-of-archive marker
        for (; i < n; i++) if (chunk[i] !== 0) throw new TarError('data-after-end-marker', 'offset ' + (this.pos + i));
        this.pos += n;
      }
    }
  }
  finish() {
    if (this.state === 'data' || this.state === 'pad' && this.pad > 0 || this.hlen > 0) throw new TarError('truncated', 'entry ' + this.index + ' offset ' + this.pos);
    if (this.meta || this.longName !== null || this.longLink !== null || this.pax) throw new TarError('dangling-meta-header', 'entry ' + this.index);
    this.stats.endMarker = this.ended;
    this.stats.entries = this.entries;
    return this.stats;
  }
  abort() { try { if (this.sink && this.sink.abort) this.sink.abort(); } catch { /* ignore */ } this.sink = null; }
  block() {
    const h = this.hbuf;
    if (h.every((b) => b === 0)) {
      this.zero++;
      if (this.zero >= 2) { this.state = 'end'; this.ended = true; }
      return;
    }
    if (this.zero > 0) throw new TarError('data-after-zero-block', 'offset ' + this.pos);
    // checksum over the header with the checksum field taken as spaces
    let u = 0, s = 0;
    for (let k = 0; k < 512; k++) { const b = (k >= 148 && k < 156) ? 0x20 : h[k]; u += b; s += b > 127 ? b - 256 : b; }
    const stored = parseNum(h.subarray(148, 156), 'checksum');
    if (stored === null || (stored !== u && stored !== s)) {
      throw new TarError('bad-checksum', 'entry ' + this.index + ' offset ' + this.pos + ' stored ' + stored + ' computed ' + u + ' magic ' + h.subarray(257, 265).toString('hex') + ' type ' + h[156].toString(16));
    }
    const typeflag = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const size = parseNum(h.subarray(124, 136), 'size') || 0;
    const magic = h.subarray(257, 263).toString('latin1');
    const ustar = magic === 'ustar\0' && h.subarray(263, 265).toString('latin1') === '00';
    const gnu = magic === 'ustar ' ;
    if (!ustar && !gnu && magic !== '\0\0\0\0\0\0') throw new TarError('unknown-magic', 'entry ' + this.index + ' magic ' + h.subarray(257, 265).toString('hex'));
    this.fmt(ustar ? 'ustar' : gnu ? 'gnu' : 'v7');
    const tf = this.stats.typeflags; tf[typeflag] = (tf[typeflag] || 0) + 1;

    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
      if (size > this.lim.maxMetaBytes) throw new TarError('meta-too-large', typeflag + ' ' + size);
      this.stats.metaRecords++;
      this.fmt(typeflag === 'x' || typeflag === 'g' ? 'pax' : 'gnu-longname');
      this.meta = []; this.metaType = typeflag;
      this.begin(size);
      return;
    }
    if (typeflag !== '0' && typeflag !== '5') {
      // 1 hardlink, 2 symlink, 3/4 device, 6 fifo, 7 contiguous, anything else
      throw new TarError('unsupported-entry-type', 'entry ' + this.index + ' typeflag 0x' + h[156].toString(16));
    }
    // --- real entry ---
    let name;
    if (this.pax && this.pax.path !== undefined) name = this.pax.path;
    else if (this.longName !== null) name = this.longName;
    else {
      name = decodeName(cstr(h.subarray(0, 100)), 'name');
      if (ustar) { const pre = cstr(h.subarray(345, 500)); if (pre.length) name = decodeName(pre, 'prefix') + '/' + name; }
    }
    const linkRaw = this.pax && this.pax.linkpath !== undefined ? this.pax.linkpath : this.longLink !== null ? this.longLink : decodeName(cstr(h.subarray(157, 257)), 'linkname');
    if (linkRaw.length) throw new TarError('link-name-on-regular-entry', 'entry ' + this.index);
    const realSize = this.pax && this.pax.size !== undefined ? (/^\d{1,15}$/.test(this.pax.size) ? Number(this.pax.size) : (() => { throw new TarError('bad-pax', 'size'); })()) : size;
    this.pax = null; this.longName = null; this.longLink = null;
    const type = typeflag === '5' ? 'd' : '-';
    if (type === 'd' && realSize !== 0) throw new TarError('directory-with-data', 'entry ' + this.index);
    if (++this.entries > this.lim.maxEntries) throw new TarError('too-many-entries', String(this.lim.maxEntries));
    this.bytes += realSize;
    if (realSize > this.lim.maxUnpackedBytes || this.bytes > this.lim.maxUnpackedBytes) throw new TarError('unpacked-size-too-large', 'entry ' + this.index);
    const norm = normalizeEntryName(name);
    if (norm.bad) throw new TarError('unsafe-entry-name', norm.bad + ' entry ' + this.index);
    const parts = norm.parts;
    if (parts.length === 0) { // "./" root entry
      if (type !== 'd') throw new TarError('unsafe-entry-name', 'root-as-file entry ' + this.index);
      this.index++; this.stats.dirs++; this.sink = null; this.begin(0); return;
    }
    this.register(parts, type);
    const st = this.stats;
    if (type === 'd') st.dirs++; else { st.files++; st.bytes += realSize; const m = /\.([A-Za-z0-9]{1,8})$/.exec(parts[parts.length - 1]); const e = m ? m[1].toLowerCase() : '(none)'; st.ext[e] = (st.ext[e] || 0) + 1; }
    st.maxDepth = Math.max(st.maxDepth, parts.length); st.maxPathLen = Math.max(st.maxPathLen, parts.join('/').length);
    this.index++;
    this.sink = this.onEntry({ type, size: realSize, parts }) || null;
    this.begin(realSize);
  }
  register(parts, type) {
    const key = (n) => parts.slice(0, n).map((p) => p.normalize('NFC').toLowerCase()).join('/');
    for (let n = 1; n < parts.length; n++) {
      const k = key(n), e = this.seen.get(k);
      if (!e) this.seen.set(k, { t: 'd', explicit: false });
      else if (e.t === 'f') throw new TarError('path-collision', 'parent-is-file entry ' + this.index);
    }
    const k = key(parts.length), e = this.seen.get(k);
    if (e) {
      if (type === 'd' && e.t === 'd' && !e.explicit) e.explicit = true;
      else throw new TarError('path-collision', 'duplicate-or-case-collision entry ' + this.index);
    } else this.seen.set(k, { t: type === 'd' ? 'd' : 'f', explicit: true });
  }
  begin(size) {
    this.remaining = size; this.pad = (512 - (size % 512)) % 512;
    this.state = size > 0 ? 'data' : (this.pad ? 'pad' : 'header');
    if (size === 0) this.finishData(true);
  }
  finishData(zero) {
    if (this.meta) {
      const data = Buffer.concat(this.meta); this.meta = null;
      const t = this.metaType;
      if (t === 'x') this.pax = parsePax(data);
      else if (t === 'g') {
        const g = parsePax(data);
        if (g.path !== undefined || g.linkpath !== undefined || g.size !== undefined) throw new TarError('bad-pax', 'global-path-or-size');
      } else {
        const v = decodeName(cstr(data), 'longname');
        if (t === 'L') this.longName = v; else this.longLink = v;
      }
    } else if (this.sink) { const s = this.sink; this.sink = null; s.end(); }
    this.state = this.pad ? 'pad' : 'header';
  }
}

// Stream a .tar.gz through the parser. Returns the stats object (no names).
export async function scanTarGz(file, onEntry, limits = LIMITS) {
  const parser = new TarParser(onEntry, limits);
  const maxDecomp = limits.maxUnpackedBytes + (limits.maxEntries * 4 + 64) * 512 + limits.maxMetaBytes;
  const src = fs.createReadStream(file);
  const gz = zlib.createGunzip();
  let total = 0, first = true;
  const done = new Promise((res, rej) => { src.on('error', (e) => rej(new TarError('read-failed', String(e.code || 'error')))); gz.on('error', (e) => rej(new TarError('gunzip-failed', String(e.code || 'error')))); });
  done.catch(() => {});
  src.pipe(gz);
  try {
    const it = gz[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const { value, done: d } = await it.next();
        if (d) break;
        if (first) { first = false; }
        total += value.length;
        if (total > maxDecomp) throw new TarError('decompressed-too-large', String(total));
        parser.feed(value);
      }
    })();
    pump.catch(() => {});
    await Promise.race([pump, done]);
    await pump;
    if (total === 0) throw new TarError('empty-archive');
    const st = parser.finish();
    st.decompressedBytes = total;
    return st;
  } catch (e) {
    parser.abort();
    throw e;
  } finally {
    src.destroy(); gz.destroy();
  }
}

// Name-free audit of an archive. Writes nothing.
export const auditTarGz = (file, limits) => scanTarGz(file, () => null, limits);

// Extract into an EMPTY dir. Pass 1 audits (no writes); pass 2 writes with flag 'wx' using only validated components.
export async function extractTarGz(file, dest, limits = LIMITS) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length) throw new Error('destination not empty');
  const audit = await auditTarGz(file, limits);
  if (audit.entries === 0) throw new TarError('empty-archive');
  const root = fs.realpathSync(dest);
  const st = await scanTarGz(file, (e) => {
    const target = path.join(root, ...e.parts);
    if (!(target + path.sep).startsWith(root + path.sep)) throw new TarError('unsafe-entry-name', 'escapes-destination');
    if (e.type === 'd') { fs.mkdirSync(target, { recursive: true }); return null; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let fd;
    try { fd = fs.openSync(target, 'wx', 0o644); } catch (er) { throw new TarError('write-failed', String(er.code || 'error')); }
    return {
      write(b) { try { let o = 0; while (o < b.length) o += fs.writeSync(fd, b, o, b.length - o); } catch (er) { throw new TarError('write-failed', String(er.code || 'error')); } },
      end() { fs.closeSync(fd); fd = null; },
      abort() { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; } },
    };
  }, limits);
  if (st.entries !== audit.entries || st.bytes !== audit.bytes) throw new TarError('archive-changed-between-passes');
  return { count: st.entries, bytes: st.bytes, files: st.files, dirs: st.dirs, formats: st.formats, endMarker: st.endMarker };
}
