// tools/build-river-layer.js
// [河川再構築] centerline + width ribbon 方式の新河川レイヤーを生成する。
//
// 入力: public/map-data/osaka-city/waterways/tile_*.json（既存パイプラインの出力。既に
//   OSM PBF → tools/convert/waterways.js → tools/build-city-layer-tiles.js（24区 line clip 済み）
//   を経た line/area feature を保持している。ネットワーク接続は不要 — 既存の抽出済みデータから
//   centerline方式のribbonを再構築する）。
// 出力:
//   data/processed/osaka-city/rivers-v2/rivers.json
//   public/map-data/osaka-city/rivers-v2/rivers.json
//   data/reports/river-layer-generation.json（主要河川レポート用）
//
// 対象タグ（指示書3節）: waterClass が 'river' | 'canal' の line feature のみを centerline として
//   採用する（waterway=river/canal/riverbank, water=river 相当）。pond/lake/reservoir/harbour/
//   stream・natural=water分類不明は対象外（既存 CleanWaterLayer 以前の旧WaterLayerで扱う）。
//   waterClass='river'|'canal' の area feature（riverbank multipolygon）は「幅推定の参考」
//   としてのみ使用し、直接メッシュ化しない（指示書8節）。

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectPath, toProjectRelativePath, PROJECT_ROOT } from './lib/paths.js';
import { writeJson } from './lib/area.js';
import { resolveRiverWidth, conservativeMinorWidth, conservativeMicroWidth, MINOR_WIDTH_LIMITS, MICRO_WIDTH_LIMITS, DEFAULT_WIDTH_BY_CLASS, clampWidth } from './lib/river-width.js';
import { buildRiverRibbonTapered } from './lib/river-ribbon.js';
import { validateRiverRibbon } from './lib/river-ribbon-validator.js';
import { orderRiverSegments, rejectWidthOutliers } from './lib/river-width-smooth.js';
import { buildFootprintGrid, resolveMinorConflict, assessRibbonConflict } from './lib/river-building-conflict.js';
import { classifyRiverTier, groupByRiver, normalizeRiverName, auditContinuity, classifyGapCause, polylineLengthXZ, MAJOR_RIVERS as NET_MAJOR_RIVERS, MEDIUM_ANCHOR_RIVERS } from './lib/river-network.js';

// [大川の実幅補正] riverbank polygon が十分ある named river は実測幅を信頼する（一般化ロジック）。
//   riverbank 実測 = 河道そのものの幾何。ここに重なる建物 footprint は「建物を水に描いた OSM 誤り」か
//   「centerline が河道中心からずれている」ケースが大半で、河川を細くしても解決しない（むしろ河川が誤る）。
//   → 強実測（riverbank >= STRONG_RB / 実測幅 >= STRONG_W）の medium 河川は major と同様に
//     建物干渉 shrink の対象外にし、幅上限を STRONG_MEDIUM_MAX_W まで許容する。
const STRONG_RB_MIN = 6;          // resolveRiverWidth の matchedRiverbanks
const STRONG_MEASURED_MIN_W = 45; // clampWidth 後の実測幅（m）
const STRONG_MEDIUM_MAX_W = 110;  // 強実測 medium の幅上限（大川級。通常 medium は 70）
function isStrongWideMeasured(wres) {
  return !!wres && wres.method === 'measured'
    && (wres.matchedRiverbanks || 0) >= STRONG_RB_MIN
    && Number.isFinite(wres.width) && wres.width >= STRONG_MEASURED_MIN_W;
}

// [Mission04] 幅平滑化パラメータ
const WIDTH_MAX_DELTA_PER_100M = 25; // 100mあたり幅差の絶対上限（rate clamp）
const WIDTH_MAX_RATIO_PER_100M = 1.3; // 100mあたり幅比の上限（2〜3倍級jumpを構造的に禁止）
const CHAIN_ENDPOINT_TOL_M = 80;     // セグメント端点一致とみなす距離
// [Mission04-B] 小河川の建物干渉回避パラメータ
const CONFLICT_BUFFER_M = 60;        // minor waterway bbox をこの分だけ広げて建物 tile を読む

const SRC_DIR = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'waterways'));
const BUILDINGS_ROOT = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'buildings'));
const OUT_PROCESSED = resolveProjectPath(path.join('data', 'processed', 'osaka-city', 'rivers-v2', 'rivers.json'));
const OUT_PUBLIC = resolveProjectPath(path.join('public', 'map-data', 'osaka-city', 'rivers-v2', 'rivers.json'));
const OUT_REPORT = resolveProjectPath(path.join('data', 'reports', 'river-layer-generation.json'));
const OUT_COVERAGE = resolveProjectPath(path.join('data', 'reports', 'river-network-coverage.json'));

// [Mission22] 対象 = surface な river/canal/stream/drain/ditch の line。地下水路（surface:false）は除外。
const RIBBON_CLASSES = new Set(['river', 'canal', 'stream']); // waterClass。drain/ditch は classifyWater で 'canal'
const MAJOR_RIVERS = NET_MAJOR_RIVERS; // 主要7河川（river-network.js canonical）
const MAJOR_SET = new Set(MAJOR_RIVERS);
// [Mission22] 実機QA §19 の代表河川（連続性レポートで必ず個別に出す）
const QA_RIVERS = ['大川', '堂島川', '土佐堀川', '東横堀川', '道頓堀川', '城北川', '寝屋川', '第二寝屋川', '平野川', '平野川分水路', '正蓮寺川', '六軒家川', '尻無川', '安治川', '木津川', '大和川', '淀川', '神崎川'];
const CONTINUITY_TOL_M = 60; // 連続性監査の端点一致距離
const BUILDING_TILE_SIZE = 500; // BUILDING_TILE_CONFIG.tileSize と一致

