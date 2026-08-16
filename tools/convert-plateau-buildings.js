#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/convert-plateau-buildings.js
// ══════════════════════════════════════════════════════════════
// PLATEAU CityGML(建物)を、split-building-tiles.jsが受け取る正規化JSON配列へ変換する。
// 座標変換は data/buildings/coordinate-config.json の実測値のみで行い、
// 値が未設定(null)の場合は変換せずエラー停止する（推測変換の禁止）。
//
// 実行例:
//   node tools/convert-plateau-buildings.js \
//     --input data/source/osaka-higashisumiyoshi \
//     --dataset osaka-higashisumiyoshi --ward 東住吉区 \
//     --coordinate-config data/buildings/coordinate-config.json \
//     --output data/processed/osaka-higashisumiyoshi-buildings.json \
//     [--html-ref public/osaka_3d_buildings.html]   … usage→ulabel対応表を既存BLDGSから抽出
//
// 入力: --input はCityGML(.gml)ファイル、またはそれらを含むディレクトリ。
// 出力: [{id, fp:[[x,z],...], z0, dz, h, usage, ulabel, ward, town}, ...]
//
// Footprint選択規則（住吉区と同一方針: 建物最下部の外周）:
//   1. bldg:lod0FootPrint の外周リング
//   2. bldg:GroundSurface の外周リング
//   3. lod1Solid内の全リングから平均標高が最小のリング（最下面）
//   ※屋根面(RoofSurface)はFootprintに使わない。interior(穴)リングは独立建物にしない。
// 高さ優先順位（指示8）:
//   1. bldg:measuredHeight
//   2. 建物Geometryの最大標高－最小標高
//   3. bldg:storeysAboveGround × DEFAULT_STOREY_HEIGHT(3.0m)
//   4. DEFAULT_HEIGHT(3.0m)  … いずれも取得元別件数を統計出力する

// ── ES Module形式（package.jsonの "type": "module" に対応）──
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { verifyWardConsistency, safeReplace } from './lib/path-config.js';
import { IdStore } from './lib/id-store.js';

const DEFAULT_STOREY_HEIGHT = 3.0; // 階数→高さの換算(m)。PLATEAU一般慣行値。独自ルールは追加しない
const DEFAULT_HEIGHT = 3.0;        // 全情報欠損時の安全既定値(m)

function parseArgs(argv) {
  // 値なしフラグ（--restart / --force / --keep-work）は次の引数を値として消費しない
  const FLAGS = new Set(['restart', 'force', 'keep-work']);
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (FLAGS.has(k)) { a[k] = true; continue; }
    const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}

// ── 座標設定の検証（推測値・プレースホルダの正式利用を防ぐ）──
function loadCoordinateConfig(p) {
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const missing = [];
  const need = (cond, name, why) => { if (!cond) missing.push(`${name}: ${why}`); };
  need(cfg.coordinateMode === 'projected' || cfg.coordinateMode === 'geographic-jprect',
    'coordinateMode', '"projected"(posListが投影座標m) か "geographic-jprect"(緯度経度→平面直角変換) を指定');
  if (cfg.coordinateMode === 'geographic-jprect') {
    need(Number.isInteger(cfg.jprectZone) && cfg.jprectZone >= 1 && cfg.jprectZone <= 19,
      'jprectZone', '平面直角座標系の系番号(大阪は通常VI=6)。住吉区パイプラインで使用した系を指定');
  }
  need(cfg.localOrigin && Number.isFinite(cfg.localOrigin.projectedE) && Number.isFinite(cfg.localOrigin.projectedN),
    'localOrigin.projectedE / projectedN', '住吉区変換で使用した基準原点の投影座標実測値(m)。推測値は不可');
  need(cfg.axisMapping && (cfg.axisMapping.sceneXSign === 1 || cfg.axisMapping.sceneXSign === -1),
    'axisMapping.sceneXSign', 'sceneX = sceneXSign × (E - originE)。住吉区の実装と一致させる(1 or -1)');
  need(cfg.axisMapping && (cfg.axisMapping.sceneZSign === 1 || cfg.axisMapping.sceneZSign === -1),
    'axisMapping.sceneZSign', 'sceneZ = sceneZSign × (N - originN)。住吉区の実装と一致させる(1 or -1)');
  need(cfg.axisOrder === 'lat lon' || cfg.axisOrder === 'lon lat' || cfg.axisOrder === 'E N' || cfg.axisOrder === 'N E',
    'axisOrder', 'posListの座標並び("lat lon" / "lon lat" / "E N" / "N E")');
  if (missing.length) {
    console.error('══ 座標設定が未確定のため変換を中止します（推測変換は行いません） ══');
    for (const m of missing) console.error(' 不足:', m);
    console.error('coordinate-config.template.json を参照し、住吉区の既存変換パイプライン');
    console.error('(tools/convert/ 等、本環境未同梱)から実測値を転記してください。');
    process.exit(2);
  }
  return cfg;
}

