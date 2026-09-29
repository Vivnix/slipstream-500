#!/usr/bin/env node
/* Wideo: zwiastun „Slipstream 500 · Nowe AI” — jedno polecenie od benchmarku do gotowych MP4.
   1) benchmark starego i nowego AI (tools/aibench.js, świeże liczby do napisów), 2) wyszukiwanie scen w wyścigach bez grafiki (find.js),
   3) montaż (lista ujęć poniżej), 4) nagrywanie klatka po klatce w Chrome bez okna (capture.js + director.html, sprawdzenie zgodności z Node),
   5) muzyka i efekty (sound.js) + dźwięk gry renderowany offline, 6) ffmpeg: trailer.mp4, trailer-bez-muzyki.mp4, [trailer-pionowy.mp4], kadry PNG.
   Użycie: node tools/video/render.js [--sim sim.js] [--old-rev e3dca2c | --old stary-sim.js] [--out katalog] [--work katalog-roboczy]
           [--vertical] (także wersja 1080×1920) [--preview] (960×540, szybki podgląd) [--only id,id] (tylko wybrane ujęcia, bez montażu)
           [--bench-seeds 5] [--scene-seeds 8] [--force] (bez cache: benchmark, sceny i ujęcia liczone od nowa)
   Wymaga: Node 24+, Chrome (albo zmienna CHROME), ffmpeg w PATH, internet (three.js i czcionki z CDN). */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const F = require('./find.js'), { captureShots } = require('./capture.js'), SND = require('./sound.js');

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; }, flag = k => args.includes('--' + k);
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(arg('out', path.join(os.homedir(), 'Videos', 'Slipstream500-AI')));
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), 's500-video')));
const PREVIEW = flag('preview'), ONLY = arg('only') ? arg('only').split(',') : null;
const FPS = 60, BEAT = 30;   // 120 BPM: ćwierćnuta = 30 klatek, cięcia na siatce muzyki
const log = (...a) => console.log(...a);
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });

// ─── wersje symulacji ───
const NEW = path.resolve(arg('sim', path.join(REPO, 'sim.js')));
let OLD = arg('old');
if (!OLD) {
  const rev = arg('old-rev', 'e3dca2c');
  OLD = path.join(WORK, `sim-old-${rev}.js`);
  fs.writeFileSync(OLD, execFileSync('git', ['show', `${rev}:sim.js`], { cwd: REPO, maxBuffer: 1 << 26 }));
}
OLD = path.resolve(OLD);
const SIMS = { old: OLD, new: NEW };

// cache w katalogu roboczym: klucz = skrót plików wejściowych i opcji (zmiana symulacji albo wyszukiwarki liczy od nowa)
function cached(name, files, extra, f) {
  const key = crypto.createHash('sha1').update(files.map(x => fs.readFileSync(x)).join('|') + JSON.stringify(extra)).digest('hex').slice(0, 12);
  const file = path.join(WORK, `${name}-${key}.json`);
  if (!flag('force') && fs.existsSync(file)) { log(`${name}: z cache (${path.basename(file)})`); return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  return Promise.resolve(f()).then(v => { fs.writeFileSync(file, JSON.stringify(v)); return v; });
}

// ─── 1. benchmark ───
function bench(sim) {
  const seeds = arg('bench-seeds', '5');
  return cached('benchmark', [sim, path.join(REPO, 'tools', 'aibench.js')], seeds, () => {
    log(`benchmark: ${path.basename(sim)}…`);
    return JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'tools', 'aibench.js'), '--seeds', seeds, '--json', '--sim', sim], { maxBuffer: 1 << 30 }).toString());
  });
}
const sum = (runs, key, f = () => true) => runs.filter(f).reduce((a, r) => a + (r[key] || 0), 0);
const pct = (o, n) => o > 0 ? (n - o) / o * 100 : 0;
const fmt = (x, dig = 0) => (Math.round(x * 10 ** dig) / 10 ** dig).toFixed(dig).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// pierwsza z kandydackich statystyk, która spadła o ≥30% (i nie jest znikoma) — gdy żadna, ujęcie idzie bez liczby
function pickStat(B, list) {
  for (const s of list) {
    const o = sum(B.old, s.key, s.f), n = sum(B.new, s.key, s.f);
    if (o >= (s.min || 4) && pct(o, n) <= -30) return { value: Math.round(pct(o, n)), label: s.label, detail: `${fmt(o, s.dig)}${s.unit || ''} → ${fmt(n, s.dig)}${s.unit || ''} · ${s.where}`, o, n };
  }
  return null;
}

