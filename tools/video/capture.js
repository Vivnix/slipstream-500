/* Wideo: nagrywanie ujęć — Chrome bez okna z reżyserem (director.html), klatka po klatce do ffmpeg.
   Każde ujęcie trafia do osobnego pliku pośredniego (cache po skrócie opisu ujęcia i wersji symulacji), dźwięk gry do WAV. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { serve, launch } = require('./cdp.js');
const VR = require('./race.js');

const FPS = 60;

function wav(file, pcm16, ch = 2, rate = 48000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm16.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm16.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm16]));
}

// odcisk z Node: ten sam wyścig do tej samej liczby ticków co w przeglądarce
const simCache = new Map();
function nodeFingerprint(simPath, spec, sub) {
  if (!simCache.has(simPath)) simCache.set(simPath, require(simPath));
  const race = VR.makeRace(simCache.get(simPath), spec);
  VR.tickN(race, sub);
  return VR.fingerprint(race);
}
const sameFp = (a, b) => a.length === b.length && a.every((r, i) => r.every((x, j) => Math.abs(x - b[i][j]) < 1e-6));

function ffmpegSink(file, w, h) {
  const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${w}:${h}:out_range=tv,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '60', '-r', String(FPS), file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('exit', c => c === 0 ? res() : rej(new Error('ffmpeg: ' + c))));
  return { write: buf => new Promise(r => { if (p.stdin.write(buf)) r(); else p.stdin.once('drain', r); }), end: () => { p.stdin.end(); return done; } };
}

// shots: [{ id, layout, frames, views: [...], ov: [...] }], sims: { old: plik, new: plik }
async function captureShots(shots, { repo, sims, work, width, height, force, log = console.log }) {
  fs.mkdirSync(work, { recursive: true });
  const simHash = Object.fromEntries(Object.entries(sims).map(([k, f]) => [k, crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10)]));
  const pageHash = crypto.createHash('sha1').update(['index.html', 'tools/video/director.html', 'tools/video/init.js', 'tools/video/race.js'].map(f => fs.readFileSync(path.join(repo, f))).join('')).digest('hex').slice(0, 10);
  const todo = [], out = [];
  for (const s of shots) {
    const key = crypto.createHash('sha1').update(JSON.stringify([s, width, height, pageHash, (s.views || []).map(v => simHash[v.sim])])).digest('hex').slice(0, 12);
    const file = path.join(work, `${s.id}-${width}x${height}-${key}.mp4`);
    const r = { shot: s, file, audio: (s.views || []).map((v, i) => v.audio ? file.replace(/\.mp4$/, `-a${i}.wav`) : null), mismatch: [] };
    out.push(r);
    if (force || !fs.existsSync(file)) todo.push(r);
  }
  if (!todo.length) return out;
  const { srv, port } = await serve(repo, sims);
  const { browser, close } = await launch({ width, height });
  try {
    const page = await browser.page(width, height);
    await page.goto(`http://127.0.0.1:${port}/tools/video/director.html`, fs.readFileSync(path.join(__dirname, 'init.js'), 'utf8'));
    await page.eval('document.fonts.ready.then(() => 1)');
    for (const r of todo) {
      const s = r.shot, t0 = Date.now();
      const start = await page.eval(`D.setup(${JSON.stringify(s)})`);
      const tmp = r.file + '.part.mp4', sink = ffmpegSink(tmp, width, height);
      for (let i = 0; i < s.frames; i++) {
        await page.eval(`D.frame(${i})`);
        await sink.write(await page.shot(94));
      }
      await sink.end();
      const end = await page.eval('D.finish()');
      // zgodność z Node: początek i koniec ujęcia tick w tick
      (s.views || []).forEach((v, i) => {
        for (const [when, st] of [['start', start[i]], ['end', end[i]]]) {
          const fp = nodeFingerprint(sims[v.sim], v.spec, st.sub);
          if (!sameFp(fp, st.fp)) r.mismatch.push(`${s.id} widok ${i} (${when}, tick ${st.sub})`);
        }
        if (end[i].pcm) wav(r.audio[i], Buffer.from(end[i].pcm, 'base64'));
      });
      fs.renameSync(tmp, r.file);
      if (page.logs.length) { for (const l of page.logs.splice(0)) if (/WYJĄTEK|error/i.test(l)) log('   [strona] ' + l); }
      log(`  ujęcie ${s.id}: ${s.frames} klatek w ${((Date.now() - t0) / 1000).toFixed(1)} s${r.mismatch.length ? '  ROZBIEŻNOŚĆ z Node: ' + r.mismatch.join(', ') : '  (zgodne z Node)'}`);
    }
  } finally { await close(); srv.close(); }
  return out;
}

module.exports = { captureShots, wav, FPS };
