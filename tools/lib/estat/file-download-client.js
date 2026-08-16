// tools/lib/estat/file-download-client.js
// e-Statの「ファイル」形式統計表(CSV)を、生バイトのまま取得するクライアント。
//
// 【重要】レスポンスは必ず arrayBuffer() で受け取り、生バイト列のまま raw 領域へ保存する。
// fetch()のres.text()やres.json()のような文字列化を行う経路は一切使わない
// （文字列化した時点でNode.jsのデフォルトデコーダ(UTF-8)が不正バイト列をU+FFFDに
// 置換し、元のバイト情報が失われるため。これは実際にweb_fetch経由で発生した不可逆の
// データ損失と同じ問題であり、本クライアントはこの問題が原理的に起こらない設計にする）。
//
// 本クライアントは実際のネットワークアクセスを必要とするため、Claude Code環境では
// 実行できない(ホスト許可リストにより e-stat.go.jp への接続が拒否される)。
// ローカルPC・GitHub Actions・本番データ処理サーバーでの実行を想定する。
import crypto from 'crypto';

/**
 * 指定URLから生バイトを取得する。テキストへの変換は一切行わない。
 * @param {string} url
 * @returns {Promise<{buffer: Buffer, status: number, headers: Record<string,string>}>}
 */
export async function downloadRawBytes(url) {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer(); // 生バイトのまま受け取る(文字列化しない)
  const buffer = Buffer.from(arrayBuffer);

  const headers = {};
  for (const [key, value] of res.headers.entries()) {
    headers[key.toLowerCase()] = value;
  }

  return {
    buffer,
    status: res.status,
    ok: res.ok,
    headers,
  };
}

/**
 * BOM(バイトオーダーマーク)の有無を確認する。
 * @param {Buffer} buffer
 * @returns {{hasBom: boolean, bomType: string|null}}
 */
export function detectBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { hasBom: true, bomType: 'UTF-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { hasBom: true, bomType: 'UTF-16LE' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { hasBom: true, bomType: 'UTF-16BE' };
  }
  return { hasBom: false, bomType: null };
}

/**
 * HTTPレスポンスヘッダのContent-Typeからcharsetを抽出する。
 * @param {Record<string,string>} headers
 */
