#!/usr/bin/env python3
"""Mission 35S patch wrapper.

35S follows the existing official BuildingLODLayer.update() lifecycle hook(s)
instead of inventing an unrelated refresh loop. Known dev-runtime variants have
one or three exact hooks; any other count fails closed.
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
        # Known dev variants contain either one consolidated official high-LOD
        # update hook or three lifecycle hooks. Follow every exact hook present.
        if n not in (1, 3):
            raise RuntimeError(f'{label}: expected 1 or 3 official high-LOD hooks, got {n}')
        print(f'[35S patch] following {n} official high-LOD update hook(s)')
        return s.replace(old, new)
    if n != 1:
        raise RuntimeError(f'{label}: expected exactly 1 anchor, got {n}')
    return s.replace(old, new, 1)


mod.one_replace = safe_replace

if __name__ == '__main__':
    mod.main()
