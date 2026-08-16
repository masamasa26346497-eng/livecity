// tests/population-2015.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import path from 'path';
import { convertPopulation2015Csv } from '../tools/convert/demographics/population-2015.js';

const FIXTURE_PATH = path.join(import.meta.dirname, '..', 'tools', 'lib', '__fixtures__', 'estat', 'population-2015-sample.csv.cp932');

test('2015年人口変換: CP932で正しくデコードされ、対象3区のみ抽出される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records, encoding } = convertPopulation2015Csv(buffer, {}, ['27120', '27121', '27126']);
  assert.match(encoding, /CP932/);
  assert.equal(records.length, 4); // 27120x2 + 27121x1 + 27126x1 (都島区27102は対象外、レベル1/2は除外)
});

test('2015年人口変換: 地域階層レベル3(2015年の町丁目最小粒度)のみ抽出される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { skippedRows } = convertPopulation2015Csv(buffer, {}, ['27120', '27121', '27126']);
  assert.ok(skippedRows.some((s) => s.reason === 'municipality-total-row')); // レベル1
  assert.ok(skippedRows.some((s) => s.reason === 'subtotal-row')); // レベル2
});

test('2015年人口変換: 秘匿値(X)はnull+suppressed:trueとして保持される(0として扱わない)', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertPopulation2015Csv(buffer, {}, ['27120', '27121', '27126']);
  const sugimoto = records.find((r) => r.chochoName === '杉本三丁目');
  assert.equal(sugimoto.population2015, null);
  assert.equal(sugimoto.population2015Suppressed, true);
});

test('2015年人口変換: 真の0(秘匿でない)は0として保持される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertPopulation2015Csv(buffer, {}, ['27120', '27121', '27126']);
  const imabayashi = records.find((r) => r.chochoName === '今林一丁目');
  assert.equal(imabayashi.population2015, 0);
  assert.equal(imabayashi.population2015Suppressed, false);
});

test('2015年人口変換: 複合コードが正しく生成される', async () => {
  const buffer = await readFile(FIXTURE_PATH);
  const { records } = convertPopulation2015Csv(buffer, {}, ['27120', '27121', '27126']);
  const minamisumiyoshi = records.find((r) => r.chochoName === '南住吉一丁目');
  assert.equal(minamisumiyoshi.compositeCode, '27120:001001');
});
