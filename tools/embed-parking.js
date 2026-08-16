#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/embed-parking.js
// ══════════════════════════════════════════════════════════════
// landuse.json から平面駐車場（parking_surface / parking_unspecified）のみを抽出し、
// 正規版HTML内の `const OSM_PARKING = ...;` 行を生成して差し替える（無ければ
// `const OSM_PARKS = ...;` 行の直後へ挿入する）。
//
// - parking_multi_storey / parking_underground / parking_rooftop は埋め込み対象外
// - landuse.json 自体は読み取りのみで一切変更しない
// - 保持するタグは必要最小限（KEEP_TAGS）のみ
// - OSMの閉じたリング（先頭＝末尾の重複頂点）は開リングへ正規化して埋め込む
//   （実行時の三角形分割・頂点数判定を正しくするため）
//
// 使い方: node tools/embed-parking.js <landuse.json> <target.html>

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';

const TARGET_SUBTYPES = ['parking_surface', 'parking_unspecified'];
const EXCLUDED_SUBTYPES = ['parking_multi_storey', 'parking_underground', 'parking_rooftop'];
const KEEP_TAGS = ['name', 'fee', 'capacity', 'access', 'operator', 'surface'];

function openRing(ring) {
  // 重複終点（閉じたリング）を開リング化。座標値そのものは変更しない。
  if (Array.isArray(ring) && ring.length >= 2) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

function minimal(entry) {
  const t = entry.tags || {};
  const o = { id: entry.id, subtype: entry.subtype };
  for (const k of KEEP_TAGS) {
    if (t[k] !== undefined && t[k] !== null) o[k] = t[k];
  }
  o.polygons = (entry.polygons || []).map(pg => ({
    outer: openRing(pg.outer),
    holes: (pg.holes || []).map(openRing)
  }));
  return o;
}

function main() {
  const [landusePath, htmlPath] = process.argv.slice(2);
  if (!landusePath || !htmlPath) {
    console.error('usage: node tools/embed-parking.js <landuse.json> <target.html>');
    process.exit(1);
  }

  const landuse = JSON.parse(fs.readFileSync(landusePath, 'utf8'));
  // 抽出条件: category === "parking" かつ 平面系subtype。点データ（polygonsなし）は除外。
  const target = landuse.filter(x => x.category === 'parking' &&
    TARGET_SUBTYPES.includes(x.subtype) &&
    Array.isArray(x.polygons) && x.polygons.length > 0);
  const excluded = landuse.filter(x => x.category === 'parking' && !target.includes(x));
  const surface = target.filter(x => x.subtype === 'parking_surface').length;
  const unspecified = target.filter(x => x.subtype === 'parking_unspecified').length;

  const out = target.map(minimal);
  const line = 'const OSM_PARKING = ' + JSON.stringify(out) +
    '; // OSM平面駐車場データ（landuse.json由来、parking_surface ' + surface +
    '件 + parking_unspecified ' + unspecified + '件 = ' + out.length +
    '件。parking_multi_storey等の立体系' + excluded.length +
    '件は除外。閉じたリングの末尾重複点は除去済み（開リング形式）。属性は必要最小限のみ保持。tools/embed-parking.jsで生成）';

  let html = fs.readFileSync(htmlPath, 'utf8');
  const lines = html.split('\n');
  const metaLine = 'const OSM_PARKING_META = ' + JSON.stringify({
    sourceTotal: target.length + excluded.length, // landuse.json内のcategory==="parking"総数
    embedded: out.length,                          // HTMLへ埋め込んだ平面駐車場数
    excludedMultiStorey: excluded.length           // 立体系（multi_storey等）の除外数
  }) + '; // 駐車場データのメタ情報（tools/embed-parking.jsが生成。ParkingLayerの統計が参照する）';
  const existing = lines.findIndex(l => l.startsWith('const OSM_PARKING = '));
  const existingMeta = lines.findIndex(l => l.startsWith('const OSM_PARKING_META = '));
  if (existingMeta >= 0) lines[existingMeta] = metaLine;
  if (existing >= 0) {
    lines[existing] = line;
    if (existingMeta < 0) lines.splice(existing, 0, metaLine); // METAをOSM_PARKING直前へ新規挿入
    console.log('replaced existing OSM_PARKING at line ' + (existing + 1));
  } else {
    const anchor = lines.findIndex(l => l.startsWith('const OSM_PARKS = '));
    if (anchor < 0) {
      console.error('anchor (const OSM_PARKS = ) not found');
      process.exit(1);
    }
    lines.splice(anchor + 1, 0, metaLine, line);
    console.log('inserted OSM_PARKING_META + OSM_PARKING after line ' + (anchor + 1));
  }
  fs.writeFileSync(htmlPath, lines.join('\n'));

  console.log('source total (parking): ' + (target.length + excluded.length));
  console.log('embedded: ' + out.length + ' (surface ' + surface + ' / unspecified ' + unspecified + ')');
  console.log('excluded (multi_storey/underground/rooftop): ' + excluded.length);
  console.log('embedded line bytes: ' + line.length);
}

main();
