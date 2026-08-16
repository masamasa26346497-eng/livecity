// tests/demographics.test.js
// 実行: node --test tests/
// Node.js組み込みのテストランナー(node:test)を使用。外部依存なし。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';

import { readXlsxFirstSheet, readXlsxSheet, getSheetNames } from '../tools/lib/xlsx.js';
import { normalizeChochoName, chochoNamesMatch, normalizeChochoCode } from '../tools/lib/chocho-normalize.js';
import { joinByChochoCode } from '../tools/join/chocho-crosswalk.js';
import { convertPopulationHouseholdsXlsx } from '../tools/convert/demographics/population-households.js';
import { convertAgeStructureXlsx } from '../tools/convert/demographics/age-structure.js';
import { calculateForeignPopulationRatio, calculatePopulationChangeRate } from '../tools/calculate/demographics-ratios.js';
import { validatePopulationRecords, validateAgeStructure, validatePercentageRange } from '../tools/lib/validate-demographics.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'tools', 'lib', '__fixtures__', 'demographics');

// 以下2件は、XLSXパーサー自体の低レベルなセル抽出機構（共有文字列・行/列構造の読み取り）の
// 検証用であり、実際の大阪市統計表の構造（複数シート・見出し名ベースの列検出・地域階層レベル
// によるフィルタ等）を再現したものではない。実構造の検証は census-real-structure.xlsx を
// 使ったテスト（下記）で行う。
test('XLSX読み込み: 単純な表構造を正しく抽出する', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-sample.xlsx'));
  const rows = readXlsxFirstSheet(buffer);
  assert.equal(rows.length, 4); // ヘッダー1行+データ3行
  assert.deepEqual(rows[0], ['町丁・字等', '人口（総数）', '人口（男）', '人口（女）', '世帯数', '外国人人口']);
  assert.equal(rows[1][0], '苅田一丁目');
  assert.equal(rows[1][1], '3245');
});

test('XLSX読み込み: 複合ヘッダー・区切り行・秘匿行を含むセル構造を抽出する', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-multiheader.xlsx'));
  const rows = readXlsxFirstSheet(buffer);
  assert.equal(rows.length, 7);
  assert.equal(rows[2][0], '住吉区'); // 区切り行
  assert.equal(rows[6][1], 'X'); // 秘匿マーカー
});

test('町丁目名正規化: 全角/半角数字が同一視される', () => {
  assert.ok(chochoNamesMatch('苅田１丁目', '苅田1丁目'));
});

test('町丁目名正規化: 漢数字丁目が算用数字に変換される', () => {
  assert.equal(normalizeChochoName('苅田十一丁目'), '苅田11丁目');
  assert.equal(normalizeChochoName('苅田二十丁目'), '苅田20丁目');
});

test('町丁目名正規化: ヶ/ケ/がの異体字が統一される', () => {
  assert.ok(chochoNamesMatch('茶屋ヶ丘', '茶屋ケ丘'));
  assert.ok(chochoNamesMatch('茶屋が丘', '茶屋ケ丘'));
});

test('町丁目コード結合: 複合キー(municipalityCode+chochoCode)優先、名称はフォールバック、不一致はunmatchedへ分離される', () => {
  const master = [
    { municipalityCode: '27108', chochoCode: '0010', chochoName: '苅田一丁目' },
    { municipalityCode: '27108', chochoCode: '0020', chochoName: '苅田二丁目' },
  ];
  const records = [
    { chochoName: '苅田一丁目', population: 3245 }, // 名称一致（municipalityCodeを持たない）
    { municipalityCode: '27108', chochoCode: '0020', chochoName: '苅田二丁目', population: 2890 }, // 複合キー一致
    { chochoName: '存在しない町', population: 100 }, // 不一致
  ];
  const result = joinByChochoCode(records, master);
  assert.equal(result.matched.length, 2);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.matched[0].matchMethod, 'normalized-name');
  assert.equal(result.matched[1].matchMethod, 'municipality-and-chocho-code');
  assert.equal(result.matched[1].joinConfidence, 'high');
  assert.equal(result.matched[0].joinConfidence, 'fallback');
  assert.equal(result.unmatched[0].chochoName, '存在しない町');
  assert.ok(result.unmatched[0].unmatchedReason); // 理由が必ず記録されている
});

