# Mission 36H — Google Places photo foundation

## Purpose

Build a Google Places photo foundation that raises photo coverage for user-relevant
buildings/facilities (hotels, restaurants, retail, offices, hospitals, schools, public
facilities, stations, tourism/cultural sites, temples/shrines, prominent residential
towers), without touching the existing Wikimedia/footprint photo system from Mission
35Z/36A, without modifying protected production HTML, and without persisting any Google
photo binaries or long-lived photo URLs.

This mission is explicitly a **foundation**, not a citywide rollout: a small curated
pilot set (30 facilities), conservative matching, and a fetch-at-display-time client.

## Files changed

New:

- `tools/google-places/lib/relevant-categories.mjs` — maps existing facility
  category/subcategory to the relevance classes named in the mission brief.
- `tools/google-places/lib/field-mask.mjs` — minimal Google Places API (New) field
  masks for Text Search / Place Details, wildcard-forbidding `buildFieldMaskHeader()`,
  and the 3–5 photo-per-place clamp.
- `tools/google-places/lib/persistence-guard.mjs` — `ALLOWED_DURABLE_FIELDS` allowlist
  and `assertDurableRecordSafe()`, which throws if a record about to be written contains
  a photo binary, a Google photo/media URL, base64 image data, or a resource name stored
  as if permanent.
- `tools/google-places/lib/rate-guard.mjs` — request de-duplication (in-flight promise
  map), a rolling-window rate limit, and a session-total request cap.
- `tools/google-places/lib/pilot-matching.mjs` — conservative candidate/Place matcher
  (coordinate distance + name agreement; multiple or conflicting candidates stay
  `AMBIGUOUS`, no candidates stay `UNRESOLVED`, only an unambiguous name+coordinate
  agreement becomes `VERIFIED`).
- `tools/google-places/lib/places-client.mjs` — thin Google Places API (New) client
  (Text Search, Place Details, Photo media) with injectable `fetchImpl` for testing,
  `isEnabled()` no-key short-circuit, and field-mask/photo-count enforcement.
- `tools/google-places/load-api-key.mjs` — reads `GOOGLE_PLACES_API_KEY` from the
  environment; returns `null` (never throws) when unset.
- `tools/google-places/match-pilot-places.mjs` — CLI/library entry point that resolves
  the pilot candidates against the real API and writes only `VERIFIED` records to the
  durable mapping, guarded by `assertDurableRecordSafe()`.
- `data/photos/google-places-pilot-candidates.json` — 30 curated pilot facilities.
- `public/map-data/osaka-city/derived/google-places-pilot-mapping.json` — durable
  mapping output location (force-added despite the broad `public/map-data/osaka-city/**`
  ignore rule, same pattern as `building-photo-index.json`). Currently a `pending`
  scaffold (see "What could not be run here" below).
- `public/local-config.example.js` — template for the browser-side API key config file.
- `tests/mission36h-google-places-foundation.test.js` — 27 tests.
- `MISSION36H_REPORT.md` — this file.

Modified:

- `public/osaka_3d_buildings.ward-ux-v1.html` (**dev artifact only** — not production,
  not protected) — adds the `GooglePlacesPhoto` module, `#fc-google-photo-section` /
  `#fc-google-photo-debug` markup and CSS, a `<script src="local-config.js">` include,
  and one call site (`GooglePlacesPhoto.fillFacilityCard(record)` inside
  `showExtendedFacilityCard`).
- `.env.example` — documents `GOOGLE_PLACES_API_KEY`.
- `.gitignore` — ignores `/public/local-config.js` (the real, non-committed key file).
- `package.json` — adds `data:google-places:match-pilot` script and registers the new
  test file in `npm test`.

**Not touched:** `public/osaka_3d_buildings.html` (production) and
`public/osaka_3d_buildings.fullward-v3.html` (protected). Confirmed by a dedicated test
that greps both files for `GooglePlacesPhoto` and asserts it is absent.

## Why the facility card, not the building property card

