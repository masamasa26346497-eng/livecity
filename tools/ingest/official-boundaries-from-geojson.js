#!/usr/bin/env node
// tools/ingest/official-boundaries-from-geojson.js
// 実行: node tools/ingest/official-boundaries-from-geojson.js --area osaka-sumiyoshi --input <path-to-geojson> [--reference-date <YYYY-MM-DD>] [--license <license>] [--source-name <name>] [--provider <name>] [--retrieved-url <url>] [--retrieved-at <ISO日時>] [--source-filename <name>]
//
// e-Stat「国勢調査 小地域（町丁・字等）境界データ」のGeoJSON由来データから、
// 正式な町丁目境界マスタ(processed/{areaId}/boundaries/administrative-boundaries.json)を生成する。
// 入力ファイル自体は無加工のまま data/raw/{areaId}/boundaries/ に既に配置されている前提とする
// （本ツールは読み込むだけで、入力ファイルを書き換えない）。
//
// 【e-Statの属性仕様】（令和2年国勢調査 町丁・字等別境界データ データベース定義書に基づく）
// - KEY_CODE: 11桁のユニークコード。先頭5桁が市区町村コード、残り6桁が町丁字コード。
//   文字列のまま扱い、数値変換による先頭ゼロの欠落を防ぐ。
// - PREF_NAME: 都道府県名, CITY_NAME: 市区町村名, S_NAME: 町丁・字等名
// - 同一市区町村内に同一町丁字番号を持つ境域が複数存在する場合、重複フラグが付与される
//   （e-Stat仕様。本ツールは取り込み時にそのフラグの有無を検出し、複合キーが本当に
//   一意かどうかを検証する。推測で一方を採用せず、両方保持しつつ事実を記録する）。
//
// 【座標変換】GeoJSONの緯度経度をそのままThree.js座標として扱わない。既存の建物・道路・公園と
// 完全に同一の原点・縮尺・軸方向(tools/lib/projection.jsのconvertCoordsArray、既存のgeoToThree()
// と同一式)で変換する。新たな座標変換式は実装しない。
import { readFile } from 'fs/promises';
import path from 'path';
import { loadAreaConfig, writeJson } from '../lib/area.js';
import { normalizeChochoName } from '../lib/chocho-normalize.js';
import { convertCoordsArray } from '../lib/projection.js';
import { toProjectRelativePath } from '../lib/paths.js';

function parseArgs(argv) {
  const args = {
    area: null, input: null, license: 'CC BY 4.0', referenceDate: null,
    sourceName: '国勢調査町丁・字等別境界データ', provider: '総務省統計局（e-Stat） / 加工: 利用者',
    retrievedUrl: null, retrievedAt: null, sourceFilename: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--area') args.area = argv[++i];
    if (argv[i] === '--input') args.input = argv[++i];
    if (argv[i] === '--license') args.license = argv[++i];
    if (argv[i] === '--reference-date') args.referenceDate = argv[++i];
    if (argv[i] === '--source-name') args.sourceName = argv[++i];
    if (argv[i] === '--provider') args.provider = argv[++i];
    if (argv[i] === '--retrieved-url') args.retrievedUrl = argv[++i];
    if (argv[i] === '--retrieved-at') args.retrievedAt = argv[++i];
    if (argv[i] === '--source-filename') args.sourceFilename = argv[++i];
  }
  return args;
}

/**
 * KEY_CODE(9桁または11桁)を市区町村コード(先頭5桁)と町丁字コード(残り4桁または6桁)に分割する。
 * 【重要】文字列のまま処理し、parseInt等で数値化しない。数値化すると先頭ゼロが失われ、
 * "01101" のようなコードが "1101" になってしまい、複合キーの桁数が不安定になる。
 * 【9桁ケース】実際のGeoshapeデータで、丁目区分のない大字・字レベルの地名
 * (例: "長峡町"=271200070, "山之内元町"=271200260, "長居公園"=271210150)は
 * 9桁のKEY_CODEを持つことが確認されている。標準の11桁(5+6)とは異なり9桁(5+4)になるが、
 * いずれも先頭5桁は市区町村コードで共通のため、可変長として両対応する。
 */
function splitKeyCode(keyCode) {
  const s = String(keyCode).trim();
  if (/^\d{11}$/.test(s)) {
    return { municipalityCode: s.slice(0, 5), chochoCode: s.slice(5) };
  }
  if (/^\d{9}$/.test(s)) {
    return { municipalityCode: s.slice(0, 5), chochoCode: s.slice(5) };
  }
  throw new Error(`KEY_CODEは9桁または11桁の数字である必要があります。実際の値: "${s}" (${s.length}桁)`);
}

function extractWard(cityName) {
  const m = (cityName || '').match(/大阪市(.+区)$/);
  return m ? m[1] : null;
}