test('町丁目コード結合: 異なる自治体で同じchochoCodeがあっても複合キーにより誤結合しない', () => {
  // chochoCode単独(例:"0010")はmunicipalityCodeが異なれば全く別の町丁目を指す。
  // municipalityCodeを含めない結合は危険であることを実証する回帰テスト。
  const master = [
    { municipalityCode: '27120', chochoCode: '1001', chochoName: '南住吉一丁目' }, // 住吉区
    { municipalityCode: '27121', chochoCode: '1001', chochoName: '今川一丁目' }, // 東住吉区（chochoCodeが偶然同じ）
  ];
  const records = [
    { municipalityCode: '27121', chochoCode: '1001', chochoName: '今川一丁目', population: 500 },
  ];
  const result = joinByChochoCode(records, master);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matchMethod, 'municipality-and-chocho-code');
  // 誤って住吉区側(南住吉一丁目)に結合されていないことを確認する
  assert.equal(result.matched[0].chochoCode, '1001');
  assert.equal(result.matched[0].municipalityCode, '27121');
});

test('町丁目コード結合: 同名町丁目が複数区にある場合、自動で誤結合せずmultipleCandidatesへ報告する', () => {
  // 「本町」のような町丁目名は複数の区に同名で存在しうる。区名を含めない名称だけでの
  // 結合は危険なため、record側がfullChochoNameを持たない(区名を判別できない)ケースで
  // マスタ側に複数の同名候補がある場合は、どちらにも結合せず明示的に報告する。
  const master = [
    { chochoCode: null, originalFullName: '住吉区本町1丁目', chochoName: '本町1丁目' },
    { chochoCode: null, originalFullName: '東住吉区本町1丁目', chochoName: '本町1丁目' },
  ];
  const records = [
    { chochoName: '本町1丁目', population: 1000 }, // fullChochoNameを持たないため区が判別できない
  ];
  const result = joinByChochoCode(records, master);
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.multipleCandidates.length, 1);
  assert.equal(result.multipleCandidates[0].candidateCount, 2);
  assert.equal(result.matchStats.multipleCandidatesCount, 1);
});

test('町丁目コード結合: fullChochoName(区名込み)があれば同名町丁目でも正しく一意に結合できる', () => {
  const master = [
    { chochoCode: null, originalFullName: '住吉区本町1丁目', chochoName: '本町1丁目' },
    { chochoCode: null, originalFullName: '東住吉区本町1丁目', chochoName: '本町1丁目' },
  ];
  const records = [
    { ward: '住吉区', chochoName: '本町1丁目', fullChochoName: '住吉区本町1丁目', population: 1000 },
  ];
  const result = joinByChochoCode(records, master);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matchMethod, 'full-normalized-name');
});

test('町丁目コード結合: 境界マスタ側のみに存在する町丁目をmasterOnlyEntriesとして報告する', () => {
  const master = [
    { chochoCode: null, originalFullName: '住吉区我孫子1丁目', chochoName: '我孫子1丁目', boundaryId: '住吉区我孫子1丁目' },
    { chochoCode: null, originalFullName: '住吉区我孫子2丁目', chochoName: '我孫子2丁目', boundaryId: '住吉区我孫子2丁目' },
  ];
  const records = [
    { ward: '住吉区', chochoName: '我孫子1丁目', fullChochoName: '住吉区我孫子1丁目', population: 1000 },
  ];
  const result = joinByChochoCode(records, master);
  assert.equal(result.masterOnlyEntries.length, 1);
  assert.equal(result.masterOnlyEntries[0].boundaryId, '住吉区我孫子2丁目');
});

test('XLSX読み込み: 複数シート構成で、データは2番目のシート"第2表"にあり1番目のシートではない', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-real-structure.xlsx'));
  const sheetNames = getSheetNames(buffer);
  assert.deepEqual(sheetNames, ['【利用上の注意】', '第2表']);

  const rows = readXlsxSheet(buffer, '第2表');
  assert.ok(rows.length > 10);
  // ヘッダー小見出し行(5行目, 0-indexed:4)に"市区町村コード"が含まれる
  // （実ファイルではセル内に\r\nが入っているため、判定前に正規化する）
  assert.ok(rows[4].some((c) => (c || '').replace(/[\r\n\s　]/g, '').includes('市区町村コード')));
});

test('人口統計変換(実構造fixture): 見出し名から列を検出し、地域階層レベル4のみを町丁目レコードとして抽出する', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-real-structure.xlsx'));
  const { records, skippedRows } = convertPopulationHouseholdsXlsx(buffer, ['住吉区', '東住吉区', '平野区']);

  // fixtureには レベル4の対象区レコード4件 + レベル1区合計1件 + レベル3小計1件 +
  // レベル4だが対象外区(都島区)1件 + 空行1件 + レベル1市合計1件 が含まれる
  assert.equal(records.length, 4);
  assert.equal(skippedRows.filter((s) => s.reason === 'municipality-total-row').length, 2); // 区合計+市合計
  assert.equal(skippedRows.filter((s) => s.reason === 'subtotal-row').length, 1); // 大字・町丁小計
  assert.equal(skippedRows.filter((s) => s.reason === 'ward-not-in-target').length, 1); // 都島区

  const normal = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(normal.ward, '住吉区');
  assert.equal(normal.population, 2986);
  assert.equal(normal.malePopulation, 1355);
  assert.equal(normal.femalePopulation, 1631);
  assert.equal(normal.foreignPopulation, 52);
  assert.equal(normal.households, 1373);
  assert.equal(normal.populationSuppressed, false);
});

