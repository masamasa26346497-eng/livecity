// tools/lib/estat/api-client.js
// e-Stat統計データ取得API(version 3.0)のクライアント。
//
// 【重要な制約】2026年6月の調査時点で、令和2年国勢調査「小地域集計」は
// e-Stat上で「ファイル」形式のみで提供されており、本APIクライアントが対象とする
// 「データベース」形式(DB)では提供されていないことが確認されている
// (e-Stat公式説明: 「API機能で利用できる統計データは、e-Stat上で『DB』表示のある
// データに対応」)。そのため、住吉区・東住吉区・平野区の世帯人員別世帯数データの
// 取得には、本クライアントではなく tools/lib/estat/file-download-client.js を使う
// 必要がある可能性が高い。本クライアントは、将来小地域集計がDB化された場合や、
// 他のDB対応統計を取得する場合のために実装している。
//
// アプリケーションIDはコードに埋め込まず、環境変数 ESTAT_APP_ID から読み込む。
const API_BASE_URL = 'https://api.e-stat.go.jp/rest/3.0/app/json';

export class EstatConfigError extends Error {}

/**
 * 環境変数からe-Stat アプリケーションIDを取得する。未設定の場合は、原因と対処法が
 * 明確に分かるエラーを投げる(無言で失敗させない、架空のIDで進めない)。
 */
export function getAppId() {
  const appId = process.env.ESTAT_APP_ID;
  if (!appId) {
    throw new EstatConfigError(
      'ESTAT_APP_ID is not configured.\n' +
      'Create an e-Stat API application ID and set it in the environment.\n' +
      '取得方法: https://www.e-stat.go.jp/ にユーザ登録 → ログイン後「マイページ」→ ' +
      '「API機能(アプリケーションID発行)」から発行（無料）。\n' +
      '取得したIDを .env ファイルの ESTAT_APP_ID=<取得したID> に設定してください' +
      '（.env.example を参照）。'
    );
  }
  return appId;
}

/**
 * 統計データ取得API(getStatsData)を呼び出す。
 * @param {object} params { statsDataId, cdArea, cdCat01, ... } など、e-Stat APIの
 *   パラメータをそのまま渡す(appId/lang以外)。
 * @returns {Promise<object>} GET_STATS_DATAのJSONオブジェクト
 */
export async function getStatsData(params) {
  const appId = getAppId();
  const query = new URLSearchParams({
    appId,
    lang: 'J',
    ...params,
  });
  const url = `${API_BASE_URL}/getStatsData?${query.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`e-Stat API HTTPエラー: ${res.status} ${res.statusText} (URL: ${url.replace(appId, '***')})`);
  }
  const json = await res.json();
  const result = json?.GET_STATS_DATA?.RESULT;
  if (!result) {
    throw new Error('e-Stat APIレスポンスの形式が想定と異なります(GET_STATS_DATA.RESULTが存在しない)。');
  }
  if (String(result.STATUS) !== '0') {
    throw new Error(`e-Stat APIエラー(STATUS=${result.STATUS}): ${result.ERROR_MSG}`);
  }
  return json.GET_STATS_DATA;
}

/**
 * 指定した統計表が「データベース」形式(API対応)で提供されているかを、
 * 件数のみ取得(cntGetFlg=Y, metaGetFlg=N)するリクエストで確認する。
 * エラーになった場合はDB非対応の可能性が高いことを示す。
 */
export async function checkStatsDataAvailability(statsDataId) {
  try {
    const data = await getStatsData({ statsDataId, cntGetFlg: 'Y', metaGetFlg: 'N' });
    const total = data?.STATISTICAL_DATA?.RESULT_INF?.TOTAL_NUMBER;
    return { available: true, totalNumber: total };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}
