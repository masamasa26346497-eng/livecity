/*
 * Mission 37E — Google Places UI Kit 写真表示の共通モジュール（課金ロック維持）
 * ============================================================================
 * このファイルは **Google へ課金対象の通信を一切行わない**。
 *   - Maps JavaScript API を読み込まない（script タグを作らない）
 *   - google.maps.importLibrary を呼ばない
 *   - <gmp-place-details> を生成・DOM 挿入しない（ENABLED=false の間は throw する）
 *   - Google のどのエンドポイントにも fetch しない
 * 読み込むのは同一オリジンの照合索引 JSON だけ。
 *
 * なぜ「要素を作ること自体」を止めるのか:
 *   Google 公式ドキュメントに
 *     "Places UI Kit queries are billed per component instantiation,
 *      not based on the Places API data included in the response."
 *   とある。つまり **コンポーネントを 1 つ生成するたびに課金される**。
 *   「生成だけして表示しない」「レスポンスを使わない」では課金を避けられない。
 *   よって ENABLED=false の間は生成経路そのものを塞ぐ。
 *
 * 24 区への横展開:
 *   このモジュールは地区固有の文字列・座標・DOM を一切持たない。
 *   索引 URL と描画先コンテナを外から渡すだけで、どの区でもそのまま使える。
 *
 * 公式ドキュメント（2026-10-11 に参照して実値を確認。憶測なし）:
 *   - 要素とタグ   https://developers.google.com/maps/documentation/javascript/places-ui-kit/place-details
 *   - 子要素の属性 https://developers.google.com/maps/documentation/javascript/reference/place-widget-child-elements
 *   - SKU/課金     https://developers.google.com/maps/documentation/javascript/places-ui-kit/overview
 *   - 価格         https://developers.google.com/maps/billing-and-pricing/pricing
 *   - 表示ポリシー https://developers.google.com/maps/documentation/places/web-service/policies
 */
/*
 * 読み込み形式: 素の <script src> で読むクラシックスクリプト。
 *   このリポジトリの package.json は "type": "module" なので、.js を require() すると
 *   ESM 扱いになり module.exports が使えない（tests/mission37b-cesium-poc.test.js が
 *   同じ理由で動かない）。そのため CommonJS の export は持たず、グローバルに 1 つだけ公開する。
 *   オフラインテストは node:vm でこのファイルを評価して同じ値を取る。
 */
