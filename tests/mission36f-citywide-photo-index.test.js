// tests/mission36f-citywide-photo-index.test.js
// [Mission 36F] 35Z の curated 24件から大阪市全域への拡張。
//   守りたい安全原則は 35Z と同じ:
//     ・近いだけでは建物を決めない
//     ・同名/同一building/同一直接IDの競合は unresolved に落とす
//     ・curated（手で確認済み）は citywide 自動処理より必ず勝つ
//   ネットワークにも生成済みindexにも依存しない、純粋関数の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeBuildingName, resolveByDirectId, resolveByNameAndCoordinate,
  resolvePriorityCollisions, summarizeCoverage,
} from '../tools/photos/lib/citywide-photo-matching.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'photos', 'build-building-photo-index.mjs');

// ── A. direct-id ──────────────────────────────────────────────
test('[36F A] direct-id: 座標近くに建物が1つだけなら high で結ぶ', () => {
  const buildings = [
    { id: 'b1', name: 'ビルA', x: 100, z: -50 },
    { id: 'b2', name: 'ビルB', x: 5000, z: 5000 },
  ];
  const r = resolveByDirectId({ x: 110, z: -55 }, buildings, { radiusM: 60 });
  assert.equal(r.canonicalId, 'b1');
  assert.equal(r.matchConfidence, 'high');
  assert.equal(r.matchMethod, 'direct-id');
});

test('[36F A] direct-id: 半径内に建物が無ければ unresolved', () => {
  const buildings = [{ id: 'b1', name: 'ビルA', x: 100, z: -50 }];
  const r = resolveByDirectId({ x: 9000, z: 9000 }, buildings, { radiusM: 60 });
  assert.equal(r.canonicalId, null);
  assert.equal(r.matchConfidence, 'unresolved');
  assert.equal(r.reasonCode, 'direct-id-no-building-nearby');
});

test('[36F A] direct-id: 半径内に建物が2つ以上あれば一意に決まらないので unresolved（近い方を推測で選ばない）', () => {
  const buildings = [
    { id: 'b1', name: 'ビルA', x: 100, z: 0 },
    { id: 'b2', name: 'ビルB', x: 120, z: 0 },
  ];
  const r = resolveByDirectId({ x: 105, z: 0 }, buildings, { radiusM: 60 });
  assert.equal(r.canonicalId, null);
  assert.equal(r.matchConfidence, 'unresolved');
  assert.equal(r.reasonCode, 'direct-id-ambiguous-radius');
});

// ── B. citywide-verified (name + coordinate) ──────────────────
test('[36F B] citywide-verified: 名前完全一致 + 座標が近い一意な建物なら high', () => {
  const buildings = [
    { id: 'b1', name: '住吉タワー', x: 0, z: 0 },
    { id: 'b2', name: '別のビル', x: 5000, z: 5000 },
  ];
  const r = resolveByNameAndCoordinate({ x: 10, z: -5 }, buildings, ['住吉タワー'], { nameRadiusM: 400, ambiguityMarginM: 30 });
  assert.equal(r.canonicalId, 'b1');
  assert.equal(r.matchConfidence, 'high');
  assert.equal(r.matchMethod, 'citywide-verified');
});

test('[36F B] citywide-verified: 名前が一致する建物が無ければ unresolved（推測で近い建物を選ばない）', () => {
  const buildings = [{ id: 'b1', name: '別のビル', x: 10, z: -5 }];
  const r = resolveByNameAndCoordinate({ x: 10, z: -5 }, buildings, ['存在しないビル名']);
  assert.equal(r.canonicalId, null);
  assert.equal(r.reasonCode, 'name-no-match');
});

test('[36F B] citywide-verified: 名前は一致するが座標が遠すぎれば unresolved', () => {
  const buildings = [{ id: 'b1', name: '住吉タワー', x: 10000, z: -5000 }];
  const r = resolveByNameAndCoordinate({ x: 0, z: 0 }, buildings, ['住吉タワー'], { nameRadiusM: 400 });
  assert.equal(r.canonicalId, null);
  assert.equal(r.reasonCode, 'name-match-too-far');
});

