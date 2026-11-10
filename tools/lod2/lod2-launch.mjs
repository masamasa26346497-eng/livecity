#!/usr/bin/env node
// Mission 162: LOD2 プレビューの一発起動 launcher(Windows/macOS/Linux)。
//   node tools/lod2/lod2-launch.mjs [--port 8152] [--no-open] [--skip-build] [--check-only] [--ext-root DIR] [--gml-dir DIR]
// どのフォルダから呼んでも、この .mjs の位置から正しい ROOT を解決する。
// 順序: 前提チェック → 41棟生成(公式 Range 取得) → loopback サーバ起動 → HTTP200 readiness → ブラウザ起動。
// サーバ起動後はこのコンソールがブロックする(正常。止めるときは Ctrl+C)。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2);
const has = (k) => a.includes(k), g = (k, d = null) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : d);
const port = Number(g('--port', 8152));
const ALL = has('--all'); // Mission 163: 大阪2025の全LOD2(33メッシュ)を分割タイルで表示
const OUT = path.join(ROOT, 'temp', ALL ? 'lod2-all' : 'lod2-preview');
const WANT_BRANCH = 'mission152-lod2-parallel';
const results = [];
const check = (name, ok, detail = '', fatal = true) => { results.push({ name, ok, detail, fatal }); console.log((ok ? '  [OK]  ' : fatal ? '  [NG]  ' : '  [注意] ') + name + (detail ? ' — ' + detail : '')); return ok; };
const die = (msg) => { console.error('\n[LOD2] 起動できません: ' + msg + '\n  → tools/lod2/README-LAUNCH.md の「うまくいかないとき」を参照してください。'); process.exit(1); };

