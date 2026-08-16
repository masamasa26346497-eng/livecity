// tools/lib/citygml.js
// PLATEAU建築物 CityGML の軽量パーサ（依存ゼロ・ストリーム非依存の正規表現ベース）。
//
// 方針:
//  - LiveCityは外部依存を最小化する方針のため、重量なXML DOMパーサは導入しない。
//  - ここでは「監査(件数集計)」「gml:id抽出」「LOD2面のposList抽出」に必要な範囲だけを
//    正規表現で堅牢に取り出す。名前空間接頭辞(bldg:, gml:, app:)は揺れがあるため
//    接頭辞非依存（`(?:\w+:)?`）でマッチする。
//  - CityGML 2.0 / PLATEAU製品仕様V2〜V4 で使われる要素名に対応:
//      建物: Building / lod1Solid / lod2Solid / lod2MultiSurface / lod3Solid / lod3MultiSurface
//      境界面: boundedBy > RoofSurface / WallSurface / GroundSurface / OuterCeilingSurface 等
//      幾何: gml:posList（緯度 経度 標高 の並び。PLATEAUは EPSG:6697 = 緯度経度+標高）
//      外観: app:appearance / app:ParameterizedTexture / app:imageURI
//
// 注意: 本パーサは「監査とID照合とposList抽出」に十分な精度を持つが、完全なCityGML
//       ジオメトリ組み立て(Solid/CompositeSurfaceの入れ子解決)は行わない。GLB生成本実装時に
//       必要なら別途強化する（今回の骨格レポートには posList 単位の集計で足りる）。

/**
 * 建物単位でXMLを分割する。<bldg:Building ...> ... </bldg:Building> を1件とする。
 * @param {string} xml
 * @returns {string[]} 各建物のXML断片
 */
export function splitBuildings(xml) {
  const out = [];
  const re = /<(?:\w+:)?Building\b[\s\S]*?<\/(?:\w+:)?Building>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}

/**
 * 建物断片から gml:id を取得する。Building要素自身の gml:id を優先。
 * @param {string} bldgXml
 * @returns {string|null}
 */
