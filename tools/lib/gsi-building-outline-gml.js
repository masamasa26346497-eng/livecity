// tools/lib/gsi-building-outline-gml.js
// [Mission 31G-FIX20] 基盤地図情報 JPGIS(GML) の「建築物の外周線」(BldL) を正規表現ベースで抽出する。
//   tools/lib/gsi-road-edge-gml.js（FIX15/16, RdEdg）と同じ方針・同じ GML schema family
//   （xmlns="http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema"。既定 namespace で prefix 無し）。
//
//   §2 GSI feature semantics（[FIX21実測] mesh 523514・FG-GML-523514-BldL-20260401-0001.xml で確認済み）:
//     - BldA（建築物）: Polygon（建物の面）。同一 ZIP に 4 分割ファイルとして同梱（1ファイルあたり最大約90MB）。
//     - BldL（建築物の外周線）: `<BldL gml:id="K18_...">` + `<loc><gml:Curve srsName="fguuid:jgd2024.bl">
//       <gml:segments><gml:LineStringSegment><gml:posList>lat lon\nlat lon...` — RdEdg と完全に同一の
//       geometry 構造（既定 namespace・prefix 無し）。posList の始点=終点で、実データは既に閉じたリング
//       として提供されている（実測確認・§9 の closed 判定は追加の修復無しでそのまま機能する）。
//       GSI 仕様上、これは「屋根の外周線」（roof outer line）であり、地上投影の建物形状そのものではない
//       （庇等により実際の壁面位置と数十cm〜数m差があり得る・§13/§20）。
//     - 実属性（[FIX21実測] RdEdg と共通ではない部分がある。正直に記録）:
//       fid・lfSpanFr（存続期間開始・nested timePosition。RdEdgには無い属性）・devDate（nested
//       timePosition）・orgGILvl（500/1000/2500等）・type（普通建物 等）。**vis / admCode / admOffice は
//       実データのBldLには出現しなかった**（RdEdgにはあった。§2の公開資料ベースの想定が一部外れていた
//       ため修正・null になるだけでクラッシュはしない）。
//   本ファイルは RdEdg 用パーサの構造をそのまま踏襲（同一 schema family のため）。
import fs from 'node:fs';

const KNOWN_FGD_TYPES = ['AdmArea', 'AdmBdry', 'AdmPt', 'BldA', 'BldL', 'Cntr', 'CommBdry', 'CommPt', 'Cstline',
  'ElevPt', 'GCP', 'RailCL', 'RdCompt', 'RdEdg', 'RdASL', 'WA', 'WL', 'WStrA', 'WStrL', 'SBAPt', 'SBArea', 'GCS'];

function extractBlocks(xml, localName) {
  const re = new RegExp('<(?:[\\w.]+:)?' + localName + '\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.]+:)?' + localName + '>', 'g');
  return xml.match(re) || [];
}
function extractAttr(block, attrName) {
  const m = block.match(new RegExp(attrName + '="([^"]*)"'));
  return m ? m[1] : null;
}
function extractText(block, localName) {
  const m = block.match(new RegExp('<(?:[\\w.]+:)?' + localName + '\\b[^>]*>([^<]*)<\\/(?:[\\w.]+:)?' + localName + '>'));
  return m ? m[1].trim() : null;
}
function extractNestedTimePosition(block, localName) {
  const m = block.match(new RegExp('<(?:[\\w.]+:)?' + localName + '\\b[^>]*>[\\s\\S]*?<(?:[\\w.]+:)?timePosition\\b[^>]*>([^<]*)<\\/(?:[\\w.]+:)?timePosition>[\\s\\S]*?<\\/(?:[\\w.]+:)?' + localName + '>'));
  return m ? m[1].trim() : extractText(block, localName);
}

/** 文書全体の既定 CRS（boundedBy 等の srsName）を推定。 */
export function detectDocumentCrs(xml) {
  const m = xml.match(/srsName="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * XML 文字列から BldL（建築物の外周線）feature を抽出する。
 * §2: BldA（建築物ポリゴン）が同一ファイルに含まれる場合はカウントのみ report する（本パーサでは
 *     geometry を取り込まない＝ミッションが指定する「建築物の外周線」に厳密に従う）。
 * @returns {{ features: Array<{ id, srsName, posListRaw, coordsCount, attrs }>, bldaCount: number, otherFeatureTypes: string[] }}
 */
export function parseBuildingOutlineGml(xml) {
  const features = [];

  const otherFeatureTypes = KNOWN_FGD_TYPES.filter((t) => t !== 'BldL' && (xml.includes('<' + t + ' ') || xml.includes('<' + t + '>')));
  const bldaCount = (xml.match(/<BldA\b/g) || []).length;

  const blocks = extractBlocks(xml, 'BldL');
  for (const block of blocks) {
    const id = extractAttr(block, 'gml:id') || extractAttr(block, 'id');
    const curveSrs = extractAttr(block, 'srsName');
    const posListMatches = [...block.matchAll(/<(?:[\w.]+:)?posList\b[^>]*>([^<]*)<\/(?:[\w.]+:)?posList>/g)];
    const posListRaw = posListMatches.map((m) => m[1].trim()).filter(Boolean);
    const coordsCount = posListRaw.reduce((n, s) => n + (s.split(/\s+/).filter(Boolean).length / 2), 0);
    const attrs = {
      type: extractText(block, 'type'),
      lfSpanFr: extractNestedTimePosition(block, 'lfSpanFr'),   // [FIX21実測] 存続期間開始。RdEdgには無くBldLに実在する属性
      devDate: extractNestedTimePosition(block, 'devDate'),
      orgGILvl: extractText(block, 'orgGILvl'),
      orgMDId: extractText(block, 'orgMDId'),
      vis: extractText(block, 'vis'),
      admCode: extractText(block, 'admCode'),
      admOffice: extractText(block, 'admOffice'),
    };
    features.push({ id, srsName: curveSrs, posListRaw, coordsCount, attrs });
  }

  return { features, bldaCount, otherFeatureTypes };
}

/**
 * posList の文字列（"v1 v2 v3 v4 ..."）を [ [a,b], [a,b], ... ] へ分解する（2軸のみ）。
 * gsi-road-edge-gml.js の posListToPairs と同一仕様（常に [lat, lon] へ正規化）。
 */
export function posListToPairs(posListRaw, axisOrder) {
  const nums = posListRaw.split(/\s+/).filter(Boolean).map(Number);
  const pairs = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const a = nums[i], b = nums[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    pairs.push(axisOrder === 'lon-lat' ? [b, a] : [a, b]);
  }
  return pairs;
}

/** GML/XML ファイルを読み parseBuildingOutlineGml へ渡す。 */
export function parseBuildingOutlineGmlFile(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const docCrs = detectDocumentCrs(xml);
  const parsed = parseBuildingOutlineGml(xml);
  return { docCrs, ...parsed };
}
