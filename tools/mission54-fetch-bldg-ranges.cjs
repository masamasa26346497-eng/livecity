// Mission 54: budgeted, sequential, read-only fetch of byte ranges of official PLATEAU bldg GML (Nakanoshima window).
// Limits: <=60 requests (incl. HEAD/API), <=50 MB total, <=15 MB per response, >=1 s between requests, stop on 403/429.
// Usage: node tools/mission54-fetch-bldg-ranges.cjs api | head | range <mesh> <start> <end> | status
// Originals go to temp/m54 (git-ignored). Ledger: temp/m54/ledger.json
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'temp', 'm54');
fs.mkdirSync(DIR, { recursive: true });
const LED = path.join(DIR, 'ledger.json');
const led = fs.existsSync(LED) ? JSON.parse(fs.readFileSync(LED, 'utf8')) : { gets: 0, bytes: 0, log: [], urls: {} };
const MAXGET = 60;
const MAXB = 50e6;
const MAXONE = 15e6;
const save = () => fs.writeFileSync(LED, JSON.stringify(led, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, opt, label) {
  if (led.gets >= MAXGET) throw new Error('request budget exhausted');
  await sleep(1100);
  led.gets++;
  const headers = Object.assign({ 'user-agent': 'livecity-poc/1.0', 'accept-encoding': 'identity' }, (opt && opt.headers) || {});
  const res = await fetch(url, Object.assign({}, opt, { headers }));
  if (res.status === 403 || res.status === 429) {
    led.log.push({ label, url, status: res.status, stop: true });
    save();
    throw new Error('HTTP ' + res.status + ' - stopping');
  }
  const isHead = opt && opt.method === 'HEAD';
  const buf = isHead ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  if (buf.length > MAXONE) throw new Error('response > 15MB');
  if (led.bytes + buf.length > MAXB) throw new Error('byte budget exceeded');
  led.bytes += buf.length;
  led.log.push({ label, url, status: res.status, bytes: buf.length, range: res.headers.get('content-range'), len: res.headers.get('content-length'), ar: res.headers.get('accept-ranges') });
  save();
  return { res, buf };
}

(async () => {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'status') {
    console.log(JSON.stringify({ gets: led.gets, bytes: led.bytes, urls: led.urls, log: led.log.slice(-8) }, null, 1));
    return;
  }
  if (cmd === 'api') {
    const r = await req('https://api.plateauview.mlit.go.jp/datacatalog/citygml/r:135.488,34.691,135.503,34.698?types=bldg', {}, 'api');
    fs.writeFileSync(path.join(DIR, 'api.json'), r.buf);
    const txt = r.buf.toString();
    console.log(r.res.status, r.buf.length, txt.slice(0, 1200));
    const urls = txt.match(/https?:[^"\\]+\.gml/g) || [];
    for (const u of urls) {
      const m = u.match(/(\d{8})_bldg/);
      if (m) led.urls[m[1]] = u;
    }
    save();
    console.log(led.urls);
  } else if (cmd === 'head') {
    for (const m of Object.keys(led.urls)) {
      const r = await req(led.urls[m], { method: 'HEAD' }, 'head ' + m);
      console.log(m, r.res.status, r.res.headers.get('content-length'), r.res.headers.get('accept-ranges'));
    }
  } else if (cmd === 'prefix') {
    // Server ignores Range (verified: full 200 body). Read only the first N bytes and abort the connection.
    const u = led.urls[a];
    const n = Number(b);
    if (!u || !(n > 0) || n > MAXONE) throw new Error('bad args');
    if (led.bytes + n > MAXB) throw new Error('byte budget exceeded');
    led.gets++;
    await sleep(1100);
    const ac = new AbortController();
    const res = await fetch(u, { signal: ac.signal, headers: { 'user-agent': 'livecity-poc/1.0', 'accept-encoding': 'identity' } });
    if (res.status === 403 || res.status === 429) { save(); throw new Error('HTTP ' + res.status); }
    const chunks = [];
    let got = 0;
    const rd = res.body.getReader();
    while (got < n) {
      const { done, value } = await rd.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
    }
    ac.abort();
    const buf = Buffer.concat(chunks).subarray(0, n);
    led.bytes += got;
    led.log.push({ label: 'prefix ' + a, url: u, status: res.status, bytes: got });
    save();
    fs.writeFileSync(path.join(DIR, 'bldg_' + a + '_prefix.part'), buf);
    console.log(res.status, got, 'saved', buf.length);
  } else if (cmd === 'range') {
    const u = led.urls[a];
    if (!u) throw new Error('unknown mesh');
    const r = await req(u, { headers: { range: 'bytes=' + b + '-' + c } }, 'range ' + a + ' ' + b + '-' + c);
    fs.writeFileSync(path.join(DIR, 'bldg_' + a + '_' + b + '-' + c + '.part'), r.buf);
    console.log(r.res.status, r.buf.length, r.res.headers.get('content-range'));
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