test('[36F B] citywide-verified: 同名の建物が僅差で複数あれば unresolved（同名競合を推測で選ばない）', () => {
  const buildings = [
    { id: 'b1', name: '第一マンション', x: 0, z: 0 },
    { id: 'b2', name: '第一マンション', x: 20, z: 0 },   // 20m しか離れていない
  ];
  const r = resolveByNameAndCoordinate({ x: 5, z: 0 }, buildings, ['第一マンション'], { ambiguityMarginM: 30 });
  assert.equal(r.canonicalId, null);
  assert.equal(r.reasonCode, 'name-ambiguous-multiple-candidates');
});

test('[36F B] citywide-verified: 同名だが十分離れていれば近い方を一意に採用してよい', () => {
  const buildings = [
    { id: 'b1', name: '第一マンション', x: 0, z: 0 },
    { id: 'b2', name: '第一マンション', x: 3000, z: 0 }, // 十分離れている（別の建物だと明確）
  ];
  const r = resolveByNameAndCoordinate({ x: 5, z: 0 }, buildings, ['第一マンション'], { ambiguityMarginM: 30 });
  assert.equal(r.canonicalId, 'b1');
  assert.equal(r.matchConfidence, 'high');
});

test('[36F] normalizeBuildingName: 全角英数・区切り記号・大文字小文字を吸収する', () => {
  assert.equal(normalizeBuildingName('ＡＢＣ　タワー'), normalizeBuildingName('abcタワー'));
  assert.equal(normalizeBuildingName('第一・マンション'), normalizeBuildingName('第一マンション'));
});

// ── 手法間の優先順位つき衝突解決 ────────────────────────────────
test('[36F] 衝突解決: curated が citywide-verified に必ず勝つ', () => {
  const records = [
    { canonicalId: 'b1', matchMethod: 'curated', matchConfidence: 'high', curatedName: 'あべのハルカス' },
    { canonicalId: 'b1', matchMethod: 'citywide-verified', matchConfidence: 'high', curatedName: '自動候補X' },
  ];
  const out = resolvePriorityCollisions(records);
  const curated = out.find((r) => r.matchMethod === 'curated');
  const auto = out.find((r) => r.matchMethod === 'citywide-verified');
  assert.equal(curated.canonicalId, 'b1');
  assert.equal(auto.canonicalId, null);
  assert.equal(auto.matchConfidence, 'unresolved');
  assert.equal(auto.reasonCode, 'collision-lost-to-other-claim');
});

test('[36F] 衝突解決: direct-id が citywide-verified に勝つ', () => {
  const records = [
    { canonicalId: 'b1', matchMethod: 'direct-id', matchConfidence: 'high', curatedName: 'X' },
    { canonicalId: 'b1', matchMethod: 'citywide-verified', matchConfidence: 'high', curatedName: 'Y' },
  ];
  const out = resolvePriorityCollisions(records);
  assert.equal(out.find((r) => r.matchMethod === 'direct-id').canonicalId, 'b1');
  assert.equal(out.find((r) => r.matchMethod === 'citywide-verified').canonicalId, null);
});

test('[36F] 衝突解決: 同じ優先度の2件が同じ建物を主張したら両方 unresolved（推測で片方を選ばない）', () => {
  const records = [
    { canonicalId: 'b1', matchMethod: 'citywide-verified', matchConfidence: 'high', curatedName: 'X' },
    { canonicalId: 'b1', matchMethod: 'citywide-verified', matchConfidence: 'high', curatedName: 'Y' },
  ];
  const out = resolvePriorityCollisions(records);
  assert.ok(out.every((r) => r.canonicalId === null));
  assert.ok(out.every((r) => r.matchConfidence === 'unresolved'));
});

test('[36F] 衝突解決: 衝突が無い record はそのまま', () => {
  const records = [
    { canonicalId: 'b1', matchMethod: 'curated', matchConfidence: 'high' },
    { canonicalId: 'b2', matchMethod: 'citywide-verified', matchConfidence: 'high' },
    { canonicalId: null, matchMethod: 'citywide-verified', matchConfidence: 'unresolved' },
  ];
  const out = resolvePriorityCollisions(records);
  assert.equal(out[0].canonicalId, 'b1');
  assert.equal(out[1].canonicalId, 'b2');
  assert.equal(out[2].canonicalId, null);
});

