// Mission 213: --sweep の経路計画・チャンク再開・判定を副作用なしの純関数に分離(単体テスト可能にする)。
//   e2e-city-lod0.mjs は import するだけ。ブラウザ/ネットワークには一切触れない。
import fs from 'node:fs';
import path from 'node:path';

// 24区の中心(attrs の repX/repZ 平均)と隣接区境(各区の最近傍2区との中点)を最近傍順に巡回する決定的な経路。
export function planRoute(extDir, registryPath) {
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')).wards;
  const cs = [];
  for (const w of reg) {
    const d = path.join(extDir, w.id, 'attrs'); if (!fs.existsSync(d)) continue;
    let sx = 0, sz = 0, n = 0;
    for (const f of fs.readdirSync(d).filter((x) => /^t_-?\d+_-?\d+\.json$/.test(x)).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); const ix = j.fields.indexOf('repX'), iz = j.fields.indexOf('repZ');
      for (const v of Object.values(j.byId)) if (Number.isFinite(v[ix]) && Number.isFinite(v[iz])) { sx += v[ix]; sz += v[iz]; n++; }
    }
    if (n) cs.push({ id: w.id, x: sx / n, z: sz / n, n });
  }
  const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
  const pts = cs.map((c) => ({ kind: 'ward-center', ward: c.id, x: c.x, z: c.z }));
  const seen = new Set();
  for (const c of cs) for (const o of cs.filter((o) => o !== c).sort((p, q) => dist(c, p) - dist(c, q)).slice(0, 2)) { const k = [c.id, o.id].sort().join('|'); if (seen.has(k)) continue; seen.add(k); pts.push({ kind: 'ward-border', ward: k, x: (c.x + o.x) / 2, z: (c.z + o.z) / 2 }); }
  const route = []; let cur = pts.find((p) => p.ward === 'kita') || pts[0], rest = pts.filter((p) => p !== cur); route.push(cur);
  while (rest.length) { rest.sort((p, q) => dist(cur, p) - dist(cur, q)); cur = rest.shift(); route.push(cur); }
  route.forEach((p, i) => { p.index = i; });
  return { route, wardsFound: cs.length };
}

export const rowKey = (r) => `${r.kind}|${r.ward}|${r.alt}`;
// 再開時に「確定済み」とみなす判定。not-loaded / camera-not-held は撮り直す(実在の欠落ではなく計測不成立のため)。
export const SETTLED = new Set(['ok', 'hole', 'covered-by-real']);

// 既存結果(--resume)の確定行を除いた、これから撮る (点, 高度) の一覧。--start-point は経路 index の下限。
export function pendingWork(route, alts, { startPoint = 0, prevRows = [] } = {}) {
  const done = new Set(prevRows.filter((r) => SETTLED.has(r.status)).map(rowKey));
  const work = [];
  for (const p of route) {
    if (p.index < startPoint) continue;
    const hs = alts.filter((h) => !done.has(rowKey({ kind: p.kind, ward: p.ward, alt: h })));
    if (hs.length) work.push({ point: p, alts: hs });
  }
  return work;
}

// 判定。lod0Share = LOD0 の表示/非表示フレーム差、realShare = 実LOD1/2 の表示/非表示フレーム差。
//   hole は「全タイルがロード済みで、LOD0 も実建物も画素に寄与しない」ときだけ。
//   LOD0 が 0 でも実建物が十分描かれているなら(LOD0 が実建物の下/背後に隠れている) covered-by-real として穴とは別に集計する。
export function classify({ held, loaded, lod0Share, realShare, minShare }) {
  if (!held) return 'camera-not-held';
  if (!loaded) return 'not-loaded';
  if (lod0Share >= minShare) return 'ok';
  return realShare >= minShare ? 'covered-by-real' : 'hole';
}

export function summarize(rows) {
  const cnt = (s) => rows.filter((r) => r.status === s).length;
  return {
    points: rows.length, ok: cnt('ok'), hole: cnt('hole'), coveredByReal: cnt('covered-by-real'), notLoaded: cnt('not-loaded'), cameraNotHeld: cnt('camera-not-held'),
    wardCentersCovered: new Set(rows.filter((r) => r.kind === 'ward-center').map((r) => r.ward)).size,
    borders: new Set(rows.filter((r) => r.kind === 'ward-border').map((r) => r.ward)).size,
  };
}

