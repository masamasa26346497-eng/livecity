// Mission 51: 同一区間の多重描画を除く（ブラウザ / Node 共用の純粋ロジック）。
// GSI RdEdg は (a) タイル境界のクリップ余白で隣接タイルに同じ線分が重複して入り、(b) 北区サンプル窓と大川窓の範囲が重なる。
// 座標は変更しない。既に出した線分（向きは無視）と完全に一致する線分だけを落とし、残りを連続区間ごとの折れ線に戻す。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveCitySegDedupe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const segKey = (a, b) => {
    const k1 = a[0] + ',' + a[1], k2 = b[0] + ',' + b[1];
    return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
  };
  // seen: Set（呼び出し間で共有すると、データセット間の重複も除ける）。戻り値: { lines, inSegs, keptSegs, droppedSegs }
  function dedupeLines(lines, seen) {
    const out = []; let inSegs = 0, kept = 0;
    for (const ln of lines) {
      let run = null;
      for (let i = 0; i + 1 < ln.length; i++) {
        inSegs++;
        const k = segKey(ln[i], ln[i + 1]);
        if (seen.has(k)) { if (run && run.length > 1) out.push(run); run = null; continue; }
        seen.add(k); kept++;
        if (!run) run = [ln[i]];
        run.push(ln[i + 1]);
      }
      if (run && run.length > 1) out.push(run);
    }
    return { lines: out, inSegs, keptSegs: kept, droppedSegs: inSegs - kept };
  }
  return { dedupeLines, segKey };
});
