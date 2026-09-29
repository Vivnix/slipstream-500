/* Wideo: Chrome bez okna sterowany przez DevTools Protocol (bez zależności — Node 24 ma globalny WebSocket)
   i mały serwer statyczny repozytorium. Ścieżka /v/<nazwa>/sim.js podaje wskazaną wersję symulacji,
   każdy inny plik pod /v/<nazwa>/ to plik z repozytorium — gra ładuje wtedy starą albo nową AI bez zmian w index.html. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// sims: { old: 'C:/…/sim-old.js', new: 'C:/…/sim.js' }
function serve(root, sims) {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]), file;
      const m = /^\/v\/([^/]+)(\/.*)$/.exec(p);
      if (m) { p = m[2]; if (p === '/sim.js' && sims[m[1]]) file = sims[m[1]]; }
      if (p === '/') p = '/index.html';
      file = file || path.join(root, p);
      if (!path.resolve(file).startsWith(path.resolve(root)) && !Object.values(sims).includes(file)) { rsp.writeHead(403); return rsp.end(); }
      fs.readFile(file, (err, buf) => {
        if (err) { rsp.writeHead(404); return rsp.end(); }
        rsp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        rsp.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// headless=new z prawdziwym GPU (ANGLE/D3D11); SWIFTSHADER=1 wymusza programowe renderowanie
async function launch({ width, height, gpu = !process.env.SWIFTSHADER }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's500-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `--window-size=${width},${height}`,
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=1',
    ...(gpu ? ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    'about:blank'];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error('Chrome nie wystartował')), 20000);
    proc.stderr.on('data', d => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(to); res(m[1]); } });
    proc.on('exit', c => rej(new Error('Chrome zakończył się: ' + c)));
  });
  const browser = await connect(wsUrl);
  const close = async () => {
    const gone = new Promise(r => { if (proc.exitCode != null) r(); else { proc.once('exit', r); setTimeout(r, 5000); } });
    try { await browser.send('Browser.close'); } catch (e) { /* już zamknięty */ }
    await gone; proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* Chrome jeszcze trzyma pliki — zostaje w %TEMP% */ }
  };
  return { browser, close, proc };
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map(), handlers = new Map();
    const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
      const i = ++id; pending.set(i, { ok, fail, method });
      ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
    });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id != null) { const p = pending.get(m.id); pending.delete(m.id); if (!p) return; if (m.error) p.fail(new Error(p.method + ': ' + m.error.message)); else p.ok(m.result); }
      else { const h = handlers.get(m.method); if (h) for (const f of h) f(m.params, m.sessionId); }
    };
    ws.onerror = e => rej(e);
    ws.onopen = () => res({
      send,
      on(ev, f) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(f); },
      // karta: sesja przypięta do celu (flatten)
      async page(width, height) {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const s = (m, p) => send(m, p, sessionId);
        await s('Page.enable'); await s('Runtime.enable');
        await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        const logs = [];
        this.on('Runtime.consoleAPICalled', (p, sid) => { if (sid === sessionId) logs.push(p.args.map(a => a.value !== undefined ? a.value : a.description).join(' ')); });
        this.on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) logs.push('WYJĄTEK: ' + (p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text)); });
        const page = {
          send: s, logs, targetId,
          async eval(expr) {
            const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text) + '\n' + logs.slice(-5).join('\n'));
            return r.result.value;
          },
          async goto(url, initScript) {
            if (initScript) await s('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
            const loaded = new Promise(ok => { const f = (p, sid) => { if (sid === sessionId) ok(); }; this.on('Page.loadEventFired', f); });
            await s('Page.navigate', { url }); await loaded;
          },
          async shot(quality = 93) {
            const r = await s('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: true, captureBeyondViewport: false });
            return Buffer.from(r.data, 'base64');
          },
          close: () => send('Target.closeTarget', { targetId }),
        };
        page.on = this.on;
        return page;
      },
    });
  });
}

module.exports = { serve, launch };
