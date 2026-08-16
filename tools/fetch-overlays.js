#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/fetch-overlays.js
// ══════════════════════════════════════════════════════════════
// ── ES Module形式（package.jsonの "type": "module" に対応）──
//
// 1回の実行で、指定データセット(区)の
//   道路 / 公園 / 学校 / 駐車場 / 河川・水域 / 墓地 / 神社 / 寺院
// をOSMから取得し、data/overlays/{datasetId}.json を生成する。
// 実行時は OverlayDataLoader がこのファイルを自動で読み込み、各レイヤーへ反映する。
//
// 設計原則:
// - 区ごとの特別処理を持たない。datasetId と coordinate-config.json だけで全国どこでも動作する。
// - 取得範囲(bbox)は「その区の建物manifestのbounds」から自動算出する
//   （data/buildings/{datasetId}/manifest.json の bounds。区の実データが範囲を決めるため
//     区名のハードコードや手動bbox指定が不要）。manifestが無い場合のみ --bbox / --span を使う。
// - OSMの実データのみを出力する。存在しない地物の生成・推測は行わない。
// - 既存ファイルがあればマージする（同一IDは上書きせず1件に保つ）。--no-merge で無効化。
//
// 使い方:
//   node tools/fetch-overlays.js --dataset osaka-higashisumiyoshi \
//     --coordinate-config data/buildings/coordinate-config.json
//   （範囲を明示する場合）--bbox <south,west,north,east> または --span <メートル>
//   （確認のみ）--dry-run
//
// setup-area.js から STEP6 として自動実行される。

import fs from 'node:fs';
import path from 'node:path';

// Overpassエンドポイント。--endpoint または環境変数 OVERPASS_ENDPOINT で差し替え可能
// （公式APIのレート制限回避、社内ミラー、自前Overpassインスタンスの利用を想定）
const DEFAULT_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let ENDPOINTS = DEFAULT_ENDPOINTS;
const RETRY = 3, RETRY_WAIT_MS = 3000;
const MIN_AREA = 50;          // m²未満の面は視認できずノイズになるため除外
const SITE_DEDUP_DIST = 60;   // 神社仏閣: 敷地と建物の重複判定距離(m)
const DEFAULT_MARGIN = 200;   // bboxに付ける余白(m)。区境の道路が途切れないようにする

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const areaOf = pts => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
};
const centroidOf = pts => {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
};

// 平面直角座標（JGD2011・国土地理院公式級数式。他ツールと同一実装）
const JPRECT_ORIGINS = { 1:[33,129.5],2:[33,131],3:[36,132.1666666667],4:[33,133.5],5:[36,134.3333333333],
  6:[36,136],7:[36,137.1666666667],8:[36,138.5],9:[36,139.8333333333],10:[40,140.8333333333],
  11:[44,140.25],12:[44,142.25],13:[44,144.25],14:[26,142],15:[26,127.5],16:[26,124],17:[26,131],18:[20,136],19:[26,154] };
