# Mission 36L implementation status

## Goal

Connect a clicked Live City canonical building to a VERIFIED Google Place through exact OSM source identity, then resolve Google Places photos only at display time.

The durable chain is:

`canonical buildingId -> exact OSM sourceId -> facilityId -> VERIFIED googlePlaceId`

No nearest-building guess, fuzzy-name-only attachment, Google photo resource name, media URL, photo binary, review, or rating is persisted in the building linkage artifact.

## Google Places building-source matching

The safe building-source matching pass is drained for all 9,498 eligible OSM `way` / `relation` candidates. The per-ward final counts sum to:

- VERIFIED building-source candidates: 5,428
- unresolved / ambiguous building-source candidates: 4,070
- unattempted building-source candidates: 0

The citywide facilities mapping contains additional verified POI/node records; those are not automatically treated as canonical building matches.

## Implemented

- `tools/google-places/match-building-source-places.mjs`
  - matches eligible OSM building sources under the 120 m safety ceiling
  - persists VERIFIED linkage only
  - preserves exact OSM source identity
- `tools/photos/build-building-google-place-index.mjs`
  - converts exact Mission 35O building provenance into a canonical building -> Google Place index
  - rejects multiple distinct Google Places for one building
  - persists no photo media data
- `public/livecity-building-photo-bridge.js`
  - loads the exact building-place index in dev preview
  - fetches Place details/photos on demand with the local browser-restricted API key
  - leaves unsafe name fallback disabled by default
- `tools/photos/prepare-mission36l-building-photo-linking.mjs`
  - one-shot local finalization command
  - validates VERIFIED-only / exact-source-only / no-photo-media policy after generation
- `tests/mission36l-building-google-place-index.test.js`
  - covers exact node/way/relation conversion, VERIFIED-only linkage, ambiguity rejection, same-Place deduplication, and no persisted media URL/resource name

## Remaining blocker

The full Mission 35O building provenance artifact is intentionally local and is not committed in the GitHub branch:

`data/processed/osaka-city/derived/building-facility-index.json`

The compact public building tiles contain canonical geometry IDs but do not contain the exact OSM source identity needed for this safe join. Therefore GitHub-only generation must not guess the linkage.

On a local checkout that has the Osaka raw/build inputs, run:

```powershell
node tools/build-building-facility-index.js
node tools/photos/prepare-mission36l-building-photo-linking.mjs
```

The second command writes and validates:

`public/map-data/osaka-city/derived/building-google-place-index.json`

After that artifact is generated, commit it on `feature/mission-36l-building-photo-linking` and verify building click -> photo display in the dev preview.

## Completion criteria

Mission 36L is complete only when the generated exact `building-google-place-index.json` is committed, runtime click/photo behavior is verified against that artifact, tests pass, and the feature branch is ready for review/merge.
