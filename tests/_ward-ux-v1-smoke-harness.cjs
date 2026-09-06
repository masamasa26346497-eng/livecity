// tests/_ward-ux-v1-smoke-harness.cjs
// Minimal DOM/THREE stub to EXECUTE the ward-ux-v1 inline script and catch top-level runtime throws
// (TDZ ReferenceErrors, undefined refs at module-eval time) that regex/`node --check` tests cannot see.
// Exports runInlineScript() → { ok, error, window }. THREE r128 is vendored/frozen so the stub surface is stable.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadInline(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('no inline <script> found in ' + htmlPath);
  return m[1];
}

// ---- stubs ----
function El() {
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === 'style') return new Proxy({}, { get: () => '', set: () => true });
      if (k === 'classList') return { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
      if (k === 'getContext') return () => ctx2d();
      if (k === 'appendChild' || k === 'append' || k === 'removeChild' || k === 'insertBefore' || k === 'setAttribute'
        || k === 'addEventListener' || k === 'removeEventListener' || k === 'querySelector' || k === 'querySelectorAll'
        || k === 'focus' || k === 'blur' || k === 'click' || k === 'remove' || k === 'setSelectionRange') return () => (k.includes('querySelectorAll') ? [] : null);
      if (k === 'children' || k === 'childNodes') return [];
      if (k === 'width' || k === 'height' || k === 'clientWidth' || k === 'clientHeight' || k === 'offsetWidth' || k === 'offsetHeight') return 100;
      if (k === 'checked') return true;
      if (k === 'value') return '';
      if (k === 'dataset') return {};
      if (k === 'parentNode' || k === 'parentElement') return El();
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 });
      return El();
    },
    apply() { return El(); },
  });
}
function ctx2d() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return { width: 64, height: 64 };
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(64 * 64 * 4) });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: () => true,
  });
}

