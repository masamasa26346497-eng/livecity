// ══════════════════════════════════════════════════════════════
// tools/measure-render-performance.js
// ══════════════════════════════════════════════════════════════
// 描画性能（FPS・メモリ・オブジェクト数）を定量計測するワンショット計測スクリプト。
// HTMLへの追記は不要。DevTools Consoleへ全文貼り付けて実行する読み取り専用ツール。
//
// 使い方:
//   1. ローカルHTTPサーバーで正規版を開き、視点を計測条件に合わせる
//      （比較の公平性のため、住吉区単体と2区構成で同じ視点・同じウィンドウサイズを使うこと）
//   2. Consoleへ本ファイルを貼り付け → 10秒間の計測後にJSONレポートが出力される
//   3. 出力JSONを保存し、住吉区単体 / 2区構成 の2回分を比較する
//
// 計測項目: FPS(平均/最小/p95)・renderer.info(drawCalls/triangles/geometries/programs)・
//          scene子要素数・BuildingTileLayerのタイル/建物/Mesh統計・データセット別統計・
//          JSヒープ(performance.memory: Chrome系のみ)。
(() => {
  const DURATION_MS = 10000;
  const report = { measuredAt: new Date().toISOString(), url: location.href,
    build: (typeof LIVE_CITY_BUILD_ID !== 'undefined') ? LIVE_CITY_BUILD_ID : 'unknown',
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } };

  // 視点（比較時に同一条件かを検証するため記録）
  if (typeof cs !== 'undefined') report.camera = { r: +cs.r?.toFixed?.(1), tgt: cs.tgt ? { x: +cs.tgt.x.toFixed(1), z: +cs.tgt.z.toFixed(1) } : null };

  const snapshot = () => {
    const s = {};
    if (typeof renderer !== 'undefined' && renderer.info) {
      s.drawCalls = renderer.info.render.calls;
      s.triangles = renderer.info.render.triangles;
      s.geometries = renderer.info.memory.geometries;
      s.textures = renderer.info.memory.textures;
      s.programs = renderer.info.programs ? renderer.info.programs.length : null;
    }
    if (typeof scene !== 'undefined') s.sceneChildren = scene.children.length;
    if (typeof BuildingTileLayer !== 'undefined') {
      const b = BuildingTileLayer.getStats();
      s.tiles = { total: b.tileCount, loaded: b.loadedTiles, visible: b.visibleTiles, states: b.states };
      s.buildings = b.totalBuildings;
      s.buildingMeshes = b.totalMeshes;
      s.datasets = b.datasets.map(d => {
        const ds = BuildingTileLayer.getDatasetStats(d.id);
        return { id: d.id, ward: d.ward, enabled: d.enabled, source: d.source,
          tiles: ds.tiles, buildings: ds.buildings, states: ds.states, io: ds.io };
      });
    }
    if (performance.memory) {
      s.jsHeapUsedMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
      s.jsHeapTotalMB = +(performance.memory.totalJSHeapSize / 1048576).toFixed(1);
    } else s.jsHeapUsedMB = 'performance.memory未対応（Chrome系で計測してください）';
    return s;
  };

  report.before = snapshot();
  console.log('[計測] ' + (DURATION_MS / 1000) + '秒間のFPS計測を開始します。視点は動かさないでください…');

  const frames = [];
  let last = performance.now();
  const start = last;
  let raf;
  const tick = (now) => {
    frames.push(now - last);
    last = now;
    if (now - start < DURATION_MS) raf = requestAnimationFrame(tick);
    else finish();
  };
  const finish = () => {
    cancelAnimationFrame(raf);
    const fps = frames.filter(d => d > 0).map(d => 1000 / d).sort((a, b) => a - b);
    const avg = fps.reduce((s, v) => s + v, 0) / fps.length;
    report.fps = {
      frames: fps.length,
      avg: +avg.toFixed(1),
      min: +fps[0].toFixed(1),
      p5: +fps[Math.floor(fps.length * 0.05)].toFixed(1),   // 下位5%（体感の引っかかり指標）
      median: +fps[Math.floor(fps.length * 0.5)].toFixed(1),
      max: +fps[fps.length - 1].toFixed(1)
    };
    report.after = snapshot();
    if (typeof report.before.jsHeapUsedMB === 'number') {
      report.heapDeltaMB = +(report.after.jsHeapUsedMB - report.before.jsHeapUsedMB).toFixed(1);
    }
    console.log('[計測レポート] ' + JSON.stringify(report, null, 1));
    console.log('※ 比較手順: 住吉区単体で1回 → 東住吉区を追加して同じ視点で1回 → 両JSONを添付して報告');
  };
  raf = requestAnimationFrame(tick);
  return '計測中…（' + (DURATION_MS / 1000) + '秒後にレポートが出力されます）';
})();
