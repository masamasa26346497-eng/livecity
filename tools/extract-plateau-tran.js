#!/usr/bin/env node
// tools/extract-plateau-tran.js
// [Mission 31C2 §3] ローカルの PLATEAU 市配布 CityGML ZIP から udx/tran/*.gml と codelists を抽出する。
//   ネットワーク取得（tools/fetch-plateau.js --layer tran）が使えない環境向けの代替経路。
//   取得ではなく「ローカル ZIP からの展開」なので、source metadata に配布元 ZIP を明記する（§3）。
//
// 実行:
//   node tools/extract-plateau-tran.js --zip "<...>/27100_osaka-shi_city_2025_citygml_1_op.zip"
//     [--out data/raw/plateau/osaka-city/tran/] [--limit N] [--list]
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { readZipEntries, extractEntry } from './lib/zip-reader.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const OUT_DEFAULT = P('data', 'raw', 'plateau', 'osaka-city', 'tran');
const REPORT = P('data', 'reports', 'plateau-tran-extraction.json');

const TRAN_RE = /(^|\/)udx\/tran\/[^/]+\.gml$/i;
const CODELIST_RE = /(^|\/)codelists\/[^/]+\.xml$/i;
const METADATA_RE = /(^|\/)(metadata|README|.*\.xml)$/i;

/** ZIP エントリ一覧から tran GML / codelist を選ぶ。 */
export function selectTranEntries(entries) {
  return {
    gml: entries.filter((e) => TRAN_RE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)),
    codelists: entries.filter((e) => CODELIST_RE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** 配布 ZIP 名から city code / 年度 / 版を読む。例: 27100_osaka-shi_city_2025_citygml_1_op.zip */
export function parseDistributionName(zipName) {
  const base = path.basename(zipName, path.extname(zipName));
  const m = base.match(/^(\d{5})_([a-z-]+)_([a-z-]+)_(\d{4})_citygml_(\d+)(?:_(\w+))?$/i);
  return {
    distributionName: base,
    cityCode: m ? m[1] : null,
    cityName: m ? m[2] : null,
    datasetYear: m ? Number(m[4]) : null,
    revision: m ? m[5] : null,
    variant: m ? (m[6] || null) : null, // op = オープンデータ版
  };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const k = process.argv[i].slice(2);
      const v = (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[++i] : true;
      args[k] = v;
    }
  }
  if (!args.zip) { console.error('--zip <配布 ZIP パス> が必要'); process.exit(1); }
  const zip = path.resolve(String(args.zip));
  if (!fs.existsSync(zip)) { console.error('ZIP が存在しない: ' + zip); process.exit(1); }
  const outDir = args.out ? resolveProjectPath(args.out) : OUT_DEFAULT;

  const entries = readZipEntries(zip);
  const sel = selectTranEntries(entries);
  console.log('[extract-plateau-tran] ZIP entries ' + entries.length + ' → tran GML ' + sel.gml.length + ' / codelist ' + sel.codelists.length);
  if (args.list) {
    for (const e of sel.gml.slice(0, 20)) console.log('  ' + e.name + '  ' + (e.uncompSize / 1024).toFixed(0) + 'KB');
    return;
  }
  if (!sel.gml.length) { console.error('udx/tran/*.gml が ZIP 内に無い'); process.exit(1); }

  const limit = args.limit ? Number(args.limit) : sel.gml.length;
  const gmlDir = outDir;
  const clDir = path.join(path.dirname(outDir), 'codelists');
  fs.mkdirSync(gmlDir, { recursive: true });
  fs.mkdirSync(clDir, { recursive: true });

  let bytes = 0; const written = [];
  for (const e of sel.gml.slice(0, limit)) {
    const buf = extractEntry(zip, e);
    const dest = path.join(gmlDir, path.basename(e.name));
    fs.writeFileSync(dest, buf);
    bytes += buf.length;
    written.push({ file: path.basename(e.name), bytes: buf.length });
  }
  let clCount = 0;
  for (const e of sel.codelists) {
    fs.writeFileSync(path.join(clDir, path.basename(e.name)), extractEntry(zip, e));
    clCount++;
  }

  const dist = parseDistributionName(zip);
  const st = fs.statSync(zip);
  // §3 source metadata: 出典 / データセット版 / 市コード / 取得日 / ソースファイル / ライセンス
  const meta = {
    source: 'PLATEAU (国土交通省) CityGML 市配布パッケージ',
    sourceUrl: 'https://www.geospatial.jp/ckan/dataset/plateau-27100-osaka-shi-2025',
    acquisitionMethod: 'local-zip-extract',
    sourceArchive: path.basename(zip),
    sourceArchivePath: zip,
    sourceArchiveBytes: st.size,
    sourceArchiveMtime: st.mtime.toISOString(),
    ...dist,
    layer: 'tran',
    license: 'CC BY 4.0 (PLATEAU オープンデータ)',
    attribution: '出典: 国土交通省 Project PLATEAU（大阪市 2025年度 CityGML）',
    extractedAt: new Date().toISOString(),
    gmlCount: written.length,
    gmlBytes: bytes,
    codelistCount: clCount,
    codelistDir: toProjectRelativePath(clDir),
    coordinateReferenceSystem: 'EPSG:6697 (JGD2011 + 標高, lat lon alt)',
    note: 'ネットワーク非依存の抽出。fetch-plateau.js --layer tran と同じ配置先に展開する。',
  };
  await writeJson(path.join(gmlDir, 'source-metadata.json'), meta);

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  await writeJson(REPORT, {
    generatedAt: new Date().toISOString(),
    zip: path.basename(zip), outDir: toProjectRelativePath(gmlDir),
    zipEntryCount: entries.length, tranGmlInZip: sel.gml.length,
    extractedGml: written.length, extractedBytes: bytes, codelists: clCount,
    largest: written.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    metadata: meta,
    RESULT: written.length === sel.gml.length ? 'EXTRACTED' : 'PARTIAL',
  });
  console.log('  展開: ' + written.length + ' GML / ' + (bytes / 1048576).toFixed(1) + 'MB, codelist ' + clCount);
  console.log('保存: ' + toProjectRelativePath(gmlDir) + ' / ' + toProjectRelativePath(REPORT));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error('[extract-plateau-tran] 失敗:', e && e.stack || e); process.exit(1); });