// ── 緯度経度→平面直角座標（JGD2011, 国土地理院公式級数式）──
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
  return { N: Abar * X - S0, E: Abar * Y }; // N=X(北), E=Y(東) ※測地系の呼称に合わせる
}

// ── posList文字列 → [E, N, alt] 配列 ──
function parsePosList(text, cfg) {
  const nums = text.trim().split(/\s+/).map(Number);
  const pts = [];
  for (let i = 0; i + 2 < nums.length; i += 3) {
    const v1 = nums[i], v2 = nums[i + 1], alt = nums[i + 2];
    let E, N;
    if (cfg.coordinateMode === 'geographic-jprect') {
      const lat = cfg.axisOrder === 'lat lon' ? v1 : v2;
      const lon = cfg.axisOrder === 'lat lon' ? v2 : v1;
      const p = latLonToJPRect(lat, lon, cfg.jprectZone);
      E = p.E; N = p.N;
    } else {
      E = (cfg.axisOrder === 'E N') ? v1 : v2;
      N = (cfg.axisOrder === 'E N') ? v2 : v1;
    }
    pts.push([E, N, alt]);
  }
  return pts;
}
function toLocal(E, N, cfg) {
  return [
    cfg.axisMapping.sceneXSign * (E - cfg.localOrigin.projectedE),
    cfg.axisMapping.sceneZSign * (N - cfg.localOrigin.projectedN)
  ];
}

// ── CityGML簡易パーサ（bldg:Buildingブロック単位・正規表現ベース）──

// 建物1件分のXML断片 → 正規化レコード。ロジックは従来と同一（footprint選択→検証→高さ→usage/town）。
// 戻り値: { rec } 採用 / { skip:'invalid'|'selfIntersect' } 除外。stats加算は呼び出し側。
function convertBuildingXml(id, xml, cfg, ulabelMap, ward) {
  const s = { fpSource: null, multiPart: false, selfIntersect: false,
    heightFrom: null, hasUsage: false, hasTown: false };
  let ringTexts = ringsIn(xml, /<bldg:lod0FootPrint>[\s\S]*?<\/bldg:lod0FootPrint>/);
  let fpSource = 'lod0FootPrint';
  if (!ringTexts.length) {
    ringTexts = ringsIn(xml, /<bldg:GroundSurface\b[\s\S]*?<\/bldg:GroundSurface>/);
    fpSource = 'GroundSurface';
  }
  let allPts = null, ring = null;
  if (ringTexts.length) {
    if (ringTexts.length > 1) s.multiPart = true;
    let best = null, bestArea = -1;
    for (const t of ringTexts) {
      const pts = parsePosList(t, cfg);
      let a2 = 0;
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p[0] * q[1] - q[0] * p[1]; }
      if (Math.abs(a2) / 2 > bestArea) { bestArea = Math.abs(a2) / 2; best = pts; }
    }
    ring = best;
  } else {
    const solid = xml.match(/<bldg:lod1Solid>[\s\S]*?<\/bldg:lod1Solid>/);
    if (solid) {
      const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
      let m, best = null, bestAlt = Infinity; const all = [];
      while ((m = re.exec(solid[0]))) {
        const pts = parsePosList(m[1], cfg);
        all.push(...pts);
        const avgAlt = pts.reduce((acc, p) => acc + p[2], 0) / pts.length;
        if (avgAlt < bestAlt) { bestAlt = avgAlt; best = pts; }
      }
      ring = best; allPts = all; fpSource = 'lowestRing';
    }
  }
  if (!ring || ring.length < 3) return { skip: 'invalid', fpNone: true };
  s.fpSource = fpSource;
  if (!allPts) {
    const solid = xml.match(/<bldg:lod1Solid>[\s\S]*?<\/bldg:lod1Solid>/);
    if (solid) {
      allPts = [];
      const re = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
      let m; while ((m = re.exec(solid[0]))) allPts.push(...parsePosList(m[1], cfg));
    } else allPts = ring;
  }
  let fp = ring.map(p => { const l = toLocal(p[0], p[1], cfg); return [Math.round(l[0] * 100) / 100, Math.round(l[1] * 100) / 100]; });
  if (fp.length >= 2 && fp[0][0] === fp[fp.length-1][0] && fp[0][1] === fp[fp.length-1][1]) fp = fp.slice(0, -1);
  let bad = fp.length < 3;
  for (const p of fp) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 1e6 || Math.abs(p[1]) > 1e6) bad = true;
  if (!bad) {
    outer: for (let i = 0; i < fp.length; i++)
      for (let j = i + 2; j < fp.length; j++) {
        if (i === 0 && j === fp.length - 1) continue;
        if (segIntersect(fp[i], fp[(i+1)%fp.length], fp[j], fp[(j+1)%fp.length])) { s.selfIntersect = true; bad = true; break outer; }
      }
  }
  if (bad) return { skip: s.selfIntersect ? 'selfIntersect' : 'invalid' };
  const measured = firstMatch(xml, /<bldg:measuredHeight[^>]*>([\d.]+)<\/bldg:measuredHeight>/);
  const storeys = firstMatch(xml, /<bldg:storeysAboveGround>(\d+)<\/bldg:storeysAboveGround>/);
  let h;
  if (measured) { h = parseFloat(measured); s.heightFrom = 'measuredHeight'; }
  else {
    const alts = allPts.map(p => p[2]).filter(Number.isFinite);
    const zr = alts.length ? Math.max(...alts) - Math.min(...alts) : 0;
    if (zr > 0.5) { h = zr; s.heightFrom = 'zRange'; }
    else if (storeys) { h = parseInt(storeys, 10) * DEFAULT_STOREY_HEIGHT; s.heightFrom = 'storeys'; }
    else { h = DEFAULT_HEIGHT; s.heightFrom = 'default'; }
  }
  if (!(h > 0)) return { skip: 'invalid' };
  h = Math.round(h * 10) / 10;
  const usage = firstMatch(xml, /<bldg:usage[^>]*>(\d+)<\/bldg:usage>/) || '';
  if (usage) s.hasUsage = true;
  const town = firstMatch(xml, /<gen:stringAttribute name="(?:町名|town|大字・町名)">\s*<gen:value>([^<]+)<\/gen:value>/) || '';
  if (town) s.hasTown = true;
  const rec = { id, fp, z0: 0, dz: h, h, usage, ulabel: ulabelMap[usage] || '', ward };
  if (town) rec.town = town;
  return { rec, s };
}

