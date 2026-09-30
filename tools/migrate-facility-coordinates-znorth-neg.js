// tools/migrate-facility-coordinates-znorth-neg.js
// Existing facilities.json files may contain localZ from the pre-znorth-neg-v1
// convention (north=+Z). Re-project every facility from its authoritative
// latitude/longitude instead of flipping localZ in place.
//
// Usage:
//   node tools/migrate-facility-coordinates-znorth-neg.js --area osaka-sumiyoshi

import path from 'node:path';
import {
  loadAreaConfig,
  processedDir,
  publicMapDataDir,
  readJsonIfExists,
  writeJson,
  writeJsonCompact,
} from './lib/area.js';
import {
  geoToRuntimeLocal,
  RUNTIME_COORDINATE_CONVENTION,
} from './lib/projection.js';

function parseArgs(argv) {
  const args = { area: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
  }
  return args;
}

export function normalizeFacilityRecords(records, projection) {
  let changed = 0;
  let unchanged = 0;
  const missingCoordinates = [];

  const normalized = records.map((record) => {
    const lat = Number(record.latitude);
    const lon = Number(record.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      missingCoordinates.push(record.id || null);
      return { ...record };
    }

    const { x, z } = geoToRuntimeLocal(lat, lon, projection);
    const same = Number(record.localX) === x && Number(record.localZ) === z;
    if (same) unchanged++;
    else changed++;

    return { ...record, localX: x, localZ: z };
  });

  return { records: normalized, changed, unchanged, missingCoordinates };
}

function normalizedDataset(dataset, projection) {
  if (!dataset || !Array.isArray(dataset.records)) {
    throw new Error('facilities.json の records 配列が見つかりません。');
  }
  const result = normalizeFacilityRecords(dataset.records, projection);
  return {
    dataset: {
      ...dataset,
      coordinateConvention: RUNTIME_COORDINATE_CONVENTION,
      records: result.records,
    },
    ...result,
  };
}

export async function run(args) {
  if (!args.area) throw new Error('--area が指定されていません。');
  const areaConfig = await loadAreaConfig(args.area);

  const processedPath = path.join(processedDir(args.area), 'facilities', 'facilities.json');
  const publicPath = path.join(publicMapDataDir(args.area), 'facilities', 'facilities.json');
  const publicMetadataPath = path.join(publicMapDataDir(args.area), 'facilities', 'metadata.json');

  const processed = await readJsonIfExists(processedPath);
  const publicData = await readJsonIfExists(publicPath);
  if (!processed && !publicData) {
    throw new Error(`施設データが見つかりません: ${args.area}`);
  }

  let canonicalResult = null;
  if (processed) canonicalResult = normalizedDataset(processed, areaConfig.projection);
  else canonicalResult = normalizedDataset(publicData, areaConfig.projection);

  if (canonicalResult.missingCoordinates.length) {
    throw new Error(
      `緯度経度が無い施設が ${canonicalResult.missingCoordinates.length} 件あります。` +
      ' raw localZ の符号反転では補完せず、処理を中止します。'
    );
  }

  // processed と public は同じ records を持つ契約なので、緯度経度から一度だけ
  // 正規化した canonicalResult を双方へ書く。個別の localZ 反転は行わない。
  await writeJson(processedPath, canonicalResult.dataset);
  await writeJsonCompact(publicPath, canonicalResult.dataset);

  const metadata = await readJsonIfExists(publicMetadataPath);
  if (metadata) {
    await writeJson(publicMetadataPath, {
      ...metadata,
      coordinateConvention: RUNTIME_COORDINATE_CONVENTION,
    });
  }

  const sample = canonicalResult.dataset.records.find((r) => r.id === 'osm-node-750515219');
  console.log(JSON.stringify({
    area: args.area,
    coordinateConvention: RUNTIME_COORDINATE_CONVENTION,
    recordCount: canonicalResult.dataset.records.length,
    changed: canonicalResult.changed,
    unchanged: canonicalResult.unchanged,
    sampleSuperTamadeAbiko: sample
      ? { id: sample.id, localX: sample.localX, localZ: sample.localZ }
      : null,
  }, null, 2));

  return canonicalResult;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error('[facility-coordinate-migration]', err.message);
    process.exit(1);
  });
}