function bboxOfPts(pts) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}

// minor waterway の bbox 群が触れる建物 tile だけを読み、footprint 配列を返す。
function loadBuildingFootprintsNear(bboxes) {
  const want = new Set();
  for (const bb of bboxes) {
    const x0 = Math.floor((bb.minX - CONFLICT_BUFFER_M) / BUILDING_TILE_SIZE);
    const x1 = Math.floor((bb.maxX + CONFLICT_BUFFER_M) / BUILDING_TILE_SIZE);
    const z0 = Math.floor((bb.minZ - CONFLICT_BUFFER_M) / BUILDING_TILE_SIZE);
    const z1 = Math.floor((bb.maxZ + CONFLICT_BUFFER_M) / BUILDING_TILE_SIZE);
    for (let tx = x0; tx <= x1; tx++) for (let tz = z0; tz <= z1; tz++) want.add(tx + '_' + tz);
  }
  const fps = [];
  let tilesRead = 0;
  if (!fs.existsSync(BUILDINGS_ROOT)) return { fps, tilesRead, wantedTiles: want.size };
  for (const ds of fs.readdirSync(BUILDINGS_ROOT)) {
    const dir = path.join(BUILDINGS_ROOT, ds);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const key of want) {
      const f = path.join(dir, `tile_${key}.json`);
      if (!fs.existsSync(f)) continue;
      tilesRead++;
      try {
        const t = JSON.parse(fs.readFileSync(f, 'utf-8'));
        for (const b of (t.buildings || [])) if (Array.isArray(b.fp) && b.fp.length >= 3) fps.push(b.fp);
      } catch { /* skip broken tile */ }
    }
  }
  return { fps, tilesRead, wantedTiles: want.size };
}

function loadAllFeatures() {
  const files = fs.readdirSync(SRC_DIR).filter((f) => /^tile_.*\.json$/.test(f));
  const byId = new Map();
  for (const f of files) {
    const tile = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
    for (const ft of (tile.features || [])) {
      if (!byId.has(ft.id)) byId.set(ft.id, ft); // feature は複数tileに複製されているため id で重複排除
    }
  }
  return [...byId.values()];
}

