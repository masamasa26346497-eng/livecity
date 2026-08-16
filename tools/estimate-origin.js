#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/estimate-origin.js
// ══════════════════════════════════════════════════════════════
// 参照点（実在施設のローカルXZ確定値 ＋ 権威ソースから取得した実在緯度経度）から、
// 都市共通ローカル座標系の原点(投影座標E/N)と軸符号を逆推定し、整合性を検証する。
//
// 入力: 参照点JSON。本番運用では tools/fetch-osm-references.js が自動生成した
//   references.auto.json をそのまま使用する（手入力は不要）。
//   形式: { references:[{name, localX, localZ, lat, lon, source, osmId?}] } または配列そのもの。
//   references.template.json は開発者向けサンプルとして残置（本番では使用しない）。
//
// 【新規都市の場合】原点の「復元」は不要。任意の基準点を選んで定義すればよい:
//   node tools/estimate-origin.js --define-origin 35.6895,139.6917 --city-code 13100 \
//     --emit-config data/buildings/13100/coordinate-config.json
//   （既存データが無い都市では局所座標系を自由に決められるため、参照点取得を経由しない。
//     大阪だけは既存データの原点が未記録だったため、逆推定による復元が必要だった。）
//
// 実行: node tools/estimate-origin.js --refs <references.auto.json> [--zone 6]
//                                     [--out <report.json>] [--emit-config <coordinate-config.json>]
//   --zone 省略時は全19系を試行し、残差最小の系を採用。
//   --emit-config 指定時、合格判定の場合のみ coordinate-config.json を自動生成する。
//
// 外れ値除去: OSM編集でジオメトリが変化した参照点は残差が大きくなるため、
//   中央値ベースのロバスト推定 → 外れ値除去 → 再フィット を自動で行う（自動取得前提の必須機構）。
//
// 出力: 系番号・軸符号(sceneXSign/sceneZSign)・原点候補(E/N)・参照点ごとの残差・
//       ペア間距離によるスケール検証。全参照点の残差が閾値内なら coordinate-config.json へ
//       転記できる値をそのまま表示する（このツール自体はconfigを書き換えない）。

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';
import path from 'node:path';

const RESIDUAL_WARN = 20;  // 残差警告閾値(m): 施設代表点のずれとして許容し得る上限目安
const RESIDUAL_FAIL = 50;  // 残差失格閾値(m): これを超える組合せは不整合として不採用
const OUTLIER_M = 5;       // 外れ値除去閾値(m): 中央値原点からこれ以上ずれる参照点はOSM編集等として除外

// 緯度経度→平面直角座標（JGD2011, 国土地理院公式級数式。convert-plateau-buildings.jsと同一実装）
const JPRECT_ORIGINS = { 1:[33,129.5],2:[33,131],3:[36,132.1666666667],4:[33,133.5],5:[36,134.3333333333],
  6:[36,136],7:[36,137.1666666667],8:[36,138.5],9:[36,139.8333333333],10:[40,140.8333333333],
  11:[44,140.25],12:[44,142.25],13:[44,144.25],14:[26,142],15:[26,127.5],16:[26,124],17:[26,131],18:[20,136],19:[26,154] };
function latLonToJPRect(latDeg, lonDeg, zone) {
  const [lat0Deg, lon0Deg] = JPRECT_ORIGINS[zone];
  const a = 6378137, F = 298.257222101, m0 = 0.9999;
  const n = 1 / (2 * F - 1);
  const rad = Math.PI / 180;
  const phi = latDeg * rad, lam = lonDeg * rad, phi0 = lat0Deg * rad, lam0 = lon0Deg * rad;
  const A = [1 + n*n/4 + n*n*n*n/64, -1.5*(n - n*n*n/8 - n*n*n*n*n/64), 15/16*(n*n - n*n*n*n/4),
             -35/48*(n*n*n - 5/16*n*n*n*n*n), 315/512*n*n*n*n, -693/1280*n*n*n*n*n];
  const alpha = [null, 0.5*n - 2/3*n*n + 5/16*n*n*n + 41/180*n*n*n*n - 127/288*n*n*n*n*n,
    13/48*n*n - 3/5*n*n*n + 557/1440*n*n*n*n + 281/630*n*n*n*n*n,
    61/240*n*n*n - 103/140*n*n*n*n + 15061/26880*n*n*n*n*n,
    49561/161280*n*n*n*n - 179/168*n*n*n*n*n, 34729/80640*n*n*n*n*n];
  const Abar = m0 * a / (1 + n) * A[0];
  function Sphi(p) {
    let s = A[0] * p;
    for (let j = 1; j <= 5; j++) s += A[j] * Math.sin(2 * j * p);
    return m0 * a / (1 + n) * s;
  }
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

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  return a;
}

