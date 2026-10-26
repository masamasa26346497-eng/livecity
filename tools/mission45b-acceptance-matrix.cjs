#!/usr/bin/env node
'use strict';
// Mission 45B: 24区 受入マトリクス（read-only・パス/ID/PIIを含まない要約）。
//   node tools/mission45b-acceptance-matrix.cjs [--evidence <ward-evidence.json> ...] [--json] [--out <file>]
// 何も書き込まない（--out 指定時のみ要約JSONを1ファイル書く）。アップロード・ネットワーク通信・ゲート変更はしない。
// 入力:
//   config/wards/registry.json                  区コード台帳
//   config/mission45b-ward-source-counts.json   source棟数/tile数/Git追跡3D棟数（45A棚卸しの転記）
//   --evidence                                   PC側で作った区ごとの実測証拠（schema livecity.mission45b.ward-evidence/1）
// 「受入」の定義: 1区が accepted になるのは、種別 real の証拠で次の5項目がすべて真のときだけ。
//   realSourceVerified / http200 / webglPixelsChanged / clickedBuildingIdVerified / coverage==='full'
// 24区すべてが accepted で、かつ同時常駐区数が上限以内のときだけ complete24=true。
// 合成fixture・Git追跡の部分メッシュ・静的テストの証拠は accepted に数えない。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_SCHEMA = 'livecity.mission45b.ward-evidence/1';
const MATRIX_SCHEMA = 'livecity.mission45b.acceptance-matrix/1';
const GATES = Object.freeze({ licenceApproved: false, noSecretsReviewed: false, noPersonalDataReviewed: false, uploadAllowed: 0 });
const MAX_RESIDENT_WARDS = 2; // 区切替時に解放されず24区が同時常駐しないこと（現在の区＋切替直前の区まで）
const CHECKS = ['realSourceVerified', 'http200', 'webglPixelsChanged', 'clickedBuildingIdVerified'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const isCount = (n) => Number.isInteger(n) && n >= 0 && n < 1e8;

// パス・URL・ID様の文字列を出力へ入れないための検査（値は真偽/整数/短いenumのみ許可）
function assertAnonymous(obj) {
  const s = JSON.stringify(obj);
  if (/[A-Za-z]:\\|\\\\|\/(?:home|Users|mnt|tmp)\/|https?:\/\/|OneDrive|\.zip\b/i.test(s)) throw new Error('matrix-not-anonymous');
  return obj;
}

function loadBase(root) {
  const reg = readJson(path.join(root || ROOT, 'config/wards/registry.json')).wards;
  const counts = readJson(path.join(root || ROOT, 'config/mission45b-ward-source-counts.json')).wards;
  return { reg, counts };
}

// 証拠1件の検証。不正な証拠は受入に使わず、理由種別だけ返す。
function validateEvidence(ev, known) {
  const problems = [];
  if (!ev || ev.schema !== EVIDENCE_SCHEMA || !Array.isArray(ev.wards)) return { ok: false, problems: ['evidence-wrong-schema'], wards: [] };
  if (ev.gates && (ev.gates.licenceApproved === true || ev.gates.noSecretsReviewed === true || ev.gates.noPersonalDataReviewed === true || ev.gates.uploadAllowed)) problems.push('evidence-flips-gate');
  if (ev.uploaded || ev.published) problems.push('evidence-claims-upload-or-publish');
  const wards = [];
  for (const w of ev.wards) {
    const code = String(w && w.code);
    if (!known.has(code)) { problems.push('evidence-unknown-ward'); continue; }
    const bad = [];
    if (w.kind !== 'real' && w.kind !== 'synthetic' && w.kind !== 'git-tracked-partial') bad.push('kind');
    for (const k of CHECKS) if (typeof w[k] !== 'boolean') bad.push(k);
    if (!isCount(w.convertedBuildings) || !isCount(w.convertedTiles)) bad.push('counts');
    if (!isCount(w.peakResidentWards) || w.peakResidentWards < 1) bad.push('peakResidentWards');
    if (bad.length) { problems.push('evidence-bad-field:' + code + ':' + bad.join('+')); continue; }
    wards.push({ code, kind: w.kind, convertedBuildings: w.convertedBuildings, convertedTiles: w.convertedTiles, peakResidentWards: w.peakResidentWards, ...Object.fromEntries(CHECKS.map((k) => [k, w[k]])) });
  }
  return { ok: problems.length === 0, problems, wards };
}

function build(evidenceDocs, root) {
  const { reg, counts } = loadBase(root);
  const known = new Set(reg.map((w) => w.code));
  const rootProblems = [];
  const byCode = new Map(); // 区ごとに「real」証拠のうち最良の1件
  const ignoredEvidence = { synthetic: 0, gitTrackedPartial: 0, invalid: 0 };
  for (const doc of evidenceDocs || []) {
    const v = validateEvidence(doc, known);
    v.problems.forEach((p) => rootProblems.push(p));
    if (!v.ok) ignoredEvidence.invalid++;
    for (const e of v.wards) {
      if (e.kind === 'synthetic') { ignoredEvidence.synthetic++; continue; }
      if (e.kind === 'git-tracked-partial') ignoredEvidence.gitTrackedPartial++;
      // 不正文書の中の有効行は、文書が全体として壊れているため受入に使わない
      if (!v.ok) continue;
      const prev = byCode.get(e.code);
      if (!prev || e.convertedBuildings > prev.convertedBuildings) byCode.set(e.code, e);
    }
  }
  const wards = reg.map((w) => {
    const c = counts[w.code];
    if (!c || c.id !== w.id) { rootProblems.push('counts-mismatch:' + w.code); }
    const src = c || { sourceBuildings: 0, sourceTiles: 0, gitTracked3dBuildings: 0 };
    const e = byCode.get(w.code) || null;
    const checks = {};
    for (const k of CHECKS) checks[k] = !!(e && e.kind === 'real' && e[k] === true);
    let coverage = 'none';
    if (e && e.kind === 'real') {
      coverage = e.convertedBuildings === src.sourceBuildings && src.sourceBuildings > 0 && e.convertedTiles === src.sourceTiles ? 'full' : (e.convertedBuildings > 0 ? 'partial' : 'none');
    } else if (src.gitTracked3dBuildings > 0) coverage = 'partial';
    const residentOk = !!e && e.peakResidentWards <= MAX_RESIDENT_WARDS;
    const accepted = CHECKS.every((k) => checks[k]) && coverage === 'full' && residentOk;
    const missing = [];
    if (!e || e.kind !== 'real') missing.push('real-evidence-absent(pc-only)');
    else {
      CHECKS.forEach((k) => { if (!checks[k]) missing.push(k); });
      if (coverage !== 'full') missing.push('coverage-' + coverage);
      if (!residentOk) missing.push('too-many-resident-wards');
    }
    return {
      ward: w.id, wardCode: w.code, sourceBuildings: src.sourceBuildings, sourceTiles: src.sourceTiles,
      gitTracked3dBuildings: src.gitTracked3dBuildings,
      convertedBuildings: e && e.kind === 'real' ? e.convertedBuildings : 0, convertedTiles: e && e.kind === 'real' ? e.convertedTiles : 0,
      ...checks, coverage, accepted, missing,
    };
  });
  const accepted = wards.filter((x) => x.accepted).length;
  const complete24 = rootProblems.length === 0 && wards.length === 24 && accepted === 24;
  return assertAnonymous({
    schema: MATRIX_SCHEMA, readOnly: true, uploaded: 0, published: false, gates: GATES, maxResidentWards: MAX_RESIDENT_WARDS,
    rootProblems: [...new Set(rootProblems)], ignoredEvidence,
    wardCount: wards.length, acceptedWards: accepted, fullCoverageWards: wards.filter((x) => x.coverage === 'full').length,
    partialCoverageWards: wards.filter((x) => x.coverage === 'partial').length, pcOnlyPendingWards: wards.filter((x) => !x.accepted && x.gitTracked3dBuildings === 0).length,
    sourceBuildingsTotal: wards.reduce((a, x) => a + x.sourceBuildings, 0), sourceTilesTotal: wards.reduce((a, x) => a + x.sourceTiles, 0),
    complete24, verdict: complete24 ? 'ACCEPTED-24' : 'NOT-ACCEPTED', wards,
  });
}

function formatTable(m) {
  const yn = (b) => (b ? 'Y' : '-');
  const lines = ['ward\tcode\tsrcBldg\tsrcTile\tgit3D\tconv\treal\t200\tpx\tclick\tcover\taccepted'];
  for (const w of m.wards) lines.push([w.ward, w.wardCode, w.sourceBuildings, w.sourceTiles, w.gitTracked3dBuildings, w.convertedBuildings, yn(w.realSourceVerified), yn(w.http200), yn(w.webglPixelsChanged), yn(w.clickedBuildingIdVerified), w.coverage, yn(w.accepted)].join('\t'));
  lines.push(`accepted ${m.acceptedWards}/${m.wardCount}  full-coverage ${m.fullCoverageWards}  partial ${m.partialCoverageWards}  verdict ${m.verdict}`);
  return lines.join('\n');
}

function main(argv) {
  const ev = []; let json = false; let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--evidence') { try { ev.push(readJson(path.resolve(argv[++i]))); } catch (e) { ev.push(null); } } else if (argv[i] === '--json') json = true; else if (argv[i] === '--out') out = argv[++i];
  }
  const m = build(ev);
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(m, null, 2) + '\n');
  process.stdout.write((json ? JSON.stringify(m, null, 2) : formatTable(m)) + '\n');
  return m.complete24 ? 0 : 1; // 未達は非0（完成と誤認させない）
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main, build, validateEvidence, formatTable, assertAnonymous, EVIDENCE_SCHEMA, MATRIX_SCHEMA, GATES, MAX_RESIDENT_WARDS, CHECKS };