const documentStub = {
  getElementById: () => El(),
  createElement: () => El(),
  createElementNS: () => El(),
  querySelector: () => El(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: El(),
  documentElement: El(),
  head: El(),
  fonts: { add() {}, load: () => Promise.resolve(), ready: Promise.resolve() },
  hidden: false,
  visibilityState: 'visible',
};

// THREE stub — enough surface for construction-time calls.
function vec3(x = 0, y = 0, z = 0) {
  const v = { x, y, z,
    set(a, b, c) { v.x = a; v.y = b; v.z = c; return v; },
    copy(o) { v.x = o.x; v.y = o.y; v.z = o.z; return v; },
    add() { return v; }, sub() { return v; }, addVectors() { return v; }, subVectors() { return v; },
    multiplyScalar() { return v; }, normalize() { return v; }, applyMatrix4() { return v; }, applyQuaternion() { return v; },
    crossVectors() { return v; }, cross() { return v; }, clone() { return vec3(v.x, v.y, v.z); },
    length() { return 0; }, lengthSq() { return 0; }, distanceTo() { return 0; }, dot() { return 0; },
    setFromMatrixPosition() { return v; }, project() { return v; }, unproject() { return v; }, lerp() { return v; },
    setScalar() { return v; }, setX() { return v; }, setY() { return v; }, setZ() { return v; }, negate() { return v; },
  };
  return v;
}
function color(c) {
  const o = { r: 1, g: 1, b: 1, isColor: true,
    set() { return o; }, setHex() { return o; }, setRGB() { return o; }, setStyle() { return o; }, setScalar() { return o; },
    copy() { return o; }, clone() { return color(); }, getHexString() { return 'ffffff'; }, getHex() { return 0xffffff; },
    lerp() { return o; }, lerpColors() { return o; }, multiplyScalar() { return o; }, offsetHSL() { return o; }, convertSRGBToLinear() { return o; },
    getStyle() { return '#ffffff'; }, addScalar() { return o; }, multiply() { return o; },
  };
  return o;
}
const ANY = new Proxy(function () {}, {
  get(t, k) {
    if (typeof k === 'symbol') return k === Symbol.iterator ? function* () {} : undefined;
    if (k === 'then') return undefined;
    if (k === 'length' || k === 'count' || k === 'x' || k === 'y' || k === 'z' || k === 'r' || k === 'g' || k === 'b') return 0;
    if (k === 'array') return new Float32Array(3);
    if (k === 'getHexString') return () => 'ffffff';
    if (k === 'isColor' || k === 'isVector3') return true;
    return ANY;
  },
  set() { return true; },
  apply() { return ANY; },
  construct() { return ANY; },
});
function anyStub() { return ANY; }
function stubClass(extra = {}) {
  return function () {
    const proxy = new Proxy(Object.assign({
      position: vec3(), rotation: vec3(), scale: vec3(1, 1, 1), quaternion: { setFromEuler() {}, copy() {} },
      up: vec3(0, 1, 0), matrix: {}, matrixWorld: {}, userData: {}, children: [], layers: { set() {}, enable() {} },
      add() {}, remove() {}, lookAt() {}, updateMatrix() {}, updateMatrixWorld() {}, updateProjectionMatrix() {},
      traverse() {}, getWorldPosition() { return vec3(); }, getWorldDirection() { return vec3(); },
      setSize() {}, setPixelRatio() {}, setClearColor() {}, render() {}, dispose() {}, clear() {}, setViewport() {},
      setScissor() {}, setScissorTest() {}, getClearColor() { return color(); }, getPixelRatio() { return 1; },
      compile() {}, forceContextLoss() {},
      setAttribute() {}, getAttribute() { return { array: new Float32Array(3), count: 1, setXYZ() {}, needsUpdate: false }; },
      setIndex() {}, computeVertexNormals() {}, computeBoundingSphere() {}, computeBoundingBox() {},
      setFromPoints() { return this; }, deleteAttribute() {}, addGroup() {},
      fov: 60, aspect: 1.5, near: 1, far: 14000, isCamera: true,
      castShadow: false, receiveShadow: false, visible: true, frustumCulled: true, renderOrder: 0,
      intensity: 1, color: color(), groundColor: color(), shadow: { mapSize: vec3(), camera: { near: 1, far: 100, left: 0, right: 0, top: 0, bottom: 0, updateProjectionMatrix() {} }, bias: 0, normalBias: 0, radius: 1 },
      get material() { return anyStub(); }, get geometry() { return anyStub(); },
      target: Object.assign(vec3(), {}), image: { width: 64, height: 64 },
      elements: new Array(16).fill(0),
      shadowMap: { enabled: false, type: 0 }, toneMapping: 0, toneMappingExposure: 1, outputColorSpace: '', info: { render: {}, memory: {} }, capabilities: { getMaxAnisotropy: () => 1 }, domElement: El(),
    }, extra), {
      get(t, k, receiver) {
        if (k in t) return t[k];
        if (typeof k === 'symbol') return undefined;
        if (k === 'then') return undefined;
        return (..._a) => receiver;
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    return proxy;
  };
}
const THREE = new Proxy({
  Vector2: stubClass(), Vector3: function (x, y, z) { return vec3(x, y, z); }, Vector4: stubClass(),
  Color: function (c) { return color(c); },
  Matrix4: stubClass(), Matrix3: stubClass(), Quaternion: stubClass(), Euler: stubClass(),
  Scene: stubClass({ background: null, fog: null, isScene: true }),
  Fog: function (c, n, f) { return { color: color(c), near: n, far: f, isFog: true }; },
  FogExp2: function (c, d) { return { color: color(c), density: d }; },
  PerspectiveCamera: stubClass({ isPerspectiveCamera: true }),
  OrthographicCamera: stubClass(),
  WebGLRenderer: stubClass({ shadowMap: { enabled: false, type: 0 }, info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } }, capabilities: { getMaxAnisotropy: () => 1 }, domElement: El() }),
  Group: stubClass(), Object3D: stubClass(), Mesh: stubClass(), InstancedMesh: stubClass(),
  Line: stubClass(), LineSegments: stubClass(), LineLoop: stubClass(), Points: stubClass(), Sprite: stubClass(),
  BufferGeometry: stubClass(), BufferAttribute: stubClass(), Float32BufferAttribute: stubClass(), Uint16BufferAttribute: stubClass(), InstancedBufferAttribute: stubClass(),
  PlaneGeometry: stubClass(), BoxGeometry: stubClass(), CircleGeometry: stubClass(), SphereGeometry: stubClass(),
  CylinderGeometry: stubClass(), ConeGeometry: stubClass(), ShapeGeometry: stubClass(), ExtrudeGeometry: stubClass(), EdgesGeometry: stubClass(), RingGeometry: stubClass(),
  MeshBasicMaterial: stubClass(), MeshStandardMaterial: stubClass(), MeshPhongMaterial: stubClass(), MeshLambertMaterial: stubClass(),
  MeshPhysicalMaterial: stubClass(), LineBasicMaterial: stubClass(), LineDashedMaterial: stubClass(), PointsMaterial: stubClass(), SpriteMaterial: stubClass(), ShadowMaterial: stubClass(), ShaderMaterial: stubClass(),
  AmbientLight: stubClass(), HemisphereLight: stubClass(), DirectionalLight: stubClass(), PointLight: stubClass(), SpotLight: stubClass(),
  Texture: stubClass(), CanvasTexture: stubClass(), DataTexture: stubClass(), TextureLoader: stubClass(),
  Raycaster: stubClass({ ray: { origin: vec3(), direction: vec3() }, params: {}, setFromCamera() {}, intersectObject() { return []; }, intersectObjects() { return []; } }),
  Plane: stubClass({ normal: vec3(), constant: 0, setFromNormalAndCoplanarPoint() {}, intersectLine() { return null; } }),
  Box3: stubClass({ min: vec3(), max: vec3(), setFromObject() { return this; }, setFromPoints() { return this; }, getCenter() { return vec3(); }, getSize() { return vec3(); }, isEmpty() { return true; }, expandByPoint() {} }),
  Sphere: stubClass(), Frustum: stubClass({ setFromProjectionMatrix() {}, intersectsObject() { return true; }, intersectsSphere() { return true; }, containsPoint() { return true; } }),
  Shape: stubClass({ moveTo() {}, lineTo() {}, holes: [] }), Path: stubClass(), Curve: stubClass(),
  CatmullRomCurve3: stubClass({ getPoints() { return [vec3()]; }, getPoint() { return vec3(); } }),
  QuadraticBezierCurve3: stubClass({ getPoints() { return [vec3()]; } }),
  GridHelper: stubClass(), AxesHelper: stubClass(), Box3Helper: stubClass(),
  MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI, clamp: (v, a, b) => Math.max(a, Math.min(b, v)), lerp: (a, b, t) => a + (b - a) * t, smoothstep: (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }, mapLinear: (x, a1, a2, b1, b2) => b1 + (x - a1) * (b2 - b1) / (a2 - a1), generateUUID: () => 'uuid' },
  Spherical: stubClass({ setFromVector3() {}, radius: 1, phi: 1, theta: 1 }),
  PCFSoftShadowMap: 2, PCFShadowMap: 1, BasicShadowMap: 0, VSMShadowMap: 3,
  ACESFilmicToneMapping: 4, NoToneMapping: 0, ReinhardToneMapping: 2, LinearToneMapping: 1, CineonToneMapping: 3,
  sRGBEncoding: 3001, LinearEncoding: 3000, SRGBColorSpace: 'srgb', LinearSRGBColorSpace: 'srgb-linear',
  FrontSide: 0, BackSide: 1, DoubleSide: 2,
  NormalBlending: 1, AdditiveBlending: 2, MultiplyBlending: 4, CustomBlending: 5,
  RepeatWrapping: 1000, ClampToEdgeWrapping: 1001, MirroredRepeatWrapping: 1002,
  NearestFilter: 1003, LinearFilter: 1006, LinearMipmapLinearFilter: 1008,
  RGBAFormat: 1023, RGBFormat: 1022, LuminanceFormat: 1024, RedFormat: 1028,
  UnsignedByteType: 1009, FloatType: 1015, HalfFloatType: 1016,
  TriangleStripDrawMode: 1, TrianglesDrawMode: 0,
  DynamicDrawUsage: 35048, StaticDrawUsage: 35044,
  AlwaysStencilFunc: 512, KeepStencilOp: 7680,
  REVISION: '128',
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return stubClass(); },
});

