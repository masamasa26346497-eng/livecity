// tools/lib/performance-budget.js
// [Mission25] パフォーマンス予算の純粋ロジック（THREE / DOM 非依存）。
//   - PERF baseline スキーマの検証
//   - Mission24 baseline と Mission25 after の比較（§25 の許容ルール）
//   - 静的 mesh 最適化 / duplicate render / 毎frame処理 の HTML 静的監査ヘルパ

export const PERF_METRICS = ['drawCalls', 'triangles', 'geometries', 'textures', 'programs', 'fps', 'frameMs'];

// 「小さいほど良い」= コスト系 / 「大きいほど良い」= FPS
export const LOWER_IS_BETTER = new Set(['drawCalls', 'triangles', 'geometries', 'textures', 'programs', 'frameMs']);

export const DEFAULT_BUDGET = {
  // after / before の許容上限（コスト系）。1.0 = 悪化させない。
  regressTolerance: 1.05,   // 計測ノイズを考慮し 5% までは "悪化なし" とみなす
  improveThreshold: 0.90,   // 10% 以上の削減で "改善" と表示（§25 の目標候補）
  fpsRegressTolerance: 0.95, // FPS は before の 95% を下回らない
  fpsImproveThreshold: 1.10,
};

/**
 * PERF baseline オブジェクトが最低限のキーを持ち、数値（または null）であることを検証する。
 * @returns {{ok:boolean, missing:string[], badType:string[]}}
 */
export function validatePerfBaselineSchema(obj) {
  const missing = [], badType = [];
  if (!obj || typeof obj !== 'object') return { ok: false, missing: ['(root)'], badType: [] };
  const required = ['mode', 'drawCalls', 'triangles', 'geometries', 'textures', 'fps', 'frameMs'];
  for (const k of required) {
    if (!(k in obj)) { missing.push(k); continue; }
    if (k === 'mode') { if (obj[k] !== 'city' && obj[k] !== 'ward') badType.push(k); continue; }
    if (obj[k] !== null && typeof obj[k] !== 'number') badType.push(k);
  }
  return { ok: missing.length === 0 && badType.length === 0, missing, badType };
}

/**
 * before(Mission24) と after(Mission25) の baseline を1メトリクスずつ比較する。
 * @param {object} before
 * @param {object} after
 * @param {object} [budget]
 * @returns {{overall:'PASS'|'FAIL', regressions:string[], improvements:string[], rows:object[]}}
 */
export function comparePerfBaselines(before, after, budget = DEFAULT_BUDGET) {
  const rows = [];
  const regressions = [];
  const improvements = [];
  for (const m of PERF_METRICS) {
    const b = before ? before[m] : null;
    const a = after ? after[m] : null;
    if (typeof b !== 'number' || typeof a !== 'number' || b <= 0) {
      rows.push({ metric: m, before: b, after: a, ratio: null, verdict: 'SKIP' });
      continue;
    }
    const ratio = a / b;
    let verdict = 'OK';
    if (m === 'fps') {
      if (ratio < budget.fpsRegressTolerance) { verdict = 'REGRESS'; regressions.push(`${m}: ${b} → ${a} (${(ratio * 100).toFixed(0)}%)`); }
      else if (ratio >= budget.fpsImproveThreshold) { verdict = 'IMPROVE'; improvements.push(`${m}: ${b} → ${a} (+${((ratio - 1) * 100).toFixed(0)}%)`); }
    } else if (LOWER_IS_BETTER.has(m)) {
      if (ratio > budget.regressTolerance) { verdict = 'REGRESS'; regressions.push(`${m}: ${b} → ${a} (+${((ratio - 1) * 100).toFixed(0)}%)`); }
      else if (ratio <= budget.improveThreshold) { verdict = 'IMPROVE'; improvements.push(`${m}: ${b} → ${a} (-${((1 - ratio) * 100).toFixed(0)}%)`); }
    }
    rows.push({ metric: m, before: b, after: a, ratio: +ratio.toFixed(3), verdict });
  }
  return { overall: regressions.length ? 'FAIL' : 'PASS', regressions, improvements, rows };
}

