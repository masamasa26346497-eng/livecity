// Mission 133: 24区別の受入表（建物 / 道路 / 河川）を組み立てる純関数。
//
// 方針:
//  - ファイル在庫・HTTP（verify-ward-layers.js の結果）と、実ブラウザ検証（別ファイル）を混同しない。
//  - 区が 'browser-verified' になるのは、建物・道路・河川の「個別ON/OFFによる実WebGL画素差分 > 0」が
//    3つとも記録されている場合のみ。manifest/HTTP/ファイル在庫だけでは決して成功扱いにしない。
//  - 道路・河川が「線のみ」のとき面描画の証拠としては数えない（waterKind / roadKind で明示）。
//  - データが無い区は reasonNotRun に理由コードを入れる（"未実施" を空欄にしない）。

export const LAYERS = ['buildings', 'roads', 'water'];

/** 実ブラウザ結果1区分の形:
 *  { buildings:{pixelDiff,pass}, roads:{pixelDiff,pass}, water:{pixelDiff,pass},
 *    clickId, fps, memoryMB, alignment:{pass} }  */
export function layerBrowserOk(b) {
  return !!b && Number.isFinite(b.pixelDiff) && b.pixelDiff > 0 && b.pass === true;
}

/** 区内カバレッジの下限（insideWard.ratio）。これ未満/未検証は完成扱いにしない。 */
export const MIN_INSIDE_WARD_RATIO = 0.9;

/** HTTP: 建物・道路・河川(waterways)・水面(water-surface)の全URLが200であること（byLayer で独立判定）。 */
export function httpComplete(http) {
  if (!http || !http.byLayer) return false;
  return ['buildings', 'roads', 'waterways', 'waterSurface'].every((l) => http.byLayer[l] && http.byLayer[l].allOk === true);
}

/** 追加ゲート。各ゲートは独立に失敗理由を返す（空配列=全合格）。 */
export function gateFailures(r, browser, row) {
  const f = [];
  const L = r.layers || {};
  for (const l of LAYERS) if (!layerBrowserOk(browser[l])) f.push(`pixel:${l}`);
  if (!(browser.alignment && browser.alignment.pass === true)) f.push('alignment');
  if (!httpComplete(r.http)) f.push('http200');
  const c = browser.click;
  if (!(c && typeof c.canonicalId === 'string' && c.canonicalId && c.canonicalId === c.expectedId)) f.push('clickCanonicalId');
  const ratio = r.checks && r.checks.insideWard ? r.checks.insideWard.ratio : null;
  if (!(Number.isFinite(ratio) && ratio >= MIN_INSIDE_WARD_RATIO)) f.push('wardCoverage');
  // 河川: データに線/面がある側は、その側の画素証拠を独立に要求
  if (row.waterLine && !layerBrowserOk(browser.waterLine)) f.push('pixel:waterLine');
  if (row.waterPolygon && !layerBrowserOk(browser.waterPolygon)) f.push('pixel:waterPolygon');
  if (!row.waterLine && !row.waterPolygon) f.push('water:no-features');
  // 道路: 線は必須。面(surface)証拠は roads.surface===true の区のみ必須
  if (row.roadKind === 'none') f.push('roads:no-features');
  else if (!layerBrowserOk(browser.roadLine)) f.push('pixel:roadLine');
  if (L.roads && L.roads.surface === true && !layerBrowserOk(browser.roadSurface)) f.push('pixel:roadSurface');
  return f;
}

export function roadKind(roadsLayer) {
  if (!roadsLayer || roadsLayer.status === 'missing') return 'none';
  return roadsLayer.features > 0 ? 'lines' : 'none'; // 現行 roads タイルは中心線。面(ribbon)描画の証拠は browser 側でのみ確認する
}

function reasonNotRun(r, browser) {
  if (browser) return '';
  if (!r || r.status === 'unknown-ward') return 'unknown-ward';
  const miss = [];
  if (!r.layers || !r.layers.buildings || r.layers.buildings.status !== 'ok') miss.push(`buildings:${(r.layers && r.layers.buildings && r.layers.buildings.code) || 'absent'}`);
  if (!r.layers || !r.layers.roads || r.layers.roads.status !== 'ok') miss.push(`roads:${(r.layers && r.layers.roads && r.layers.roads.code) || 'absent'}`);
  if (!r.layers || !r.layers.waterways || r.layers.waterways.status !== 'ok') miss.push(`waterways:${(r.layers && r.layers.waterways && r.layers.waterways.code) || 'absent'}`);
  return miss.length ? `データ不足 ${miss.join(', ')}` : 'ブラウザ検証未実行（データは在庫OK）';
}