test('人口統計変換(実構造fixture): 秘匿マーカー(X)がnull+suppressedとして保持される', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-real-structure.xlsx'));
  const { records } = convertPopulationHouseholdsXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  const suppressed = records.find((r) => r.chochoName === '南住吉二丁目');
  assert.equal(suppressed.foreignPopulation, null);
  assert.equal(suppressed.foreignPopulationSuppressed, true);
  // 秘匿されていない他の項目は通常通り数値で取得される
  assert.equal(suppressed.population, 3495);
});

test('人口統計変換(実構造fixture): カンマ区切りの数値が正しく解析される', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-real-structure.xlsx'));
  const { records } = convertPopulationHouseholdsXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  const yuzato = records.find((r) => r.chochoName === '湯里一丁目');
  assert.equal(yuzato.population, 1369); // "1,369" -> 1369(数値)として解析される
  assert.equal(typeof yuzato.population, 'number');
});

test('人口統計変換(実構造fixture): fullChochoNameが区名+町丁目名で組み立てられる', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'census-real-structure.xlsx'));
  const { records } = convertPopulationHouseholdsXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  const normal = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(normal.fullChochoName, '住吉区南住吉一丁目');
});

test('比率計算: 通常値はlivecity-calculatedとして算出され、秘匿値は計算しない', () => {
  const records = [
    { population: 3245, foreignPopulation: 42, populationSuppressed: false, foreignPopulationSuppressed: false },
    { population: null, foreignPopulation: null, populationSuppressed: true, foreignPopulationSuppressed: true },
  ];
  const result = calculateForeignPopulationRatio(records);
  assert.equal(result[0].foreignPopulationRatio, 1.3);
  assert.equal(result[0].foreignPopulationRatioValueType, 'livecity-calculated');
  assert.equal(result[1].foreignPopulationRatio, null);
  assert.equal(result[1].foreignPopulationRatioUnavailableReason, 'underlying-value-suppressed');
});

test('増減率計算: 正常ケースと基準値欠損ケースの両方を扱える', () => {
  const ok = calculatePopulationChangeRate(2817994, 2814185);
  assert.equal(ok.valueType, 'livecity-calculated');
  assert.ok(ok.changeRate !== null);

  const missing = calculatePopulationChangeRate(null, 2814185);
  assert.equal(missing.changeRate, null);
  assert.equal(missing.unavailableReason, 'missing-or-zero-base');
});

test('検証: 負の人口・外国人人口過剰を検出する', () => {
  const result = validatePopulationRecords([
    { chochoCode: 'A', population: 100 },
    { chochoCode: 'B', population: -10 },
    { chochoCode: 'C', population: 100, foreignPopulation: 150 },
  ]);
  assert.equal(result.pass, false);
  assert.equal(result.issues.length, 2);
});

test('検証: 年齢階級合計と総人口の差異を検出するが、秘匿がある場合は許容する', () => {
  const result = validateAgeStructure([
    { chochoCode: 'A', totalPopulation: 100, ageGroups: { a: 50, b: 50 } }, // 一致
    { chochoCode: 'B', totalPopulation: 100, ageGroups: { a: 10, b: 10 } }, // 不一致
    { chochoCode: 'C', totalPopulation: 100, ageGroups: { a: 10, b: 'suppressed' } }, // 秘匿のため許容
  ]);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].chochoCode, 'B');
});

test('検証: 割合が0-100の範囲外であれば検出する', () => {
  const result = validatePercentageRange([{ chochoCode: 'A', ratio: 150 }], ['ratio']);
  assert.equal(result.pass, false);
});

// ── 年齢構成（第3表）変換テスト ──
// fixtureは実ファイル(2026年6月にアップロードされた実データ)の構造を忠実に再現したもの:
// 複数シート構成・男女別行(総数/男/女)・地域階層レベル・5歳階級の動的列検出・
// 「100歳以上」列に"-"(=0人、秘匿ではない)が入るケースを含む。
test('年齢構成変換(実構造fixture): "総数"行のみを抽出し、男女別行・区合計・対象外区を除外する', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'age-structure-real-structure.xlsx'));
  const { records, skippedRows } = convertAgeStructureXlsx(buffer, ['住吉区', '東住吉区', '平野区']);

  assert.equal(records.length, 1);
  assert.equal(skippedRows.filter((s) => s.reason === 'sex-breakdown-row').length, 2); // 男・女行
  assert.equal(skippedRows.filter((s) => s.reason === 'municipality-total-row').length, 1);
  assert.equal(skippedRows.filter((s) => s.reason === 'ward-not-in-target').length, 1);
});

