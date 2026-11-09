// Mission 36L — Google Places UI Kit Essentials integration (dev preview only).
// COST LOCK: Never load Google Maps JS or instantiate billable UI without an
// explicit deployment-time owner approval and a separately enforced usage cap.
// This file ships with the gate closed. Do not put an unrestricted key in source.
(() => {
  'use strict';
  const ENABLED = false; // owner approval + server-side budget guard required
  const HOST_ID = 'pc-places-ui-kit-36l';
  let lastPlaceId = null;
  let calls = 0;
  let activePlaceId = null;

  function host() {
    const card = document.getElementById('prop-card');
    if (!card) return null;
    let el = document.getElementById(HOST_ID);
    if (!el) {
      el = document.createElement('section');
      el.id = HOST_ID;
      el.style.cssText = 'display:none;margin-top:12px;padding-top:10px;border-top:1px solid rgba(130,170,220,.24)';
      const existing = document.getElementById('pc-photo-section');
      if (existing?.parentNode === card) existing.insertAdjacentElement('afterend', el);
      else card.appendChild(el);
    }
    return el;
  }

  async function show(event) {
    const id = event?.detail?.googlePlaceId;
    if (typeof id !== 'string' || !/^[-_A-Za-z0-9]{8,256}$/.test(id)) {
      lastPlaceId = null;
      activePlaceId = null;
      const old = document.getElementById(HOST_ID);
      if (old) { old.style.display = 'none'; old.replaceChildren(); }
      return;
    }
    lastPlaceId = id;
    activePlaceId = null;
    const el = host();
    if (!el) return;
    el.replaceChildren();
    el.style.display = '';
    const heading = document.createElement('div');
    heading.textContent = 'Google Places 写真・施設情報';
    heading.style.cssText = 'font-size:12px;font-weight:700;margin-bottom:7px';
    el.appendChild(heading);
    if (!ENABLED) {
      const note = document.createElement('div');
      note.textContent = '準備中：料金上限と利用承認の設定が完了するまでGoogleへの通信は行いません。';
      note.style.cssText = 'font-size:11px;line-height:1.6;opacity:.78';
      el.appendChild(note);
      return;
    }

    // UI Kit may only be activated after a separate audited usage gate exists.
    // A browser counter is not a hard monetary cap; never rely on it as one.
    const key = String(window.LIVECITY_CONFIG?.googlePlacesApiKey || '').trim();
    if (!key || !window.LIVECITY_CONFIG?.placesUiKitServerBudgetGuardVerified) {
      throw new Error('UI Kit requires an approved, enforced billing gate');
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Googleの写真・施設情報を表示';
    button.addEventListener('click', async () => {
      if (activePlaceId === id) return;
      // Gate must be checked by a trusted server before any billable request.
      // No implementation is supplied yet: fail closed until reviewed.
      throw new Error('Server authorization endpoint not configured');
    });
    el.appendChild(button);
  }

  window.addEventListener('livecity:verified-google-place', (event) => {
    show(event).catch((error) => console.warn('[Mission 36L UI Kit]', error));
  });
  window.__MISSION36L_UI_KIT__ = () => ({
    enabled: ENABLED, lastPlaceId, billableRequests: calls, mode: 'staged-locked'
  });
})();
