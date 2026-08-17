// tests/ward-lifecycle.test.js
// [AutoDev P0-1] Ward切替(WardModeManager/FullWardManager)の回帰テスト。
//
// 【方針】ブラウザ・Three.jsを実際には起動できない環境のため、
// public/osaka_3d_buildings.ward-ux-v1.html からWard関連の主要コード
// (WardModeManager/FullWardManager/getWardUXStatus、およびWard SelectorのdataReady
// ゲーティング部分)をソースのまま抽出し、BuildingTileLayer等を最小限のモックに差し替えて
// 実際に評価・実行することで、既存のWard lifecycle挙動(AUTODEV_RULES.md 5.1参照)を保護する。
// 再実装ではなく、実際に配信されるコードそのものをテストする(tests/html-regression.test.jsの
// normalizeTownName抽出テストと同じ考え方)。
//
// 対象(AUTODEV_BACKLOG.md P0-1の確認項目):
//   - switchWard()が正常に呼べる
//   - generation/superseded guardを破壊していない
//   - failed tile時にcommit abortされる既存挙動を維持
//   - WardAreaFill / WardBoundary / WardLabelがcurrentWardIdに追従
//   - Ward SelectorのdataReady=false区がfetch対象にならない
//
// 【注意】Ward lifecycleそのものは一切変更しない。本ファイルは既存挙動の保護のみを目的とする。
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

// ── ソース抽出ヘルパー(文字列/テンプレートリテラル/コメント内の{}に惑わされない、対応する'}'探索) ──
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

function extractFunctionDecl(html, fnName) {
  const marker = `function ${fnName}(`;
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error(`"${marker}" がHTML内に見つかりません`);
  const braceIdx = html.indexOf('{', startIdx);
  const closeIdx = findMatchingBrace(html, braceIdx);
  return html.slice(startIdx, closeIdx + 1);
}

function extractBlockAfterMarker(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error(`"${marker}" がHTML内に見つかりません`);
  const braceIdx = html.indexOf('{', idx);
  const closeIdx = findMatchingBrace(html, braceIdx);
  return html.slice(idx, closeIdx + 1);
}

// ── WardModeManager/FullWardManager/getWardUXStatusを、実HTMLのソースそのままモック環境で評価する ──
function loadWardModules(html) {
  const wardModeSrc = extractConstIIFE(html, 'WardModeManager');
  const fullWardSrc = extractConstIIFE(html, 'FullWardManager');
  const statusSrc = extractFunctionDecl(html, 'getWardUXStatus');
  return new Function(
    'BuildingTileLayer', 'BUILDING_TILE_CONFIG', 'TOWN_POLYGONS', 'controls', 'camUpd',
    'performance', 'console', 'window', 'document', 'setInterval', 'clearInterval', 'setTimeout',
    `'use strict';\n${wardModeSrc}\n${fullWardSrc}\n${statusSrc}\nreturn { WardModeManager, FullWardManager, getWardUXStatus };`,
  );
}

function createConsoleStub() {
  return { log() {}, warn() {}, error() {} };
}

function createDocumentStub() {
  return { createElement() { return { style: {}, appendChild() {} }; }, body: { appendChild() {} } };
}

// datasetId => [{tx,tz}, ...] のtile一覧を持つ最小BuildingTileLayerモック。
// shouldFail(datasetId, tx, tz, attemptNo) がtrueを返すタイルはloadRemoteTileがnullを返す(失敗)。
function createMockBuildingTileLayer(tilesByDataset, shouldFail) {
  const calls = { enableDataset: [], disableDataset: [], disposeDataset: [] };
  const manifestState = {};
  const tileObjects = {};
  const attempts = {};
  return {
    calls,
    enableDataset(id) { calls.enableDataset.push(id); manifestState[id] = 'ready'; },
    disableDataset(id) { calls.disableDataset.push(id); },
    disposeDataset(id) { calls.disposeDataset.push(id); },
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
    prefetchManifestOnly() {},
  };
}

function buildSandbox(mockBTL) {
  const factory = loadWardModules(loadHtml());
  return factory(
    mockBTL, undefined, undefined, undefined, undefined,
    performance, createConsoleStub(), {}, createDocumentStub(),
    setInterval, clearInterval, setTimeout,
  );
}