// ─── 2. sceny ───
function scenes() {
  return cached('sceny', [OLD, NEW, path.join(__dirname, 'find.js'), path.join(__dirname, 'race.js')], [arg('scene-seeds', 8), String(findScenes), String(packMoment)], findScenes);
}
async function findScenes() {
  const S = +arg('scene-seeds', 8), jobs = [];
  const add = (sim, track, diffs, maxT, seeds = S) => { for (const diff of diffs) for (let seed = 1; seed <= seeds; seed++) jobs.push({ sim, simPath: SIMS[sim], track, diff, seed, maxT }); };
  for (const sim of ['old', 'new']) { add(sim, 'speedway', [10], 170); add(sim, 'intermediate', [10], 120); add(sim, 'indy', [7, 10], 110); add(sim, 'daytona', [7, 10], 110); }
  add('new', 'short', [10], 90, 4);
  log(`sceny: ${jobs.length} wyścigów bez grafiki…`);
  const runs = await F.runAll(jobs);
  const get = (sim, track, diff, seed) => runs.find(r => r.sim === sim && r.track === track && r.diff === diff && r.seed === seed);
  const all = (sim, tracks) => runs.filter(r => r.sim === sim && tracks.includes(r.track));
  const best = l => l.sort((a, b) => b.score - a.score);
  const out = {};
  // kraksy starego AI na superspeedwayu: najlepsza na otwarcie, dla porównania ta, której odpowiednik w nowym AI jest czysty
  const wr = best(all('old', ['speedway']).flatMap(r => F.wrecks(r)));
  out.cold = wr[0];
  const pairs = wr.map(w => ({ w, a: F.aligned(get('new', w.track, w.diff, w.seed), w, get('old', w.track, w.diff, w.seed)) })).filter(p => p.a && p.a.incidents === 0);
  const sp = pairs.find(p => p.w !== out.cold && p.w.seed !== out.cold.seed) || pairs.find(p => p.w !== out.cold) || pairs[0] || { w: wr[1] || wr[0], a: null };
  out.spOld = sp.w; out.spNew = sp.a || { sim: 'new', track: sp.w.track, diff: sp.w.diff, seed: sp.w.seed, t: sp.w.t, focus: sp.w.focus };
  // jazda po bandzie (owal 1,5 mili) i to samo auto w nowym AI w czystym fragmencie
  const sc = best(all('old', ['intermediate']).flatMap(r => F.scrapes(r)));
  out.scOld = sc[0];
  { const ro = get('old', sc[0].track, sc[0].diff, sc[0].seed), rn = get('new', sc[0].track, sc[0].diff, sc[0].seed); out.scNew = F.cleanNear(rn, rn.numbers.indexOf(ro.numbers[sc[0].focus]), sc[0].t, 4.5); }
  // tory drogowe: karambol na 1. okrążeniu i ta sama chwila w nowym AI
  const rw = best(all('old', ['indy', 'daytona']).flatMap(r => F.wrecks(r, { tMax: r.green + 100 }).filter(w => w.cars.length >= 3)));
  const rp = rw.map(w => ({ w, a: F.aligned(get('new', w.track, w.diff, w.seed), w, get('old', w.track, w.diff, w.seed)) })).find(p => p.a && p.a.incidents === 0) || { w: rw[0], a: F.aligned(get('new', rw[0].track, rw[0].diff, rw[0].seed), rw[0], get('old', rw[0].track, rw[0].diff, rw[0].seed)) };
  out.rdOld = rp.w; out.rdNew = rp.a;
  // montaż nowego AI
  const distinct = (l, n) => { const o = []; for (const c of l) if (!o.some(x => x.seed === c.seed && x.track === c.track && x.diff === c.diff)) { o.push(c); if (o.length >= n) break; } return o; };
  out.wide = distinct(best(all('new', ['speedway']).flatMap(r => F.threeWide(r))), 4);
  out.side = distinct(best(all('new', ['indy', 'daytona']).flatMap(r => F.sideBySide(r))), 3);
  out.pass = distinct(best(runs.filter(r => r.sim === 'new').flatMap(r => F.overtakes(r))).filter(c => c.t > 8), 3);
  out.pack = ['short', 'intermediate', 'daytona'].map(tr => packMoment(runs.filter(r => r.sim === 'new' && r.track === tr && r.diff === 10)));
  return out;
}
// największa grupa aut (±45 m) bez incydentów w pobliżu czasu — ujęcie „stawka w komplecie”
function packMoment(rs) {
  let bestM = null;
  for (const r of rs) for (let i = 0; i < r.samples.length; i += 5) {
    const t = (i + 1) * F.DT_S; if (r.green == null || t < r.green + 12 || t > r.samples.length * F.DT_S - 8) continue;
    const row = r.samples[i];
    for (let c = 0; c < row.length; c++) {
      if (!row[c][4]) continue;
      const n = row.filter(x => x[4] && Math.abs(x[2] - row[c][2]) < 45).length;
      if ((!bestM || n > bestM.n) && !r.ev.some(e => Math.abs(e.t - t) < 5)) bestM = { sim: 'new', track: r.track, diff: r.diff, seed: r.seed, t, focus: c, n };
    }
  }
  return bestM;
}

