// tests/household-composition.test.js
// 世帯構成比変換処理のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import path from 'path';
import { convertHouseholdCompositionCsv, parseCsv, convertHouseholdCompositionTable } from '../tools/convert/demographics/household-composition.js';
import { normalizeHeaderForMatching, headerMatchesAlias } from '../tools/lib/chocho-normalize.js';

const FIXTURE_PATH = path.join(import.meta.dirname, '..', 'tools', 'lib', '__fixtures__', 'estat', 'household-composition-sample.csv.cp932');

test('世帯構成変換: CP932で正しくデコードされ、対象3区(27120,27121,27126)のみ抽出される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records, encoding } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  assert.match(encoding, /CP932/);
  // 27120(住吉区)2件 + 27121(東住吉区)1件 + 27126(平野区)1件 = 4件
  // (27102都島区・27120の区合計(レベル1)は対象外として除外される)
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => ['27120', '27121', '27126'].includes(r.municipalityCode)));
});

test('世帯構成変換: 地域階層レベル4以外(区合計等)は除外される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { skippedRows } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const totalRowSkip = skippedRows.find((s) => s.reason === 'municipality-total-row');
  assert.ok(totalRowSkip, '区合計行(レベル1)がmunicipality-total-rowとしてスキップされている');
});

test('世帯構成変換: 1人世帯率が正しく計算される(650/1373*100=47.3%)', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const minamisumiyoshi = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(minamisumiyoshi.singlePersonHouseholdRate, 47.3);
});

test('世帯構成変換: 4人以上世帯数が4・5・6・7人以上世帯の合算になる(100+30+10+3=143)', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const minamisumiyoshi = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(minamisumiyoshi.fourOrMorePersonHouseholds, 143);
});

test('世帯構成変換: 一般世帯数が0の場合、比率を計算しない(0除算を回避する)', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const imabayashi = records.find((r) => r.chochoName === '今林一丁目');
  assert.equal(imabayashi.generalHouseholds, 0); // 真の0として保持される(nullではない)
  assert.equal(imabayashi.singlePersonHouseholdRate, null); // 比率は計算しない
  assert.equal(imabayashi.twoPersonHouseholdRate, null);
  assert.equal(imabayashi.threePersonHouseholdRate, null);
  assert.equal(imabayashi.fourOrMorePersonHouseholdRate, null);
});

test('世帯構成変換: 秘匿値(X)を0として扱わず、全項目nullかつsuppressed:trueになる', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const sugimoto = records.find((r) => r.chochoName === '杉本三丁目');
  assert.equal(sugimoto.generalHouseholds, null);
  assert.equal(sugimoto.generalHouseholdsSuppressed, true);
  assert.equal(sugimoto.fourOrMorePersonHouseholds, null);
  assert.equal(sugimoto.fourOrMorePersonHouseholdsSuppressed, true);
  // 秘匿の場合、比率も計算しない
  assert.equal(sugimoto.singlePersonHouseholdRate, null);
});

test('世帯構成変換: 4人以上世帯の一部だけが秘匿でも、全体をsuppressedとして扱う(部分合算しない)', () => {
  // 4人世帯のみ秘匿、5・6・7人以上は通常値というケースを想定したfixture
  const rows = [
    ['1', 'タイトル'],
    ['2', '第5-2表'],
    ['3', '', '', '', '', '', '', '', '', '', '', '一般世帯数', '一般世帯数', '一般世帯数', '一般世帯数', '一般世帯数', '一般世帯数', '一般世帯数', '一般世帯数', '一般世帯の1世帯当たり人員'],
    ['4', '市区町村コード', '町丁字コード', '地域階層レベル', '秘匿処理', '秘匿先情報', '合算地域', '都道府県名', '市区町村名', '大字・町名', '字・丁目名', '一般世帯数', '1人世帯', '2人世帯', '3人世帯', '4人世帯', '5人世帯', '6人世帯', '7人以上世帯', '1世帯当たり人員'],
    ['5', '27120', '999999', '4', '', '', '', '大阪府', '大阪市住吉区', 'テスト', '町', '1000', '500', '300', '100', 'X', '20', '10', '5', '2.0'],
  ];
  const { records } = convertHouseholdCompositionTable(rows, ['27120']);
  const r = records[0];
  assert.equal(r.fourOrMorePersonHouseholds, null); // 4人世帯がXのため、合算全体をnullにする
  assert.equal(r.fourOrMorePersonHouseholdsSuppressed, true);
  assert.equal(r.fourOrMorePersonHouseholdRate, null);
});

