// tools/lib/gsi-tile-probe.js
// [Mission 35B §1/§2/§3] 地理院タイルの「実際の」解像度を測るための純粋関数と薄い HTTP 層。
//   §2 の要求どおり、Web 表示の zoom ではなく **配信されている最大 native zoom** から
//   地上画素寸法（GSD）を出す。maxzoom を超えた要求は 404 になるか、上位を拡大した
//   画像が返る（＝情報量が増えない）ので、両方を判定する。

/** Web Mercator のタイル座標（z/x/y）。 */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const la = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n),
  };
}

/** そのタイルの 1px が地上何 m か（256px タイル前提）。 */
export function mppAt(lat, z) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** 梅田 PoC 範囲を覆うタイルの z/x/y を列挙する。 */
export function tilesCovering(bbox, z) {
  const a = lonLatToTile(bbox.west, bbox.north, z);
  const b = lonLatToTile(bbox.east, bbox.south, z);
  const out = [];
  for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) out.push({ z, x, y });
  }
  return out;
}

/**
 * §5 写真縮尺と走査 dpi から地上画素寸法を出す。
 *   「400dpi だから高解像度」は誤り。元の写真縮尺で決まる。
 * @param {number} scaleDenom 写真縮尺の分母（例 1:8000 なら 8000）
 * @param {number} dpi 走査解像度
 * @returns {number} 地上画素寸法 [m]
 */
export function scannedPhotoGsd(scaleDenom, dpi) {
  const mmPerPixel = 25.4 / dpi;          // フィルム上の 1px の大きさ [mm]
  return (mmPerPixel * scaleDenom) / 1000; // [m]
}

/**
 * §6 ステレオ復元で得られる高さの精度。
 *   撮影基線長 B / 撮影高度 H（基線高度比）と視差測定精度から決まる。
 * @param {number} gsdM 地上画素寸法 [m]
 * @param {number} baseHeightRatio B/H（60% オーバーラップの標準的な航空写真で約 0.6）
 * @param {number} parallaxPx 視差の測定精度 [px]（自動マッチングで 0.3〜1.0 が現実的）
 */
export function stereoHeightPrecision(gsdM, baseHeightRatio, parallaxPx = 0.5) {
  return (gsdM * parallaxPx) / baseHeightRatio;
}

/** 前後の重複率から基線高度比を出す（画面短辺方向の撮影基線）。 */
export function baseHeightFromOverlap(forwardOverlap, fieldAngleDeg = 74) {
  // 画角 2θ のカメラで、1 コマの地上幅 W = 2 H tan(θ)。重複 p なら B = W (1 - p)。
  const halfTan = Math.tan((fieldAngleDeg / 2) * (Math.PI / 180));
  return 2 * halfTan * (1 - forwardOverlap);
}

/**
 * 同じ画像を 2 段階の zoom で取ったとき、下位が上位の単純拡大かどうか。
 * 拡大なら「解像度は名目だけで、実際の情報量は増えていない」と言える（§2）。
 * @param {Uint8Array} childPixels 下位 zoom のタイルを親相当へ縮小した画素
 * @param {Uint8Array} parentPixels 親 zoom の該当 1/4 領域の画素
 */
export function pixelDifference(childPixels, parentPixels) {
  const n = Math.min(childPixels.length, parentPixels.length);
  if (!n) return null;
  let sum = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(childPixels[i] - parentPixels[i]);
    sum += d; if (d > max) max = d;
  }
  return { meanAbs: +(sum / n).toFixed(3), maxAbs: max, n };
}

/** 画像に含まれる情報量の目安。上位を拡大しただけの画像は高周波成分が乏しい。 */
export function highFrequencyEnergy(gray, w, h) {
  let sum = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // ラプラシアン
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v * v; cnt++;
    }
  }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}

export const USER_AGENT = 'livecity-data-pipeline/0.2.0 (Mission35B aerial evidence audit)';

/** 1 タイル取得。404 と本文なしを区別して返す。 */
export async function fetchTile(url, { timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { ok: false, status: res.status, bytes: 0, buf: null };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, bytes: buf.length, buf,
      contentType: res.headers.get('content-type') || null };
  } catch (e) {
    return { ok: false, status: 0, bytes: 0, buf: null, error: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}
