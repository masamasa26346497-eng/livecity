#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/fetch-schools.js
// ══════════════════════════════════════════════════════════════
// OSMから学校敷地ポリゴン（小学校・中学校・高校）を自動取得し、
// 共通座標系のローカルXZへ変換して HTML の OSM_SCHOOLS 定数へ埋め込む。
// 手入力は不要。取得できない要素を推測で補完することはしない。
//
// 前提: data/buildings/coordinate-config.json（tools/setup-area.js または
//       estimate-origin.js --emit-config が自動生成）。未確定なら明確に停止する。
//
// 使い方:
//   node tools/fetch-schools.js --bbox <south,west,north,east> \
//     --coordinate-config data/buildings/coordinate-config.json \
//     --html public/osaka_3d_buildings.html [--dry-run]
//   ※ --bbox 省略時は coordinate-config の原点から住吉区相当の範囲を自動算出する。
//
// 取得対象: amenity=school（日本のOSMでは小中高がこのタグ）と landuse=education のway/relation外周。
//   大学(amenity=university/college)は今回の対象外として除外する。
// 分類(kind): 名称に「小学校」→primary /「中学校」→junior_high /「高等学校|高校」→high /
//   それ以外の amenity=school は school（汎用）。名称からの推測はこの範囲に限定し、
//   学校種別が判定できないものを勝手に決めつけない。

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const RETRY = 3, RETRY_WAIT_MS = 3000;

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

function classify(tags) {
  const name = (tags && (tags.name || tags['name:ja'])) || '';
  if (/小学校/.test(name)) return 'primary';
  if (/中学校/.test(name)) return 'junior_high';
  if (/高等学校|高校/.test(name)) return 'high';
  if (tags && tags['school:type']) return String(tags['school:type']);
  return 'school'; // 種別不明。推測で決めつけない
}

async function overpass(query) {
  let lastErr = null;
  for (const endpoint of ENDPOINTS) {
    for (let i = 1; i <= RETRY; i++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LiveCity/1.0 (school-layer)' },
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfgPath = args['coordinate-config'] || 'data/buildings/coordinate-config.json';
  const htmlPath = args.html || 'public/osaka_3d_buildings.html';

  if (!fs.existsSync(cfgPath)) {
    console.error('══ 座標設定が未確定のため学校敷地の変換ができません ══');
    console.error(cfgPath + ' がありません。先に原点較正を実行してください:');
    console.error('  node tools/fetch-osm-references.js --landuse data/landuse.json --out data/buildings/references.auto.json');
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

  // bbox: 未指定なら原点周辺（住吉区の建物範囲に余裕を持たせた矩形）を逆算
  let bbox = args.bbox;
  if (!bbox) {
    const span = parseFloat(args.span || '3500'); // ローカル座標の半径(m)
    const toLatLon = (lx, lz) => {
      const E = oE + lx / sx, N = oN + lz / sz;
      let lat = 34.6, lon = 135.5;
      for (let i = 0; i < 40; i++) {
        const p = latLonToJPRect(lat, lon, zone);
        const dE = E - p.E, dN = N - p.N;
        lat += dN / 111000; lon += dE / (111000 * Math.cos(lat * Math.PI / 180));
        if (Math.abs(dE) < 1e-6 && Math.abs(dN) < 1e-6) break;
      }
      return [lat, lon];
    };
    const a = toLatLon(-span, -span), b = toLatLon(span, span);
    bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
      .map(v => v.toFixed(6)).join(',');
    console.log('bbox自動算出:', bbox);
  }

  const q = `[out:json][timeout:90];(
    way["amenity"="school"](${bbox});
    way["landuse"="education"](${bbox});
    relation["amenity"="school"](${bbox});
  );out geom;`;
  console.log('学校敷地をOverpassから取得中…');
  const data = await overpass(q);

  const toLocal = (lat, lon) => {
    const p = latLonToJPRect(lat, lon, zone);
    return [Math.round(sx * (p.E - oE) * 100) / 100, Math.round(sz * (p.N - oN) * 100) / 100];
  };
  const areaOf = pts => { let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q2 = pts[(i + 1) % pts.length]; a += p[0] * q2[1] - q2[0] * p[1]; }
    return Math.abs(a) / 2; };

  const out = [];
  const stats = { elements: (data.elements || []).length, ways: 0, relations: 0,
    skippedNoGeom: 0, skippedSmall: 0, skippedUniversity: 0, byKind: {} };
  const MIN_AREA = 300; // m²未満は学校敷地として不自然なため除外

  for (const el of (data.elements || [])) {
    const tags = el.tags || {};
    if (tags.amenity === 'university' || tags.amenity === 'college') { stats.skippedUniversity++; continue; }
    let rings = [];
    if (el.type === 'way' && Array.isArray(el.geometry)) { rings = [el.geometry]; stats.ways++; }
    else if (el.type === 'relation' && Array.isArray(el.members)) {
      rings = el.members.filter(m => m.role === 'outer' && Array.isArray(m.geometry)).map(m => m.geometry);
      stats.relations++;
    }
    if (!rings.length) { stats.skippedNoGeom++; continue; }
    for (const g of rings) {
      let pts = g.map(p => toLocal(p.lat, p.lon));
      if (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
      if (pts.length < 3) { stats.skippedNoGeom++; continue; }
      if (areaOf(pts) < MIN_AREA) { stats.skippedSmall++; continue; }
      const kind = classify(tags);
      out.push({ id: el.type + '/' + el.id, name: tags.name || '', kind, p: pts });
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    }
  }

  console.log('取得要素:', stats.elements, '(way', stats.ways, '/ relation', stats.relations, ')');
  console.log('採用:', out.length, '件 / 種別内訳:', JSON.stringify(stats.byKind));
  console.log('除外: 大学', stats.skippedUniversity, '/ ジオメトリなし', stats.skippedNoGeom, '/ 面積過小', stats.skippedSmall);
  console.log('総敷地面積:', Math.round(out.reduce((s, o) => s + areaOf(o.p), 0)), 'm²');

  if (!out.length) { console.error('学校敷地が0件でした。bbox範囲を確認してください。'); process.exit(1); }
  if (args['dry-run']) { console.log('--dry-run のためHTMLは更新していません。'); return; }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const line = 'const OSM_SCHOOLS = ' + JSON.stringify(out) + ';';
  if (/^const OSM_SCHOOLS = .*$/m.test(html)) {
    fs.writeFileSync(htmlPath, html.replace(/^const OSM_SCHOOLS = .*$/m, line));
  } else {
    // OSM_PARKS の直後へ新規挿入（データ定数の並びを既存構造に合わせる）
    const anchor = html.match(/^const OSM_PARKS = .*$/m);
    if (!anchor) { console.error('挿入位置(OSM_PARKS)が見つかりません'); process.exit(1); }
    fs.writeFileSync(htmlPath, html.replace(anchor[0], anchor[0] + '\n' + line));
  }
  console.log('HTMLへOSM_SCHOOLSを書き込みました:', htmlPath);
}

main().catch(e => { console.error('[fetch-schools] 失敗:', e.message); process.exit(1); });
