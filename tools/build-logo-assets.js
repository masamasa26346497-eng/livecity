#!/usr/bin/env node
// tools/build-logo-assets.js
// [ブランド] Live City ロゴのマスター PNG から、サイト用のロゴアセットを生成する。
//   マスター: public/assets/logo/livecity-logo-source.png（2172x724 / 8bit RGBA / 背景は既に透過）
//
// 生成物（すべて透過 PNG・縦横比は元のまま。拡大はしない＝面積平均で縮小のみ）:
//   livecity-logo-horizontal.png       エンブレム + "LiveCity"（タグライン除去）。PC トップバー用
//   livecity-logo-horizontal-dark.png  同上・暗背景用（低輝度のネイビーを白へ寄せる）
//   livecity-logo-icon.png             エンブレムのみ。モバイル / 小サイズ用
//   data/reports/logo-assets-build.json
//
// なぜタグラインを外すか: トップバー高 56px ではロゴ実寸 30px 程度になり、
//   "SEE MORE LIFE"（元画像で高さ 38px / 全高 519px）は約 2px となって潰れるため。
//   ブランドの主要素である「LiveCity」ワードマークの可読性を優先する。
//
// 依存なし（Node 組み込み zlib のみ）。ImageMagick / sharp / PIL は不要。
// 実行: node tools/build-logo-assets.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const SRC = P('public', 'assets', 'logo', 'livecity-logo-source.png');
const OUT_DIR = P('public', 'assets', 'logo');
const REPORT = P('data', 'reports', 'logo-assets-build.json');

const TARGET_H = 120; // 出力高さ(px)。トップバー表示 30px に対し 4x 相当でぼやけない

// ── PNG (8bit RGBA / 非インターレース) の最小デコーダ・エンコーダ ──────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
};

export function decodePng(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG ではない');
  let o = 8, w = 0, h = 0, colorType = -1;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.slice(o + 4, o + 8).toString('latin1');
    if (type === 'IHDR') {
      w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); colorType = buf[o + 17];
      if (buf[o + 16] !== 8) throw new Error('bit depth 8 のみ対応: ' + buf[o + 16]);
      if (buf[o + 20] !== 0) throw new Error('インターレース PNG は非対応');
    } else if (type === 'IDAT') idat.push(buf.slice(o + 8, o + 8 + len));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) throw new Error('colorType 6/2 のみ対応: ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    raw.copy(cur, 0, p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = cur[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1; else if (ft === 4) v += paeth(a, b, c);
      cur[i] = v & 0xFF;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, data: out };
}

export function encodePng({ w, h, data }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = Buffer.alloc(stride), line = Buffer.alloc(stride);
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  let q = 0;
  for (let y = 0; y < h; y++) {
    data.copy(line, 0, y * stride, (y + 1) * stride);
    let best = 0, bestScore = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      const c = cand[ft]; let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? line[i - 4] : 0, b = prev[i], cc = i >= 4 ? prev[i - 4] : 0;
        let v;
        if (ft === 0) v = line[i]; else if (ft === 1) v = line[i] - a; else if (ft === 2) v = line[i] - b;
        else if (ft === 3) v = line[i] - ((a + b) >> 1); else v = line[i] - paeth(a, b, cc);
        v &= 0xFF; c[i] = v; score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = ft; }
    }
    raw[q++] = best; cand[best].copy(raw, q); q += stride;
    line.copy(prev);
  }
  const chunk = (type, body) => {
    const b = Buffer.alloc(8 + body.length + 4);
    b.writeUInt32BE(body.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 8 + body.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── 画像操作 ──────────────────────────────────────────────────────────────────
const clone = (im) => ({ w: im.w, h: im.h, data: Buffer.from(im.data) });
export function crop(im, x0, y0, cw, ch) {
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) im.data.copy(out, y * cw * 4, ((y0 + y) * im.w + x0) * 4, ((y0 + y) * im.w + x0 + cw) * 4);
  return { w: cw, h: ch, data: out };
}
export function alphaBbox(im, x0 = 0, x1 = im.w - 1, y0 = 0, y1 = im.h - 1, thr = 8) {
  let mnx = im.w, mny = im.h, mxx = -1, mxy = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (im.data[(y * im.w + x) * 4 + 3] > thr) { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  }
  if (mxx < 0) return null;
  return { x: mnx, y: mny, w: mxx - mnx + 1, h: mxy - mny + 1 };
}
export function trimAlpha(im) {
  const b = alphaBbox(im);
  if (!b) throw new Error('画像が空');
  return crop(im, b.x, b.y, b.w, b.h);
}
/** 面積平均（box filter）による縮小。ロゴのエッジを滑らかに保つ。 */
export function resizeArea(im, tw, th) {
  const { w, h, data } = im, out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy0 = y * h / th, sy1 = (y + 1) * h / th;
    for (let x = 0; x < tw; x++) {
      const sx0 = x * w / tw, sx1 = (x + 1) * w / tw;
      let ar = 0, ag = 0, ab = 0, aa = 0, wsum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const fy = Math.min(sy + 1, sy1) - Math.max(sy, sy0); if (fy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const fx = Math.min(sx + 1, sx1) - Math.max(sx, sx0); if (fx <= 0) continue;
          const i = (sy * w + sx) * 4, f = fx * fy, a = data[i + 3] / 255;
          ar += data[i] * a * f; ag += data[i + 1] * a * f; ab += data[i + 2] * a * f;
          aa += data[i + 3] * f; wsum += f;
        }
      }
      const d = (y * tw + x) * 4, alpha = aa / wsum;
      const norm = alpha > 0 ? (alpha / 255) * wsum : 1;
      out[d] = Math.round(ar / norm); out[d + 1] = Math.round(ag / norm); out[d + 2] = Math.round(ab / norm);
      out[d + 3] = Math.round(alpha);
    }
  }
  return { w: tw, h: th, data: out };
}

