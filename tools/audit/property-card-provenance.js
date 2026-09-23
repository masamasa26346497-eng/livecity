#!/usr/bin/env node
// tools/audit/property-card-provenance.js
// [Mission 32S §11/§13] property card の各項目のデータ出所と、仮値生成コードの残存を調べる。
//   §11: Math.random / ハッシュ由来の擬似値 / 賃料・利回り・推定階数・仮メモ を生む記述を全リポジトリから探す
//        （data/raw・node_modules は除外。dev HTML / production・protected / 旧コピー / テスト文字列に分類）
//   §13: card に出す各 field について source / real か derived か / データが実際に何 % 埋まるか を数える
//   出力: data/reports/property-card-provenance.json
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, isMainModule } from '../lib/paths.js';
import { readFileRetry } from '../lib/synced-dir-writer.js';

const P = (...s) => resolveProjectPath(path.join(...s));
const DEV_HTML = 'public/osaka_3d_buildings.ward-ux-v1.html';
const BUILDINGS = P('data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2');
const STATIONS = P('data', 'processed', 'osaka-city', 'canonical', 'rail', 'stations.json');
const OUT = P('data', 'reports', 'property-card-provenance.json');
const FACTS_REPORT = P('data', 'reports', 'building-source-facts.json');
const rj = (p) => JSON.parse(readFileRetry(p));

