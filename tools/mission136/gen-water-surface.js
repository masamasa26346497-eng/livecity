#!/usr/bin/env node
// Mission 136: 海面（water-surface）を、リポジトリ既存の公開ポリゴン（ward-classification-polygons.json）だけから決定的に再生成する。
//   node tools/mission136/gen-water-surface.js --out <map-root相当の新規ディレクトリ>
// 出力: <out>/water-surface/water-surface.json（Mission115 の規約: znorth-neg-v1, positions=[x,z,...] 三角形）
// ネットワーク不要・外部データ不要・public/ には書かない。--out は存在しない/空のディレクトリのみ（既存を上書きしない）。
// その後: npm run wards:build-layers -- --map-root <out> --out <layers-root> で区別ファイルへ変換できる。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWaterSurface } from '../build-water-surface.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WARDS_JSON = path.join(ROOT, 'public/map-data/osaka-city/boundaries/ward-classification-polygons.json');

export function generate(outDir, { wardsFile = WARDS_JSON } = {}) {
  const out = path.resolve(outDir);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('--out must be empty or not exist: ' + out);
  const wards = JSON.parse(fs.readFileSync(wardsFile, 'utf8')).wards || [];
  const { payload, report } = buildWaterSurface({ wards });
  if (!payload.emitted) throw new Error('water-surface rejected-to-empty: ' + (payload.validationErrors || []).join('; '));
  const dir = path.join(out, 'water-surface'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'water-surface.json'), tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload)); fs.renameSync(tmp, f);
  return { file: f, triangles: payload.triangleCount, areaKm2: +(payload.areaM2 / 1e6).toFixed(1), validation: report.RESULT };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), i = a.indexOf('--out');
  if (i < 0 || !a[i + 1]) { console.error('usage: --out <new dir>'); process.exit(2); }
  try { console.log(JSON.stringify(generate(a[i + 1]))); } catch (e) { console.error(e.message); process.exit(1); }
}