Mission 35Z/36A's Wikimedia system (`BuildingPhoto`) attaches photos to **building
footprints** (`canonicalId`) and renders inside `#prop-card` / `#pc-photo-section`.
The existing codebase already has a second, independent card —
`showExtendedFacilityCard(record)` / `#facility-card` — for **facility POIs**
(`FacilityDataStore`, backed by `data/processed/osaka-sumiyoshi/facilities/facilities.json`
whose `id` field, e.g. `osm-node-1422980350`, is a stable per-facility key already used
in the UI). Google Places is specified as a "facility-photo layer," so this foundation
hooks into that existing, separate facility card rather than overloading the building
card. This keeps the two sources structurally isolated: `GooglePlacesPhoto` never
touches `#pc-photo-section` or `#bldg-photo-card` (enforced by a test), and Wikimedia's
building-exterior identity is never at risk of being overwritten.

## Pilot facility set (30)

`osaka-sumiyoshi` (住吉区・東住吉区・平野区) is a residential-ward dataset, so it has no
OSM records for hotels, restaurants, large commercial complexes, or high-rise residential
towers. Rather than inventing plausible-looking facilities for those classes, the pilot
draws only real, already-verified records from
`data/processed/osaka-sumiyoshi/facilities/facilities.json` (OSM via Overpass API, ODbL
1.0), covering the classes that do exist there:

| relevanceClass | count | examples |
|---|---|---|
| hospital | 5 | あびこ病院, 錦秀会阪和住吉総合病院, 四恩学園診療所 |
| school | 8 | 市立矢田小学校, 城南学園高等学校, 近畿測量専門学校 |
| station | 2 | 矢田, 我孫子町 |
| public-facility | 8 | 住吉区役所, 大阪市立住吉図書館, 東住吉警察署矢田駅前交番 |
| retail-commercial | 3 | スーパー玉出 アビコ店, ライフ, デイリーカナートイズミヤ |
| office | 2 | りそな銀行, のぞみ信用組合 |
| temple-shrine | 1 | 式内大社 中臣須牟地神社 |
| hotel / restaurant / residential-tower | 0 | not present in this area's dataset |

A test (`パイロット候補30件は実在する facilities.json のレコードそのもの`) cross-checks
every candidate's `facilityId`/`name`/`expectLat`/`expectLon` against the live
`facilities.json` record and fails if any value was fabricated or drifted.

## What could not be run here (environment separation)

Per `CLAUDE.md`'s environment-separation table, this sandbox has no network access.
Resolving the pilot against the real Google Places API requires both network access and
a `GOOGLE_PLACES_API_KEY`, so — like `data:download`/`data:check-sources` — it cannot run
here. `public/map-data/osaka-city/derived/google-places-pilot-mapping.json` is committed
as a `"pending": true` scaffold with `entries: []`. To actually populate it:

```bash
GOOGLE_PLACES_API_KEY=xxxx npm run data:google-places:match-pilot
```

This calls Text Search for each of the 30 candidates, applies the conservative matcher,
writes only `VERIFIED` records to the mapping file, and writes
`data/reports/mission36h-google-places-pilot/pilot-match-report.json` with per-candidate
unresolved reasons and API usage counters. Until that is run, the pilot's real
verified-mapping count, photo-bearing count, and unresolved reasons are not yet known —
reported here as designed-and-tested-but-not-yet-executed-against-the-live-API.

**I was also unable to execute `npm test` / `node --test` myself in this session** — every
`node ...` invocation (including `node --version`-adjacent commands like `--check`)
required interactive approval that isn't available to this automated run. I instead did a
full manual trace of each new pure function against every test assertion (values,
branches, regex anchors), verified the 30 candidate records byte-for-byte against
`facilities.json` via search tools, and reviewed the HTML diff line-by-line for balanced
braces/tags and non-duplicate ids. **Please run `npm test` (and ideally
`node --test tests/mission36h-google-places-foundation.test.js` on its own) and let me
know if anything fails** — I can fix it in a follow-up, but could not confirm a green run
myself. If this keeps happening across missions, allowing plain `node` invocations in
`--allowedTools` would let me verify future changes directly.

## API-call model

- **Matching (build time, local/CI only):** one Text Search call per pilot candidate
  (30 calls total for this pilot). Never called from the browser.
- **Display (runtime, on demand):** opening a facility card whose `record.id` is in the
  durable mapping triggers one Place Details call (cached per `googlePlaceId` for the
  session) and up to `MAX_PHOTOS` (4) Photo Media calls. Re-opening the same facility
  reuses the in-memory cache; concurrent opens of the same facility de-duplicate to a
  single in-flight request. A session cap (`MAX_CALLS_PER_SESSION = 60`) stops further
  calls even if many different facilities are opened in one session.
