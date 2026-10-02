// Mission 36I dev-only UI coordinator.
// Loaded only by tools/preview.js when serving osaka_3d_buildings.ward-ux-v1.html.
// Keeps facility/building detail cards mutually exclusive and makes the large QA tuning panel collapsible.
(() => {
  'use strict';

  const FACILITY_CARD_ID = 'facility-card';
  const BUILDING_CARD_ID = 'prop-card';
  const TUNING_PANEL_ID = 'canonical-runtime-status';
  const STORAGE_KEY = 'livecity.dev.tuning-collapsed.v1';
  const TOGGLE_ID = 'livecity-dev-tuning-toggle';

  let arbitrationQueued = false;
  let cardsObserverInstalled = false;
  let tuningToggleInstalled = false;

  function isVisible(el) {
    if (!el || el.hidden) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function cardHasPhoto(card) {
    if (!card) return false;
    return [...card.querySelectorAll('img')].some((img) => {
      const src = String(img.currentSrc || img.getAttribute('src') || '').trim();
      if (!src || src.startsWith('data:image/svg')) return false;
      if (img.naturalWidth > 1 || img.naturalHeight > 1) return true;
      const rect = img.getBoundingClientRect();
      return rect.width > 16 && rect.height > 16;
    });
  }

  function hideCard(card) {
    if (!card || !isVisible(card)) return;
    card.style.display = 'none';
  }

  function arbitrateCards() {
    arbitrationQueued = false;
    const facility = document.getElementById(FACILITY_CARD_ID);
    const building = document.getElementById(BUILDING_CARD_ID);
    if (!facility || !building || !isVisible(facility) || !isVisible(building)) return;

    const facilityHasPhoto = cardHasPhoto(facility);
    const buildingHasPhoto = cardHasPhoto(building);

    // A photo is the strongest signal. If both/neither have one, the facility card wins the collision:
    // this duplicate-card state is caused by one facility interaction also reaching the building picker.
    if (buildingHasPhoto && !facilityHasPhoto) hideCard(facility);
    else hideCard(building);
  }

  function queueCardArbitration() {
    if (arbitrationQueued) return;
    arbitrationQueued = true;
    requestAnimationFrame(arbitrateCards);
  }

  function observeCards() {
    if (cardsObserverInstalled) return true;
    const facility = document.getElementById(FACILITY_CARD_ID);
    const building = document.getElementById(BUILDING_CARD_ID);
    if (!facility || !building) return false;

    const observer = new MutationObserver(queueCardArbitration);
    const options = { attributes: true, childList: true, subtree: true, attributeFilter: ['style', 'class', 'src'] };
    observer.observe(facility, options);
    observer.observe(building, options);

    // Image load completion can occur after the card DOM has already been created.
    document.addEventListener('load', (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && (facility.contains(target) || building.contains(target))) {
        queueCardArbitration();
      }
    }, true);

    cardsObserverInstalled = true;
    queueCardArbitration();
    return true;
  }

  function readCollapsedState() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; }
    catch { return false; }
  }

  function writeCollapsedState(collapsed) {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); }
    catch { /* localStorage may be unavailable; UI still works for this session. */ }
  }

  function installTuningPanelToggle() {
    if (tuningToggleInstalled) return true;
    const panel = document.getElementById(TUNING_PANEL_ID);
    if (!panel) return false;
    if (document.getElementById(TOGGLE_ID)) {
      tuningToggleInstalled = true;
      return true;
    }

    const button = document.createElement('button');
    button.id = TOGGLE_ID;
    button.type = 'button';
    button.setAttribute('aria-controls', TUNING_PANEL_ID);
    button.style.cssText = [
      'position:fixed', 'right:12px', 'top:50%', 'transform:translateY(-50%)', 'z-index:99999',
      'padding:7px 10px', 'border-radius:8px', 'border:1px solid rgba(90,170,255,.42)',
      'background:rgba(8,14,26,.92)', 'color:#d9e8ff', 'font:11px ui-monospace,Menlo,Consolas,monospace',
      'cursor:pointer', 'box-shadow:0 4px 16px rgba(0,0,0,.28)'
    ].join(';');

    let collapsed = readCollapsedState();
    const render = () => {
      panel.style.display = collapsed ? 'none' : '';
      button.textContent = collapsed ? '調整を表示' : '調整を隠す';
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.title = collapsed ? '開発用の調整パネルを表示' : '開発用の調整パネルを隠す';
    };

    button.addEventListener('click', () => {
      collapsed = !collapsed;
      writeCollapsedState(collapsed);
      render();
    });

    document.body.appendChild(button);
    tuningToggleInstalled = true;
    render();
    return true;
  }

  function bootstrap() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const cardsReady = observeCards();
      const tuningReady = installTuningPanelToggle();
      if ((cardsReady && tuningReady) || tries >= 120) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