function latLonToJPRect(latDeg, lonDeg, zone) {
  const [lat0Deg, lon0Deg] = JPRECT_ORIGINS[zone];
  const a = 6378137, F = 298.257222101, m0 = 0.9999;
  const n = 1 / (2 * F - 1), rad = Math.PI / 180;
  const phi = latDeg * rad, lam = lonDeg * rad, phi0 = lat0Deg * rad, lam0 = lon0Deg * rad;
  const A = [1 + n*n/4 + n*n*n*n/64, -1.5*(n - n*n*n/8 - n*n*n*n*n/64), 15/16*(n*n - n*n*n*n/4),
             -35/48*(n*n*n - 5/16*n*n*n*n*n), 315/512*n*n*n*n, -693/1280*n*n*n*n*n];
  const alpha = [null, 0.5*n - 2/3*n*n + 5/16*n*n*n + 41/180*n*n*n*n - 127/288*n*n*n*n*n,
    13/48*n*n - 3/5*n*n*n + 557/1440*n*n*n*n + 281/630*n*n*n*n*n,
    61/240*n*n*n - 103/140*n*n*n*n + 15061/26880*n*n*n*n*n,
    49561/161280*n*n*n*n - 179/168*n*n*n*n*n, 34729/80640*n*n*n*n*n];
  const Abar = m0 * a / (1 + n) * A[0];
  const Sphi = p => { let s = A[0] * p; for (let j = 1; j <= 5; j++) s += A[j] * Math.sin(2 * j * p);
    return m0 * a / (1 + n) * s; };
  const S0 = Sphi(phi0);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - (2 * Math.sqrt(n) / (1 + n)) * Math.atanh(2 * Math.sqrt(n) / (1 + n) * Math.sin(phi)));
  const tb = Math.sqrt(1 + t * t);
  const lc = Math.cos(lam - lam0), ls = Math.sin(lam - lam0);
  const xi = Math.atan(t / lc), eta = Math.atanh(ls / tb);
  let X = xi, Y = eta;
  for (let j = 1; j <= 5; j++) {
    X += alpha[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    Y += alpha[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { N: Abar * X - S0, E: Abar * Y };
}

async function overpass(query) {
  let lastErr = null;
  for (const endpoint of ENDPOINTS) {
    for (let i = 1; i <= RETRY; i++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LiveCity/1.0 (overlays)' },
          body: 'data=' + encodeURIComponent(query)
        });
        if (res.status === 429 || res.status === 504) { await sleep(RETRY_WAIT_MS * i); continue; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; await sleep(RETRY_WAIT_MS); }
    }
  }
  throw new Error('Overpass取得に失敗しました（ネットワーク不通の可能性）: ' + (lastErr && lastErr.message));
}

