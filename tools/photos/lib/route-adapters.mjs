// Issue #52: 取得経路ごとの「記録済みレスポンス → 統一候補」アダプタ（純関数・外部通信なし）。
// 段階:  (1) 経路アダプタ  → 参照 refs { route, file, canonicalId, evidence, ... }   ← 「どのファイルが、なぜ候補か」
//        (2) enrichRefs     → Commons imageinfo レスポンスと突き合わせ、ライセンス/作者/サムネ/撮影日と名称・住所の照合信号を付けた統一候補
//        (3) importCandidates（import-candidates.mjs）→ 採用 / 保留 / 重複
//        (4) mergeIntoIndex → 索引へ接続
// 取得（ネットワーク）は別工程。ここは Wikidata wbgetentities / Commons API / Overpass の JSON 形式だけを前提にする。
// 既存の build-building-photo-index.mjs は実行時に API を直接叩く単体スクリプトで関数を export していないため、
// ネットワークを伴わない変換だけをここに置く（取得処理は複製しない）。
import { commonsFile, plainText } from './panel-shared.mjs';

const normText = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s_　・･\-–—.,，、。()（）]/g, '').toLowerCase();
const fileOfTitle = (t) => { const m = String(t || '').match(/^File:(.+)$/); return m ? m[1].replace(/_/g, ' ').trim() : null; };
const uniqBy = (arr, key) => { const s = new Set(); return arr.filter((x) => { const k = key(x); if (s.has(k)) return false; s.add(k); return true; }); };

// ── (1-a) Wikidata wbgetentities → P18（代表画像）
//   qidToCanonical: { Qxxx: canonicalId | [canonicalId...] }。1つの Q が複数の建物に結ばれている場合は、どれにも確定しない。
export function fromWikidataEntities(json, qidToCanonical) {
  const refs = [], skipped = [];
  for (const [qid, ent] of Object.entries((json && json.entities) || {})) {
    const p18 = ((ent && ent.claims && ent.claims.P18) || []).filter((c) => c.rank !== 'deprecated');
    if (!p18.length) continue;
    const m = (qidToCanonical || {})[qid];
    const ids = Array.isArray(m) ? m : m ? [m] : [];
    if (ids.length !== 1) { skipped.push({ qid, reason: ids.length ? 'qid-multiple-buildings' : 'qid-unmapped' }); continue; }
    for (const c of p18) {
      const v = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
      if (typeof v !== 'string' || !v.trim()) continue;
      refs.push({ route: 'wikidata-p18', canonicalId: ids[0], file: v.replace(/_/g, ' ').trim(), qid, evidence: { explicitLink: true } });
    }
  }
  return { refs, skipped };
}

// ── (1-b) Commons カテゴリ所属 (list=categorymembers) → 候補のみ。カテゴリ所属は個別写真の建物一致を保証しない
export function fromCommonsCategoryMembers(json, { canonicalId, category }) {
  const members = ((json && json.query && json.query.categorymembers) || []).filter((m) => m.ns === 6);
  return { refs: members.map((m) => ({ route: 'commons-category', canonicalId, file: fileOfTitle(m.title), category, evidence: { categoryLink: true } })).filter((r) => r.file), skipped: [] };
}

// ── (1-c) Commons 検索 (list=search)。haswbstatement:P180=Q.. は被写体の構造化データ、それ以外は名称/住所検索
export function fromCommonsSearch(json, { canonicalId, route }) {
  if (route !== 'commons-p180' && route !== 'name-search') throw new Error('route must be commons-p180 or name-search');
  const hits = ((json && json.query && json.query.search) || []).filter((m) => m.ns === 6);
  const evidence = route === 'commons-p180' ? { explicitLink: true, subject: true } : {};
  return { refs: hits.map((m) => ({ route, canonicalId, file: fileOfTitle(m.title), evidence: Object.assign({}, evidence) })).filter((r) => r.file), skipped: [] };
}

// ── (1-d) Commons geosearch → 近傍候補のみ（距離だけでは採用されない）
export function fromCommonsGeosearch(json, { canonicalId }) {
  const hits = ((json && json.query && json.query.geosearch) || []).filter((m) => m.ns === 6);
  return { refs: hits.map((m) => ({ route: 'geosearch', canonicalId, file: fileOfTitle(m.title), evidence: { distanceM: typeof m.dist === 'number' ? m.dist : undefined } })).filter((r) => r.file), skipped: [] };
}