function evaluate(refs, zone) {
  // 各参照点を投影座標へ変換
  const proj = refs.map(r => ({ ...r, ...latLonToJPRect(r.lat, r.lon, zone) }));
  let best = null;
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    // localX = sx*(E - E0) → E0 = E - sx*localX（各点で算出し、ばらつき=残差を評価）
    const E0s = proj.map(p => p.E - sx * p.localX);
    const N0s = proj.map(p => p.N - sz * p.localZ);
    // ロバスト推定: 中央値で初期原点 → 外れ値(OSM編集された地物等)を除去 → 残りで平均再フィット
    const med = arr => { const a = [...arr].sort((x, y) => x - y); const m = a.length >> 1;
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    const E0m = med(E0s), N0m = med(N0s);
    const dev = proj.map((p, i) => Math.hypot(E0s[i] - E0m, N0s[i] - N0m));
    const inlierIdx = dev.map((d, i) => ({ d, i })).filter(x => x.d <= OUTLIER_M).map(x => x.i);
    const idx = inlierIdx.length >= 3 ? inlierIdx : proj.map((_, i) => i); // 全点外れなら除去せず報告
    const E0 = idx.reduce((s, i) => s + E0s[i], 0) / idx.length;
    const N0 = idx.reduce((s, i) => s + N0s[i], 0) / idx.length;
    const residuals = proj.map((p, i) => ({
      name: p.name,
      dE: +(E0s[i] - E0).toFixed(2),
      dN: +(N0s[i] - N0).toFixed(2),
      d: +Math.hypot(E0s[i] - E0, N0s[i] - N0).toFixed(2),
      inlier: idx.includes(i)
    }));
    const inlierResiduals = residuals.filter(r => r.inlier);
    const maxResidual = Math.max(...inlierResiduals.map(r => r.d));
    if (!best || maxResidual < best.maxResidual) {
      best = { zone, sceneXSign: sx, sceneZSign: sz,
        originE: +E0.toFixed(3), originN: +N0.toFixed(3), residuals, maxResidual,
        inlierCount: idx.length, outlierCount: proj.length - idx.length,
        outliers: residuals.filter(r => !r.inlier).map(r => ({ name: r.name, d: r.d })) };
    }
  }
  // スケール検証: ペア間距離（ローカル vs 投影）
  best.scaleChecks = [];
  for (let i = 0; i < proj.length; i++) for (let j = i + 1; j < proj.length; j++) {
    const dl = Math.hypot(refs[i].localX - refs[j].localX, refs[i].localZ - refs[j].localZ);
    const dp = Math.hypot(proj[i].E - proj[j].E, proj[i].N - proj[j].N);
    if (dl > 100) best.scaleChecks.push({
      pair: refs[i].name + '↔' + refs[j].name,
      localDist: +dl.toFixed(1), projDist: +dp.toFixed(1),
      ratio: +(dp / dl).toFixed(5)
    });
  }
  return best;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.refs && typeof args['define-origin'] !== 'string') {
    console.error('usage: node tools/estimate-origin.js --refs <references.auto.json> [--zone 6] [--out <report.json>] [--emit-config <path>]');
    console.error('   or: node tools/estimate-origin.js --define-origin <緯度,経度> --city-code <5桁> --emit-config <path>');
    process.exit(1);
  }
  // ── 新規都市: 原点を定義してconfigを生成（参照点の取得・推定を行わない）──
  if (typeof args['define-origin'] === 'string') {
    let originSpec = String(args['define-origin']);
    // --define-origin auto: 取得済みCityGMLの座標重心を原点にする（人手で基準点を選ぶ必要をなくす）
    if (originSpec === 'auto' || originSpec === 'true') {
      const dir = args['from-citygml'];
      if (!dir || !fs.existsSync(dir)) {
        console.error('--define-origin auto には --from-citygml <GMLディレクトリ> が必要です。');
        process.exit(2);
      }
      const files = (fs.statSync(dir).isDirectory()
        ? fs.readdirSync(dir).filter(f => /\.gml$/i.test(f)).map(f => path.join(dir, f))
        : [dir]).slice(0, 20); // 多数ある場合は先頭20ファイルで十分な精度
      let sLat = 0, sLon = 0, n = 0;
      for (const f of files) {
        const txt = fs.readFileSync(f, 'utf8');
        const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
        let mm, guard = 0;
        while ((mm = re.exec(txt)) && guard++ < 500) {
          const v = mm[1].trim().split(/\s+/).map(Number);
          for (let i = 0; i + 2 < v.length; i += 3) {
            const a = v[i], b = v[i + 1];
            if (a >= 20 && a <= 46 && b >= 122 && b <= 154) { sLat += a; sLon += b; n++; } // 日本国内の緯度経度
          }
        }
      }
      if (!n) {
        console.error('CityGMLから緯度経度を検出できませんでした（投影座標の可能性）。--define-origin <緯度,経度> で指定してください。');
        process.exit(2);
      }
      originSpec = (sLat / n).toFixed(6) + ',' + (sLon / n).toFixed(6);
      console.log('CityGML ' + files.length + 'ファイル / ' + n + '点の重心を原点に採用:', originSpec);
    }
    const m = originSpec.split(',').map(v => parseFloat(v.trim()));
    if (m.length !== 2 || !Number.isFinite(m[0]) || !Number.isFinite(m[1])) {
      console.error('--define-origin は "緯度,経度" の形式で指定してください（例 35.6895,139.6917）');
      process.exit(2);
    }
    const [lat, lon] = m;
    // 系番号: --zone 指定が無ければ緯度経度から最も近い系を自動選択
    let zone = args.zone ? parseInt(args.zone, 10) : null;
    if (!zone) {
      let best = null;
      for (const z of Object.keys(JPRECT_ORIGINS)) {
        const [la, lo] = JPRECT_ORIGINS[z];
        const d = Math.hypot(lat - la, (lon - lo) * Math.cos(lat * Math.PI / 180));
        if (!best || d < best.d) best = { z: parseInt(z, 10), d };
      }
      zone = best.z;
      console.log('系番号を自動選択:', zone, '（指定緯度経度に最も近い系）');
    }
    const p = latLonToJPRect(lat, lon, zone);
    const cfg = {
      _generated: 'tools/estimate-origin.js --define-origin による自動生成（新規都市の原点定義）',
      generatedAt: new Date().toISOString(),
      version: 1,
      city: args.city || null,
      cityCode: args['city-code'] ? String(args['city-code']) : null,
      sourceCRS: 'JGD2011 / 平面直角座標系 第' + zone + '系',
      coordinateMode: 'geographic-jprect',
      jprectZone: zone,
      axisOrder: 'lat lon',
      localOrigin: { projectedE: +p.E.toFixed(3), projectedN: +p.N.toFixed(3) },
      axisMapping: { sceneXSign: 1, sceneZSign: -1 },
      unit: 'meter', tileSize: 500,
      calibration: { method: args['from-citygml'] ? 'defined-from-citygml' : 'defined',
        originLatLon: [lat, lon],
        note: '既存データが無い都市のため原点を定義。参照点による逆推定は行っていない。' }
    };
    const outCfg = args['emit-config'];
    if (!outCfg) { console.log(JSON.stringify(cfg, null, 1)); return; }
    fs.mkdirSync(path.dirname(outCfg), { recursive: true });
    fs.writeFileSync(outCfg, JSON.stringify(cfg, null, 1));
    console.log('原点を定義しました: 系' + zone + ' / 基準(' + lat + ',' + lon + ') → E=' +
      cfg.localOrigin.projectedE + ' N=' + cfg.localOrigin.projectedN);
    console.log('coordinate-config.json を生成:', outCfg);
    return;
  }

  if (!args.refs) {
    console.error('--refs か --define-origin のどちらかを指定してください。');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(args.refs, 'utf8'));
  const refs = Array.isArray(raw) ? raw : (raw.references || []); // 自動生成形式/配列形式の両対応
  if (raw && raw.source) console.log('参照点ソース:', raw.source, '/ 生成:', raw.generatedAt || '-');
  const bad = refs.filter(r => !Number.isFinite(r.lat) || !Number.isFinite(r.lon) ||
    !Number.isFinite(r.localX) || !Number.isFinite(r.localZ) || !r.source);
  if (refs.length < 3 || bad.length) {
    console.error('参照点は3点以上必要で、各点に localX/localZ/lat/lon と source(取得元) が必須です。');
    console.error('本番運用では node tools/fetch-osm-references.js で自動生成してください（手入力不要）。');
    if (bad.length) console.error('不備:', bad.map(b => b.name || '(無名)').join(', '));
    process.exit(2);
  }
  const zones = args.zone ? [parseInt(args.zone, 10)] : Object.keys(JPRECT_ORIGINS).map(Number);
  const results = zones.map(z => evaluate(refs, z)).sort((a, b) => a.maxResidual - b.maxResidual);
  const best = results[0];

  console.log('══ 原点逆推定結果 ══');
  console.log('最良: 系' + best.zone + ' / sceneXSign=' + best.sceneXSign + ' / sceneZSign=' + best.sceneZSign);
  console.log('原点候補: projectedE=' + best.originE + ' / projectedN=' + best.originN);
  console.log('参照点: ' + best.inlierCount + '点採用 / ' + best.outlierCount + '点を外れ値除去（OSM編集等）');
  const show = best.residuals.filter(r => r.inlier).slice(0, 5);
  for (const r of show) console.log('  ' + r.name + ': ' + r.d + 'm (dE=' + r.dE + ', dN=' + r.dN + ')');
  if (best.residuals.filter(r => r.inlier).length > 5) console.log('  …他' + (best.inlierCount - 5) + '点');
  if (best.outlierCount) console.log('  除去: ' + best.outliers.slice(0, 5).map(o => o.name + '(' + o.d + 'm)').join(', '));
  console.log('スケール検証(投影距離/ローカル距離、≈1.0期待):');
  for (const s of best.scaleChecks.slice(0, 6)) console.log('  ' + s.pair + ': ' + s.ratio + ' (' + s.localDist + 'm vs ' + s.projDist + 'm)');
  const verdict = best.maxResidual <= RESIDUAL_WARN ? '合格（config転記可）'
    : best.maxResidual <= RESIDUAL_FAIL ? '要注意（参照点を追加して再確認を推奨）'
    : '不整合（参照点の座標取得元・系番号を見直すこと。configへ転記しない）';
  console.log('最大残差: ' + best.maxResidual + 'm → 判定: ' + verdict);
  if (zones.length > 1) {
    console.log('系別残差(上位3): ' + results.slice(0, 3).map(r => '系' + r.zone + '=' + r.maxResidual + 'm').join(' / '));
  }
  if (best.maxResidual <= RESIDUAL_WARN) {
    console.log('── coordinate-config.json への転記値 ──');
    console.log(JSON.stringify({ coordinateMode: 'geographic-jprect', jprectZone: best.zone,
      axisOrder: 'lat lon', localOrigin: { projectedE: best.originE, projectedN: best.originN },
      axisMapping: { sceneXSign: best.sceneXSign, sceneZSign: best.sceneZSign } }, null, 1));
  }
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify({ refs, best, allZones: results.map(r => ({ zone: r.zone, maxResidual: r.maxResidual })) }, null, 1));
  }
  // [自動化] 合格時のみ coordinate-config.json を自動生成（手作業の転記は不要）
  if (args['emit-config']) {
    if (best.maxResidual > RESIDUAL_WARN) {
      console.error('残差が閾値(' + RESIDUAL_WARN + 'm)を超えるため coordinate-config.json は生成しません。');
      console.error('参照点を増やす(--limit)か、OSM側ジオメトリの変化を確認してください。');
      process.exit(3);
    }
    const cfg = {
      _generated: 'tools/estimate-origin.js による自動生成（手入力なし）',
      generatedAt: new Date().toISOString(),
      version: 1,
      city: args.city || 'osaka',
      cityCode: args['city-code'] ? String(args['city-code']) : null,
      sourceCRS: 'JGD2011 / 平面直角座標系 第' + best.zone + '系（残差最小で自動選択）',
      coordinateMode: 'geographic-jprect',
      jprectZone: best.zone,
      axisOrder: 'lat lon',
      localOrigin: { projectedE: best.originE, projectedN: best.originN },
      axisMapping: { sceneXSign: best.sceneXSign, sceneZSign: best.sceneZSign },
      unit: 'meter', tileSize: 500,
      calibration: { references: refs.length, inliers: best.inlierCount, outliers: best.outlierCount,
        maxResidualM: best.maxResidual, refsFile: args.refs }
    };
    fs.mkdirSync(path.dirname(args['emit-config']), { recursive: true });
    fs.writeFileSync(args['emit-config'], JSON.stringify(cfg, null, 1));
    console.log('coordinate-config.json を自動生成しました:', args['emit-config']);
  }
}

main();
