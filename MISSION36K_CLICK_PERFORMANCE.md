# Mission 36K | Building Click & Facility Spatial Performance

## Goal
Keep the full Osaka City facility dataset and existing exact building picking while reducing facility-side runtime work that can delay map interaction.

## Constraints
- Do not reduce or delete the 40,585-source facility dataset.
- Preserve 24-ward lazy loading.
- Preserve Mission 35Y exact building picking (`faceIndex` / triangle-to-building mapping).
- Do not modify protected production HTML (`public/osaka_3d_buildings.html`, `public/osaka_3d_buildings.fullward-v3.html`).
- Apply changes to the dev UI first.

## Change
- Add a 500m runtime facility spatial grid.
- Index records as ward shards are loaded.
- Use nearby grid cells for finite-radius facility queries.
- Select facility render candidates through the spatial query rather than mapping/filtering/sorting all loaded records.
- Keep the existing bounded facility sprite cap.
- Keep exact legacy fallback semantics for infinite-radius nearest queries.

## Verification
- Run the focused Mission 36K spatial-performance test.
- Run the existing Mission 35Y precise-building-picking test.
- Assert protected production HTML remains untouched.
