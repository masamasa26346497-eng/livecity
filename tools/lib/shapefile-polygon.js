// tools/lib/shapefile-polygon.js
// Mission 35L: e-Stat 町丁・字等 Shapefile を追加依存なしで読むための最小実装。
// 対象: ESRI Shapefile Polygon / PolygonZ / PolygonM + dBASE III/IV 属性。
// PolyLine/Point 等はこの用途では受け付けない。座標系の変換はここでは行わない。

function trimNullAscii(buffer, start, length) {
  let end = start + length;
  while (end > start && (buffer[end - 1] === 0x00 || buffer[end - 1] === 0x20)) end--;
  return buffer.toString('ascii', start, end).replace(/\0.*$/, '').trim();
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return [...ring, [...a]];
  return ring;
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Shapefile の parts を GeoJSON Polygon/MultiPolygon に組み直す。
 * orientation だけに依存せず、包含関係の深さで outer / hole を決める。
 */
export function ringsToGeoJsonGeometry(inputRings) {
  const rings = inputRings
    .map(closeRing)
    .filter((r) => r.length >= 4 && Math.abs(signedArea(r)) > 1e-18)
    .map((ring, index) => ({ index, ring, absArea: Math.abs(signedArea(ring)), parent: null, depth: 0 }));
  if (!rings.length) return null;

  const byAreaDesc = [...rings].sort((a, b) => b.absArea - a.absArea);
  for (let i = 0; i < byAreaDesc.length; i++) {
    const child = byAreaDesc[i];
    let parent = null;
    for (let j = 0; j < i; j++) {
      const candidate = byAreaDesc[j];
      if (!pointInRing(child.ring[0], candidate.ring)) continue;
      if (!parent || candidate.absArea < parent.absArea) parent = candidate;
    }
    child.parent = parent;
    child.depth = parent ? parent.depth + 1 : 0;
  }

  const outers = byAreaDesc.filter((r) => r.depth % 2 === 0);
  const polygons = outers.map((outer) => {
    const holes = byAreaDesc
      .filter((r) => r.depth % 2 === 1 && r.parent === outer)
      .map((r) => r.ring);
    return [outer.ring, ...holes];
  });
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

export function parsePolygonShp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) throw new Error('SHP header is missing');
  const fileCode = buffer.readInt32BE(0);
  if (fileCode !== 9994) throw new Error(`invalid SHP file code: ${fileCode}`);
  const version = buffer.readInt32LE(28);
  if (version !== 1000) throw new Error(`unsupported SHP version: ${version}`);

  const records = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const recordNumber = buffer.readInt32BE(offset);
    const contentBytes = buffer.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const end = start + contentBytes;
    if (contentBytes < 4 || end > buffer.length) throw new Error(`truncated SHP record ${recordNumber}`);
    const shapeType = buffer.readInt32LE(start);
    if (shapeType === 0) {
      records.push(null);
      offset = end;
      continue;
    }
    if (![5, 15, 25].includes(shapeType)) {
      throw new Error(`unsupported shape type ${shapeType} in record ${recordNumber}`);
    }
    if (start + 44 > end) throw new Error(`short polygon record ${recordNumber}`);
    const numParts = buffer.readInt32LE(start + 36);
    const numPoints = buffer.readInt32LE(start + 40);
    if (numParts <= 0 || numPoints <= 0) throw new Error(`empty polygon record ${recordNumber}`);
    const partsOffset = start + 44;
    const pointsOffset = partsOffset + numParts * 4;
    if (pointsOffset + numPoints * 16 > end) throw new Error(`invalid polygon lengths in record ${recordNumber}`);

    const partStarts = [];
    for (let i = 0; i < numParts; i++) partStarts.push(buffer.readInt32LE(partsOffset + i * 4));
    const points = [];
    for (let i = 0; i < numPoints; i++) {
      const p = pointsOffset + i * 16;
      points.push([buffer.readDoubleLE(p), buffer.readDoubleLE(p + 8)]);
    }
    const rings = [];
    for (let i = 0; i < numParts; i++) {
      const from = partStarts[i];
      const to = i + 1 < numParts ? partStarts[i + 1] : numPoints;
      if (from < 0 || to > numPoints || to <= from) throw new Error(`invalid part index in record ${recordNumber}`);
      rings.push(points.slice(from, to));
    }
    records.push(ringsToGeoJsonGeometry(rings));
    offset = end;
  }
  return records;
}

export function parseDbf(buffer, { encoding = 'shift_jis' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) throw new Error('DBF header is missing');
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  if (headerLength < 33 || recordLength < 2 || headerLength > buffer.length) throw new Error('invalid DBF header');

  const fields = [];
  for (let off = 32; off + 32 <= headerLength && buffer[off] !== 0x0d; off += 32) {
    const name = trimNullAscii(buffer, off, 11);
    const type = String.fromCharCode(buffer[off + 11]);
    const length = buffer[off + 16];
    if (!name || !length) continue;
    fields.push({ name, type, length });
  }

  let decoder;
  try { decoder = new TextDecoder(encoding); }
  catch { decoder = new TextDecoder('utf-8'); }
  const records = [];
  for (let i = 0; i < recordCount; i++) {
    const off = headerLength + i * recordLength;
    if (off + recordLength > buffer.length) throw new Error(`truncated DBF record ${i + 1}`);
    if (buffer[off] === 0x2a) { records.push(null); continue; } // deleted
    let cursor = off + 1;
    const row = {};
    for (const field of fields) {
      const bytes = buffer.subarray(cursor, cursor + field.length);
      let value = decoder.decode(bytes).replace(/\0/g, '').trim();
      if (field.type === 'L') value = /^[YyTt1]/.test(value);
      row[field.name] = value;
      cursor += field.length;
    }
    records.push(row);
  }
  return { fields, records };
}

export function shapefileToFeatureCollection(shpBuffer, dbfBuffer, options = {}) {
  const geometries = parsePolygonShp(shpBuffer);
  const { records: attributes, fields } = parseDbf(dbfBuffer, options);
  const count = Math.max(geometries.length, attributes.length);
  const features = [];
  for (let i = 0; i < count; i++) {
    const geometry = geometries[i];
    const properties = attributes[i];
    if (!geometry || !properties) continue;
    features.push({ type: 'Feature', properties, geometry });
  }
  return { type: 'FeatureCollection', features, _dbfFields: fields.map((f) => f.name) };
}
