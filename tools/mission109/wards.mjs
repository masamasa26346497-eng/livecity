// Mission 109: strict whitelist of the 24 official Osaka City wards (N03 codes) + batch planning. Pure functions, no I/O.
// Expo site 27999 and anything else is refused. Source vintage must be 2025 (checked against source.json by the verifier).
export const OSAKA_WARDS = Object.freeze({
  miyakojima: '27102', fukushima: '27103', konohana: '27104', nishi: '27106', minato: '27107', taisho: '27108',
  tennoji: '27109', naniwa: '27111', nishiyodogawa: '27113', higashiyodogawa: '27114', higashinari: '27115', ikuno: '27116',
  asahi: '27117', joto: '27118', abeno: '27119', sumiyoshi: '27120', higashisumiyoshi: '27121', nishinari: '27122',
  yodogawa: '27123', tsurumi: '27124', suminoe: '27125', hirano: '27126', kita: '27127', chuo: '27128',
});
export const ALL_WARDS = Object.freeze(Object.keys(OSAKA_WARDS));
export const MAX_BATCH = 6;
export const DEFAULT_BATCH = 4;
export const PRIOR_RUN = { runId: '41776480060', wards: ['nishi', 'fukushima', 'yodogawa'], note: 'Mission108 Actions run reported success: fetch allVerified=true, headless QA allPass=true (3/24). Summaries are not stored in the repo.' };

// Accepts "ALL" (case-insensitive) or a comma list. Rejects unknown, duplicate, expo, malformed tokens. Returns wards in canonical order.
export function parseWards(input) {
  const raw = String(input == null ? '' : input).replace(/\s/g, '');
  if (!raw) throw new Error('no wards');
  if (raw.toUpperCase() === 'ALL') return [...ALL_WARDS];
  const seen = new Set();
  for (const w of raw.split(',')) {
    if (!w) throw new Error('empty ward token');
    if (/^27999/.test(w)) throw new Error('expo site refused');
    if (!/^[a-z]+$/.test(w)) throw new Error('invalid ward token');
    if (!Object.hasOwn(OSAKA_WARDS, w)) throw new Error('ward not in the 24-ward whitelist: ' + w);
    if (seen.has(w)) throw new Error('duplicate ward: ' + w);
    seen.add(w);
  }
  return ALL_WARDS.filter((w) => seen.has(w));
}
export function wardCodeOf(w) { if (!Object.hasOwn(OSAKA_WARDS, w)) throw new Error('unknown ward'); return OSAKA_WARDS[w]; }

export function planBatches(wards, size = DEFAULT_BATCH) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) throw new Error('batch size must be 1..' + MAX_BATCH);
  const out = [];
  for (let i = 0; i < wards.length; i += size) out.push(wards.slice(i, i + size));
  return out;
}
