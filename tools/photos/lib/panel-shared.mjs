// Issue #52: ブラウザ用 public/mission52-photo-panel.js の検証関数（URL/作者/ライセンス/表示可否）を Node から共有する。
// 取り込み側（import-candidates）と画面側で「採用の条件」を二重定義しないための薄いローダ。外部通信なし。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sb = { module: { exports: {} }, URL };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission52-photo-panel.js'), 'utf8'), sb);

export const Panel = sb.module.exports;
const sb2 = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/mission37f-photo-select.js'), 'utf8'), sb2);
export const Select = sb2.module.exports;
export const { commonsFile, commonsImage, licenseUrl, authorText, photoEligibility, plainText } = Panel;
