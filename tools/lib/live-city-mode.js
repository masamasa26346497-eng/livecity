// tools/lib/live-city-mode.js
// [見た目改善 Mission20] Normal Mode / Analysis Mode の canonical 状態機械（純粋ロジック）。
// ══════════════════════════════════════════════════════════════════════════════════
//   NORMAL   … 街を見る・探す・移動するためのシンプルな都市ビュー（白い都市模型）
//   ANALYSIS … 人口・世帯・地価・用途色・施設・行政区などを調べる都市分析ビュー
//
//   - アプリのモード状態は 1 つだけ（散在させない）。
//   - ANALYSIS 内の choropleth / 建物色は同時に 1 テーマのみ（混ざらない）。
//   - NORMAL へ戻ると analysis の色・凡例・overlay を完全に解除する。
//   - base レイヤーの ON/OFF（建物/道路/河川/海/公園/鉄道/駅名）はモード非依存で保持する。
//   - HTML 側（LIVE_CITY_MODE IIFE）はこのロジックを inline ミラーし、Node テストで一致を担保する。
// ══════════════════════════════════════════════════════════════════════════════════

export const APP_MODES = Object.freeze(['normal', 'analysis']);
export const DEFAULT_MODE = 'normal';

export const ANALYSIS_THEMES = Object.freeze([
  'none', 'building_usage', 'facilities', 'admin_boundary',
  'population', 'households', 'pop_change', 'land_price', 'real_estate', 'disaster',
]);
export const DEFAULT_THEME = 'none';

// implemented … 地図上の見た目が実際に変わる（UI で選択可能）
// card-only   … データは建物クリック時の詳細カードにのみ表示（地図 overlay なし。準備中扱い）
// planned     … 未実装（準備中）
export const THEME_STATUS = Object.freeze({
  none: 'implemented',
  building_usage: 'implemented',
  facilities: 'implemented',
  admin_boundary: 'implemented',
  population: 'card-only',
  households: 'card-only',
  pop_change: 'card-only',
  land_price: 'card-only',
  real_estate: 'planned',
  disaster: 'planned',
});

export const THEME_LABELS = Object.freeze({
  none: 'なし（色を付けない）', building_usage: '建物用途', facilities: '施設', admin_boundary: '行政区界',
  population: '人口', households: '世帯', pop_change: '人口増減', land_price: '地価',
  real_estate: '不動産', disaster: '防災',
});

// 現在テーマに対応した凡例（implemented のみ）。NORMAL では凡例を出さない。
export const THEME_LEGENDS = Object.freeze({
  building_usage: [
    { c: '#c8825e', l: '住宅系' }, { c: '#6a5cc4', l: '業務・事務所' }, { c: '#d9745a', l: '商業' },
    { c: '#4a78a8', l: '官公庁' }, { c: '#82b85f', l: '文教・厚生' }, { c: '#707888', l: '工場' }, { c: '#7a8a98', l: 'その他' },
  ],
  facilities: [
    { c: '#e8a33d', l: '買い物' }, { c: '#d65a5a', l: '医療' }, { c: '#5a9fd6', l: '教育' },
    { c: '#9b6fd6', l: '公共' }, { c: '#4a90d9', l: '交通' }, { c: '#5a9b5a', l: '公園' }, { c: '#d68fb0', l: '観光' },
  ],
  admin_boundary: [{ c: '#5a9fd6', l: '区界（面発光）' }, { c: '#8aa0b8', l: '区名ラベル' }],
});

export function isValidMode(m) { return APP_MODES.includes(m); }
export function isValidTheme(t) { return ANALYSIS_THEMES.includes(t); }
/** UI で押せる（＝地図上で効果があり、preview できる）テーマか。 */
export function themeSelectable(t) { return THEME_STATUS[t] === 'implemented'; }
export function themeStatus(t) { return THEME_STATUS[t] || 'planned'; }
export function legendFor(theme) { return THEME_LEGENDS[theme] || null; }

// ── URL foundation（§12：将来の共有 URL 用。router の大規模実装はしない）──
export function serializeState(s) {
  const p = new URLSearchParams();
  if (s && s.mode && s.mode !== DEFAULT_MODE) p.set('mode', s.mode);
  if (s && s.mode === 'analysis' && s.theme && s.theme !== DEFAULT_THEME) p.set('theme', s.theme);
  if (s && s.ward) p.set('ward', s.ward);
  const str = p.toString();
  return str ? '?' + str : '';
}
export function parseState(search) {
  let p;
  try { p = new URLSearchParams(String(search || '').replace(/^\?/, '')); } catch (e) { p = new URLSearchParams(); }
  const modeRaw = p.get('mode');
  const themeRaw = p.get('theme');
  const mode = isValidMode(modeRaw) ? modeRaw : DEFAULT_MODE;
  let theme = (mode === 'analysis' && isValidTheme(themeRaw) && themeSelectable(themeRaw)) ? themeRaw : DEFAULT_THEME;
  return { mode, theme, ward: p.get('ward') || null };
}

/**
 * 純粋な状態機械。副作用（レイヤー操作 / DOM）は呼び出し側（HTML の LIVE_CITY_MODE）が subscribe で行う。
 * @param {{mode?:string, theme?:string}} [init]
 */
export function createModeStore(init) {
  let mode = isValidMode(init && init.mode) ? init.mode : DEFAULT_MODE;
  let theme = (mode === 'analysis' && isValidTheme(init && init.theme)) ? init.theme : DEFAULT_THEME;
  let lastAnalysisTheme = theme !== 'none' ? theme : 'none';
  const subs = new Set();
  let transitionCount = 0;
  let lastTransition = null;

  function notify(reason) {
    const st = getState();
    for (const fn of subs) { try { fn(st, reason); } catch (e) { /* subscriber の失敗は他へ波及させない */ } }
  }
  function getState() {
    return {
      mode, analysisTheme: mode === 'analysis' ? theme : 'none',
      isNormal: mode === 'normal', isAnalysis: mode === 'analysis',
      lastAnalysisTheme, transitionCount, lastTransition,
    };
  }
  function setMode(next) {
    if (!isValidMode(next) || next === mode) return getState();
    const from = mode;
    mode = next;
    if (mode === 'normal') {
      // NORMAL へ：analysis テーマは記憶だけして none へ落とす（色・overlay は subscriber が解除）
      if (theme !== 'none') lastAnalysisTheme = theme;
      theme = 'none';
    } else {
      // ANALYSIS へ：直前の analysis テーマを復帰（初回は none）
      theme = (isValidTheme(lastAnalysisTheme) && themeSelectable(lastAnalysisTheme)) ? lastAnalysisTheme : 'none';
    }
    transitionCount++;
    lastTransition = { from, to: mode, theme, at: Date.now() };
    notify('mode');
    return getState();
  }
  function setTheme(next) {
    if (!isValidTheme(next)) return getState();
    if (!themeSelectable(next) && next !== 'none') return getState(); // 準備中テーマは選べない
    if (mode !== 'analysis') return getState();                        // ANALYSIS 中のみ
    if (next === theme) return getState();
    theme = next;
    if (theme !== 'none') lastAnalysisTheme = theme;
    transitionCount++;
    lastTransition = { from: mode, to: mode, theme, at: Date.now() };
    notify('theme');
    return getState();
  }
  return {
    getMode: () => mode,
    getTheme: () => (mode === 'analysis' ? theme : 'none'),
    isNormal: () => mode === 'normal',
    isAnalysis: () => mode === 'analysis',
    setMode, setTheme,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    getState,
    serialize: () => serializeState({ mode, theme }),
  };
}