// ─── 3. montaż ───
const view = (c, cam, extra = {}) => Object.assign({ sim: c.sim, spec: { track: c.track, diff: c.diff, seed: c.seed }, t0: +c.t.toFixed(2), focus: c.focus, cam, audio: true }, extra);
function edl(S, B) {
  const shots = [], TR = { speedway: 'Superspeedway', intermediate: 'Owal 1,5 mili', short: 'Krótki owal', indy: 'Indianapolis RC', daytona: 'Daytona Road Course' };
  const where = c => `${TR[c.track]}, poziom ${c.diff}`;
  const shot = (id, beats, o) => { shots.push(Object.assign({ id, layout: 'full', frames: beats * BEAT }, o)); return shots[shots.length - 1]; };
  const flashIn = { type: 'flash', from: 0, to: 16, len: 16, peak: 0.85 };
  const stats = {
    sp: pickStat(B, [
      { key: 'wallHard', label: 'mocnych uderzeń w ścianę', where: 'superspeedway, poziom 10', f: r => r.track === 'speedway' && r.diff === 10, min: 3 },
      { key: 'contacts', label: 'kontaktów w pociągu', where: 'superspeedway', f: r => r.track === 'speedway' },
      { key: 'spins', label: 'obrotów', where: 'superspeedway', f: r => r.track === 'speedway' }]),
    sc: pickStat(B, [
      { key: 'scrapeT', label: 'jazdy po bandzie', unit: ' s', where: 'owal 1,5 mili', f: r => r.track === 'intermediate', min: 20 },
      { key: 'wallHits', label: 'uderzeń w ścianę', where: 'owal 1,5 mili', f: r => r.track === 'intermediate' },
      { key: 'spins', label: 'obrotów', where: 'owal 1,5 mili', f: r => r.track === 'intermediate' }]),
    rd: pickStat(B, [
      { key: 'contacts', label: 'kontaktów między autami', where: 'tory drogowe', f: r => r.track === 'indy' || r.track === 'daytona' },
      { key: 'spins', label: 'obrotów', where: 'tory drogowe', f: r => r.track === 'indy' || r.track === 'daytona' },
      { key: 'grassT', label: 'jazdy po trawie', unit: ' s', where: 'tory drogowe', f: r => r.track === 'indy' || r.track === 'daytona', min: 20 }]),
  };
  const statOv = (s, from, to) => s ? [{ type: 'stat', value: s.value, unit: '%', label: s.label, detail: s.detail, from, to, count: 45 }] : [];
  const PRZED = { type: 'tag', kind: 'before', text: 'Przed', sub: 'stare AI', from: 0 }, PO = { type: 'tag', kind: 'after', text: 'Po', sub: 'nowe AI', from: 0 };

  // 1. zimne otwarcie: kraksa starego AI, zwolnienie 4,5× wokół pierwszego uderzenia
  const c = S.cold, pre = 2.3, slowA = 125, slowB = 140, slowC = 330, slowD = 350;
  // statyw jak kamera TV (na zewnątrz ściany, wysoko), ale stały przez całe ujęcie — kamera TV gry przeskakiwała na starcie
  const cold = shot('01-otwarcie', 14, {
    views: [view(c, { type: 'tripod', ahead: 250, out: 26, h: 16, size: 12 }, { t0: +(c.t - pre).toFixed(2), speed: [[slowA, 1], [slowB, 0.22], [slowC, 0.22], [slowD, 1]] })],
    ov: [{ type: 'black', from: 0, to: 30, fadeIn: 30 }, { type: 'bars', from: 0, h: 0.1 },
      { type: 'caption', text: 'Tak było…', small: `stare AI · ${where(c)}`, from: 40, to: 390, in: 30, out: 20 }, { type: 'flash', from: 414, len: 8, peak: 0.9 }],
  });
  cold.music = { boom: videoTime(cold.views[0].speed, pre) };
  // 2. tytuł na rozmytej stawce nowego AI
  const tw = S.wide[3] || S.wide[0];
  shot('02-tytul', 8, { views: [view(tw, { type: 'heli', back: 26, up: 8, lead: 30 }, { filter: 'blur(5px) brightness(0.5) saturate(1.15)', t0: +(tw.t - 1).toFixed(2) })],
    ov: [flashIn, { type: 'vig', from: 0 }, { type: 'title', sub: 'Nowe AI', line: 'Rywale, którzy wreszcie umieją ścigać się w stawce', from: 0, to: 236, out: 14 }] });
  // 3. rozdziały przed / po
  shot('03-speedway-przed', 8, { views: [view(S.spOld, { type: 'heli', back: 24, up: 9, lead: 24 }, { t0: +(S.spOld.t - 1.6).toFixed(2) })],
    ov: [PRZED, { type: 'chapter', num: '01', title: 'Superspeedway', sub: 'Pociąg zderzak w zderzak przy ponad 300 km/h', from: 8, to: 228 }] });
  shot('04-speedway-po', 8, { views: [view(S.spNew, { type: 'heli', back: 24, up: 9, lead: 24 }, { t0: +(S.spNew.t - 1.6).toFixed(2) })],
    ov: [PO, ...statOv(stats.sp, 40, 238)] });
  const heliOval = { type: 'heli', back: 14, up: 6, lead: 16 };   // blisko, z góry: widać odstęp auta od bandy
  shot('05-owal-przed', 8, { views: [view(S.scOld, heliOval, { t0: +(S.scOld.t - 0.6).toFixed(2) })],
    ov: [PRZED, { type: 'chapter', num: '02', title: 'Owal 1,5 mili', sub: 'Koniec z jazdą na styk z bandą', from: 8, to: 228 }] });
  shot('06-owal-po', 8, { views: [view(S.scNew, heliOval)], ov: [PO, ...statOv(stats.sc, 40, 238)] });
  const heliRoad = { type: 'heli', back: 22, up: 11, lead: 16 };
  shot('07-drogowe-porownanie', 12, { layout: 'split', views: [view(S.rdOld, heliRoad, { t0: +(S.rdOld.t - 2).toFixed(2) }), view(S.rdNew, heliRoad, { t0: +(S.rdNew.t - 2).toFixed(2) })],
    ov: [Object.assign({ view: 0 }, PRZED), Object.assign({ view: 1 }, PO), { type: 'chapter', num: '03', title: 'Tory drogowe', sub: 'Ten sam start, ten sam zakręt', from: 8, to: 170 }, ...statOv(stats.rd, 180, 358)] });
  // 4. montaż nowego AI
  const chip = (text, beats) => [{ type: 'chip', text, from: 4, to: beats * BEAT - 4, in: 8, out: 6 }];
  const M = [
    [S.wide[0], { type: 'heli', back: 20, up: 6, lead: 26 }, 'Trzy rzędy przy 300 km/h', -1],
    [S.side[0], { type: 'heli', back: 12, up: 4.5, lead: 14 }, 'Koło w koło w zakręcie', -1.2],
    [S.pass[0], { type: 'heli', back: 13, up: 5, lead: 16 }, 'Czyste wyprzedzenie', 1.2],   // t kandydata = 2,6 s przed zmianą kolejności
    [S.pack[0], { type: 'heli', back: 20, up: 8, lead: 22 }, 'Krótki owal: ciasno, ale czysto', -0.5],
    [S.wide[1] || S.wide[0], { type: 'tripod', ahead: 150, d: -16, h: 3, size: 16 }, 'Tunel aerodynamiczny', 0],
    [S.side[1] || S.pass[1] || S.side[0], { type: 'game', mode: 3 }, 'Walka bez kontaktu', -1],
    [S.wide[2] || S.wide[0], { type: 'game', mode: 1 }, 'W środku pociągu', -0.5],
    [S.pack[2] || S.pack[1], { type: 'heli', back: 18, up: 7, lead: 22 }, 'Daytona: banking i szykany', -1],
  ].filter(m => m[0]);
  M.forEach(([cand, cam, text, dt], k) => shot(`08-montaz-${k + 1}`, 4, { views: [view(cand, cam, { t0: +(cand.t + dt).toFixed(2) })], ov: [...(k ? [{ type: 'flash', from: 0, len: 6, peak: 0.35 }] : [flashIn]), ...chip(text, 4)] }));
  // 5. liczby z benchmarku
  const rows = [
    { key: 'spins', label: 'Obroty' }, { key: 'contactsHard', label: 'Mocne kontakty' }, { key: 'chains', label: 'Karambole' },
    { key: 'wallHits', label: 'Uderzenia w ścianę' }, { key: 'scrapeT', label: 'Jazda po bandzie', unit: ' s' }, { key: 'grassT', label: 'Jazda po trawie', unit: ' s' }, { key: 'resets', label: 'Auta rozbite i cofnięte na tor' },
  ].map(r => Object.assign(r, { old: Math.round(sum(B.old, r.key)), new: Math.round(sum(B.new, r.key)) })).filter(r => r.old >= 5 && pct(r.old, r.new) <= -25).slice(0, 5);
  const races = B.new.length, tracks = new Set(B.new.map(r => r.track)).size, diffs = [...new Set(B.new.map(r => r.diff))].join(', ');
  const bg = S.pack[2] || S.pack[1] || S.wide[0];
  shot('09-liczby', 16, { views: [view(bg, { type: 'heli', back: 30, up: 12, lead: 30 }, { filter: 'blur(9px) brightness(0.32) saturate(0.9)', t0: +(bg.t + 3).toFixed(2) })],
    ov: [flashIn, { type: 'card', title: 'Nowe AI <span>w liczbach</span>', rows, stagger: 16, from: 0, to: 474, out: 12,
      foot: `Benchmark: ${races} wyścigów samych kierowców AI (${tracks} torów, poziomy ${diffs}), te same starty dla starego i nowego AI.` }] });
  // 6. zakończenie
  const oc = S.wide[1] || S.wide[0];
  shot('10-koniec', 10, { views: [view(oc, { type: 'heli', back: 34, up: 14, lead: 40 }, { t0: +(oc.t + 2).toFixed(2), filter: 'brightness(0.62)' })],
    ov: [flashIn, { type: 'vig', from: 0 }, { type: 'outro', cta: 'Zagraj teraz', sub: 'Nowe AI już na torze', from: 0 }, { type: 'black', from: 250, to: 300, fadeOut: 50 }] });
  return { shots, stats, rows };
}
// czas wideo [s], w którym symulacja przejdzie simT od początku ujęcia (przy zmiennej prędkości odtwarzania)
function videoTime(sp, simT) { let s = 0; for (let i = 0; i < 10000; i++) { s += speedAt(sp, i) / FPS; if (s >= simT) return i / FPS; } return 0; }
function speedAt(sp, i) {
  if (!sp || !sp.length) return 1;
  if (i <= sp[0][0]) return sp[0][1];
  for (let k = 1; k < sp.length; k++) if (i <= sp[k][0]) return sp[k - 1][1] + (sp[k][1] - sp[k - 1][1]) * (i - sp[k - 1][0]) / Math.max(1, sp[k][0] - sp[k - 1][0]);
  return sp[sp.length - 1][1];
}