(function (root, factory) {
  'use strict';
  root.LiveCityPlacesUiKit37E = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // 課金ロック。ここを true にするだけでは有効化しない（下の ACTIVATION_BLOCKERS 参照）
  // ══════════════════════════════════════════════════════════════════════════
  const ENABLED = false;

  /** 公式ドキュメントから転記した実値。推定値は入れない。 */
  const BILLING = Object.freeze({
    verifiedOn: '2026-10-11',
    element: 'AdvancedPlaceDetailsElement (<gmp-place-details>)',
    sku: 'Places UI Kit Pro',
    skuId: '42AB-1FB3-B56A',
    pricePer1000Usd: 5.00,
    freeMonthlyEvents: 5000,
    billingTrigger: 'per component instantiation',
    billingTriggerQuote:
      'Places UI Kit queries are billed per component instantiation, not based on the Places API data included in the response.',
    docs: Object.freeze({
      placeDetails: 'https://developers.google.com/maps/documentation/javascript/places-ui-kit/place-details',
      childElements: 'https://developers.google.com/maps/documentation/javascript/reference/place-widget-child-elements',
      overview: 'https://developers.google.com/maps/documentation/javascript/places-ui-kit/overview',
      pricing: 'https://developers.google.com/maps/billing-and-pricing/pricing',
      policies: 'https://developers.google.com/maps/documentation/places/web-service/policies',
    }),
  });

  /** 非 Google 地図（Cesium）との併用条件。公式ポリシーからの転記。 */
  const DISPLAY_POLICY = Object.freeze({
    allowedBesideNonGoogleMap: true,
    quoteUiKit: 'for the first time, you can use Places content on a non-Google map',
    quoteOnMap: 'Places API results displayed on a map must be shown on a Google Map, with proper attribution.',
    quoteOffMap: 'When displaying Places API data without a Google Map, you must include the Google logo, adhering to the provided style guidelines.',
    quotePhotoAuthor: 'You must always credit the author when displaying photos or reviews.',
    // 結論: 写真を「サイドパネル」に出すのは可。ただし Google ロゴの表示が必須。
    //       Cesium の地図上にピン等として Places の結果を描くのは不可。
    googleLogoRequired: true,
    mustNotPlotOnNonGoogleMap: true,
  });

  /** 有効化前に潰すべき項目。空にならない限り activate しない。 */
  const ACTIVATION_BLOCKERS = Object.freeze([
    '100円で確実に止まる仕組みが未検証（予算アラートは事後通知で、上限保証ではない）',
    'Google ロゴの表示が未実装（非 Google 地図でのポリシー必須要件）',
    '写真の作者クレジット表示の実装・確認が未了',
    'API キーの保管方法と配信方法が未決定（ソースに書かない）',
    'オーナーの明示的な再承認が未取得',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // 照合キー
  // ══════════════════════════════════════════════════════════════════════════
  // 実データで確認した対応（2026-10-11）:
  //   索引キー   : 'cg_bldg_' + 建物 id   例 'cg_bldg_bldg_000a2259-…' / 'cg_bldg_osm_…'
  //   canonicalId: 建物 id そのもの        例 'bldg_000a2259-…'
  // Issue #26 には「'cg_' + canonicalId」とあるが、それでは 14,112 件中 0 件しか当たらない
  // （'cg_bldg_' + canonicalId なら住吉区の表示建物 10,546 件中 271 件が当たる）。
  const INDEX_KEY_PREFIX = 'cg_bldg_';

  function toPlaceIndexKey(canonicalId) {
    if (typeof canonicalId !== 'string' || !canonicalId) return null;
    // 既に完全な canonical キーで渡された場合は二重接頭を付けない
    if (canonicalId.startsWith(INDEX_KEY_PREFIX)) return canonicalId;
    return INDEX_KEY_PREFIX + canonicalId;
  }

  /** この索引の Place ID は全件 ChIJ 始まり（14,112/14,112 で確認済み）。 */
  function isValidPlaceId(id) {
    return typeof id === 'string' && /^ChIJ[-_A-Za-z0-9]{8,}$/.test(id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UI Kit のマークアップ仕様（公式ドキュメントで確認した実値）
  //   生成はしない。「どう作るか」をデータとして持つだけなので、これ自体は無課金。
  // ══════════════════════════════════════════════════════════════════════════
  const MARKUP_SPEC = Object.freeze({
    container: 'gmp-place-details',
    compactContainer: 'gmp-place-details-compact',
    placeRequest: 'gmp-place-details-place-request',
    placeAttribute: 'place',
    contentConfig: 'gmp-place-content-config',
    // 写真表示に必要な最小構成。項目を増やしても課金は「生成回数」なので変わらないが、
    // 取得する情報は目的に必要な分だけにする。
    content: Object.freeze([
      Object.freeze({ tag: 'gmp-place-media', attributes: Object.freeze({ 'lightbox-preferred': '' }) }),
      Object.freeze({ tag: 'gmp-place-attribution', attributes: Object.freeze({}) }),
    ]),
    // 公式ローダーは v:"weekly"。alpha/beta チャンネルは不要（2026-10-11 時点）。
    // 有効化時は公式ローダーを v:'weekly' で読み、ライブラリ 'places' を取り込む。
    // ここには呼び出しコードを置かない（置くと「呼べてしまう」経路が残る）。
    loader: Object.freeze({ channel: 'weekly', library: 'places' }),
  });

  /**
   * 生成する DOM の形を「データ」として返す。DOM は作らないので無課金。
   * テストと目視レビューのためのもの。
   */
  function buildMarkupSpec(placeId, options) {
    if (!isValidPlaceId(placeId)) throw new TypeError('Invalid verified Place ID');
    const opts = options || {};
    const content = MARKUP_SPEC.content.map((c) => ({ tag: c.tag, attributes: Object.assign({}, c.attributes) }));
    if (opts.lightbox === false) delete content[0].attributes['lightbox-preferred'];
    if (opts.preferredSize) content[0].attributes['preferred-size'] = String(opts.preferredSize);
    return {
      tag: opts.compact ? MARKUP_SPEC.compactContainer : MARKUP_SPEC.container,
      children: [
        { tag: MARKUP_SPEC.placeRequest, attributes: { [MARKUP_SPEC.placeAttribute]: placeId } },
        { tag: MARKUP_SPEC.contentConfig, children: content },
      ],
      billableOnInstantiation: true,
    };
  }

  /**
   * 実際に <gmp-place-details> を生成する。**ENABLED=false の間は必ず throw する。**
   * 生成＝課金なので、ここが唯一の課金境界。
   */
  function createPlaceDetailsElement(documentRef, placeId, options) {
    if (!ENABLED) {
      const err = new Error(
        'Places UI Kit is disabled. Creating the element is itself a billable event ('
        + BILLING.sku + ', ' + BILLING.billingTrigger + '). Blockers: ' + ACTIVATION_BLOCKERS.length);
      err.code = 'E_BILLING_LOCKED';
      err.blockers = ACTIVATION_BLOCKERS.slice();
      throw err;
    }
    /* istanbul ignore next — 有効化されるまで到達しない */
    return materialize(documentRef, buildMarkupSpec(placeId, options));
  }

  /* 有効化後に使う純粋な spec→DOM 変換。ENABLED=false の間は呼ばれない。 */
  function materialize(documentRef, spec) {
    const el = documentRef.createElement(spec.tag);
    for (const [k, v] of Object.entries(spec.attributes || {})) el.setAttribute(k, v);
    for (const child of spec.children || []) el.appendChild(materialize(documentRef, child));
    return el;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PlacePhotoPanel — 建物選択 → 照合 → 表示 を受け持つ地区非依存のコントローラ
  // ══════════════════════════════════════════════════════════════════════════
  const DEFAULT_LABELS = Object.freeze({
    idle: 'Google施設情報は建物選択時に照合します（有料API通信なし）。',
    lookingUp: 'Google施設情報との照合中…',
    matched: 'Google施設情報：建物との照合済み',
    matchedNote: '写真表示は準備中です。課金制御が完了するまでGoogleへの通信は行いません。',
    unmatched: 'Google施設情報：確認済みの対応データなし',
    indexError: 'Google施設情報の照合データを読み込めませんでした。',
  });

  class PlacePhotoPanel {
    /**
     * @param {object} o
     * @param {string} o.indexUrl   同一オリジンの照合索引 JSON（区ごとに差し替え可能）
     * @param {Function} [o.fetchImpl]    テストから差し替え可能
     * @param {Document} [o.documentImpl] テストから差し替え可能
     * @param {Element}  [o.container]    描画先。無ければ状態だけ持つ
     * @param {object}   [o.labels]
     */
    constructor(o) {
      if (!o || typeof o.indexUrl !== 'string' || !o.indexUrl) throw new TypeError('indexUrl is required');
      if (/^https?:\/\//i.test(o.indexUrl)) throw new TypeError('indexUrl must be same-origin (relative)');
      this.indexUrl = o.indexUrl;
      this._fetch = o.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      this._doc = o.documentImpl || (typeof document !== 'undefined' ? document : null);
      this.container = o.container || null;
      this.labels = Object.assign({}, DEFAULT_LABELS, o.labels || {});
      this._seq = 0;             // 非同期競合: 最後の選択だけを採用する
      this._indexPromise = null;
      this.state = { status: 'idle', canonicalId: null, key: null, placeId: null };
    }

    /** 索引は 1 度だけ読む。失敗したら次の選択で再試行できるよう promise を捨てる。 */
    loadIndex() {
      if (!this._indexPromise) {
        if (!this._fetch) return Promise.reject(new Error('fetch unavailable'));
        this._indexPromise = this._fetch(this.indexUrl).then((r) => {
          if (!r || !r.ok) throw new Error('place index unavailable: ' + (r && r.status));
          return r.json();
        });
        this._indexPromise.catch(() => { this._indexPromise = null; });
      }
      return this._indexPromise;
    }

    /** 選択解除。進行中の照合結果は破棄される。 */
    clear() {
      this._seq++;
      this.state = { status: 'idle', canonicalId: null, key: null, placeId: null };
      this._render();
      return this.state;
    }

    /**
     * 建物選択。前の建物の Place ID と表示を必ず先に捨ててから照合する。
     * @returns {Promise<object>} 確定した state（古い選択なら status:'superseded'）
     */
    select(canonicalId) {
      const seq = ++this._seq;
      // 先に捨てる: 未照合の建物に前の建物の写真が残らないようにする
      this.state = { status: 'idle', canonicalId: null, key: null, placeId: null };
      if (!canonicalId) { this._render(); return Promise.resolve(this.state); }

      const key = toPlaceIndexKey(canonicalId);
      this.state = { status: 'looking-up', canonicalId, key, placeId: null };
      this._render();

      return this.loadIndex().then((index) => {
        if (seq !== this._seq) return { status: 'superseded', canonicalId, key, placeId: null };
        const byId = index && index.byBuildingId;
        const placeId = byId ? byId[key] : undefined;
        this.state = isValidPlaceId(placeId)
          ? { status: 'matched', canonicalId, key, placeId }
          : { status: 'unmatched', canonicalId, key, placeId: null };
        this._render();
        return this.state;
      }, () => {
        if (seq !== this._seq) return { status: 'superseded', canonicalId, key, placeId: null };
        this.state = { status: 'index-error', canonicalId, key, placeId: null };
        this._render();
        return this.state;
      });
    }

    /** 表示。textContent のみを使い、外部文字列を HTML として解釈しない。 */
    _render() {
      const c = this.container;
      if (!c || !this._doc) return;
      c.replaceChildren();
      delete c.dataset.googlePlaceId;
      const line = (text) => { const d = this._doc.createElement('div'); d.textContent = text; c.appendChild(d); };
      switch (this.state.status) {
        case 'idle': c.textContent = this.labels.idle; break;
        case 'looking-up': c.textContent = this.labels.lookingUp; break;
        case 'unmatched': c.textContent = this.labels.unmatched; break;
        case 'index-error': c.textContent = this.labels.indexError; break;
        case 'matched':
          line(this.labels.matched);
          line(this.labels.matchedNote);
          // Place ID は保持するだけ。UI Kit 要素は作らない（作ると課金される）。
          c.dataset.googlePlaceId = this.state.placeId;
          break;
      }
    }
  }

  /** オーナー承認用のチェックリストと見積もり。 */
  function describeActivation(plannedEvents) {
    const n = Number.isFinite(plannedEvents) ? plannedEvents : 100;
    const billable = Math.max(0, n - BILLING.freeMonthlyEvents);
    return {
      enabled: ENABLED,
      blockers: ACTIVATION_BLOCKERS.slice(),
      billing: BILLING,
      policy: DISPLAY_POLICY,
      estimate: {
        plannedEvents: n,
        freeMonthlyEvents: BILLING.freeMonthlyEvents,
        billableEvents: billable,
        estimatedUsd: +(billable * BILLING.pricePer1000Usd / 1000).toFixed(4),
        caveat: '無料枠は Google 側の請求設定に依存する。無料枠が適用されない場合は '
          + BILLING.pricePer1000Usd + ' USD / 1000 件で課金される。上限保証ではない。',
      },
    };
  }

  return Object.freeze({
    ENABLED,
    BILLING,
    DISPLAY_POLICY,
    ACTIVATION_BLOCKERS,
    MARKUP_SPEC,
    INDEX_KEY_PREFIX,
    toPlaceIndexKey,
    isValidPlaceId,
    buildMarkupSpec,
    createPlaceDetailsElement,
    PlacePhotoPanel,
    describeActivation,
    activationBlockedReason: ACTIVATION_BLOCKERS[0],
  });
});
