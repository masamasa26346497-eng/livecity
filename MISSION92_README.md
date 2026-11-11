# Mission 92 P0: Private data repo (livecity-3d-data) connection

Target: masamasa26346497-eng/livecity-3d-data (private, per owner/ChatGPT API check; not re-verified here).

## One-time setup (owner)
1. GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token.
2. Resource owner: masamasa26346497-eng. Repository access: Only select repositories -> livecity-3d-data ONLY.
3. Permissions: Contents = Read and write (Metadata read is automatic). Nothing else. Short expiry (e.g. 90 days).
4. In the PUBLIC dev repo livecity: Settings > Secrets and variables > Actions > New repository secret, name LIVECITY_3D_DATA_TOKEN. Do not paste the token anywhere else.

GITHUB_TOKEN cannot write to other repos. If the secret/env is missing the tool FAILS (no fallback to other credentials, no --allow-public with --repo).

## Usage
  node tools/mission87-persist.mjs pack --ward nishi
  node tools/mission87-persist.mjs upload --ward nishi --repo masamasa26346497-eng/livecity-3d-data            # dry-run
  node tools/mission87-persist.mjs upload --ward nishi --repo masamasa26346497-eng/livecity-3d-data --execute  # needs LIVECITY_3D_DATA_TOKEN
  node tools/mission87-persist.mjs verify --ward nishi --repo masamasa26346497-eng/livecity-3d-data

Guards: repo must be PRIVATE (checked via API with the dedicated token), vintage must be 2025, sha256 recorded and re-checked after download, deny-list for secrets/photos/Google, release assets only (no Git history growth, private repo main untouched).

## Not done (blockers)
- PLATEAU Osaka 27100/2025 redistribution/attribution terms: unverified (WebFetch not available here). Real data NOT uploaded.
- Private release asset size/billing limits: unverified. Release assets are <2GiB each; storage quota for private repos unconfirmed.
- Nishi ward 2025 conversion output is not present in this CI checkout (it lives on the owner PC). Stored wards: 0/24. Browser acceptance: 0.