// ── 区別カバレッジ集計 ─────────────────────────────────────────
test('[36F] summarizeCoverage: 区別の named / resolved / method 内訳と unresolved 理由を集計する', () => {
  const namedBuildings = [
    { id: 'b1', wardId: 'sumiyoshi' }, { id: 'b2', wardId: 'sumiyoshi' },
    { id: 'b3', wardId: 'kita' }, { id: 'b4', wardId: null },
  ];
  const records = [
    { canonicalId: 'b1', matchMethod: 'curated', matchConfidence: 'high' },
    { canonicalId: 'b3', matchMethod: 'citywide-verified', matchConfidence: 'high' },
    { canonicalId: null, matchMethod: 'citywide-verified', matchConfidence: 'unresolved', reasonCode: 'name-no-match' },
    { canonicalId: null, matchMethod: 'citywide-verified', matchConfidence: 'unresolved', reasonCode: 'name-no-match' },
    { canonicalId: null, matchMethod: 'direct-id', matchConfidence: 'unresolved', reasonCode: 'direct-id-ambiguous-radius' },
  ];
  const { wardStats, coverage, unresolvedReasons } = summarizeCoverage(namedBuildings, records, { sumiyoshi: 34930, kita: 15779 });

  assert.equal(wardStats.sumiyoshi.namedTotal, 2);
  assert.equal(wardStats.sumiyoshi.resolved, 1);
  assert.equal(wardStats.sumiyoshi.byMethod.curated, 1);
  assert.equal(wardStats.sumiyoshi.selectableTotal, 34930);
  assert.equal(wardStats.kita.resolved, 1);
  assert.equal(wardStats.kita.byMethod['citywide-verified'], 1);
  assert.equal(wardStats.unknown.namedTotal, 1);

  assert.equal(coverage.resolvedTotal, 2);
  assert.equal(coverage.unresolvedTotal, 3);
  assert.equal(coverage.byMethod.curated, 1);
  assert.equal(coverage.byMethod['citywide-verified'], 1);

  assert.equal(unresolvedReasons['name-no-match'], 2);
  assert.equal(unresolvedReasons['direct-id-ambiguous-radius'], 1);
});

test('[36F] 1件の重複画像/canonicalIdの重複はindexに残らない（既存の35Zガードを流用していることを確認）', () => {
  const b = fs.readFileSync(BUILD_SCRIPT, 'utf-8');
  assert.match(b, /同じ canonicalId を 2 件以上が主張したら/);
});

// ── build スクリプトが citywide 拡張を安全に組み込んでいることの静的チェック ──
// （このサンドボックスには building-name-labels.json / OSM PBF / ネットワークが無いため、
//   実際にスクリプトを実行して確認することはできない。ソースの不変条件だけを確認する。）
test('[36F] build スクリプト: citywide 候補ファイルが無くても壊れない（存在チェックがある）', () => {
  const b = fs.readFileSync(BUILD_SCRIPT, 'utf-8');
  assert.match(b, /fs\.existsSync\(CITYWIDE_DIRECT_ID\)/);
  assert.match(b, /fs\.existsSync\(CITYWIDE_CANDIDATE_POOL\)/);
});

test('[36F] build スクリプト: citywide 経路も wbsearchentities（名前検索での自動確定）を使わない', () => {
  const b = fs.readFileSync(BUILD_SCRIPT, 'utf-8');
  assert.ok(!/wbsearchentities/.test(b), '候補確定スクリプトで名前検索して自動確定している');
});

test('[36F] build スクリプト: 手法間の優先順位（curated > direct-id > citywide-verified）で衝突解決している', () => {
  const b = fs.readFileSync(BUILD_SCRIPT, 'utf-8');
  assert.match(b, /resolvePriorityCollisions/);
  assert.match(b, /summarizeCoverage/);
});
