// tests/gsi-building-outline-import.test.js
// [Mission 31G-FIX20] GML parser（BldL）と import pipeline の missing-data 経路のテスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuildingOutlineGml, posListToPairs } from '../tools/lib/gsi-building-outline-gml.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...s) => path.join(ROOT, ...s);
const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// [FIX16実測パターンを踏襲] 既定 namespace・prefix無し・gml:Curve+posList構造の合成GML。
const SAMPLE_GML = `<?xml version="1.0" encoding="UTF-8"?>
<Dataset xmlns="http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2">
<BldL gml:id="bl1">
<fid>bl1</fid>
<devDate><gml:timePosition>2026-01-01</gml:timePosition></devDate>
<orgGILvl>2500</orgGILvl>
<vis>表示</vis>
<loc><gml:Curve srsName="fguuid:jgd2024.bl">
<gml:segments><gml:LineStringSegment><gml:posList>34.70 135.50 34.7001 135.50 34.7001 135.5001 34.70 135.5001 34.70 135.50</gml:posList></gml:LineStringSegment></gml:segments>
</gml:Curve></loc>
<type>普通建物</type>
<admOffice>不明</admOffice>
</BldL>
<BldA gml:id="ba1"><type>普通建物</type></BldA>
</Dataset>`;

test('parseBuildingOutlineGml: BldL を抽出し、BldA は件数のみ記録する', () => {
  const { features, bldaCount, otherFeatureTypes } = parseBuildingOutlineGml(SAMPLE_GML);
  assert.equal(features.length, 1);
  assert.equal(features[0].id, 'bl1');
  assert.equal(features[0].srsName, 'fguuid:jgd2024.bl');
  assert.equal(features[0].attrs.type, '普通建物');
  assert.equal(features[0].attrs.devDate, '2026-01-01');
  assert.equal(features[0].attrs.orgGILvl, '2500');
  assert.equal(bldaCount, 1);
  assert.ok(otherFeatureTypes.includes('BldA'));
});

test('posListToPairs: lat-lon 軸順で [lat,lon] へ正規化する', () => {
  const pairs = posListToPairs('34.70 135.50 34.71 135.51', 'lat-lon');
  assert.deepEqual(pairs, [[34.70, 135.50], [34.71, 135.51]]);
});

test('[import] GSI_BUILDING_OUTLINE_RAW_DATA_MISSING: raw data 無しでも安全に終了し捏造しない', () => {
  const rawDir = R('data', 'raw', 'gsi', 'building-outline');
  const hasRealFiles = fs.existsSync(rawDir) && fs.readdirSync(rawDir).some((f) => !/^readme\.md$/i.test(f) && !f.startsWith('.'));
  if (hasRealFiles) return;   // 実データが投入されていれば本テストはスキップ相当（他テストで実測検証）
  const report = rj(R('data', 'reports', 'gsi-building-outline-import.json'));
  if (!report) return;
  assert.equal(report.STATUS, 'GSI_BUILDING_OUTLINE_RAW_DATA_MISSING');
  assert.equal(report.rawDataPresent, false);
  assert.equal(report.featureCount, 0);
  assert.equal(report.osakaFeatureCount, 0);
});

test('[FIX21実測で発見・修正] import-gsi-building-outline.js は大量件数を push(...records) で追加していない（RangeError回帰防止）', () => {
  // [FIX21] 実データ(mesh 523514・BldL 335,519件)で `allRecords.push(...records)` が
  // RangeError: Maximum call stack size exceeded を起こした（V8のspread引数上限）。
  // 通常のforループに修正済み。ここでは実装が退行してspreadへ戻っていないことを静的に確認する。
  // [FIX22] ctx オブジェクト化（ネストZIP対応の共通化）に伴い `ctx.allRecords.push(r)` という
  //   プレフィックス付き形になったため、正規表現は `(?:ctx\.)?` を許容する（判定意図＝forループ
  //   経由であること・spreadでないこと、は不変）。
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'import-gsi-building-outline.js'), 'utf-8');
  assert.doesNotMatch(src, /(?:ctx\.)?allRecords\.push\(\.\.\.records\)/, 'spread構文に退行している（大量件数でRangeErrorになる）');
  assert.match(src, /for \(const r of records\) (?:ctx\.)?allRecords\.push\(r\);/);
});

test('[FIX22実測で発見・修正] building-outline-lines.json は JSON.stringify 一括呼び出しで書いていない（RangeError: Invalid string length 回帰防止）', () => {
  // [FIX22] 大阪市24区全域(6メッシュ・596,183 clean features)では writeJson(JSON.stringify(全体))
  // が V8 の文字列長上限を超えて RangeError: Invalid string length を起こした（実測）。
  // feature 1件ずつ streaming で書く writeLargeLinesJson に修正済み。退行検出。
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'import-gsi-building-outline.js'), 'utf-8');
  assert.doesNotMatch(src, /writeJson\(OUT_LINES,/, 'building-outline-lines.json の書込が一括JSON.stringify方式に退行している');
  assert.match(src, /writeLargeLinesJson\(OUT_LINES,/);
});

test('[README] data/raw/gsi/building-outline/README.md が存在し取得手順を明示している', () => {
  const p = R('data', 'raw', 'gsi', 'building-outline', 'README.md');
  assert.ok(fs.existsSync(p));
  const t = fs.readFileSync(p, 'utf-8');
  assert.match(t, /service\.gsi\.go\.jp\/kiban/);
  assert.match(t, /BldL/);
  assert.match(t, /GSI_BUILDING_OUTLINE_RAW_DATA_MISSING/);
});