// GMLファイルを<bldg:Building>境界でチャンク分割しながらコールバックする（全文をメモリに載せない）。
// PLATEAUの建物GMLは1行が長くなりうるため、行単位ではなくストリームのバッファ境界で切り出す。
const MAX_BUILDING_BYTES = 64 * 1024 * 1024; // 単一Buildingの上限(64MB)。超過は異常として明確にエラー

// <bldg:Building> を要素名境界で厳密に判定しながらストリーム抽出する。
// 重要: 「<bldg:Building」の直後が空白/>/ で終わる場合のみ Building 開始とみなす。
//   → <bldg:BuildingPart> や <bldg:BuildingInstallation> を親Buildingとして誤検出しない。
// ネスト（Building内のBuildingPart）にも対応: 開始/終了タグの深さを数え、深さ0に戻った所で1棟切り出す。
// 開始タグがチャンク境界をまたいでも、次チャンク結合後に再判定するため取りこぼさない。
async function streamBuildings(file, onBuilding) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  let inside = false, depth = 0, startIdx = -1;
  // 要素名境界つきの正規表現。lastIndexを進めながら走査する。
  const OPEN_RE = /<bldg:Building(?=[\s/>])/g;   // <bldg:Building の直後が空白 / > /
  const PART_OPEN_RE = /<bldg:BuildingPart(?=[\s/>])/g;
  const CLOSE_RE = /<\/bldg:Building>/g;
  const PART_CLOSE_RE = /<\/bldg:BuildingPart>/g;

  async function tryEmit() {
    while (true) {
      if (!inside) {
        OPEN_RE.lastIndex = 0;
        // BuildingPart等を誤って拾わないよう、Building開始のみ探す
        let m = OPEN_RE.exec(buf);
        if (!m) {
          // 末尾に開始タグの断片が残る可能性があるので、安全マージンを残して前方を捨てる
          if (buf.length > 32) buf = buf.slice(-32);
          return;
        }
        startIdx = m.index;
        buf = buf.slice(startIdx); startIdx = 0;
        inside = true; depth = 1;
      }
      // inside: 直近の開始位置以降で、Building/BuildingPart の開始・終了を数えて深さ0の閉じを探す
      let scan = 1; // buf[0..] の '<bldg:Building' は既にカウント済みなので1から
      let pos = 1;
      let closeEnd = -1;
      // 単純カウンタ走査（正規表現をlastIndexで回す）
      const tokRe = /<(\/?)bldg:Building(Part)?(?=[\s/>])/g;
      tokRe.lastIndex = 1;
      let t, d = 1;
      while ((t = tokRe.exec(buf))) {
        const closing = t[1] === '/';
        if (closing) { d--; if (d === 0) { closeEnd = tokRe.lastIndex; break; } }
        else d++;
      }
      // 自己終了 <bldg:Building .../> の考慮（稀だが安全のため）
      if (closeEnd < 0) {
        // まだ閉じていない。バッファ肥大の監視
        if (buf.length > MAX_BUILDING_BYTES) {
          throw new Error('単一Buildingが上限(' + (MAX_BUILDING_BYTES / 1048576) + 'MB)を超過。閉じタグ不足か破損の可能性: ' + path.basename(file));
        }
        return; // 次チャンクを待つ
      }
      // closeEnd は </bldg:Building> の直後だが、実際のタグ終端 '>' まで含める
      const gt = buf.indexOf('>', closeEnd - 1);
      const end = gt >= 0 ? gt + 1 : closeEnd;
      const xml = buf.slice(0, end);
      const idm = xml.match(/^<bldg:Building[^>]*\sgml:id="([^"]+)"/) || xml.match(/gml:id="([^"]+)"/);
      await onBuilding(idm ? idm[1] : ('nogid_' + crypto.randomBytes(4).toString('hex')), xml);
      buf = buf.slice(end); inside = false; depth = 0;
    }
  }

  for await (const chunk of stream) {
    buf += chunk;
    await tryEmit();
  }
  // ストリーム終端で未完のBuildingが残っていれば閉じタグ不足
  if (inside && buf.indexOf('<bldg:Building') >= 0) {
    throw new Error('閉じタグ不足のBuildingが残存: ' + path.basename(file));
  }
}
function firstMatch(xml, re) { const m = xml.match(re); return m ? m[1] : null; }
function ringsIn(xml, sectionRe) {
  const sec = xml.match(sectionRe);
  if (!sec) return [];
  const rings = [];
  const re = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g; // interior(穴)は使わない
  let m;
  while ((m = re.exec(sec[0]))) rings.push(m[1]);
  return rings;
}
function segIntersect(p1,p2,p3,p4){
  const ccw=(a,b,c)=>(c[1]-a[1])*(b[0]-a[0])-(b[1]-a[1])*(c[0]-a[0]);
  const d1=ccw(p3,p4,p1),d2=ccw(p3,p4,p2),d3=ccw(p1,p2,p3),d4=ccw(p1,p2,p4);
  return ((d1>0)!==(d2>0))&&((d3>0)!==(d4>0));
}

