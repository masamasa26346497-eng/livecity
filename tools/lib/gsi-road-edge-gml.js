// tools/lib/gsi-road-edge-gml.js
// [Mission 31G-FIX15/FIX16] 基盤地図情報 JPGIS(GML) の道路縁 (RdEdg) を正規表現ベースで抽出する。
//   既存 tools/convert-plateau-tran.js と同じ方針（XML DOM ライブラリへ依存しない・regex ベース）。
//
//   [FIX16] 実データ（FG-GML-*-ALL-*.zip、大阪市域 5 メッシュ）で構造を確認・修正済み:
//     - 既定 namespace（xmlns="http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema"）でタグに prefix が付かない
//       （<RdEdg>, <loc>, <type> 等。fgd: prefix ではない）。既存 regex（prefix 任意）はそのまま動作する。
//     - <Dataset><RdEdg gml:id="..."><fid>..</fid><lfSpanFr>..</lfSpanFr><devDate>..</devDate>
//       <orgGILvl>2500</orgGILvl><vis>表示</vis><loc><gml:Curve srsName="fguuid:jgd2024.bl">
//       <gml:segments><gml:LineStringSegment><gml:posList>lat lon\r\nlat lon...</gml:posList>
//       </gml:LineStringSegment></gml:segments></gml:Curve></loc><type>庭園路等</type>
//       <admOffice>不明</admOffice></RdEdg>...</Dataset>
//     - srsName は "fguuid:jgd2024.bl"（**JGD2024**。旧仕様書が想定していた jgd2000/jgd2011 ではない）。
//       axis order は B,L（緯度,経度）で従来想定通り。classifyCrs() で jgd2024 対応済み。
//     - <type> は codeSpace 参照ではなく人間可読な値がそのまま入る（例: "庭園路等"）。実際に出現する値の
//       分布は tools/import-gsi-road-edge.js の集計（typeCounts）で report する（§3/§21）。
//     - 1 ZIP（1 メッシュ）は feature type ごとに別ファイル（FG-GML-<mesh>-RdEdg-<date>-NNNN.xml 等）に
//       分割されている。同一ファイル内に他 feature type が混在することは基本無い
//       （§5 の「他 feature type 列挙」は importer 側で ZIP entry ファイル名から行う）。
//     - 23MB の RdEdg 1 ファイルで parse ~0.5s（25,859 features）。5 メッシュ合計 260MB でも数秒で完了する
//       実測値（regex ベースのままで性能上問題なし。ストリーミング書き換えは不要と判断）。
import fs from 'node:fs';

// 道路縁本体（RdEdg）のタグ名（namespace prefix は問わない）
const RDEDG_TAG = /RdEdg\b/;
// [FIX16] 実データで確認した既知の FGD feature type（ZIP entry ファイル名からの判定を優先するが、
//   単一 XML 内の混在チェック用に低コストな includes() ベースの補助検出でも使う）。
const KNOWN_FGD_TYPES = ['AdmArea', 'AdmBdry', 'AdmPt', 'BldA', 'BldL', 'Cntr', 'CommBdry', 'CommPt', 'Cstline',
  'ElevPt', 'GCP', 'RailCL', 'RdCompt', 'RdEdg', 'RdASL', 'WA', 'WL', 'WStrA', 'WStrL', 'SBAPt', 'SBArea', 'GCS'];

/** 汎用: 指定タグ名（接頭辞は任意）の要素ブロックを全て抜き出す。 */
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

/** 文書全体 or ローカル srsName（boundedBy 等）から既定 CRS を推定。 */
export function detectDocumentCrs(xml) {
  const m = xml.match(/srsName="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * XML 文字列から RdEdg（道路縁）feature を抽出する。
 * @returns {{ features: Array<{ id, srsName, posListRaw, coordsCount, attrs }>, otherFeatureTypes: string[] }}
 */
export function parseRoadEdgeGml(xml) {
  const features = [];

  // ── §5: 同一 XML 内に RdEdg 以外の feature type が混在していないか（低コストな includes チェック）──
  //   [FIX16] 実データは 1 ファイル=1 feature type だが、将来別配布形式で混在する可能性に備えて残す。
  const otherFeatureTypes = KNOWN_FGD_TYPES.filter((t) => t !== 'RdEdg' && (xml.includes('<' + t + ' ') || xml.includes('<' + t + '>')));

  const blocks = extractBlocks(xml, 'RdEdg');
  for (const block of blocks) {
    const id = extractAttr(block, 'gml:id') || extractAttr(block, 'id');
    const curveSrs = extractAttr(block, 'srsName');
    const posListMatches = [...block.matchAll(/<(?:[\w.]+:)?posList\b[^>]*>([^<]*)<\/(?:[\w.]+:)?posList>/g)];
    const posListRaw = posListMatches.map((m) => m[1].trim()).filter(Boolean);
    const coordsCount = posListRaw.reduce((n, s) => n + (s.split(/\s+/).filter(Boolean).length / 2), 0);
    const attrs = {
      type: extractText(block, 'type'),
      devDate: extractNestedTimePosition(block, 'devDate'),
      orgGILvl: extractText(block, 'orgGILvl'),
      orgMDId: extractText(block, 'orgMDId'),
      vis: extractText(block, 'vis'),
      admCode: extractText(block, 'admCode'),
      admOffice: extractText(block, 'admOffice'),
    };
    features.push({ id, srsName: curveSrs, posListRaw, coordsCount, attrs });
  }

  return { features, otherFeatureTypes };
}

// [FIX16] devDate 等は <devDate gml:id="..."><gml:timePosition>2026-03-10</gml:timePosition></devDate>
//   のようにネストされる（実データで確認）。extractText の単純な「直接テキスト」抽出では取れないため専用関数を用意。
function extractNestedTimePosition(block, localName) {
  const m = block.match(new RegExp('<(?:[\\w.]+:)?' + localName + '\\b[^>]*>[\\s\\S]*?<(?:[\\w.]+:)?timePosition\\b[^>]*>([^<]*)<\\/(?:[\\w.]+:)?timePosition>[\\s\\S]*?<\\/(?:[\\w.]+:)?' + localName + '>'));
  return m ? m[1].trim() : extractText(block, localName);
}

/**
 * posList の文字列（"v1 v2 v3 v4 ..."）を [ [a,b], [a,b], ... ] へ分解する（2軸のみ・alt は非対応）。
 * 軸順は呼び出し側（axisOrder: 'lat-lon' | 'lon-lat'）に従う。GSI JPGIS(BL) は通常 lat,lon（緯度,経度）。
 */
export function posListToPairs(posListRaw, axisOrder) {
  const nums = posListRaw.split(/\s+/).filter(Boolean).map(Number);
  const pairs = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const a = nums[i], b = nums[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    pairs.push(axisOrder === 'lon-lat' ? [b, a] : [a, b]);  // 常に [lat, lon] へ正規化
  }
  return pairs;
}

/** GML/XML ファイルを読み parseRoadEdgeGml へ渡す。 */
export function parseRoadEdgeGmlFile(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const docCrs = detectDocumentCrs(xml);
  const parsed = parseRoadEdgeGml(xml);
  return { docCrs, ...parsed };
}
