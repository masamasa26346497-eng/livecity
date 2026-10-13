// Mission 37I: read-only audit of Google Places API usage across refs (Legacy vs New).
// Uses `git grep` only. No network, no writes. Usage: node tools/mission37i-audit-google-photo-api.cjs
const { execFileSync } = require('child_process');

const cwd = process.cwd();
const REFS = [
  'HEAD',
  'origin/feature/mission-36l-building-photo-linking',
  'origin/feature/mission-36j-osaka-24ward-google-places-expansion',
  'origin/feature/mission-36i-sumiyoshi-149-google-places-expansion',
  'origin/feature/mission-36h-google-places-photo-foundation',
  'origin/main',
];
const PATTERNS = {
  legacy: 'maps/api/place|photo_reference|photoreference|html_attributions|place/details/json|findplacefromtext|place/textsearch|place/nearbysearch|PlacesService',
  newApi: 'places\\.googleapis\\.com|skipHttpRedirect|authorAttributions|PAID_GOOGLE_PHOTOS_ENABLED|X-Goog-FieldMask',
};

function grep(ref, pattern) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-lIE', pattern, ref, '--', '.', ':!data', '*.js', '*.mjs', '*.cjs', '*.html'],
      { cwd, encoding: 'utf8', maxBuffer: 1 << 26 },
    );
    return out.split('\n').filter(Boolean).map((s) => s.slice(ref.length + 1));
  } catch (e) {
    return (e.stdout || '').split('\n').filter(Boolean).map((s) => s.slice(ref.length + 1));
  }
}

const result = {};
for (const ref of REFS) {
  result[ref] = {};
  for (const [k, p] of Object.entries(PATTERNS)) result[ref][k] = grep(ref, p);
}
console.log(JSON.stringify(result, null, 2));
