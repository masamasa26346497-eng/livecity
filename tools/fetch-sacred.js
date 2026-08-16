#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/fetch-sacred.js
// ══════════════════════════════════════════════════════════════
// 墓地・神社・寺院データを OSM_CEMETERY / OSM_TEMPLES 定数へ埋め込む。
//
//  A) ローカル取込（ネットワーク不要）
//     --landuse data/landuse.json  … 取得済みの墓地面（landuse=cemetery）を取り込む
//  B) Overpass取得（ネットワーク必要 + coordinate-config.json 必須）
//     対象: landuse=cemetery, amenity=grave_yard（墓地）
//           amenity=place_of_worship, building=church/temple/shrine（神社・寺院）
//
// 敷地/建物の選択規則（指示に準拠）:
//   place_of_worship の敷地ポリゴン（way/relationの外周）があれば敷地を採用（src='site'）。
//   敷地が取得できない場合のみ building=church/temple/shrine の建物ポリゴンを採用（src='building'）。
//   同一施設で敷地と建物が両方取れた場合は敷地を優先し、建物側は重複として除外する。
//
// 種別(kind)の判定:
//   religion=shinto → 'shinto' / religion=buddhist → 'buddhist'
//   religion不明の place_of_worship → 'worship'（推測で神社/寺院に振り分けない）
//
// 使い方:
//   node tools/fetch-sacred.js --landuse data/landuse.json --html public/osaka_3d_buildings.html
//   node tools/fetch-sacred.js --landuse data/landuse.json --overpass \
//     --coordinate-config data/buildings/coordinate-config.json --html public/osaka_3d_buildings.html

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RETRY = 3, RETRY_WAIT_MS = 3000;
const MIN_AREA = 50;         // m²未満は視認できずノイズになるため除外
const SITE_DEDUP_DIST = 60;  // 敷地内に建物がある場合の重複判定距離(m)

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
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LiveCity/1.0 (sacred-layer)' },
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