// FullWardManager.loadFullWard()が返すPromiseを捕捉するためのラップヘルパー。
// switchWard()内部の.then(handler)はこのPromiseに対して先に登録されるため、
// 呼び出し側でこのPromiseをawaitすればhandlerの完了後まで待てる。
function captureLoadFullWard(sandbox) {
  const original = sandbox.FullWardManager.loadFullWard;
  const captured = [];
  sandbox.FullWardManager.loadFullWard = (...args) => {
    const p = original(...args);
    captured.push(p);
    return p;
  };
  return captured;
}

test('Ward切替: switchWard()が住吉区・東住吉区・平野区いずれも正常に呼べ、全タイルcommitされる', { skip: SKIP_REASON }, async () => {
  const tiles = {
    'osaka-sumiyoshi': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
    'osaka-higashisumiyoshi': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
    'osaka-hirano': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
  };
  const mockBTL = createMockBuildingTileLayer(tiles, () => false);
  const sandbox = buildSandbox(mockBTL);
  const captured = captureLoadFullWard(sandbox);

  for (const wardId of ['sumiyoshi', 'higashisumiyoshi', 'hirano']) {
    const ok = sandbox.WardModeManager.switchWard(wardId);
    assert.equal(ok, true, `switchWard('${wardId}')はtrueを返すべき`);
    const result = await captured[captured.length - 1];
    assert.equal(result.superseded, false);
    assert.equal(result.aborted, false);
    assert.equal(result.tilesFailed, 0);
    assert.equal(result.tilesLoaded, tiles[`osaka-${wardId}`].length);
    assert.equal(sandbox.WardModeManager.currentWardId, wardId);
  }
});

test('Ward切替: generation/supersededガード — 連続切替時、古い世代はsupersededとしてatomic commitされない', { skip: SKIP_REASON }, async () => {
  const tiles = {
    'osaka-higashisumiyoshi': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
    'osaka-hirano': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
  };
  const mockBTL = createMockBuildingTileLayer(tiles, () => false);
  const sandbox = buildSandbox(mockBTL);
  const captured = captureLoadFullWard(sandbox);

  // 連打を再現: higashisumiyoshiへの切替直後、それが完了する前にhiranoへ切替える。
  sandbox.WardModeManager.switchWard('higashisumiyoshi'); // gen A(古い世代)
  sandbox.WardModeManager.switchWard('hirano');            // gen B(新しい世代)

  const [resultA, resultB] = await Promise.all(captured);

  assert.equal(resultA.superseded, true, '古い世代(gen A)はsupersededとして扱われるべき');
  assert.equal(resultB.superseded, false, '新しい世代(gen B)は正常にcommitされるべき');
  assert.equal(resultB.aborted, false);
  // 最終的にACTIVEなのは新しい世代の切替先だけ
  assert.equal(sandbox.WardModeManager.currentWardId, 'hirano');
});

test('FullWardManager: 失敗タイルは1回だけ自動retryされ、成功すれば通常どおりcommitされる', { skip: SKIP_REASON }, async () => {
  const tiles = { 'osaka-hirano': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }] };
  // (0,0)は初回だけ失敗し、retry(2回目)で成功する。
  const mockBTL = createMockBuildingTileLayer(tiles, (id, tx, tz, attemptNo) => tx === 0 && tz === 0 && attemptNo === 1);
  const sandbox = buildSandbox(mockBTL);
  // 実際の呼び出し順(switchWard内: enableDataset() → loadFullWard())を再現する。
  // enableDataset未呼び出しだとmanifestStateが'none'のままmanifest待ちループがタイムアウトしてしまう。
  mockBTL.enableDataset('osaka-hirano');

  const result = await sandbox.FullWardManager.loadFullWard('osaka-hirano');
  assert.equal(result.aborted, false, 'retryで成功した場合はcommit中止されるべきではない');
  assert.equal(result.tilesFailed, 0);
  assert.equal(result.tilesLoaded, 2);
});

