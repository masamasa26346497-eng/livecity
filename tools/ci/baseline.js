// tools/ci/baseline.js — 既知の失敗（baseline）との比較（Mission 38）
// 方針: 失敗を隠さない。baseline 内の失敗は「既知の赤」として件数・名前を必ず出力し、
// 新規の失敗、またはテスト実行自体の異常終了（失敗が解析できない非0終了）は常に失敗扱い。
// baseline は「PRで観測した赤」であり main との同条件比較が済むまで main 起因とは断定しない。
export function compareToBaseline(current, baselineNames) {
  const base = new Set(baselineNames);
  const cur = new Set(current.map((f) => f.name));
  return {
    newFailures: [...cur].filter((n) => !base.has(n)).sort(),
    knownFailures: [...cur].filter((n) => base.has(n)).sort(),
    nowPassing: [...base].filter((n) => !cur.has(n)).sort(),
  };
}

/** exitStatus: node --test の終了コード。parsed: 解析できた失敗配列。 */
export function verdict(exitStatus, parsed, baselineNames) {
  const cmp = compareToBaseline(parsed, baselineNames);
  const crashed = exitStatus !== 0 && parsed.length === 0;
  const ok = !crashed && cmp.newFailures.length === 0;
  return { ...cmp, crashed, ok };
}
