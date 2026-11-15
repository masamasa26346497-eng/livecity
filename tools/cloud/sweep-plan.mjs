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