/**
 * GeoJSONのgeometryをThree.js座標系のリング配列(boundaryコードと同じ [[x,z],...] の配列の配列)
 * へ変換する。Polygon/MultiPolygonの両方に対応する。不正なgeometry(型不明、coordinates欠落、
 * 座標が数値でない等)は黙って空配列にせず、明確な例外として呼び出し側に伝える。
 */
function convertGeometryToRings(geometry, projection) {
  if (!geometry || typeof geometry !== 'object') {
    throw new Error('geometryが存在しません。');
  }
  const { type, coordinates } = geometry;
  if (!coordinates || !Array.isArray(coordinates)) {
    throw new Error(`geometry.coordinatesが配列ではありません(type: ${type})。`);
  }

  function convertRing(ring) {
    if (!Array.isArray(ring) || ring.length === 0) {
      throw new Error('リングが空、または配列ではありません。');
    }
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
        throw new Error(`座標点が不正です: ${JSON.stringify(pt)}`);
      }
      if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
        throw new Error(`座標点が有限値ではありません: ${JSON.stringify(pt)}`);
      }
    }
    return convertCoordsArray(ring, projection);
  }

  if (type === 'Point') {
    // 図形中心点のみ(ポリゴン形状が未取得のレコード)。1点だけのリングとして表現する。
    // 既存のTOWN_POLYGONS形式(リング配列)とは異質なデータであるため、呼び出し側で
    // hasFullPolygon: false として明示し、地図上のポリゴン描画には使わない前提とする。
    const pt = coordinates;
    if (!Array.isArray(pt) || pt.length < 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      throw new Error(`Point座標が不正です: ${JSON.stringify(pt)}`);
    }
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new Error(`Point座標が有限値ではありません: ${JSON.stringify(pt)}`);
    }
    return [convertCoordsArray([pt], projection)];
  }
  if (type === 'Polygon') {
    // Polygon.coordinates = [外周リング, 穴リング1, 穴リング2, ...]
    return coordinates.map(convertRing);
  }
  if (type === 'MultiPolygon') {
    // MultiPolygon.coordinates = [Polygon1のリング群, Polygon2のリング群, ...]
    // 既存のTOWN_POLYGONS形式(リングの配列)と互換にするため、全Polygonの外周・穴リングを
    // フラットに1つの配列へまとめる(複数ポリゴンを持つ町丁目=飛び地として扱う既存設計を踏襲)。
    const rings = [];
    for (const polygonCoords of coordinates) {
      for (const ring of polygonCoords) {
        rings.push(convertRing(ring));
      }
    }
    return rings;
  }
  throw new Error(`未対応のgeometry.type: "${type}" (Point/Polygon/MultiPolygonのみ対応)`);
}

