'use strict';
// Mission 62 P0: 既存の Git 追跡済み JSON/コードだけを読む（外部通信なし。http/https/fetch を使わない）。
// 出力: data/reports/mission62/evidence.json
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const out = { mission: '62', network: { externalGets: 0, note: 'fs 読み取りのみ' } };

// (1) Mission58: 建物 pick の深度読み戻し。h は「画面中心ピクセルの深度から復元した高さ」。
// globe=true で屋根(=expect.h)でなく地表(≈0)を拾う例は、translucent な面が depth を書かず、
// 屋根が深度に入らない/別プリミティブが先に決まる、という描画順の事実を示す。
out.mission58 = {};
for (const label of ['none', 'gsipale']) {
  const d = rd('data/reports/mission58-plates/' + label + '-result.json');
  const rows = (d.samples || []).filter((s) => s.hit && s.expect);
  out.mission58[label] = {
    sampleCount: rows.length,
    jsErrors: (d.jsErrors || []).length,
    googleRequests: d.googleRequests,
    horizontalMaxM: Math.max(0, ...rows.map((s) => Math.abs(s.dxz || 0))),
    roofHit: rows.filter((s) => Math.abs(s.dh) < 0.5).length,
    groundHit: rows.filter((s) => Math.abs(s.hit.h) < 0.5 && s.expect.h > 1).length,
    byKind: rows.reduce((a, s) => { const k = s.kind + '|globe=' + s.globe; a[k] = (a[k] || 0) + 1; return a; }, {}),
  };
}

// (2) Mission59: 背景ラスタ(bg)と描画(render)の画像レジストレーション（同一カメラ）
const bg = rd('data/reports/mission59/bg-vs-render.json');
out.mission59 = (bg.points || []).map((p) => ({
  name: p.name, lat: p.lat, lon: p.lon, localXZ: p.localXZ, metersPerPixel: p.metersPerPixel,
  shiftMeters: p.shiftMeters, peakOverMean: p.registration && p.registration.peakOverMean,
  maskPx: p.registration && p.registration.maskPx,
}));

// (3) Mission61 の距離統計を「異なる地物間の距離」として再掲（真の座標誤差ではない）
const j = rd('data/reports/mission61/offline-join.json');
out.mission61Keys = Object.keys(j);

// (4) 視点別の理論見かけずれ: 高さ h の面を、地表に対し仰角 e で見たときの水平見かけずれ = h / tan(e)
out.layerApparentShiftM = {};
const LAYER_H = { waterways: 0.5, parks: 0.9, roadsCasing: 1.3, roads: 1.4, railways: 2.0 };
for (const [name, h] of Object.entries(LAYER_H)) {
  out.layerApparentShiftM[name] = {};
  for (const e of [90, 60, 45, 30, 15]) out.layerApparentShiftM[name]['elev' + e] = +(h / Math.tan(e * Math.PI / 180)).toFixed(2);
}

// (5) コード上の設定の行番号（現ファイルを grep して記録）
const html = fs.readFileSync(path.join(root, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8').split('\n');
const find = (re) => html.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean).slice(0, 12);
out.codeLines = {
  depthTestAgainstTerrain: find(/depthTestAgainstTerrain\s*=/),
  LAYER_H: find(/const LAYER_H\s*=/),
  toCart: find(/const toCart\s*=/),
  areaPolygonHeight: find(/height: opts\.height, perPositionHeight: false/),
  translucentAppearance: find(/translucent: true/),
  groundPrimitiveOrClassification: find(/GroundPrimitive|ClassificationPrimitive|clampToGround|HeightReference/),
  primitivesAddOrder: find(/scene\.primitives\.add\(/),
};

fs.mkdirSync(path.join(root, 'data/reports/mission62'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/reports/mission62/evidence.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
