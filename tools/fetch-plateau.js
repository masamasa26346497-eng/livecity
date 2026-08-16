#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// tools/fetch-plateau.js
// ══════════════════════════════════════════════════════════════
// ── ES Module形式（package.jsonの "type": "module" に対応）──
//
// PLATEAU（国土交通省 3D都市モデル）の建物CityGMLを自動取得する。
//   URL解決 → ダウンロード → ZIPから必要なGMLだけ選択展開 → 区コードで絞り込み → 一時ファイル削除
// までを行い、data/raw/{datasetId}/ に変換対象のGMLを配置する。
//
// ── 配布形式の変更に耐えるための設計 ──
// 1) URL解決は3段フォールバック。コード変更なしで運用を続けられる。
//      ①--url 明示指定
//      ②data/plateau-sources.json（運用側で編集可能な定義ファイル）
//      ③G空間情報センター CKAN API 検索（package_search → resource一覧）
//    ②③のどちらが欠けても、もう一方だけで動作する。
// 2) ZIP内の対象判定は正規表現をJSON設定に外出し（gmlPatterns / bldgPatterns。複数候補可）。
//    ディレクトリ階層が変わっても再帰的に探索するため影響を受けない。
// 3) 区の絞り込みは「ファイル名」ではなく「ファイル内容に区コードが含まれるか」で判定する。
//    PLATEAUの建物GMLはメッシュ単位で分割され名称に区名を持たないため、
//    命名規則の変更に依存しないこの方式を採用している。
// 4) ZIPは全展開せず、中央ディレクトリを読んで必要エントリだけを部分展開する。
//    数GBの市単位ZIPでもメモリを圧迫せず、不要ファイルをディスクに書き出さない。
//    Zip64（4GB超）にも対応。外部コマンド（unzip/PowerShell）に依存しない。
//
// 使い方:
//   node tools/fetch-plateau.js --dataset osaka-higashisumiyoshi --ward-code 27121
//   node tools/fetch-plateau.js --dataset x --url https://.../27100_osaka-shi_citygml.zip --ward-code 27121
//   node tools/fetch-plateau.js --city-code 27100 --list        # 配布リソース一覧の確認のみ
//   node tools/fetch-plateau.js ... --dry-run                   # 取得計画の表示のみ
//
// setup-area.js から STEP0 として自動実行される（--citygml 未指定かつ --ward-code 指定時）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dataPaths } from './lib/path-config.js';

const DEFAULT_SOURCES = 'data/plateau-sources.json';
const RETRY = 3, RETRY_WAIT_MS = 5000;
// CKAN APIのベースURL。--ckan-base または環境変数 PLATEAU_CKAN_BASE で差し替え可能
// （G空間情報センター側のURL変更、社内ミラー、オフライン検証に対応するため）
const DEFAULT_CKAN_BASE = 'https://www.geospatial.jp/ckan/api/3/action';
let CKAN_BASE = process.env.PLATEAU_CKAN_BASE || DEFAULT_CKAN_BASE;

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
const fmtMB = b => (b / 1024 / 1024).toFixed(1) + 'MB';

// ══════════════════════════════════════════════════════════
// 設定ファイル（運用側で編集可能。配布URLが変わってもコード変更不要）
// ══════════════════════════════════════════════════════════
function loadSources(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn('[fetch-plateau] 設定ファイルの解析に失敗:', p, e.message); return null; }
}

