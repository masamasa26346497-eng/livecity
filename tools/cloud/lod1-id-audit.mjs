// Mission 198: LOD1(元)/補完 LOD1/LOD2 の gml:id を厳格に突き合わせる fail-closed 監査。
// ids/ には葉タイル t_*.json(string[])と LOD グループ g_*.json(子 ID の再掲)がある。葉のみを数える(g_ を混ぜると二重計上)。
// 期待フォーマットと違う・0 件・重複・件数不一致は全て例外(= ビルド失敗)。空振りで通ることはない。
import fs from 'node:fs';
import path from 'node:path';

export function readLeafIds(dir, label) {
  const idDir = path.join(dir, 'ids');
  if (!fs.existsSync(idDir)) throw new Error(`${label}: ids/ が無い`);
  const files = fs.readdirSync(idDir).filter((f) => /^t_.*\.json$/.test(f));
  if (!files.length) throw new Error(`${label}: 葉タイルの ids/t_*.json が 0 ファイル`);
  const set = new Set(); let dup = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(idDir, f), 'utf8'));
    if (!Array.isArray(j)) throw new Error(`${label}: ids/${f} が配列ではない(想定外のフォーマット)`);
    for (const id of j) {
      if (typeof id !== 'string' || !id) throw new Error(`${label}: ids/${f} に不正な ID`);
      if (set.has(id)) dup++; set.add(id);
    }
  }
  if (dup) throw new Error(`${label}: 葉タイル間で ID 重複 ${dup} 件`);
  if (!set.size) throw new Error(`${label}: ID が 0 件`);
  return { ids: set, files: files.length };
}

// origDir=元 LOD1, suppDir=補完 LOD1, lod2Ids=LOD2 manifest の gml:id 集合
export function auditWard({ id, origDir, suppDir, lod2Ids, origBuildings, suppBuildings, excludedCount }) {
  const orig = readLeafIds(origDir, id + ' 元LOD1');
  const supp = readLeafIds(suppDir, id + ' 補完LOD1');
  const exFile = path.join(suppDir, 'lod1-excluded-ids.json');
  if (!fs.existsSync(exFile)) throw new Error(`${id}: lod1-excluded-ids.json が無い`);
  const exJ = JSON.parse(fs.readFileSync(exFile, 'utf8'));
  if (!Array.isArray(exJ.ids)) throw new Error(`${id}: lod1-excluded-ids.json に ids 配列が無い`);
  const excluded = new Set(exJ.ids);
  if (excluded.size !== exJ.ids.length) throw new Error(`${id}: 除外 ID に重複`);
  const fail = (m) => { throw new Error(`${id}: ID 監査失敗 — ${m}`); };
  // 件数 = データ定義(1 棟 = 1 gml:id)と一致
  if (orig.ids.size !== origBuildings) fail(`元LOD1 ID ${orig.ids.size} ≠ 棟数 ${origBuildings}`);
  if (supp.ids.size !== suppBuildings) fail(`補完LOD1 ID ${supp.ids.size} ≠ 棟数 ${suppBuildings}`);
  if (excluded.size !== excludedCount) fail(`除外 ID ${excluded.size} ≠ source.json の excludedForLod2 ${excludedCount}`);
  if (orig.ids.size !== supp.ids.size + excluded.size) fail('元 ≠ 補完 + 除外');
  // 集合の完全照合
  const lod2InOrig = new Set([...lod2Ids].filter((x) => orig.ids.has(x)));       // LOD2 と元 LOD1 の交差
  for (const x of excluded) if (!orig.ids.has(x) || !lod2Ids.has(x)) fail(`除外 ID が元LOD1∩LOD2 に無い: ${x}`);
  if (lod2InOrig.size !== excluded.size) fail(`LOD2∩元LOD1 ${lod2InOrig.size} ≠ 除外 ${excluded.size}(除外漏れ/過剰)`);
  for (const x of supp.ids) { if (lod2Ids.has(x)) fail(`補完LOD1 に LOD2 の ID が残存: ${x}`); if (excluded.has(x)) fail(`補完LOD1 に除外 ID: ${x}`); if (!orig.ids.has(x)) fail(`補完LOD1 の ID が元に無い: ${x}`); }
  return { origIds: orig.ids.size, suppIds: supp.ids.size, excludedIds: excluded.size, lod2CoveredInOrig: lod2InOrig.size, lod2IdsTotal: lod2Ids.size, doubleDrawn: 0, leafFilesOrig: orig.files, leafFilesSupp: supp.files };
}
