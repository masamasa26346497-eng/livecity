// tools/lib/canonical-runtime-adapter.js
// [Mission 31F §31/§32/§33] 31G で ward-ux-v1 を Canonical 表示へ切り替えるための runtime adapter interface。
//   ★ 31F ではこのモジュールを ward-ux-v1.html へ接続しない（§0）。Node テストで interface を固定するだけ。
//   THREE 非依存。derived tile を「読む方法」と「canonicalId → 属性」の引き方だけを定義する。
//
//   設計方針:
//     - runtime は derived/<lod>/<layer>/tile_*.json を距離帯（far/mid/near/ultra-near）で読む
//     - 各 derived feature は canonicalId を持つ → pick 時に attribute store（canonical/<layer>/attributes/ or
//       feature 本体の attributes）から属性を引く
//     - 既存 UI（building popup / ward selection / City Mode / LOD / camera / labels）は
//       「geometry の出所」だけ差し替え、イベント配線は再利用できる形にする

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath } from './paths.js';

const DERIVED = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'derived'));
const CANON = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'canonical'));

export const RUNTIME_LAYERS = ['buildings', 'roads', 'water', 'parks', 'rail'];
export const RUNTIME_LODS = ['far', 'mid', 'near']; // 31G: ultra-near は廃止（near = 完全＋微 simplify）

/** 距離(m) → LOD band。既存 Mission13/24/26 の band 境界に合わせる。 */
export function lodForDistance(distanceM) {
  const d = Number.isFinite(distanceM) ? distanceM : 0;
  if (d > 9000) return 'far';
  if (d > 3500) return 'mid';
  return 'near';
}

/**
 * adapter interface。31G の実装（THREE 側）はこの shape を満たすものを作る。
 * @typedef {Object} CanonicalLayerAdapter
 * @property {string} layer
 * @property {(lod:string) => {tileSize:number, tiles:Array}} manifest
 * @property {(lod:string, tx:number, tz:number) => Object|null} tile   derived tile を返す
 * @property {(canonicalId:string) => Object|null} attributes           canonicalId → 属性
 * @property {(canonicalId:string) => Object|null} canonicalFeature     canonicalId → 元 canonical geometry
 */

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }

/** 指定レイヤーの adapter を組み立てる（Node 側・ファイル読み。runtime では fetch に置換）。 */
export function makeCanonicalLayerAdapter(layer) {
  if (!RUNTIME_LAYERS.includes(layer)) throw new Error('unknown layer: ' + layer);

  const manifestCache = {};
  const attrCache = new Map();

  function manifest(lod) {
    const key = lod;
    if (!manifestCache[key]) manifestCache[key] = readJson(path.join(DERIVED, lod, layer, 'manifest.json'));
    return manifestCache[key];
  }
  function tile(lod, tx, tz) {
    return readJson(path.join(DERIVED, lod, layer, `tile_${tx}_${tz}.json`));
  }
  function attributes(canonicalId) {
    if (attrCache.has(canonicalId)) return attrCache.get(canonicalId);
    let result = null;
    // buildings は attributes/ tile に分離。それ以外は canonical feature の attributes。
    if (layer === 'buildings') {
      // canonicalId から tile 位置を特定できないので、derived ultra-near の attributes を使う（pick payload）。
      // 実 runtime は pick した derived feature の attributes をまず見て、詳細は attributes/ を lazy fetch。
      result = null;
    }
    attrCache.set(canonicalId, result);
    return result;
  }
  function canonicalFeature() { return null; } // runtime では lazy fetch。ここでは interface のみ。

  return { layer, manifest, tile, attributes, canonicalFeature };
}

/**
 * §32 feature picking: render geometry（derived feature）→ canonicalId → 属性。
 *   pick したオブジェクトが { canonicalId } を持てば、そのまま attribute store を引ける。
 */
export function resolvePick(pickResult, adapter) {
  if (!pickResult || !pickResult.canonicalId) return null;
  const cid = pickResult.canonicalId;
  return {
    canonicalId: cid,
    layer: adapter.layer,
    lod: pickResult.lod || null,
    attributes: pickResult.attributes || adapter.attributes(cid) || null,
    derivedFrom: pickResult.derivedFrom || cid,
    correctionIds: pickResult.correctionIds || [],
    sourceConfidence: pickResult.sourceConfidence != null ? pickResult.sourceConfidence : null,
  };
}

/**
 * §33 既存 UI 互換マップ。31G はこの対応表に沿って接続する（geometry の出所だけ差し替え）。
 */
export const UI_COMPAT = Object.freeze({
  buildingPopup: {
    current: 'selectBuilding(e,h) → showPropertyCard(h.d) → updateLifeTab',
    canonical: 'pick → resolvePick → showPropertyCard(canonicalAttributes) → updateLifeTab（配線は不変。h.d の代わりに canonical 属性）',
  },
  wardSelection: {
    current: 'ward polygon で建物を bucket',
    canonical: 'derived building feature の attributes.wardId をそのまま使う（canonical build 時に確定済み）',
  },
  cityMode: {
    current: 'CityBuildingLOD / MajorBuildingLOD',
    canonical: 'derived far = MajorBuildingLOD 相当 / derived mid+near = CityBuildingLOD 相当。lodForDistance で band 切替',
  },
  lod: {
    current: 'Mission13/24/26 の FAR/MID/NEAR band',
    canonical: 'derived の far/mid/near/ultra-near。band 境界（9000/3500/1200m）は既存に合わせた',
  },
  camera: { current: '独自 OrbitControls 相当', canonical: '不変（geometry の座標系 znorth-neg-v1 は同一）' },
  labels: {
    current: 'LabelLayer / station label',
    canonical: 'rail stations.json を station label の別 payload として使う（§17）。他ラベルは不変',
  },
});
