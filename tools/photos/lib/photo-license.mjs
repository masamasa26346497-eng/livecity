// Issue #52: ライセンス判定（純関数・外部通信なし）。再利用・帰属の要件を満たすと確認できるものだけ ok。
const RULES = [
  { re: /^CC0(?:\s*1\.0)?$/i, kind: 'cc0', attribution: false, shareAlike: false },
  { re: /^(public domain|パブリックドメイン)$/i, kind: 'public-domain', attribution: false, shareAlike: false },
  { re: /^CC BY(?:\s+[1-4]\.\d)?$/i, kind: 'cc-by', attribution: true, shareAlike: false },
  { re: /^CC BY-SA(?:\s+[1-4]\.\d)?$/i, kind: 'cc-by-sa', attribution: true, shareAlike: true }
];
// 非商用・改変禁止・独自条件・不明は採用しない（'Attribution' や 'FAL' のような曖昧な名称は needs-review として保留）
export function classifyLicense(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return { ok: false, kind: 'unknown', reason: 'no-license' };
  if (/(^|[\s-])(NC|ND)([\s-]|$)/i.test(s)) return { ok: false, kind: 'restricted', reason: 'non-commercial-or-no-derivatives' };
  for (const r of RULES) if (r.re.test(s)) return { ok: true, kind: r.kind, attribution: r.attribution, shareAlike: r.shareAlike };
  return { ok: false, kind: 'needs-review', reason: 'unrecognized-license-name' };
}
