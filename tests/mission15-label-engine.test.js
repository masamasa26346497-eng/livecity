// tests/mission15-label-engine.test.js
// [見た目改善 Mission15] 共通 LabelEngine の HTML 配線 + 実データ検証。
//   ward/station/river/place/park/public_facility を1つの priority queue で collision。
//   lazy sprite + texture cache。Mission14 駅表示を壊さない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT_ROOT } from '../tools/lib/paths.js';

const require = createRequire(import.meta.url);
const { runInlineScript } = require('./_ward-ux-v1-smoke-harness.cjs');
const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');

test('[Mission15] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m15-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission15] LabelEngine が定義され、共通 collision / density cap / grid を持つ', () => {
  assert.ok(/const LabelEngine = \(function \(\) \{/.test(html), 'LabelEngine 未定義');
  assert.ok(/const DENSITY_CAP = \{ far: 34, mid: 78, near: 120 \};/.test(html), 'density cap が無い');
  assert.ok(/const GRID = \{ cols: 8, rows: 6, perCell: 4 \};/.test(html), 'viewport grid が無い');
  assert.ok(/if \(!pinned && visibleIds\.size >= cap\)/.test(html), 'density cap の打ち切りが無い');
  assert.ok(/if \(!pinned && \(cellCount\.get\(cell\) \|\| 0\) >= GRID\.perCell\)/.test(html), 'grid density が無い');
});

test('[Mission15] 全 type を 1 つの queue で: collectCandidates が ward/station/river/park/public_facility/place を集める', () => {
  const cc = html.match(/function collectCandidates\(\) \{[\s\S]*?return out\.map/);
  assert.ok(cc, 'collectCandidates が取れない');
  for (const t of ["type: 'ward'", 'StationLabelLayer.getLabelCandidates', "type: 'river'", "type: 'park'", "type: 'public_facility'", "type: 'place'"]) {
    assert.ok(cc[0].includes(t), `collectCandidates に ${t} が無い`);
  }
  // priority 順に 1 pool でソート
  assert.ok(/pool\.sort\(\(a, z\) => \(z\.c\.priority - a\.c\.priority\)/.test(html), '全候補が1つの priority ソートを通っていない');
});

test('[Mission15] lazy sprite + texture cache: 画面に出ないラベルの Texture を作らない', () => {
  assert.ok(/const texCache = new Map\(\);/.test(html), 'texture cache が無い');
  assert.ok(/if \(texCache\.has\(key\)\) \{ lastStats\.cachedTextures\+\+; return texCache\.get\(key\); \}/.test(html), 'texture 再利用が無い');
  // sprite は visible 判定を通った時だけ getSprite() で生成
  assert.ok(/for \(const p of placed\) \{[\s\S]*?const obj = getSprite\(p\.c\);/.test(html), 'lazy sprite 生成でない（全候補を先に生成している疑い）');
  assert.ok(/lastStats\.createdSprites\+\+;/.test(html), 'createdSprites カウンタが無い');
});

test('[Mission15] river ラベル: 主要7河川、1河川1ラベル（centerline 最長を1本）', () => {
  assert.ok(/const MAJOR_RIVER_NAMES = \['淀川', '大和川', '神崎川', '安治川', '木津川', '寝屋川', '道頓堀川'\];/.test(html));
  assert.ok(/1 河川名につき centerline 弧長が最長の1本だけ残す/.test(html), '河川の name dedup が無い（長大河川を大量複製）');
  assert.ok(/centerlineAnchor\(r\.centerline, 0\.5\)/.test(html), 'river ラベルが centerline 弧長50% でない');
});

test('[Mission15] ward ラベル: N03 polygon の面積加重セントロイド（海・河川へ落ちない）', () => {
  assert.ok(/multiRingCentroid\(rec\.rings\) \|\| rec\.centroid/.test(html), 'ward が面積加重セントロイドを使っていない');
  assert.ok(/pinned: \(w\.id === cur\)/.test(html), 'selected ward の pin が無い');
});

test('[Mission15] park ラベル: LARGE/一部 MEDIUM、SMALL 除外、同名は最大面積の1つ', () => {
  assert.ok(/function getAllParks\(\)/.test(html), 'CityTileLayer.getAllParks が無い');
  assert.ok(/if \(tier === 'small'\) continue;/.test(html), 'SMALL park を除外していない');
  assert.ok(/同名は最大面積の1つだけ/.test(html), 'park の name dedup が無い');
});

test('[Mission15] public_facility: OSM_LABELS の govt/hospital/library + FacilityDataStore public/medical', () => {
  const cc = html.match(/if \(typeEnabled\.public_facility\) \{[\s\S]*?\n    \}/);
  assert.ok(cc, 'public_facility provider が無い');
  assert.ok(/l\.category === 'government'.*'GOVERNMENT'/.test(cc[0]), 'GOVERNMENT 分類が無い');
  assert.ok(/警察\|交番.*'POLICE'/.test(cc[0]) && /消防.*'FIRE'/.test(cc[0]), 'POLICE/FIRE 分類が無い');
  assert.ok(/FacilityDataStore\.getState\(\) === 'ready'/.test(cc[0]), 'FacilityDataStore 連携が無い');
});

test('[Mission15] canonical styles: WARD/PLACE/RIVER/PARK/PUBLIC_FACILITY（派手色・黒ベタ禁止）', () => {
  const s = html.match(/const STYLES = \{[\s\S]*?\n  \};/)[0];
  assert.ok(/ward:\s+\{ font: 17,\s+weight: '650', text: '#46515b'/.test(s), 'WARD style が指定と違う');
  assert.ok(/river:\s+\{ font: 13,\s+weight: '500', text: '#5b8795'[\s\S]*?italic: true/.test(s), 'RIVER style（italic）が違う');
  assert.ok(/park:\s+\{ font: 12,\s+weight: '500', text: '#60775a'/.test(s), 'PARK style が違う');
  assert.ok(/public_facility:\s+\{ font: 12,\s+weight: '500', text: '#59636d'[\s\S]*?bg: 'rgba\(255,255,255,0\.78\)'/.test(s), 'PUBLIC_FACILITY style が違う');
  assert.ok(!/text: '#000000'/.test(s), '黒ベタ text がある');
});

test('[Mission15] Station 後方互換: Mission14 の clustering/dot/style/collision 呼び出しを壊さない', () => {
  // StationLabelLayer の clustering / dot / style は残る
  assert.ok(/const StationLabelLayer = \(function \(\) \{/.test(html));
  assert.ok(/function clusterStations\(stations, radiusM, groupMergeM, sameNameMergeM\)/.test(html), 'clustering が消えた');
  assert.ok(/function makeDotTexture\(style\)/.test(html), 'dot が消えた');
  // LabelEngine が collision 権威、StationLabelLayer は candidate 提供 + applyEngineDecision
  assert.ok(/function getLabelCandidates\(\) \{[\s\S]*?type: 'station'/.test(html), 'getLabelCandidates が無い');
  assert.ok(/function applyEngineDecision\(visibleSet, pxScale\) \{/.test(html), 'applyEngineDecision が無い');
  assert.ok(/if \(typeof LabelEngine !== 'undefined'\) return; \/\/ collision は LabelEngine が担当/.test(html), 'StationLabelLayer が LabelEngine へ委譲していない');
  // 駅名トグル・render loop 配線
  assert.ok(/if \(typeof LabelEngine !== 'undefined'\) LabelEngine\.update\(\);/.test(html), 'render loop に LabelEngine.update() が無い');
});

test('[Mission15] camera dirty + throttle（毎フレーム全件計算しない）', () => {
  assert.ok(/const THROTTLE_MS = 200;/.test(html), 'LabelEngine throttle が無い');
  assert.ok(/if \(!dirty && key === lastKey\) return;/.test(html), 'camera dirty 判定が無い');
  assert.ok(/markDirty\(\) \{ dirty = true; \}/.test(html), 'markDirty が無い（tile 到着で再計算できない）');
});

test('[Mission15 hotfix] render loop でラベル更新が try/catch 隔離されている（各区表示を巻き込まない）', () => {
  assert.ok(/try \{ if \(typeof StationLabelLayer !== 'undefined'\) StationLabelLayer\.update\(\); \} catch/.test(html),
    'StationLabelLayer.update() が try/catch されていない');
  assert.ok(/try \{ if \(typeof LabelEngine !== 'undefined'\) LabelEngine\.update\(\); \} catch/.test(html),
    'LabelEngine.update() が try/catch されていない');
  // place() 内も try/catch
  assert.ok(/try \{ place\(\); \} catch \(e\)/.test(html), 'LabelEngine.place() が try/catch されていない');
  // ward provider は WardModeManager.WARD_DEFS（bare WARD_DEFS はスコープ外）
  assert.ok(/const wardDefsSafe = \(\) => \(typeof WardModeManager !== 'undefined' && WardModeManager\.WARD_DEFS\)/.test(html),
    'ward provider が WardModeManager.WARD_DEFS を使っていない');
  assert.ok(/for \(const w of wardDefsSafe\(\)\)/.test(html), 'ward provider が wardDefsSafe() を使っていない');
  // 各 provider が try/catch で隔離
  assert.equal((html.match(/\} catch \(e\) \{ \/\* \S+ provider 失敗は無視 \*\//g) || []).length, 6, 'provider ごとの try/catch が 6 個ない');
});

test('[Mission15] debug API: __LABEL_DEBUG__ / __LABEL_TYPE_TOGGLE__（実行して確認）', () => {
  assert.ok(/window\.__LABEL_DEBUG__ = \(\) => LabelEngine\.getDebug\(\);/.test(html));
  assert.ok(/window\.__LABEL_TYPE_TOGGLE__ = \(type, on\) => LabelEngine\.setTypeEnabled\(type, on !== false\);/.test(html));
  const r = runInlineScript(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'));
  assert.ok(r.ok, 'inline script が throw');
  const d = r.window.__LABEL_DEBUG__();
  for (const k of ['totalCandidates', 'byType', 'band', 'visibleLabels', 'hiddenByLOD', 'hiddenByViewport', 'hiddenByCollision', 'hiddenByDensityCap', 'hiddenByGrid', 'createdSprites', 'createdTextures', 'cachedTextures', 'visibleNames']) {
    assert.ok(k in d, `__LABEL_DEBUG__ に ${k} が無い`);
  }
  // stub 環境では OSM_LABELS 由来の public_facility 6 件が候補になる
  assert.ok(d.byType.public_facility >= 5, `public_facility 候補=${d.byType.public_facility}`);
  const t = r.window.__LABEL_TYPE_TOGGLE__('public_facility', false);
  assert.equal(t.public_facility, false, 'type toggle が効かない');
});

test('[Mission15] 実データ validator: 候補が finite/name/type/priority 正常、24区・7河川 coverage', () => {
  const out = execFileSync('node', ['tools/validate/map-labels.js'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  assert.ok(/RESULT: PASS/.test(out), 'map-labels validator が FAIL:\n' + out.slice(-800));
  assert.ok(/ward=24/.test(out), '24区 coverage でない');
  assert.ok(/major river coverage=7\/7/.test(out), '7河川 coverage でない');
});

test('[Mission15] 他ミッション成果を壊していない', () => {
  assert.ok(/const RAIL_COLORS = \{ major: 0x8f969d/.test(html), 'Mission13 rail 色');
  assert.ok(/const MS_PARK_GREEN = 0xcfe3c7;/.test(html), 'Mission12 公園色');
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川色');
  assert.ok(/const CITY_CAMERA_PRESET = \{/.test(html), 'Mission16 camera preset');
  assert.ok(/window\.__STATION_LABEL_DEBUG__/.test(html), 'Mission14 駅 debug API');
});

test('[Mission15] protected / production 無変更', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/LabelEngine|__LABEL_DEBUG__|collectCandidates/.test(fw), 'fullward-v3.html に Mission15 の変更が混入');
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(!/LabelEngine|__LABEL_DEBUG__/.test(prod), 'production HTML に Mission15 の変更が混入');
});
