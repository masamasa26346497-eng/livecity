// tests/production-data-integrity.test.js
// [Mission 32S] PRODUCTION DATA INTEGRITY CLEANUP
//   property card から仮値（推定階数 / 推定利回り / 想定賃料 / 自動メモ / 町丁目データなし）を消し、
//   高さは実測の裏付けがあるときだけ、階数は PLATEAU の実属性があるときだけ出す。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { factOf, HEIGHT_BASIS } from '../tools/build-building-source-facts.js';
import { stripComments } from '../tools/validate/production-data-integrity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const code = stripComments(html);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');

test('[32S §1/§4/§5/§6] 仮値の生成コードと DOM が残っていない', () => {
  for (const re of [/function pseudoRand\(/, /function estimateFloors\(/, /function estimateRentPerTsubo\(/, /function fmtYen\(/, /yieldRate/, /rentLow/, /rentHigh/, /const memos\s*=/]) {
    assert.doesNotMatch(code, re, String(re));
  }
  for (const re of [/id="pc-yield"/, /id="pc-rent"/, /id="pc-memo"/, /pc-disclaimer/, /推定利回り/, /想定賃料/, /推定階数/]) {
    assert.doesNotMatch(code, re, String(re));
  }
  // card が出すのは実データのある項目だけ
  assert.match(html, /<div class="pc-stat" id="pc-height-stat">/);
  assert.match(html, /<div class="pc-stat" id="pc-floors-stat">/);
  assert.match(html, /<div class="pc-row" id="pc-ward-row">/);
  assert.match(html, /function buildPropertyData\(d\)\{[\s\S]{0,200}return \{ area: calcArea\(d\.fp\) \};/);
});

test('[32S §7] 町丁目データが無ければ section ごと非表示（「データなし」と並べない）', () => {
  assert.match(html, /const townSection = document\.getElementById\('pc-town-section'\);/);
  assert.match(html, /townSection\.style\.display = t \? '' : 'none';/);
  assert.doesNotMatch(code, /textContent = townKey \|\| 'データなし'/);
});

test('[32S §3] 高さの出所判定は変換器と同じ順序（measuredHeight → LOD 形状 → 階数×3.0m → 既定値）', () => {
  const plateau = (heightM) => ({ source: 'plateau-building', heightM });
  // measuredHeight があれば実測
  assert.deepEqual(factOf(plateau(24.3), { m: 24.3, s: 8 }), { basis: HEIGHT_BASIS.measured, storeys: 8 });
  // measuredHeight が無く、高さが 階数×3.0m と一致するなら階数由来（高さは出さない）
  assert.deepEqual(factOf(plateau(24), { m: null, s: 8 }), { basis: HEIGHT_BASIS.storeys, storeys: 8 });
  // measuredHeight も階数も無く、高さがちょうど 3.0m なら変換時の既定値（根拠なし）
  assert.deepEqual(factOf(plateau(3), { m: null, s: null }), { basis: HEIGHT_BASIS.none, storeys: 0 });
  // それ以外は LOD 形状の標高差
  assert.deepEqual(factOf(plateau(7.4), { m: null, s: null }), { basis: HEIGHT_BASIS.geometry, storeys: 0 });
  // センチネル（9999 階 / 負の measuredHeight）は実データとして扱わない
  assert.deepEqual(factOf(plateau(3), { m: -9999, s: 9999 }), { basis: HEIGHT_BASIS.none, storeys: 0 });
  // OSM fallback: タグ由来なら表示可、既定値なら根拠なし
  assert.deepEqual(factOf({ source: 'osm-building', heightM: 12, heightUnknown: false }), { basis: HEIGHT_BASIS.osmTag, storeys: 0 });
  assert.deepEqual(factOf({ source: 'osm-building', heightM: 9, heightUnknown: true }), { basis: HEIGHT_BASIS.none, storeys: 0 });
});

test('[32S §2/§3] BuildingFacts は表示中 namespace の facts tile を引き、根拠のある高さだけ許可する', async () => {
  const s = html.indexOf('const BuildingFacts = (function () {');
  const e = html.indexOf('function footprintCentroid(fp) {');
  assert.ok(s > 0 && e > s);
  const fetched = [];
  const ctx = {
    Promise, Math, Map, Object, JSON, console,
    CanonicalRuntime: { getBuildingDataBase: () => 'map-data/osaka-city/derived-v2-osmv2' },
    fetch: async (u) => { fetched.push(u); return { ok: true, json: async () => ({ facts: { 'cg_bldg_a': [1, 5], 'cg_bldg_b': [0], 'cg_bldg_c': [3, 9] } }) }; },
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(s, e) + '; this.BF = BuildingFacts; this.hm = heightIsMeasured;', ctx);
  assert.equal(ctx.BF.tileKey(-2668, -10941), '-6_-22');
  await ctx.BF.ensure(-2668, -10941);
  assert.equal(JSON.stringify(fetched), JSON.stringify(['map-data/osaka-city/derived-v2-osmv2/building-facts/tile_-6_-22.json']));
  await ctx.BF.ensure(-2600, -10900);   // 同じ tile は 2 度取らない
  assert.equal(fetched.length, 1);
  // vm の別 realm から返るので JSON で比較する
  assert.equal(JSON.stringify(ctx.BF.get('cg_bldg_a')), JSON.stringify({ basis: 1, storeys: 5 }));
  assert.equal(JSON.stringify(ctx.BF.get('cg_bldg_b')), JSON.stringify({ basis: 0, storeys: 0 }));
  assert.equal(JSON.stringify(ctx.BF.get('cg_bldg_c')), JSON.stringify({ basis: 3, storeys: 9 }));
  assert.equal(ctx.BF.get('cg_bldg_zzz'), null);
  // 実測（measuredHeight / LOD 形状 / OSM タグ）だけ高さを出す
  assert.equal(JSON.stringify([0, 1, 2, 3, 4].map(ctx.hm)), JSON.stringify([false, true, true, false, true]));
  // namespace を切り替えたら別の facts を引く（V1 には facts が無いので高さは出ない）
  ctx.CanonicalRuntime.getBuildingDataBase = () => 'map-data/osaka-city/derived';
  assert.equal(ctx.BF.get('cg_bldg_a'), null);
  assert.equal(ctx.BF.has('cg_bldg_a'), false);
});

test('[32S §2/§3] showPropertyCard は facts に従って高さ・階数を出し分ける', () => {
  assert.match(html, /applyBuildingFacts\(d\);/);
  assert.match(html, /const showHeight = basis != null && heightIsMeasured\(basis\) && typeof d\.h === 'number';/);
  assert.match(html, /floorsStat\.style\.display = storeys \? '' : 'none';/);
  // 高さから階数を作らない
  assert.doesNotMatch(code, /Math\.round\(dz\s*\/\s*3\.2\)/);
});

test('[32S §13] building-facts が canonical の全建物をカバーする', { skip: skip('building-source-facts.json') }, () => {
  const f = rpt('building-source-facts.json');
  const manifest = rj(path.join(ROOT, 'data', 'processed', 'osaka-city', 'canonical', 'buildings-v2-osmv2', 'manifest.json'));
  assert.equal(f.stat.buildings, manifest.featureCount);
  assert.equal(f.stat.plateau + f.stat.osm, f.stat.buildings);
  const sum = Object.values(f.stat.byBasis).reduce((a, b) => a + b, 0);
  assert.equal(sum, f.stat.buildings);
  // 公開側にも同数の tile がある
  const pub = path.join(ROOT, 'public', 'map-data', 'osaka-city', 'derived-v2-osmv2', 'building-facts');
  assert.equal(fs.readdirSync(pub).filter((n) => /^tile_-?\d+_-?\d+\.json$/.test(n)).length, f.stat.tiles);
});

test('[32S §2/§8] hover の「建物属性」も実測の裏付けがある高さだけ出す', () => {
  assert.match(html, /const showH = tipBasis != null && heightIsMeasured\(tipBasis\) && typeof d\.h === 'number';/);
  assert.match(html, /document\.getElementById\('tr2'\)\.style\.display = showH \? '' : 'none';/);
});

test('[32S §12] 実ブラウザ QA: 6 地点の card に仮値が出ない', { skip: skip('production-data-integrity-qa.json') }, () => {
  const qa = rpt('production-data-integrity-qa.json');
  assert.equal(qa.sites.length, 6);
  for (const s of qa.sites) {
    assert.deepEqual(s.plateau.forbiddenTextHits, [], s.site);
    assert.equal(s.plateau.cardDisplay, 'block', s.site);
    assert.equal(s.plateau.townSectionDisplay, 'none', s.site);
    assert.deepEqual(s.plateau.missingElements, ['pc-yield', 'pc-rent', 'pc-memo'], s.site);
    // hover tooltip も facts が届いたあとは実測の高さだけを出す
    assert.ok(s.plateau.tipAfter && /建物属性/.test(s.plateau.tipAfter.text), s.site);
  }
  assert.deepEqual(qa.consoleErrors, []);
});

test('[32S §14] validator が PASS', { skip: skip('production-data-integrity-validation.json') }, () => {
  const v = rpt('production-data-integrity-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'PRODUCTION_DATA_INTEGRITY_READY');
  for (const k of ['fakeYieldVisible', 'fakeRentVisible', 'fakeNoteVisible', 'fakeFloorCountVisible', 'unsupportedTownChomeVisible', 'productionModified', 'protectedModified']) {
    assert.equal(v[k], false, k);
  }
  assert.equal(v.propertyCardFieldsHaveRealSource, true);
  for (const k of ['buildingV2Mutation', 'roadV3Mutation', 'projectionMutation']) assert.equal(v[k], 0, k);
});