async function main() {
  const all = loadAllFeatures();
  const allLines = all.filter((f) => f.kind === 'line' && RIBBON_CLASSES.has(f.waterClass));
  // [Mission22 §14] 地下水路（暗渠・トンネル・layer<0）は地表河川として描画しない。
  const undergroundLines = allLines.filter((f) => f.surface === false);
  const lines = allLines.filter((f) => f.surface !== false);
  const riverbanks = all.filter((f) => f.kind === 'area' && (RIBBON_CLASSES.has(f.waterClass) || f.waterClass === 'river'));

  // waterway tag（種別）内訳
  const byTag = {};
  for (const f of allLines) { const k = f.waterwayTag || f.subtype || f.waterClass || '?'; byTag[k] = (byTag[k] || 0) + 1; }
  console.log(`[build-river-layer] source line features=${allLines.length}（${JSON.stringify(byTag)}） surface=${lines.length} underground=${undergroundLines.length} riverbank(幅参考)=${riverbanks.length}`);

  // ── 1. 名前グループ化 → 3 階級分類（§3） + 幅解決（§6） ──
  //   まず正規化名でグループ化し、グループ総延長を出す（length だけで分類しないための材料の1つ）。
  const groups = groupByRiver(lines);
  const groupLenByKey = new Map();
  for (const [key, g] of groups) groupLenByKey.set(key, g.indices.reduce((s, i) => s + polylineLengthXZ(lines[i].p), 0));
  const keyOfLine = new Map();
  for (const [key, g] of groups) for (const i of g.indices) keyOfLine.set(i, key);

  const segInfo = lines.map((line, idx) => {
    const wres = resolveRiverWidth(line, riverbanks, { bufferM: 300 });
    const measured = wres.method === 'measured' ? wres.width : null;
    const widthHint = (Number.isFinite(line.width) && line.width > 0) ? line.width : (measured || null);
    const groupLengthM = groupLenByKey.get(keyOfLine.get(idx)) || polylineLengthXZ(line.p);
    const tier = classifyRiverTier({
      name: line.name || '', waterwayTag: line.waterwayTag, waterClass: line.waterClass,
      groupLengthM, widthHint,
    });

    let rawWidth, widthMethod;
    if (tier === 'major') {
      rawWidth = wres.width; widthMethod = wres.method;
    } else if (tier === 'medium') {
      // medium: OSM width → 実測 → riverbank → class default。major の 1/2〜上限で clamp。
      const strong = isStrongWideMeasured(wres);
      if (Number.isFinite(line.width) && line.width > 0) { rawWidth = line.width; widthMethod = 'osm-width'; }
      else if (measured != null) { rawWidth = measured; widthMethod = strong ? 'measured-strong' : 'measured'; }
      else { rawWidth = (DEFAULT_WIDTH_BY_CLASS[line.waterClass] || DEFAULT_WIDTH_BY_CLASS.river) * 1.4; widthMethod = 'medium-default'; }
      // [大川の実幅補正] 強実測 named river は幅上限を STRONG_MEDIUM_MAX_W へ（通常 medium は 70）。
      rawWidth = Math.max(14, Math.min(strong ? STRONG_MEDIUM_MAX_W : 70, clampWidth(rawWidth)));
    } else if (tier === 'micro') {
      // [Mission28 §3] drain/ditch/ごく小さい stream。太くしすぎない（1〜8m）。
      const cw = conservativeMicroWidth(line.waterwayTag || line.waterClass, Number.isFinite(line.width) ? line.width : measured);
      rawWidth = cw.width; widthMethod = cw.method;
    } else {
      const cw = conservativeMinorWidth(line.waterwayTag || line.waterClass, Number.isFinite(line.width) ? line.width : measured);
      rawWidth = cw.width; widthMethod = cw.method;
    }
    return { line, wres, riverClass: tier, rawWidth, widthMethod, smoothWidth: rawWidth, profile: null, conflict: null, groupLengthM };
  });

  // ── 2. major / medium の同名河川をグループ化し、流路順に並べ、幅列の単発スパイクを除去 ──
  //   （minor は別ルール：平滑化せず conservative 一定幅 → 建物干渉回避で必要なら縮小）
  //   [Mission22] medium も tapered width にする（都心河川が一定幅の帯に見えないように）。
  const byName = new Map();
  segInfo.forEach((si, idx) => {
    if (si.riverClass !== 'major' && si.riverClass !== 'medium') return;
    const key = normalizeRiverName(si.line.name || '') || `__unnamed_${idx}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(idx);
  });
  const chainMeta = []; // レポート用
  for (const [name, idxs] of byName) {
    if (name.startsWith('__unnamed_') || idxs.length < 2) continue; // 単独/無名は平滑化対象外
    const segs = idxs.map((i) => ({ id: segInfo[i].line.id, centerline: segInfo[i].line.p, width: segInfo[i].rawWidth, _idx: i }));
    const { chains } = orderRiverSegments(segs, CHAIN_ENDPOINT_TOL_M);
    for (const chain of chains) {
      if (chain.length < 2) continue;
      const ordered = chain.map((c) => segs[c.segIndex]);
      const rawSeq = ordered.map((s) => s.width);
      const cleanSeq = rejectWidthOutliers(rawSeq, { spikeRatio: 1.8 });
      ordered.forEach((s, k) => { segInfo[s._idx].smoothWidth = cleanSeq[k]; });
      // 各セグメントの start/end 幅 = 隣接セグメントとの平均（端は自分の幅）
      ordered.forEach((s, k) => {
        const wSelf = cleanSeq[k];
        const wPrev = k > 0 ? cleanSeq[k - 1] : null;
        const wNext = k < ordered.length - 1 ? cleanSeq[k + 1] : null;
        const startW = wPrev != null ? (wSelf + wPrev) / 2 : wSelf;
        const endW = wNext != null ? (wSelf + wNext) / 2 : wSelf;
        // chain[k].flip が true なら centerline は逆向きに繋がっている → start/end を入れ替える
        segInfo[s._idx].profile = chain[k].flip
          ? [{ t: 0, w: endW }, { t: 1, w: startW }]
          : [{ t: 0, w: startW }, { t: 1, w: endW }];
      });
      chainMeta.push({ name, segIds: ordered.map((s) => s.id), rawWidths: rawSeq.map((x) => +x.toFixed(1)), smoothWidths: cleanSeq.map((x) => +x.toFixed(1)) });
    }
  }

  // ── 2.5 建物干渉回避（§13）: minor と medium の ribbon を仮生成し footprint 干渉を評価 ──
  //   minor: 100→85→70→55% 段階縮小、ダメなら suppress（従来どおり）。
  //   [Mission22] medium: 都心の骨格河川。preferShrink を常に有効化し、edge が多くても
  //     0.40 倍まで細くして「残す」。suppress は centerline が本当に建物内（centerSuppressFrac）
  //     の時だけ＝OSM geometry 誤差の疑いが濃い場合のみ。
  // [大川の実幅補正] 強実測（riverbank 十分）の medium 河川は major と同様に建物干渉 shrink の対象外。
  //   riverbank polygon = 河道の幾何そのもの。重なる建物 footprint は OSM 誤りで、河川を細くしても直らない。
  const strongWideSegs = new Set();
  const conflictSegs = segInfo.filter((si) => {
    if (si.riverClass === 'medium' && isStrongWideMeasured(si.wres)) {
      si.conflict = { action: 'keep', scale: 1, edgeInFrac: 0, centerInFrac: 0, strongWideMeasured: true };
      strongWideSegs.add(si);
      return false;
    }
    return si.riverClass === 'minor' || si.riverClass === 'medium' || si.riverClass === 'micro';
  });
  const conflictBboxes = conflictSegs.map((si) => bboxOfPts(si.line.p)).filter((b) => Number.isFinite(b.minX));
  const bl = loadBuildingFootprintsNear(conflictBboxes);
  const fpIndex = buildFootprintGrid(bl.fps, 150);
  console.log(`[build-river-layer] 干渉チェック: minor+medium+micro=${conflictSegs.length} 建物footprint=${bl.fps.length}（tile ${bl.tilesRead}/${bl.wantedTiles}読込）`);
  const conflictStats = { checked: 0, keep: 0, shrink: 0, suppress: 0, conflictBefore: 0, mediumShrink: 0, mediumSuppress: 0, microShrink: 0, microSuppress: 0 };
  const MEDIUM_MIN_W = 5;             // medium はこれ未満には縮めない（細い青線として必ず残す）
  const MEDIUM_SCALES = [1.0, 0.8, 0.62, 0.46, 0.32, 0.20, 0.12];
  for (const si of conflictSegs) {
    const baseW = si.smoothWidth;
    const isMedium = si.riverClass === 'medium';
    const probe = buildRiverRibbonTapered(si.line.p, [{ t: 0.5, w: baseW }], { maxSeg: 40, maxMiterRatio: 2.5 });
    if (!probe.ok) { si.conflict = { action: 'keep', scale: 1, edgeInFrac: 0, centerInFrac: 0 }; continue; }
    const halfWidths = probe.widths.map((w) => w / 2);
    conflictStats.checked++;

    if (isMedium) {
      // [Mission22 §13] 名前付き medium 河川は「消さない」。edgeInFrac が下がる最小スケールを選び、
      //   MEDIUM_MIN_W で下限クランプ。centerline が完全にブロックを貫く（誤 geometry の疑い）
      //   場合でも suppress せず、最小幅の thin ribbon で残し、原因を report へ回す。
      const base = assessRibbonConflict(probe.centerline, halfWidths, fpIndex);
      if (base.edgeInFrac > 0.15 || base.centerInFrac > 0.30) conflictStats.conflictBefore++;
      let chosen = 1, last = base;
      for (const sc of MEDIUM_SCALES) {
        const w = Math.max(MEDIUM_MIN_W, baseW * sc);
        const a = sc === 1 ? base : assessRibbonConflict(probe.centerline, halfWidths.map((h) => Math.max(MEDIUM_MIN_W / 2, h * sc)), fpIndex);
        last = a; chosen = w / baseW;
        if (a.edgeInFrac <= 0.30) break;
        if (w <= MEDIUM_MIN_W + 1e-6) break;
      }
      const finalW = Math.max(MEDIUM_MIN_W, baseW * chosen);
      const thin = finalW <= MEDIUM_MIN_W + 1e-6 && last.edgeInFrac > 0.30;
      si.conflict = { action: chosen >= 0.999 ? 'keep' : (thin ? 'thin' : 'shrink'), scale: +chosen.toFixed(3), edgeInFrac: last.edgeInFrac, centerInFrac: last.centerInFrac };
      if (chosen < 0.999) {
        conflictStats.shrink++; conflictStats.mediumShrink++;
        si.smoothWidth = finalW;
        if (si.profile) si.profile = si.profile.map((pt) => ({ ...pt, w: Math.max(MEDIUM_MIN_W, pt.w * chosen) }));
        console.log(`[RIVER-CONFLICT] name=${si.line.name || si.line.id} class=medium rawWidth=${baseW.toFixed(1)} finalWidth=${finalW.toFixed(1)} action=${thin ? 'thin' : 'shrink'} edgeInFrac=${last.edgeInFrac.toFixed(2)} centerInFrac=${last.centerInFrac.toFixed(2)}`);
      } else conflictStats.keep++;
      continue;
    }

    // [Mission28] micro（drain/ditch/小 stream）: 幅が極小なので「まず縮小」を常に有効化し、
    //   縁が建物に多少触れても残す。suppress は centerline が明確に建物内の時のみ（誤 geometry の疑い）。
    const isMicro = si.riverClass === 'micro';
    const isNamedRiver = !isMicro && !!si.line.name && si.line.waterClass === 'river' && (probe.centerlineLength || 0) > 700;
    const res = resolveMinorConflict(probe.centerline, halfWidths, fpIndex, isMicro
      ? { edgeOkFrac: 0.40, centerOkFrac: 0.35, preferShrink: true, scales: [1.0, 0.7, 0.5, 0.35], extraScale: 0.22, edgeOkFracRelaxed: 0.5 }
      : { edgeOkFrac: 0.28, centerOkFrac: 0.30, preferShrink: isNamedRiver });
    si.conflict = res;
    const cls = si.riverClass;
    if (res.edgeInFrac > 0.15 || res.centerInFrac > 0.30) conflictStats.conflictBefore++;
    if (res.action === 'keep') conflictStats.keep++;
    else if (res.action === 'shrink') {
      conflictStats.shrink++;
      if (isMicro) conflictStats.microShrink++;
      si.smoothWidth = Math.max(isMicro ? MICRO_WIDTH_LIMITS.min : MINOR_WIDTH_LIMITS.min, baseW * res.scale);
      console.log(`[RIVER-CONFLICT] name=${si.line.name || si.line.id} class=${cls} rawWidth=${baseW.toFixed(1)} finalWidth=${si.smoothWidth.toFixed(1)} action=shrink edgeInFrac=${res.edgeInFrac.toFixed(2)}`);
    } else {
      conflictStats.suppress++;
      if (isMicro) conflictStats.microSuppress++;
      si.suppressed = true;
      console.log(`[RIVER-CONFLICT] name=${si.line.name || si.line.id} class=${cls} rawWidth=${baseW.toFixed(1)} action=suppress edgeInFrac=${res.edgeInFrac.toFixed(2)} centerInFrac=${res.centerInFrac.toFixed(2)}`);
    }
  }

  // ── 3. ribbon 生成（major: tapered / minor: conservative 一定幅・干渉回避後） ──
  const rivers = [];
  const errors = [], warns = [];
  for (const si of segInfo) {
    const { line, wres } = si;
    const profile = si.profile || [{ t: 0.5, w: si.smoothWidth }];
    // [Mission28 §9] micro 水路は major river と同じ miter/densify を使わない: 細い帯用に
    //   densify 間隔を詰め（maxSeg 25）miter clamp を厳しく（1.6）＝角の spike を出さない。
    const ribbonOpts = si.riverClass === 'micro'
      ? { maxSeg: 25, maxMiterRatio: 1.6, maxDeltaPer100m: WIDTH_MAX_DELTA_PER_100M, maxRatioPer100m: WIDTH_MAX_RATIO_PER_100M }
      : { maxSeg: 60, maxMiterRatio: 2.5, maxDeltaPer100m: WIDTH_MAX_DELTA_PER_100M, maxRatioPer100m: WIDTH_MAX_RATIO_PER_100M };
    const ribbon = buildRiverRibbonTapered(line.p, profile, ribbonOpts);
    const widths = ribbon.widths || [];
    const wSorted = [...widths].filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
    const pct = (p) => (wSorted.length ? wSorted[Math.min(wSorted.length - 1, Math.floor(p * wSorted.length))] : null);
    const cf = si.conflict || null;
    const river = {
      id: line.id,
      name: line.name || '',
      waterClass: line.waterClass,
      subtype: line.subtype,
      riverClass: si.riverClass, // [Mission22] 'major' | 'medium' | 'minor'
      waterwayTag: line.waterwayTag || line.subtype || line.waterClass,
      normName: normalizeRiverName(line.name || ''),
      surface: line.surface !== false,
      width: wSorted.length ? pct(0.5) : si.smoothWidth, // 代表値（tier分類用）＝中央値
      widthRaw: si.rawWidth,
      widthMethod: si.widthMethod,
      widthSmoothed: si.profile != null,
      widthMin: wSorted.length ? wSorted[0] : null,
      widthMedian: pct(0.5),
      widthMax: wSorted.length ? wSorted[wSorted.length - 1] : null,
      widthP95: pct(0.95),
      widthMatchedRiverbanks: wres.matchedRiverbanks,
      widthSampleCount: wres.sampleCount,
      maxWidthDeltaPer100m: ribbon.maxWidthDeltaPer100m || 0,
      // [Mission04-B] 建物干渉回避の結果
      suppressed: !!si.suppressed,
      conflictAction: cf ? cf.action : null,
      conflictWidthScale: cf ? cf.scale : null,
      conflictEdgeInFrac: cf ? +cf.edgeInFrac.toFixed(3) : null,
      conflictCenterInFrac: cf ? +cf.centerInFrac.toFixed(3) : null,
      source: line.source || null,
      ok: ribbon.ok,
      reason: ribbon.reason || null,
      centerline: ribbon.centerline || [],
      widths,
      left: ribbon.left || [],
      right: ribbon.right || [],
      triangleCount: ribbon.triangleCount || 0,
      maxTriangleArea: ribbon.maxTriangleArea || 0,
      maxTriangleEdge: ribbon.maxTriangleEdge || 0,
      centerlineLength: ribbon.centerlineLength || 0,
      rawMaxSegment: ribbon.rawMaxSegment || 0,
      bbox: ribbon.bbox || null,
    };
    if (river.ok) {
      const v = validateRiverRibbon(river,
        si.riverClass === 'micro' ? { widthLimits: MICRO_WIDTH_LIMITS, selfCrossingSeverity: 'warn' }
          : si.riverClass === 'minor' ? { widthLimits: MINOR_WIDTH_LIMITS, selfCrossingSeverity: 'warn' }
            : si.riverClass === 'medium'
              ? { widthLimits: { min: 4, max: isStrongWideMeasured(si.wres) ? STRONG_MEDIUM_MAX_W + 10 : 80 }, selfCrossingSeverity: 'warn' }
              : {});
      river.validationErrors = v.errors;
      river.validationWarns = v.warns;
      errors.push(...v.errors);
      warns.push(...v.warns);
    } else {
      errors.push(`[${river.name || river.id}] ribbon生成失敗: ${river.reason}`);
    }
    rivers.push(river);
  }

  const okRivers = rivers.filter((r) => r.ok && !r.suppressed && (!r.validationErrors || r.validationErrors.length === 0));
  const totalTriangles = okRivers.reduce((s, r) => s + r.triangleCount, 0);
  const majorCount = rivers.filter((r) => r.riverClass === 'major').length;
  const mediumCount = rivers.filter((r) => r.riverClass === 'medium').length;
  const minorCount = rivers.filter((r) => r.riverClass === 'minor').length;
  const microCount = rivers.filter((r) => r.riverClass === 'micro').length; // [Mission28]
  const suppressedCount = rivers.filter((r) => r.suppressed).length;
  // [Mission28 §11] 建物 overlap 監査（縮小/抑制の効果測定）。conflictEdgeInFrac は「回避後」の縁が建物内の割合。
  const overlapAfter = rivers.filter((r) => !r.suppressed && r.ok && (r.conflictEdgeInFrac || 0) > 0.30);
  const waterBuildingOverlapCount = overlapAfter.length;
  const waterBuildingOverlapArea = Math.round(overlapAfter.reduce((s, r) => s + (r.centerlineLength || 0) * (r.width || 0) * (r.conflictEdgeInFrac || 0), 0));
  const minorWaterSuppressedCount = rivers.filter((r) => r.suppressed && (r.riverClass === 'minor' || r.riverClass === 'micro')).length;
  const minorWaterShrunkCount = rivers.filter((r) => (r.conflictAction === 'shrink' || r.conflictAction === 'thin') && (r.riverClass === 'minor' || r.riverClass === 'micro' || r.riverClass === 'medium')).length;
  const namedRiverSet = new Set(rivers.filter((r) => r.normName).map((r) => r.normName));
  const unnamedShown = okRivers.filter((r) => !r.normName).length;

  // ── 連続性監査（§7）: 正規化名でまとめ、connected components / gap / total length ──
  // 地下水路（暗渠）区間を正規化名ごとにインデックス化 → gap がそれに一致すれば「暗渠区間」と分類。
  const undergroundByName = new Map();
  for (const f of undergroundLines) {
    const nn = normalizeRiverName(f.name || '');
    if (!undergroundByName.has(nn)) undergroundByName.set(nn, []);
    undergroundByName.get(nn).push(f.p);
  }
  const cityBbox = { minX: -16900, maxX: 7100, minZ: -18600, maxZ: 2300 }; // OSAKA_CITY_GROUND_EXTENT
  const nearAny = (pt, polylines, tolM) => {
    if (!pt || !polylines) return false;
    for (const pl of polylines) for (const q of pl) if (Math.hypot(q[0] - pt[0], q[1] - pt[1]) <= tolM) return true;
    return false;
  };
  const nearCityEdge = (pt) => !!pt && (Math.abs(pt[0] - cityBbox.minX) < 650 || Math.abs(pt[0] - cityBbox.maxX) < 650 || Math.abs(pt[1] - cityBbox.minZ) < 650 || Math.abs(pt[1] - cityBbox.maxZ) < 650);

  const shownByName = new Map();
  for (const r of okRivers) {
    if (!r.normName) continue;
    if (!shownByName.has(r.normName)) shownByName.set(r.normName, []);
    shownByName.get(r.normName).push(r);
  }
  const continuity = {};
  for (const [nm, segs] of shownByName) {
    // ribbon.centerline は [x,z] ペア列（river-ribbon.js の dense）。
    const cls = segs.map((s) => (Array.isArray(s.centerline) && s.centerline.length >= 2) ? s.centerline : s.left).filter((c) => c && c.length >= 2);
    const audit = auditContinuity(cls, CONTINUITY_TOL_M);
    const tier = segs[0].riverClass;
    const wAll = segs.flatMap((s) => s.widths || []).filter(Number.isFinite).sort((a, b) => a - b);
    const ugForName = [...(undergroundByName.get(nm) || []), ...(undergroundByName.get('') || [])];
    let gaps = audit.gaps.map((g) => {
      let cause;
      if (nearAny(g.at, undergroundByName.get(nm), 400)) cause = 'H: 暗渠区間（同名の地下水路 way が存在。§14 で地表描画から除外＝正当な不連続）';
      else if (nearCityEdge(g.at)) cause = 'D: 市境クリップ（大阪市 study extent 端。市外へ続く）';
      else if (tier === 'major') cause = 'G: 主要河川の OSM 由来分断（Mission04 から geometry 固定・不変。水門/隧道付近）';
      else if (nearAny(g.at, ugForName, 400)) cause = 'H: 暗渠区間の可能性（付近に無名の地下水路 way）';
      else cause = classifyGapCause({ distM: g.distM, at: g.at, nearCityEdge: false });
      return { distM: g.distM, at: g.at && [Math.round(g.at[0]), Math.round(g.at[1])], cause };
    });
    // 同一河川に確定した暗渠 gap があれば、残る中規模 gap（< 1200m）も暗渠の可能性が高い
    //   （都市河川の暗渠区間は OSM で地下 way が未整備なことが多い。直線補間はしない＝表示は不連続のまま）。
    if (gaps.some((g) => /^H: 暗渠区間（/.test(g.cause))) {
      gaps = gaps.map((g) => ((/^B:/.test(g.cause) || /^E:/.test(g.cause)) && g.distM < 1200
        ? { ...g, cause: 'H: 暗渠区間の可能性（同河川に暗渠区間が複数。OSM に地下 way 欠落。補間しない）' }
        : g));
    }
    continuity[nm] = {
      class: tier, segments: audit.segments, components: audit.components,
      gapCount: gaps.length, maxGapM: audit.maxGapM,
      lengthKm: +(audit.totalLengthM / 1000).toFixed(2),
      widthMin: wAll.length ? +wAll[0].toFixed(1) : null,
      widthMedian: wAll.length ? +wAll[Math.floor(wAll.length / 2)].toFixed(1) : null,
      widthMax: wAll.length ? +wAll[wAll.length - 1].toFixed(1) : null,
      gaps,
    };
  }
  const unexplainedGapRivers = Object.entries(continuity)
    .filter(([, c]) => c.gaps.some((g) => /^B:/.test(g.cause)))
    .map(([nm, c]) => ({ name: nm, class: c.class, maxGapM: c.maxGapM, components: c.components, gaps: c.gaps.filter((g) => /^B:/.test(g.cause)) }));

  const payload = {
    version: 2,
    coordinateConvention: 'znorth-neg-v1',
    generatedAt: new Date().toISOString(),
    method: 'centerline+width ribbon（major/medium=tapered / minor=conservative幅）+ 建物干渉回避 + 地下水路除外',
    sourceDir: toProjectRelativePath(SRC_DIR),
    riverCount: rivers.length,
    majorCount, mediumCount, minorCount, microCount, suppressedCount,
    undergroundSkipped: undergroundLines.length,
    buildingOverlap: { waterBuildingOverlapCount, waterBuildingOverlapArea, minorWaterSuppressedCount, minorWaterShrunkCount },
    okCount: okRivers.length,
    namedRivers: namedRiverSet.size,
    errorCount: errors.length,
    warnCount: warns.length,
    totalTriangles,
    conflictStats,
    continuity,
    rivers,
  };

  fs.mkdirSync(path.dirname(OUT_PROCESSED), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
  await writeJson(OUT_PROCESSED, payload);
  await writeJson(OUT_PUBLIC, payload);

  // ── river-network-coverage.json（§18） ──
  const tagTally = {};
  for (const f of allLines) { const k = f.waterwayTag || f.subtype || '?'; tagTally[k] = (tagTally[k] || 0) + 1; }
  const namedList = [...shownByName.entries()].map(([nm, segs]) => {
    const c = continuity[nm];
    return {
      name: nm, class: c.class, segments: c.segments, lengthKm: c.lengthKm,
      components: c.components, gapCount: c.gapCount, maxGapM: c.maxGapM,
      widthMin: c.widthMin, widthMedian: c.widthMedian, widthMax: c.widthMax,
      sourceOsmIds: segs.map((s) => s.source && `${s.source.type}/${s.source.id}`).filter(Boolean).slice(0, 20),
    };
  }).sort((a, b) => b.lengthKm - a.lengthKm);
  const skipReasons = {
    underground: undergroundLines.length,
    suppressedByBuildingConflict: suppressedCount,
    ribbonError: rivers.filter((r) => !r.ok).length,
    validationError: rivers.filter((r) => r.ok && r.validationErrors && r.validationErrors.length).length,
  };
  // [Mission28] 生 OSM の raw waterway tag 内訳（surface / underground / name 別）。
  const rawTagBreakdown = {};
  for (const f of allLines) {
    const k = f.waterwayTag || f.subtype || f.waterClass || '?';
    const b = rawTagBreakdown[k] || (rawTagBreakdown[k] = { total: 0, surface: 0, underground: 0, named: 0 });
    b.total++; if (f.surface === false) b.underground++; else b.surface++; if (f.name) b.named++;
  }
  const coverageReport = {
    generatedAt: payload.generatedAt,
    source: toProjectRelativePath(SRC_DIR),
    totalWaterwayLineFeatures: allLines.length,
    surfaceLineFeatures: lines.length,
    undergroundLineFeatures: undergroundLines.length,
    byWaterwayTag: tagTally,
    rawTagBreakdown,
    named: namedRiverSet.size,
    unnamedShown,
    tiers: { major: majorCount, medium: mediumCount, minor: minorCount, micro: microCount },
    displayed: okRivers.length,
    displayedByTier: {
      major: okRivers.filter((r) => r.riverClass === 'major').length,
      medium: okRivers.filter((r) => r.riverClass === 'medium').length,
      minor: okRivers.filter((r) => r.riverClass === 'minor').length,
      micro: okRivers.filter((r) => r.riverClass === 'micro').length,
    },
    buildingOverlap: { waterBuildingOverlapCount, waterBuildingOverlapArea, minorWaterSuppressedCount, minorWaterShrunkCount },
    conflictStats,
    skipped: rivers.length - okRivers.length,
    skipReasons,
    qaRivers: QA_RIVERS.map((nm) => {
      const key = normalizeRiverName(nm);
      const c = continuity[key];
      return c ? { name: nm, resolved: true, class: c.class, lengthKm: c.lengthKm, components: c.components, gapCount: c.gapCount, maxGapM: c.maxGapM }
        : { name: nm, resolved: false, note: 'surface な OSM way が見つからない（推測生成しない = UNRESOLVED）' };
    }),
    unexplainedGapRivers,
    namedRivers: namedList,
  };
  fs.mkdirSync(path.dirname(OUT_COVERAGE), { recursive: true });
  await writeJson(OUT_COVERAGE, coverageReport);

  // 主要7河川レポート（指示書9節: centerline length / min/median/max/p95 width / max width delta /
  //   triangleCount / maxTriangleEdge）
  const majorReport = MAJOR_RIVERS.map((name) => {
    const segs = rivers.filter((r) => r.name === name);
    const allW = segs.flatMap((s) => s.widths || []).filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
    const pctl = (p) => (allW.length ? allW[Math.min(allW.length - 1, Math.floor(p * allW.length))] : null);
    const maxArea = segs.reduce((m, s) => Math.max(m, s.maxTriangleArea || 0), 0);
    const maxEdge = segs.reduce((m, s) => Math.max(m, s.maxTriangleEdge || 0), 0);
    const maxDelta = segs.reduce((m, s) => Math.max(m, s.maxWidthDeltaPer100m || 0), 0);
    const totalCenterlineLength = segs.reduce((s2, s) => s2 + (s.centerlineLength || 0), 0);
    const totalTriangleCount = segs.reduce((s2, s) => s2 + (s.triangleCount || 0), 0);
    let bbox = null;
    for (const s of segs) {
      if (!s.bbox) continue;
      if (!bbox) bbox = { ...s.bbox };
      else {
        bbox.minX = Math.min(bbox.minX, s.bbox.minX); bbox.maxX = Math.max(bbox.maxX, s.bbox.maxX);
        bbox.minZ = Math.min(bbox.minZ, s.bbox.minZ); bbox.maxZ = Math.max(bbox.maxZ, s.bbox.maxZ);
      }
    }
    return {
      name, segmentCount: segs.length,
      sourceOsmIds: segs.map((s) => s.source && `${s.source.type}/${s.source.id}`).filter(Boolean),
      centerlineLengthTotalM: Math.round(totalCenterlineLength),
      widthMin: allW.length ? +allW[0].toFixed(1) : null,
      widthMedian: allW.length ? +pctl(0.5).toFixed(1) : null,
      widthMax: allW.length ? +allW[allW.length - 1].toFixed(1) : null,
      widthP95: allW.length ? +pctl(0.95).toFixed(1) : null,
      rawWidthsPerSegment: segs.map((s) => (Number.isFinite(s.widthRaw) ? +s.widthRaw.toFixed(1) : null)),
      widthMethods: [...new Set(segs.map((s) => s.widthMethod))],
      widthSmoothed: segs.some((s) => s.widthSmoothed),
      maxWidthDeltaPer100m: +maxDelta.toFixed(1),
      ribbonBbox: bbox,
      triangleCount: totalTriangleCount,
      maxTriangleArea: maxArea,
      maxTriangleEdge: Math.round(maxEdge),
      errors: segs.flatMap((s) => s.validationErrors || (s.ok ? [] : [`ribbon生成失敗: ${s.reason}`])),
      warns: segs.flatMap((s) => s.validationWarns || []),
    };
  });

  const suppressedSample = rivers.filter((r) => r.suppressed).slice(0, 20).map((r) => ({ id: r.id, name: r.name, waterClass: r.waterClass, rawWidth: +r.widthRaw.toFixed(1), edgeInFrac: r.conflictEdgeInFrac, centerInFrac: r.conflictCenterInFrac, sourceId: r.source && `${r.source.type}/${r.source.id}` }));
  const shrinkSample = rivers.filter((r) => r.conflictAction === 'shrink').slice(0, 20).map((r) => ({ id: r.id, name: r.name, rawWidth: +r.widthRaw.toFixed(1), scale: r.conflictWidthScale, finalWidth: +(r.widthRaw * r.conflictWidthScale).toFixed(1) }));
  const report = {
    generatedAt: payload.generatedAt,
    riverCount: rivers.length, majorCount, mediumCount, minorCount, microCount, suppressedCount,
    buildingOverlap: { waterBuildingOverlapCount, waterBuildingOverlapArea, minorWaterSuppressedCount, minorWaterShrunkCount },
    undergroundSkipped: undergroundLines.length, namedRivers: namedRiverSet.size,
    okCount: okRivers.length, errorCount: errors.length, warnCount: warns.length,
    totalTriangles,
    conflict: { ...conflictStats, buildingFootprints: bl.fps.length, tilesRead: bl.tilesRead, suppressedSample, shrinkSample },
    widthSmoothing: { maxDeltaPer100m: WIDTH_MAX_DELTA_PER_100M, maxRatioPer100m: WIDTH_MAX_RATIO_PER_100M, chainEndpointTolM: CHAIN_ENDPOINT_TOL_M, chains: chainMeta },
    majorRivers: majorReport,
  };
  fs.mkdirSync(path.dirname(OUT_REPORT), { recursive: true });
  await writeJson(OUT_REPORT, report);

  console.log(`[build-river-layer] rivers=${rivers.length}（major=${majorCount} medium=${mediumCount} minor=${minorCount} micro=${microCount}） ok=${okRivers.length} suppressed=${suppressedCount} underground除外=${undergroundLines.length} named=${namedRiverSet.size} error=${errors.length} warn=${warns.length} triangles=${totalTriangles}`);
  console.log(`[build-river-layer] 干渉: checked=${conflictStats.checked} 干渉検出(修正前)=${conflictStats.conflictBefore} → keep=${conflictStats.keep} shrink=${conflictStats.shrink}(medium ${conflictStats.mediumShrink} / micro ${conflictStats.microShrink}) suppress=${conflictStats.suppress}(micro ${conflictStats.microSuppress})`);
  console.log(`[build-river-layer] 建物 overlap: after=${waterBuildingOverlapCount}（~${waterBuildingOverlapArea}m²） minor/micro suppressed=${minorWaterSuppressedCount} shrunk=${minorWaterShrunkCount}`);
  console.log('主要7河川（Mission04: width平滑化後・major は干渉回避対象外＝品質維持）:');
  for (const m of majorReport) {
    console.log(`  ${m.name}: seg=${m.segmentCount} clLen=${m.centerlineLengthTotalM}m width[min=${m.widthMin} median=${m.widthMedian} max=${m.widthMax} p95=${m.widthP95}] maxΔ/100m=${m.maxWidthDeltaPer100m} tri=${m.triangleCount} maxEdge=${m.maxTriangleEdge}m err=${m.errors.length} warn=${m.warns.length}`);
  }
  console.log(`[build-river-layer] 連続性: named=${Object.keys(continuity).length} / 未説明gap(OSM欠落)=${unexplainedGapRivers.length}`);
  for (const nm of QA_RIVERS) {
    const c = continuity[normalizeRiverName(nm)];
    if (c) console.log(`  ${nm}: ${c.class} len=${c.lengthKm}km comp=${c.components} gap=${c.gapCount} maxGap=${c.maxGapM}m w[${c.widthMin}/${c.widthMedian}/${c.widthMax}]`);
    else console.log(`  ${nm}: UNRESOLVED（surface な OSM way なし）`);
  }
  console.log('保存:', toProjectRelativePath(OUT_PROCESSED), toProjectRelativePath(OUT_PUBLIC), toProjectRelativePath(OUT_REPORT), toProjectRelativePath(OUT_COVERAGE));
  if (errors.length) { console.error(`[build-river-layer] ERROR ${errors.length}件（詳細は各riverのvalidationErrors参照）`); process.exitCode = 1; }
}

main().catch((e) => { console.error('[build-river-layer] 失敗:', e && e.stack || e); process.exitCode = 1; });
