// tools/lib/osm-pbf-stream.js
// P1-6B / P1-6D: .osm.pbf を OSM primitive（node / way / relation）の async iterable へ変換する
//                薄いアダプタ。parser 交換の境界はこのファイルに閉じ込める。
//
// 【役割分担】
//   PBF バイナリのデコードは npm パッケージ `osm-pbf-parser`（pure JS）へ委譲する。
//   このファイルだけが osm-pbf-parser に依存し、読み込みは「実際にストリームを回すときだけ」
//   動的 import で行う。したがって:
//     - パッケージ未インストールでも tools/import/osm-pbf-city.js の純粋関数は読み込める
//     - npm test（合成 primitive でテスト）は osm-pbf-parser 無しで green のまま
//
// 【P1-6D 修正】osm-pbf-parser が pipe で返す stream は through2/readable-stream v2 系で、
//   Symbol.asyncIterator を持たない（`for await` 不可 → "stream is not async iterable"）。
//   そのため objectStreamToPrimitives() で 'data'/'end'/'error' を手動購読し、
//   backpressure（pause/resume）付きで async generator へ橋渡しする。
//   importOsmPbfCity 側の `for await (const primitive of openPrimitiveStream())` は不変。
//
// 【item 形状】osm-pbf-parser は dense node も {type:'node'} に正規化し、1 チャンク = 要素の配列で push する。
//   実装差を normalizePrimitive() で吸収し、内部標準形へ揃える:
//     node:     { type:'node', id:<number>, lat, lon, tags:{} }
//     way:      { type:'way',  id:<number>, refs:[<number>...], tags:{} }
//     relation: { type:'relation', id:<number>, members:[{type,ref:<number>,role}], tags:{} }

let _parseOSM = null;

async function loadParser() {
  if (_parseOSM) return _parseOSM;
  let mod;
  try {
    mod = await import('osm-pbf-parser');
  } catch (e) {
    throw new Error(
      'osm-pbf-parser を読み込めませんでした。プロジェクトルートで `npm install` を実行してください\n' +
      '（package.json の dependencies に追加済み。インストールにはネットワークが必要です）。\n' +
      `  元エラー: ${(e && e.message) || e}`
    );
  }
  // CommonJS（module.exports = function parseOSM(){}）を dynamic import した場合、
  // 実体は mod.default に入る。稀なラッパも考慮して段階的に剥がす。
  const cand = [mod && mod.default, mod && mod.default && mod.default.default, mod].filter(Boolean);
  _parseOSM = cand.find((c) => typeof c === 'function');
  if (!_parseOSM) {
    throw new Error(`osm-pbf-parser の export が関数ではありません（typeof default = ${typeof (mod && mod.default)}）`);
  }
  return _parseOSM;
}

/**
 * osm-pbf-parser の生 item を内部標準形へ正規化する。フィールド名の揺れ（id が string、
 * refs / nodes、lat / latitude など）を吸収する。純粋関数なのでテスト可能。
 * @param {any} item
 * @returns {{type:string,id:number,tags:object}|null}
 */
export function normalizePrimitive(item) {
  if (!item || typeof item !== 'object' || !item.type) return null;
  const tags = item.tags && typeof item.tags === 'object' ? item.tags : {};
  if (item.type === 'node') {
    const lat = item.lat != null ? Number(item.lat) : (item.latitude != null ? Number(item.latitude) : null);
    const lon = item.lon != null ? Number(item.lon) : (item.longitude != null ? Number(item.longitude) : null);
    return { type: 'node', id: Number(item.id), lat, lon, tags };
  }
  if (item.type === 'way') {
    const rawRefs = item.refs || item.nodes || item.nodeRefs || [];
    return { type: 'way', id: Number(item.id), refs: rawRefs.map(Number), tags };
  }
  if (item.type === 'relation') {
    const members = (item.members || []).map((m) => ({
      type: m.type,
      ref: Number(m.ref != null ? m.ref : m.id),
      role: m.role || '',
    }));
    return { type: 'relation', id: Number(item.id), members, tags };
  }
  return null;
}

/**
 * objectMode の Readable/Transform（'data' で「要素配列」または「単一要素」を emit）を
 * 正規化済み primitive の async generator へ変換する。
 *
 *  - チャンクが配列でも単一 object でも安全に展開する
 *  - source / parsed どちらの 'error' も generator 側へ throw する
 *  - 'end' / 'close' で generator を終了する
 *  - 消費が追いつかないときは parsed.pause() で backpressure をかける
 *  - generator の終了（正常・例外・early return）で必ず listener を外し stream を destroy する
 *
 * @param {import('node:stream').Readable} parsed  parser 出力ストリーム（= source.pipe(parseOSM())）
 * @param {import('node:stream').Readable} [source] 元の createReadStream（error 購読用。省略可）
 * @param {() => void} [start] listener 装着後にフロー開始する処理（pipe 実行など）
 * @returns {AsyncGenerator<{type:string,id:number,tags:object}>}
 */
export async function* objectStreamToPrimitives(parsed, source, start) {
  const HIGH_WATER = 64;
  const LOW_WATER = 16;
  const queue = [];
  let ended = false;
  let streamError = null;
  let paused = false;
  let notify = null;

  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
  const onData = (chunk) => {
    queue.push(chunk);
    if (!paused && queue.length >= HIGH_WATER && parsed && typeof parsed.pause === 'function') {
      paused = true;
      parsed.pause();
    }
    wake();
  };
  const onEnd = () => { ended = true; wake(); };
  const onError = (err) => { streamError = err || new Error('stream error'); ended = true; wake(); };

  parsed.on('data', onData);
  parsed.on('end', onEnd);
  parsed.on('close', onEnd);
  parsed.on('error', onError);
  if (source && typeof source.on === 'function') source.on('error', onError);

  if (typeof start === 'function') start();

  try {
    while (true) {
      while (queue.length) {
        const chunk = queue.shift();
        if (paused && queue.length <= LOW_WATER && parsed && typeof parsed.resume === 'function') {
          paused = false;
          parsed.resume();
        }
        const items = Array.isArray(chunk) ? chunk : [chunk];
        for (const raw of items) {
          const p = normalizePrimitive(raw);
          if (p) yield p;
        }
      }
      if (streamError) throw streamError;
      if (ended) return;
      await new Promise((resolve) => { notify = resolve; });
    }
  } finally {
    parsed.removeListener('data', onData);
    parsed.removeListener('end', onEnd);
    parsed.removeListener('close', onEnd);
    parsed.removeListener('error', onError);
    if (source && typeof source.removeListener === 'function') source.removeListener('error', onError);
    try { if (parsed && typeof parsed.destroy === 'function') parsed.destroy(); } catch { /* noop */ }
    try { if (source && typeof source.destroy === 'function') source.destroy(); } catch { /* noop */ }
  }
}

/**
 * .osm.pbf を primitive の async iterable にする。
 * 3-pass 抽出のため複数回イテレートされるので、呼ぶたびに新しいストリームを開く。
 * @param {string} filePath
 * @returns {AsyncGenerator<{type:string,id:number,tags:object}>}
 */
export async function* pbfPrimitiveStream(filePath) {
  const fs = await import('node:fs');
  const parseOSM = await loadParser();
  const source = fs.createReadStream(filePath);
  const parser = parseOSM();
  // listener を付けてから pipe する（'data' 取りこぼし防止）。
  yield* objectStreamToPrimitives(parser, source, () => { source.pipe(parser); });
}
