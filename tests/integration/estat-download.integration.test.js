// tests/integration/estat-download.integration.test.js
// 実際にe-Statへネットワーク接続して、生バイト取得・文字コード判定・変換までを検証する
// 統合テスト。ネットワークが無い環境(Claude Code サンドボックス等)では明示的にskipし、
// 失敗とはしない。ローカルPC・GitHub Actions等、実際にe-Statへ到達できる環境でのみ実行される。
//
// 実行: npm run test:integration:estat
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadRawBytes } from '../../tools/lib/estat/file-download-client.js';
import { convertHouseholdCompositionCsv } from '../../tools/convert/demographics/household-composition.js';
import { convertPopulation2015Csv } from '../../tools/convert/demographics/population-2015.js';

const HOUSEHOLD_COMPOSITION_URL = 'https://www.e-stat.go.jp/stat-search/file-download?fileKind=1&statInfId=000032163488';
const POPULATION_2015_URL = 'https://www.e-stat.go.jp/stat-search/file-download?fileKind=1&statInfId=000031522156';
const TARGET_MUNICIPALITY_CODES = ['27120', '27121', '27126'];

/**
 * e-Statへの到達性を簡易に確認する。DNS解決やTLSハンドシエイクの時点で失敗する場合
 * （ネットワーク自体が無い等）に加えて、接続自体は成立するがHTTPレベルで拒否される場合
 * （例: 隔離環境のegressプロキシがTLS接続は許可するがリクエストは403で拒否する）も
 * 「利用不可」として扱う。2xx以外は全て利用不可と判定する。
 */
async function checkNetworkAvailable() {
  try {
    const res = await fetch('https://www.e-stat.go.jp/', { method: 'HEAD' });
    if (!res.ok) {
      return { available: false, reason: `HTTP ${res.status} ${res.statusText}（接続は成立したがリクエストが拒否された）` };
    }
    return { available: true, status: res.status };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

let networkCheck = null;
async function getSkipReason() {
  if (networkCheck === null) {
    networkCheck = await checkNetworkAvailable();
  }
  if (!networkCheck.available) {
    return `e-Statへのネットワーク接続ができません(${networkCheck.reason})。` +
      `Claude Code等の隔離環境ではこのテストは意図的にskipされます。` +
      `ローカルPCまたはGitHub Actions環境ではこのテストが実行されます。`;
  }
  return false;
}

test('統合テスト: 世帯構成CSVを実際にe-Statから取得し、CP932で正しく変換できる', async (t) => {
  const skipReason = await getSkipReason();
  if (skipReason) { t.skip(skipReason); return; }

  const { buffer, status, headers } = await downloadRawBytes(HOUSEHOLD_COMPOSITION_URL);
  assert.equal(status, 200);
  assert.ok(buffer.length > 0);

  const { records, encoding } = convertHouseholdCompositionCsv(buffer, headers, TARGET_MUNICIPALITY_CODES);
  assert.match(encoding, /CP932|UTF-8/);
  assert.ok(records.length > 0, '対象3区(住吉区・東住吉区・平野区)から1件以上抽出できること');
  // 杉本三丁目(秘匿、人口3)が含まれることを確認(前回セッションで実在確認済み)
  const sugimoto = records.find((r) => r.chochoName === '杉本三丁目');
  assert.ok(sugimoto, '杉本三丁目が抽出されていること');
});

test('統合テスト: 2015年人口CSVを実際にe-Statから取得し、CP932で正しく変換できる', async (t) => {
  const skipReason = await getSkipReason();
  if (skipReason) { t.skip(skipReason); return; }

  const { buffer, status, headers } = await downloadRawBytes(POPULATION_2015_URL);
  assert.equal(status, 200);
  assert.ok(buffer.length > 0);

  const { records, encoding } = convertPopulation2015Csv(buffer, headers, TARGET_MUNICIPALITY_CODES);
  assert.match(encoding, /CP932|UTF-8/);
  assert.ok(records.length > 0, '対象3区から1件以上抽出できること');
});
