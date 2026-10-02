# Mission 36K Implementation Status

Implemented on `feature/mission-36k-building-click-performance`.

- Facility source data remains unchanged (40,585 records / 24 ward shards).
- Runtime facility store gains a 500m spatial grid through the dev UI coordinator.
- Facility-layer rebuilds are bounded to nearby candidates and the existing render cap.
- Facility click picking now uses a spatial + screen-space gate before invoking the original exact sprite raycast.
- Ordinary building clicks can therefore skip facility sprite raycasting when no facility marker is close to the pointer.
- Existing exact building picking remains untouched.
- Dev-only injection is performed by `tools/preview.js`; protected production HTML is not modified.

Runtime diagnostics:

```js
window.__MISSION36K_FACILITY_PERF__?.()
window.__MISSION36K_BUILDING_CLICK_PERF__?.()
```

Focused tests:

```bash
node --test tests/mission36k-facility-spatial-performance.test.js
node --test tests/mission36k-building-click-performance.test.js
node --test tests/mission36k-preview-injection-order.test.js
```
