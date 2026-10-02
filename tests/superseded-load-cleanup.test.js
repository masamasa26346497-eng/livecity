// tests/superseded-load-cleanup.test.js
// [AutoDev P0-3] FullWardManagerのsuperseded loadで残るhidden tile/metadataについての調査。
//
// 【調査結論】専用のorphan cleanup機構は不要と判断した。理由:
//   1. supersededされたgenerationがloadRemoteTile()で生成したtileは、loadAllTiles()内で
//      即座にtile.hide()され、通常のring-based navigationでhide()されたtileと全く同じ
//      'loaded-hidden'状態になる(public/osaka_3d_buildings.ward-ux-v1.html loadAllTiles、
//      現在の行番号は概ね5020-5055)。
//   2. BuildingTileLayer.updateByCamera()内のLRU破棄ブロック(概ね行4359-4372)は、
//      'remote'かつ'loaded-hidden'な全tileを対象にしており、__fullModeDatasetIds
//      (full-modeのdataset集合、ring判定をスキップするためだけに使われる)による除外を
//      一切受けない。つまりsuperseded loadが残したhidden tileも、通常のWARM tileと
//      同じmaxCachedHiddenTiles(既定256)のLRU管理下に入り、上限超過時に確実にdispose()
//      される。このLRUはrequestAnimationFrameループから毎フレーム(500ms間隔で内部判定)
//      呼ばれるため、full-mode/ward切替の有無に関わらず継続的に働く。
//   3. tile.dispose()はThree.jsのscene.remove(m)・m.geometry.dispose()を実施し、
//      bMesh/bldgWM/bldgTM/bldgEdgesからも除去する。「disposeしたつもりで実は参照が
//      残る」ような見せかけの解放にはなっていない。
//   4. FullWardManager.loadFullWard()自身のloadingStateは、supersededされた分岐も含め
//      全ての早期returnパスでgeneration一致を確認した上でnull化されており、
//      generationをまたいで残留しない。
//   したがって、追加のWard単位/generation単位のorphan cleanup機構を新設する必要性は
//   確認されなかった(AUTODEV_RULES.md 5.3により、新設自体もそもそも許可されていない)。
//   本ファイルはこの調査結論を将来の変更から保護する回帰テストである。
//
// 【方針】tests/ward-lifecycle.test.js・tests/picking-visibility.test.jsと同じ考え方で、
// 実際に配信されるHTMLからソースをそのまま抽出して評価する(再実装しない)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const STANDARD_CANDIDATE_PATHS = [
  path.join(process.cwd(), 'public', 'osaka_3d_buildings.ward-ux-v1.html'),
  path.join(process.cwd(), '..', 'public', 'osaka_3d_buildings.ward-ux-v1.html'),
];

