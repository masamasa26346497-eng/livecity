// Mission 37E: UI Kit adapter. Zero Google network calls until explicit activation.
// This module creates Google's documented Place Details markup, but deliberately
// does NOT load Maps JavaScript, instantiate the element, or enable billing.
// Reference: https://developers.google.com/maps/documentation/javascript/places-ui-kit/place-details
(() => {
  'use strict';
  const ENABLED = false;
  function isValidPlaceId(id) { return typeof id === 'string' && /^ChIJ[-_A-Za-z0-9]{8,}$/.test(id); }
  function createPlaceDetails(placeId) {
    if (!isValidPlaceId(placeId)) throw new TypeError('Invalid verified Place ID');
    const details = document.createElement('gmp-place-details');
    const request = document.createElement('gmp-place-details-place-request');
    request.setAttribute('place', placeId);
    const config = document.createElement('gmp-place-content-config');
    for (const tag of ['gmp-place-media', 'gmp-place-attribution', 'gmp-place-address', 'gmp-place-rating', 'gmp-place-opening-hours']) {
      const item = document.createElement(tag);
      if (tag === 'gmp-place-media') item.setAttribute('lightbox-preferred', '');
      config.appendChild(item);
    }
    details.append(request, config);
    return details;
  }
  // Deliberately expose a factory only; no automatic script load or DOM insertion.
  // Activation requires reviewed Google billing safeguards and a new explicit owner approval.
  window.LiveCityPlacesUiKit37E = Object.freeze({
    enabled: ENABLED, createPlaceDetails,
    activationBlockedReason: 'No enforceable monetary limit; Google JS must not load automatically'
  });
})();