test('世帯構成変換: 異なる区の同一町丁字コードを正しく区別する複合キーが生成される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const minamisumiyoshi = records.find((r) => r.chochoName === '南住吉一丁目'); // 27120:001001
  const imabayashi = records.find((r) => r.chochoName === '今林一丁目'); // 27121:001001 (同一chochoCode、別区)
  assert.equal(minamisumiyoshi.chochoCode, imabayashi.chochoCode); // chochoCode自体は同じ"001001"
  assert.notEqual(minamisumiyoshi.compositeCode, imabayashi.compositeCode); // しかし複合キーは異なる
  assert.equal(minamisumiyoshi.compositeCode, '27120:001001');
  assert.equal(imabayashi.compositeCode, '27121:001001');
});

test('CSVパーサ: ダブルクォート内のカンマ・エスケープを正しく扱う', () => {
  const text = 'a,"b,c","d""e",f';
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ['a', 'b,c', 'd"e', 'f']);
});

// ── 実際のe-Stat見出し表記の差異に対応するテスト ──
// 【背景】ユーザーが実際にローカルPCで実行した際、ここまでのfixture(「1人世帯」表記)とは
// 異なり、実データでは「世帯人員が1人」のような表記だったため列検出が全て失敗した。
// この実例を再現したfixtureで、別名マッピング・複数行見出し結合が機能することを確認する。
const REAL_HEADER_FIXTURE_PATH = path.join(import.meta.dirname, '..', 'tools', 'lib', '__fixtures__', 'estat', 'household-composition-real-headers.csv.cp932');

test('世帯構成変換: 実際のe-Stat見出し表記("世帯人員が1人"等)から列を検出できる', async () => {
  const buffer = await readFile(REAL_HEADER_FIXTURE_PATH);
  const { records, encoding } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  assert.match(encoding, /CP932/);
  assert.equal(records.length, 4);
  const minamisumiyoshi = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(minamisumiyoshi.generalHouseholds, 1373);
  assert.equal(minamisumiyoshi.onePersonHouseholds, 650);
});

test('世帯構成変換: 2人～7人以上まで全て"世帯人員がN人"表記から検出できる', async () => {
  const buffer = await readFile(REAL_HEADER_FIXTURE_PATH);
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  const minamisumiyoshi = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(minamisumiyoshi.twoPersonHouseholds, 400);
  assert.equal(minamisumiyoshi.threePersonHouseholds, 180);
  assert.equal(minamisumiyoshi.fourPersonHouseholds, 100);
  assert.equal(minamisumiyoshi.fivePersonHouseholds, 30);
  assert.equal(minamisumiyoshi.sixPersonHouseholds, 10);
  assert.equal(minamisumiyoshi.sevenOrMorePersonHouseholds, 3);
});

test('見出し正規化: 全角数字が半角に正規化される', () => {
  assert.equal(normalizeHeaderForMatching('世帯人員が１人'), '世帯人員が1人');
});

test('見出し正規化: 注釈記号(※1, 注1)が除去される', () => {
  assert.equal(normalizeHeaderForMatching('一般世帯数※1'), '一般世帯数');
  assert.equal(normalizeHeaderForMatching('一般世帯数(注1)'), '一般世帯数注1'.replace('注1', '')); // 括弧除去後に注釈除去
});

test('見出し正規化: 括弧の表記差(全角/半角)が吸収される', () => {
  assert.equal(normalizeHeaderForMatching('世帯人員（7区分）'), normalizeHeaderForMatching('世帯人員(7区分)'));
});

test('見出しマッチング: 「15人」を「5人」の別名と誤認しない(回帰テスト)', () => {
  const normalized15 = normalizeHeaderForMatching('世帯人員が15人');
  assert.equal(headerMatchesAlias(normalized15, '5人世帯'), false);
  assert.equal(headerMatchesAlias(normalized15, '世帯人員が15人'), true);
});

test('見出し検出: 表のタイトル行(「第5-2表 世帯人員の人数別一般世帯数...」)を誤ってヘッダー行と判定しない(回帰テスト)', async () => {
  // 【発覚した実バグ】タイトル行自体に「一般世帯」「1人」「2人」「3人」「1世帯当たり人員」が
  // 偶然全て部分文字列として含まれるため、識別語の出現数だけで判定すると誤ってタイトル行を
  // ヘッダー行として選んでしまっていた。「市区町村コード」を必須条件にする修正で解決した。
  const buffer = await readFile(REAL_HEADER_FIXTURE_PATH);
  // 変換が例外を投げずに成功すること自体が、タイトル行を誤検出していないことの確認になる
  // (誤検出していた場合は市区町村コード列等が全て検出失敗し例外が投げられる)。
  const { records } = convertHouseholdCompositionCsv(buffer, {}, ['27120', '27121', '27126']);
  assert.equal(records.length, 4);
});
