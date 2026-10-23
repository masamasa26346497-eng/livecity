# Mission 41I: secret-candidate review (offline; nothing is uploaded, no gate is opened)

Tested only with synthetic fixtures (72/72 `tests/mission41*.test.cjs`). Not run on the owner's real data or under PowerShell 5.1.

## 1. Is the key exposed through GitHub / Vercel? (no network, no key values, no absolute paths)
```powershell
node tools\mission41i-review.cjs exposure-check --repo .
```
Reports: `public/local-config.js` tracked? git-ignored? ever in history? present locally (existence only, content never read)? any tracked text file with a Google-key-shaped string (count + repo-relative tracked names only)? which served pages reference it. Exit 2 = something needs attention.

In this repo `.gitignore` has `/public/local-config.js`, only `local-config.example.js` is tracked, and a test asserts that. Vercel Git deployments contain only committed files, so a never-committed config is not deployed. Not covered: manual `vercel deploy` from a folder containing the real file, zips, screenshots, chat pastes.

## 2. What a Google key in front-end code means
A browser Maps/Places key is visible to every visitor by design. It is safe to ship only if it is restricted; otherwise it is a leak.
- Cloud Console > APIs & Services > Credentials > the key:
  - Application restriction: HTTP referrers, only your own origins (not `*`).
  - API restriction: only the APIs this app uses.
  - Only needed APIs enabled on the project; quotas/budget alerts set (alerts do not hard-stop spend).
- Suspected leak (key was in a shared zip, screenshot, public repo, chat): create a new restricted key, switch the app to it, then disable/delete the old key, then check usage for unknown traffic. Repo history rewrite does not un-leak a key; rotate first.
- Currently Google calls are locked off in this project (`ENABLED=false`); that does not make a leaked key safe.

## 3. E-mail finding (1 file)
The tool never shows the address. The owner opens the file locally and decides: is it a contact printed in a public source (attribution/metadata) or a personal address? Options: `keep-local-only`, `redact-then-rescan`, or `approved-public-source-contact` (only if classified `public-source-contact`). Do not paste the content anywhere.

## 4. Backups: staged local content inspection
A name-only zip scan (41H `zip-keys`) is **not proof that no secrets exist**: a key can sit inside `app.js`, a notes file or a screenshot. Stages, all run on the owner's PC:
1. Name hints (41C/41H): done, informative only.
2. Content scan of every candidate and of backup contents (extract to a new empty folder, scan, never run scripts from it). Key shapes, private-key headers, tokens, e-mail/phone patterns.
3. Owner opens every flagged item locally and decides.
4. Redact or exclude; re-scan after redaction.
5. Owner signs `noSecretsReviewed` / `noPersonalDataReviewed` by hand. No tool here sets them.
Treat every backup zip as secret-bearing until stage 5.

## 5. Review ledger (ids only)
```powershell
node tools\mission41i-review.cjs review-ledger --review "<report folder>\secret-review.json" --out "$env:TEMP\livecity-secret-review-ledger.json"
node tools\mission41i-review.cjs review-check  --ledger "$env:TEMP\livecity-secret-review-ledger.json"   # exit 2 until complete
```
One entry per file needing action (the Google-key file and the e-mail file), by file id only. Fill checks/decision/approvedBy/approvedOn by hand and set `resolved:true`. `gates` stay false whatever you enter.
