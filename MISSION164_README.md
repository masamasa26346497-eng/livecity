# Mission 164 (PR #51 branch only): root cause of "no tile content requested"

**Cause (measured):** the QA pages (`tools/mission156/verify.html`) never loaded Cesium's `widgets.css`, so the `<canvas>` stayed at the default 300x150 px. At that size the screen-space error of the generated tileset's *content-less* root (geometricError 160) was 15.1 < `maximumScreenSpaceError` 16, so Cesium treated the empty root as "detailed enough", selected nothing and never requested a child GLB (`visited=0`, 0 GLB requests, 0 `tileLoad`/`tileVisible`). HTTP 200 and bounds were fine all along; the tiles/GLBs were never the problem.
With a 1280x800 canvas the same tileset: rootSSE 64.6, 7 GLBs requested, `tileLoad`=7, `tileVisible`>300.

**Secondary tileset weakness (also fixed):** an empty root can still satisfy SSE when the camera is far (SSE 2.35 at 30 radii) -> blank view. `tools/mission164/harden-tileset.mjs` raises geometricError of content-less parents (still >= children); applied automatically by `mission156-run-all.mjs` after the build (`rec.hardenedNodes`). Transform / bounds / IDs untouched.

**Checks added:** `strictBrowserOk` now also needs `tileLoadEvents>0`, `tileVisibleEvents>0` and `pixelDiff>0` (canvas pixels differ with tileset shown vs hidden, via preserveDrawingBuffer).

Tools: `tools/mission164/diag.html` + `diag-run.mjs` (single-ward camera `view|far|set` diagnostics), `summarize.mjs`, `verify-wards.mjs`.
Not changed: PR #24 HTML, PR #50 files, `.github/workflows`, private Release.