// 前回結果と今回の行を (kind|ward|alt) で統合(今回が優先)。
export function mergeRows(prevRows, newRows) {
  const m = new Map(); for (const r of prevRows) m.set(rowKey(r), r); for (const r of newRows) m.set(rowKey(r), r);
  return [...m.values()];
}

// ---- CI バッチ運用(ラベル経路で start-point を指定する) ----
// ラベル名 `run-mission213-qa` = 先頭(0)から、`run-mission213-qa:<n>` = 経路 index n から。厳密一致以外は null(workflow は失敗させる)。
export function parseBatchLabel(name) {
  const m = /^run-mission213-qa(?::(\d{1,3}))?$/.exec(String(name ?? ''));
  return m ? { startPoint: m[1] ? Number(m[1]) : 0 } : null;
}

// qa.json(e2e の --out)から PR コメント用の集計 Markdown を作る。原データは含めず、対象 index 範囲・判定・未検証点だけを出す。
export function renderBatchSummary(qa, meta = {}) {
  const s = qa?.sweep; const out = [];
  out.push(`### Mission213 QA バッチ (run ${meta.runId ?? '?'}, sha ${meta.sha ?? '?'})`);
  out.push(`- build: ${meta.build ?? '?'} (${meta.buildSec ?? '?'}s)  sweep: ${meta.sweep ?? '?'}  build size MB: ${meta.sizeMb ?? 'n/a'}`);
  if (!s) { out.push('- qa.json に sweep なし(build か e2e が失敗)'); return out.join('\n') + '\n'; }
  const rows = s.rows || [], idx = rows.map((r) => r.index).filter(Number.isFinite);
  const lo = idx.length ? Math.min(...idx) : null, hi = idx.length ? Math.max(...idx) : null;
  out.push(`- 経路: 全 ${s.routePlanned ?? '?'} 点 / 今回の開始 index ${s.startPoint ?? 0} / 撮影した index 範囲 ${lo ?? '-'}〜${hi ?? '-'} / wardsFound=${s.wardsFound}`);
  out.push(`- summary: ${JSON.stringify(s.summary)}  truncated=${s.truncated ?? 'なし'}`);
  const bad = rows.filter((r) => r.status !== 'ok' && r.status !== 'covered-by-real');
  out.push(`- 要確認(hole / not-loaded / camera-not-held): ${bad.length ? bad.map((r) => `#${r.index} ${r.ward}@${r.alt}m=${r.status}`).join(', ') : 'なし'}`);
  if (s.nextStartPoint != null) out.push(`- **次バッチ**: PR のラベルを外し \`run-mission213-qa:${s.nextStartPoint}\` を付与(未検証: index ${s.nextStartPoint} 以降)`);
  else out.push('- 経路の末尾まで到達(この開始 index 以降は全点撮影済み)。ただし先行バッチの結果と合わせて 0 から末尾まで揃ったかは各バッチ summary で確認すること');
  out.push('', '| index | kind | ward | alt | lod0Share | realShare | loaded | status |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${[r.index, r.kind, r.ward, r.alt, r.lod0Share, r.realShare, r.loaded, r.status].join(' | ')} |`);
  out.push('', '※ headless SwiftShader の値であり実機性能ではありません。24区全域の完成は、全バッチで hole/not-loaded 0 かつ末尾到達のときのみ。');
  return out.join('\n') + '\n';
}

// Mission 213: --cells の1セル分類(純関数。ブラウザ内にも toString() で埋め込むので外部参照・クロージャ禁止)。
//   in: {hidden, w:{x,y}|null(画面座標、物理px), W, H, d9, d3}  d9/d3 = セル中心の9x9/3x3 窓で
//   「LOD0のみ消した画」と「全タイル消した画」に差があるか(=実建物画素あり)。
//   out: 'hidden'(置換で非表示) | 'offscreen' | 'realUnder3'(3x3でも実建物あり=二重描画の強い疑い)
//        | 'realUnder9only'(9x9のみ=隣接建物の拾い=誤検知の可能性大) | 'noRealUnder'(実建物なし=fallback)
export function classifyCellPure(c) {
  if (c.hidden) return 'hidden';
  if (!c.w) return 'offscreen';
  const x = Math.round(c.w.x), y = Math.round(c.w.y);
  if (x < 4 || y < 4 || x >= c.W - 4 || y >= c.H - 4) return 'offscreen';
  if (c.d3) return 'realUnder3';
  if (c.d9) return 'realUnder9only';
  return 'noRealUnder';
}

// ---- 統一診断(Mission213): --cells(--lod)と --compare --resid-detail を「置換の適用状態が同じ」場合だけ比較できるようにする純関数群 ----
// 同一カメラ・同一ビルド・置換ON固定・安定待機完了の前提を、出力(swapState)から機械的に判定する。
export const swapKey = (s) => (s ? `${s.swapEnabled}|${s.hidden}|${s.visible}|${s.total}` : 'null');
// samples(時系列のスナップショット)の末尾 need 件が全て同一(hidden/visible/total/swapEnabled)かつ tilesLoaded なら安定。
export function swapStable(samples, need = 3) {
  if (!Array.isArray(samples) || samples.length < need) return false;
  const t = samples.slice(-need); return t.every((s) => s && s.tilesLoaded === true && swapKey(s) === swapKey(t[0]));
}
// 2つの診断(別モード/別時点)が数値比較可能か。不一致の理由を返す。置換OFF(または適用0)・カメラ差・viewport差は比較不可。
export function comparableDiag(a, b, camTol = 0.05) {
  const reasons = [];
  if (!a || !b) return { comparable: false, reasons: ['swapState 欠落'] };
  if (a.swapEnabled !== b.swapEnabled) reasons.push(`swapEnabled 不一致(${a.swapEnabled} vs ${b.swapEnabled})`);
  if (a.swapEnabled && a.hidden === 0) reasons.push('A: 置換有効だが hidden=0(置換未適用)');
  if (b.swapEnabled && b.hidden === 0) reasons.push('B: 置換有効だが hidden=0(置換未適用)');
  if (a.hidden !== b.hidden) reasons.push(`hidden 不一致(${a.hidden} vs ${b.hidden})`);
  if (a.visible !== b.visible) reasons.push(`visible 不一致(${a.visible} vs ${b.visible})`);
  if (a.camH && b.camH && Math.abs(a.camH - b.camH) > Math.max(a.camH, b.camH) * camTol) reasons.push(`camH 不一致(${a.camH} vs ${b.camH})`);
  const va = a.viewport || {}, vb = b.viewport || {};
  if (va.w !== vb.w || va.h !== vb.h) reasons.push(`viewport 不一致(${va.w}x${va.h} vs ${vb.w}x${vb.h})`);
  return { comparable: reasons.length === 0, reasons };
}
// ブラウザ内で評価する置換状態スナップショット(read-only。cells の f.show を数えるだけで状態は変えない)。
export const SWAP_SNAP_EXPR = `(()=>{const v=window.__v;if(!v)return null;const ps=(v.scene.primitives._primitives||[]).filter(p=>p.tilesLoaded!==undefined);const l0=ps.find(p=>p._lcCityLod0);const real=ps.filter(p=>!p._lcCityLod0);let hidden=0,visible=0;if(l0&&l0._lcCells)for(const arr of l0._lcCells.values())for(const c of arr){if(c.f.show)visible++;else hidden++}let sel=0,leaf=0;for(const p of real)for(const t of (p._selectedTiles||[])){if(!t.content)continue;sel++;if(!t.children||t.children.length===0)leaf++}const c=v.scene.canvas;const sw=new URLSearchParams(location.search).get('citylod0swap');const pf=(window.__mission37g&&window.__mission37g.perf)||{};return {swapEnabled:sw!=='0',swapInstalled:!!pf.cityLod0Swap,spheres:pf.cityLod0Swap?pf.cityLod0Swap.spheres:null,l0Show:l0?l0.show:null,hidden,visible,total:hidden+visible,selected:sel,selectedLeaf:leaf,tilesLoaded:ps.length>0&&ps.every(p=>p.tilesLoaded),camH:Math.round(v.camera.positionCartographic.height),viewport:{w:c.width,h:c.height,cw:c.clientWidth,ch:c.clientHeight,dpr:window.devicePixelRatio},tileFail:window.__tileFail||0}})()`;