// 学校種別: 名称から判定できるものだけ。判定不能は 'school' のまま（推測しない）
function schoolKind(tags) {
  const name = (tags.name || tags['name:ja'] || '');
  if (/小学校/.test(name)) return 'primary';
  if (/中学校/.test(name)) return 'junior_high';
  if (/高等学校|高校/.test(name)) return 'high';
  if (tags['school:type']) return String(tags['school:type']);
  return 'school';
}
// 宗派: religionタグ優先。不明は 'worship'（神社/寺院に推測で振り分けない）
function worshipKind(tags) {
  const r = (tags.religion || '').toLowerCase();
  if (r === 'shinto') return 'shinto';
  if (r === 'buddhist') return 'buddhist';
  if (tags.building === 'shrine') return 'shinto';
  if (tags.building === 'temple') return 'buddhist';
  return 'worship';
}
// 施設ラベルのカテゴリ（既存OSM_LABELSと同じ語彙のみ採用）
function labelCategory(tags) {
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'library') return 'library';
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') return 'hospital';
  if (tags.amenity === 'townhall' || tags.office === 'government') return 'government';
  if (tags.railway === 'station' || tags.public_transport === 'station') return 'station';
  if (tags.leisure === 'park') return 'park';
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetId = args.dataset;
  const ep = args.endpoint || process.env.OVERPASS_ENDPOINT;
  if (ep) { ENDPOINTS = [ep]; console.log('Overpassエンドポイント:', ep); }
  if (!datasetId) {
    console.error('usage: node tools/fetch-overlays.js --dataset <id> [--coordinate-config <json>] [--bbox s,w,n,e | --span <m>] [--margin 200] [--endpoint <url>] [--dry-run] [--no-merge]');
    process.exit(1);
  }
  const cfgPath = args['coordinate-config'] || 'data/buildings/coordinate-config.json';
  const buildingsRoot = args['buildings-root'] || 'public/data/buildings';
  const outPath = args.out || path.join(args['overlays-root'] || 'public/data/overlays', datasetId + '.json');

  if (!fs.existsSync(cfgPath)) {
    console.error('══ 座標設定が未確定のため取得できません ══');
    console.error(cfgPath + ' がありません。先に原点較正を実行してください:');
    console.error('  node tools/fetch-osm-references.js --html public/osaka_3d_buildings.html --out data/buildings/references.auto.json');
    console.error('  node tools/estimate-origin.js --refs data/buildings/references.auto.json --emit-config ' + cfgPath);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const zone = cfg.jprectZone, oE = cfg.localOrigin.projectedE, oN = cfg.localOrigin.projectedN;
  const sx = cfg.axisMapping.sceneXSign, sz = cfg.axisMapping.sceneZSign;
  if (!Number.isInteger(zone) || !Number.isFinite(oE) || !Number.isFinite(oN)) {
    console.error('coordinate-config.json の値が未確定です（null）。原点較正をやり直してください。');
    process.exit(2);
  }
  const toLocal = (lat, lon) => {
    const p = latLonToJPRect(lat, lon, zone);
    return [Math.round(sx * (p.E - oE) * 100) / 100, Math.round(sz * (p.N - oN) * 100) / 100];
  };
  const toLatLon = (lx, lz) => {
    const E = oE + lx / sx, N = oN + lz / sz;
    let lat = JPRECT_ORIGINS[zone][0] - 1.5, lon = JPRECT_ORIGINS[zone][1];
    for (let i = 0; i < 60; i++) {
      const p = latLonToJPRect(lat, lon, zone);
      const dE = E - p.E, dN = N - p.N;
      lat += dN / 111000; lon += dE / (111000 * Math.cos(lat * Math.PI / 180));
      if (Math.abs(dE) < 1e-6 && Math.abs(dN) < 1e-6) break;
    }
    return [lat, lon];
  };

  // ── bbox決定: ①--bbox ②その区の建物manifestのbounds ③--span（原点中心）──
  const margin = parseFloat(args.margin || DEFAULT_MARGIN);
  let bbox = args.bbox, bboxSource = '--bbox 指定';
  if (!bbox) {
    const mPath = path.join(buildingsRoot, datasetId, 'manifest.json');
    if (fs.existsSync(mPath)) {
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const b = m.bounds;
      if (b && Number.isFinite(b.minX)) {
        const c1 = toLatLon(b.minX - margin, b.minZ - margin);
        const c2 = toLatLon(b.maxX + margin, b.maxZ + margin);
        bbox = [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])]
          .map(v => v.toFixed(6)).join(',');
        bboxSource = `建物manifestのbounds + 余白${margin}m (${mPath})`;
      }
    }
  }
  if (!bbox) {
    const span = parseFloat(args.span || '3000');
    const c1 = toLatLon(-span, -span), c2 = toLatLon(span, span);
    bbox = [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])]
      .map(v => v.toFixed(6)).join(',');
    bboxSource = `--span ${span}m（原点中心。建物manifest未生成のため）`;
  }
  console.log('dataset:', datasetId);
  console.log('bbox:', bbox, '←', bboxSource);

  // ── 1回のクエリで全カテゴリを取得 ──
  const query = `[out:json][timeout:180];(
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$"](${bbox});
    way["leisure"="park"](${bbox});
    way["landuse"="recreation_ground"](${bbox});
    way["amenity"="parking"](${bbox});
    way["amenity"="school"](${bbox});
    way["landuse"="education"](${bbox});
    way["waterway"~"^(river|canal|stream|riverbank)$"](${bbox});
    way["natural"="water"](${bbox});
    way["landuse"~"^(reservoir|basin)$"](${bbox});
    way["water"](${bbox});
    way["landuse"="cemetery"](${bbox});
    way["amenity"="grave_yard"](${bbox});
    way["amenity"="place_of_worship"](${bbox});
    way["building"~"^(church|temple|shrine|cathedral|chapel|mosque)$"](${bbox});
    relation["leisure"="park"](${bbox});
    relation["natural"="water"](${bbox});
    relation["amenity"="place_of_worship"](${bbox});
    relation["landuse"="cemetery"](${bbox});
    node["amenity"~"^(school|library|hospital|clinic|townhall)$"](${bbox});
    node["railway"="station"](${bbox});
  );out geom;`;
  console.log('Overpassから一括取得中…（道路・公園・学校・駐車場・河川・墓地・神社・寺院）');
  const data = await overpass(query);
  console.log('取得要素:', (data.elements || []).length);

  const out = { datasetId, generatedAt: new Date().toISOString(), bbox,
    source: 'OpenStreetMap via Overpass API', coordinateConfig: cfgPath,
    roads: [], parks: [], parking: [], schools: [], water: [], cemetery: [], temples: [], labels: [] };
  const stats = { skippedSmall: 0, skippedInvalid: 0, dedupBuilding: 0, byKind: {} };
  const worshipSites = [], worshipBuildings = [];

  const ringsOf = el => {
    if (el.type === 'way' && Array.isArray(el.geometry)) return [el.geometry];
    if (el.type === 'relation' && Array.isArray(el.members)) {
      return el.members.filter(m => m.role === 'outer' && Array.isArray(m.geometry)).map(m => m.geometry);
    }
    return [];
  };
  const closeRing = pts => {
    if (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) return pts.slice(0, -1);
    return pts;
  };

  for (const el of (data.elements || [])) {
    const tags = el.tags || {};
    const id = el.type + '/' + el.id;

    // ── 施設ラベル（node）──
    if (el.type === 'node') {
      const cat = labelCategory(tags);
      if (!cat || !tags.name) continue; // 名称なしはラベルにならない
      const p = toLocal(el.lat, el.lon);
      const priority = cat === 'station' ? 9 : cat === 'hospital' ? 6 : cat === 'government' ? 7 : 5;
      out.labels.push({ name: tags.name, category: cat, priority, p });
      continue;
    }

    // ── 道路（線）──
    if (tags.highway) {
      if (!Array.isArray(el.geometry) || el.geometry.length < 2) { stats.skippedInvalid++; continue; }
      const p = el.geometry.map(g => toLocal(g.lat, g.lon));
      const rec = { highway: tags.highway, p };
      if (tags.name) rec.name = tags.name;
      rec.id = id; // 区境の重複除外に使う（既存埋め込み分はid無しだが形状キーで判定される）
      out.roads.push(rec);
      continue;
    }

    for (const g of ringsOf(el)) {
      let pts = closeRing(g.map(q => toLocal(q.lat, q.lon)));
      const isLineWater = /^(river|canal|stream)$/.test(tags.waterway || '');
      if (isLineWater) {
        if (pts.length < 2) { stats.skippedInvalid++; continue; }
        const rec = { id, name: tags.name || '', kind: 'line', subtype: tags.waterway, p: pts };
        const w = parseFloat(tags.width);
        if (Number.isFinite(w) && w > 0) rec.w = w; // widthタグがある場合のみ実値
        out.water.push(rec);
        continue;
      }
      if (pts.length < 3) { stats.skippedInvalid++; continue; }
      const area = areaOf(pts);
      if (area < MIN_AREA) { stats.skippedSmall++; continue; }

      if (tags.leisure === 'park' || tags.landuse === 'recreation_ground') {
        out.parks.push({ tag: tags.leisure === 'park' ? 'leisure_park' : 'landuse_recreation_ground',
          name: tags.name || '', id, p: pts });
      } else if (tags.amenity === 'parking') {
        const st = tags.parking === 'surface' ? 'parking_surface'
          : tags.parking === 'multi-storey' ? 'parking_multi_storey'
          : tags.parking === 'underground' ? 'parking_underground' : 'parking_unspecified';
        if (st === 'parking_multi_storey' || st === 'parking_underground') continue; // 地表面でないものは除外
        out.parking.push({ id, subtype: st, fee: tags.fee || '', polygons: [{ outer: pts, holes: [] }] });
      } else if (tags.amenity === 'school' || tags.landuse === 'education') {
        if (tags.amenity === 'university' || tags.amenity === 'college') continue; // 大学は対象外
        out.schools.push({ id, name: tags.name || '', kind: schoolKind(tags), p: pts });
      } else if (tags.landuse === 'cemetery' || tags.amenity === 'grave_yard') {
        out.cemetery.push({ id, name: tags.name || '', kind: 'cemetery', src: 'site', p: pts });
      } else if (tags.amenity === 'place_of_worship') {
        worshipSites.push({ id, name: tags.name || '', kind: worshipKind(tags), src: 'site', p: pts });
      } else if (/^(church|temple|shrine|cathedral|chapel|mosque)$/.test(tags.building || '')) {
        worshipBuildings.push({ id, name: tags.name || '', kind: worshipKind(tags), src: 'building', p: pts });
      } else if (tags.waterway === 'riverbank' || tags.natural === 'water' || tags.water ||
                 tags.landuse === 'reservoir' || tags.landuse === 'basin') {
        const sub = tags.waterway === 'riverbank' ? 'riverbank'
          : (tags.water || tags.landuse || tags.natural || 'water');
        out.water.push({ id, name: tags.name || '', kind: 'area', subtype: sub, p: pts });
      }
    }
  }

  // 神社仏閣: 敷地優先。敷地近傍の建物は重複として除外（敷地が無いものだけ建物を採用）
  for (const s of worshipSites) out.temples.push(s);
  for (const b of worshipBuildings) {
    const bc = centroidOf(b.p);
    const covered = worshipSites.some(s => {
      const sc = centroidOf(s.p);
      return Math.hypot(sc[0] - bc[0], sc[1] - bc[1]) < SITE_DEDUP_DIST;
    });
    if (covered) { stats.dedupBuilding++; continue; }
    out.temples.push(b);
  }
  for (const t of out.temples) stats.byKind[t.kind] = (stats.byKind[t.kind] || 0) + 1;

  // ── 既存ファイルとのマージ（同一IDは1件に保つ）──
  if (!args['no-merge'] && fs.existsSync(outPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      // 重複判定キー: IDがあればID、無ければ形状/座標から生成（ラベル等のID無しデータ対策）
      const keyOf = it => {
        if (!it) return null;
        if (it.id) return 'id:' + it.id;
        const p0 = it.p || (it.polygons && it.polygons[0] && it.polygons[0].outer);
        if (Array.isArray(p0) && p0.length) {
          const f = Array.isArray(p0[0]) ? p0[0] : p0;
          return 'geom:' + (it.name || '') + ':' + f[0] + ',' + f[1] + ',' + p0.length;
        }
        return null;
      };
      let merged = 0;
      for (const key of ['roads', 'parks', 'parking', 'schools', 'water', 'cemetery', 'temples', 'labels']) {
        if (!Array.isArray(prev[key])) continue;
        const seen = new Set(out[key].map(keyOf).filter(Boolean));
        for (const it of prev[key]) {
          const k = keyOf(it);
          if (k && seen.has(k)) continue;
          if (k) seen.add(k);
          out[key].push(it); merged++;
        }
      }
      if (merged) console.log('既存ファイルから引き継ぎ:', merged, '件');
    } catch (e) { /* 壊れていれば無視して新規生成 */ }
  }

  const counts = Object.fromEntries(['roads','parks','parking','schools','water','cemetery','temples','labels']
    .map(k => [k, out[k].length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log('件数:', JSON.stringify(counts));
  console.log('合計:', total, '件 / 神社仏閣の種別:', JSON.stringify(stats.byKind));
  console.log('除外: 面積過小', stats.skippedSmall, '/ 無効', stats.skippedInvalid,
    '/ 敷地優先で建物除外', stats.dedupBuilding);
  if (!total) { console.error('取得0件でした。bbox範囲を確認してください。'); process.exit(1); }
  if (args['dry-run']) { console.log('--dry-run のためファイルは書き出していません。'); return; }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log('出力:', outPath, '(' + kb + 'KB)');
  console.log('※ ブラウザをリロードすると OverlayDataLoader が自動で読み込みます（HTML変更不要）');
}

main().catch(e => { console.error('[fetch-overlays] 失敗:', e.message); process.exit(1); });
