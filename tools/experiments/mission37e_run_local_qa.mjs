// tools/experiments/mission37e_run_local_qa.mjs
// [Mission 37E] 無課金のローカル静的サーバー（public/ を 8137 で配信）を立てて QA スクリプトを実行する。
//   使い方: node tools/experiments/mission37e_run_local_qa.mjs [qa-script.mjs]
//   Google への通信は行わない。python3 が無い場合は node の http で代替する。
import { spawn } from 'node:child_process';

const qaScript = process.argv[2] || 'tools/experiments/mission37e_billing_guard_qa.mjs';
const srv = spawn('python3', ['-m', 'http.server', '8137', '-d', 'public'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2000));
const res = await fetch('http://localhost:8137/mission37d-sumiyoshi-mvp.html').catch((e) => ({ status: String(e) }));
console.log('local server status:', res.status);
const qa = spawn(process.execPath, [qaScript], { stdio: 'inherit' });
qa.on('exit', (code) => { srv.kill(); process.exit(code ?? 1); });
