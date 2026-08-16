// tools/lib/current-buildings.js
// 正規HTML(public/osaka_3d_buildings.html)内の `const BLDGS = [...]` を「読み取り専用」で
// 解析し、現在の建物id・重心・用途・区・町を取り出す。
//
// 重要: このモジュールはHTMLを一切書き換えない。LOD2 ID照合の基準（現行建物集合）を
// 得るためだけに読む。将来 BuildingDataStore を正式分離するまでの暫定的な単一情報源。

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './paths.js';
import { localToGeo } from './projection.js';

/**
 * 正規HTMLのパスを返す。環境変数 LIVECITY_HTML_PATH があれば優先（テスト用）。
 */
export function currentHtmlPath() {
  if (process.env.LIVECITY_HTML_PATH && existsSync(process.env.LIVECITY_HTML_PATH)) {
    return process.env.LIVECITY_HTML_PATH;
  }
  return path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html');
}

/**
 * BLDGS配列を読み取り、各建物の {id, usage, ward, town, fp, centroidLocal, centroidGeo} を返す。
 * @param {object} projection area設定のprojectionブロック（重心を緯度経度へ戻すのに使う）
 * @returns {Promise<Array>}
 */
export async function loadCurrentBuildings(projection) {
  const html = await readFile(currentHtmlPath(), 'utf-8');
  // 各建物オブジェクトを {"id":"bldg_...", ...} 単位で抜く（貪欲でなく、}まで）。
  const objs = html.match(/\{"id":"bldg_[^{}]*\}/g) || [];
  const buildings = [];
  for (const s of objs) {
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (!o.id || !Array.isArray(o.fp) || o.fp.length === 0) continue;
    let sx = 0, sz = 0;
    for (const p of o.fp) { sx += p[0]; sz += p[1]; }
    sx /= o.fp.length; sz /= o.fp.length;
    const geo = projection ? localToGeo(sx, sz, projection) : null;
    buildings.push({
      id: o.id,
      usage: o.usage ?? null,
      ward: o.ward ?? null,
      town: o.town ?? null,
      centroidLocal: { x: Math.round(sx * 100) / 100, z: Math.round(sz * 100) / 100 },
      centroidGeo: geo ? { lat: geo.lat, lon: geo.lon } : null,
    });
  }
  return buildings;
}

/**
 * 現行建物idの Set を返す（ID照合の高速化用）。
 */
export async function loadCurrentBuildingIdSet(projection) {
  const list = await loadCurrentBuildings(projection);
  return new Set(list.map((b) => b.id));
}
