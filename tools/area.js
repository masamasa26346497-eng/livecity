// tools/lib/area.js
import { readFile, writeFile, mkdir, rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT, areaConfigPath } from './paths.js';

const ROOT = PROJECT_ROOT;

/**
 * config/areas/{areaId}.json を読み込む。
 * パス生成は areaConfigPath() に集約されている（area引数はファイル名としてのみ使う）。
 */
export async function loadAreaConfig(areaId) {
  const configPath = areaConfigPath(areaId);
  if (!existsSync(configPath)) {
    throw new Error(
      `エリア設定が見つかりません: ${configPath}\n` +
      `config/areas/${areaId}.json を作成してください。`
    );
  }
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}

export function rawDir(areaId) {
  return path.join(ROOT, 'data', 'raw', areaId);
}

export function processedDir(areaId) {
  return path.join(ROOT, 'data', 'processed', areaId);
}

export function publicMapDataDir(areaId) {
  return path.join(ROOT, 'public', 'map-data', areaId);
}

export function manifestPath(areaId) {
  return path.join(ROOT, 'data', 'manifests', `${areaId}.json`);
}

export async function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

export async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function writeJson(filePath, data) {
  await writeJsonSafely(filePath, JSON.stringify(data, null, 2));
}

export async function writeJsonCompact(filePath, data) {
  await writeJsonSafely(filePath, JSON.stringify(data));
}

/**
 * JSON文字列を「同一ディレクトリ内の一時ファイルへ書き込み → 再読込で妥当性確認 → renameで原子的に置換」
 * する共通の安全書込関数。writeJson/writeJsonCompact/metadata書込すべてがこれを経由する。
 *
 * 安全設計（ご指示2への対応）:
 * - 一時ファイルは出力先と同一ディレクトリに作るため、renameが同一ボリューム内となりWindowsでも原子的。
 * - 一時ファイル名は pid + 時刻 + 乱数 で衝突を回避。
 * - rename前に一時ファイルをJSONとして再読込し、壊れた内容を正式ファイルへ昇格させない。
 * - 失敗時は一時ファイルを削除し、既存の正常な正式ファイルはそのまま維持する（先に削除しない）。
 * - Windowsの rename は「既存ファイルが存在すると EPERM/EEXIST になる」ため、fs.rename ではなく
 *   fs.promises.rename の失敗時フォールバックとして copyFile→unlink は用いず、Node.jsの rename が
 *   POSIX/Windows いずれでも既存を置換する `fs.promises.rename` の仕様（Node 16+では上書き置換）に依拠する。
 *   万一 rename が失敗した場合のみ、既存を退避せず一時ファイルを削除して例外を投げる（正式ファイルは無傷）。
 * - 文字コードはUTF-8。内容・スキーマ・整形形式は呼び出し側の JSON.stringify 結果をそのまま保存する。
 */
export async function writeJsonSafely(filePath, jsonString) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const base = path.basename(filePath);
  const tmpName = `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    // 1-2. 一時ファイルへUTF-8で書き込む
    await writeFile(tmpPath, jsonString, 'utf-8');
    // 3. JSONとして再読込できるか確認（壊れた書込を検出）
    const readBack = await readFile(tmpPath, 'utf-8');
    JSON.parse(readBack); // パース不能なら例外 → catchで一時ファイル削除、正式ファイルは無傷
    // 5. 正常時のみ正式ファイルへrename（同一ディレクトリ＝同一ボリューム、原子的置換）
    await rename(tmpPath, filePath);
  } catch (err) {
    // 6. 失敗時は一時ファイルを掃除。既存の正式ファイルには一切触れない。
    try { if (existsSync(tmpPath)) await unlink(tmpPath); } catch { /* 掃除失敗は無視 */ }
    throw err;
  }
}
