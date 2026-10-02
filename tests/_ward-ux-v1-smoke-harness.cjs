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
      // getImageData(sx,sy,sw,sh) / createImageData(w,h): 引数のサイズをそのまま尊重する
      // （固定64x64だと、大きいcanvas texture(例: raster可視化)を使うコードでバッファ不足の
      //  TypeError を誤検出できず、実ブラウザでのみ顕在化するバグを見逃す）。
      if (k === 'getImageData') return (sx, sy, sw, sh) => ({ data: new Uint8ClampedArray(Math.max(1, sw || 64) * Math.max(1, sh || 64) * 4), width: sw || 64, height: sh || 64 });
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w || 64) * Math.max(1, h || 64) * 4), width: w || 64, height: h || 64 });
      if (k === 'putImageData') return () => {};
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
  // [Mission 32J] 実際に指定された色を保持する。従来は常に 0xffffff を返していたため、
  //   「実機で緑に描かれているのはどの object か」を runtime から実測できなかった（§1 推測禁止）。
  //   set/setHex/copy も値を反映する。未指定時の既定は従来どおり白。
  let hex = typeof c === 'number' ? c : 0xffffff;
  const o = { isColor: true,
    get r() { return ((hex >> 16) & 255) / 255; },
    get g() { return ((hex >> 8) & 255) / 255; },
    get b() { return (hex & 255) / 255; },
    set(v) { if (typeof v === 'number') hex = v; else if (v && typeof v.getHex === 'function') hex = v.getHex(); return o; },
    setHex(v) { if (typeof v === 'number') hex = v; return o; },
    setRGB() { return o; }, setStyle() { return o; }, setScalar() { return o; },
    copy(v) { if (v && typeof v.getHex === 'function') hex = v.getHex(); return o; },
    clone() { return color(hex); },
    getHexString() { return hex.toString(16).padStart(6, '0'); }, getHex() { return hex; },
    lerp() { return o; }, lerpColors() { return o; }, multiplyScalar() { return o; }, offsetHSL() { return o; }, convertSRGBToLinear() { return o; },
    getStyle() { return '#' + hex.toString(16).padStart(6, '0'); }, addScalar() { return o; }, multiply() { return o; },
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
  return function (opts) {
    // [Mission 32J] material 等のコンストラクタ引数を保持する（従来は破棄していた）。
    //   {color: 0x...} を渡された場合は material.color.getHex() がその値を返すようにする。
    const optColor = opts && typeof opts === 'object' && opts.color != null ? opts.color : undefined;
    const proxy = new Proxy(Object.assign({
      __opts: opts && typeof opts === 'object' ? opts : null,
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
      intensity: 1,
      // [Mission 32J] コンストラクタで {color: 0x...} を渡された場合はその色を保持する
      //   （このキーが同一リテラル内で最後に現れるため、ここで設定しないと上書きされてしまう）。
      color: color(typeof optColor === 'number' ? optColor : (optColor && typeof optColor.getHex === 'function' ? optColor.getHex() : undefined)),
      groundColor: color(), shadow: { mapSize: vec3(), camera: { near: 1, far: 100, left: 0, right: 0, top: 0, bottom: 0, updateProjectionMatrix() {} }, bias: 0, normalBias: 0, radius: 1 },
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
// [Mission 31G-FIX23] Legacy residual を実機同様に検証するには、scene.traverse()/add()/remove()/
//   children/parent が「本物のシーングラフ」として機能し、Mesh/LineSegments が実際に渡された
//   geometry(position属性のcount)を保持する必要がある（classifyLegacyResidual()がposition count>300で
//   小helperを除外する判定・isMesh/isLineSegments判定・parentチェーン走査に依存するため）。
//   既存の stubClass()（他の全THREEクラス用）はロジック・シグネチャとも一切変更しない
//   （純粋な追加。既存1470件超のtestへの影響ゼロ）。
function makeObject3DLike(extra = {}) {
  const base = Object.assign({
    position: vec3(), rotation: vec3(), scale: vec3(1, 1, 1), quaternion: { setFromEuler() {}, copy() {} },
    up: vec3(0, 1, 0), matrix: {}, matrixWorld: {}, userData: {}, children: [], parent: null,
    layers: { set() {}, enable() {} }, name: '', visible: true, frustumCulled: true, renderOrder: 0,
    castShadow: false, receiveShadow: false, isObject3D: true,
    // [Mission 31G-ALIGNMENT-RESET] 実 three.js の Object3D.add() は複数引数(add(a,b,c))に対応する。
    //   単一引数のみのstubだと `scene.add(rootA, rootB, rootC)` の2つ目以降が実 three.js では
    //   ちゃんと追加されるのにこのharnessでは静かに無視され、「実ブラウザでは動くのにテストだけ
    //   誤ってfailする/逆に本来falseになるべきものがvacuousにpassする」食い違いを生む
    //   （本ミッションで scene.add(canonicalRoot, legacyRoot, debugRoot, uiRoot) を書いた際に実際に発覚）。
    add(...objs) { for (const obj of objs) if (obj && this.children.indexOf(obj) === -1) { this.children.push(obj); obj.parent = this; } return this; },
    remove(obj) { const i = this.children.indexOf(obj); if (i >= 0) { this.children.splice(i, 1); if (obj.parent === this) obj.parent = null; } return this; },
    traverse(cb) { cb(this); for (const c of this.children.slice()) { if (c && typeof c.traverse === 'function') c.traverse(cb); else cb(c); } },
    lookAt() {}, updateMatrix() {}, updateMatrixWorld() {},
    getWorldPosition() { return vec3(); }, getWorldDirection() { return vec3(); },
    clone() { return makeObject3DLike(extra); },
  }, extra);
  return new Proxy(base, {
    get(t, k, receiver) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; if (k === 'then') return undefined; return (..._a) => receiver; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function makeBufferGeometry() {
  const attrs = {};
  const geo = {
    attributes: attrs, index: null,
    setAttribute(name, attr) { attrs[name] = attr; return geo; },
    getAttribute(name) { return attrs[name]; },
    deleteAttribute(name) { delete attrs[name]; return geo; },
    setIndex(idx) { geo.index = idx; return geo; },
    computeVertexNormals() {}, computeBoundingSphere() {}, computeBoundingBox() {},
    setFromPoints() { return geo; }, addGroup() {}, clearGroups() {}, dispose() {},
    setDrawRange() {}, toNonIndexed() { return geo; }, rotateX() { return geo; }, rotateY() { return geo; }, rotateZ() { return geo; },
    translate() { return geo; }, scale() { return geo; }, center() { return geo; }, merge() { return geo; }, clone() { return makeBufferGeometry(); },
    boundingSphere: { radius: 1, center: vec3() }, boundingBox: { min: vec3(), max: vec3() },
  };
  return geo;
}
function makeBufferAttribute(array, itemSize) {
  const arr = array || new Float32Array(0);
  const is = itemSize || 1;
  return { array: arr, itemSize: is, count: Math.floor(arr.length / is), needsUpdate: false, setXYZ() { return this; }, setX() { return this; }, setY() { return this; }, setZ() { return this; } };
}
const THREE = new Proxy({
  Vector2: stubClass(), Vector3: function (x, y, z) { return vec3(x, y, z); }, Vector4: stubClass(),
  Color: function (c) { return color(c); },
  Matrix4: stubClass(), Matrix3: stubClass(), Quaternion: stubClass(), Euler: stubClass(),
  Scene: function () { return makeObject3DLike({ background: null, fog: null, isScene: true }); },
  Fog: function (c, n, f) { return { color: color(c), near: n, far: f, isFog: true }; },
  FogExp2: function (c, d) { return { color: color(c), density: d }; },
  PerspectiveCamera: stubClass({ isPerspectiveCamera: true }),
  OrthographicCamera: stubClass(),
  WebGLRenderer: stubClass({ shadowMap: { enabled: false, type: 0 }, info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } }, capabilities: { getMaxAnisotropy: () => 1 }, domElement: El() }),
  Group: function () { return makeObject3DLike({ isGroup: true }); },
  Object3D: function () { return makeObject3DLike({}); },
  Mesh: function (geometry, material) { return makeObject3DLike({ isMesh: true, geometry: geometry || anyStub(), material: material || anyStub() }); },
  InstancedMesh: function (geometry, material, count) { return makeObject3DLike({ isInstancedMesh: true, isMesh: true, geometry: geometry || anyStub(), material: material || anyStub(), count: count || 0 }); },
  Line: function (geometry, material) { return makeObject3DLike({ isLine: true, geometry: geometry || anyStub(), material: material || anyStub() }); },
  LineSegments: function (geometry, material) { return makeObject3DLike({ isLineSegments: true, isLine: true, geometry: geometry || anyStub(), material: material || anyStub() }); },
  LineLoop: function (geometry, material) { return makeObject3DLike({ isLineLoop: true, isLine: true, geometry: geometry || anyStub(), material: material || anyStub() }); },
  Points: function (geometry, material) { return makeObject3DLike({ isPoints: true, geometry: geometry || anyStub(), material: material || anyStub() }); },
  Sprite: function (material) { return makeObject3DLike({ isSprite: true, material: material || anyStub(), geometry: anyStub() }); },
  BufferGeometry: function () { return makeBufferGeometry(); },
  BufferAttribute: function (array, itemSize) { return makeBufferAttribute(array, itemSize); },
  Float32BufferAttribute: function (array, itemSize) { return makeBufferAttribute(array instanceof Float32Array ? array : new Float32Array(array || []), itemSize); },
  Uint16BufferAttribute: function (array, itemSize) { return makeBufferAttribute(array, itemSize); },
  InstancedBufferAttribute: function (array, itemSize) { return makeBufferAttribute(array, itemSize); },
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

// Optional: serve real map-data files to fetch(). fetchRoot defaults to public/.
function makeFetch(fetchRoot) {
  const notFound = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  if (!fetchRoot) return notFound;
  return (url) => {
    try {
      const rel = String(url).replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '').split(/[?#]/)[0];
      const p = path.resolve(fetchRoot, rel);
      if (!p.startsWith(path.resolve(fetchRoot)) || !fs.existsSync(p)) return notFound();
      const text = fs.readFileSync(p, 'utf8');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(text)), text: () => Promise.resolve(text) });
    } catch { return notFound(); }
  };
}

function buildSandbox(opts = {}) {
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
    fetch: makeFetch(opts.fetchRoot),
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

/** Execute the ward-ux-v1 inline script under stubs. Returns { ok, error, window }.
 *  opts.fetchRoot: if set, fetch() serves real files under that dir (e.g. path.resolve('public')). */
function runInlineScript(htmlPath = path.resolve('public/osaka_3d_buildings.ward-ux-v1.html'), opts = {}) {
  const code = loadInline(htmlPath);
  const sandbox = buildSandbox(opts);
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
