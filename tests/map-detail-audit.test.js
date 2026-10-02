// tests/map-detail-audit.test.js
// [Mission30] tools/lib/map-detail-audit.js の純粋ロジック（§3/§5/§6/§15）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAUSE, DETAIL_SEVERITY, normalizeCause, isExplainableCause,
  extractExtremeBlank, anomalySummary, consolidateWardScores,
} from '../tools/lib/map-detail-audit.js';

test('[Mission30] CAUSE taxonomy / SEVERITY', () => {
  assert.ok(CAUSE.includes('SOURCE_MISSING') && CAUSE.includes('PORT') && CAUSE.includes('UNKNOWN'));
  assert.equal(CAUSE.length, 13);
  assert.deepEqual([...DETAIL_SEVERITY], ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
});

test('[Mission30] §5 normalizeCause: 自由文 → taxonomy', () => {
  // Mission24 の catch-all（複数施設種の総称）は INDUSTRIAL 代表へ
  assert.equal(normalizeCause({ note: 'PLATEAU 0・OSM も疎（0棟/km²）＝鉄道ヤード/空港敷地/スポーツ島/大規模工業' }), 'INDUSTRIAL');
  // 単独の rail yard note は RAIL_YARD
  assert.equal(normalizeCause({ note: '宮原電車区・貨物駅の車両基地' }), 'RAIL_YARD');
  assert.equal(normalizeCause({ note: '港湾ヤード・コンテナターミナル' }), 'PORT');
  assert.equal(normalizeCause({ note: '中島工業地帯の大規模工場敷地' }), 'INDUSTRIAL');
  assert.equal(normalizeCause({ note: 'OSM road/building データが当該エリアで薄い（known limitation）' }), 'OSM_SPARSE');
  assert.equal(normalizeCause({ note: 'OSM 抽出ファイルの収録範囲外（北端 lat≈34.735）' }), 'SOURCE_MISSING');
  assert.equal(normalizeCause({ note: '暗渠区間（culvert）。地表描画から除外' }), 'UNDERGROUND');
  assert.equal(normalizeCause({ note: 'ラスタ端の丸め（1 cell）' }), 'ROUNDING');
  assert.equal(normalizeCause({ note: '大阪市外周に接する cell（隣接市）', nearCityEdge: true }), 'BOUNDARY');
  assert.equal(normalizeCause({ note: '河川敷' }), 'RIVERBANK');
  assert.equal(normalizeCause({ note: '舞洲・夢洲の埋立地' }), 'COAST');
  assert.equal(normalizeCause({ note: '公園のグラウンド' }), 'PARK');
  assert.equal(normalizeCause({ note: '意味不明なメモ' }), 'UNKNOWN');
});

test('[Mission30] isExplainableCause: UNKNOWN / PLATEAU_MISSING のみ未説明', () => {
  assert.equal(isExplainableCause('PORT'), true);
  assert.equal(isExplainableCause('SOURCE_MISSING'), true);
  assert.equal(isExplainableCause('ROUNDING'), true);
  assert.equal(isExplainableCause('UNKNOWN'), false);
  assert.equal(isExplainableCause('PLATEAU_MISSING'), false);
});

test('[Mission30] §3 extractExtremeBlank: 周囲が密なのに当該だけ空白 = H', () => {
  const bG = new Map();
  // (5,5) 周囲 8 セルに 10 棟ずつ、(5,5) は 0
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue;
    bG.set((5 + dx) + ',' + (5 + dz), { plat: 10, fb: 0 });
  }
  const a = [
    { cx: 5, cz: 5, x: 500, z: 500, ward: 'a' },  // 周囲密 → H
    { cx: 20, cz: 20, x: 2000, z: 2000, ward: 'b' }, // 周囲も空 → not H
  ];
  const h = extractExtremeBlank(a, bG, { neighborMedianMin: 8 });
  assert.equal(h.length, 1);
  assert.equal(h[0].cx, 5);
  assert.equal(h[0].neighborMedianBuildings, 10);
});

test('[Mission30] §15 anomalySummary', () => {
  const anoms = [
    { type: 'A', severity: 'LOW', cause: 'PORT', explained: true },
    { type: 'A', severity: 'INFO', cause: 'INDUSTRIAL', explained: true },
    { type: 'B', severity: 'MEDIUM', cause: 'UNKNOWN', explained: false },
    { type: 'F', severity: 'LOW', cause: 'ROUNDING', explained: true },
    { type: 'H', severity: 'HIGH', cause: 'PLATEAU_MISSING', explained: false },
  ];
  const s = anomalySummary(anoms);
  assert.equal(s.total, 5);
  assert.equal(s.bySeverity.HIGH, 1);
  assert.equal(s.bySeverity.MEDIUM, 1);
  assert.equal(s.bySeverity.LOW, 2);
  assert.equal(s.byType.A, 2);
  assert.equal(s.byCause.PORT, 1);
  // unexplained = MEDIUM+ かつ cause が UNKNOWN/PLATEAU_MISSING かつ !explained
  assert.equal(s.unexplained, 2, 'B(MEDIUM,UNKNOWN) + H(HIGH,PLATEAU_MISSING)');
});

test('[Mission30] §6 consolidateWardScores', () => {
  const mcByWard = {
    a: { buildingCoverage: 0.9, roadCoverage: 0.95, landCells: 100, riverCells: 5, parkCells: 3, railCells: 8, landStatus: 'PASS', roadStatus: 'PASS' },
    b: { buildingCoverage: 0.5, roadCoverage: 0.1, landCells: 200, riverCells: 0, parkCells: 0, railCells: 0, landStatus: 'PASS', roadStatus: 'SOURCE-MISSING' },
  };
  const anoms = [{ ward: 'b', severity: 'MEDIUM', cause: 'SOURCE_MISSING', explained: true }];
  const w = consolidateWardScores(mcByWard, anoms);
  assert.equal(w.a.overallCompleteness, 100);
  assert.equal(w.a.railCoverage, 0.08);
  assert.equal(w.b.overallCompleteness, 96, 'MEDIUM 1 → -4');
  assert.equal(w.b.explainedCount, 1);
  assert.equal(w.b.statuses.road, 'SOURCE-MISSING');
});