// 仮値を生みうる記述（§11）
export const FAKE_PATTERNS = [
  { id: 'math-random', re: /Math\.random\s*\(/ },
  { id: 'pseudo-random-hash', re: /pseudoRand\s*\(/ },
  { id: 'estimate-floors', re: /estimateFloors\s*\(/ },
  { id: 'estimate-rent', re: /estimateRentPerTsubo\s*\(/ },
  { id: 'yield-rate', re: /yieldRate/ },
  { id: 'rent-value', re: /rentLow|rentHigh|rentBase/ },
  { id: 'label-rent', re: /想定賃料/ },
  { id: 'label-yield', re: /推定利回り/ },
  { id: 'label-floors', re: /推定階数/ },
  { id: 'auto-memo', re: /const memos\s*=|pc-memo'\)\.textContent = p\.memo/ },
];
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);
const SKIP_PREFIX = ['data/raw/'];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.md', '.css']);

export function classifyFile(rel) {
  if (rel === DEV_HTML) return 'dev-html（今回の対象）';
  if (/^public\/osaka_3d_buildings(\.fullward-v3)?\.html$/.test(rel)) return 'production-or-protected-html（変更禁止）';
  if (/^public\/.*\.html$/.test(rel) || /^(temp|backup|handoff|livecity)\//.test(rel)) return 'archived-html-copy（旧コピー）';
  if (/^(tests|tools)\//.test(rel)) return 'tool-or-test';
  if (/^data\/reports\//.test(rel) || /^MISSION.*\.md$/.test(rel)) return 'report-record';
  return 'other';
}
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = toProjectRelativePath(p).replace(/\\/g, '/');
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_PREFIX.some((s) => (rel + '/').startsWith(s))) yield* walk(p); }
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && !/-DESKTOP-/.test(e.name) && !/property-card-provenance/.test(e.name)) yield { p, rel };
  }
}
export function scanFakeValueCode() {
  const hits = [];
  for (const { p, rel } of walk(resolveProjectPath('.'))) {
    if (fs.statSync(p).size > 16 * 1024 * 1024) continue;
    const t = fs.readFileSync(p, 'utf-8');
    if (!FAKE_PATTERNS.some((f) => f.re.test(t))) continue;
    t.split(/\r?\n/).forEach((line, i) => {
      for (const f of FAKE_PATTERNS) if (f.re.test(line)) hits.push({ file: rel, line: i + 1, pattern: f.id, cls: classifyFile(rel), text: line.trim().slice(0, 140) });
    });
  }
  return hits;
}

/** canonical 建物属性から、card の各項目がどれだけ実データで埋まるかを数える */
export function fieldAvailability() {
  const n = { total: 0, usageLabel: 0, usageCode: 0, heightM: 0, heightPlateau: 0, heightOsmMeasured: 0, heightDefault: 0, heightUnknownFlag: 0, plateauHeightExactly3m: 0, wardId: 0, levels: 0 };
  for (const f of fs.readdirSync(BUILDINGS)) {
    if (!/^tile_-?\d+_-?\d+\.json$/.test(f)) continue;
    const a = rj(path.join(BUILDINGS, 'attributes', f)).attributes;
    for (const k in a) {
      const x = a[k]; n.total++;
      if (x.usageLabel) n.usageLabel++;
      if (x.usage != null && x.usage !== '') n.usageCode++;
      if (Number.isFinite(x.heightM)) n.heightM++;
      if (x.heightSource === 'plateau') n.heightPlateau++;
      else if (x.heightSource === 'osm-height' || x.heightSource === 'osm-levels') n.heightOsmMeasured++;
      else n.heightDefault++;
      if (x.heightUnknown) n.heightUnknownFlag++;
      if (x.source === 'plateau-building' && x.heightM === 3) n.plateauHeightExactly3m++;
      if (x.wardId) n.wardId++;
      if (x.levels != null) n.levels++;
    }
  }
  return n;
}

export function buildProvenance(avail, stations, facts) {
  const pc = (x) => +(100 * x / avail.total).toFixed(2);
  return [
    { field: '用途（バッジ / 用途行）', element: 'pc-usage-badge / pc-usage-full', source: 'canonical attributes.usageLabel・usage（PLATEAU bldg:usage コード / OSM building タグ）', kind: 'real', availabilityPct: pc(avail.usageLabel), note: 'PLATEAU はコード（例 461=事務所）を併記。OSM 由来は building タグの分類' },
    { field: '高さ', element: 'pc-height（pc-height-stat）', source: 'canonical attributes.heightM + building-facts tile の heightBasis（生 CityGML の bldg:measuredHeight / LOD 形状 / OSM の height・building:levels タグ）', kind: 'real（実測の裏付けがあるものだけ表示）', availabilityPct: pc(facts.byBasis[1] + facts.byBasis[2] + facts.byBasis[4]), note: `内訳: measuredHeight ${facts.byBasis[1]} / LOD 形状の標高差 ${facts.byBasis[2]} / OSM タグ ${facts.byBasis[4]}。非表示にしたのは「階数×3.0m の換算」${facts.byBasis[3]} 棟 と「根拠なし（変換時の既定値）」${facts.byBasis[0]} 棟` },
    { field: '階数', element: 'pc-floors（pc-floors-stat）', source: '生 CityGML の bldg:storeysAboveGround（building-facts tile 経由）', kind: 'real', availabilityPct: pc(facts.withStoreys), note: `9999 等のセンチネル値と OSM 由来は 0 として扱い、行ごと非表示。高さからの推定は行わない（§3/§10）` },
    { field: '底面積', element: 'pc-area', source: 'canonical geometry（footprint の面積をその場で計算）', kind: 'real（幾何から計算）', availabilityPct: 100, note: '表示は m²。丸めのみ' },
    { field: '区', element: 'pc-ward', source: 'canonical attributes.wardId（N03 2026 の区界で判定）', kind: 'real', availabilityPct: pc(avail.wardId), note: '区界の外（232 棟）は行ごと非表示' },
    { field: '最寄駅・直線距離', element: 'pc-station', source: `canonical rail stations（${stations} 駅）と建物重心の world 距離`, kind: 'derived（実データ間の距離計算）', availabilityPct: null, note: '徒歩時間は出さない。OSM 抽出の北端（34.74°）より外は「駅データ未整備」' },
    { field: '建物 ID', element: 'pc-id', source: 'canonical canonicalId', kind: 'real', availabilityPct: 100, note: '開発用。production では非表示にできる（§9）' },
    { field: '町丁目データ（地価・人口・年齢・地域統計・生活）', element: 'pc-town-section', source: '旧 3 区の町丁目マスタ（LEGACY_TOWN_DATA_UNVERIFIED）＋ osaka-sumiyoshi の人口・施設データ', kind: 'real（ただし対象は旧 3 区のみ）', availabilityPct: 0, note: 'canonical 建物は町丁目を持たないため section ごと非表示（§7）' },
    { field: '推定階数（高さ ÷ 3.2m）', element: '（削除）', source: '無し', kind: 'removed', availabilityPct: 0, note: `高さ ÷ 3.2m の推定だった。canonical には階数が 1 件も無い（levels 非 null ${avail.levels} 件）。代わりに生 CityGML の bldg:storeysAboveGround を building-facts tile として作り直し、実値がある ${facts.withStoreys} 棟にだけ「階数」を出す（§3）` },
    { field: '推定利回り', element: '（削除）', source: '無し', kind: 'removed', availabilityPct: 0, note: '建物 ID のハッシュから生成していた。価格・費用の実データが無いため削除（§4）' },
    { field: '想定賃料（月）', element: '（削除）', source: '無し', kind: 'removed', availabilityPct: 0, note: '用途別の仮単価 × 面積 × ハッシュ係数だった。実賃料データが無いため削除（§5）' },
    { field: 'メモ', element: '（削除）', source: '無し', kind: 'removed', availabilityPct: 0, note: '定型文 6 種からハッシュで選んでいた。実際の入力が無いため削除（§6）' },
  ];
}

async function main() {
  const hits = scanFakeValueCode();
  const avail = fieldAvailability();
  const stations = rj(STATIONS).stations.length;
  const facts = rj(FACTS_REPORT).stat;
  const byClass = {}, byPattern = {};
  for (const h of hits) { byClass[h.cls] = (byClass[h.cls] || 0) + 1; byPattern[h.pattern] = (byPattern[h.pattern] || 0) + 1; }
  const devHits = hits.filter((h) => h.cls.startsWith('dev-html'));
  const out = {
    version: 1, generatedAt: new Date().toISOString(), missionId: '32S',
    fakeValueScan: { patterns: FAKE_PATTERNS.map((f) => f.id), total: hits.length, byClass, byPattern, devHtmlHits: devHits, hits },
    buildingAttributes: avail, stationCount: stations, buildingSourceFacts: facts,
    provenance: buildProvenance(avail, stations, facts),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (isMainModule(import.meta.url)) {
  main().then((o) => {
    console.log('[provenance] fake-value scan', JSON.stringify({ total: o.fakeValueScan.total, byClass: o.fakeValueScan.byClass, dev: o.fakeValueScan.devHtmlHits.length }));
    for (const h of o.fakeValueScan.devHtmlHits) console.log('   dev:', h.line, h.pattern, h.text);
    console.log('[provenance] attributes', JSON.stringify(o.buildingAttributes));
    for (const p of o.provenance) console.log('  ', p.kind === 'removed' ? '✗' : '✓', p.field, '|', p.source, '|', p.availabilityPct);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
