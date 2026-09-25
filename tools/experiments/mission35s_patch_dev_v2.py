#!/usr/bin/env python3
"""Mission 35S patch wrapper.

The dev runtime intentionally calls BuildingLODLayer.update() from three lifecycle
paths. 35S must follow every one of those official high-LOD update hooks rather
than guessing which occurrence is the 'real' camera hook.
"""
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

BASE = Path(__file__).with_name('mission35s_patch_dev.py')
spec = spec_from_file_location('mission35s_patch_base', BASE)
mod = module_from_spec(spec)
spec.loader.exec_module(mod)


def safe_replace(s: str, old: str, new: str, label: str) -> str:
    n = s.count(old)
    if label == 'camera update':
        # Existing runtime has exactly three official high-LOD update hooks.
        # Custom high-LOD must track all three. Fail closed if that contract drifts.
        if n != 3:
            raise RuntimeError(f'{label}: expected exactly 3 official high-LOD hooks, got {n}')
        return s.replace(old, new)
    if n != 1:
        raise RuntimeError(f'{label}: expected exactly 1 anchor, got {n}')
    return s.replace(old, new, 1)


mod.one_replace = safe_replace

if __name__ == '__main__':
    mod.main()
