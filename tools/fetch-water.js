#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/fetch-water.js
// ══════════════════════════════════════════════════════════════
// 河川・水域データを OSM_WATER 定数へ埋め込む。2つの入力モードを併用できる。
//
//  A) ローカル取込（ネットワーク不要）
//     --landuse data/landuse.json  … 既に取得済みの水域面（natural=water 等）を取り込む
//  B) Overpass取得（ネットワーク必要 + coordinate-config.json 必須）
//     --bbox <south,west,north,east> または省略で原点から自動算出
//     対象: waterway=river/canal/stream/riverbank, natural=water,
//           landuse=reservoir/basin, water=pond/reservoir/lake
//
// 使い方:
//   node tools/fetch-water.js --landuse data/landuse.json --html public/osaka_3d_buildings.html
//   node tools/fetch-water.js --landuse data/landuse.json --overpass \
//     --coordinate-config data/buildings/coordinate-config.json --html public/osaka_3d_buildings.html
//
// 出力形式（OSM_WATER の各要素）:
//   面: { id, name, kind:'area', subtype:'natural_water', p:[[x,z],...] }
//   線: { id, name, kind:'line', subtype:'river', w:<幅m>, p:[[x,z],...] }
//        w はOSMのwidthタグ由来。無い場合は WaterLayer 側の代表幅が使われる（実測川幅ではない）。

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RETRY = 3, RETRY_WAIT_MS = 3000;
const MIN_AREA = 30; // m²未満の水域は視認できずノイズになるため除外

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
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LiveCity/1.0 (water-layer)' },
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
  const htmlPath = args.html || 'public/osaka_3d_buildings.html';
  const out = [];
  const stats = { fromLanduse: 0, fromOverpass: 0, fromHtml: 0, areas: 0, lines: 0,
    skippedSmall: 0, skippedInvalid: 0, byKind: {} };

  // ── 既存のHTML埋め込みデータを引き継ぐ（再実行しても既存分が消えない）──
  if (fs.existsSync(htmlPath) && !args['no-merge']) {
    const line = fs.readFileSync(htmlPath, 'utf8').split('\n').find(l => l.startsWith('const OSM_WATER = '));
    if (line) {
      try {
        const prev = JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1));
        for (const w of (prev || [])) {
          if (!w || !w.id || !Array.isArray(w.p)) continue;
          out.push(w);
          stats.fromHtml++;
          if (w.kind === 'line') stats.lines++; else stats.areas++;
          const k = w.subtype || w.kind || 'water';
          stats.byKind[k] = (stats.byKind[k] || 0) + 1;
        }
        console.log('既存HTMLの水域を引き継ぎ:', stats.fromHtml, '件');
      } catch (e) { /* 解析できない場合は引き継がない */ }
    }
  }

  // ── A) ローカル取込（landuse.json の水域面）──
  if (args.landuse && fs.existsSync(args.landuse)) {
    const lu = JSON.parse(fs.readFileSync(args.landuse, 'utf8'));
    const waters = lu.filter(x => (x.category === 'water' || /water|reservoir|basin|pond/.test(x.subtype || '')) &&
      x.polygons && x.polygons[0] && Array.isArray(x.polygons[0].outer));
    for (const w of waters) {
      let p = w.polygons[0].outer.map(q => [Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100]);
      if (p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
      if (p.length < 3) { stats.skippedInvalid++; continue; }
      if (areaOf(p) < MIN_AREA) { stats.skippedSmall++; continue; }
      if (out.some(o => o.id === w.id)) continue; // 既存引き継ぎ分との重複を除外
      out.push({ id: w.id, name: (w.tags && w.tags.name) || '', kind: 'area', subtype: w.subtype || 'natural_water', p });
      stats.fromLanduse++; stats.areas++;
      stats.byKind[w.subtype || 'natural_water'] = (stats.byKind[w.subtype || 'natural_water'] || 0) + 1;
    }
    console.log('landuse.jsonから水域面:', stats.fromLanduse, '件');
  }

  // ── B) Overpass取得（河川線＋水域面）──
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
      way["waterway"~"^(river|canal|stream|riverbank)$"](${bbox});
      way["natural"="water"](${bbox});
      way["landuse"~"^(reservoir|basin)$"](${bbox});
      way["water"~"^(pond|reservoir|lake)$"](${bbox});
      relation["natural"="water"](${bbox});
    );out geom;`;
    console.log('河川・水域をOverpassから取得中…');
    const data = await overpass(q);
    const seen = new Set(out.map(o => o.id));
    for (const el of (data.elements || [])) {
      const tags = el.tags || {};
      const id = el.type + '/' + el.id;
      if (seen.has(id)) continue;
      const ww = tags.waterway;
      const isLine = ww === 'river' || ww === 'canal' || ww === 'stream';
      let rings = [];
      if (el.type === 'way' && Array.isArray(el.geometry)) rings = [el.geometry];
      else if (el.type === 'relation' && Array.isArray(el.members)) {
        rings = el.members.filter(m => m.role === 'outer' && Array.isArray(m.geometry)).map(m => m.geometry);
      }
      if (!rings.length) { stats.skippedInvalid++; continue; }
      for (const g of rings) {
        let pts = g.map(p => toLocal(p.lat, p.lon));
        if (isLine) {
          if (pts.length < 2) { stats.skippedInvalid++; continue; }
          const w = parseFloat(tags.width);
          const rec = { id, name: tags.name || '', kind: 'line', subtype: ww, p: pts };
          if (Number.isFinite(w) && w > 0) rec.w = w; // widthタグがある場合のみ実値を採用
          out.push(rec);
          stats.lines++; stats.fromOverpass++;
          stats.byKind[ww] = (stats.byKind[ww] || 0) + 1;
        } else {
          if (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
          if (pts.length < 3) { stats.skippedInvalid++; continue; }
          if (areaOf(pts) < MIN_AREA) { stats.skippedSmall++; continue; }
          const sub = ww === 'riverbank' ? 'riverbank' : (tags.water || tags.landuse || tags.natural || 'water');
          out.push({ id, name: tags.name || '', kind: 'area', subtype: sub, p: pts });
          stats.areas++; stats.fromOverpass++;
          stats.byKind[sub] = (stats.byKind[sub] || 0) + 1;
        }
      }
      seen.add(id);
    }
    console.log('Overpassから:', stats.fromOverpass, '件');
  }

  console.log('合計:', out.length, '件（面', stats.areas, '/ 線', stats.lines, '）',
    '/ 内訳:', JSON.stringify(stats.byKind));
  console.log('除外: 面積過小', stats.skippedSmall, '/ 無効', stats.skippedInvalid);
  const totalArea = Math.round(out.filter(o => o.kind === 'area').reduce((s, o) => s + areaOf(o.p), 0));
  console.log('水域面の総面積:', totalArea, 'm²');

  if (!out.length) { console.error('水域が0件でした。--landuse か --overpass を指定してください。'); process.exit(1); }
  if (args['dry-run']) { console.log('--dry-run のためHTMLは更新していません。'); return; }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const line = 'const OSM_WATER = ' + JSON.stringify(out) + ';';
  if (/^const OSM_WATER = .*$/m.test(html)) {
    fs.writeFileSync(htmlPath, html.replace(/^const OSM_WATER = .*$/m, line));
  } else {
    const anchor = html.match(/^const OSM_PARKS = .*$/m);
    if (!anchor) { console.error('挿入位置(OSM_PARKS)が見つかりません'); process.exit(1); }
    fs.writeFileSync(htmlPath, html.replace(anchor[0], anchor[0] + '\n' + line));
  }
  console.log('HTMLへOSM_WATERを書き込みました:', htmlPath);
}

main().catch(e => { console.error('[fetch-water] 失敗:', e.message); process.exit(1); });
