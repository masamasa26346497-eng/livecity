# Mission 36J — Osaka 24 Ward Google Places Expansion

This mission expands Live City facility/photo linkage from the Sumiyoshi pilot to all 24 Osaka wards.

Safety rules:
- OSM acquisition is tiled and resumable.
- Official ward polygons classify every facility.
- Google Places matching keeps the 120m hard ceiling.
- Only VERIFIED facilityId ↔ googlePlaceId linkage is persisted.
- Ambiguous/unresolved matches stay unresolved rather than borrowing the wrong photo.
- Google photo binaries, media URLs and photo resource names are never persisted.
