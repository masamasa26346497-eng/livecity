// Mission 213 CI 補助: ラベル→start-point 変換と集計 Markdown 生成(副作用は stdout のみ。ネットワーク・ブラウザ不使用)。
//   node qa-batch.mjs start          # env QA_LABEL を検証し start=<n> を出力。不正なら exit 1
//   node qa-batch.mjs summary <qa.json>   # env RUN_ID SHA BUILD BUILD_SEC SWEEP SIZE_MB を参照
import fs from 'node:fs';
import { parseBatchLabel, renderBatchSummary } from './sweep-plan.mjs';

const [cmd, file] = process.argv.slice(2);
if (cmd === 'start') {
  const p = parseBatchLabel(process.env.QA_LABEL);
  if (!p) { console.error('不正なラベル: 期待は run-mission213-qa または run-mission213-qa:<index>'); process.exit(1); }
  console.log(`start=${p.startPoint}`);
} else if (cmd === 'summary') {
  let qa = null; try { qa = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const e = process.env;
  process.stdout.write(renderBatchSummary(qa, { runId: e.RUN_ID, sha: e.SHA, build: e.BUILD, buildSec: e.BUILD_SEC, sweep: e.SWEEP, sizeMb: e.SIZE_MB }));
} else { console.error('usage: qa-batch.mjs start | summary <qa.json>'); process.exit(2); }