- Facilities **not** in the pilot mapping trigger zero calls — the section stays hidden.
- No citywide/bulk photo pass exists anywhere in this code.

## Cost-control behavior

- Field masks (`SEARCH_FIELD_MASK` / `DETAILS_FIELD_MASK`) request only the fields this
  feature actually uses — no reviews, opening hours, price level, or ratings.
  `buildFieldMaskHeader()` throws on any wildcard.
- Photos per place are hard-capped to 3–5 (default 4) both server- and client-side
  (`clampPhotoCount`, `MAX_PHOTOS`).
- Request de-duplication + rolling-window + session-total caps exist in both the Node
  client (`rate-guard.mjs`, used by the matching CLI) and the browser module (inlined
  `scheduleCall`, used by the dev HTML).
- A visible debug counter (`#fc-google-photo-debug`, `window.__GOOGLE_PLACES_PHOTO_DEBUG__`)
  shows live API-call/cache-hit counts whenever a key is configured.

## No-key / no-photo behavior

- `createPlacesClient({ apiKey: null })` returns `{ ok:false, reason:'no-api-key' }` from
  every method without ever invoking `fetchImpl` — verified by a test that would fail if
  `fetch` were called.
- `runPilotMatch()` with no key returns `{ ok:false, reason:'no-api-key' }` and performs
  no matching, no writes.
- In the dev HTML, `GooglePlacesPhoto.fillFacilityCard()` hides `#fc-google-photo-section`
  immediately if no key is configured (`public/local-config.js` absent or empty) — no
  error thrown, the rest of the facility card renders normally.
- If a key is configured but a facility isn't in the pilot mapping, or the API returns
  zero photos, the section either stays hidden or shows an explicit "no photo found"
  message — never silently reuses another facility's photo.

## Persistence policy (enforced, not just documented)

`ALLOWED_DURABLE_FIELDS` = `facilityId, googlePlaceId, name, relevanceClass,
matchConfidence, matchReason, distanceMeters, verifiedAt, verifiedBy`. Anything else —
and specifically anything matching `/photo|imageData|base64|binary|thumbnailUrl|
mediaUrl|resourceName/i` in its key, or a `googleusercontent.com`/`.../media` URL or
`data:image/` URI in its *value* — is rejected by `assertDurableRecordSafe()`, which the
write path in `match-pilot-places.mjs` always calls before touching disk. The browser
module never writes to `localStorage`/`sessionStorage`/`indexedDB` (checked by a test);
its only cache is an in-memory `Map` that disappears on reload, and it re-fetches photo
media from Google at display time every session.

## Attribution / branding behavior

Each rendered Google photo shows a blue "Google" badge, the photo's author attribution
(as a link when Google supplies one, otherwise "Google ユーザーの投稿"), and a footer
with a "Google マップで見る" link to `googleMapsUri` plus the internal match-confidence/
reason. The section is visually distinct from the Wikimedia section (separate container,
green accent border vs. the Wikimedia section's default styling, separate "Google" vs.
"Wikimedia Commons" source labels).

**Deployment follow-up required before shipping to real users:** review Google Maps
Platform's Places API Terms of Service and the "Google Places photo attribution"
requirements in full (in particular whether the current text-badge approach satisfies
the current branding guidelines or whether the official Google logo asset is required),
confirm the browser-side API key is restricted by HTTP referrer to this site's origin
and to Places API (New) only, and set up billing/budget alerts before any real key is
issued — none of this can be verified from this sandbox.

## Regression

- `tests/mission36h-google-places-foundation.test.js` includes a direct check that the
  Wikimedia `BuildingPhoto` block (URL, `matchConfidence !== 'high'` gate) is unchanged,
  and that `GooglePlacesPhoto` never references `#pc-photo-section` / `#bldg-photo-card`.
- Existing Wikimedia/footprint tests (`mission35z-building-photo-preview.test.js`,
  `mission36a-footprint-photo-matching.test.js`, `mission36f-citywide-photo-index.test.js`)
  were not modified.
- `public/osaka_3d_buildings.html` and `public/osaka_3d_buildings.fullward-v3.html` are
  untouched (git diff shows zero changes to either file).

## Mission independence

This branch is based on `feature/mission-36a-footprint-photo-matching` and does not merge,
cherry-pick, or reference Mission 36G work.

`.github/mission-36h-trigger.txt` removed.
