// tools/lib/dataset.js
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT, datasetConfigPath } from './paths.js';

const ROOT = PROJECT_ROOT;

export function datasetsDir() {
  return path.join(ROOT, 'config', 'datasets');
}

/**
 * config/datasets/{datasetId}.json を読み込む。
 * パス生成は datasetConfigPath() に集約されている。
 */
export async function loadDataset(datasetId) {
  const p = datasetConfigPath(datasetId);
  if (!existsSync(p)) {
    throw new Error(`データセット設定が見つかりません: ${p}`);
  }
  return JSON.parse(await readFile(p, 'utf-8'));
}

/**
 * config/datasets/ 配下の全データセット定義を読み込む（npm run data:catalog 用）。
 */
export async function loadAllDatasets() {
  const dir = datasetsDir();
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const datasets = [];
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf-8');
    datasets.push(JSON.parse(raw));
  }
  return datasets;
}