// ── (1-e) OSM（Overpass）の明示タグ
//   wikimedia_commons=File:X / image=<Commons ファイルページURL> → osm-explicit（ファイル単位の明示リンク）
//   wikimedia_commons=Category:X → カテゴリ参照のみ（categoryRefs。ファイルは別途 categorymembers を取得し commons-category として扱う）
//   wikidata=Q → wikidataRefs（P18 は fromWikidataEntities で扱う）
//   image=<Commons 以外のURL> → 個別の権利確認ができないので採用しない
//   osmToCanonical: { 'way/123': canonicalId }
export function fromOverpassElements(json, osmToCanonical) {
  const refs = [], categoryRefs = [], wikidataRefs = [], skipped = [];
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    const key = el.type + '/' + el.id;
    if (!(tags.wikimedia_commons || tags.image || tags.wikidata)) continue;
    const canonicalId = (osmToCanonical || {})[key];
    if (!canonicalId) { skipped.push({ osm: key, reason: 'osm-element-unmapped' }); continue; }
    const wc = tags.wikimedia_commons;
    if (typeof wc === 'string' && /^File:/i.test(wc)) refs.push({ route: 'osm-explicit', canonicalId, file: fileOfTitle('File:' + wc.slice(5)), osm: key, evidence: { explicitLink: true } });
    else if (typeof wc === 'string' && /^Category:/i.test(wc)) categoryRefs.push({ canonicalId, category: wc.replace(/^Category:/i, '').replace(/_/g, ' ').trim(), osm: key });
    if (typeof tags.image === 'string') {
      const f = commonsFile(tags.image);
      if (f) refs.push({ route: 'osm-explicit', canonicalId, file: f, osm: key, evidence: { explicitLink: true } });
      else skipped.push({ osm: key, reason: 'external-image-url-rights-unverified', url: String(tags.image).slice(0, 200) });
    }
    if (typeof tags.wikidata === 'string' && /^Q\d+$/.test(tags.wikidata)) wikidataRefs.push({ qid: tags.wikidata, canonicalId, osm: key });
  }
  return { refs, categoryRefs, wikidataRefs, skipped };
}

// ── (2) Commons imageinfo (prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=..) の解析
//   ライセンス名からライセンスURL/版を推測しない。extmetadata に無ければ null のまま（→ import 側で保留）。
export function parseImageInfo(json) {
  const out = new Map();
  for (const page of Object.values((json && json.query && json.query.pages) || {})) {
    const ii = page && page.imageinfo && page.imageinfo[0];
    const file = fileOfTitle(page && page.title);
    if (!file || !ii) continue;
    const v = (k) => (ii.extmetadata && ii.extmetadata[k] && typeof ii.extmetadata[k].value === 'string' ? ii.extmetadata[k].value : null);
    const taken = (v('DateTimeOriginal') || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/); // 形式が日付として読めるものだけ。アップロード日(DateTime)は使わない
    out.set(file, {
      thumbnailUrl: ii.thumburl || null, imageUrl: ii.url || null, width: ii.thumbwidth || null, height: ii.thumbheight || null,
      sourcePageUrl: ii.descriptionurl || null,
      license: v('LicenseShortName') || null, licenseUrl: v('LicenseUrl') || null,
      author: plainText(v('Artist') || '', 200) || null,
      description: plainText(v('ImageDescription') || '', 400),
      takenAt: taken ? taken[1] : null
    });
  }
  return out;
}

// ── (2) refs + imageinfo + 建物情報 → 統一候補
//   buildings: { canonicalId: { names:[正式名/旧称/別名/英語名], addressTokens:[住所の特徴語], otherNames:[同一カテゴリ・近傍の別建物の名称], otherAddressTokens:[] } }
//   名称/住所は「ファイル名と説明文」だけを根拠にする（カテゴリ名・検索語は根拠にしない）。
export function enrichRefs(refs, imageInfo, buildings, opts) {
  const o = opts || {};
  const candidates = [], unresolved = [];
  for (const r of uniqBy(refs, (x) => x.canonicalId + '|' + x.route + '|' + x.file)) {
    const info = imageInfo.get(r.file);
    if (!info) { unresolved.push({ canonicalId: r.canonicalId, file: r.file, route: r.route, reason: 'no-imageinfo' }); continue; }
    const b = (buildings || {})[r.canonicalId] || {};
    const text = normText(r.file + ' ' + info.description);
    const has = (list) => (list || []).some((n) => normText(n).length >= 2 && text.includes(normText(n)));
    const own = has(b.names), other = has(b.otherNames);
    const addr = has(b.addressTokens), otherAddr = has(b.otherAddressTokens);
    const ev = Object.assign({}, r.evidence);
    if (own && !other) ev.name = true;
    if (other && !own) ev.nameConflict = true;      // 別の建物の名称だけが写真に現れる（カテゴリ内の別建物など）
    if (addr && !otherAddr) ev.address = true;
    if (otherAddr && !addr) ev.addressConflict = true;
    candidates.push({
      canonicalId: r.canonicalId, route: r.route, category: r.category, qid: r.qid, osm: r.osm,
      thumbnailUrl: info.thumbnailUrl, imageUrl: info.imageUrl, width: info.width, height: info.height, sourcePageUrl: info.sourcePageUrl,
      license: info.license, licenseUrl: info.licenseUrl, author: info.author,
      takenAt: info.takenAt, dateEvidenceUrl: info.takenAt ? info.sourcePageUrl : null, fetchedAt: o.fetchedAt || null,
      evidence: ev
    });
  }
  return { candidates, unresolved };
}