const portFree = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
const get = (p, pathname) => new Promise((res) => { const r = http.get({ host: '127.0.0.1', port: p, path: pathname, timeout: 4000, headers: { 'x-lc-probe': '1' } }, (x) => { let n = 0; x.on('data', (d) => (n += d.length)); x.on('end', () => res({ status: x.statusCode, bytes: n })); }); r.on('error', () => res({ status: 0, bytes: 0 })); r.on('timeout', () => { r.destroy(); res({ status: 0, bytes: 0 }); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[LOD2] ROOT = ' + ROOT);
console.log('[1/5] 前提チェック');
const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node.js 18 以上', nodeMajor >= 18, 'v' + process.versions.node);
const must = ['tools/lod2/lod2-preview-build.mjs', 'tools/lod2/lod2-preview-serve.cjs', 'tools/lod2/lod2-overlay.js', 'tools/lod2/lod2-to-glb.js', 'tools/lib/citygml.js', 'public/mission37g-osaka-24ward-mvp.html', 'tools/mission79-plateau2025-source.mjs'];
const missing = must.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('LOD2 に必要なファイル', missing.length === 0, missing.length ? '無い: ' + missing.join(', ') + '(PR24 など別ブランチのフォルダで実行していませんか? README-LAUNCH.md の手順で ' + WANT_BRANCH + ' を取得してください)' : 'すべて存在');
if (missing.length) die('必要なファイルがありません。');
const html = fs.readFileSync(path.join(ROOT, 'public/mission37g-osaka-24ward-mvp.html'), 'utf8');
check('37G HTML に LOD2 フック(LC152.attach)', html.includes('/lod2-preview/overlay.js') && html.includes('LC152.attach'), 'sceneの直後に挿入済み');
const git = spawnSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
if (git.status === 0) {
  const br = git.stdout.trim();
  check('Git ブランチ', br === WANT_BRANCH, br === WANT_BRANCH ? br : `現在 "${br}"。LOD2 は ${WANT_BRANCH} のコードです(フックがあれば動きますが、想定外のブランチです)`, false);
  const st = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  check('未コミットの変更', true, st.stdout.trim() ? '変更あり(この launcher は一切変更・破棄しません)' : 'なし', false);
} else check('Git', true, 'git を実行できません(ZIP 展開の場合は問題なし)', false);
let lock = null;
try { const m = await import('../mission79-plateau2025-source.mjs'); lock = JSON.parse(fs.readFileSync(m.LOCK_PATH, 'utf8')); } catch (e) { /* below */ }
check('Source lock(公式 PLATEAU 大阪2025)', !!lock && Array.isArray(lock.entries), lock ? lock.entries.length + ' entries' : '読めません');
if (!lock) die('source-lock を読み込めません。');
check('ポート ' + port, await portFree(port), (await portFree(port)) ? '空き' : '使用中(別プロセスが占有)');
if (!(await portFree(port))) die(`ポート ${port} が使用中です。別ポートで: --port ${port + 1}`);
if (has('--check-only') && !has('--build-check')) { console.log('\n[LOD2] --check-only: 前提は OK(生成・起動はしていません)'); process.exit(0); }

console.log('[2/5] 実 LOD2 41棟の生成' + (has('--skip-build') ? '(--skip-build)' : '(公式 PLATEAU から Range 取得・約0.6MB。数十秒かかります)'));
if (!has('--skip-build')) {
  const args = [path.join(ROOT, 'tools/lod2/lod2-preview-build.mjs'), '--out', OUT];
  if (g('--gml-dir')) args.push('--gml-dir', g('--gml-dir'));
  if (ALL) { args[0] = path.join(ROOT, 'tools/lod2/lod2-build-all.mjs'); args.push('--resume'); }
  const b = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (b.status !== 0) {
    const tail = ((b.stderr || '') + (b.stdout || '')).trim().split('\n').slice(-4).join(' | ');
    die('LOD2 生成に失敗しました(公式サイトへ接続できない/プロキシ等の可能性)。' + tail);
  }
  console.log('  ' + b.stdout.trim().split('\n').pop());
}
for (const f of ALL ? ['tileset.json', 'footprints.json', 'report.json', 'manifest.json'] : ['tileset.json', 'lod2.glb', 'footprints.json', 'report.json']) if (!fs.existsSync(path.join(OUT, f))) die('生成物がありません: temp/lod2-preview/' + f);
const rep = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));
check('生成物', rep.converted > 0, `LOD2 ${rep.converted} 棟 / 失敗 ${rep.failed.length} / LOD1 のまま ${rep.lod1Remaining}`);
if (!rep.converted) die('LOD2 が 0 棟です。');
if (ALL && !rep.fullMatch) console.log('  [注意] 全件一致ではありません: 変換 ' + rep.converted + ' / 期待 ' + rep.expected + '(未変換 ' + rep.unconverted + ')。未変換分は LOD1 のまま表示されます。');

console.log('[3/5] ローカルサーバ起動(127.0.0.1 のみ)');
const sargs = [path.join(ROOT, 'tools/lod2/lod2-preview-serve.cjs'), '--port', String(port)];
if (ALL) sargs.push('--lod2-dir', OUT);
if (g('--ext-root')) sargs.push('--ext-root', g('--ext-root'));
if (has('--no-auto-ext')) sargs.push('--no-auto-ext');
if (g('--layers-root')) sargs.push('--layers-root', g('--layers-root'));
if (has('--no-auto-layers')) sargs.push('--no-auto-layers');
const srv = spawn(process.execPath, sargs, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
let srvExit = null; srv.on('exit', (c) => { srvExit = c; });
process.on('SIGINT', () => { srv.kill(); process.exit(0); });
process.on('exit', () => { try { srv.kill(); } catch (e) { /* ignore */ } });

console.log('[4/5] HTTP 200 readiness');
// Mission 169: --all は大阪24区の俯瞰から開始(LOD2 は右上のナビから移動)。41棟モードは従来どおりLOD2へ直行。
const URL_PATH = '/mission37g-osaka-24ward-mvp.html?nobuiltin=1&ext45=1&lod2=1&' + (ALL ? 'lod2ov=1' : 'lod2fly=1');
const probes = ['/mission37g-osaka-24ward-mvp.html', '/lod2-preview/overlay.js', '/lod2-preview/tileset.json', ...(ALL ? [] : ['/lod2-preview/lod2.glb']), '/lod2-preview/footprints.json', '/__lod2/diag.json'];
let ready = false, last = [];
for (let i = 0; i < 40 && srvExit === null; i++) {
  last = await Promise.all(probes.map(async (p) => ({ p, ...(await get(port, p)) })));
  if (last.every((x) => x.status === 200 && x.bytes > 0)) { ready = true; break; }
  await sleep(250);
}
for (const x of last) console.log('  ' + (x.status === 200 ? '[OK]' : '[NG]') + ' HTTP ' + x.status + ' ' + x.p + ' (' + x.bytes + ' bytes)');
if (!ready) { srv.kill(); die(srvExit !== null ? 'サーバが起動直後に終了しました(上のエラーを確認)。' : 'HTTP 200 を確認できませんでした(上の NG を確認)。'); }

const url = `http://localhost:${port}${URL_PATH}`;
console.log('[5/5] 準備完了');
console.log('\n  ★ 開く URL: ' + url);
console.log('  ★ このウィンドウは「サーバ実行中」のため終了しません(正常)。閉じる/Ctrl+C でサーバも止まり、ページは開けなくなります。');
console.log('  ★ 診断: http://localhost:' + port + '/__lod2/diag.json  / ブラウザ F12 コンソールで window.__lc152.state');
// Mission 170: 24区 LOD1 は --ext-root 未指定でも既定位置(%LOCALAPPDATA%\LiveCity-3DTiles-Out-24 等)を読み取り専用で自動検出する。
try {
  const dg = await (await fetch(`http://127.0.0.1:${port}/__lod2/diag.json`)).json();
  const ea = dg.extAttach || {};
  if (ea.chosen) {
    console.log(`  ★ 24区 LOD1: ${ea.chosen.wards} 区を接続(${ea.chosen.kind}${ea.chosen.verified ? '' : '・未検証'}${ea.auto ? '・自動検出' : ''})。` + (ea.chosen.buildingsKnown ? `合計 ${ea.chosen.buildings} 棟` : '棟数は不明'));
    for (const b of ea.chosen.brokenWards || []) console.log('  ✕ ' + b.ward + ': 出力はあるが 37G が読めません → ' + ((b.reasons[0] || {}).reason || ''));
    if (ea.chosen.kind === '45d-root') console.log('    ※ 既存の旧PC変換データの可能性があります。PR51 の公式2025 LOD1(615,234棟)と同一とは限りません。欠落区: ' + ((ea.chosen.missingWards || []).join(',') || 'なし'));
  } else {
    console.log('  ※ 24区の LOD1 は未接続です(LOD2 と内蔵サンプルのみ)。右上パネルの「✕」が未接続データです。');
    for (const x of ea.inspected || []) console.log('    検査した場所 ' + x.name + ': ' + x.reasons.join(' / '));
    if (!(ea.inspected || []).length) console.log('    既定の場所に LOD1 出力が見つかりません。PowerShell: Test-Path "$env:LOCALAPPDATA\\LiveCity-3DTiles-Out-24" / 別の場所なら --ext-root <フォルダ> を指定してください。');
  }
  const ly = dg.layers || {};
  console.log(ly.attached ? `  ★ 道路・河川・公園: ${ly.wards.length} 区のレイヤーを接続` : '  ※ 道路・河川・公園の24区レイヤーは未接続(区境界のみ)。' + ((ly.inspected || []).map((x) => x.name + ': ' + x.reasons.join('/')).join(' ; ') || '既定の場所に LiveCity-MapLayers-Out-24 が無い。別の場所なら --layers-root <フォルダ> を指定'));
  console.log('  ★ 建物は「全域3D」を自動で有効化します。区ごとの状態は右上パネル「区ごとの LOD1 状態」(NG / 描画中 / 待機)で確認できます。');
} catch (e) { /* 診断のみ */ }
if (!has('--no-open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }); p.on('error', () => console.log('  (ブラウザを自動で開けませんでした。上の URL を手動で開いてください)')); p.unref(); } catch (e) { console.log('  (自動起動不可。URL を手動で開いてください)'); }
}
await new Promise(() => {});