// ══════════════════════════════════════════════════════════
// URL解決: ①--url ②設定ファイル ③CKAN API検索
// ══════════════════════════════════════════════════════════
async function httpJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'LiveCity/1.0 (plateau-fetch)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// CKANレスポンスを保存する（調査用。--save-json 既定ON）
function saveCkanJson(obj, label, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `ckan-${label.replace(/[^\w.-]/g, '_').slice(0, 60)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj, null, 1));
    console.log('  CKANレスポンスを保存:', f);
    return f;
  } catch (e) { console.warn('  レスポンス保存に失敗:', e.message); return null; }
}

// 検索語を段階的に広げる。CKANのqは複数語がAND結合されるため、
// 語を多く並べるほど0件になりやすい。狭い順→広い順に試す。
function buildQueries(cityCode, cityName, userQuery) {
  const qs = [];
  if (userQuery) qs.push(String(userQuery));
  // PLATEAU限定の語を先に置く（市コード単独だと統計データ等が大量に混ざるため後段へ回す）
  if (cityName) {
    qs.push(`3D都市モデル ${cityName}`);
    qs.push(`PLATEAU ${cityName}`);
    qs.push(`${cityName} CityGML`);
  }
  if (cityCode) {
    qs.push(`3D都市モデル ${cityCode}`);
    qs.push(`PLATEAU ${cityCode}`);
  }
  qs.push('3D都市モデル CityGML');
  qs.push('PLATEAU CityGML');
  // 最後の手段: 市コード/市名の単独検索（package段階フィルタで無関係なものは落とす）
  if (cityCode) qs.push(String(cityCode));
  if (cityName) qs.push(String(cityName));
  return [...new Set(qs)];
}

// リソースが取得対象になりうるか判定し、理由も返す（不採用理由をログに出すため）
//
// PLATEAUは同じ都市について複数形式を配布している:
//   CityGML版   … 27100_osaka-shi_2020_citygml_3_op.zip   ← 本ツールの対象
//   Shapefile版 … 27100_osaka-shi_2020_shape_3_op.zip     ← shp/dbf/shxのみでGMLを含まない
//   3D Tiles版 / OBJ版 / GeoJSON版 なども併存する
// いずれもZIPなので「アーカイブか否か」では区別できない。
// そのため ①非CityGML形式を明示的に除外 → ②CityGMLを示す語を要求 という二段構えで判定する。
const RE_SHAPEFILE = /shape\s*file|shapefile|(^|[_\-\/\s])shp([_\-\/\s.]|$)|\.shp|\.dbf|\.shx|esri/i;
const RE_OTHER_FORMAT = /3d\s*tiles|3dtiles|\.obj|(^|[_\-\/\s])obj([_\-\/\s.]|$)|fbx|gltf|glb|geojson|mvt|\.las|lasz|point\s*cloud|texture|\.kml|czml/i;
const RE_DOCUMENT = /\.(pdf|xlsx?|docx?|pptx?|csv|txt|html?)($|\?)/i;
const RE_DOC_WORD = /品質評価|仕様書|マニュアル|説明書|メタデータ|利用規約|report/i;
const RE_CITYGML = /citygml|city\s*gml/i;
const RE_GML = /(^|[_\-\/\s.])gml([_\-\/\s.]|$)/i;
const RE_PLATEAU = /3d都市モデル|plateau/i;
const RE_BLDG = /bldg|建築物|建物/i;

// ── パッケージ（データセット）段階の判定 ──
// CKANの全文検索は市コードや市名だけで統計・CSV・Shapefile等の無関係なデータセットも拾う。
// リソースを評価する前に、まずデータセット自体がPLATEAUの3D都市モデルかを判定して絞り込む。
const RE_PKG_PLATEAU = /plateau|3d都市モデル|3d\s*city\s*model|都市モデル/i;
const RE_PKG_STATS = /統計|国勢調査|人口|世帯|推計|地価|課税|税務|家計|事業所|センサス|指標|集計|名簿|一覧表/i;
const RE_PKG_OTHER = /航空写真|オルソ|標高|dem|地形図|道路台帳|避難所|公共施設一覧|バス|時刻表/i;

function evaluatePackage(pkg, cityCode, cityName) {
  const title = pkg.title || pkg.name || '';
  const notes = pkg.notes || '';
  const tags = (pkg.tags || []).map(t => (typeof t === 'string' ? t : (t.display_name || t.name || ''))).join(' ');
  const org = (pkg.organization && (pkg.organization.title || pkg.organization.name)) || '';
  const resNames = (pkg.resources || []).map(r => (r.name || '') + ' ' + (r.url || '') + ' ' + (r.format || '')).join(' ');
  const hay = [title, notes, tags, org, resNames].join(' ').toLowerCase();

  const isPlateau = RE_PKG_PLATEAU.test(hay);
  if (!isPlateau) {
    if (RE_PKG_STATS.test(title)) return { eligible: false, score: 0, rejectReason: '統計・調査データ（PLATEAUではない）' };
    if (RE_PKG_OTHER.test(title)) return { eligible: false, score: 0, rejectReason: '別種の地理データ（PLATEAUではない）' };
    return { eligible: false, score: 0, rejectReason: 'PLATEAU/3D都市モデルを示す語がタイトル・説明・タグ・リソース名に無い' };
  }
  // ── 対象都市の一致を必須にする（他都市のPLATEAUデータセットを弾く）──
  // 市コード(27100)か市名(大阪市)のどちらかが、title か リソース名(=URL/ファイル名)に含まれること。
  // これが無いと "PLATEAU" 単独検索で全国のデータセットが採用されてしまう。
  const titleHay = (title + ' ' + resNames).toLowerCase();
  const codeHit = cityCode && titleHay.includes(String(cityCode).toLowerCase());
  const nameHit = cityName && titleHay.includes(String(cityName).toLowerCase());
  if ((cityCode || cityName) && !codeHit && !nameHit) {
    return { eligible: false, score: 0,
      rejectReason: '対象都市（' + [cityCode, cityName].filter(Boolean).join(' / ') +
        '）が title・リソース名に含まれない（別都市のPLATEAUデータセット）' };
  }
  // PLATEAUだがCityGML/GMLを含むリソースが1つも無い場合（Shapefile専用配布など）
  const hasGmlResource = (pkg.resources || []).some(r => {
    const h = ((r.name || '') + ' ' + (r.description || '') + ' ' + (r.url || '') + ' ' + (r.format || '')).toLowerCase();
    if (RE_SHAPEFILE.test(h) || RE_OTHER_FORMAT.test(h)) return false;
    return RE_CITYGML.test(h) || RE_GML.test(h) || (RE_BLDG.test(h) && /zip|7z/i.test(h));
  });
  if (!hasGmlResource) {
    return { eligible: false, score: 0, rejectReason: 'PLATEAUだがCityGML/GMLリソースを含まない（Shapefile/3D Tiles等のみ）' };
  }

  let score = 5;
  const reasons = ['PLATEAU/3D都市モデル'];
  if (cityCode && hay.includes(String(cityCode).toLowerCase())) { score += 3; reasons.push('市コード一致'); }
  if (cityName && hay.includes(String(cityName).toLowerCase())) { score += 2; reasons.push('市名一致'); }
  if (/citygml/i.test(hay)) { score += 2; reasons.push('CityGML明示'); }
  return { eligible: true, score, reasons, rejectReason: null };
}

function evaluateResource(r, pkg, cityCode) {
  const name = (r.name || '') + ' ' + (r.description || '');
  const url = r.url || '';
  const fmt = (r.format || '');
  const hay = (name + ' ' + url + ' ' + fmt).toLowerCase();
  const pkgTitle = (pkg.title || '');

  // ── ① 除外判定（形式が明確に違うものを先に落とす）──
  if (RE_SHAPEFILE.test(hay)) {
    return { eligible: false, score: -99, reasons: [],
      rejectReason: 'Shapefile版（shp/dbf/shxのみでGMLを含まない）' };
  }
  if (RE_OTHER_FORMAT.test(hay)) {
    return { eligible: false, score: -99, reasons: [],
      rejectReason: 'CityGML以外の配信形式（3D Tiles/OBJ/GeoJSON等）' };
  }
  if (RE_DOCUMENT.test(url) || RE_DOC_WORD.test(name)) {
    return { eligible: false, score: -99, reasons: [],
      rejectReason: '文書ファイル（PDF/Excel/仕様書等）' };
  }

  // ── ② CityGMLであることを示す根拠を要求 ──
  const hasCityGml = RE_CITYGML.test(hay);
  const hasGml = RE_GML.test(hay) || /gml/i.test(fmt);
  const hasPlateau = RE_PLATEAU.test(hay) || RE_PLATEAU.test(pkgTitle);
  const hasBldg = RE_BLDG.test(hay);
  const isArchive = /zip|7z|tar|gz/i.test(fmt) || /\.(zip|7z|tar\.gz|tgz)($|\?)/i.test(url);

  let score = 0;
  const reasons = [];
  if (hasCityGml) { score += 6; reasons.push('CityGML明示'); }
  if (hasGml) { score += 4; reasons.push('GML'); }
  if (hasBldg) { score += 3; reasons.push('建築物/bldg'); }
  if (hasPlateau) { score += 2; reasons.push('3D都市モデル/PLATEAU'); }
  if (cityCode && hay.includes(String(cityCode).toLowerCase())) { score += 3; reasons.push('市コード一致'); }
  if (isArchive) { score += 1; reasons.push('アーカイブ'); }
  if (/lod[123]/i.test(hay)) { score += 1; reasons.push('LOD指定'); }

  // 採用条件: CityGML/GMLの明示、または「PLATEAUデータセット かつ 建築物」
  const eligible = hasCityGml || hasGml || (hasPlateau && hasBldg);
  const rejectReason = eligible ? null
    : 'CityGMLを示す語（citygml/gml/建築物+3D都市モデル）が name・description・format・url のいずれにも無い';
  return { eligible, score, reasons, rejectReason, url, fmt };
}

async function resolveFromCkan(cityCode, cityName, args) {
  const cacheDir = args.cache || dataPaths(args).archives;
  const queries = buildQueries(cityCode, cityName, args.query);
  let allCands = [];
  const rejectedSummary = [];

  for (const q of queries) {
    const url = `${CKAN_BASE}/package_search?q=${encodeURIComponent(q)}&rows=50`;
    console.log('\n───────────────────────────────────────────');
    console.log('CKAN検索 q="' + q + '"');
    console.log('  送信URL:', url);
    let j;
    try { j = await httpJson(url); }
    catch (e) { console.warn('  検索失敗:', e.message); continue; }
    saveCkanJson(j, 'search-' + q, cacheDir);

    const count = (j && j.result && j.result.count) || 0;
    const results = (j && j.result && j.result.results) || [];
    console.log(`  ヒット総数: ${count} 件（取得 ${results.length} 件）`);
    // ヒットした全 package.title を列挙（他都市混入の可視化）
    console.log('  ヒットしたpackage.title:');
    results.forEach((pkg, i) => console.log(`    (${i}) ${pkg.title || pkg.name}`));
    if (!results.length) continue;

    // ── package段階のフィルタ（resource評価の前に実施）──
    console.log('  検索されたデータセット一覧:');
    const accepted = [], rejected = [];
    for (const pkg of results) {
      const pe = evaluatePackage(pkg, cityCode, cityName);
      if (pe.eligible) accepted.push({ pkg, pe }); else rejected.push({ pkg, pe });
      console.log(`    ${pe.eligible ? '✓' : '×'} ${pkg.title || pkg.name}` +
        (pe.eligible ? `  [採用 score=${pe.score} / ${pe.reasons.join(' / ')}]` : `  [除外: ${pe.rejectReason}]`));
    }
    console.log(`  → 採用データセット ${accepted.length} 件 / 除外 ${rejected.length} 件`);
    if (!accepted.length) { console.log('  この検索語ではPLATEAUデータセットが見つかりません。次の検索語を試します。'); continue; }

    accepted.sort((a, b) => b.pe.score - a.pe.score);
    for (const { pkg, pe } of accepted) {
      const resources = pkg.resources || [];
      console.log(`\n  ★ 採用package.title: ${pkg.title || pkg.name}`);
      console.log(`     採用理由: ${pe.reasons.join(' / ')}（score=${pe.score}）`);
      console.log(`     package.resources 先頭5件:`);
      resources.slice(0, 5).forEach((r, i) =>
        console.log(`       [${i}] ${r.name || '(無名)'} | format=${r.format || '空'} | ${r.url || ''}`));
      console.log(`  ├ リソース評価（${resources.length} 件）:`);
      for (const r of resources) {
        const ev = evaluateResource(r, pkg, cityCode);
        const label = `${r.name || '(無名)'} [format=${r.format || '空'}${r.size ? ', ' + fmtMB(r.size) : ''}]`;
        if (ev.eligible) {
          console.log(`  │   ✓ 採用候補 score=${ev.score} ${label}`);
          console.log(`  │     ${r.url}`);
          console.log(`  │     理由: ${ev.reasons.join(' / ') || '-'}`);
          allCands.push({ url: r.url, name: r.name || pkg.title, size: r.size || 0,
            score: ev.score, pkg: pkg.title, format: r.format || '' });
        } else {
          console.log(`  │   × 不採用 ${label} … ${ev.rejectReason}`);
          rejectedSummary.push({ name: r.name, url: r.url, reason: ev.rejectReason });
        }
      }
    }
    if (allCands.length) break; // 候補が得られた検索語で打ち切る
  }

  // 重複URLを除去してスコア順
  const seen = new Set();
  allCands = allCands.filter(c => !seen.has(c.url) && seen.add(c.url)).sort((a, b) => b.score - a.score);

  console.log(`\n候補の集計: 採用可能 ${allCands.length} 件 / 不採用 ${rejectedSummary.length} 件`);
  if (!allCands.length && rejectedSummary.length) {
    console.log('不採用となったリソース（先頭10件）:');
    rejectedSummary.slice(0, 10).forEach((r, i) =>
      console.log(`  [${i}] ${r.name || '(無名)'} … ${r.reason}\n      ${r.url}`));
  }
  return allCands;
}

// ── リモートZIPの中身をRangeリクエストで検証（全体をダウンロードしない）──
// HTTP Rangeで末尾（中央ディレクトリ）だけを取得し、ZIP内に *.gml / *.xml が存在するか、
// さらにその中身に <bldg:Building> または CityModel が含まれるかを確認する。
// これにより resource名だけに頼らず、ZIPの実内容で採否を決められる。
async function fetchRange(url, start, end) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LiveCity/1.0 (plateau-verify)', 'Range': `bytes=${start}-${end}` }
  });
  if (res.status !== 206 && res.status !== 200) throw new Error('Range非対応 (HTTP ' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, status: res.status, acceptRanges: res.headers.get('accept-ranges'),
    contentRange: res.headers.get('content-range') };
}
async function getContentLength(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'LiveCity/1.0' } });
    const len = Number(res.headers.get('content-length') || 0);
    return { len, acceptRanges: res.headers.get('accept-ranges') };
  } catch (e) { return { len: 0, acceptRanges: null }; }
}

// deflateRawされたローカルエントリをRangeで取得して展開し、先頭テキストを返す
async function fetchEntryText(url, entry, maxBytes) {
  // ローカルヘッダ(30B+名前+extra)を読み、データ開始位置を確定
  const lh = (await fetchRange(url, entry.localOffset, entry.localOffset + 29)).buf;
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('ローカルヘッダ不正');
  const nameLen = lh.readUInt16LE(26), extraLen = lh.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const want = Math.min(entry.compSize, maxBytes || entry.compSize);
  const comp = (await fetchRange(url, dataStart, dataStart + want - 1)).buf;
  if (entry.method === 0) return comp.toString('utf8');
  if (entry.method === 8) {
    // 部分データのdeflateはZ_BUF_ERRORで途中終了する。得られた分だけ返す。
    return await new Promise((resolve) => {
      const inflate = zlib.createInflateRaw();
      const chunks = [];
      inflate.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > (maxBytes || 1e9)) inflate.destroy(); });
      inflate.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      inflate.on('error', () => resolve(Buffer.concat(chunks).toString('utf8'))); // 途中打ち切りは正常系
      inflate.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      inflate.end(comp);
    });
  }
  throw new Error('未対応の圧縮方式 ' + entry.method);
}

// 検証結果: { ok, reason, gmlCount, sampledName, hasBuildingTag }
async function verifyRemoteZipHasCityGml(url) {
  const { len, acceptRanges } = await getContentLength(url);
  if (!len) {
    // content-lengthが取れない場合はRangeで末尾を推測取得
    console.log('    (content-length不明。末尾64KBをRange取得して試行)');
  }
  // 末尾（EOCD + 可能なら中央ディレクトリ)を取得
  const tailSize = Math.min(len || 5 * 1024 * 1024, 5 * 1024 * 1024); // 最大5MB（大規模CDに対応）
  const start = len ? Math.max(0, len - tailSize) : 0;
  let tail;
  try { tail = (await fetchRange(url, start, (len || start + tailSize) - 1)).buf; }
  catch (e) { return { ok: false, reason: 'Rangeリクエスト不可: ' + e.message }; }

  const readAbs = async (off, l) => (await fetchRange(url, off, off + l - 1)).buf;
  // locateCentralDirectory は同期の readAbsolute を要求するため、Zip64分岐用に事前取得は行わず簡易対応
  let loc;
  try {
    loc = locateCentralDirectory(tail, start, (off, l) => {
      throw new Error('__NEEDS_ASYNC__'); // Zip64は後述の再取得で対応
    });
  } catch (e) {
    if (e.message === '__NEEDS_ASYNC__') {
      // Zip64: z64 EOCDを非同期取得してからもう一度
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      let l2 = -1;
      for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x07064b50) { l2 = i; break; }
      const z64Off = Number(tail.readBigUInt64LE(l2 + 8));
      const z64 = await readAbs(z64Off, 56);
      loc = { count: Number(z64.readBigUInt64LE(32)), cdSize: Number(z64.readBigUInt64LE(40)), cdOffset: Number(z64.readBigUInt64LE(48)) };
    } else {
      return { ok: false, reason: 'ZIP解析失敗: ' + e.message };
    }
  }
  // 中央ディレクトリを取得（末尾取得済み範囲に含まれていればそれを使い、無ければ再取得）
  let cd;
  if (len && loc.cdOffset >= start) cd = tail.subarray(loc.cdOffset - start, loc.cdOffset - start + loc.cdSize);
  else cd = await readAbs(loc.cdOffset, loc.cdSize);
  const entries = parseCentralDirectory(cd, loc.count);

  const gmls = entries.filter(e => isGml(e.name));
  if (!gmls.length) {
    // ZIP内のファイル種別を要約して理由に添える
    const exts = {};
    for (const e of entries) { const m = e.name.match(/\.([a-z0-9]+)$/i); const x = m ? m[1].toLowerCase() : '(なし)'; exts[x] = (exts[x] || 0) + 1; }
    return { ok: false, reason: 'ZIP内にGML/XMLが存在しない（拡張子: ' + JSON.stringify(exts) + '）', gmlCount: 0 };
  }
  // 建物GMLを優先し、その中身に <bldg:Building> か CityModel があるか確認
  const bldgFirst = gmls.filter(e => isBldg(e.name)).concat(gmls);
  for (const e of bldgFirst.slice(0, 3)) { // 最大3ファイルまで中身を確認
    try {
      const head = await fetchEntryText(url, e, 256 * 1024); // 先頭256KB展開で十分
      if (/<bldg:Building[\s>]|<[a-zA-Z]+:CityModel[\s>]|<CityModel[\s>]/.test(head)) {
        return { ok: true, gmlCount: gmls.length, sampledName: e.name, hasBuildingTag: true };
      }
    } catch (err) { /* 次の候補へ */ }
  }
  return { ok: false, reason: 'GMLは存在するが <bldg:Building>/CityModel を確認できなかった', gmlCount: gmls.length };
}

async function resolveUrl(args, sources) {
  if (typeof args.url === 'string') return { url: args.url, from: '--url 指定' };
  const wardCode = String(args['ward-code'] || '');
  // 政令指定都市の区コード(例 27121=東住吉区) → 市コード(27100)。上位3桁+'00'。
  // 横浜14101→14100、名古屋23101→23100 と同じ規則。--city-code で明示指定も可能。
  const cityCode = String(args['city-code'] || (wardCode ? wardCode.slice(0, 3) + '00' : ''));

  // ② 設定ファイル: cities[cityCode].url、または wards[wardCode].url（区単位配布がある場合）
  if (sources) {
    const w = sources.wards && sources.wards[wardCode];
    if (w && w.url) return { url: w.url, from: `設定ファイル wards.${wardCode}` };
    const c = sources.cities && sources.cities[cityCode];
    if (c && c.url) return { url: c.url, from: `設定ファイル cities.${cityCode}` };
  }
  // ③ CKAN検索
  const cityName = (sources && sources.cities && sources.cities[cityCode] && sources.cities[cityCode].name) || '';
  console.log('対象都市の絞り込み条件: 市コード=' + (cityCode || '(なし)') + ' / 市名=' + (cityName || '(定義ファイルに未登録。市コード一致のみで判定)'));
  // 定義ファイルに検索語ヒント(query)があれば最優先で使う
  const hintQuery = (sources && sources.cities && sources.cities[cityCode] && sources.cities[cityCode].query) || null;
  const cands = await resolveFromCkan(cityCode, cityName, { ...args, query: args.query || hintQuery });
  if (!cands.length) {
    console.error('\n══ 配布リソースを特定できませんでした ══');
    console.error('上のログに、検索語ごとのヒット数と各リソースの不採用理由を出力しています。');
    console.error('保存済みCKANレスポンス:', path.join(args.cache || '.cache/plateau', 'ckan-*.json'));
    console.error('対処:');
    console.error('  ① --query "<検索語>" で検索語を変える（例: --query "大阪市 建築物モデル"）');
    console.error('  ② 一覧を確認: node tools/fetch-plateau.js --city-code ' + (cityCode || '27100') + ' --list');
    console.error('  ③ 配布URLが分かっている場合: --url <zip url>');
    console.error('  ④ ' + DEFAULT_SOURCES + ' の cities.' + (cityCode || '27100') + '.url に記載');
    throw new Error('配布リソースを特定できませんでした');
  }
  if (args.list) {
    console.log('候補リソース:');
    cands.slice(0, 20).forEach((c, i) => console.log(`  [${i}] score=${c.score} ${c.name} (${c.size ? fmtMB(c.size) : 'サイズ不明'}) format=${c.format}\n      ${c.url}`));
    return { url: null, from: 'list', cands };
  }
  const idx = args['resource-index'] !== undefined ? parseInt(args['resource-index'], 10) : 0;
  if (!cands[idx]) { console.error('--resource-index', idx, 'に該当する候補がありません（候補数', cands.length, '）'); process.exit(1); }
  if (cands.length > 1) {
    console.log('\n採用候補一覧（--resource-index で選択可）:');
    cands.slice(0, 10).forEach((c, i) => console.log(`  [${i}]${i === idx ? ' ←採用' : ''} score=${c.score} ${c.name} ${c.size ? '(' + fmtMB(c.size) + ')' : ''}\n      ${c.url}`));
  }
  // ── 内容検証: resource名では決めず、ZIP中央ディレクトリを読んで実内容で採否を決定 ──
  // idx指定があればその1件のみ、無ければスコア順に各候補のZIP内容を検証して最初に合格したものを採る。
  const toVerify = (args['resource-index'] !== undefined) ? [cands[idx]] : cands;
  let verified = null;
  if (args['no-verify']) {
    console.log('\n(--no-verify 指定のためZIP内容検証をスキップし、メタデータ判定のみで採用)');
    verified = cands[idx];
  } else {
    for (const c of toVerify) {
      console.log('\nZIP内容を検証中:', c.name);
      console.log('  url:', c.url);
      let v;
      try { v = await verifyRemoteZipHasCityGml(c.url); }
      catch (e) { console.log('  × 検証失敗:', e.message); continue; }
      if (v.ok) {
        console.log('  ✓ ZIP内容を確認した結果採用: GML/XML ' + v.gmlCount + ' 件、' +
          '確認ファイル "' + v.sampledName + '" に <bldg:Building>/CityModel を検出');
        verified = c; verified._verify = v; break;
      } else {
        console.log('  × 不採用（内容検証）:', v.reason);
      }
    }
  }
  if (!verified) {
    console.error('\n══ ZIP内容の検証に合格したリソースがありません ══');
    console.error('候補はメタデータ上は該当しましたが、ZIP内に建物CityGML（<bldg:Building>/CityModel）を確認できませんでした。');
    console.error('  ・Shapefile/GeoJSON/3D Tiles/OBJ のZIPはこの段階で確実に除外されます。');
    console.error('  ・別候補を試す場合: --resource-index N（--list で確認）');
    console.error('  ・サーバがRange非対応の場合: --no-verify でメタデータ判定のみに切替（非推奨）');
    throw new Error('ZIP内容の検証に合格したリソースがありません');
  }
  console.log('\n══ 採用したリソース（ZIP内容確認済み）══');
  console.log('  name  :', verified.name);
  console.log('  format:', verified.format || '(空)');
  console.log('  size  :', verified.size ? fmtMB(verified.size) : '(不明)');
  console.log('  url   :', verified.url);
  console.log('  score :', verified.score, '/ データセット:', verified.pkg);
  if (verified._verify) console.log('  内容  : GML ' + verified._verify.gmlCount + ' 件 / 建物タグ確認 "' + verified._verify.sampledName + '"');
  return { url: verified.url, from: `CKAN検索＋ZIP内容検証（候補${cands.length}件）`, cands };
}

// ══════════════════════════════════════════════════════════
// ダウンロード（再開なし・リトライあり・進捗表示）
// ══════════════════════════════════════════════════════════
async function download(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    console.log('キャッシュ済みアーカイブを使用:', destPath, fmtMB(fs.statSync(destPath).size));
    return destPath;
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      console.log(`ダウンロード開始 (試行${attempt}/${RETRY}):`, url);
      const res = await fetch(url, { headers: { 'User-Agent': 'LiveCity/1.0 (plateau-fetch)' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      const tmp = destPath + '.part';
      const out = fs.createWriteStream(tmp);
      let received = 0, lastLog = Date.now();
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        if (Date.now() - lastLog > 3000) {
          lastLog = Date.now();
          console.log(`  ${fmtMB(received)}${total ? ' / ' + fmtMB(total) + ` (${(received / total * 100).toFixed(1)}%)` : ''}`);
        }
      }
      await new Promise(r => out.end(r));
      fs.renameSync(tmp, destPath);
      console.log('ダウンロード完了:', fmtMB(received));
      return destPath;
    } catch (e) {
      lastErr = e;
      console.warn('  失敗:', e.message);
      await sleep(RETRY_WAIT_MS * attempt);
    }
  }
  throw new Error('ダウンロードに失敗しました: ' + (lastErr && lastErr.message));
}

// ══════════════════════════════════════════════════════════
// ZIP選択展開（中央ディレクトリを読み、必要エントリだけ部分展開。Zip64対応）
// ══════════════════════════════════════════════════════════
// 中央ディレクトリのバイト列からエントリ一覧を解析する（fd版・リモート版で共通）
function parseCentralDirectory(cd, count) {
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen; const end = e + extraLen;
      while (e + 4 <= end) {
        const hid = cd.readUInt16LE(e), hsz = cd.readUInt16LE(e + 2);
        if (hid === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + hsz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// EOCD/Zip64を解析して中央ディレクトリの位置とエントリ数を返す（tail=末尾バイト列）
function locateCentralDirectory(tail, tailStartOffset, readAbsolute) {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIPのEOCDが見つかりません（壊れているか非ZIP）');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x07064b50) { loc = i; break; }
    }
    if (loc < 0) throw new Error('Zip64ロケータが見つかりません');
    const z64Off = Number(tail.readBigUInt64LE(loc + 8));
    const z64 = readAbsolute(z64Off, 56);
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('Zip64 EOCDが不正です');
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  return { count, cdSize, cdOffset };
}

function readZipEntries(fd, fileSize) {
  // EOCD（End Of Central Directory）を末尾から探索
  const maxBack = Math.min(fileSize, 66000);
  const tail = Buffer.alloc(maxBack);
  fs.readSync(fd, tail, 0, maxBack, fileSize - maxBack);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIPのEOCDが見つかりません（壊れているか非ZIP）');
  const readAbs = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
  const { count, cdSize, cdOffset } = locateCentralDirectory(tail, fileSize - maxBack, readAbs);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  return parseCentralDirectory(cd, count);
}

function extractEntry(fd, entry, destPath) {
  // ローカルヘッダを読んで実データ開始位置を得る（拡張フィールド長がCDと異なる場合がある）
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, entry.localOffset);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('ローカルヘッダが不正: ' + entry.name);
  const nameLen = lh.readUInt16LE(26), extraLen = lh.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const comp = Buffer.alloc(entry.compSize);
  fs.readSync(fd, comp, 0, entry.compSize, dataStart);
  let data;
  if (entry.method === 0) data = comp;                       // 無圧縮
  else if (entry.method === 8) data = zlib.inflateRawSync(comp); // deflate
  else throw new Error('未対応の圧縮方式 ' + entry.method + ': ' + entry.name);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, data);
  return data.length;
}

// ══════════════════════════════════════════════════════════
// メイン
// ══════════════════════════════════════════════════════════
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args['ckan-base'] === 'string') CKAN_BASE = args['ckan-base'];
  const sourcesPath = args.sources || DEFAULT_SOURCES;
  const sources = loadSources(sourcesPath);
  const cfg = (sources && sources.patterns) || {};
  // パターンは配列で複数候補を持つ（年度・命名規則の変更に備える）。旧形式の単一文字列も受け付ける。
  const toList = (v, def) => (Array.isArray(v) ? v : (typeof v === 'string' ? [v] : def));
  const gmlPatterns = toList(cfg.gmlPatterns || cfg.gmlPattern, ['\\.gml$', '\\.xml$'])
    .map(x => new RegExp(x, 'i'));
  const bldgPatterns = toList(cfg.bldgPatterns || cfg.bldgPattern, ['bldg', 'building', '建築物', '建物'])
    .map(x => new RegExp(x, 'i'));
  const isGml = n => gmlPatterns.some(r => r.test(n));
  const isBldg = n => bldgPatterns.some(r => r.test(n));
  const wardCode = args['ward-code'] ? String(args['ward-code']) : null;

  // ── 診断モード: リソース選択の内訳だけを表示する（取得は行わない）──
  // 保存済みCKANレスポンス(.cache/plateau/ckan-*.json)を指定するか、省略時はライブ検索する。
  if (args.diagnose) {
    const wc = args['ward-code'] ? String(args['ward-code']) : null;
    const cc = String(args['city-code'] || (wc ? wc.slice(0, 3) + '00' : ''));
    let packages = [];
    if (typeof args.diagnose === 'string' && fs.existsSync(args.diagnose)) {
      const j = JSON.parse(fs.readFileSync(args.diagnose, 'utf8'));
      packages = (j.result && j.result.results) || [];
      console.log('保存済みレスポンスを診断:', args.diagnose);
    } else {
      const q = args.query || (cc ? cc : 'PLATEAU');
      const url = `${CKAN_BASE}/package_search?q=${encodeURIComponent(q)}&rows=50`;
      console.log('ライブ検索して診断: q="' + q + '"');
      const j = await httpJson(url);
      saveCkanJson(j, 'diagnose-' + q, args.cache || '.cache/plateau');
      packages = (j.result && j.result.results) || [];
    }
    console.log('データセット数:', packages.length);
    let anyEligible = null;
    for (const pkg of packages) {
      const resources = pkg.resources || [];
      const pe = evaluatePackage(pkg, cc, null);
      console.log('\n═══ データセット: ' + (pkg.title || pkg.name) + ' ═══');
      console.log('  package判定:', pe.eligible ? '採用 score=' + pe.score + ' / ' + pe.reasons.join(' / ') : '除外: ' + pe.rejectReason);
      console.log('  リソース数:', resources.length);
      if (!pe.eligible) { console.log('  （package段階で除外されたためリソース評価は行いません）'); continue; }
      // このデータセット内にCityGMLリソースが存在するかを明示
      const cityGmlHere = resources.filter(r => {
        const h = ((r.name || '') + ' ' + (r.description || '') + ' ' + (r.url || '') + ' ' + (r.format || '')).toLowerCase();
        return RE_CITYGML.test(h) || RE_GML.test(h);
      });
      console.log('  CityGML/GMLを示すリソース:', cityGmlHere.length, '件',
        cityGmlHere.length ? '→ ' + cityGmlHere.map(r => r.name).join(' , ') : '（このデータセットには存在しない）');
      for (const r of resources) {
        const ev = evaluateResource(r, pkg, cc);
        console.log('\n  ── リソース ──');
        console.log('    name       :', r.name || '(無名)');
        console.log('    format     :', r.format || '(空)');
        console.log('    description:', (r.description || '(空)').slice(0, 120));
        console.log('    url        :', r.url || '(空)');
        console.log('    size       :', r.size ? fmtMB(r.size) : '(不明)');
        console.log('    判定       :', ev.eligible ? '採用可 score=' + ev.score : '不採用');
        console.log('    理由       :', ev.eligible ? ev.reasons.join(' / ') : ev.rejectReason);
        if (ev.eligible && (!anyEligible || ev.score > anyEligible.score)) anyEligible = { r, score: ev.score, pkg: pkg.title };
      }
    }
    console.log('\n═══ 診断結果 ═══');
    if (anyEligible) {
      console.log('この条件で採用されるリソース:');
      console.log('  name  :', anyEligible.r.name);
      console.log('  format:', anyEligible.r.format || '(空)');
      console.log('  url   :', anyEligible.r.url);
      console.log('  score :', anyEligible.score, '/ データセット:', anyEligible.pkg);
    } else {
      console.log('採用可能なリソースがありません。上の不採用理由を確認してください。');
    }
    return;
  }

  if (args.list && !args.dataset) {
    await resolveUrl({ ...args, list: true }, sources);
    return;
  }
  const datasetId = args.dataset;
  if (!datasetId) {
    console.error('usage: node tools/fetch-plateau.js --dataset <id> [--ward-code 27121] [--city-code 27100]');
    console.error('       [--url <zip url>] [--out data/raw/<id>] [--cache .cache/plateau] [--keep-archive] [--ckan-base <url>] [--query <検索語>] [--resource-index N] [--dry-run] [--list] [--force] [--diagnose [saved.json]] [--no-verify]');
    process.exit(1);
  }
  // 明示指定 > LIVECITY_DATA_ROOT配下。旧data/raw等は使わない（setup-area側が後方互換を扱う）。
  const dp = dataPaths(args, datasetId);
  const outDir = args.out || dp.datasetRaw;
  const cacheDir = args.cache || dp.archives;

  // 既に展開済みなら再取得しない（setup-area.jsから何度呼んでも安全）
  if (!args.force && fs.existsSync(outDir)) {
    const existing = fs.readdirSync(outDir).filter(f => isGml(f));
    if (existing.length) {
      console.log('取得済みのGMLが存在するためスキップ:', outDir, `(${existing.length}ファイル)`);
      console.log('再取得する場合は --force を付けてください。');
      return;
    }
  }

  const resolved = await resolveUrl(args, sources);
  if (!resolved.url) return; // --list のみ
  console.log('取得元:', resolved.from);
  console.log('URL:', resolved.url);

  if (args['dry-run']) {
    console.log('--dry-run のため取得は行いません。');
    console.log('計画: ダウンロード → ZIP走査 → ' + (wardCode ? `区コード ${wardCode} を含むGMLのみ` : '全建物GML') + ' を ' + outDir + ' へ展開');
    return;
  }

  const archivePath = path.join(cacheDir, path.basename(new URL(resolved.url).pathname) || (datasetId + '.zip'));
  await download(resolved.url, archivePath);

  // ── ZIP走査 → 建物GMLの自動検出（入れ子ZIPにも対応）──
  // 検出方針（固定文字列に依存しない）:
  //   ① GML拡張子 かつ bldg/Building/建築物 のいずれかを含むパス
  //   ② GML拡張子のもの全部（命名規則が変わった場合のフォールバック）
  //   ③ ①②が0件なら、ZIP内のZIPを展開して同じ判定を再帰適用（PLATEAUの入れ子配布に対応）
  function analyze(entries, label) {
    console.log(`\n[${label}] エントリ数: ${entries.length}`);
    const extHist = {};
    const topDirs = {};
    for (const e of entries) {
      const ext = (e.name.match(/\.([A-Za-z0-9]+)$/) || [null, '(なし)'])[1].toLowerCase();
      extHist[ext] = (extHist[ext] || 0) + 1;
      const top = e.name.split('/')[0] || '(ルート)';
      topDirs[top] = (topDirs[top] || 0) + 1;
    }
    console.log('  拡張子の内訳:', JSON.stringify(extHist));
    console.log('  最上位ディレクトリ:', JSON.stringify(topDirs));
    const show = entries.slice(0, 40);
    console.log('  ファイル一覧（先頭' + show.length + '件 / 全' + entries.length + '件）:');
    for (const e of show) console.log('    ' + e.name + '  (' + (e.uncompSize ? fmtMB(e.uncompSize) : '0MB') + ')');
    if (entries.length > show.length) console.log('    … 他 ' + (entries.length - show.length) + ' 件');
  }

  function selectTargets(entries, label) {
    const gmls = entries.filter(e => isGml(e.name));
    const bldgGmls = gmls.filter(e => isBldg(e.name));
    console.log(`  [${label}] GML該当: ${gmls.length} 件 / うち建物パターン該当: ${bldgGmls.length} 件`);
    if (bldgGmls.length) {
      console.log('  → 建物GMLとして採用:', bldgGmls.length, '件');
      return bldgGmls;
    }
    if (gmls.length) {
      console.log('  → 建物パターン不一致のため、全GMLを対象にします（命名規則変更の可能性）');
      console.log('     不一致だったパターン:', bldgPatterns.map(r => r.source).join(' | '));
      console.log('     GMLの例:', gmls.slice(0, 5).map(e => path.basename(e.name)).join(', '));
      return gmls;
    }
    console.log('  → GMLが0件。GML判定パターン:', gmlPatterns.map(r => r.source).join(' | '));
    return [];
  }

  // 展開対象を {archivePath, entry} の配列で集める（入れ子ZIP由来も同じ形で扱う）
  const collected = [];
  const openFds = new Map(); // archivePath → fd
  const getFd = ap => { if (!openFds.has(ap)) openFds.set(ap, fs.openSync(ap, 'r')); return openFds.get(ap); };
  const nestedTemp = path.join(cacheDir, 'nested-' + datasetId);

  function scanArchive(ap, label, depth) {
    const fd0 = getFd(ap);
    const sz = fs.statSync(ap).size;
    let ents;
    try { ents = readZipEntries(fd0, sz); }
    catch (e) { console.warn(`  [${label}] ZIP解析に失敗: ${e.message}`); return; }
    analyze(ents, label);
    const t = selectTargets(ents, label);
    for (const e of t) collected.push({ archivePath: ap, entry: e });
    if (t.length || depth >= 2) return;

    // ③ 入れ子ZIPを探索
    const innerZips = ents.filter(e => /\.(zip|7z)$/i.test(e.name));
    if (!innerZips.length) { console.log(`  [${label}] 入れ子アーカイブもありません`); return; }
    console.log(`  [${label}] 入れ子アーカイブを検出: ${innerZips.length} 件 → 展開して再探索します`);
    fs.mkdirSync(nestedTemp, { recursive: true });
    for (const iz of innerZips) {
      if (/\.7z$/i.test(iz.name)) { console.warn('    7z形式は未対応のためスキップ:', iz.name); continue; }
      const dest = path.join(nestedTemp, path.basename(iz.name));
      try {
        extractEntry(fd0, iz, dest);
        console.log('    展開:', iz.name, '→', fmtMB(fs.statSync(dest).size));
        scanArchive(dest, path.basename(iz.name), depth + 1);
        if (collected.length) break; // 目的のGMLが見つかったら以降の入れ子は開かない
      } catch (err) {
        console.warn('    入れ子ZIPの展開に失敗:', iz.name, err.message);
      }
    }
  }

  scanArchive(archivePath, path.basename(archivePath), 0);

  if (!collected.length) {
    for (const fd0 of openFds.values()) { try { fs.closeSync(fd0); } catch (e) {} }
    try { fs.rmSync(nestedTemp, { recursive: true, force: true }); } catch (e) {}
    console.error('\n══ ZIP内に建物GMLが見つかりませんでした ══');
    console.error('上のファイル一覧と拡張子内訳を確認してください。対処:');
    console.error('  ① ' + sourcesPath + ' の patterns.gmlPatterns / patterns.bldgPatterns に候補を追加');
    console.error('     例: "gmlPatterns": ["\\\\.gml$", "\\\\.xml$"], "bldgPatterns": ["bldg", "building", "建築物"]');
    console.error('  ② 別のリソースを選択: --resource-index N（--list で候補確認）');
    console.error('  ③ 建物モデルを含むZIPを --url で直接指定');
    process.exit(1);
  }
  console.log('\n展開対象の建物GML:', collected.length, '件');

  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(cacheDir, 'tmp-' + datasetId);
  fs.mkdirSync(tmpDir, { recursive: true });
  let kept = 0, skipped = 0, totalBytes = 0;
  for (const item of collected) {
    const e = item.entry;
    const base = path.basename(e.name);
    const tmpPath = path.join(tmpDir, base);
    let bytes;
    try { bytes = extractEntry(getFd(item.archivePath), e, tmpPath); }
    catch (err) { console.warn('  展開失敗:', base, err.message); continue; }
    // ── 区の絞り込み: ファイル名ではなく内容に区コードが含まれるかで判定 ──
    if (wardCode) {
      const head = fs.readFileSync(tmpPath, 'utf8');
      if (!head.includes(wardCode)) {
        fs.unlinkSync(tmpPath);
        skipped++;
        continue;
      }
    }
    fs.renameSync(tmpPath, path.join(outDir, base));
    kept++; totalBytes += bytes;
  }
  for (const fd0 of openFds.values()) { try { fs.closeSync(fd0); } catch (e) {} }

  // ── 一時ファイル削除 ──
  try { fs.rmSync(nestedTemp, { recursive: true, force: true }); } catch (e) { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
  if (!args['keep-archive']) {
    try { fs.unlinkSync(archivePath); console.log('アーカイブを削除:', archivePath); }
    catch (e) { /* noop */ }
  } else {
    console.log('アーカイブを保持:', archivePath, '(--keep-archive)');
  }

  console.log('展開:', kept, 'ファイル /', fmtMB(totalBytes),
    wardCode ? `（区コード ${wardCode} 不一致で除外: ${skipped}）` : '');
  console.log('出力先:', outDir);
  if (!kept) {
    console.error('区コード ' + wardCode + ' に一致するGMLが0件でした。--ward-code を確認するか、--ward-code なしで全件取得してください。');
    process.exit(1);
  }
  console.log('次: node tools/setup-area.js --dataset ' + datasetId + ' --ward <区名> --citygml ' + outDir);
}

main().catch(e => { console.error('[fetch-plateau] 失敗:', e.message); process.exit(1); });
