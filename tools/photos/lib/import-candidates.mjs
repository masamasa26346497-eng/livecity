// Issue #52: 公開写真候補の検証・重複除去・保留（純関数・外部通信なし）。
// 入力の候補は fixture / 既存キャッシュ / 記録済みレスポンスのアダプタ出力のいずれでもよい。取得そのものはこのモジュールの責務外。
// URL・作者・ライセンスの採用条件は public/mission52-photo-panel.js と共有（panel-shared.mjs）。画面と取り込みで条件がずれない。
import { commonsFile, photoEligibility } from './panel-shared.mjs';

// route: 'wikidata-p18' | 'commons-category' | 'commons-p180' | 'osm-explicit' | 'name-search' | 'geosearch'
//   個別の写真と建物の対応を示す「ファイル単位の明示リンク」を持てる経路だけが直接採用の対象:
//     wikidata-p18 : 建物の Wikidata 項目の代表画像（項目 = 建物が canonicalId と1対1で結ばれているとき）
//     commons-p180 : 写真の構造化データ「被写体(P180)」が建物の項目
//     osm-explicit : OSM 要素の wikimedia_commons=File:... / image=<Commons File URL>
//   commons-category / name-search / geosearch は「候補の取得」だけ。カテゴリ所属や近さは個別写真の建物一致を保証しない。
const DIRECT_ROUTES = new Set(['wikidata-p18', 'commons-p180', 'osm-explicit']);

// 照合根拠: 距離だけでは確定しない。矛盾（名称/住所/被写体）があれば直接リンクでも採用しない。
export function evaluateEvidence(c) {
  const ev = c.evidence || {};
  if (ev.nameConflict === true) return { ok: false, reason: 'name-conflict' };
  if (ev.addressConflict === true) return { ok: false, reason: 'address-conflict' };
  if (ev.subject === false) return { ok: false, reason: 'subject-conflict' };
  const signals = ['name', 'address', 'subject'].filter((k) => ev[k] === true);
  let direct = DIRECT_ROUTES.has(c.route) && ev.explicitLink === true;
  if (c.route === 'commons-p180') direct = direct && ev.subject === true; // P180 は被写体が確認できて初めて直接リンク
  if (direct) return { ok: true, basis: 'explicit-link' };
  if (signals.includes('name') && signals.length >= 2) return { ok: true, basis: signals.join('+') };
  if (c.route === 'commons-category') return { ok: false, reason: 'category-membership-only' };
  if (!signals.length && typeof ev.distanceM === 'number') return { ok: false, reason: 'distance-only' };
  return { ok: false, reason: 'insufficient-evidence' };
}

