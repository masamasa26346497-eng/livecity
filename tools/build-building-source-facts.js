#!/usr/bin/env node
// tools/build-building-source-facts.js
// [Mission 32S §2/§3/§10] property card が「実データの裏付けがある値だけ」を出せるようにするための追加データ。
//   canonical（V2N）の建物属性には heightM しか無く、変換時の既定値（3.0m）と実測値を画面で区別できない。
//   ここでは既存の建物 tile / placement / geometry を一切書き換えず、別 namespace に facts tile を新規生成する。
//     heightBasis: 1=measuredHeight（実測） 2=geometry（LOD 形状の標高差） 3=storeys（階数×3.0m の換算）
//                  4=osm-tag（OSM の height / building:levels タグ） 0=根拠なし（変換時の既定値）
//     storeys: PLATEAU bldg:storeysAboveGround の実値（1〜200 以外のセンチネルは 0）
//   出力: data/processed/osaka-city/derived-v2-osmv2/building-facts/tile_x_z.json（+ public へ mirror）
//         data/reports/building-source-facts.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, isMainModule } from './lib/paths.js';
import { writeFilesVerified, readFileRetry } from './lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const FACTS = P('data', 'processed', 'osaka-city', 'canonical', 'plateau-height-facts.json');

/**
 * [Mission 35G §4] facts は **建物 namespace ごと** に要る。
 *   property card は `CanonicalRuntime.getBuildingDataBase()` の下の building-facts を読むので、
 *   V4 へ cutover すると `derived-v4-final/building-facts` を見に行く。
 *   そこに無いと `BuildingFacts.get()` が全棟 null を返し、**高さと階数が全部消える**
 *   （`applyBuildingFacts` は根拠を確かめられない値を出さない設計のため）。
 *   判定ロジック（`factOf`）は 32S のまま。読む canonical と書く namespace を差し替えるだけ。
 */
export const NAMESPACES = {
  V2N: { canonical: 'buildings-v2-osmv2', derived: 'derived-v2-osmv2', missionId: '32S' },
  V4: { canonical: 'buildings-v4-final', derived: 'derived-v4-final', missionId: '35G' },
};
export function dirsFor(ns) {
  const n = NAMESPACES[ns];
  if (!n) throw new Error('知らない namespace: ' + ns);
  return {
    canon: P('data', 'processed', 'osaka-city', 'canonical', n.canonical),
    outDirs: [
      P('data', 'processed', 'osaka-city', n.derived, 'building-facts'),
      P('public', 'map-data', 'osaka-city', n.derived, 'building-facts'),
    ],
    report: P('data', 'reports', 'building-source-facts' + (ns === 'V2N' ? '' : '-' + ns.toLowerCase()) + '.json'),
    missionId: n.missionId,
  };
}
const rj = (p) => JSON.parse(readFileRetry(p));

export const HEIGHT_BASIS = { none: 0, measured: 1, geometry: 2, storeys: 3, osmTag: 4 };
const okStoreys = (v) => v != null && v >= 1 && v <= 200;
const okMeasured = (v) => v != null && v > 0 && v < 1000;

/** 建物 1 棟の事実（変換器 tools/convert-plateau-buildings.js の判定順と同じ順序で決める） */
export function factOf(attr, raw) {
  if (attr.source !== 'plateau-building') {
    // OSM fallback: canonical が heightUnknown を持っている（tools/lib/osm-building-fallback.js）
    return { basis: attr.heightUnknown ? HEIGHT_BASIS.none : HEIGHT_BASIS.osmTag, storeys: 0 };
  }
  if (!raw) return { basis: HEIGHT_BASIS.none, storeys: 0 };
  const storeys = okStoreys(raw.s) ? raw.s : 0;
  if (okMeasured(raw.m)) return { basis: HEIGHT_BASIS.measured, storeys };
  // measuredHeight が無い場合、変換器は 1) LOD 形状の標高差 2) 階数×3.0m 3) 既定値 3.0m の順に落とす
  if (storeys && Math.abs(attr.heightM - Math.round(storeys * 3.0 * 10) / 10) < 0.051) return { basis: HEIGHT_BASIS.storeys, storeys };
  if (attr.heightM === 3) return { basis: HEIGHT_BASIS.none, storeys };
  return { basis: HEIGHT_BASIS.geometry, storeys };
}

export function buildAll(ns = 'V2N') {
  const { canon: CANON, missionId } = dirsFor(ns);
  const raw = rj(FACTS).facts;
  const files = fs.readdirSync(CANON).filter((f) => /^tile_-?\d+_-?\d+\.json$/.test(f)).sort();
  const out = new Map();
  const stat = { tiles: 0, buildings: 0, byBasis: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }, withStoreys: 0, plateau: 0, osm: 0 };
  for (const f of files) {
    const a = rj(path.join(CANON, 'attributes', f)).attributes;
    const facts = {};
    for (const cid in a) {
      const attr = a[cid];
      const r = factOf(attr, raw[cid.replace(/^cg_bldg_/, '')]);
      facts[cid] = r.storeys ? [r.basis, r.storeys] : [r.basis];
      stat.buildings++;
      stat.byBasis[r.basis]++;
      if (r.storeys) stat.withStoreys++;
      if (attr.source === 'plateau-building') stat.plateau++; else stat.osm++;
    }
    const m = /^tile_(-?\d+)_(-?\d+)\.json$/.exec(f);
    out.set(f, JSON.stringify({
      tileId: `${m[1]}_${m[2]}`, version: 1, missionId, namespace: ns,
      note: 'heightBasis: 0=根拠なし 1=measuredHeight 2=LOD形状 3=階数×3.0m 4=OSMタグ / 2 要素目は storeysAboveGround の実値',
      facts,
    }));
    stat.tiles++;
  }
  return { out, stat };
}

async function main(ns = 'V2N') {
  const { outDirs: OUT_DIRS, report: OUT_REPORT, missionId } = dirsFor(ns);
  const { out, stat } = buildAll(ns);
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    // 既存の建物 tile / placement は触らない。この namespace は今回新規なので stray 削除もしない（§0）
    const r = writeFilesVerified(dir, out, { label: 'building-facts', removeStray: false });
    console.log('[facts] wrote', dir, JSON.stringify(r));
  }
  const report = { version: 1, generatedAt: new Date().toISOString(), missionId, namespace: ns, stat,
    outDirs: OUT_DIRS.map((d) => path.relative(resolveProjectPath('.'), d).replace(/\\/g, '/')) };
  fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2));
  return report;
}

if (isMainModule(import.meta.url)) {
  const ns = (process.argv.find((a) => a.startsWith('--namespace=')) || '').slice(12) || 'V2N';
  main(ns).then((r) => { console.log('[facts]', ns, JSON.stringify(r.stat)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