// ─── 5. dźwięk ───
function soundtrack(shots, caps, name) {
  let at = 0; const parts = [], plan = { total: 0, bpm: 120, sections: [], hits: [], risers: [], whooshes: [], booms: [], ticks: [] };
  shots.forEach((s, k) => {
    const dur = s.frames / FPS, cap = caps[k];
    parts.push({ at, dur, files: cap.audio, sp: u => speedAt(s.views[0] && s.views[0].speed, u * FPS) });
    const kind = /otwarcie/.test(s.id) ? 'intro' : /tytul|liczby/.test(s.id) ? 'break' : /koniec/.test(s.id) ? 'outro' : /przed/.test(s.id) ? 'drive-dark' : /montaz/.test(s.id) ? 'montage' : 'drive';
    plan.sections.push({ from: at, to: at + dur, kind });
    if (/tytul|03-|montaz-1$|liczby|koniec/.test(s.id)) plan.hits.push(at);
    if (/tytul|montaz-1$/.test(s.id)) plan.risers.push([at - 2, at]);
    if (k && !/tytul|liczby|koniec/.test(s.id)) plan.whooshes.push(at);
    if (s.music && s.music.boom) plan.booms.push(at + s.music.boom);
    for (const o of s.ov || []) if (o.type === 'card') o.rows.forEach((r, n) => { for (let j = 0; j < 9; j++) plan.ticks.push(at + (o.from + 10 + n * (o.stagger || 14) + 8) / FPS + j * 0.075); });
    at += dur;
  });
  plan.total = at;
  log('dźwięk: muzyka i efekty…');
  SND.writeWav(path.join(WORK, `${name}-muzyka.wav`), SND.music(plan));
  SND.writeWav(path.join(WORK, `${name}-gra.wav`), SND.gameTrack(parts, at));
  return at;
}