// existing: 既存索引 { byCanonicalId }。relocated: { canonicalId: [除外ファイル名] }。
export function importCandidates(candidates, existing, opts) {
  const o = opts || {};
  const relocated = o.relocated || {};
  const seenFiles = new Map(); // file -> canonicalId（既存 + 今回採用）
  for (const [id, e] of Object.entries((existing && existing.byCanonicalId) || {})) {
    for (const p of e.photos || []) { const f = commonsFile(p.sourcePageUrl); if (f) seenFiles.set(f, id); }
  }
  const existingFiles = new Set(seenFiles.keys());
  const adopted = [];
  const held = [];
  const dup = [];
  // 同名施設: 同じファイルが異なる canonicalId に向く場合は、どちらにも確定しない
  const claimants = new Map();
  for (const c of candidates) { const f = commonsFile(c.sourcePageUrl); if (!f) continue; if (!claimants.has(f)) claimants.set(f, new Set()); claimants.get(f).add(c.canonicalId); }

  for (const c of candidates) {
    const f = commonsFile(c.sourcePageUrl);
    const hold = (reason) => held.push({ canonicalId: c.canonicalId, file: f, route: c.route, reason });
    if (!c.canonicalId) { hold('no-canonical-id'); continue; }
    if (!f) { hold('invalid-source-url'); continue; } // Commons 以外のホスト・不正URLを含む
    // 画面と同じ表示可否（サムネURL・ライセンス・帰属必須の作者・ライセンスURL）
    const el = photoEligibility({ sourcePageUrl: c.sourcePageUrl, thumbnailUrl: c.thumbnailUrl, license: c.license, licenseUrl: c.licenseUrl, author: c.author });
    if (!el.ok) { hold(el.reason); continue; }
    if ((relocated[c.canonicalId] || []).includes(f)) { hold('relocation-excluded'); continue; }
    if (claimants.get(f).size > 1) { hold('same-file-multiple-buildings'); continue; }
    const ev = evaluateEvidence(c);
    if (!ev.ok) { hold(ev.reason); continue; }
    if (seenFiles.has(f)) {
      // 同じ Commons ファイルを複数経路・既存と二重計上しない
      if (seenFiles.get(f) === c.canonicalId) { dup.push({ canonicalId: c.canonicalId, file: f, route: c.route, duplicateOf: existingFiles.has(f) ? 'existing-index' : 'earlier-candidate' }); }
      else hold('file-already-assigned-to-other-building');
      continue;
    }
    seenFiles.set(f, c.canonicalId);
    const dateOk = /^\d{4}(-\d{2})?(-\d{2})?$/.test(String(c.takenAt || '')) && /^https:\/\/commons\.wikimedia\.org\//.test(String(c.dateEvidenceUrl || ''));
    adopted.push({
      canonicalId: c.canonicalId, file: f, route: c.route, evidenceBasis: ev.basis, kind: c.kind || 'unclassified',
      photo: { thumbnailUrl: c.thumbnailUrl, imageUrl: c.imageUrl, width: c.width, height: c.height, source: 'wikimedia-commons',
        title: 'File:' + f, sourcePageUrl: c.sourcePageUrl, license: c.license, licenseUrl: c.licenseUrl, author: c.author, kind: c.kind },
      takenAt: dateOk ? c.takenAt : null, dateEvidenceUrl: dateOk ? c.dateEvidenceUrl : null, // アップロード日は撮影日にしない
      fetchedAt: c.fetchedAt || null
    });
  }
  const buildingsBefore = new Set(Object.entries((existing && existing.byCanonicalId) || {}).filter(([, e]) => (e.photos || []).length).map(([k]) => k));
  const buildingsAfter = new Set([...buildingsBefore, ...adopted.map((a) => a.canonicalId)]);
  const byReason = {};
  held.forEach((h) => { byReason[h.reason] = (byReason[h.reason] || 0) + 1; });
  const byRoute = {};
  candidates.forEach((c) => { const r = byRoute[c.route] || (byRoute[c.route] = { candidates: 0, adopted: 0 }); r.candidates++; });
  adopted.forEach((a) => { byRoute[a.route].adopted++; });
  return {
    adopted, held, duplicates: dup,
    stats: { candidates: candidates.length, adopted: adopted.length, held: held.length, duplicates: dup.length, heldByReason: byReason, byRoute,
      buildingsWithPhotoBefore: buildingsBefore.size, buildingsWithPhotoAfter: buildingsAfter.size, netNewBuildings: buildingsAfter.size - buildingsBefore.size,
      adoptedWithKnownDate: adopted.filter((a) => a.takenAt).length }
  };
}

// 採用結果を索引へ接続する（純関数・入力は変更しない）。既存の写真は削除しない。
//   既存エントリ: 写真を追記（同一ファイルは追記しない）。
//   エントリが無い建物: registry[canonicalId] がある場合のみ、HIGH で新規エントリを作る（根拠は evidenceBasis として保存）。無ければ保留。
export function mergeIntoIndex(index, adopted, registry) {
  const out = JSON.parse(JSON.stringify(index));
  out.byCanonicalId = out.byCanonicalId || {};
  const unattached = [];
  for (const a of adopted) {
    let e = out.byCanonicalId[a.canonicalId];
    if (!e) {
      const reg = registry && registry[a.canonicalId];
      if (!reg) { unattached.push({ canonicalId: a.canonicalId, file: a.file, reason: 'no-index-entry-or-registry' }); continue; }
      e = out.byCanonicalId[a.canonicalId] = Object.assign({ canonicalId: a.canonicalId, matchConfidence: 'HIGH', matchMethod: 'issue52-' + a.route, matchReason: a.evidenceBasis, photos: [] }, reg);
    }
    e.photos = e.photos || [];
    if (e.photos.some((p) => commonsFile(p.sourcePageUrl) === a.file)) continue;
    e.photos.push(Object.assign({}, a.photo, { issue52: { route: a.route, evidenceBasis: a.evidenceBasis, takenAt: a.takenAt, dateEvidenceUrl: a.dateEvidenceUrl, fetchedAt: a.fetchedAt } }));
  }
  return { index: out, unattached };
}