export function extractBuildingId(bldgXml) {
  // <bldg:Building gml:id="bldg_xxxx" ...>
  const m = bldgXml.match(/<(?:\w+:)?Building\b[^>]*?\bgml:id="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * 各種LOD保有フラグと境界面数を数える。
 * @param {string} bldgXml
 */
export function analyzeBuilding(bldgXml) {
  const has = (re) => re.test(bldgXml);
  const count = (re) => (bldgXml.match(re) || []).length;
  return {
    id: extractBuildingId(bldgXml),
    hasLod1Solid: has(/<(?:\w+:)?lod1Solid\b/),
    hasLod1MultiSurface: has(/<(?:\w+:)?lod1MultiSurface\b/),
    hasLod2Solid: has(/<(?:\w+:)?lod2Solid\b/),
    hasLod2MultiSurface: has(/<(?:\w+:)?lod2MultiSurface\b/),
    hasLod3Solid: has(/<(?:\w+:)?lod3Solid\b/),
    hasLod3MultiSurface: has(/<(?:\w+:)?lod3MultiSurface\b/),
    roofSurfaceCount: count(/<(?:\w+:)?RoofSurface\b/g),
    wallSurfaceCount: count(/<(?:\w+:)?WallSurface\b/g),
    groundSurfaceCount: count(/<(?:\w+:)?GroundSurface\b/g),
    boundedByCount: count(/<(?:\w+:)?boundedBy\b/g),
    // 開口部(将来のLOD3確認用)
    openingCount: count(/<(?:\w+:)?(?:Window|Door)\b/g),
    posListCount: count(/<(?:\w+:)?posList\b/g),
  };
}

/**
 * ファイル全体を監査する。ご指示4の集計項目を返す。
 * @param {string} xml CityGML全文
 */
export function auditCityGml(xml) {
  const buildings = splitBuildings(xml);
  const audit = {
    buildingCount: buildings.length,
    lod1SolidCount: 0,
    lod1MultiSurfaceCount: 0,
    lod2SolidCount: 0,
    lod2MultiSurfaceCount: 0,
    lod2AnyCount: 0, // lod2Solid か lod2MultiSurface のいずれかを持つ建物数
    lod3AnyCount: 0,
    roofSurfaceTotal: 0,
    wallSurfaceTotal: 0,
    groundSurfaceTotal: 0,
    boundedByTotal: 0,
    openingTotal: 0,
    buildingsWithNullId: 0,
  };
  for (const b of buildings) {
    const a = analyzeBuilding(b);
    if (a.hasLod1Solid) audit.lod1SolidCount++;
    if (a.hasLod1MultiSurface) audit.lod1MultiSurfaceCount++;
    if (a.hasLod2Solid) audit.lod2SolidCount++;
    if (a.hasLod2MultiSurface) audit.lod2MultiSurfaceCount++;
    if (a.hasLod2Solid || a.hasLod2MultiSurface) audit.lod2AnyCount++;
    if (a.hasLod3Solid || a.hasLod3MultiSurface) audit.lod3AnyCount++;
    audit.roofSurfaceTotal += a.roofSurfaceCount;
    audit.wallSurfaceTotal += a.wallSurfaceCount;
    audit.groundSurfaceTotal += a.groundSurfaceCount;
    audit.boundedByTotal += a.boundedByCount;
    audit.openingTotal += a.openingCount;
    if (!a.id) audit.buildingsWithNullId++;
  }

  // 外観(テクスチャ)はファイル全体で数える（appearanceMember配下に集約されることが多い）
  audit.appearancePresent = /<(?:\w+:)?appearance\b/.test(xml) || /<(?:\w+:)?Appearance\b/.test(xml);
  audit.parameterizedTextureCount = (xml.match(/<(?:\w+:)?ParameterizedTexture\b/g) || []).length;
  audit.imageUriCount = (xml.match(/<(?:\w+:)?imageURI\b/g) || []).length;

  return audit;
}

/**
 * 座標参照系(CRS)・軸順序・Envelopeを検出する。
 * 固定値で決めつけず、GMLの記述と実際の座標値の両方から推定する（ご指示対応）。
 *
 * PLATEAUは通常 srsName="http://www.opengis.net/def/crs/EPSG/0/6697"（JGD2011 地理座標+標高、
 * 軸順序= 緯度,経度,高さ）だが、年度・製品によっては平面直角座標系(EPSG:6669〜6687等)の
 * 場合もあり得るため、srsName の EPSGコードと、posList先頭値のレンジから軸順序・座標系種別を判定する。
 *
 * @param {string} xml CityGML全文
 * @returns {object}
 */
export function detectCoordinateSystem(xml) {
  // srsName（envelopeやposListの属性、boundedBy等に現れる。最初の出現を代表値とする）
  const srsNameMatch = xml.match(/srsName="([^"]+)"/);
  const srsName = srsNameMatch ? srsNameMatch[1] : null;
  // srsDimension
  const srsDimMatch = xml.match(/srsDimension="(\d+)"/);
  const srsDimension = srsDimMatch ? Number(srsDimMatch[1]) : null;
  // EPSGコード抽出（.../EPSG/0/6697 または EPSG:6697 の形）
  let epsgCode = null;
  if (srsName) {
    const m = srsName.match(/EPSG[/:](?:0\/)?(\d{4,5})/i);
    if (m) epsgCode = Number(m[1]);
  }

  // gml:Envelope の lowerCorner / upperCorner
  const lower = (xml.match(/<(?:\w+:)?lowerCorner>([^<]+)<\/(?:\w+:)?lowerCorner>/) || [])[1] || null;
  const upper = (xml.match(/<(?:\w+:)?upperCorner>([^<]+)<\/(?:\w+:)?upperCorner>/) || [])[1] || null;
  const parseCorner = (s) => (s ? s.trim().split(/\s+/).map(Number) : null);
  const lowerCorner = parseCorner(lower);
  const upperCorner = parseCorner(upper);

  // 座標の先頭サンプル（最初のposListの先頭3値）
  const posMatch = xml.match(/<(?:\w+:)?posList\b[^>]*>([\s\S]*?)<\/(?:\w+:)?posList>/);
  let firstCoordSample = null;
  if (posMatch) {
    const nums = posMatch[1].trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
    firstCoordSample = nums.slice(0, 6);
  }

  // 軸順序と座標系種別の推定（固定せず値のレンジから判定）
  // 地理座標(度): 概ね |値| <= 180、日本域は 緯度20〜46, 経度122〜154。
  // 平面直角座標系(m): 数十万〜数百万オーダー、または負の大きな値。
  let axisOrder = 'unknown';       // 'lat-lon' | 'lon-lat' | 'projected-xy'
  let crsKind = 'unknown';          // 'geographic' | 'projected'
  const sample = firstCoordSample || lowerCorner;
  if (sample && sample.length >= 2) {
    const a = sample[0], b = sample[1];
    const looksGeographic = Math.abs(a) <= 180 && Math.abs(b) <= 180;
    if (looksGeographic) {
      crsKind = 'geographic';
      // 日本域: 緯度は20〜46, 経度は122〜154。値がどちらのレンジに合うかで軸順序を判定。
      const aIsLat = a >= 20 && a <= 46;
      const aIsLon = a >= 122 && a <= 154;
      const bIsLat = b >= 20 && b <= 46;
      const bIsLon = b >= 122 && b <= 154;
      if (aIsLat && bIsLon) axisOrder = 'lat-lon';
      else if (aIsLon && bIsLat) axisOrder = 'lon-lat';
      else axisOrder = 'lat-lon-uncertain'; // 地理座標だが日本域の典型レンジで断定不可
    } else {
      crsKind = 'projected';
      axisOrder = 'projected-xy';
    }
  }

  // EPSGコードからの補助判定（記述と値が食い違う場合は両方を残し、決めつけない）
  let epsgKind = null;
  if (epsgCode != null) {
    // 6697 = JGD2011地理座標+標高(緯度経度), 6668=JGD2011地理2D。
    // 6669〜6687 = JGD2011平面直角座標系I〜XIX系。
    if (epsgCode === 6697 || epsgCode === 6668 || epsgCode === 4326) epsgKind = 'geographic';
    else if (epsgCode >= 6669 && epsgCode <= 6687) epsgKind = 'projected-plane-rectangular';
    else epsgKind = 'other';
  }

  return {
    srsName,
    srsDimension,
    epsgCode,
    epsgKind,                 // srsNameのEPSGコードから推定した座標系種別
    lowerCorner,
    upperCorner,
    firstCoordSample,         // 実座標の先頭サンプル（軸順序の実証用）
    detectedCrsKind: crsKind, // 実座標値から推定した種別
    detectedAxisOrder: axisOrder,
    isProjectedPlaneRectangular: epsgKind === 'projected-plane-rectangular' || crsKind === 'projected',
    // 記述(EPSG)と実値の推定が食い違う場合の警告フラグ（決めつけないための材料）
    epsgVsValueMismatch: (epsgKind && crsKind !== 'unknown') ? (epsgKind !== crsKind &&
      !(epsgKind === 'projected-plane-rectangular' && crsKind === 'projected')) : false,
  };
}

/**
 * 全建物の gml:id を配列で返す（ID照合用）。順序は出現順だが、照合は集合(Set)で行うこと。
 * @param {string} xml
 * @returns {string[]}
 */
export function extractAllBuildingIds(xml) {
  return splitBuildings(xml).map(extractBuildingId).filter(Boolean);
}

/**
 * ある境界面種別(RoofSurface/WallSurface/GroundSurface)の posList 群を抽出する。
 * 返り値は「面ごとの座標配列」。各座標は [lat, lon, height]（PLATEAU EPSG:6697の並び）。
 * @param {string} bldgXml 建物断片
 * @param {'Roof'|'Wall'|'Ground'} kind
 * @returns {number[][][]} surfaces[面][点][lat,lon,h]
 */
export function extractSurfacePosLists(bldgXml, kind) {
  const surfEl = `${kind}Surface`;
  const surfaces = [];
  const surfRe = new RegExp(`<(?:\\w+:)?${surfEl}\\b[\\s\\S]*?<\\/(?:\\w+:)?${surfEl}>`, 'g');
  let sm;
  while ((sm = surfRe.exec(bldgXml))) {
    const block = sm[0];
    const posRe = /<(?:\w+:)?posList\b[^>]*>([\s\S]*?)<\/(?:\w+:)?posList>/g;
    let pm;
    while ((pm = posRe.exec(block))) {
      const nums = pm[1].trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
      // 3次元(lat lon h)想定。srsDimension が2の場合もあるためスタガリングを判定。
      const dim = nums.length % 3 === 0 ? 3 : (nums.length % 2 === 0 ? 2 : 3);
      const pts = [];
      for (let i = 0; i + dim <= nums.length; i += dim) {
        if (dim === 3) pts.push([nums[i], nums[i + 1], nums[i + 2]]);
        else pts.push([nums[i], nums[i + 1], 0]);
      }
      if (pts.length >= 3) surfaces.push(pts);
    }
  }
  return surfaces;
}

/**
 * 建物のLOD2幾何から、三角形数の概算・境界(緯度経度範囲)・面数を集計する。
 * n角形ポリゴンは (n-2) 三角形として概算（穴は考慮しない骨格集計）。
 * @param {string} bldgXml
 */
export function summarizeBuildingGeometry(bldgXml) {
  const kinds = ['Roof', 'Wall', 'Ground'];
  let triangles = 0, surfaceCount = 0;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let hasCoords = false;
  for (const k of kinds) {
    const surfaces = extractSurfacePosLists(bldgXml, k);
    for (const poly of surfaces) {
      surfaceCount++;
      // 閉ポリゴン(先頭=末尾)なら実頂点は length-1
      const ring = (poly.length > 1 &&
        poly[0][0] === poly[poly.length - 1][0] &&
        poly[0][1] === poly[poly.length - 1][1]) ? poly.slice(0, -1) : poly;
      triangles += Math.max(0, ring.length - 2);
      for (const [lat, lon] of ring) {
        hasCoords = true;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      }
    }
  }
  return {
    id: extractBuildingId(bldgXml),
    surfaceCount,
    triangleCountApprox: triangles,
    bounds: hasCoords ? { minLat, maxLat, minLon, maxLon } : null,
  };
}
