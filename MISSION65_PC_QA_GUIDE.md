# Mission 65: Windows PC QA guide (collect the screen where the seam looks wrong)

Goal: capture **evidence** of building-foot / road-edge / water-edge mismatches on your own PC.
This guide does not claim a cause. The cause of the seam is **undetermined** until screenshots + JSON from your PC are compared.
Nothing here calls external services from Claude; the browser on your PC loads the site (and the GSI basemap) as it normally would.

Every command and JS name below exists in the source (file in parentheses).

## 0. Which URL?

| Where | QA hooks (`window.__mission37dQA`) | What to do |
|---|---|---|
| Vercel Preview (`https://livecity-git-claude-issue-23-...vercel.app/`) | **Disabled.** The hook block only runs on `localhost` / `127.0.0.1` with `?qa=1` (`public/mission37g-osaka-24ward-mvp.html`, the `if (/^(localhost\|127\.0\.0\.1)$/...` block). | Only take a normal screenshot and copy the full URL (section 6). |
| Local server (below) | Enabled with `?qa=1` | Sections 1-5. |

## 1. Start the local server (existing checkout, PowerShell 5.1 OK)

Needs Node 18+ (`node -v`). From the repo root:

```powershell
git fetch origin
git merge --ff-only origin/claude/issue-23-20261007-1424
node tools\mission40f-serve-local.cjs --port 8137
```

- `--ext` is optional since Mission 65 (public/ only is enough for Sumiyoshi). It is read-only, bound to 127.0.0.1, GET/HEAD only (`tools/mission40f-serve-local.cjs`).
- Needed files are already in Git: `public/mission37g-osaka-24ward-mvp.html`, `public/mission37c-layers/osaka-sumiyoshi-9tile/`, `public/mission37b-3dtiles/osaka-sumiyoshi-9tile/`. Nothing else to download.
- Stop with Ctrl+C.

Open in Chrome (the URL the A/B script uses, `tools/experiments/mission64_ab_qa.mjs`):

```
http://127.0.0.1:8137/mission37g-osaka-24ward-mvp.html?qa=1&basemap=gsi-pale&extra=0&fac=0&bw=27120&vcull=0&panel=0
```

- `basemap=gsi-pale|gsi-blank|osm|none` selects the background. Use the one you saw the problem on.
- `bw=27120` mounts Sumiyoshi buildings only. `panel=0` hides side panels.
- Wait until the loading overlay is gone, then F12 -> Console.

## 2. Record the state (read-only)

In the Console:

```js
JSON.stringify(__mission37dQA.snapshot(), null, 2)
```

`snapshot()` returns camera (lon, lat, heightM, headingDeg, pitchDeg, fovDeg, canvas, dpr), globe (show, tilesLoaded, tilesToRenderByLevel = background LOD), layer visibility/counts (`roads, waterways, parks, railways, gsiroadedge, gsiwater`), per-tileset `ready/tilesLoaded`.
To copy to the clipboard: `copy(JSON.stringify(__mission37dQA.snapshot(), null, 2))` (Chrome DevTools `copy()`), then paste into a text file.

Also run: `__mission37dQA.renderInfo()` and `__mission37dQA.renderErrors()` (Cesium render-stop errors; should be `[]`).

## 3. Same-camera A/B (one camera, toggle one thing at a time)

Placing the camera needs local x,z (metres). From lat/lon (same constants as `geoToThree`, CLAT=34.604208, CLON=135.525020, MPD=111320):

```js
const ll = (lat, lon) => [(lon - 135.525020) * Math.cos(34.604208 * Math.PI / 180) * 111320, -((lat - 34.604208) * 111320)];
const [x, z] = ll(34.6044, 135.5051);   // Hanwa hospital; put YOUR anomaly lat/lon here first
__mission37dQA.lookAtLocal(x, z, 0, 450, -90, 0);   // (x, z, h, range, pitchDeg, headingDeg)  top view
// oblique: __mission37dQA.lookAtLocal(x, z, 0, 450, -45, 0)
```

Do **not** move the camera between steps. Before each screenshot wait until
`__mission37dQA.tilesReady() && __mission37dQA.snapshot().globe.tilesLoaded` is `true`, then ~2 s more.
Reset between states:

```js
const L = ['roads','waterways','parks','railways','gsiroadedge','gsiwater'];
const reset = () => { L.forEach(id => __mission37dQA.setLayer(id, true)); __mission37dQA.setGlobe(true); __mission37dQA.setBuildingSlice(null,null); __mission37dQA.setBuildingColor(null); __mission37dQA.setTilesetShow(true); };
const only = (on) => { L.forEach(id => __mission37dQA.setLayer(id, on.includes(id))); };
```

| Step | Question | Console |
|---|---|---|
| 00 | baseline | `reset()` |
| (a1) | building foot (0-2 m) | `only([]); __mission37dQA.setBuildingColor('#ff00ff'); __mission37dQA.setBuildingSlice(null, 2)` |
| (a2) | roof (>=12 m) | `only([]); __mission37dQA.setBuildingColor('#ff00ff'); __mission37dQA.setBuildingSlice(12, null)` |
| (b1) | OSM road **centre lines** only (no road surface exists) | `reset(); only(['roads']); __mission37dQA.setTilesetShow(false)` |
| (b2) | GSI road **edges** only | `only(['gsiroadedge']); __mission37dQA.setTilesetShow(false)` |
| (c) | water + parks | `only(['waterways','parks','gsiwater']); __mission37dQA.setTilesetShow(false)` |
| (d1) | background only | `only([]); __mission37dQA.setTilesetShow(false)` |
| (d2) | Globe/background OFF, everything else ON | `reset(); __mission37dQA.setGlobe(false)` |