async function main(args) {
  if (!args.area || !args.input) {
    throw new Error('使用法: node tools/ingest/official-boundaries-from-geojson.js --area <areaId> --input <path-to-geojson> [--reference-date <YYYY-MM-DD>] [--license <license>]');
  }

  console.log(`=== 正式境界データ取り込み: ${args.area} ===`);
  console.log(`入力: ${args.input}`);

  const areaConfig = await loadAreaConfig(args.area);
  const projection = areaConfig.projection;
  if (!projection) {
    throw new Error(`config/areas/${args.area}.json に projection 設定がありません。既存の座標変換式が取得できないため処理を中止します。`);
  }

  const raw = await readFile(args.input, 'utf-8');
  const geojson = JSON.parse(raw);
  if (!geojson.features || !Array.isArray(geojson.features)) {
    throw new Error('入力ファイルがGeoJSON FeatureCollection形式ではありません。');
  }

  const master = [];
  const compositeKeySeen = new Map();
  let skippedNoKeyCode = 0;
  let skippedInvalidGeometry = 0;
  const invalidGeometryDetails = [];

  for (const feature of geojson.features) {
    const props = feature.properties || {};
    const keyCode = props.KEY_CODE || props.key_code;
    if (!keyCode) {
      skippedNoKeyCode++;
      continue; // KEY_CODEが無い行(山林・湖沼等、町丁・大字名称を付与できない地域)はスキップする
    }

    let municipalityCode, chochoCode;
    try {
      ({ municipalityCode, chochoCode } = splitKeyCode(keyCode));
    } catch (err) {
      console.warn(`[WARN] KEY_CODE解析失敗、スキップ: ${err.message}`);
      skippedNoKeyCode++;
      continue;
    }

    let rings = null;
    let hasFullPolygon = false;
    if (feature.geometry == null) {
      // geometry未取得(今回の属性データ取得方式では大部分のレコードがこの状態)。
      // 「不正」ではなく「形状データが現時点で存在しない」という正当な状態として扱う。
      // 複合キーでの統計結合自体はポリゴン座標を必要としないため、レコード自体は
      // マスタへ含め、hasFullPolygon:falseで明示する(地図上のポリゴン描画には使えないことを示す)。
      rings = null;
      hasFullPolygon = false;
    } else {
      try {
        rings = convertGeometryToRings(feature.geometry, projection);
        hasFullPolygon = feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
      } catch (err) {
        // 不正なgeometryは黙ってスキップせず、件数・理由を記録した上でスキップする
        // （取り込み自体を中断しない。1件の不正データが全体の取り込みを止めないようにする）。
        skippedInvalidGeometry++;
        invalidGeometryDetails.push({ keyCode, reason: err.message });
        console.warn(`[WARN] geometry不正、スキップ (KEY_CODE=${keyCode}): ${err.message}`);
        continue;
      }
    }

    const chochoName = props.S_NAME || props.s_name || '';
    const cityName = props.CITY_NAME || props.city_name || '';
    const prefName = props.PREF_NAME || props.pref_name || '';
    const ward = extractWard(cityName);
    const originalFullName = `${ward || cityName}${chochoName}`;

    const compositeCode = `${municipalityCode}:${chochoCode}`; // 桁数を保持した文字列の複合キー
    compositeKeySeen.set(compositeCode, (compositeKeySeen.get(compositeCode) || 0) + 1);

    master.push({
      municipalityCode, // 文字列のまま保持(先頭ゼロを失わない)
      chochoCode, // 文字列のまま保持(先頭ゼロを失わない)
      compositeCode,
      prefectureName: prefName,
      municipalityName: cityName,
      ward,
      chochoName,
      originalFullName,
      normalizedChochoName: normalizeChochoName(chochoName),
      boundaryId: originalFullName, // 既存の暫定マスタ(boundaryId形式)・TOWN_POLYGONSキーとの互換性を保つ
      geometry: rings, // Three.js座標系のリング配列(既存TOWN_POLYGONS形式と同一構造)。nullの場合は未取得。
      hasFullPolygon, // true: ポリゴン形状を保持(地図描画に使用可能)。false: 中心点のみ、または形状自体が未取得。
      source: args.sourceName,
      provider: args.provider,
      retrievedUrl: args.retrievedUrl,
      retrievedAt: args.retrievedAt,
      sourceFilename: args.sourceFilename,
      referenceDate: args.referenceDate,
      license: args.license,
      // 【重要】属性データ(コード・名称・人口・世帯数)自体は常に公式出典(Geoshapeリポジトリ/e-Stat)
      // に基づくため officialAttributes は常に true。一方 officialBoundary は、実際に有効な
      // Polygon/MultiPolygon形状を保持している場合のみ true とする(hasFullPolygonと完全に連動)。
      // 属性データの公式性と境界形状の公式性は別の軸であり、片方の真偽が他方の値を決めることはない。
      officialAttributes: true,
      officialBoundary: hasFullPolygon,
      boundaryDataStatus: hasFullPolygon ? 'official' : 'official-attributes-only',
      boundarySourceType: 'official-estat-boundaries',
      duplicateKeyCode: false, // 後段で更新
      displayStatus: 'in-current-render-area', // 後段で対象地域外と判定された場合に上書きする
    });
  }

  // 重複していた複合キーにフラグを立てる(削除も自動結合もしない、事実の記録のみ)
  let duplicateCount = 0;
  for (const entry of master) {
    if (compositeKeySeen.get(entry.compositeCode) > 1) {
      entry.duplicateKeyCode = true;
      duplicateCount++;
    }
  }

  // data/raw(無加工の入力)とは別に、変換済みマスタはdata/processedへ保存する
  const outputPath = path.resolve(process.cwd(), 'data', 'processed', args.area, 'boundaries', 'administrative-boundaries.json');
  await writeJson(outputPath, master);

  console.log(`取り込み件数: ${master.length}`);
  console.log(`KEY_CODE無しでスキップ: ${skippedNoKeyCode}件`);
  console.log(`不正geometryでスキップ: ${skippedInvalidGeometry}件`);
  console.log(`複合キー重複(e-Stat仕様による重複フラグ対象): ${duplicateCount}件`);
  console.log(`保存先: ${toProjectRelativePath(outputPath)}`);
  if (duplicateCount > 0) {
    console.warn(`[WARN] 複合キーが重複する町丁目があります。該当地域は手動確認を推奨します。`);
  }
  if (skippedInvalidGeometry > 0) {
    console.warn(`[WARN] 不正なgeometryを持つfeatureがありました:`, invalidGeometryDetails);
  }

  return { recordCount: master.length, skippedNoKeyCode, skippedInvalidGeometry, duplicateCount, invalidGeometryDetails };
}

const args = parseArgs(process.argv.slice(2));
main(args).catch((err) => {
  console.error('予期しないエラー:', err);
  process.exit(1);
});