/**
 * ward-ux-v1 HTML の render loop 本体（`(function loop(){...})();`）を抜き出す。
 * 見つからなければ null。
 */
export function extractRenderLoopBody(html) {
  // [Mission 31G-ALIGNMENT-RESET] Reference Alignment Mode 用に render 呼び出しが
  //   renderer.render(scene, activeCamera()) へ変わった（Perspective/Orthographic の排他選択。
  //   §17）。activeCamera() 自体は try/catch 1個 + 関数呼び出しのみの軽量関数で hot path 上も
  //   問題ないため、旧来の `camera` 直渡しと新しい `activeCamera()` の両方を終端アンカーとして許容する。
  const m = html.match(/\(function loop\(\)\{([\s\S]*?)renderer\.render\(scene,\s*(?:camera|activeCamera\(\))\);\}\)\(\);/);
  return m ? m[1] : null;
}

/**
 * render loop 内で「毎フレーム実行すべきでない重い処理」の兆候を静的に検出する。
 *   - console.log / console.warn / console.error
 *   - JSON.parse
 *   - new THREE.BufferGeometry / new THREE.Mesh（毎frame geometry 生成）
 *   - document.querySelector（DOM 走査。getElementById は id 直参照なので許容）
 * throttle されているサブ関数呼び出し（updateByCamera 等）は対象外。
 * @returns {{ok:boolean, hits:string[]}}
 */
export function auditRenderLoopHotPath(html) {
  let body = extractRenderLoopBody(html);
  if (body == null) return { ok: false, hits: ['render loop body を抽出できない'] };
  // 例外隔離のための catch ブロック内 console は hot path ではない（毎フレームは実行されない）。
  //   `catch (x) { ... }` の中身を除去してからスキャンする（1段ネストのみ想定）。
  body = body.replace(/catch\s*\([^)]*\)\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, 'catch(){}');
  // 1秒に1回だけ走る FPS-HUD ブロック（if(now-lt>=1000){...}）も除外。
  body = body.replace(/if\s*\(\s*now\s*-\s*lt\s*>=\s*1000\s*\)\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
  const hits = [];
  const patterns = [
    [/console\.(log|warn|error|info|debug)\s*\(/, 'console 出力'],
    [/JSON\.parse\s*\(/, 'JSON.parse'],
    [/new\s+THREE\.(BufferGeometry|Mesh|Geometry)\b/, 'geometry/mesh 生成'],
    [/document\.querySelector(All)?\s*\(/, 'DOM 走査 (querySelector)'],
  ];
  for (const [re, label] of patterns) if (re.test(body)) hits.push(label);
  return { ok: hits.length === 0, hits };
}

/**
 * 静的 mesh 最適化（markStaticMesh）の適用状況を静的に確認する。
 * @returns {{defined:boolean, callCount:number, layers:string[]}}
 */
export function auditStaticMeshUsage(html) {
  const defined = /function markStaticMesh\s*\(/.test(html);
  const callCount = (html.match(/markStaticMesh\s*\(/g) || []).length - (defined ? 1 : 0);
  const layers = [];
  for (const [re, label] of [
    [/markStaticMesh\(majorMesh\)/, 'RiverLayerV2'],
    [/markStaticMesh\(mesh\); \/\/ \[Mission25\] 原点アンカーの統合mesh/, 'CityBuildingLOD'],
    [/markStaticMesh\(mesh\);\s*\n\s*if \(mesh\.userData && \(mesh\.userData\.water/, 'CityTileLayer'],
    [/markStaticMesh\(mesh\); \/\/ \[Mission25\] 原点アンカーの統合地表mesh/, 'LandSurfaceLayer'],
    [/markStaticMesh\(mesh\); \/\/ \[Mission25\] 原点アンカーの統合公園mesh/, 'ParkLayer'],
    [/markStaticMesh\(mesh\); \/\/ \[Mission25\] 原点アンカーの統合海面mesh/, 'WaterSurfaceLayer'],
    [/markStaticMesh\(wM\);/, 'BuildingTileLayer'],
  ]) if (re.test(html)) layers.push(label);
  return { defined, callCount, layers };
}