test('Ward切替: retry後も失敗タイルが残る場合、commitが中止され旧区は維持される(disposeされない)', { skip: SKIP_REASON }, async () => {
  const tiles = {
    'osaka-sumiyoshi': [{ tx: 0, tz: 0 }],
    'osaka-higashisumiyoshi': [{ tx: 0, tz: 0 }, { tx: 1, tz: 0 }],
  };
  // higashisumiyoshiの(0,0)は初回・retryとも常に失敗する。
  const mockBTL = createMockBuildingTileLayer(tiles, (id, tx, tz) => id === 'osaka-higashisumiyoshi' && tx === 0 && tz === 0);
  const sandbox = buildSandbox(mockBTL);
  const captured = captureLoadFullWard(sandbox);

  // まず住吉区へ切替えて正常にcommitさせ、「旧区」を確定させる。
  sandbox.WardModeManager.switchWard('sumiyoshi');
  const firstResult = await captured[0];
  assert.equal(firstResult.aborted, false);

  // 次に、常に1タイル失敗し続ける東住吉区へ切替える。
  sandbox.WardModeManager.switchWard('higashisumiyoshi');
  const secondResult = await captured[1];

  assert.equal(secondResult.superseded, false);
  assert.equal(secondResult.aborted, true, 'retry後も失敗が残る場合はaborted:trueであるべき');
  assert.equal(secondResult.tilesFailed, 1);
  assert.ok(
    !mockBTL.calls.disposeDataset.includes('osaka-sumiyoshi'),
    '旧区(住吉区)はcommit中止時にdisposeされてはいけない(旧区の表示を維持する既存仕様)',
  );
});

test('getWardUXStatus: currentWardIdと一致する区はactive、tileが残る区はwarm、それ以外はevicted', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const statusSrc = extractFunctionDecl(html, 'getWardUXStatus');
  const getWardUXStatus = new Function(
    'WardModeManager', 'BuildingTileLayer',
    `${statusSrc}\nreturn getWardUXStatus;`,
  )(
    {
      currentWardId: 'sumiyoshi',
      WARD_DEFS: [
        { id: 'sumiyoshi', datasetId: 'osaka-sumiyoshi' },
        { id: 'higashisumiyoshi', datasetId: 'osaka-higashisumiyoshi' },
        { id: 'hirano', datasetId: 'osaka-hirano' },
      ],
    },
    {
      getDatasetStats(datasetId) {
        if (datasetId === 'osaka-higashisumiyoshi') return { visibleTiles: 0, hiddenTiles: 3 };
        return { visibleTiles: 0, hiddenTiles: 0 };
      },
    },
  );

  assert.equal(getWardUXStatus('sumiyoshi'), 'active');
  assert.equal(getWardUXStatus('higashisumiyoshi'), 'warm');
  assert.equal(getWardUXStatus('hirano'), 'evicted');
});

test('Ward表示レイヤー: WardBoundaryLayer/WardAreaFillLayer/WardLabelLayerがgetWardUXStatus()を参照している(currentWardIdへの追従経路が失われていない)', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  for (const layerName of ['WardBoundaryLayer', 'WardAreaFillLayer', 'WardLabelLayer']) {
    const src = extractConstIIFE(html, layerName);
    assert.ok(/getWardUXStatus\(/.test(src), `${layerName}がgetWardUXStatus()を参照していません(currentWardId追従が壊れている可能性)`);
  }
});

test('Ward Selector: dataReady=false区の行にはswitchWardへ繋がるクリックハンドラが設定されない', { skip: SKIP_REASON }, () => {
  const html = loadHtml();
  const loopBlock = extractBlockAfterMarker(html, 'for (const def of WardModeManager.WARD_DEFS) {');

  assert.ok(/const ready = def\.dataReady !== false;/.test(loopBlock), 'dataReadyの明示的false判定(未指定は準備済み扱い)が失われています');

  const readyIfIdx = loopBlock.indexOf('if (ready) {');
  assert.ok(readyIfIdx !== -1, 'if (ready) { ... } ブロックが見つかりません');

  const beforeReadyBlock = loopBlock.slice(0, readyIfIdx);
  assert.ok(!beforeReadyBlock.includes("addEventListener('click'"), 'ready判定より前でクリックハンドラが登録されています(dataReady=false区にもfetchが発生する可能性)');

  const readyBraceIdx = loopBlock.indexOf('{', readyIfIdx);
  const readyCloseIdx = findMatchingBrace(loopBlock, readyBraceIdx);
  const readyBlock = loopBlock.slice(readyIfIdx, readyCloseIdx + 1);

  assert.ok(readyBlock.includes("addEventListener('click'"), 'ready区のクリックハンドラ登録が見つかりません');
  assert.ok(readyBlock.includes('WardModeManager.switchWard(def.id)'), 'ready区のクリックハンドラがswitchWard(def.id)を呼んでいません');
});
