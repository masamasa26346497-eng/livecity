// tools/lib/gsi-road-edge-format.js
// [Mission 31G-FIX15 §3] GSI raw file の形式を「ファイル内容」から判定する（ファイル名では判定しない）。
import fs from 'node:fs';

/**
 * @param {Buffer} buf 先頭数百バイトで十分
 * @returns {'zip'|'gml-xml'|'geojson'|'shapefile'|'unknown'}
 */
export function detectFormat(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  // ZIP: local file header "PK\x03\x04" or empty archive "PK\x05\x06" / spanned "PK\x07\x08"
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  // Shapefile: big-endian int32 file code 9994 (0x0000270A) at offset 0
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x27 && buf[3] === 0x0a) return 'shapefile';
  const head = buf.slice(0, Math.min(buf.length, 512)).toString('utf-8').trimStart();
  if (head.startsWith('<?xml') || /^<[A-Za-z_:]/.test(head)) return 'gml-xml';
  if (head.startsWith('{')) {
    // JSON かつ GeoJSON らしい type を含むか（他の JSON と区別）
    try {
      const s = buf.slice(0, Math.min(buf.length, 4096)).toString('utf-8');
      if (/"type"\s*:\s*"(FeatureCollection|Feature|LineString|MultiLineString)"/.test(s)) return 'geojson';
    } catch { /* noop */ }
    return 'unknown';
  }
  return 'unknown';
}

/** ファイルの先頭バイトを読んで detectFormat へ渡す。 */
export function detectFileFormat(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    return detectFormat(buf.slice(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/** dir を再帰走査し、README.md / .gitkeep / 隠しファイルを除いた候補ファイルパスを返す。 */
export function listCandidateFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = d + '/' + e.name;
      if (e.isDirectory()) walk(p);
      else if (!/^readme\.md$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