function kindOf(tags) {
  const r = (tags.religion || '').toLowerCase();
  if (r === 'shinto') return 'shinto';
  if (r === 'buddhist') return 'buddhist';
  if (tags.building === 'shrine') return 'shinto';
  if (tags.building === 'temple') return 'buddhist';
  return 'worship'; // 宗派不明。推測しない
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const htmlPath = args.html || 'public/osaka_3d_buildings.html';
  const cemeteries = [], temples = [];
  const stats = { cemeteryLocal: 0, cemeteryOverpass: 0, templeSite: 0, templeBuilding: 0,
    fromHtml: 0, skippedSmall: 0, skippedInvalid: 0, dedupBuilding: 0, byKind: {} };

  // ── 既存のHTML埋め込みデータを引き継ぐ（再実行しても既存分が消えない）──
  if (fs.existsSync(htmlPath) && !args['no-merge']) {
    const html0 = fs.readFileSync(htmlPath, 'utf8');
    const load = (name, target) => {
      const line = html0.split('\n').find(l => l.startsWith('const ' + name + ' = '));
      if (!line) return;
      try {
        const prev = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1));
        for (const x of (prev || [])) {
          if (!x || !x.id || !Array.isArray(x.p)) continue;
          target.push(x); stats.fromHtml++;
        }
      } catch (e) { /* 解析できない場合は引き継がない */ }
    };
    load('OSM_CEMETERY', cemeteries);
    load('OSM_TEMPLES', temples);
    if (stats.fromHtml) console.log('既存HTMLの墓地・神社寺院を引き継ぎ:', stats.fromHtml, '件');
  }

  // ── A) ローカル取込（landuse.json の墓地面）──
  if (args.landuse && fs.existsSync(args.landuse)) {
    const lu = JSON.parse(fs.readFileSync(args.landuse, 'utf8'));
    const cems = lu.filter(x => (x.category === 'cemetery' || /cemetery|grave/.test(x.subtype || '')) &&
      x.polygons && x.polygons[0] && Array.isArray(x.polygons[0].outer));
    for (const c of cems) {
      let p = c.polygons[0].outer.map(q => [Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100]);
      if (p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
      if (p.length < 3) { stats.skippedInvalid++; continue; }
      if (areaOf(p) < MIN_AREA) { stats.skippedSmall++; continue; }
      if (cemeteries.some(o => o.id === c.id)) continue; // 既存引き継ぎ分との重複を除外
      cemeteries.push({ id: c.id, name: (c.tags && c.tags.name) || '', kind: 'cemetery', src: 'site', p });
      stats.cemeteryLocal++;
    }
    console.log('landuse.jsonから墓地:', stats.cemeteryLocal, '件');
  }

  // ── B) Overpass取得 ──
  if (args.overpass) {
    const cfgPath = args['coordinate-config'] || 'data/buildings/coordinate-config.json';
    if (!fs.existsSync(cfgPath)) {
      console.error('══ 座標設定が未確定のためOverpass取得分の変換ができません ══');
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
    const toLocal = (lat, lon) => {
      const p = latLonToJPRect(lat, lon, zone);
      return [Math.round(sx * (p.E - oE) * 100) / 100, Math.round(sz * (p.N - oN) * 100) / 100];
    };
    let bbox = args.bbox;
    if (!bbox) {
      const span = parseFloat(args.span || '3500');
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
      way["landuse"="cemetery"](${bbox});
      way["amenity"="grave_yard"](${bbox});
      way["amenity"="place_of_worship"](${bbox});
      way["building"~"^(church|temple|shrine|cathedral|chapel|mosque)$"](${bbox});
      relation["amenity"="place_of_worship"](${bbox});
      relation["landuse"="cemetery"](${bbox});
    );out geom;`;
    console.log('墓地・神社・寺院をOverpassから取得中…');
    const data = await overpass(q);

    const seenCem = new Set(cemeteries.map(c => c.id));
    const sites = [], buildings = [];
    for (const el of (data.elements || [])) {
      const tags = el.tags || {};
      const id = el.type + '/' + el.id;
      let rings = [];
      if (el.type === 'way' && Array.isArray(el.geometry)) rings = [el.geometry];
      else if (el.type === 'relation' && Array.isArray(el.members)) {
        rings = el.members.filter(m => m.role === 'outer' && Array.isArray(m.geometry)).map(m => m.geometry);
      }
      if (!rings.length) { stats.skippedInvalid++; continue; }
      for (const g of rings) {
        let pts = g.map(p => toLocal(p.lat, p.lon));
        if (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
        if (pts.length < 3) { stats.skippedInvalid++; continue; }
        if (areaOf(pts) < MIN_AREA) { stats.skippedSmall++; continue; }
        const isCem = tags.landuse === 'cemetery' || tags.amenity === 'grave_yard';
        if (isCem) {
          if (seenCem.has(id)) continue;
          seenCem.add(id);
          cemeteries.push({ id, name: tags.name || '', kind: 'cemetery', src: 'site', p: pts });
          stats.cemeteryOverpass++;
        } else if (tags.amenity === 'place_of_worship') {
          sites.push({ id, name: tags.name || '', kind: kindOf(tags), src: 'site', p: pts });
        } else {
          buildings.push({ id, name: tags.name || '', kind: kindOf(tags), src: 'building', p: pts });
        }
      }
    }
    // 敷地優先: 敷地ポリゴン内(または近傍)の建物は重複として除外
    for (const s of sites) { temples.push(s); stats.templeSite++; }
    for (const b of buildings) {
      const bc = centroidOf(b.p);
      const covered = sites.some(s => {
        const sc = centroidOf(s.p);
        return Math.hypot(sc[0] - bc[0], sc[1] - bc[1]) < SITE_DEDUP_DIST;
      });
      if (covered) { stats.dedupBuilding++; continue; }
      temples.push(b); stats.templeBuilding++;
    }
    for (const t of temples) stats.byKind[t.kind] = (stats.byKind[t.kind] || 0) + 1;
    console.log('Overpassから: 墓地', stats.cemeteryOverpass, '件 / 神社・寺院 敷地', stats.templeSite,
      '件 + 建物のみ', stats.templeBuilding, '件（敷地優先で建物', stats.dedupBuilding, '件を除外）');
  }

  console.log('合計: 墓地', cemeteries.length, '件 / 神社・寺院', temples.length, '件',
    Object.keys(stats.byKind).length ? '/ 種別 ' + JSON.stringify(stats.byKind) : '');
  console.log('墓地の総面積:', Math.round(cemeteries.reduce((s, c) => s + areaOf(c.p), 0)), 'm²');
  if (temples.length) console.log('神社・寺院の総面積:', Math.round(temples.reduce((s, t) => s + areaOf(t.p), 0)), 'm²');
  console.log('除外: 面積過小', stats.skippedSmall, '/ 無効', stats.skippedInvalid);

  if (!cemeteries.length && !temples.length) {
    console.error('対象が0件でした。--landuse か --overpass を指定してください。');
    process.exit(1);
  }
  if (args['dry-run']) { console.log('--dry-run のためHTMLは更新していません。'); return; }

  let html = fs.readFileSync(htmlPath, 'utf8');
  const write = (name, arr) => {
    if (!arr.length) return;
    const line = 'const ' + name + ' = ' + JSON.stringify(arr) + ';';
    const re = new RegExp('^const ' + name + ' = .*$', 'm');
    if (re.test(html)) html = html.replace(re, line);
    else {
      const anchor = html.match(/^const OSM_PARKS = .*$/m);
      if (!anchor) { console.error('挿入位置(OSM_PARKS)が見つかりません'); process.exit(1); }
      html = html.replace(anchor[0], anchor[0] + '\n' + line);
    }
  };
  write('OSM_CEMETERY', cemeteries);
  write('OSM_TEMPLES', temples);
  fs.writeFileSync(htmlPath, html);
  console.log('HTMLへ書き込みました:', htmlPath);
}

main().catch(e => { console.error('[fetch-sacred] 失敗:', e.message); process.exit(1); });
