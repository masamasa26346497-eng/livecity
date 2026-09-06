// tests/mission14-station-label.test.js
// [見た目改善 Mission14] 駅ラベルの HTML 配線 + 実データ検証。
//   StationLabelLayer: clustering + importance + FAR/MID/NEAR LOD + screen-space collision + throttle。
//   既存 Sprite+CanvasTexture パターンを再利用。station y > rail y。protected/production 無変更。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../tools/lib/paths.js';
import { clusterStations, classifyStationImportance } from '../tools/lib/station-cluster.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html'), 'utf-8');
const RAIL_DIR = path.join(PROJECT_ROOT, 'public', 'map-data', 'osaka-city', 'railways');

function loadRail() {
  const st = new Map(), ln = new Map();
  for (const f of fs.readdirSync(RAIL_DIR).filter((n) => /^tile_.*\.json$/.test(n))) {
    const tile = JSON.parse(fs.readFileSync(path.join(RAIL_DIR, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (ft.kind === 'station' && ft.p && ft.p[0] && !st.has(ft.id)) st.set(ft.id, { id: ft.id, name: ft.name || '', x: ft.p[0][0], z: ft.p[0][1] });
      else if (ft.kind === 'line' && ft.p && !ln.has(ft.id)) ln.set(ft.id, { id: ft.id, railway: ft.railway, p: ft.p });
    }
  }
  return { stations: [...st.values()], lines: [...ln.values()] };
}
const nearbyOf = (lines) => (c) => {
  const R = 250, rail = new Set(), sub = new Set();
  for (const l of lines) { let hit = false; for (const p of l.p) { if (Math.hypot(p[0] - c.x, p[1] - c.z) < R) { hit = true; break; } } if (hit) { if (l.railway === 'subway') sub.add(l.id); else if (l.railway !== 'light_rail') rail.add(l.id); } }
  return { railWays: rail.size, subwayWays: sub.size };
};

test('[Mission14] ward-ux-v1.html: インライン <script> の JS 構文が壊れていない', () => {
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  const f = path.join(os.tmpdir(), `m14-${process.pid}.js`);
  fs.writeFileSync(f, m[1]);
  try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } finally { try { fs.unlinkSync(f); } catch { /* noop */ } }
});

test('[Mission14] 実データ: 233 station → cluster 後は大幅減、MAJOR は 10〜25', () => {
  const { stations, lines } = loadRail();
  assert.ok(stations.length >= 200 && stations.length <= 260, `raw station=${stations.length}`);
  const clusters = clusterStations(stations, {});
  assert.ok(clusters.length < stations.length * 0.85, `clustering 効果が薄い: ${clusters.length}/${stations.length}`);
  const near = nearbyOf(lines);
  const cnt = { major: 0, medium: 0, local: 0 };
  for (const c of clusters) cnt[classifyStationImportance(c, near(c))]++;
  assert.ok(cnt.major >= 10 && cnt.major <= 25, `MAJOR=${cnt.major}（FAR 表示上限の範囲）`);
  assert.ok(cnt.major + cnt.medium >= 30, `MID pool (major+medium)=${cnt.major + cnt.medium}`);
});

test('[Mission14] 実データ: 大阪・梅田 / なんば / 天王寺 が MAJOR で1ラベルに統合', () => {
  const { stations, lines } = loadRail();
  const clusters = clusterStations(stations, {});
  const near = nearbyOf(lines);
  for (const label of ['大阪・梅田', 'なんば', '天王寺', '京橋', '鶴橋']) {
    const c = clusters.filter((x) => x.label === label);
    assert.equal(c.length, 1, `${label} が ${c.length} クラスタ（1に統合されていない）`);
    assert.equal(classifyStationImportance(c[0], near(c[0])), 'major', `${label} が major でない`);
  }
});

test('[Mission14] 実データ: 重複 canonical label は既知の別駅（中津/野江/平野/今里 等）のみ', () => {
  const { stations } = loadRail();
  const clusters = clusterStations(stations, {});
  const lc = {};
  for (const c of clusters) lc[c.label] = (lc[c.label] || 0) + 1;
  const KNOWN = new Set(['中津', '野田', '平野', '今里', '九条', '野江']);
  for (const [label, n] of Object.entries(lc)) {
    if (n > 1) assert.ok(KNOWN.has(label), `想定外の重複 canonical label: ${label}×${n}`);
  }
});

test('[Mission14] StationLabelLayer が定義され、LabelLayer と同じ Sprite+CanvasTexture 方式', () => {
  assert.ok(/const StationLabelLayer = \(function \(\) \{/.test(html), 'StationLabelLayer 未定義');
  assert.ok(/new THREE\.CanvasTexture\(canvas\)/.test(html) && /new THREE\.Sprite\(lm\)/.test(html), 'Sprite+CanvasTexture 方式でない');
  assert.ok(/function makeLabelTexture\(name, style\)/.test(html), 'ラベルテクスチャ生成関数が無い');
  // camera-facing: THREE.Sprite（常にカメラを向く）
  assert.ok(/const spr = new THREE\.Sprite\(lm\);/.test(html), 'ラベルが Sprite でない（camera-facing でない疑い）');
  // fog で薄くしない
  assert.ok(/fog: false/.test(html), 'Sprite material に fog:false が無い（fog で文字が薄くなる）');
});

test('[Mission14] LOD: FAR=major / MID=major+medium / NEAR=all、band しきい値は 9000/3500', () => {
  assert.ok(/const BANDS = \{ farM: 9000, midM: 3500 \};/.test(html), 'band しきい値が道路と揃っていない');
  assert.ok(/function lodVisible\(imp, d\) \{ const b = band\(d\); if \(imp === 'major'\) return true; if \(imp === 'medium'\) return b !== 'far'; return b === 'near'; \}/.test(html),
    'lodVisible の実装が違う');
  assert.ok(/const FAR_MAX = 26;/.test(html), 'FAR 表示上限が無い（駅名だらけ防止）');
});

test('[Mission14] collision: priority 順 + screen-space bbox、camera dirty 時のみ再計算（毎フレーム全件禁止）', () => {
  assert.ok(/cand\.sort\(\(a, b2\) => \(STYLE\[a\.it\.imp\]\.priority - STYLE\[b2\.it\.imp\]\.priority\)/.test(html), 'priority ソートが無い');
  assert.ok(/if \(Math\.abs\(c\.sx - q\.sx\) < \(hw \+ q\.hw\) && Math\.abs\(c\.sy - q\.sy\) < \(hh \+ q\.hh\)\)/.test(html), 'screen-space bbox collision が無い');
  assert.ok(/const THROTTLE_MS = 180;/.test(html), 'throttle が無い');
  assert.ok(/if \(key === lastRecomputeKey\) return;/.test(html), 'camera dirty 判定が無い（毎フレーム再計算）');
});

test('[Mission14] canonical style: 白模型に合う（黒ベタ・派手色でない）、MAJOR>MEDIUM>LOCAL', () => {
  const m = html.match(/const STYLE = \{\s*major:\s*\{ font: ([0-9.]+)[^}]*\},\s*medium:\s*\{ font: ([0-9.]+)[^}]*\},\s*local:\s*\{ font: ([0-9.]+)/);
  assert.ok(m, 'STYLE テーブルが取れない');
  assert.ok(parseFloat(m[1]) > parseFloat(m[2]) && parseFloat(m[2]) > parseFloat(m[3]), 'font size が MAJOR>MEDIUM>LOCAL でない');
  assert.ok(parseFloat(m[1]) >= 13 && parseFloat(m[1]) <= 16, `MAJOR font=${m[1]}`);
  // text 色は濃いグレー（黒 #000 でない）、bg は白系
  assert.ok(/text: '#3f4852'/.test(html) && /bg: 'rgba\(255,255,255,0\.9/.test(html), 'ラベル色/背景が白模型向けでない');
  assert.ok(!/text: '#000000'|background: 'black'/.test(html), '黒ベタが使われている');
});

test('[Mission14] station y(0.5) > rail y(0.17)、駅点とラベルが対応（dot + label）', () => {
  assert.ok(/const STATION_Y = 0\.5;/.test(html), 'STATION_Y が rail(0.17) より上でない');
  assert.ok(/railways:\s+\{ y: 0\.17,/.test(html), 'rail y が変わった');
  assert.ok(/const LABEL_ANCHOR_DY = 22;/.test(html), 'ラベルアンカーオフセットが無い');
  assert.ok(/function makeDotTexture\(style\)/.test(html), '駅記号（dot）生成が無い');
  // dot は tier で 3 テクスチャ共有（大量生成しない）
  assert.ok(/for \(const k of \['major', 'medium', 'local'\]\) dotTex\[k\] = makeDotTexture/.test(html), 'dot テクスチャが tier 共有でない');
});

test('[Mission14] 地下鉄駅の扱い: FAR は major(override)のみ → 地下鉄単独駅は FAR で出ない', () => {
  // subway 単独駅は group 無し → major にならない → FAR で lodVisible=false
  assert.ok(/if \(imp === 'medium'\) return b !== 'far';/.test(html), 'medium(地下鉄乗換含む) が FAR で表示される');
  // 実データ: 心斎橋/本町 等の主要地下鉄駅は override で major、昭和町等の単独駅は local/medium
  const { stations, lines } = loadRail();
  const clusters = clusterStations(stations, {});
  const near = nearbyOf(lines);
  const showa = clusters.find((c) => c.label === '昭和町');
  if (showa) assert.notEqual(classifyStationImportance(showa, near(showa)), 'major', '昭和町（地下鉄単独）が major');
});

test('[Mission14] render loop / 駅名トグル / 初期表示 の配線', () => {
  assert.ok(/if \(typeof StationLabelLayer !== 'undefined'\) StationLabelLayer\.update\(\);/.test(html), 'render loop に StationLabelLayer.update() が無い');
  assert.ok(/if \(typeof StationLabelLayer !== 'undefined'\) StationLabelLayer\.setVisible\(on\);/.test(html), '「駅名」トグルが StationLabelLayer に配線されていない');
  assert.ok(/StationLabelLayer\.show\(\); \/\/ 初期表示/.test(html), '初期表示の show() が無い');
  // CityTileLayer の旧 '+' マーカーは debug flag 時のみ（データは保持）
  assert.ok(/layer === 'railways' && \(typeof window !== 'undefined' && window\.__RAIL_STATION_MARKERS__ === true\)/.test(html),
    '旧 station マーカーが debug flag ガードされていない');
  assert.ok(/function getAllStations\(\)/.test(html) && /function getAllRailLines\(\)/.test(html), 'StationLabelLayer のデータソース accessor が無い');
});

test('[Mission14] debug API: __STATION_LABEL_DEBUG__ / __STATION_LABEL_FORCE__ / __STATION_COLLISION_DEBUG__', () => {
  assert.ok(/window\.__STATION_LABEL_DEBUG__ = \(\) => StationLabelLayer\.getDebug\(\);/.test(html));
  assert.ok(/window\.__STATION_LABEL_FORCE__ = \(b\) => StationLabelLayer\.setForceBand\(b\);/.test(html));
  assert.ok(/window\.__STATION_COLLISION_DEBUG__ === true/.test(html), 'collision debug flag が無い');
  const dbg = html.match(/getDebug\(\) \{[\s\S]*?\n    \},/)[0];
  for (const k of ['stationCount', 'clusterCount', 'majorCount', 'mediumCount', 'localCount', 'cameraBand', 'visibleLabels', 'hiddenByCollision', 'hiddenByLOD', 'sampleVisibleNames']) {
    assert.ok(dbg.includes(k), `getDebug に ${k} が無い`);
  }
});

test('[Mission14] 他ミッション成果を壊していない', () => {
  assert.ok(/const RAIL_COLORS = \{ major: 0x8f969d/.test(html), 'Mission13 rail 色');
  assert.ok(/const MS_PARK_GREEN = 0xcfe3c7;/.test(html), 'Mission12 公園色');
  assert.ok(/fillColor: 0x9ed6e6/.test(html), '河川色');
  assert.ok(/const CITY_CAMERA_PRESET = \{/.test(html), 'Mission16 camera preset');
});

test('[Mission14] protected / production 無変更', () => {
  const fw = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html'), 'utf-8');
  assert.ok(!/StationLabelLayer|__STATION_LABEL_DEBUG__|clusterStations/.test(fw), 'fullward-v3.html に Mission14 の変更が混入');
  const prod = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'osaka_3d_buildings.html'), 'utf-8');
  assert.ok(!/StationLabelLayer|__STATION_LABEL_DEBUG__/.test(prod), 'production HTML に Mission14 の変更が混入');
});
