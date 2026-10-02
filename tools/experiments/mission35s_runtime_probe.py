#!/usr/bin/env python3
"""Mission 35S: inspect the huge dev HTML for high-LOD/runtime integration anchors.
Read-only probe. Prints compact contexts so GitHub Actions logs can guide a safe patch.
"""
from pathlib import Path

p = Path('public/osaka_3d_buildings.ward-ux-v1.html')
s = p.read_text(encoding='utf-8')
terms = [
    'MaxLodQaLayer', 'building-lod-high', '__MAX_LOD_QA__', '__MAX_LOD_INSPECT__',
    'canonicalId', 'suppressed', 'suppress', 'HighLod', 'highLod', 'LOD2',
    'BuildingLayer', 'buildingMeshes', 'buildingGroup', 'pickBuilding'
]
print(f'[35S probe] bytes={len(s.encode("utf-8")):,} chars={len(s):,}')
for term in terms:
    print(f'\n===== {term} =====')
    start = 0
    hits = 0
    while hits < 8:
        i = s.find(term, start)
        if i < 0: break
        a = max(0, i - 700); b = min(len(s), i + 1400)
        ctx = s[a:b].replace('\r','')
        print(f'\n--- hit {hits+1} @ {i} ---\n{ctx}\n')
        start = i + len(term); hits += 1
    print(f'[hits shown] {hits}')
