// tools/lib/production-invariants.js
// [Mission 35G] production HTML について「いつでも成り立つべきこと」の正本。
//
//   32U 以降、production は dev（ward-ux-v1）から **ビルドプロファイルの 1 行だけ**
//   変えて生成する。つまり dev に入った機能のコードは production のバイトにも必ず入る。
//
//   そのため「production に <開発中の機能> の文字列が無いこと」を検査すると、
//   **その機能が dev に入った時点ではなく、production へ cutover した時点で一斉に落ちる**。
//   実際 35G の cutover で 13 本のテストが同時に落ちた。落ちた理由は不具合ではなく、
//   検査が「まだ cutover していない」という一時的な状態を仕様として固定していたこと。
//
//   守りたいことは本当は次の 3 つで、これらは cutover しても変わらない:
//     1. production は dev からプロファイル 1 行だけの変換になっている（勝手な差分が無い）
//     2. 開発用 UI は production で **表示されない**（コードが無いこと、ではない）
//     3. QA モードは **既定で off**（コードが無いこと、ではない）
//   protected（fullward-v3）は別で、こちらは本当に 1 バイトも変えない。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectPath } from './paths.js';

const P = (...s) => resolveProjectPath(path.join(...s));
export const DEV_HTML = P('public', 'osaka_3d_buildings.ward-ux-v1.html');
export const PRODUCTION_HTML = P('public', 'osaka_3d_buildings.html');
export const PROTECTED_HTML = P('public', 'osaka_3d_buildings.fullward-v3.html');

export const DEV_PROFILE_LINE = "const LIVECITY_BUILD_PROFILE = 'development';";
export const PRODUCTION_PROFILE_LINE = "const LIVECITY_BUILD_PROFILE = 'production';";

/** production で開発用 UI をまとめて隠している CSS 規則。 */
export const PRODUCTION_HIDE_RULE = 'html[data-livecity-build="production"] [id^="canonical-runtime-"]{display:none !important}';
/** 開発用のトグルを入れる箱。ここに入れておけば上の規則で隠れる。 */
export const DEV_UI_CONTAINER_ID = 'canonical-runtime-road-v2-controls';

export const sha256 = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const read = (p) => fs.readFileSync(p, 'utf-8');

/**
 * 不変条件 1: production は dev からプロファイル 1 行だけ変えたもの。
 *
 * **これは cutover した直後にだけ成り立つ**。次のミッションが dev を進めれば
 * dev が先行して当然なので、常時成り立つ検査として使ってはいけない
 * （35H で dev だけを変えた結果、これを常時条件にしていた 2 本が落ちた）。
 * 「production に勝手な変更が入っていないか」を常時見たいときは
 * `productionMatchesBuildRecord()` を使う。こちらは cutover と cutover のあいだも成り立つ。
 */
export function productionIsDevWithProfileOnly() {
  const dev = read(DEV_HTML), prod = read(PRODUCTION_HTML);
  const devLines = dev.split(DEV_PROFILE_LINE).length - 1;
  if (devLines !== 1) return { ok: false, reason: `dev のプロファイル行が ${devLines} 個` };
  if (dev.includes(PRODUCTION_PROFILE_LINE)) return { ok: false, reason: 'dev に production 行がある' };
  const expected = dev.replace(DEV_PROFILE_LINE, PRODUCTION_PROFILE_LINE);
  if (expected !== prod) return { ok: false, reason: 'production に dev と違う差分がある' };
  return { ok: true };
}

/**
 * 不変条件 2: その開発用 UI が production で隠れる。
 *
 * 隠れ方は 3 通りあり、**どれか 1 つでも満たしていれば隠れる**。
 * 1 つの仕組みしか見ないと、別の仕組みで隠れているものを「隠れていない」と誤判定する
 * （35J で `#canonical-runtime-status` がこれに当たった。箱の外だが接頭辞の規則で隠れている）。
 *
 *   a. id が `canonical-runtime-` で始まる → 接頭辞の CSS 規則で隠れる
 *   b. production 用の CSS に `#<id>` が名指しされている
 *   c. 開発用トグルの箱（`#canonical-runtime-road-v2-controls`）の中で作られている
 *
 * どれにも当たらなければ「隠れない」と判定する。**見つからない id を黙って通さない**
 * （通すと、検査したつもりで何も見ていないことになる）。
 */
export function devUiIsGated(ids, html = read(PRODUCTION_HTML)) {
  if (!html.includes(PRODUCTION_HIDE_RULE)) return { ok: false, reason: 'production の非表示 CSS 規則が無い' };
  const boxAt = html.indexOf(`.id = '${DEV_UI_CONTAINER_ID}'`);
  if (boxAt < 0) return { ok: false, reason: '開発用 UI の箱が無い' };
  const ungated = [];
  for (const id of ids) {
    if (id.startsWith('canonical-runtime-')) continue;                                  // a
    if (html.includes(`html[data-livecity-build="production"] #${id}`)) continue;        // b
    const at = html.indexOf(`.id = '${id}'`);
    if (at > boxAt) continue;                                                            // c
    ungated.push(id);
  }
  return ungated.length ? { ok: false, reason: 'production で隠れない: ' + ungated.join(','), ungated } : { ok: true };
}

/**
 * 不変条件 3: その QA / 開発モードが既定で off。
 * `decl` は宣言のとおりに書く（例 `let qaMode = false;`）。
 */
export function defaultsOff(decls, html = read(PRODUCTION_HTML)) {
  const bad = decls.filter((d) => !html.includes(d));
  return bad.length ? { ok: false, reason: '既定 off の宣言が見つからない: ' + bad.join(' / '), bad } : { ok: true };
}

/** protected は 1 バイトも変えない。 */
export function protectedUnchanged(expectedSha) {
  const now = sha256(PROTECTED_HTML);
  return { ok: !!expectedSha && now === expectedSha, now, expected: expectedSha || null };
}

/** production が最後のビルド成果物と一致するか（勝手に手で編集していないか）。 */
export function productionMatchesBuildRecord(recordedSha) {
  const now = sha256(PRODUCTION_HTML);
  return { ok: !!recordedSha && now === recordedSha, now, expected: recordedSha || null };
}
