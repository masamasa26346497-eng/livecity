# Mission 41B: 75GB data migration design (dry-run only, nothing uploaded)

## Why 41A `parts=20` was misleading
41A groups files by `category/root/two path segments` and never splits a group. A group larger than the
900 MB target still became one "part", so 20 parts for 74.77 GB means many parts are far above 900 MB.
41A now prints `partsOverTarget` / `maxPartBytes` and a warning. Use 41B for a limit-enforcing plan.

## Tools (offline, read only `inventory.json`, never touch source data)
```powershell
node tools\mission41b-plan.cjs summary --inventory <inventory.json>          # anonymous aggregate (no paths / values)
node tools\mission41b-plan.cjs plan --inventory <inventory.json> --out <NEW dir> [--max-part-gib 1.5]
```
`plan` writes `manifest.json`, `state.json` (resume), `provenance-ledger.json`, `plan.md`. Exit code 2 if validation fails
(part over limit, file placed twice/never, byte mismatch, >=1000 assets per release). Files larger than the limit
are listed as `unsplittable` (need byte chunking), never silently placed. Limit must be < 2 GiB.

## Recommended layout: private repo + private Release assets
- Git (light): `provenance-ledger.json` (source, licence, attribution per dataset), `manifest.json` (asset, release, size, sha256, file list), docs.
- Release assets (heavy): tar per category and ward/layer, each < 1.5 GiB, ~50 assets per release (cap is 1000), `sha256` recorded in the manifest.
- Claude Code fetches only the needed asset (e.g. one ward) and verifies size + sha256 before use.
- Do not use LFS for the whole set: free quota is 10 GiB (as reported by the owner) vs ~75 GB.

| | Private repo + Releases | External object storage |
|---|---|---|
| Cost | no per-GB charge known for release assets (verify current GitHub terms) | per-GB storage + egress, new account/billing (prices not verified here) |
| Convenience | same auth as repo; `gh release download` per asset | needs credentials/secrets in CI; extra service |
| Limits | asset < 2 GiB, 1000/release, 2 GB per push for Git | no per-file limit practical |
| Risk | private only; never publish under `public/` | new paid service needs owner approval |

## Hold list (excluded until a human clears it)
secrets candidates, photos with unknown rights, raw PLATEAU/CityGML/zip (re-downloadable, terms unconfirmed), caches, unclassified.
A part is `approved:false` until its category is passed with `--approved` after `provenance-ledger.json` shows `approved`.

## Dry-run, resume, verification, dedup
- Dry-run is the only mode: no network code exists in the tool (tested).
- `state.json` per asset: pending/done/failed + attempts; `nextPending` retries failures up to 5 times and skips done assets.
- An asset counts as uploaded only if remote size == manifest bytes AND sha256 matches (`verifyPart`).
- Dedup drops only sha256-confirmed duplicates (needs 41A `-Hash`); size-only matches are never dropped.

## Not done / needs owner
- No upload, no repo creation, no release, no ledger approval. 6 secret candidates and per-dataset licences must be reviewed first.
- The uploader (tar, sha256, `gh release upload`) is not implemented; it needs explicit approval.
- Owner command now: re-run 41A with `-Hash`, then run `summary` and `plan` above and paste `plan.md` Validation section.
