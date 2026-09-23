// tools/lib/gsi-building-area-gml.js
// [Mission 32B §2] 基盤地図情報 JPGIS(GML) の「建築物」(BldA) を正規表現ベースで抽出する。
//   §2で実ファイルから確認した構造（mesh 523514・FG-GML-523514-BldA-20260401-0001.xml、実測）:
//     <BldA gml:id="K17_..."><fid>...</fid><lfSpanFr>...</lfSpanFr><devDate>...</devDate>
//     <orgGILvl>500</orgGILvl>
//     <area><gml:Surface srsName="fguuid:jgd2024.bl"><gml:patches><gml:PolygonPatch>
//       <gml:exterior><gml:Ring><gml:curveMember><gml:Curve><gml:segments>
//         <gml:LineStringSegment><gml:posList>lat lon lat lon...</gml:posList>
//       </gml:LineStringSegment></gml:segments></gml:Curve></gml:curveMember></gml:Ring></gml:exterior>
//       <gml:interior>...</gml:interior>  ※ 0個以上（中庭等の穴）
//     </gml:PolygonPatch></gml:patches></gml:Surface></area></BldA>
//   BldL（tools/lib/gsi-building-outline-gml.js）と同じ既定namespace・prefix無しのGMLファミリー。
//   BldAは「建物の面」(Polygon)であり、BldLの「外周線」よりも直接的な footprint polygon候補
//   （§3優先度1: GSI building polygon）。§0遵守: 座標の加工（simplify/buffer等）は一切しない。
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
function extractSinglePosList(block) {
  // exterior/interior 1リング内には posList が1つだけ出現する想定（実データ確認済み）。
  const m = block.match(/<(?:[\w.]+:)?posList\b[^>]*>([^<]*)<\/(?:[\w.]+:)?posList>/);
  return m ? m[1].trim() : null;
}

export function detectDocumentCrs(xml) {
  const m = xml.match(/srsName="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * XML文字列からBldA(建築物ポリゴン)featureを抽出する。
 * @returns {{ features: Array<{id, srsName, exteriorPosList, interiorPosLists, attrs}>, otherFeatureTypes: string[] }}
 */
export function parseBuildingAreaGml(xml) {
  const features = [];
  const otherFeatureTypes = KNOWN_FGD_TYPES.filter((t) => t !== 'BldA' && (xml.includes('<' + t + ' ') || xml.includes('<' + t + '>')));

  const blocks = extractBlocks(xml, 'BldA');
  for (const block of blocks) {
    const id = extractAttr(block, 'gml:id') || extractAttr(block, 'id');
    const srsName = extractAttr(block, 'srsName'); // Surface要素のsrsName属性（block内のどこかにある想定でそのまま拾う）

    const extMatch = block.match(/<(?:[\w.]+:)?exterior\b[^>]*>[\s\S]*?<\/(?:[\w.]+:)?exterior>/);
    const exteriorPosList = extMatch ? extractSinglePosList(extMatch[0]) : null;
    if (!exteriorPosList) continue; // exterior無し(壊れたfeature)はスキップ・正直にcountして呼び出し側で報告

    const interiorBlocks = extractBlocks(block, 'interior');
    const interiorPosLists = interiorBlocks.map(extractSinglePosList).filter(Boolean);

    const attrs = {
      lfSpanFr: extractNestedTimePosition(block, 'lfSpanFr'),
      devDate: extractNestedTimePosition(block, 'devDate'),
      orgGILvl: extractText(block, 'orgGILvl'),
      orgMDId: extractText(block, 'orgMDId'),
    };
    features.push({ id, srsName, exteriorPosList, interiorPosLists, attrs });
  }
  return { features, otherFeatureTypes, blockCount: blocks.length };
}

/** posListの文字列("v1 v2 v3 v4 ...")を[[a,b],[a,b],...]へ分解する（2軸のみ・常に[lat,lon]へ正規化）。 */
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

export function parseBuildingAreaGmlFile(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const docCrs = detectDocumentCrs(xml);
  const parsed = parseBuildingAreaGml(xml);
  return { docCrs, ...parsed };
}
