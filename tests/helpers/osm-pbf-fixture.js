// tests/helpers/osm-pbf-fixture.js
// 合成 .osm.pbf バッファを組み立てる（テスト用）。
// osm-pbf-parser 同梱の .proto 定義（lib/parsers.js）をそのまま使うため、パッケージ未インストール時は
// 呼び出し側でスキップすること（hasOsmPbfParser() を参照）。
//
// 生成物: OSMHeader ブロック + OSMData ブロック1個（dense nodes + ways + relations）。
// 座標は granularity=100 / offset=0（1 単位 = 1e-7 度）で符号化する。

import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function hasOsmPbfParser() {
  try { require.resolve('osm-pbf-parser'); return true; } catch { return false; }
}

const COORD_UNIT = 1e-7; // granularity(100) * NANO(1e-9)
const encCoord = (v) => Math.round(v / COORD_UNIT);
const deltas = (arr) => arr.map((v, i) => (i === 0 ? v : v - arr[i - 1]));

/**
 * @param {object} spec
 * @param {Array<{id:number,lat:number,lon:number,tags?:object}>} spec.nodes
 * @param {Array<{id:number,refs:number[],tags?:object}>} spec.ways
 * @param {Array<{id:number,tags?:object,members:Array<{type:'node'|'way'|'relation',ref:number,role:string}>}>} [spec.relations]
 * @returns {Buffer} .osm.pbf の中身
 */
export function buildOsmPbf(spec) {
  const parsers = require('osm-pbf-parser/lib/parsers.js');

  // ── stringtable（index 0 は空文字列）──
  const strings = [''];
  const idx = new Map([['', 0]]);
  const intern = (s) => {
    if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); }
    return idx.get(s);
  };
  const tagKV = (tags = {}) => {
    const keys = [], vals = [];
    for (const k of Object.keys(tags)) { keys.push(intern(k)); vals.push(intern(String(tags[k]))); }
    return { keys, vals };
  };

  // ── dense nodes ──
  const nodes = [...spec.nodes].sort((a, b) => a.id - b.id);
  const keysVals = [];
  for (const n of nodes) {
    for (const k of Object.keys(n.tags || {})) { keysVals.push(intern(k), intern(String(n.tags[k]))); }
    keysVals.push(0); // ノード区切り
  }
  const dense = {
    id: deltas(nodes.map((n) => n.id)),
    lat: deltas(nodes.map((n) => encCoord(n.lat))),
    lon: deltas(nodes.map((n) => encCoord(n.lon))),
    keys_vals: keysVals,
  };

  // ── ways ──
  const ways = spec.ways.map((w) => {
    const { keys, vals } = tagKV(w.tags);
    return { id: w.id, keys, vals, refs: deltas(w.refs) };
  });

  // ── relations ──
  const TYPE_ENUM = { node: 0, way: 1, relation: 2 };
  const relations = (spec.relations || []).map((r) => {
    const { keys, vals } = tagKV(r.tags);
    return {
      id: r.id, keys, vals,
      roles_sid: r.members.map((m) => intern(m.role || '')),
      memids: deltas(r.members.map((m) => m.ref)),
      types: r.members.map((m) => TYPE_ENUM[m.type]),
    };
  });

  const primitiveBlock = parsers.osm.PrimitiveBlock.encode({
    stringtable: { s: strings.map((s) => Buffer.from(s, 'utf8')) },
    granularity: 100, lat_offset: 0, lon_offset: 0, date_granularity: 1000,
    primitivegroup: [{ nodes: [], changesets: [], dense, ways, relations }],
  });
  const headerBlock = parsers.osm.HeaderBlock.encode({
    required_features: ['OsmSchema-V0.6', 'DenseNodes'], optional_features: [],
  });

  const frame = (type, block) => {
    const blob = parsers.file.Blob.encode({ zlib_data: zlib.deflateSync(block), raw_size: block.length });
    const bh = parsers.file.BlobHeader.encode({ type, datasize: blob.length });
    const size = Buffer.alloc(4); size.writeUInt32BE(bh.length, 0);
    return Buffer.concat([size, bh, blob]);
  };

  return Buffer.concat([frame('OSMHeader', headerBlock), frame('OSMData', primitiveBlock)]);
}