function buildSandbox() {
  const sb = {
    THREE,
    window: null,
    document: documentStub,
    navigator: { userAgent: 'node', platform: 'node', maxTouchPoints: 0, hardwareConcurrency: 4, language: 'ja' },
    location: { href: 'file:///test.html', protocol: 'file:', search: '', hash: '', pathname: '/test.html', reload() {} },
    history: { replaceState() {}, pushState() {} },
    innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, group: () => {}, groupEnd: () => {}, table: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    URL, URLSearchParams, Blob: function () {}, FileReader: function () {},
    Image: function () { return El(); }, Path2D: function () {},
    alert: () => {}, confirm: () => true, prompt: () => null,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    scrollTo: () => {}, focus: () => {}, blur: () => {},
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, WeakMap, WeakSet, Promise, Symbol, Proxy, Reflect,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array, Uint8ClampedArray, ArrayBuffer, DataView,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    structuredClone: (x) => JSON.parse(JSON.stringify(x)),
  };
  sb.window = sb; sb.globalThis = sb; sb.self = sb;
  return sb;
}

/** Execute the ward-ux-v1 inline script under stubs. Returns { ok, error, window }. */
function runInlineScript(htmlPath = path.resolve('public/osaka_3d_buildings.ward-ux-v1.html')) {
  const code = loadInline(htmlPath);
  const sandbox = buildSandbox();
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: 'ward-ux-v1-inline.js', timeout: 15000 });
    return { ok: true, error: null, window: sandbox.window };
  } catch (e) {
    return { ok: false, error: e, window: sandbox.window };
  }
}

module.exports = { runInlineScript };

if (require.main === module) {
  const r = runInlineScript();
  if (r.ok) { console.log('OK: inline script executed without a top-level throw.'); }
  else { console.error('THROW:', r.error && r.error.stack ? r.error.stack.split('\n').slice(0, 6).join('\n') : r.error); process.exit(1); }
}