const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const satOf = (r, g, b) => { const mx = Math.max(r, g, b); return mx ? (mx - Math.min(r, g, b)) / mx : 0; };

/** エンブレムとワードマークの境界（最も広い全透明の縦帯）を検出する。 */
export function findEmblemSplit(im) {
  const empty = [];
  for (let x = 0; x < im.w; x++) {
    let ink = 0;
    for (let y = 0; y < im.h; y++) if (im.data[(y * im.w + x) * 4 + 3] > 16) { ink = 1; break; }
    empty.push(ink === 0);
  }
  let best = null, s = -1;
  for (let x = 0; x <= im.w; x++) {
    if (x < im.w && empty[x]) { if (s < 0) s = x; }
    else { if (s >= 0 && (!best || x - s > best.w)) best = { x0: s, x1: x - 1, w: x - s }; s = -1; }
  }
  return best; // { x0, x1, w }
}

/** タグライン（低彩度グレーの小文字帯）を検出して消す。y ディセンダ等のネイビーは残す。 */
export function removeTagline(im, wordmarkX0) {
  const cand = [];
  let mnx = im.w, mny = im.h, mxx = -1, mxy = -1;
  for (let y = Math.floor(im.h * 0.7); y < im.h; y++) {
    for (let x = wordmarkX0; x < im.w; x++) {
      const i = (y * im.w + x) * 4;
      if (im.data[i + 3] < 120) continue;
      const r = im.data[i], g = im.data[i + 1], b = im.data[i + 2];
      if (satOf(r, g, b) < 0.32 && lumOf(r, g, b) >= 42 && lumOf(r, g, b) < 125) {
        cand.push(i);
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
      }
    }
  }
  if (!cand.length) return { removed: 0, bbox: null };
  // 検出領域内のグレー画素のみ透明化（矩形一括消去はしない＝重なるネイビーを守る）
  for (const i of cand) im.data[i + 3] = 0;
  // 取りこぼしのアンチエイリアス残渣も同 bbox 内で薄いものだけ消す
  let extra = 0;
  for (let y = mny; y <= mxy; y++) for (let x = mnx; x <= mxx; x++) {
    const i = (y * im.w + x) * 4;
    const a = im.data[i + 3];
    if (a === 0 || a >= 250) continue;
    const r = im.data[i], g = im.data[i + 1], b = im.data[i + 2];
    if (satOf(r, g, b) < 0.42 && lumOf(r, g, b) >= 35) { im.data[i + 3] = 0; extra++; }
  }
  return { removed: cand.length, antialiasRemoved: extra, bbox: { x: mnx, y: mny, w: mxx - mnx + 1, h: mxy - mny + 1 } };
}

/**
 * 暗背景用にワードマーク側の低輝度（ネイビー／グレー）を白へ寄せる。
 * エンブレムは元の鮮やかな配色のまま残す（ブランド忠実性）。
 * 彩度の高いアクセント（cyan / pink / orange）は輝度が高いので影響を受けない。
 */
