// tools/lib/paths.js
// 全てのファイルパス解決をこの1ファイルに集約する。
//
// 【修正の背景】
// 以前は各ファイルが個別に
//   path.resolve(new URL('../..', import.meta.url).pathname)
// という形でプロジェクトルートを計算していた。
// new URL(...).pathname は Windows では先頭にスラッシュが付いた
// "/C:/Users/..." という形式の文字列を返す。Node.jsの path モジュールは
// Windows上でこれを「現在のドライブからの相対パス」と解釈するため、
// path.resolve() の際に process.cwd() のドライブ文字(C:\)が先頭に
// 重複して付加され、C:\C:\Users\... という二重ドライブ文字列が生成されていた。
// （これは Node.js 本体でも issue #37845 として報告されている既知のクラスの不具合）
//
// 解決策: file:// URL からOSネイティブなパス文字列へ変換するには、
// .pathname を直接使うのではなく、node:url の fileURLToPath() を使う。
// これは全プラットフォーム（Windows/macOS/Linux）で正しく動作することが
// Node.js公式に保証されている変換方法である。
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// プロジェクトルート（tools/lib/paths.js から2階層上）を、全プラットフォームで
// 正しく解決する。日本語やOneDriveパス中の特殊文字も fileURLToPath が正しく処理する。
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * 入力パスを「プロジェクトルートを基準にした絶対パス」へ解決する、唯一の関数。
 * - 絶対パスが渡された場合: path.normalize() で正規化するだけで、projectRootは付加しない。
 * - 相対パスが渡された場合: path.resolve(projectRoot, input) で絶対パス化する。
 * 判定は path.isAbsolute() を使う（文字列の先頭文字を手動チェックしない）。
 *
 * @param {string} inputPath 絶対パスまたは相対パス
 * @param {string} [base=PROJECT_ROOT] 相対パスの場合の基準ディレクトリ
 */
export function resolveProjectPath(inputPath, base = PROJECT_ROOT) {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  return path.resolve(base, inputPath);
}

/**
 * area ID（ファイル名としてのみ使う識別子）から、config/areas/{areaId}.json の
 * 絶対パスを生成する唯一の関数。area引数自体がたまたま絶対パスやパス区切りを含んでいても、
 * ここでは「ファイル名の構成要素」としてのみ扱い、手動の文字列連結は一切行わない。
 */
export function areaConfigPath(areaId) {
  const relativePath = path.join('config', 'areas', `${areaId}.json`);
  return resolveProjectPath(relativePath);
}

export function datasetConfigPath(datasetId) {
  const relativePath = path.join('config', 'datasets', `${datasetId}.json`);
  return resolveProjectPath(relativePath);
}

/**
 * CLIから直接実行されたかどうかを判定する。
 * 【修正の背景】
 * 以前は `import.meta.url === \`file://${process.argv[1]}\`` という文字列連結で
 * 判定していたが、process.argv[1] はOSネイティブな形式（Windowsではバックスラッシュ区切り、
 * ドライブ文字付き）であるため、"file://" を単純に前置しても正しいfile URLにならず、
 * import.meta.url と一致しない（Windowsでは常にfalseになり、CLI実行が検出できなくなる）。
 * pathToFileURL() で process.argv[1] を正しいfile URL形式に変換してから比較する。
 */
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return moduleUrl === pathToFileURL(process.argv[1]).href;
}

/**
 * 絶対パスを「プロジェクトルートからの相対パス（常に/区切り）」へ変換する。
 * 【用途】マニフェストやレポート等、後から別の環境(ローカルWindows PC、CI等)で読まれる
 * 可能性があるJSONへパスを永続保存する場合、実際のファイル操作自体は絶対パスを使って構わないが、
 * 保存する文字列はこの関数を必ず通し、環境固有の絶対パス(例: /home/claude/livecity-data-pipeline/...
 * や C:\Users\...)がそのまま書き込まれることを防ぐ。
 * Windows由来のバックスラッシュも含め、常に "/" 区切りの文字列に正規化する。
 */
export function toProjectRelativePath(absolutePath) {
  const rel = path.relative(PROJECT_ROOT, absolutePath);
  return rel.split(path.sep).join('/');
}
