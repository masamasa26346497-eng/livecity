#!/usr/bin/env node
// Mission 105: render tools/mission105/three-wards.pinned.workflow.yml (ikuno, abeno, yodogawa only) from the audited Mission103 template + steps.
//   node tools/mission105/render.mjs --pin <commit-sha>
// The pin must be an existing commit that already contains tools/mission105/chunked-batch.mjs. Every sha256 is computed from the git OBJECT at
// that commit (not the working tree), so the embedded list always describes exactly the code the runner will check out. No network, no token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENTRY = ['tools/mission105/chunked-batch.mjs', 'tools/mission95-check-output.mjs', 'tools/mission95-persist-ward.mjs', 'tools/mission87-persist.mjs'];
export const WARDS = ['ikuno', 'abeno', 'yodogawa'];
const RUNTIME_OUTPUTS = new Set(['data/reports/mission87/storage-manifest.json', 'data/reports/mission80/batch-manifest.json']);

const show = (sha, rel) => { try { return execFileSync('git', ['show', sha + ':' + rel], { cwd: ROOT, maxBuffer: 1 << 28 }); } catch { return null; } };

// Same reference-following rules as tools/mission96/pin-audit.mjs, but reading git objects at <sha>.
export function closureAt(sha) {
  const seen = new Map(); const missing = [];
  const visit = (rel) => {
    rel = path.posix.normalize(rel);
    if (seen.has(rel) || RUNTIME_OUTPUTS.has(rel)) return;
    const buf = show(sha, rel);
    if (!buf) { if (!missing.includes(rel)) missing.push(rel); return; }
    seen.set(rel, crypto.createHash('sha256').update(buf).digest('hex'));
    if (!/\.(mjs|cjs|js)$/.test(rel)) return;
    const s = buf.toString('utf8'); const dir = path.posix.dirname(rel);
    for (const m of s.matchAll(/(?:from\s+|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) visit(path.posix.join(dir, m[1]));
    for (const m of s.matchAll(/\bT\(\s*'([^']+)'\s*\)/g)) visit('tools/' + m[1]);
    for (const m of s.matchAll(/['"](tools\/[A-Za-z0-9_\-\/]+\.(?:mjs|cjs|js))['"]/g)) visit(m[1]);
    for (const m of s.matchAll(/['"]((?:config|data)\/[A-Za-z0-9_\-\/.]+\.json)['"]/g)) visit(m[1]);
  };
  ENTRY.forEach(visit);
  return { files: [...seen.keys()].sort(), hashes: seen, missing: missing.sort() };
}

function must(str, from, to, label) {
  if (!str.includes(from)) throw new Error('render: anchor not found: ' + label);
  return str.split(from).join(to);
}
function cut(str, startMarker, endMarker, label) {
  const a = str.indexOf(startMarker), b = str.indexOf(endMarker);
  if (a < 0 || b < 0 || b <= a) throw new Error('render: block not found: ' + label);
  return str.slice(0, a) + str.slice(b);
}

export function render(pin) {
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error('--pin must be a full 40-hex commit sha');
  execFileSync('git', ['cat-file', '-e', pin + '^{commit}'], { cwd: ROOT });
  const c = closureAt(pin);
  if (c.missing.length) throw new Error('closure files missing at pin: ' + c.missing.join(', '));
  if (!c.files.includes('tools/mission104/chunked-run.mjs') || !c.files.includes('tools/mission80-batch.mjs')) throw new Error('closure lacks chunked-run or mission80-batch');
  const dir103 = path.join(ROOT, 'tools/mission103');
  const hashBody = c.files.map((f) => '          ' + c.hashes.get(f) + '  ' + f).join('\n');
  let steps = fs.readFileSync(path.join(dir103, 'steps.part.yml'), 'utf8').replace(/\n$/, '');
  steps = must(steps, '@@HASHES@@', hashBody, 'hashes');
  // Convert step -> chunked path (single ward, refuses anything but the 3 wards) + a resource preflight BEFORE any download.
  steps = must(steps,
    '      - name: Convert ward (PLATEAU 2025, NO token)\n        id: convert\n        run: node tools/mission80-batch.mjs --wards "$WARD" --max-wards 1 --ward-timeout-min 60\n',
    '      - name: Resource preflight (no token, no download)\n'
    + '        run: |\n'
    + '          set -eu\n'
    + '          case "$WARD" in ikuno|abeno|yodogawa) ;; *) echo "FAIL: ward not allowed in Mission105: $WARD"; exit 1;; esac\n'
    + '          free_gb=$(df -BG --output=avail . | tail -n1 | tr -dc 0-9)\n'
    + '          mem_mb=$(free -m | awk \'/^Mem:/ {print $2}\')\n'
    + '          echo "free_disk_gb=$free_gb mem_mb=$mem_mb"\n'
    + '          [ "$free_gb" -ge 6 ] || { echo "FAIL: need >= 6 GB free disk (peak plan ~0.35 GB inflated + output)"; exit 1; }\n'
    + '          [ "$mem_mb" -ge 3000 ] || { echo "FAIL: need >= 3000 MB RAM"; exit 1; }\n'
    + '          node tools/mission104/chunked-run.mjs --ward "$WARD" --chunk-mb 300 --max-mb 1200 --dry-run\n'
    + '      - name: Convert ward in bounded chunks (PLATEAU 2025, NO token)\n        id: convert\n        run: node tools/mission105/chunked-batch.mjs --wards "$WARD" --chunk-mb 300 --max-mb 1200 --ward-timeout-min 80\n',
    'convert step');
  let t = fs.readFileSync(path.join(dir103, 'all-wards.pinned.workflow.template.yml'), 'utf8');
  // header + inputs
  t = t.slice(t.indexOf('name: Mission95 persist ward to private repo'));
  const head = '# Mission 105: OWNER-INSTALLED, OWNER-DISPATCHED ONLY. NOT installed by this commit (a GitHub App cannot write .github/workflows).\n'
    + '# GENERATED by `node tools/mission105/render.mjs --pin <sha>` from the audited Mission103 template/steps. Do not hand-edit hashes.\n'
    + '# Scope: ONLY ikuno, abeno, yodogawa (the 3 wards whose inflated GML exceeded the 1200MB gate). Conversion uses the Mission104 bounded chunked path.\n'
    + '# The 21 already-stored wards are never listed, never converted, never uploaded here. Stored target wards are re-downloaded, sha256 recomputed and skipped.\n'
    + '# No overwrite input exists. No automatic retry (re-dispatch resumes). Result is STORAGE ONLY (browser acceptance stays 0).\n';
  t = must(t, 'concurrency:\n  group: mission103-persist-all-wards', 'concurrency:\n  group: mission105-persist-3-wards', 'concurrency');
  t = must(t, 'name: Mission95 persist ward to private repo', 'name: Mission105 persist 3 oversized wards (chunked)', 'name');
  t = must(t, '        description: "ALL (default: every official ward, fukushima pilot first) or comma-separated ward ids to resume a subset. Expo 27999 is never allowed"',
    '        description: "ALL (default) = ikuno,abeno,yodogawa, or a comma-separated subset of those three. Any other ward is rejected"', 'input description');
  t = must(t, '  # sha256 recorded by the successful Mission95 run 41544102363 (nishi, 12603 buildings). Stored nishi is re-verified against it.\n  EXPECTED_SHA_NISHI: "0232c89f0a5beeb2a03333b6ac8d0ca6366004ac85a0f3b221170dbc91a078c4"\n', '', 'nishi hash env');
  t = must(t, 'ALL="fukushima miyakojima konohana nishi minato taisho tennoji naniwa nishiyodogawa higashiyodogawa higashinari ikuno asahi joto abeno sumiyoshi higashisumiyoshi nishinari yodogawa tsurumi suminoe hirano kita chuo"',
    'ALL="ikuno abeno yodogawa"', 'ward list');
  t = must(t, '[ "$(printf \'%s\\n\' $ALL | wc -l)" = "24" ] && [ "$(printf \'%s\\n\' $ALL | sort -u | wc -l)" = "24" ] || { echo "FAIL: ward list is not 24 unique"; exit 1; }',
    '[ "$(printf \'%s\\n\' $ALL | wc -l)" = "3" ] && [ "$(printf \'%s\\n\' $ALL | sort -u | wc -l)" = "3" ] || { echo "FAIL: ward list is not 3 unique"; exit 1; }', 'ward count');
  t = must(t, 'not one of the 24 official wards', 'not one of the 3 Mission105 wards (ikuno abeno yodogawa)', 'reject msg');
  t = must(t, '              if [ "$w" = "nishi" ] && [ "$sha" != "$EXPECTED_SHA_NISHI" ]; then echo "FAIL: stored nishi sha256 $sha != recorded"; exit 1; fi\n', '', 'nishi check');
  // no pilot: remove pilot job, outputs, and rewire rest/summary
  t = cut(t, '  pilot:\n    needs: plan\n', '  rest:\n', 'pilot job');
  t = must(t, '      pilot_matrix: ${{ steps.plan.outputs.pilot_matrix }}\n      pilot_count: ${{ steps.plan.outputs.pilot_count }}\n', '', 'pilot outputs');
  t = must(t, '          pilot=""; rest=""\n          for w in $todo; do\n            if [ "$w" = "fukushima" ]; then pilot="$w"; else rest="$rest $w"; fi\n          done\n', '          rest="$todo"\n', 'pilot split');
  t = must(t, '          pl=$(mk "$pilot"); rl=$(mk "$rest")\n          echo "pilot_matrix={\\"ward\\":$pl}" >> "$GITHUB_OUTPUT"; echo "pilot_count=$(echo "$pl" | jq length)" >> "$GITHUB_OUTPUT"\n', '          rl=$(mk "$rest")\n', 'pilot emit');
  t = must(t, 'echo "pilot: $pl  rest: $rl"', 'echo "rest: $rl"', 'pilot echo');
  t = must(t, "    needs: [plan, pilot]\n    if: ${{ always() && needs.plan.result == 'success' && needs.plan.outputs.rest_count != '0' && (needs.pilot.result == 'success' || needs.pilot.result == 'skipped') }}\n",
    "    needs: plan\n    if: ${{ needs.plan.result == 'success' && needs.plan.outputs.rest_count != '0' }}\n", 'rest needs');
  t = must(t, '    timeout-minutes: 90\n', '    timeout-minutes: 100\n', 'timeout');
  t = must(t, '    needs: [plan, pilot, rest]\n', '    needs: [plan, rest]\n', 'summary needs');
  t = must(t, '          PILOT_RESULT: ${{ needs.pilot.result }}\n', '', 'summary pilot env');
  t = must(t, '            echo "- pilot job result: $PILOT_RESULT / rest job result: $REST_RESULT"\n', '            echo "- convert job result: $REST_RESULT"\n', 'summary line');
  t = must(t, ' || [ "$PILOT_RESULT" = "failure" ]', '', 'summary pilot fail');
  t = must(t, 'Mission103 all-ward run', 'Mission105 3-ward run', 'summary title');
  t = must(t, 'dispatch again with wards=ALL', 'dispatch again with wards=ALL (or the failed ward ids)', 'resume text');
  t = must(t, '@@STEPS@@', steps, 'steps');
  t = must(t, '@@PIN_SHA@@', pin, 'pin');
  if (/@@|pilot/.test(t.replace(/#.*$/gm, ''))) throw new Error('render: leftover placeholder or pilot reference');
  return head + t;
}

function main() {
  const a = process.argv.slice(2); const i = a.indexOf('--pin');
  if (i < 0) throw new Error('usage: render.mjs --pin <40-hex commit containing tools/mission105/chunked-batch.mjs>');
  const out = render(a[i + 1]);
  fs.writeFileSync(path.join(ROOT, 'tools/mission105/three-wards.pinned.workflow.yml'), out);
  console.log('rendered pin=' + a[i + 1] + ' bytes=' + out.length);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); } catch (e) { console.error('FAILED', e.message); process.exit(1); }
}