export function detectCharsetFromHeaders(headers) {
  const contentType = headers['content-type'] || '';
  const m = contentType.match(/charset=([^\s;]+)/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 生バイト列がUTF-8として厳密にデコードできるかを検証する。
 * Node.jsの TextDecoder は fatal:true を指定すると、不正なバイト列に対して
 * 例外を投げる(デフォルトのBuffer.toString('utf-8')は不正バイトを黙って置換するため、
 * 厳密な検証にはTextDecoderのfatalモードを使う必要がある)。
 * @param {Buffer} buffer
 * @returns {{ok: boolean, text: string|null, error: string|null}}
 */
export function tryStrictUtf8Decode(buffer) {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(buffer);
    return { ok: true, text, error: null };
  } catch (err) {
    return { ok: false, text: null, error: err.message };
  }
}

/**
 * 生バイト列がCP932として厳密にデコードできるかを検証する。
 * Node.js組み込みのTextDecoder('windows-31j', {fatal:true})を使う
 * (windows-31jはCP932と同一の文字集合のIANA名で、Node.jsのICUが直接サポートしている。
 * 外部パッケージを追加導入する必要はない)。fatal:trueにより、不正なバイト列があれば
 * 例外を投げる(errors="ignore"のような無条件の置換は行わない)。
 * @param {Buffer} buffer
 * @returns {{ok: boolean, text: string|null, error: string|null}}
 */
export function tryStrictCp932Decode(buffer) {
  const decoder = new TextDecoder('windows-31j', { fatal: true });
  try {
    const text = decoder.decode(buffer);
    return { ok: true, text, error: null };
  } catch {
    // 全体のデコードが失敗した場合のみ、不正バイトの位置を特定する。
    // CP932の2バイト文字の先頭バイトは 0x81-0x9F または 0xE0-0xFC の範囲にある
    // (JIS X 0208/Microsoft拡張の規定)。この情報を使い、1文字ずつ正しい長さ
    // (1バイトまたは2バイト)でデコードを試みることで、二分探索では区別できなかった
    // 「マルチバイト文字の境界をまたいだ失敗」と「実際に不正なバイト」を正しく区別する。
    function isDoubleByteLead(byte) {
      return (byte >= 0x81 && byte <= 0x9F) || (byte >= 0xE0 && byte <= 0xFC);
    }

    const invalidPositions = [];
    let pos = 0;
    while (pos < buffer.length) {
      const byte = buffer[pos];
      const charLen = isDoubleByteLead(byte) && pos + 1 < buffer.length ? 2 : 1;
      try {
        decoder.decode(buffer.subarray(pos, pos + charLen));
        pos += charLen;
      } catch {
        invalidPositions.push(pos);
        pos += 1; // 不正バイトを1つだけスキップして続行する(置換はしない)
      }
    }

    return {
      ok: invalidPositions.length === 0,
      text: null,
      error: invalidPositions.length > 0
        ? `${invalidPositions.length}件の不正バイト列が検出されました(位置: ${invalidPositions.slice(0, 20).join(', ')}${invalidPositions.length > 20 ? '...' : ''})。`
        : null,
    };
  }
}

/**
 * 生バイト列のエンコーディングを、推測ではなく次の順序で確定する。
 * 1. BOMの有無
 * 2. HTTPヘッダーのcharset
 * 3. UTF-8として厳密にデコードできるか
 * 4. CP932として厳密にデコードできるか
 * 5. 復号後に期待する日本語ヘッダー文字列が含まれるか
 * いずれの段階でも確証が得られない場合は、無理に決定せず失敗として返す
 * (errors="ignore"による無条件のフォールバックは行わない)。
 *
 * @param {Buffer} buffer
 * @param {Record<string,string>} headers HTTPレスポンスヘッダー
 * @param {string[]} expectedHeaderTokens 復号後に含まれているべき日本語文字列
 *   (例: ['市区町村コード', '一般世帯数'])。1つでも欠けていれば確証なしとする。
 * @returns {{encoding: string|null, text: string|null, ok: boolean, steps: object[]}}
 */
export function resolveEncoding(buffer, headers, expectedHeaderTokens) {
  const steps = [];

  const bom = detectBom(buffer);
  steps.push({ step: 'bom', result: bom });
  if (bom.hasBom && bom.bomType === 'UTF-8') {
    const withoutBom = buffer.subarray(3);
    const utf8Result = tryStrictUtf8Decode(withoutBom);
    if (utf8Result.ok && expectedHeaderTokens.every((t) => utf8Result.text.includes(t))) {
      return { encoding: 'UTF-8 (BOM)', text: utf8Result.text, ok: true, steps };
    }
  }

  const headerCharset = detectCharsetFromHeaders(headers);
  steps.push({ step: 'http-header-charset', result: headerCharset });
  if (headerCharset) {
    if (/^utf-?8$/i.test(headerCharset)) {
      const r = tryStrictUtf8Decode(buffer);
      if (r.ok && expectedHeaderTokens.every((t) => r.text.includes(t))) {
        return { encoding: 'UTF-8 (HTTPヘッダー指定)', text: r.text, ok: true, steps };
      }
    } else if (/^(cp932|shift[_-]?jis|sjis|windows-31j|x-sjis)$/i.test(headerCharset)) {
      const r = tryStrictCp932Decode(buffer);
      if (r.ok && expectedHeaderTokens.every((t) => r.text.includes(t))) {
        return { encoding: 'CP932 (HTTPヘッダー指定)', text: r.text, ok: true, steps };
      }
    }
  }

  const utf8Result = tryStrictUtf8Decode(buffer);
  steps.push({ step: 'strict-utf8', result: { ok: utf8Result.ok, error: utf8Result.error } });
  if (utf8Result.ok && expectedHeaderTokens.every((t) => utf8Result.text.includes(t))) {
    return { encoding: 'UTF-8 (厳密デコード成功)', text: utf8Result.text, ok: true, steps };
  }

  const cp932Result = tryStrictCp932Decode(buffer);
  steps.push({ step: 'strict-cp932', result: { ok: cp932Result.ok, error: cp932Result.error } });
  if (cp932Result.ok && expectedHeaderTokens.every((t) => cp932Result.text.includes(t))) {
    return { encoding: 'CP932 (厳密デコード成功)', text: cp932Result.text, ok: true, steps };
  }

  // どの段階でも確証が得られなかった。無理に決定せず失敗として返す。
  return { encoding: null, text: null, ok: false, steps };
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