// ─── 6. ffmpeg ───
function ff(a) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' }); }
function assemble(caps, name, outName, total) {
  const list = path.join(WORK, `${name}-lista.txt`);
  fs.writeFileSync(list, caps.map(c => `file '${c.file.replace(/\\/g, '/')}'`).join('\n'));
  const video = ['-f', 'concat', '-safe', '0', '-i', list];
  const venc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', String(FPS), '-g', '120', '-movflags', '+faststart'];
  const aenc = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'];
  const game = path.join(WORK, `${name}-gra.wav`), mus = path.join(WORK, `${name}-muzyka.wav`);
  log(`ffmpeg: ${outName}.mp4…`);
  ff([...video, '-i', game, '-i', mus, '-filter_complex', '[1:a]volume=0.85[g];[2:a]volume=0.8[m];[g][m]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.2:LRA=11[a]',
    '-map', '0:v', '-map', '[a]', ...venc, ...aenc, '-t', total.toFixed(3), path.join(OUT, `${outName}.mp4`)]);
  log(`ffmpeg: ${outName}-bez-muzyki.mp4…`);
  ff([...video, '-i', game, '-filter_complex', '[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]', '-map', '0:v', '-map', '[a]', ...venc, ...aenc, '-t', total.toFixed(3), path.join(OUT, `${outName}-bez-muzyki.mp4`)]);
}