// ── usage→ulabel 対応表を安全に読み込む（eval不使用）──
// 優先: --ulabel-map <json>（{"461":"事務所",...}）。
// 互換: --html-ref のHTMLからBLDGS配列を「正規表現で」usage/ulabel対を抽出（任意コード実行しない）。
function loadUlabelMap(args) {
  const map = {};
  if (args['ulabel-map'] && fs.existsSync(args['ulabel-map'])) {
    try {
      const j = JSON.parse(fs.readFileSync(args['ulabel-map'], 'utf8'));
      for (const k of Object.keys(j)) if (typeof j[k] === 'string') map[k] = j[k];
      console.log('ulabel対応表: JSONから', Object.keys(map).length, '種を読込');
      return map;
    } catch (e) { console.warn('ulabel-map読込失敗:', e.message); }
  }
  if (args['html-ref'] && fs.existsSync(args['html-ref'])) {
    const html = fs.readFileSync(args['html-ref'], 'utf8');
    const line = html.split('\n').find(l => l.startsWith('const BLDGS = '));
    if (line) {
      // eval を使わず、{... "usage":"461" ... "ulabel":"事務所" ...} の対を正規表現で拾う。
      // JSONオブジェクト境界ごとに usage と ulabel を同一オブジェクト内から取る。
      const objRe = /\{[^{}]*\}/g;
      let m, n = 0;
      while ((m = objRe.exec(line))) {
        const o = m[0];
        const u = o.match(/"usage"\s*:\s*"([^"]*)"/);
        const l = o.match(/"ulabel"\s*:\s*"([^"]*)"/);
        if (u && l && u[1] && l[1] && !map[u[1]]) { map[u[1]] = l[1]; n++; }
      }
      console.log('ulabel対応表: 既存BLDGSから', Object.keys(map).length, '種を抽出（eval不使用）');
    }
  }
  return map;
}

