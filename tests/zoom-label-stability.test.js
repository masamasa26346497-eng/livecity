// tests/zoom-label-stability.test.js
// [Mission 33D] ホイールズームの操作感 + 地名ラベルのチラつき抑制
//   - ズーム: 加算式（1 ノッチ 90m 固定）→ 距離比例の指数式。deltaMode 正規化とトラックパッド判定。
//   - ラベル: band ヒステリシス / 前回選定の再利用 / 再選定しきい値 / セル境界のねばり / 主要ラベルの下限
//   - 既存の修正（camera.updateMatrixWorld・旧 StationLabelLayer 休止）が残っていること
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { walkSteps, jaccard, ZOOM_PROBE_R } from '../tools/audit/zoom-label-stability-qa.js';
import { ZOOM_GAIN_TARGET, STABILITY_TARGET } from '../tools/validate/zoom-label-stability.js';
import { productionMatchesBuildRecord } from '../tools/lib/production-invariants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, 'public', 'osaka_3d_buildings.ward-ux-v1.html');
const PROD = path.join(ROOT, 'public', 'osaka_3d_buildings.html');
const PROT = path.join(ROOT, 'public', 'osaka_3d_buildings.fullward-v3.html');
const html = fs.readFileSync(DEV, 'utf-8');
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const rpt = (n) => rj(path.join(ROOT, 'data', 'reports', n));
const skip = (n) => (!rpt(n) && 'no report');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('[33D §1/§2] ホイールズームが距離比例（指数）になっている', () => {
  // 加算式（1 ノッチ 90m 固定）は残っていない
  assert.doesNotMatch(html, /cs\.r\s*\+\s*e\.deltaY\s*\*\s*\.9/);
  assert.match(html, /const ZOOM_WHEEL = \{/);
  assert.match(html, /K: 0\.22,/);
  assert.match(html, /let next = r \* Math\.exp\(ZOOM_WHEEL\.K \* notches\);/);
  // 近景で従来より弱くならない下限
  assert.match(html, /MIN_STEP_M: 90,/);
  assert.match(html, /if \(Math\.abs\(next - r\) < minStep\) next = r \+ Math\.sign\(notches\) \* minStep;/);
});

test('[33D §2] 指数係数 K=0.22 は「1 ノッチで手応え・4 ノッチで 1 段階」を満たす', () => {
  const K = 0.22;
  const inRatio = Math.exp(-K);              // 寄り 1 ノッチ
  assert.ok(inRatio > 0.78 && inRatio < 0.82, '1 ノッチの縮率: ' + inRatio);
  assert.ok(Math.exp(K * 4) > 1.8, '4 ノッチで 1.8 倍未満だと段階が変わらない');
  assert.ok(Math.exp(K * 1) < 1.35, '1 ノッチで 1.35 倍を超えると飛びすぎ');
  // 作業距離帯（r≈800〜1,100m）で従来（90m/ノッチ）の 1.7〜2.3 倍になる
  for (const r of [800, 1000]) {
    const gain = (r * (1 - inRatio)) / 90;
    assert.ok(gain >= ZOOM_GAIN_TARGET.min && gain <= ZOOM_GAIN_TARGET.max, `r=${r} の倍率 ${gain}`);
  }
});

test('[33D §3] wheel delta を deltaMode で正規化し、トラックパッドを見分ける', () => {
  assert.match(html, /const px = e\.deltaY \* \(e\.deltaMode === 1 \? 16 : e\.deltaMode === 2 \? \(innerHeight \|\| 800\) : 1\);/);
  assert.match(html, /ZOOM_WHEEL\.trackpad = ZOOM_WHEEL\.smallRun >= 3;/);
  assert.match(html, /if \(ZOOM_WHEEL\.trackpad\) n \*= ZOOM_WHEEL\.TRACKPAD_SCALE;/);
  // 1 イベントで飛びすぎない上限
  assert.match(html, /return Math\.max\(-ZOOM_WHEEL\.MAX_NOTCH, Math\.min\(ZOOM_WHEEL\.MAX_NOTCH, n\)\);/);
});

test('[33D §4/§5] ズーム中心（カーソル寄せ）とズーム範囲は従来どおり', () => {
  // マウス位置の地表点へ寄せる既存挙動を壊していない
  assert.match(html, /const zoomingIn = cs\.r < oldR;/);
  assert.match(html, /const pull = Math\.min\(0\.15, \(oldR-cs\.r\)\/oldR\);/);
  // min/max は変更していない
  assert.match(html, /minPh:0\.05, maxPh:1\.45, minR:60, maxR:24000/);
  assert.match(html, /return Math\.max\(cs\.minR, Math\.min\(cs\.maxR, next\)\);/);
});

test('[33D §14] band 境界にヒステリシスがある', () => {
  assert.match(html, /const BAND_HYST = 0\.10;/);
  assert.match(html, /const BANDS = \{ farM: 9000, midM: 3500 \};/);   // しきい値そのものは変えない
  assert.match(html, /const lo = 1 - BAND_HYST, hi = 1 \+ BAND_HYST;/);
  assert.match(html, /if \(curBand !== null && next !== curBand\) stats\.bandSwitches\+\+;/);
  // band は place() で 1 回だけ決め、item ごとに評価しない
  assert.match(html, /function lodVisible\(item, b\) \{/);
  assert.match(html, /if \(!lodVisible\(item, b\)\) \{ stats\.hiddenByLOD\+\+; continue; \}/);
});

test('[33D §14] ヒステリシスの閾値は「入る側」と「出る側」で分かれている', () => {
  const farM = 9000, midM = 3500, m = 0.10;
  // far へ出るのは 9,900m 超、mid へ戻るのは 8,100m 未満（＝ 8,100〜9,900m では直前の band を保つ）
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(farM * (1 + m), 9900);
  near(farM * (1 - m), 8100);
  near(midM * (1 + m), 3850);
  near(midM * (1 - m), 3150);
  // 1 ノッチ（×1.246）で往復しても band が往復しない幅があること
  assert.ok(farM * (1 + m) / (farM * (1 - m)) > 1.2);
});

test('[33D §8/§12] 前回の選定結果を同順位の並びにだけ使う', () => {
  assert.match(html, /let prevVisible = new Set\(\), prevMajor = new Set\(\);/);
  assert.match(html, /stable: prevVisible\.has\(item\.id\) \? 0 : 1/);
  assert.match(html, /pool\.sort\(\(a, z\) => \(a\.rank - z\.rank\) \|\| \(a\.stable - z\.stable\) \|\| \(a\.dc - z\.dc\)\);/);
  // rank そのものへの加点はしない（ランドマーク/駅/地名の大分類を逆転させないため §12）
  assert.doesNotMatch(html, /rank \+= .*stabilityBonus/i);
  assert.doesNotMatch(html, /const STABILITY_BONUS/);
  assert.match(html, /prevVisible = nextVisible; prevMajor = nextMajor;/);
});

test('[33D §9/§10/§11] 小さな camera 変化では選び直さず、大きさだけ更新する', () => {
  assert.match(html, /const RELAYOUT = \{ targetFrac: 0\.035, targetMinM: 30, distRatio: 1\.06, angleRad: 0\.035 \};/);
  assert.match(html, /function needsRelayout\(\) \{/);
  assert.match(html, /if \(Math\.hypot\(cs\.tgt\.x - layoutCam\.x, cs\.tgt\.z - layoutCam\.z\) > Math\.max\(RELAYOUT\.targetMinM, cs\.r \* RELAYOUT\.targetFrac\)\) return true;/);
  assert.match(html, /function refreshTransforms\(\) \{/);
  assert.match(html, /if \(dirty \|\| needsRelayout\(\)\) \{ dirty = false; place\(\); lastXf = xfKey\(\); return; \}/);
  // 量子化キーによる全再選定は廃止（CityLabelLayer のキーは昼夜を末尾に持っていた。
  //   同じ形のキーを使う LabelEngine 側は 33D の対象外なのでそのまま）
  assert.doesNotMatch(html, /Math\.round\(cs\.ph \* 20\) \+ ',' \+ \(isNight\(\) \? 'n' : 'd'\)/);
  // §11 再選定を止めても sprite の大きさ・河川の向きは追従する
  assert.match(html, /const h = rec\.pxHeight \* worldPerPixel\(dist\);\s+rec\.sprite\.scale\.set\(h \* rec\.aspect, h, 1\);\s+if \(item\.kind === 'river'\) rec\.sprite\.material\.rotation = screenAngleOf\(item\);/);
});

test('[33D §10] 再選定しきい値は 1 ノッチでは必ず超え、微小操作では超えない', () => {
  const R = { targetFrac: 0.035, targetMinM: 30, distRatio: 1.06, angleRad: 0.035 };
  const NOTCH = Math.exp(0.22);
  assert.ok(NOTCH > R.distRatio, 'ホイール 1 ノッチで選び直さないのは不可');
  assert.ok(1.03 < R.distRatio, '3% のズームで選び直すとチラつく');
  const r = 900;
  assert.ok(r * 0.005 < Math.max(R.targetMinM, r * R.targetFrac), '0.5% の pan で選び直すとチラつく');
  assert.ok(r * 0.06 > Math.max(R.targetMinM, r * R.targetFrac), '6% の pan では選び直す');
  assert.ok(0.012 < R.angleRad && 0.06 > R.angleRad);
});

test('[33D §13] セル境界でラベルが押し出されない（前のセルに留まる）', () => {
  assert.match(html, /const CELL_MARGIN = 0\.28;/);
  assert.match(html, /if \(prev\[0\] !== ix && Math\.abs\(fx - \(prev\[0\] \+ 0\.5\)\) <= 0\.5 \+ CELL_MARGIN\) ix = prev\[0\];/);
  assert.match(html, /prevCell\.set\(c\.item\.id, cellIdx\);/);
});

test('[33D §15/§16] 主要ラベルは名前ではなく tier で決め、グリッド上限を緩める', () => {
  assert.match(html, /function isMajorLabel\(item\) \{/);
  assert.match(html, /if \(item\.kind === 'landmark'\) return item\.tier === 'S';/);
  assert.match(html, /if \(item\.kind === 'station' \|\| item\.kind === 'place'\) return item\.importance === 'major';/);
  assert.match(html, /const GRID_MAJOR_PER_CELL = 5;/);
  assert.match(html, /const perCell = major \? GRID_MAJOR_PER_CELL : GRID\.perCell;/);
  // 地名のハードコードで固定していない（§16）
  for (const name of ['梅田', '難波', '天王寺', '本町', '中之島', '淡路', '上新庄', '東三国']) {
    assert.doesNotMatch(html, new RegExp(`MAJOR_LABEL[A-Z_]*\\s*=\\s*\\[[^\\]]*${name}`));
  }
  // 画面全体の上限と衝突判定は主要ラベルにも掛かる（文字だらけにしない）
  assert.match(html, /if \(stats\.visible >= cap\) \{ stats\.hiddenByDensityCap\+\+;/);
  assert.match(html, /if \(overlap\) \{ rec\.sprite\.visible = false; stats\.hiddenByCollision\+\+; continue; \}/);
});

test('[33D §21] 33B で入れた修正が残っている', () => {
  assert.match(html, /camera\.updateMatrixWorld\(\);[\s\S]{0,200}前回の配置をいったん全部消す/);
  assert.match(html, /for \(const rec of sprites\.values\(\)\) rec\.sprite\.visible = false;/);
  assert.doesNotMatch(html, /^StationLabelLayer\.show\(\);/m);
  assert.match(html, /if \(allowShow\) scene\.add\(group\);/);
  assert.match(html, /show\(\) \{ allowShow = true;/);
});

test('[33D] QA ヘルパー: walk は 20〜50 サンプルで 4 種類の動きを含む', () => {
  const steps = walkSteps({ r: 900 });
  assert.ok(steps.length >= 20 && steps.length <= 50, 'サンプル数 ' + steps.length);
  assert.deepEqual([...new Set(steps.map((s) => s.tier))].sort(), ['jitter', 'pan', 'rotate', 'zoom']);
  // pan は少しずつ積み上がる（同じ場所を測り直すだけにならない）
  const pans = steps.filter((s) => s.tier === 'pan');
  assert.ok(Math.hypot(pans[pans.length - 1].dx, pans[pans.length - 1].dz) > Math.hypot(pans[0].dx, pans[0].dz));
  // 1 歩は再選定しきい値より小さい
  assert.ok(Math.hypot(pans[1].dx - pans[0].dx, pans[1].dz - pans[0].dz) < Math.max(30, 900 * 0.035));
  // jitter は往復する
  const jit = steps.filter((s) => s.tier === 'jitter');
  assert.ok(jit.some((s) => s.rk > 1) && jit.some((s) => s.rk < 1));
  // zoom は寄ってから戻る
  const zm = steps.filter((s) => s.tier === 'zoom');
  assert.ok(zm[3].rk < zm[0].rk && zm[7].rk > zm[3].rk);
  assert.ok(ZOOM_PROBE_R.includes(300) && ZOOM_PROBE_R.includes(12000));
});

test('[33D] QA ヘルパー: Jaccard', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 0.3333);
  assert.equal(jaccard(['a'], ['b']), 0);
});

test('[33D §18] 実ブラウザ: 1 ノッチのズーム量が増えた', { skip: skip('zoom-label-stability-qa.json') }, () => {
  const qa = rpt('zoom-label-stability-qa.json');
  const after = qa.phases.after, before = qa.phases.before;
  assert.ok(after, 'phase=after が無い');
  for (const q of after.zoom.notch) {
    const b = before ? before.zoom.notch.find((x) => x.r === q.r) : null;
    if (b) assert.ok(q.zoomInStepM >= b.zoomInStepM - 0.5, `r=${q.r}: ${b.zoomInStepM} → ${q.zoomInStepM}（弱くなっている）`);
    if (b && q.r >= 900) assert.ok(q.zoomInStepM / b.zoomInStepM >= ZOOM_GAIN_TARGET.min, `r=${q.r} の倍率が足りない`);
  }
  // 引いた画面でも同じ割合で動く
  const far = after.zoom.notch.filter((q) => q.r >= 900);
  for (const q of far) assert.ok(Math.abs(q.zoomInRatio - 0.8025) < 0.01, `r=${q.r} の縮率 ${q.zoomInRatio}`);
  // 2〜4 ノッチで段階が変わる
  const m4 = after.zoom.multi.find((m) => m.notches === 4);
  assert.ok(m4 && m4.ratio >= 1.8, JSON.stringify(after.zoom.multi));
  // トラックパッドで暴走しない
  assert.equal(after.zoom.trackpad.detected, true);
  assert.ok(after.zoom.trackpad.ratio <= 1.6, JSON.stringify(after.zoom.trackpad));
  // ズーム範囲の端まで届く（旧実装は maxR へ届かなかった）
  assert.equal(after.zoom.range.minOk, true);
  assert.equal(after.zoom.range.maxOk, true);
});

test('[33D §19/§20] 実ブラウザ: 連続した小さな操作でラベルが入れ替わらない', { skip: skip('zoom-label-stability-qa.json') }, () => {
  const qa = rpt('zoom-label-stability-qa.json');
  const after = qa.phases.after, before = qa.phases.before;
  const rows = after.sites.concat([{ ...after.cityMode, site: 'cityMode' }]);
  const bRows = before ? before.sites.concat([{ ...before.cityMode, site: 'cityMode' }]) : [];
  for (const s of rows) {
    assert.equal(s.maxSevereOverlaps, 0, `${s.site}: 完全重複`);
    assert.equal(s.maxDuplicates, 0, `${s.site}: 同一ラベルの二重表示`);
    assert.ok(s.jaccardStep >= STABILITY_TARGET.all, `${s.site}: 1 手ごとの Jaccard ${s.jaccardStep}`);
    // 微小 pan と往復では表示が変わらない
    assert.equal(s.byTier.pan.jaccardStep, 1, `${s.site}: 微小 pan で入れ替わっている`);
    assert.equal(s.byTier.jitter.jaccardStep, 1, `${s.site}: 往復でチラついている`);
    const b = bRows.find((q) => q.site === s.site);
    if (b) assert.ok(s.jaccardStep >= b.jaccardStep, `${s.site}: 悪化 ${b.jaccardStep} → ${s.jaccardStep}`);
    if (b) assert.ok(s.churnPerStep <= b.churnPerStep, `${s.site}: 入れ替わり数が増えた ${b.churnPerStep} → ${s.churnPerStep}`);
    // §15/§16 主要ラベル
    assert.ok(s.majorJaccardStep >= 0.85, `${s.site}: 主要ラベルが安定しない ${s.majorJaccardStep}`);
  }
});

test('[33D §22] 実ブラウザ: hover / クリック / カード / トグル / 検索の回帰なし', { skip: skip('zoom-label-stability-qa.json') }, () => {
  const rg = rpt('zoom-label-stability-qa.json').phases.after.regression;
  assert.equal(rg.hover, 'block');
  assert.equal(rg.cardDisplay, 'block');
  for (const [k, t] of Object.entries(rg.toggles)) {
    assert.equal(typeof t, 'object', `${k}: トグル行が無い`);
    assert.ok(t.off < t.before, `${k}: OFF で減っていない`);
  }
  assert.equal(rg.search.msgShown, false);
  assert.ok(rg.search.distanceM <= 50);
  assert.deepEqual(rpt('zoom-label-stability-qa.json').phases.after.errors, []);
});

test('[33D §17] 性能: 交互計測で FPS が落ちていない / 再配置は throttle 内', { skip: skip('zoom-label-perf-ab.json') }, () => {
  const ab = rpt('zoom-label-perf-ab.json');
  assert.ok(ab.summary.before.fps.length >= 2 && ab.summary.after.fps.length >= 2, '交互計測が 2 ラウンド未満');
  assert.ok(ab.summary.fpsDeltaPct >= -8, 'FPS 低下 ' + ab.summary.fpsDeltaPct + '%');
  // ラベル再選定 1 回の実時間。最悪値は GC など単発の外れ値で振れるので中央値で見る。
  assert.ok(ab.summary.after.placeMedianMs <= ab.summary.before.placeMedianMs + 0.05,
    'place() が重くなった ' + ab.summary.before.placeMedianMs + ' → ' + ab.summary.after.placeMedianMs + 'ms');
  assert.ok(ab.summary.after.placeMedianMs <= 1.0, 'place() が遅い ' + ab.summary.after.placeMedianMs + 'ms');
  assert.ok(ab.summary.after.placeMaxMs <= 5, 'place() の最悪値が 5ms 超 ' + ab.summary.after.placeMaxMs);
  // 200ms throttle を超えて再配置していない
  assert.ok(ab.summary.after.relayoutPerSec !== null && ab.summary.after.relayoutPerSec <= 5.1);
});

test('[33D §24] validator が PASS', { skip: skip('zoom-label-stability-validation.json') }, () => {
  const v = rpt('zoom-label-stability-validation.json');
  assert.equal(v.RESULT, 'PASS', JSON.stringify(v.errors));
  assert.equal(v.classification, 'ZOOM_LABEL_STABILITY_SUCCESS');
  assert.equal(v.zoomWheelStrengthIncreased, true);
  assert.equal(v.trackpadStillStable, true);
  assert.equal(v.labelHysteresisEnabled, true);
  assert.equal(v.labelSelectionStateCached, true);
  assert.equal(v.majorLabelFlickerReduced, true);
  assert.equal(v.nearOverlapCount, 0);
  assert.equal(v.duplicateLabelCount, 0);
  assert.equal(v.buildingMutation, 0);
  assert.equal(v.roadMutation, 0);
  assert.equal(v.projectionMutation, 0);
  assert.equal(v.productionModified, false);
  assert.equal(v.protectedModified, false);
});

test('[33D §23] production / protected は変更していない', () => {
  const build = rpt('production-cutover-build.json');
  assert.ok(build && build.productionSha256);
  assert.equal(sha(PROD), build.productionSha256, 'production HTML が変わっている');
  const baseline = rpt('baselines/prod-protected-hashes.json');
  assert.ok(baseline && baseline.prot);
  assert.equal(sha(PROT), baseline.prot, 'protected HTML が変わっている');
  // [Mission 35G] production は dev からビルドプロファイル 1 行だけ変えて作るので、
  //   cutover 後は 33D の変更も production に入る（それが正しい状態）。
  //   「文字列が無いこと」ではなく「勝手な差分が無いこと」を見る。
  // [Mission 35H] dev 先行が正常なので、production 自身のビルド記録と比べる。
  assert.deepEqual(productionMatchesBuildRecord(build.productionSha256), { ok: true, now: sha(PROD), expected: build.productionSha256 });
});
