#!/usr/bin/env node
// tools/build-production-html.js
// [Mission 32U] development で確定した ward-ux-v1 を production HTML へ昇格する。
//   変換は 1 箇所だけ: ビルドプロファイル定数 'development' → 'production'。
//   （production では開発用 overlay が CSS で隠れ、起動時 self-check が動く。コードは同一）
//   protected（fullward-v3）は読むだけで書き換えない。
//   --check を付けると書き込まず、現在の production が dev から生成した内容と一致するかだけ確認する。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath, isMainModule } from './lib/paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const SRC = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
export const DEST = P('public', 'osaka_3d_buildings.html');
export const PROTECTED = P('public', 'osaka_3d_buildings.fullward-v3.html');
const OUT_REPORT = P('data', 'reports', 'production-cutover-build.json');
const DEV_LINE = "const LIVECITY_BUILD_PROFILE = 'development';";
const PROD_LINE = "const LIVECITY_BUILD_PROFILE = 'production';";
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** dev HTML から production HTML の内容を作る（唯一の差分がビルドプロファイル行） */
export function renderProductionHtml(devHtml) {
  const n = devHtml.split(DEV_LINE).length - 1;
  if (n !== 1) throw new Error(`ビルドプロファイル行が ${n} 個（1 個であるべき）: ${DEV_LINE}`);
  if (devHtml.includes(PROD_LINE)) throw new Error('dev HTML に production プロファイル行が既にある');
  return devHtml.replace(DEV_LINE, PROD_LINE);
}

export function buildProductionHtml({ check = false } = {}) {
  const dev = fs.readFileSync(SRC, 'utf-8');
  const next = renderProductionHtml(dev);
  const prevExists = fs.existsSync(DEST);
  const prev = prevExists ? fs.readFileSync(DEST, 'utf-8') : null;
  const result = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32U', check,
    source: 'public/osaka_3d_buildings.ward-ux-v1.html', dest: 'public/osaka_3d_buildings.html',
    devSha256: sha(dev), productionSha256: sha(next),
    previousProductionSha256: prev === null ? null : sha(prev),
    identical: prev === next,
    protectedSha256: sha(fs.readFileSync(PROTECTED)),
    transform: [{ from: DEV_LINE, to: PROD_LINE, count: 1 }],
    bytes: Buffer.byteLength(next),
  };
  if (!check && !result.identical) fs.writeFileSync(DEST, next);
  result.written = !check && !result.identical;
  return result;
}

if (isMainModule(import.meta.url)) {
  const check = process.argv.includes('--check');
  try {
    const r = buildProductionHtml({ check });
    // --check は「現在の production が最後のビルド成果物と一致するか」を見るだけ。
    //   ビルド記録（rollback / 検証の基準）は実際に書き出したときだけ更新する。
    if (!check) fs.writeFileSync(OUT_REPORT, JSON.stringify(r, null, 2));
    console.log('[prod-build]', JSON.stringify({ check: r.check, written: r.written, identical: r.identical, prod: r.productionSha256.slice(0, 12), prev: r.previousProductionSha256 && r.previousProductionSha256.slice(0, 12) }));
    process.exit(check && !r.identical ? 1 : 0);
  } catch (e) { console.error(e.message); process.exit(1); }
}
