#!/usr/bin/env node
// Mission 109: generate the owner-installed workflow from a PIN commit (hashes are read from git objects at the pin).
//   node tools/mission109/gen-workflow.mjs <PIN_SHA> > tools/mission109/qa-private-2025-24ward.workflow.yml
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ALL_WARDS, DEFAULT_BATCH } from './wards.mjs';

const pin = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(pin || '')) { console.error('usage: gen-workflow.mjs <40-hex PIN_SHA>'); process.exit(64); }
const FILES = [
  'tools/mission108/lib.mjs', 'tools/mission108/qa.mjs', 'tools/mission109/wards.mjs', 'tools/mission109/fetch-verify.mjs', 'tools/mission109/qa.mjs',
  'tools/mission88-collect-evidence.mjs', 'tools/lib/cdp-browser.js', 'data/processed/osaka-city/boundaries/ward-classification-polygons.json', 'public/mission37g-osaka-24ward-mvp.html',
];
const hashes = FILES.map((f) => crypto.createHash('sha256').update(execFileSync('git', ['show', pin + ':' + f], { maxBuffer: 1 << 28 })).digest('hex') + '  ' + f);
const caseList = ALL_WARDS.join('|');
const y = `# Mission 109: INSTALL BY OWNER as .github/workflows/mission109-private-2025-qa.yml on the default branch. NOT installed, NOT run by Claude.
# Read-only: fetch stored PLATEAU 2025 archives (any of the 24 wards, batched) from the PRIVATE release, verify, render in headless Chrome on a
# 127.0.0.1 server inside the runner, upload counts-only JSON. No archive/tileset/GLB/screenshot is ever uploaded or published.
# Hashes are sha256 of git objects at PIN_SHA. Re-pin (tools/mission109/gen-workflow.mjs) only after review. Generated file: do not hand-edit.
name: Mission109 private 2025 QA (24 wards)
on:
  workflow_dispatch:
    inputs:
      wards:
        description: "ALL or comma-separated subset of the 24 ward ids (e.g. nishi,fukushima). 27999/expo is refused."
        required: true
        type: string
        default: "nishi,fukushima,yodogawa"
      batch_size:
        description: "Wards per job (1-6)"
        required: true
        type: string
        default: "${DEFAULT_BATCH}"
permissions:
  contents: read
concurrency:
  group: mission109-private-2025-qa
  cancel-in-progress: false
env:
  PIN_SHA: "${pin}"
jobs:
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    if: github.actor == github.repository_owner && github.triggering_actor == github.repository_owner && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    outputs:
      batches: \${{ steps.p.outputs.batches }}
    steps:
      - id: p
        name: Validate input and plan batches (no repo code, no token)
        env:
          IN_WARDS: \${{ inputs.wards }}
          IN_BATCH: \${{ inputs.batch_size }}
        run: |
          set -eu
          ALL="${ALL_WARDS.join(' ')}"
          raw=$(printf '%s' "$IN_WARDS" | tr -d ' \\n\\r')
          [ -n "$raw" ] || { echo "FAIL: no wards"; exit 1; }
          case "$IN_BATCH" in [1-6]) ;; *) echo "FAIL: batch_size 1-6"; exit 1;; esac
          if [ "$(printf '%s' "$raw" | tr a-z A-Z)" = "ALL" ]; then sel="$ALL"; else
            sel=""; seen=" "
            for w in $(printf '%s' "$raw" | tr ',' ' '); do
              case "$w" in ${caseList}) ;; *) echo "FAIL: ward not in whitelist"; exit 1;; esac
              case "$seen" in *" $w "*) echo "FAIL: duplicate ward"; exit 1;; esac
              seen="$seen$w "
            done
            for w in $ALL; do case "$seen" in *" $w "*) sel="$sel $w";; esac; done
          fi
          json="["; i=0; cur=""
          for w in $sel; do
            cur="\${cur:+$cur,}$w"; i=$((i+1))
            if [ "$i" -ge "$IN_BATCH" ]; then json="$json\\"$cur\\","; cur=""; i=0; fi
          done
          [ -z "$cur" ] || json="$json\\"$cur\\","
          json="\${json%,}]"
          echo "batches=$json" >> "$GITHUB_OUTPUT"
  qa:
    needs: plan
    runs-on: ubuntu-latest
    timeout-minutes: 60
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        batch: \${{ fromJSON(needs.plan.outputs.batches) }}
    steps:
      - name: Re-validate batch (no repo code, no token)
        env:
          IN_BATCH: \${{ matrix.batch }}
        run: |
          set -eu
          for w in $(printf '%s' "$IN_BATCH" | tr ',' ' '); do case "$w" in ${caseList}) ;; *) echo "FAIL: ward not allowed"; exit 1;; esac; done
          echo "WARDS=$IN_BATCH" >> "$GITHUB_ENV"
      - name: Checkout pinned commit
        uses: actions/checkout@v4
        with:
          ref: "${pin}"
          persist-credentials: false
          fetch-depth: 1
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Verify pin, clean tree and file hashes (no token yet)
        run: |
          set -eu
          [ "$(git rev-parse HEAD)" = "$PIN_SHA" ] || { echo "FAIL: HEAD != pin"; exit 1; }
          [ -z "$(git status --porcelain)" ] || { echo "FAIL: dirty tree"; exit 1; }
          cat > "$RUNNER_TEMP/pin.sha256" <<'HASHES'
${hashes.map((h) => '          ' + h).join('\n')}
          HASHES
          sed -i 's/^ *//' "$RUNNER_TEMP/pin.sha256"
          sha256sum -c "$RUNNER_TEMP/pin.sha256"
      - name: Fetch + verify private archives (token only here; read-only GETs)
        env:
          LIVECITY_3D_DATA_TOKEN: \${{ secrets.LIVECITY_3D_DATA_TOKEN }}
        run: |
          set -eu
          [ -n "$LIVECITY_3D_DATA_TOKEN" ] || { echo "FAIL: secret empty or missing"; exit 1; }
          echo "::add-mask::$LIVECITY_3D_DATA_TOKEN"
          mkdir -p "$RUNNER_TEMP/m109-out"
          node tools/mission109/fetch-verify.mjs --wards "$WARDS" --dest "$RUNNER_TEMP/m109-root" --summary "$RUNNER_TEMP/m109-out/fetch-summary.json" || echo "fetch reported failures (see summary)"
      - name: Headless Chrome QA on 127.0.0.1 (no token in environment)
        run: |
          set -eu
          node tools/mission109/qa.mjs --root "$RUNNER_TEMP/m109-root" --wards "$WARDS" --summary "$RUNNER_TEMP/m109-out/qa-summary.json" || echo "QA reported failures (see summary); not acceptance either way"
      - name: Counts-only summary
        if: always()
        run: |
          for f in fetch-summary.json qa-summary.json; do
            if [ -f "$RUNNER_TEMP/m109-out/$f" ]; then { echo '### '"$f"; echo '\`\`\`json'; cat "$RUNNER_TEMP/m109-out/$f"; echo; echo '\`\`\`'; } >> "$GITHUB_STEP_SUMMARY"; fi
          done
      - name: Upload summary only (JSON counts; no data, no archives)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: mission109-summary-\${{ strategy.job-index }}
          path: \${{ runner.temp }}/m109-out/*.json
          if-no-files-found: ignore
          retention-days: 7
      - name: Wipe runner temp data
        if: always()
        run: rm -rf "$RUNNER_TEMP/m109-root" "$RUNNER_TEMP/m109-out" "$RUNNER_TEMP/pin.sha256"
`;
process.stdout.write(y);