function resolveHtmlPath() {
  if (process.env.LIVECITY_WARD_HTML_PATH) return process.env.LIVECITY_WARD_HTML_PATH;
  for (const candidate of STANDARD_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HTML_PATH = resolveHtmlPath();
const SKIP_REASON = HTML_PATH
  ? false
  : `Ward UX検証用HTML(osaka_3d_buildings.ward-ux-v1.html)が見つかりません。標準配置候補(` +
    `${STANDARD_CANDIDATE_PATHS.join(', ')})に存在しないか、環境変数 LIVECITY_WARD_HTML_PATH で` +
    `明示的にパスを指定してください。`;

function loadHtml() {
  return readFileSync(HTML_PATH, 'utf-8');
}

function findMatchingBrace(str, openIdx) {
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    const next = str[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`対応する'}'が見つかりません(開始index=${openIdx})`);
}

function extractFunctionDecl(html, fnName, fromIdx = 0) {
  const marker = `function ${fnName}(`;
  const startIdx = html.indexOf(marker, fromIdx);
  if (startIdx === -1) throw new Error(`"${marker}" がHTML内に見つかりません`);
  const braceIdx = html.indexOf('{', startIdx);
  const closeIdx = findMatchingBrace(html, braceIdx);
  return html.slice(startIdx, closeIdx + 1);
}

function extractConstIIFE(html, constName) {
  const marker = `const ${constName} = (function`;
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error(`"${marker}" がHTML内に見つかりません`);
  const braceIdx = html.indexOf('{', startIdx);
  const closeIdx = findMatchingBrace(html, braceIdx);
  const semiIdx = html.indexOf(';', closeIdx);
  if (semiIdx === -1) throw new Error(`${constName} の終端(;)が見つかりません`);
  return html.slice(startIdx, semiIdx + 1);
}

// updateByCamera内の「LRU破棄」ブロックだけを、コメント区切りを目印に取り出す。
function extractLruDisposeBlock(html) {
  const fnSrc = extractFunctionDecl(html, 'updateByCamera');
  const startMarker = '// LRU:';
  const endMarker = '// [METADATA-EVICT]';
  const startIdx = fnSrc.indexOf(startMarker);
  if (startIdx === -1) throw new Error('updateByCamera内に"// LRU:"ブロックが見つかりません');
  const endIdx = fnSrc.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('LRUブロックの終端("// [METADATA-EVICT]")が見つかりません');
  return fnSrc.slice(startIdx, endIdx);
}

test('BuildingTileLayer LRU破棄: hidden tileのdispose対象はfull-mode datasetでも除外されない(superseded load由来のhidden tileも例外なくLRU管理下)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const lruBlock = extractLruDisposeBlock(html);

  assert.ok(/t\.source === 'remote'/.test(lruBlock), 'remote tileを対象にするフィルタが見つかりません');
  assert.ok(/t\.state === 'loaded-hidden'/.test(lruBlock), "'loaded-hidden'状態のtileを対象にするフィルタが見つかりません");
  assert.ok(/\.dispose\(\)/.test(lruBlock), 'dispose()呼び出しが見つかりません');
  assert.ok(
    !lruBlock.includes('__fullModeDatasetIds'),
    'LRU破棄ブロックがfull-mode datasetを除外するよう変更されています。' +
    'superseded loadが残すhidden tileがLRU管理から漏れ、orphanとして蓄積する回帰の可能性があります。',
  );
});

test('BuildingTileLayer tile.dispose(): sceneからの除去とgeometry解放を実施する(見せかけの解放になっていない)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const makeTileSrc = extractFunctionDecl(html, 'makeTile');
  const disposeIdx = makeTileSrc.indexOf('dispose() {');
  assert.ok(disposeIdx !== -1, 'makeTile()内にdispose()メソッドが見つかりません');
  const braceIdx = makeTileSrc.indexOf('{', disposeIdx);
  const closeIdx = findMatchingBrace(makeTileSrc, braceIdx);
  const disposeBody = makeTileSrc.slice(disposeIdx, closeIdx + 1);

  assert.ok(disposeBody.includes('scene.remove(m)'), 'dispose()がscene.remove(m)を呼んでいません');
  assert.ok(disposeBody.includes('m.geometry.dispose()'), 'dispose()がgeometry.dispose()を呼んでいません');
  assert.ok(/this\.state = 'disposed'/.test(disposeBody), "dispose()後にstateが'disposed'へ遷移していません");
});

test('FullWardManager.loadAllTiles: ロード直後にtile.hide()され、supersededなgenerationのtileが誤ってvisibleのまま残らない', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const loadAllTilesSrc = extractFunctionDecl(html, 'loadAllTiles');

  assert.ok(loadAllTilesSrc.includes('tile.hide()'), 'loadAllTiles()がtile.hide()を呼んでいません(一括表示前提が崩れている可能性)');
  assert.ok(!loadAllTilesSrc.includes('tile.show()'), 'loadAllTiles()が個々のtileを即座にshow()しています(atomic commit前提・superseded時の非表示保証が崩れる可能性)');
});

// ── FullWardManager: supersededされたgenerationのloadingStateが残留しないことの動的検証 ──
// (tests/ward-lifecycle.test.jsと同じモック方式。BuildingTileLayer全体ではなく
//  FullWardManager/WardModeManagerのみをHTMLから抽出して評価する。)
function createMockBuildingTileLayer(tilesByDataset, shouldFail) {
  const manifestState = {};
  const tileObjects = {};
  const attempts = {};
  return {
    enableDataset(id) { manifestState[id] = 'ready'; },
    disableDataset() {},
    disposeDataset() {},
    getDatasetStats(id) {
      return { manifestState: manifestState[id] || 'none', tiles: 0, bounds: null, visibleTiles: 0, hiddenTiles: 0 };
    },
    getDatasetManifestTiles(id) { return tilesByDataset[id] || []; },
    async loadRemoteTile(id, tx, tz) {
      const key = `${id}:${tx}_${tz}`;
      attempts[key] = (attempts[key] || 0) + 1;
      if (shouldFail && shouldFail(id, tx, tz, attempts[key])) return null;
      const tile = { loaded: true, visible: false, show() { this.visible = true; }, hide() { this.visible = false; } };
      tileObjects[key] = tile;
      return tile;
    },
    getTileObject(id, tx, tz) { return tileObjects[`${id}:${tx}_${tz}`] || null; },
  };
}

function createConsoleStub() {
  return { log() {}, warn() {}, error() {} };
}

function loadFullWardManager(html, mockBTL) {
  const fullWardSrc = extractConstIIFE(html, 'FullWardManager');
  const factory = new Function(
    'BuildingTileLayer', 'performance', 'console', 'window', 'setInterval', 'clearInterval',
    `'use strict';\n${fullWardSrc}\nreturn FullWardManager;`,
  );
  return factory(mockBTL, performance, createConsoleStub(), {}, setInterval, clearInterval);
}