export function buildAcceptanceRow(verifyResult, browser) {
  const r = verifyResult || {};
  const L = r.layers || {};
  const c = r.checks || {};
  const row = {
    ward: r.ward || r.wardKey,
    wardKey: r.wardKey,
    buildingSource: L.buildings ? `${L.buildings.tilesPresent || 0}/${L.buildings.tilesDeclared || 0} tiles, ${L.buildings.buildingsLoaded || 0}/${(r.declared && r.declared.buildings) || '?'} 棟` : 'absent',
    buildings: L.buildings ? L.buildings.status : 'absent',
    roads: L.roads ? L.roads.status : 'absent',
    roadKind: roadKind(L.roads),
    waterLine: !!(L.waterways && L.waterways.water && L.waterways.water.lines),
    waterPolygon: !!(L.waterways && L.waterways.water && L.waterways.water.polygons),
    waterKind: r.waterKind || 'unknown',
    http200: r.http ? `${r.http.ok200}/${r.http.checked}` : '未実施',
    insideWard: c.insideWard && c.insideWard.ratio != null ? `${(c.insideWard.ratio * 100).toFixed(1)}%` : '未検証',
    groundBase: c.groundBase ? (c.groundBase.pass ? 'OK' : 'NG') : '未検証',
    browser: browser
      ? {
        buildings: layerBrowserOk(browser.buildings), roads: layerBrowserOk(browser.roads), water: layerBrowserOk(browser.water),
        clickId: browser.clickId ?? null, fps: browser.fps ?? null, memoryMB: browser.memoryMB ?? null,
        alignment: browser.alignment ? browser.alignment.pass === true : null,
      }
      : null,
  };
  const fails = browser ? gateFailures(r, browser, row) : ['no-browser-result'];
  row.gateFailures = fails;
  row.verdict = fails.length === 0 ? 'browser-verified' : 'not-verified';
  row.reasonNotRun = row.verdict === 'browser-verified' ? '' : (browser ? `ブラウザ検証で不合格/不足: ${fails.join(', ')}` : reasonNotRun(r, browser));
  return row;
}

export function buildAcceptanceTable(verifyResults, browserByWard = {}, expectedWardKeys = null) {
  const keys = expectedWardKeys || verifyResults.map((r) => r.wardKey);
  const byKey = new Map(verifyResults.map((r) => [r.wardKey, r]));
  const rows = keys.map((k) => buildAcceptanceRow(byKey.get(k) || { wardKey: k, status: 'unknown-ward' }, browserByWard[k]));
  const verified = rows.filter((x) => x.verdict === 'browser-verified').length;
  return { rows, total: rows.length, browserVerified: verified, allVerified: rows.length === 24 && verified === 24 };
}

export function renderMarkdown(table) {
  const yn = (v) => (v === true ? 'OK' : v === false ? 'NG' : '-');
  const h = ['| 区 | 建物ソース | 道路 | 道路種別 | 河川線 | 水面polygon | HTTP200 | 区内率 | 地表 | 実画素 建物 | 実画素 道路 | 実画素 河川 | クリックID | FPS | 位置整合 | 判定 | 未実施/不合格理由 |', '|' + '---|'.repeat(17)];
  for (const r of table.rows) {
    const b = r.browser;
    h.push(`| ${r.ward} | ${r.buildingSource} | ${r.roads} | ${r.roadKind} | ${r.waterLine ? 'あり' : 'なし'} | ${r.waterPolygon ? 'あり' : 'なし'} | ${r.http200} | ${r.insideWard} | ${r.groundBase} | ${b ? yn(b.buildings) : '未実施'} | ${b ? yn(b.roads) : '未実施'} | ${b ? yn(b.water) : '未実施'} | ${b && b.clickId ? b.clickId : '-'} | ${b && b.fps != null ? b.fps : '-'} | ${b ? yn(b.alignment) : '未実施'} | ${r.verdict} | ${r.reasonNotRun} |`);
  }
  h.push('', `実ブラウザで建物・道路・河川が個別に証明された区: **${table.browserVerified}/${table.total}**。` + (table.allVerified ? ' 24/24 達成。' : ' 24区完成ではない。'));
  return h.join('\n') + '\n';}