test('年齢構成変換(実構造fixture): 5歳階級が見出し名から動的に検出され、要求された年齢区分へ正しく合算される', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'age-structure-real-structure.xlsx'));
  const { records } = convertAgeStructureXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  const r = records[0];
  // fixtureの5歳階級値: 0-4=10,5-9=12,10-14=8 → 0-14歳=30
  assert.equal(r.age0to14, 30);
  // 15-19=15,20-24=20 → 15-24歳=35
  assert.equal(r.age15to24, 35);
  // 25-29=25,30-34=30,35-39=20 → 25-39歳=75
  assert.equal(r.age25to39, 75);
  // 40-44=40,45-49=45,50-54=50,55-59=40,60-64=30 → 40-64歳=205
  assert.equal(r.age40to64, 205);
  // 65-69=20,70-74=15 → 65-74歳=35
  assert.equal(r.age65to74, 35);
});

test('年齢構成変換(実構造fixture): 「100歳以上」列の"-"は0人として扱われ、秘匿と誤判定されない（回帰テスト）', () => {
  // 総務省統計局の公式「利用上の注意」により、「-」は「該当数字がない(=0)」を意味し、
  // 秘匿(数値を「X」に置き換え)とは異なる。この区別を誤ると、実データの検算で
  // 222件の不一致を引き起こした実際の不具合が再発する。
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'age-structure-real-structure.xlsx'));
  const { records } = convertAgeStructureXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  const r = records[0];
  // 75-79=10,80-84=5,85-89=2,90-94=1,95-99=0,100歳以上="-"(=0) → 75歳以上=18
  assert.equal(r.age75plus, 18);
  assert.equal(r.age75plusSuppressed, false);
});

test('年齢構成変換(実構造fixture): 年少人口比率・生産年齢人口比率・高齢化率がlivecity-calculatedとして算出される', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'age-structure-real-structure.xlsx'));
  const { records } = convertAgeStructureXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  const r = records[0];
  // totalPopulation=398, age0to14=30 -> 30/398*100 = 7.5%
  assert.equal(r.youngPopulationRatio, 7.5);
  assert.equal(r.ratioValueType, 'livecity-calculated');
  assert.equal(r.valueType, 'official'); // 元データ自体はofficial、比率のみcalculated
});

test('年齢構成変換(実構造fixture): fullChochoNameがpopulation-householdsと同一形式で組み立てられる', () => {
  const buffer = readFileSync(path.join(FIXTURE_DIR, 'age-structure-real-structure.xlsx'));
  const { records } = convertAgeStructureXlsx(buffer, ['住吉区', '東住吉区', '平野区']);
  assert.equal(records[0].fullChochoName, '住吉区南住吉一丁目');
});

// ── chochoCode正規化(6桁ゼロパディング)の回帰テスト ──
// 【発覚した実バグ】国勢調査XLSXの町丁字コード("1001"等、先頭ゼロなし)と、e-Stat KEY_CODEの
// 町丁字コード部分("001001"等、6桁ゼロパディング)は、実際には同じ町丁目を指す同一コード体系
// だが桁数が異なるため、正規化なしでは複合キー結合が常に0件になっていた(実データで確認済み)。
test('chochoCode正規化: XLSX由来の桁数なしコードが6桁ゼロパディングされ、KEY_CODE由来のコードと一致する', () => {
  // 実データで確認した値: 南住吉一丁目のXLSX町丁字コードは"1001"、KEY_CODE(27120001001)の
  // 町丁字部分は"001001"。両者は同じ町丁目を指す。
  assert.equal(normalizeChochoCode('1001'), '001001');
  // 杉本三丁目: XLSX="24003", KEY_CODE(27120024003)の町丁字部分="024003"
  assert.equal(normalizeChochoCode('24003'), '024003');
});

test('chochoCode正規化: 既に6桁以上のコードはそのまま保持される(再パディングしない)', () => {
  assert.equal(normalizeChochoCode('001001'), '001001');
  assert.equal(normalizeChochoCode('1234567'), '1234567'); // 7桁等、想定外に長いコードも変更しない
});

test('chochoCode正規化: null/空文字はnullを返す(架空のコードを作らない)', () => {
  assert.equal(normalizeChochoCode(null), null);
  assert.equal(normalizeChochoCode(''), null);
});

test('chochoCode正規化: 数字以外を含むコード(特殊記号付き等)はパディングせずそのまま返す', () => {
  assert.equal(normalizeChochoCode('A001'), 'A001');
});
