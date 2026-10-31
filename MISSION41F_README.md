# Mission 41F: offline local tar packaging (no upload)

Tested only with synthetic fixtures in CI. It has NOT been run on the owner's real data, and cannot be run on the owner's PC until they pull this commit.

## What it does
`tools/mission41f-pack-local.cjs create` builds real ustar `.tar` files for the selected subset of the 41B `manifest.json`. It reuses the 41D checks (relative path, `..`, NFC, name length, duplicates, case collisions, symlink files, real path inside root, size equals manifest, tar estimate < 1.5 GiB and < 2 GiB). 41F adds: symlink/junction on any directory between the root and the file; free disk >= total tar + 2 GiB.

- Sources are only read. Source `size:mtime:inode` is recorded before, checked after, and every source is re-hashed after writing; any change fails the part.
- Each tar is written to `<out>/.staging/<name>.partial` (`wx`, never overwrite), re-read by an independent tar parser (header checksums, relative names, sizes, zero padding, end blocks, SHA-256 of every member = the source hash), then renamed into place. Tar SHA-256 and byte count go to `pack-report.json` (anonymous ids, no paths).
- Nothing is deleted. A failed or leftover partial is MOVED to `<out>/quarantine/`.
- Re-running into the same folder: an archive that still matches the sources is reported `already-packed-verified` and not rewritten; one that does not match is refused (not overwritten). Reports get a new name each run. A subset archive is named `<asset>-subset-<8 hex>.tar`, never a full-part name.
- `--out` must be outside every data root and either new/empty or a previous 41F folder.
- Never packed: categories `secrets-candidate` and `backup-archive`, plus file names that look like keys/tokens/credentials. The name check is a hint only. It is NOT a secret scan; file contents are not inspected. Packing is NOT permission to transfer.
- No network code, no upload, no private repo, no Release. The licence / secrets / personal-data gates stay closed and `readyToUpload` is always false.

## Owner commands (Windows PowerShell 5.1, repo root; not yet run)
Priority first: the unfiltered 41D dry-run for all 43,258 files:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41d-pack.ps1
```
Then, after pulling this commit, local packaging of the Fukushima subset (one command; newest `%TEMP%\livecity-plan-*\manifest.json` auto-detected, roots default `..`, Japanese paths OK):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mission41f-pack-local.ps1
```
Optional: `-OutDir D:\packs\fukushima` (outside the data folder), `-PathContains <text>`, `-OnlyCategory <name>`. Exit 3 = nothing matched, 1 = problem (nothing finalised for the failing part).

## Long-term goal
All 75.62 GB is still to be preserved in stages through the 41B plan; deferred categories stay on `deferred-ledger.json`. 41F only handles the packable subset locally.

## CI
`node --test tests/mission41*.test.cjs`. The ps1 is checked statically (ASCII, brace balance, no remove/copy/network commands), not run under PowerShell 5.1.