(async () => {
  const t0 = Date.now();
  const B = { old: await bench(OLD), new: await bench(NEW) };
  const S = await scenes();
  const { shots, stats, rows } = edl(S, B);
  fs.writeFileSync(path.join(WORK, 'montaz.json'), JSON.stringify({ scenes: S, stats, rows, shots }, null, 1));
  log('statystyki:', JSON.stringify(stats), '\ntablica:', rows.map(r => `${r.label} ${r.old}→${r.new}`).join(', '));
  const formats = PREVIEW ? [['podglad', 960, 540, 'trailer-podglad']] : [['poziomo', 1920, 1080, 'trailer'], ...(flag('vertical') ? [['pionowo', 1080, 1920, 'trailer-pionowy']] : [])];
  for (const [name, w, h, outName] of formats) {
    const list = ONLY ? shots.filter(s => ONLY.some(o => s.id.startsWith(o))) : shots;
    log(`nagrywanie ${name} ${w}×${h}: ${list.length} ujęć, ${list.reduce((a, s) => a + s.frames, 0)} klatek…`);
    const caps = await captureShots(list, { repo: REPO, sims: SIMS, work: path.join(WORK, 'ujecia'), width: w, height: h, force: flag('force'), log });
    const bad = caps.flatMap(c => c.mismatch);
    if (bad.length) log('UWAGA: wyścig w przeglądarce rozjechał się z Node w: ' + bad.join('; '));
    if (ONLY) { log('ujęcia:\n' + caps.map(c => '  ' + c.file).join('\n')); continue; }
    const total = soundtrack(shots, caps, name);
    assemble(caps, name, outName, total);
    if (name !== 'pionowo') {
      // kadry: środek wybranych ujęć
      let at = 0; const mid = {};
      for (const s of shots) { mid[s.id] = at + s.frames / FPS * (/otwarcie/.test(s.id) ? 0.45 : /liczby/.test(s.id) ? 0.9 : 0.6); at += s.frames / FPS; }
      const pick = Object.keys(mid).filter(id => /otwarcie|tytul|speedway-po|drogowe|montaz-1$|montaz-2$|liczby|koniec/.test(id));
      pick.forEach((id, k) => ff(['-ss', mid[id].toFixed(3), '-i', path.join(OUT, `${outName}.mp4`), '-frames:v', '1', path.join(OUT, `kadr-${String(k + 1).padStart(2, '0')}-${id.replace(/^\d+-/, '')}.png`)]));
    }
  }
  log(`gotowe w ${((Date.now() - t0) / 60000).toFixed(1)} min → ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
