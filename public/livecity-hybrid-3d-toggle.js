// public/livecity-hybrid-3d-toggle.js
// [Mission 37] Dev-only launcher for the isolated Cesium/Photorealistic 3D POC.
// Injected only by tools/preview.js into the dev UI. Production HTML is untouched.
(function () {
  if (window.__LIVECITY_M37_TOGGLE__) return;

  const root = document.createElement('div');
  root.id = 'mission37-hybrid-toggle';
  root.style.cssText = [
    'position:fixed',
    'right:14px',
    'bottom:14px',
    'z-index:2147483000',
    'display:flex',
    'gap:8px',
    'align-items:center',
    'padding:8px',
    'border-radius:12px',
    'background:rgba(8,18,32,.88)',
    'border:1px solid rgba(255,255,255,.14)',
    'box-shadow:0 8px 30px rgba(0,0,0,.28)',
    'backdrop-filter:blur(8px)'
  ].join(';');

  const label = document.createElement('span');
  label.textContent = '3D基盤';
  label.style.cssText = 'color:#d9e7f4;font:12px/1.2 system-ui,sans-serif;padding:0 4px';

  function makeButton(text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = [
      'appearance:none',
      'border:1px solid rgba(255,255,255,.18)',
      'border-radius:9px',
      'padding:8px 10px',
      'background:#13243a',
      'color:white',
      'font:600 12px/1 system-ui,sans-serif',
      'cursor:pointer'
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  }

  const currentBtn = makeButton('Three.js', function () {
    // Current page already is the Three.js dev implementation.
    location.href = '/osaka_3d_buildings.ward-ux-v1.html';
  });

  const hybridBtn = makeButton('Cesium POC', function () {
    location.href = '/mission37-livecity-hybrid-3d-poc.html';
  });

  const compareBtn = makeButton('比較', function () {
    window.open('/mission37-livecity-hybrid-3d-compare.html', '_blank', 'noopener');
  });

  root.append(label, currentBtn, hybridBtn, compareBtn);
  document.body.appendChild(root);

  window.__LIVECITY_M37_TOGGLE__ = {
    version: 'mission37-dev-v1',
    current: 'threejs',
    pocUrl: '/mission37-livecity-hybrid-3d-poc.html',
    compareUrl: '/mission37-livecity-hybrid-3d-compare.html'
  };
})();