// 入力ルートからの相対パスを正規化した安全なチェックポイントキー
function safeKey(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return rel;
}
// キーをファイル名に使える安全なハッシュに
function keyHash(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// checkpoint fingerprint: 設定・コード・データセット・入力ルートが変わったら古い進捗を流用しない。
// 個別ファイルのsize/mtimeは含めない（失敗ファイルを修正して再開する正当なケースを妨げないため）。
// 各ファイルの内容整合は「成功チャンクのmeta」と「done判定（相対パスキー）」で個別に担保する。
function computeFingerprint(root, cfgPath, dataset, ward, wardCode, codeVersion) {
  const h = crypto.createHash('sha256');
  h.update('v=' + codeVersion + '|dataset=' + dataset + '|ward=' + ward + '|wardCode=' + (wardCode||'') + '|root=' + root + '\n');
  try {
    // 座標設定は変換結果を左右するので内容を含める（原点が変われば座標が全滅するため停止すべき）
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    h.update('cfg=' + JSON.stringify({ mode: c.coordinateMode, zone: c.jprectZone,
      origin: c.localOrigin, axis: c.axisMapping, order: c.axisOrder }) + '\n');
  } catch (e) {}
  return h.digest('hex');
}

const CODE_VERSION = 'convert-v2-stream-atomic';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dataset, ward, output } = args;
  const input = args.input;
  const wardCode = args['ward-code'] ? String(args['ward-code']) : null;
  if (!input || !dataset || !ward || !output || !args['coordinate-config']) {
    console.error('usage: node tools/convert-plateau-buildings.js --input <gml|dir> --dataset <id> --ward <区名> --coordinate-config <json> --output <json>');
    console.error('       [--ward-code 27121] [--html-ref <html> | --ulabel-map <json>] [--work-dir <dir>] [--restart] [--force] [--keep-work]');
    console.error('  --restart: このdatasetのcheckpointと中間生成物を初期化して最初から');
    console.error('  --force  : 既存の最終出力があっても再生成');
    process.exit(1);
  }
  // 区名・区コードの整合性検証（誤った組み合わせでの変換を防ぐ）
  if (wardCode) {
    const chk = verifyWardConsistency(ward, wardCode, args.sources || 'data/plateau-sources.json');
    if (!chk.ok) {
      console.error('══ 区名と区コードの不一致 ══');
      console.error('  ' + chk.message);
      process.exit(5);
    }
  }
  const cfg = loadCoordinateConfig(args['coordinate-config']);
  const ulabelMap = loadUlabelMap(args);

  // GMLをサブフォルダ含め再帰検索（隠しフォルダ・cache・tmp・出力先は除外）
  const EXCLUDE_DIRS = new Set(['.cache', 'cache', 'tmp', 'node_modules', 'chunks', '.git']);
  function findGmls(dir, out = []) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || EXCLUDE_DIRS.has(e.name)) continue;
        findGmls(path.join(dir, e.name), out);
      } else if (e.name.toLowerCase().endsWith('.gml')) {
        out.push(path.join(dir, e.name));
      }
    }
    return out;
  }
  const isDir = fs.statSync(input).isDirectory();
  const root = isDir ? path.resolve(input) : path.dirname(path.resolve(input));
  const files = (isDir ? findGmls(path.resolve(input)) : [path.resolve(input)]).sort();
  if (!files.length) { console.error('入力に.gmlがありません（サブフォルダも検索済み）:', input); process.exit(1); }
  console.log('GML検索:', files.length, 'ファイル（サブフォルダ再帰・隠し/cache/tmp除外）');

  // 作業ディレクトリ（checkpoint）
  const workDir = args['work-dir'] || path.join('.cache/convert', dataset);
  const chunksDir = path.join(workDir, 'chunks');
  const progressPath = path.join(workDir, 'progress.json');
  const failedPath = path.join(workDir, 'failed-files.json');
  const fpPath = path.join(workDir, 'fingerprint.txt');
  if (args.restart || args.force) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {} }
  fs.mkdirSync(chunksDir, { recursive: true });

  // 既存progressのwardCode不一致を最優先で検出（誤った区コードのcheckpoint再開を防ぐ。fingerprintより先）
  if (fs.existsSync(progressPath) && !args.restart && !args.force) {
    try {
      const pre = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      if (pre.wardCode && wardCode && String(pre.wardCode) !== wardCode) {
        console.error('══ 既存チェックポイントの区コードが一致しません ══');
        console.error('  既存progress: wardCode=' + pre.wardCode + ' / 今回指定: wardCode=' + wardCode);
        console.error('  別の区のデータを誤って再開しようとしています。--restart で初期化してください。');
        process.exit(6);
      }
    } catch (e) {}
  }

  // fingerprint検証（E要件）。wardCodeも含めて誤った組み合わせのcheckpoint再利用を防ぐ。
  const fingerprint = computeFingerprint(root, args['coordinate-config'], dataset, ward, wardCode, CODE_VERSION);
  if (fs.existsSync(fpPath)) {
    const prev = fs.readFileSync(fpPath, 'utf8').trim();
    if (prev !== fingerprint) {
      console.error('══ 入力構成・設定・区コード・コードが前回から変化しています ══');
      console.error('  古い進捗を流用すると不整合になります。--restart で初期化してください:');
      console.error('  node tools/convert-plateau-buildings.js ... --restart');
      process.exit(4);
    }
  } else {
    fs.writeFileSync(fpPath, fingerprint);
  }

  // 進捗の読み込み（統計も含めて復元＝B要件）
  const emptyStats = () => ({ input: 0, output: 0, invalid: 0,
    fpFrom: { lod0FootPrint: 0, GroundSurface: 0, lowestRing: 0, none: 0 },
    heightFrom: { measuredHeight: 0, zRange: 0, storeys: 0, default: 0 },
    usageCount: 0, townCount: 0, selfIntersect: 0, multiPart: 0, duplicates: 0 });
  let progress = { dataset, ward, wardCode, fingerprint, codeVersion: CODE_VERSION,
    startedAt: new Date().toISOString(), updatedAt: null,
    doneKeys: [], failed: [], stats: emptyStats() };
  // 既存progressのwardCode不一致を検出（誤った27114 checkpointを東住吉区として再開しない）
  if (fs.existsSync(progressPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      // 前回のwardCodeが今回と異なるなら、誤ったcheckpointの再利用として停止
      if (prev.wardCode && wardCode && String(prev.wardCode) !== wardCode) {
        console.error('══ 既存チェックポイントの区コードが一致しません ══');
        console.error('  既存progress: wardCode=' + prev.wardCode + ' / 今回指定: wardCode=' + wardCode);
        console.error('  別の区のデータを誤って再開しようとしています。--restart で初期化してください。');
        process.exit(6);
      }
      progress = { ...progress, ...prev, wardCode, startedAt: prev.startedAt || progress.startedAt };
      progress.stats = { ...emptyStats(), ...(prev.stats || {}) };
      progress.stats.fpFrom = { ...emptyStats().fpFrom, ...(prev.stats && prev.stats.fpFrom) };
      progress.stats.heightFrom = { ...emptyStats().heightFrom, ...(prev.stats && prev.stats.heightFrom) };
      console.log('前回の進捗を再開:', progress.doneKeys.length, '/', files.length, 'ファイル完了 / 累計出力', progress.stats.output);
    } catch (e) { console.warn('progress.json読込失敗。最初から処理します。'); }
  }
  const doneSet = new Set(progress.doneKeys);
  const stats = progress.stats; // 参照で更新

  // ── チャンクのクラッシュ復旧（要件2）──
  // rename後・meta保存後・progress保存前など、各コミット段階での停止を検出して整合を取る。
  // 既存データは無条件削除せず、正常なjsonl+metaが揃えばdoneへ復旧登録、不完全なら再処理対象に戻す。
  {
    let recovered = 0, reprocessed = 0, cleanedTmp = 0;
    const allEntries = fs.existsSync(chunksDir) ? fs.readdirSync(chunksDir) : [];
    const hashToKey = new Map();
    for (const f of files) { const k = safeKey(root, f); hashToKey.set(keyHash(k), k); }

    // 1) 古い.tmpを掃除（未コミットの残骸）
    for (const f of allEntries) {
      if (f.endsWith('.jsonl.tmp')) { try { fs.unlinkSync(path.join(chunksDir, f)); cleanedTmp++; } catch (e) {} }
    }
    // 2) 各正式jsonlについて meta と progress の整合を検査
    for (const jf of allEntries.filter(f => f.endsWith('.jsonl') && !f.endsWith('.jsonl.tmp'))) {
      const hash = jf.replace(/\.jsonl$/, '');
      const key = hashToKey.get(hash);
      if (!key) continue; // 現在の入力に対応しないチャンクは触らない
      const metaPath = path.join(chunksDir, hash + '.meta.json');
      const jsonlPath = path.join(chunksDir, jf);
      let jsonlCount = -1;
      try { const txt = fs.readFileSync(jsonlPath, 'utf8'); jsonlCount = txt ? txt.trimEnd().split('\n').filter(Boolean).length : 0; } catch (e) {}
      let metaOk = false, metaCount = -1;
      if (fs.existsSync(metaPath)) {
        try { const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); metaCount = m.count; metaOk = true; } catch (e) {}
      }
      if (metaOk && metaCount === jsonlCount && jsonlCount >= 0) {
        if (!doneSet.has(key)) { doneSet.add(key); recovered++; } // meta保存後・progress保存前で停止
      } else {
        // meta無し/件数不一致 → 不完全。安全に再処理（破棄してdoneから外す）
        try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch (e) {}
        try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch (e) {}
        if (doneSet.has(key)) doneSet.delete(key);
        reprocessed++;
      }
    }
    // 3) doneKeysにあるがjsonlが無いものは再処理へ戻す
    for (const key of [...doneSet]) {
      const jsonlPath = path.join(chunksDir, keyHash(key) + '.jsonl');
      if (!fs.existsSync(jsonlPath)) { doneSet.delete(key); reprocessed++; }
    }
    progress.doneKeys = [...doneSet];
    if (recovered || reprocessed || cleanedTmp) {
      console.log(`チャンク復旧: 復旧登録 ${recovered} / 再処理へ戻し ${reprocessed} / 古いtmp掃除 ${cleanedTmp}`);
    }
  }

  // 重複ID集合をディスクの成功チャンクmetaから復元（本体・座標は保持しない＝IDのみ）
  const SEEN_MAX_MEMORY = 2_000_000; // これを超えたらディスク索引へ自動切替（メモリ常駐回避）
  const seenIds = new IdStore({ maxMemory: SEEN_MAX_MEMORY, dir: path.join(workDir, 'idindex') });
  let seenWarned = false;
  for (const key of doneSet) {
    const metaPath = path.join(chunksDir, keyHash(key) + '.meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      for (const id of (meta.ids || [])) seenIds.add(id);
    } catch (e) {}
  }
  if (seenIds.size) console.log('重複判定IDを成功チャンクから復元:', seenIds.size, '件 (' + seenIds.mode + ')');

  // 復旧でdoneSetが変わった可能性があるため、統計をチャンクmetaから再構築（B要件の整合を保証）
  {
    const rebuilt = emptyStats();
    for (const key of doneSet) {
      const metaPath = path.join(chunksDir, keyHash(key) + '.meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const ls = m.stats; if (!ls) continue;
        rebuilt.input += ls.input || 0; rebuilt.output += ls.output || 0; rebuilt.invalid += ls.invalid || 0;
        rebuilt.selfIntersect += ls.selfIntersect || 0; rebuilt.multiPart += ls.multiPart || 0;
        rebuilt.usageCount += ls.usageCount || 0; rebuilt.townCount += ls.townCount || 0; rebuilt.duplicates += ls.duplicates || 0;
        for (const k of Object.keys(rebuilt.fpFrom)) rebuilt.fpFrom[k] += (ls.fpFrom && ls.fpFrom[k]) || 0;
        for (const k of Object.keys(rebuilt.heightFrom)) rebuilt.heightFrom[k] += (ls.heightFrom && ls.heightFrom[k]) || 0;
      } catch (e) {}
    }
    // 参照を保ったまま中身を差し替え
    Object.assign(stats, rebuilt);
  }

  let peakHeap = 0, peakRss = 0;
  const touchMem = () => { const m = process.memoryUsage(); if (m.heapUsed > peakHeap) peakHeap = m.heapUsed; if (m.rss > peakRss) peakRss = m.rss; return m; };
  const fmtMB = b => (b / 1024 / 1024).toFixed(0);
  const t0 = Date.now();
  let processedFiles = doneSet.size;

  const writeAtomic = (p, text) => {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, text);
    safeReplace(tmp, p); // Windows/Mac共通の安全置換
  };

  for (const file of files) {
    const key = safeKey(root, file);
    if (doneSet.has(key)) continue;
    // 古い失敗記録を先に消す（今回の結果で上書き）
    progress.failed = progress.failed.filter(f => f.file !== key);
    const hash = keyHash(key);
    const chunkTmp = path.join(chunksDir, hash + '.jsonl.tmp');
    const chunkFinal = path.join(chunksDir, hash + '.jsonl');
    const metaFinal = path.join(chunksDir, hash + '.meta.json');
    const fileStart = Date.now();
    let fileExtracted = 0, fileDup = 0, fileErr = null;
    const fileIds = [];
    const localStats = emptyStats();

    // 前回の中途半端な.tmpは破棄（C要件: 途中停止の部分データを使わない）
    try { if (fs.existsSync(chunkTmp)) fs.unlinkSync(chunkTmp); } catch (e) {}
    const chunkStream = fs.createWriteStream(chunkTmp);
    const writeLine = text => new Promise((res, rej) => chunkStream.write(text, e => e ? rej(e) : res()));

    try {
      await streamBuildings(file, async (id, xml) => {
        localStats.input++;
        const r = convertBuildingXml(id, xml, cfg, ulabelMap, ward);
        if (r.skip) {
          localStats.invalid++;
          if (r.fpNone) localStats.fpFrom.none++;
          if (r.skip === 'selfIntersect') localStats.selfIntersect++;
          return;
        }
        if (seenIds.has(r.rec.id)) { localStats.duplicates++; fileDup++; return; }
        seenIds.add(r.rec.id); fileIds.push(r.rec.id);
        await writeLine(JSON.stringify(r.rec) + '\n');
        localStats.output++; fileExtracted++;
        if (r.s.fpSource) localStats.fpFrom[r.s.fpSource]++;
        if (r.s.multiPart) localStats.multiPart++;
        if (r.s.heightFrom) localStats.heightFrom[r.s.heightFrom]++;
        if (r.s.hasUsage) localStats.usageCount++;
        if (r.s.hasTown) localStats.townCount++;
      });
      // ストリーム完了を確実に待つ（fsync相当のflush）
      await new Promise((res, rej) => chunkStream.end(err => err ? rej(err) : res()));
    } catch (e) {
      fileErr = e.message;
      try { await new Promise(res => chunkStream.end(res)); } catch (e2) {}
      try { if (fs.existsSync(chunkTmp)) fs.unlinkSync(chunkTmp); } catch (e2) {} // 失敗ファイルの.tmpは破棄
      // 今回追加したIDはロールバック（部分データ二重登録の防止）
      for (const id of fileIds) seenIds.delete(id);
    }

    processedFiles++;
    if (!fileErr) {
      // 原子的コミット: .tmp → 正式チャンク → meta → progressにdone記録（C要件の順序）
      fs.renameSync(chunkTmp, chunkFinal);
      writeAtomic(metaFinal, JSON.stringify({ file: key, count: fileExtracted, ids: fileIds, stats: localStats }));
      doneSet.add(key);
      progress.doneKeys = [...doneSet];
      progress.failed = progress.failed.filter(f => f.file !== key);
      // 累計統計へ加算（B要件: 再開後も正確）
      stats.input += localStats.input; stats.output += localStats.output; stats.invalid += localStats.invalid;
      stats.selfIntersect += localStats.selfIntersect; stats.multiPart += localStats.multiPart;
      stats.usageCount += localStats.usageCount; stats.townCount += localStats.townCount;
      stats.duplicates += localStats.duplicates;
      for (const k of Object.keys(localStats.fpFrom)) stats.fpFrom[k] += localStats.fpFrom[k];
      for (const k of Object.keys(localStats.heightFrom)) stats.heightFrom[k] += localStats.heightFrom[k];
    } else {
      progress.failed.push({ file: key, error: fileErr });
    }
    progress.updatedAt = new Date().toISOString();
    writeAtomic(progressPath, JSON.stringify(progress, null, 1));
    writeAtomic(failedPath, JSON.stringify(progress.failed, null, 1));

    const mem = touchMem();
    if (!seenWarned && seenIds.mode === 'disk') {
      seenWarned = true;
      console.warn('  ⚠ 重複判定IDが' + SEEN_MAX_MEMORY + '件を超えたためディスク索引へ自動切替しました（メモリ節約）。');
    }
    const pct = ((processedFiles / files.length) * 100).toFixed(1);
    console.log(`[${processedFiles}/${files.length}] ${path.basename(file)} 抽出${fileExtracted} 累計${stats.output} 重複${fileDup} ` +
      (fileErr ? 'ERR ' : '') + `${((Date.now() - fileStart) / 1000).toFixed(1)}s heap=${fmtMB(mem.heapUsed)}MB rss=${fmtMB(mem.rss)}MB ${pct}%`);
  }

  if (progress.failed.length) {
    console.error('\n失敗ファイル', progress.failed.length, '件。再実行で未完了分だけ再処理します:', failedPath);
    console.error('  ' + progress.failed.map(f => f.file).join(', '));
    process.exit(1);
  }

  // ── 全成功チャンクJSONL → 最終JSON配列へストリーム結合（メモリに載せない）──
  const tmpOut = output + '.tmp';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const outStream = fs.createWriteStream(tmpOut);
  await new Promise(r => outStream.write('[', r));
  let first = true, emitted = 0;
  for (const key of [...doneSet].sort()) {
    const chunkFinal = path.join(chunksDir, keyHash(key) + '.jsonl');
    if (!fs.existsSync(chunkFinal)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(chunkFinal), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      await new Promise((res, rej) => outStream.write((first ? '' : ',') + line, e => e ? rej(e) : res()));
      first = false; emitted++;
    }
  }
  await new Promise(r => outStream.write(']', r));
  await new Promise(r => outStream.end(r));

  // JSON妥当性をストリーミングで検証してからatomic置換（G要件）。
  // 全読み(JSON.parse)はGB級でOOMするため、先頭/末尾の括弧と要素数をストリームで確認する。
  {
    const size = fs.statSync(tmpOut).size;
    const fd = fs.openSync(tmpOut, 'r');
    const head = Buffer.alloc(1); fs.readSync(fd, head, 0, 1, 0);
    const tail = Buffer.alloc(1); fs.readSync(fd, tail, 0, 1, Math.max(0, size - 1));
    fs.closeSync(fd);
    let okBracket = head.toString() === '[' && tail.toString() === ']';
    // 要素数を軽量カウント（空配列'[]'は0件、それ以外はカンマ数+1で概算せず、書き出したemittedを正とする）
    if (!okBracket) {
      console.error('最終JSONの検証に失敗（角括弧不正・既存出力は保持）');
      try { fs.unlinkSync(tmpOut); } catch (e2) {}
      process.exit(1);
    }
    if (emitted === 0 && size > 2) {
      console.error('最終JSONの検証に失敗（0件のはずが非空・既存出力は保持）');
      try { fs.unlinkSync(tmpOut); } catch (e2) {}
      process.exit(1);
    }
    // 小さいファイル（<64MB）は完全パースで厳密検証
    if (size < 64 * 1024 * 1024) {
      try {
        const check = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
        if (!Array.isArray(check) || check.length !== emitted) throw new Error('件数不一致 ' + (Array.isArray(check) ? check.length : 'not-array') + ' != ' + emitted);
      } catch (e) {
        console.error('最終JSONの検証に失敗（既存出力は保持）:', e.message);
        try { fs.unlinkSync(tmpOut); } catch (e2) {}
        process.exit(1);
      }
    } else {
      console.log('（最終JSONが大容量(' + (size / 1048576).toFixed(0) + 'MB)のため、角括弧＋ストリーム件数で検証。件数=' + emitted + '）');
    }
  }
  safeReplace(tmpOut, output);
  touchMem();

  console.log('\n入力ファイル:', files.length, '/ 入力建物:', stats.input, '/ 出力建物:', stats.output,
    '/ 無効除外:', stats.invalid, '/ 重複除外:', stats.duplicates);
  console.log('Footprint取得元:', JSON.stringify(stats.fpFrom), '(複数棟外周選択:', stats.multiPart, ')');
  console.log('高さ取得元:', JSON.stringify(stats.heightFrom));
  console.log('用途あり:', stats.usageCount, '/ 町丁目あり:', stats.townCount, '/ 自己交差除外:', stats.selfIntersect);
  console.log('peak heapUsed=' + fmtMB(peakHeap) + 'MB peak rss=' + fmtMB(peakRss) + 'MB / 総時間 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('出力:', output, '(' + (fs.statSync(output).size / 1024 / 1024).toFixed(1) + 'MB) / 出力件数', emitted);
  if (emitted !== stats.output) console.warn('  ⚠ 最終JSON件数(' + emitted + ')とstats.output(' + stats.output + ')が不一致');
  try { seenIds.destroy(); } catch (e) {}
  if (!args['keep-work']) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {} }
}
main().catch(e => { console.error('[convert-plateau-buildings] 失敗:', e.message); process.exit(1); });