export function lightenForDarkBackground(im, wordmarkX0, { threshold = 95 } = {}) {
  let n = 0;
  for (let y = 0; y < im.h; y++) for (let x = wordmarkX0; x < im.w; x++) {
    const i = (y * im.w + x) * 4;
    if (im.data[i + 3] === 0) continue;
    const r = im.data[i], g = im.data[i + 1], b = im.data[i + 2];
    const lum = lumOf(r, g, b);
    if (lum >= threshold) continue;
    // 暗いほど強く白へ。本体ネイビー(lum~23)→ほぼ白 / タグライン級グレー(lum~74)→淡いグレー
    const amount = lum <= 30 ? 0.97 : 0.97 - 0.45 * ((lum - 30) / (threshold - 30));
    im.data[i] = Math.round(r + (255 - r) * amount);
    im.data[i + 1] = Math.round(g + (255 - g) * amount);
    im.data[i + 2] = Math.round(b + (255 - b) * amount);
    n++;
  }
  return n;
}

async function main() {
  if (!fs.existsSync(SRC)) { console.error('[logo] マスターが無い: ' + toProjectRelativePath(SRC)); process.exit(1); }
  const srcBuf = fs.readFileSync(SRC);
  const src = decodePng(srcBuf);
  const base = trimAlpha(src);
  const split = findEmblemSplit(base);
  if (!split || split.w < 8) throw new Error('エンブレムとワードマークの境界を検出できない');
  const emblemBox = alphaBbox(base, 0, split.x0 - 1);
  const wordX0 = split.x1 + 1;

  // ── horizontal（タグライン除去）──
  const noTag = clone(base);
  const tag = removeTagline(noTag, wordX0);
  const horiz = trimAlpha(noTag);
  const horizOut = resizeArea(horiz, Math.max(1, Math.round(horiz.w * TARGET_H / horiz.h)), TARGET_H);

  // ── horizontal-dark ──
  const darkSrc = clone(noTag);
  // trim 前の座標系でワードマーク領域を指定する
  const lightened = lightenForDarkBackground(darkSrc, wordX0);
  const dark = trimAlpha(darkSrc);
  const darkOut = resizeArea(dark, Math.max(1, Math.round(dark.w * TARGET_H / dark.h)), TARGET_H);

  // ── icon（エンブレムのみ）──
  const icon = trimAlpha(crop(base, emblemBox.x, emblemBox.y, emblemBox.w, emblemBox.h));
  const iconOut = resizeArea(icon, Math.max(1, Math.round(icon.w * TARGET_H / icon.h)), TARGET_H);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  const write = (name, im) => {
    const buf = encodePng(im);
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, buf);
    files.push({ file: name, w: im.w, h: im.h, aspect: +(im.w / im.h).toFixed(4), bytes: buf.length });
  };
  write('livecity-logo-horizontal.png', horizOut);
  write('livecity-logo-horizontal-dark.png', darkOut);
  write('livecity-logo-icon.png', iconOut);

  const report = {
    generatedAt: new Date().toISOString(),
    source: toProjectRelativePath(SRC),
    sourceSize: { w: src.w, h: src.h },
    trimmedSize: { w: base.w, h: base.h },
    emblemBox, emblemSplitGap: split, wordmarkX0: wordX0,
    taglineRemoval: tag,
    darkVariantPixelsLightened: lightened,
    targetHeight: TARGET_H,
    outDir: toProjectRelativePath(OUT_DIR),
    files,
    notes: [
      'マスターは既に背景透過。白背景の除去は不要（floodfill していない）。',
      'タグライン "SEE MORE LIFE" は低彩度グレーとして検出し画素単位で除去。"City" の y ディセンダ（ネイビー）は保持。',
      'dark 版はワードマーク領域の低輝度画素のみ白へ寄せ、エンブレムの配色は変更しない。',
      '縮小は面積平均。拡大は行わない（元 519px 高 → 120px）。',
    ],
    RESULT: files.length === 3 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, report);

  console.log('[logo] source ' + src.w + 'x' + src.h + ' → trimmed ' + base.w + 'x' + base.h);
  console.log('  emblem ' + emblemBox.w + 'x' + emblemBox.h + ' / gap x' + split.x0 + '-' + split.x1 + ' / wordmark x' + wordX0 + '-');
  console.log('  tagline removed: ' + tag.removed + 'px' + (tag.bbox ? ' bbox ' + JSON.stringify(tag.bbox) : ''));
  console.log('  dark variant lightened: ' + lightened + 'px');
  for (const f of files) console.log('  → ' + f.file + '  ' + f.w + 'x' + f.h + ' (aspect ' + f.aspect + ', ' + (f.bytes / 1024).toFixed(1) + 'KB)');
  console.log('保存: ' + toProjectRelativePath(REPORT) + '  RESULT: ' + report.RESULT);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[logo] 失敗:', e && e.stack || e); process.exit(1); });