test('FullWardManager: supersededされたgenerationが完了しても、getLoadingState()にstaleなstateが残留しない', { skip: SKIP_REASON }, async () => {
  const html = loadHtml();
  const tiles = {
    'osaka-higashisumiyoshi': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
    'osaka-hirano': [{ tx: 0, tz: 0 }],
  };
  const mockBTL = createMockBuildingTileLayer(tiles, () => false);
  mockBTL.enableDataset('osaka-higashisumiyoshi');
  mockBTL.enableDataset('osaka-hirano');
  const FullWardManager = loadFullWardManager(html, mockBTL);

  // 連打を再現: genAの完了を待たずgenBを開始する(genAがsupersededされる)。
  const genA = FullWardManager.loadFullWard('osaka-higashisumiyoshi');
  const genB = FullWardManager.loadFullWard('osaka-hirano');

  const [resultA, resultB] = await Promise.all([genA, genB]);

  assert.equal(resultA.superseded, true, '古い世代(genA)はsupersededとして扱われるべき');
  assert.equal(resultB.superseded, false, '新しい世代(genB)は正常にcommitされるべき');
  assert.equal(
    FullWardManager.getLoadingState(), null,
    'genB完了後、loadingStateはnullへ戻るべき(supersededされたgenAのstateが残留してはいけない)',
  );
});

// ── [P0-3 最終確認] metadata eviction (evictTileMetadata) の回帰テスト ──
// updateByCamera内の「// [METADATA-EVICT] disposedから猶予期間...」から関数末尾までを抽出する。
// この節はupdateByCamera内で最後に評価される独立したifブロックのため、マーカー以降の全文で足りる。
function extractMetadataEvictBlock(html) {
  const fnSrc = extractFunctionDecl(html, 'updateByCamera');
  const marker = '// [METADATA-EVICT] disposedから猶予期間';
  const startIdx = fnSrc.indexOf(marker);
  if (startIdx === -1) throw new Error('updateByCamera内に"// [METADATA-EVICT] disposedから猶予期間"ブロックが見つかりません');
  return fnSrc.slice(startIdx);
}

test('BuildingTileLayer evictTileMetadata: remote+disposed+metadataEvicted=falseのtileだけを対象に状態遷移し、updateByCamera側は既定120秒後にfull-mode除外なく呼び出す', { skip: SKIP_REASON }, () => {
  const html = loadHtml();

  // ① evictTileMetadata(tile) 自体の存在と対象条件(remote + disposed + metadataEvicted=false のみ)。
  const evictSrc = extractFunctionDecl(html, 'evictTileMetadata');
  assert.ok(
    /tile\.source\s*!==\s*'remote'/.test(evictSrc),
    'evictTileMetadata()がsource!==\'remote\'(embedded建物)を除外するガードを持っていません',
  );
  assert.ok(
    /tile\.state\s*!==\s*'disposed'/.test(evictSrc),
    'evictTileMetadata()がstate!==\'disposed\'なtileを除外するガードを持っていません',
  );
  assert.ok(
    /tile\.metadataEvicted/.test(evictSrc),
    'evictTileMetadata()が既にmetadataEvicted=trueなtileを除外するガードを持っていません(二重evict防止)',
  );

  // ② 状態遷移: buildingIndicesを空配列へ、metadataEvictedをtrueへ。
  assert.ok(
    /tile\.buildingIndices\s*=\s*\[\]/.test(evictSrc),
    'evictTileMetadata()がbuildingIndicesを空配列にしていません',
  );
  assert.ok(
    /tile\.metadataEvicted\s*=\s*true/.test(evictSrc),
    'evictTileMetadata()がmetadataEvictedをtrueにしていません',
  );

  // ③ updateByCamera側: disposedAtから既定120000ms(120秒)経過後にevictTileMetadata(t)を呼ぶ。
  const block = extractMetadataEvictBlock(html);
  assert.ok(/evictTileMetadata\(t\)/.test(block), 'updateByCamera内でevictTileMetadata(t)が呼ばれていません');
  assert.ok(/120000/.test(block), '既定の猶予期間120000ms(120秒)が見つかりません');
  assert.ok(
    /t\.disposedAt\s*!=\s*null/.test(block),
    'disposedAtがnullでないことを確認するガードが見つかりません',
  );
  assert.ok(
    /__now\s*-\s*t\.disposedAt/.test(block) && /__graceMs/.test(block),
    'disposedAtからの経過時間(__now - t.disposedAt)を猶予期間(__graceMs)と比較する判定が見つかりません',
  );

  // ④ full-mode datasetをmetadata eviction対象から除外する条件が無いこと
  //    (superseded-load-cleanup調査の結論と同じく、full-modeのdatasetもLRU/evictionから
  //     特別扱いで除外されてはいけない)。
  assert.ok(
    !block.includes('__fullModeDatasetIds'),
    'metadata evictionブロックがfull-mode datasetを除外するよう変更されています。' +
    'full-mode(atomic swap)のdatasetもremote+disposedであればmetadata evictionの対象であるべきです。',
  );
});