Compare foot (a1) and roof (a2) against background only (d1): a roof offset from the foot at oblique angles is perspective parallax, not necessarily a position error. `__mission37dQA.setFov(10)` (narrow FOV, then lookAtLocal with a larger range, e.g. 3000) approximates orthographic view.
Always `reset()` at the end. These toggles only change display; data and coordinates are not modified.

Optional single-point probes (read-only): `__mission37dQA.project(x, z, h)` (screen point), `__mission37dQA.pickLocal(px, py)` (local x,z,h of the rendered surface at a screen point), `__mission37dQA.pickId(px, py)` (canonicalId).

Example targets: Hanwa hospital 34.6044, 135.5051; Sumiyoshi Taisha pond (the A/B script computes it as the water x park overlap centroid, so use your own reported spot instead). **Your anomaly spot has priority.**

## 4. Screenshots and JSON

- Screenshot: DevTools `Ctrl+Shift+P` -> "Capture screenshot" (viewport), once per state, name them `00-all`, `a1-foot`, ... 
- JSON: the `snapshot()` output from section 2 for each state you captured (at least baseline and the state where the seam is visible).
- Write down: lat/lon of the anomaly, which basemap, and camera (`snapshot().camera`).

## 5. Errors

- Console tab: copy red entries (right click -> Save as...). No login info or tokens are printed by this page.
- Network tab: filter `Status` 4xx/5xx or tick "Failed"; screenshot the list. Expected external hosts: `cdn.jsdelivr.net` (Cesium), `cyberjapandata.gsi.go.jp` (GSI tiles).
- Optionally `__mission37dQA.renderErrors()`.

## 6. On the Vercel Preview (no hooks)

Take a screenshot of the anomaly, copy the address-bar URL, note the lat/lon and zoom/tilt in words, plus the Console/Network errors as in section 5. `?basemap=...` can be added to the URL. `__mission37dQA` will be `undefined` there; that is expected.

## 7. After you send the evidence

Cause is **not determined**. With the screenshots + snapshot JSON, compare in this order to narrow it down:
1. (a1) foot vs (d1) background: does the foot footprint align with the GSI building/road edge when parallax is removed (top view / `setFov`)?
2. (b1) OSM centre line vs (b2) GSI edge: is the centre line midway between the two edges (expected) or shifted to one side (position offset)?
3. (c) water/parks vs (d1) background water edge.
4. (d2) vs baseline: if the seam only exists with Globe ON, suspect background LOD (`tilesToRenderByLevel`) or depth; otherwise the vector layers.
5. Same spot with `basemap=gsi-blank` vs `gsi-pale` vs `none`.

No uniform shift should be applied to buildings or roads before this comparison.

## 8. Mission 66: point probe for the seam (3 minutes, localhost + `?qa=1` only)

**Send first:** (1) a screenshot where the anomaly is visible, (2) the full URL, (3) the probe JSON of the spot (below). Nothing else is needed; do not copy tokens, cookies or unrelated DevTools data.

What `probe(px, py)` returns (read-only; `px,py` = clientX/clientY of the pixel in the screenshot viewport):
- `hit` / `hitId`: what `scene.pick` found: `building` (canonicalId), `poi`, `other-primitive` (e.g. PolylineCollection = OSM centre line), or `none` (background raster/globe).
- `depthLocal`: the surface last drawn at that pixel (roof, wall, line or background). **Not** a road-edge coordinate.
- `groundLocal`: the pixel's view ray vs the Globe (ellipsoid, no terrain). It is where the *background raster* pixel sits, not the true coordinate of the real road edge or shoreline.
- `reprojectPx`: round-trip check only (should be ~0).
- `visibleLayers`, `tilesReady`, `globeLevels` (background LOD), `camera`, `tilesets`.

Console (same camera, do not move between the two clicks):
```js
const A = __mission37dQA.probe(X1, Y1);   // e.g. building foot
const B = __mission37dQA.probe(X2, Y2);   // e.g. adjacent road edge in the background
copy(JSON.stringify({ A: A, B: B, pair: __mission37dQA.probePair(A, B) }, null, 2));
```
Combine with the A/B states in section 3: probe the same pixel under (a1) foot only, (b1) OSM centre lines only, (b2) GSI edges only, (d1) background only, (d2) Globe OFF.

**Measurable:** pixel positions, and the local x/z/h difference between the points *you* clicked, at a fixed camera; which layer is under the pixel; background LOD.

**Not measurable:** a true horizontal error between a vector feature and the real-world road edge/shoreline. The raster has no feature coordinates, and the clicked pair is only a pair of clicks. `probePair` reports `groundDelta`/`depthDelta` and `sameCamera`; do not read them as an error unless you know both clicks mean the same real-world point. No layer here is a "road surface": OSM roads are centre lines.

The cause of the seam stays **undetermined** until your screenshot + JSON arrive.
