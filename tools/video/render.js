#!/usr/bin/env node
/* Wideo: zwiastun „Slipstream 500 · Nowe AI” — jedno polecenie od benchmarku do gotowych MP4.
   1) benchmark starego i nowego AI (tools/aibench.js, świeże liczby do napisów), 2) wyszukiwanie scen w wyścigach bez grafiki (find.js),
   3) montaż (lista ujęć poniżej), 4) nagrywanie klatka po klatce w Chrome bez okna (capture.js + director.html, sprawdzenie zgodności z Node),
   5) muzyka i efekty (sound.js) + dźwięk gry renderowany offline, 6) ffmpeg: trailer.mp4, trailer-bez-muzyki.mp4, [trailer-pionowy.mp4], kadry PNG,
   opis.txt (przypis o benchmarku do opisu filmu).
   Sceny nie mają wpisanych na sztywno czasów: wszystko wynika z przebiegów wyścigów (kraksy, gęstość stawki, chwile uderzeń),
   więc po zmianie sim.js wystarczy uruchomić render.js jeszcze raz.
   Użycie: node tools/video/render.js [--sim sim.js] [--old-rev e3dca2c | --old stary-sim.js] [--out katalog] [--work katalog-roboczy]
           [--vertical] (także wersja 1080×1920) [--preview] (960×540, z --vertical także 540×960 — szybki podgląd) [--only id,id] (tylko wybrane ujęcia, bez montażu)
           [--bench-seeds 5] [--scene-seeds 8] [--force] (bez cache: benchmark, przebiegi, sceny i ujęcia liczone od nowa)
   Wymaga: Node 24+, Chrome (albo zmienna CHROME), ffmpeg w PATH, internet (three.js i czcionki z CDN). */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), v8 = require('v8');
const { execFileSync, spawnSync } = require('child_process');
const F = require('./find.js'), { captureShots } = require('./capture.js'), SND = require('./sound.js');

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; }, flag = k => args.includes('--' + k);
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(arg('out', path.join(os.homedir(), 'Videos', 'Slipstream500-AI')));
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), 's500-video')));
const PREVIEW = flag('preview'), ONLY = arg('only') ? arg('only').split(',') : null;
const FPS = 60, BPM = 150, BEAT = 24;   // 150 BPM: ćwierćnuta = 24 klatki (całe klatki przy 60 fps), cięcia na siatce muzyki
const log = (...a) => console.log(...a);
const sha = x => crypto.createHash('sha1').update(x).digest('hex');
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
  const key = sha(files.map(x => fs.readFileSync(x)).join('|') + JSON.stringify(extra)).slice(0, 12);
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
// zaokrąglenie uczciwe: jeśli coś jeszcze zostało (n > 0), nigdy nie pokazujemy −100%
const pctR = (o, n) => { const p = Math.round(pct(o, n)); return n > 0 && p <= -100 ? -99 : p; };
const fmt = (x, dig = 0) => (Math.round(x * 10 ** dig) / 10 ** dig).toFixed(dig).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// pierwsza z kandydackich statystyk, która spadła o ≥30% (i nie jest znikoma) — gdy żadna, ujęcie idzie bez liczby
function pickStat(B, list) {
  for (const s of list) {
    const o = sum(B.old, s.key, s.f), n = sum(B.new, s.key, s.f);
    if (o >= (s.min || 4) && pct(o, n) <= -30) return { key: s.key, grp: s.grp || s.key, value: pctR(o, n), label: s.label, detail: `${fmt(o, s.dig)}${s.unit || ''} → ${fmt(n, s.dig)}${s.unit || ''} · ${s.where}`, o, n };
  }
  return null;
}

// ─── 2. sceny ───
// przebiegi wyścigów (zapis co 0,1 s) w cache per wyścig — zmiana punktacji scen nie wymaga liczenia wyścigów od nowa
async function runsCached(jobs) {
  const dir = path.join(WORK, 'przebiegi'); fs.mkdirSync(dir, { recursive: true });
  const rec = sha(String(F.record) + fs.readFileSync(path.join(__dirname, 'race.js')));
  const simH = Object.fromEntries(Object.entries(SIMS).map(([k, f]) => [k, sha(fs.readFileSync(f))]));
  const files = jobs.map(j => path.join(dir, sha(rec + simH[j.sim] + JSON.stringify([j.track, j.diff, j.seed, j.maxT])).slice(0, 16) + '.bin'));
  const todo = jobs.map((j, i) => i).filter(i => flag('force') || !fs.existsSync(files[i]));
  if (todo.length) {
    log(`sceny: ${todo.length} wyścigów bez grafiki…`);
    const res = await F.runAll(todo.map(i => jobs[i]));
    res.forEach((r, k) => fs.writeFileSync(files[todo[k]], v8.serialize(r)));
  }
  return files.map(f => v8.deserialize(fs.readFileSync(f)));
}
function scenes() {
  return cached('sceny', [OLD, NEW, path.join(__dirname, 'find.js'), path.join(__dirname, 'race.js')], [arg('scene-seeds', 8), String(findScenes), String(packMoment)], findScenes);
}
const MIN_PACK = 6;   // „po” ma pokazać stawkę: co najmniej tyle aut w ±45 m od auta w kadrze
async function findScenes() {
  const S = +arg('scene-seeds', 8), jobs = [];
  const add = (sim, track, diffs, maxT, seeds = S) => { for (const diff of diffs) for (let seed = 1; seed <= seeds; seed++) jobs.push({ sim, simPath: SIMS[sim], track, diff, seed, maxT }); };
  for (const sim of ['old', 'new']) { add(sim, 'speedway', [10], 170); add(sim, 'intermediate', [10], 120); add(sim, 'indy', [7, 10], 110); add(sim, 'daytona', [7, 10], 110); }
  add('new', 'short', [10], 90, 4);
  const runs = await runsCached(jobs);
  const get = (sim, track, diff, seed) => runs.find(r => r.sim === sim && r.track === track && r.diff === diff && r.seed === seed);
  const runOf = c => get(c.sim, c.track, c.diff, c.seed);
  const all = (sim, tracks) => runs.filter(r => r.sim === sim && tracks.includes(r.track));
  const best = l => l.sort((a, b) => b.score - a.score);
  const dens = c => +F.density(runOf(c), c.t, c.focus).toFixed(1);
  // para „przed/po”: ta sama chwila w nowym AI (to samo ziarno, to samo miejsce toru), bez incydentów i ze zbitą stawką
  const pairsOf = wr => wr.map(w => ({ w, a: F.aligned(get('new', w.track, w.diff, w.seed), w, get('old', w.track, w.diff, w.seed)) }))
    .filter(p => p.a && p.a.incidents === 0).map(p => Object.assign(p, { dens: dens(p.a) }));
  const out = {};
  // kraksy starego AI na superspeedwayu: najlepsza na otwarcie
  const wr = best(all('old', ['speedway']).flatMap(r => F.wrecks(r)));
  out.cold = wr[0];
  const sp = pairsOf(wr.filter(w => w !== out.cold));
  const spPick = sp.find(p => p.dens >= MIN_PACK && p.w.seed !== out.cold.seed) || sp.find(p => p.dens >= MIN_PACK) || sp.sort((a, b) => b.dens - a.dens)[0] || { w: wr[1] || wr[0], a: null, dens: 0 };
  out.spOld = spPick.w;
  // montaż nowego AI
  const distinct = (l, n) => { const o = []; for (const c of l) if (!o.some(x => x.seed === c.seed && x.track === c.track && x.diff === c.diff)) { o.push(c); if (o.length >= n) break; } return o; };
  out.wide = distinct(best(all('new', ['speedway']).flatMap(r => F.threeWide(r))), 5);
  out.side = distinct(best(all('new', ['indy', 'daytona']).flatMap(r => F.sideBySide(r))), 4);
  out.pass = distinct(best(runs.filter(r => r.sim === 'new').flatMap(r => F.overtakes(r))).filter(c => c.t > 8), 4);
  out.pack = ['short', 'intermediate', 'daytona'].map(tr => packMoment(runs.filter(r => r.sim === 'new' && r.track === tr && r.diff === 10))).filter(Boolean);
  // „po” na superspeedwayu: odpowiednik ze zbitą stawką, a gdy żadnej kraksy nie da się tak zestawić — jazda trzema rzędami
  out.spNew = spPick.a && spPick.dens >= MIN_PACK ? spPick.a : out.wide[0] ? Object.assign({}, out.wide.shift(), { alt: true }) : spPick.a || { sim: 'new', track: out.spOld.track, diff: out.spOld.diff, seed: out.spOld.seed, t: out.spOld.t, focus: out.spOld.focus };
  // jazda po bandzie (owal 1,5 mili) i to samo auto w nowym AI w czystym fragmencie
  const sc = best(all('old', ['intermediate']).flatMap(r => F.scrapes(r)));
  out.scOld = sc[0];
  { const ro = get('old', sc[0].track, sc[0].diff, sc[0].seed), rn = get('new', sc[0].track, sc[0].diff, sc[0].seed); out.scNew = F.cleanNear(rn, rn.numbers.indexOf(ro.numbers[sc[0].focus]), sc[0].t, 4.5); }
  // tory drogowe: karambol na 1. okrążeniu i ta sama chwila w nowym AI (stawka zbita, zero incydentów)
  const rw = best(all('old', ['indy', 'daytona']).flatMap(r => F.wrecks(r, { tMax: r.green + 100 }).filter(w => w.cars.length >= 3)));
  const rp = pairsOf(rw);
  const rdPick = rp.find(p => p.dens >= MIN_PACK) || rp.sort((a, b) => b.dens - a.dens)[0]
    || { w: rw[0], a: F.aligned(get('new', rw[0].track, rw[0].diff, rw[0].seed), rw[0], get('old', rw[0].track, rw[0].diff, rw[0].seed)) };
  out.rdOld = rdPick.w; out.rdNew = rdPick.a;
  // w „po” kamera jedzie za autem, które ma przed sobą najwięcej stawki (ta sama chwila i to samo miejsce toru)
  for (const k of ['spNew', 'rdNew']) if (out[k] && out[k].kind === 'aligned') Object.assign(out[k], F.chaseFocus(runOf(out[k]), out[k].t, out[k].focus));
  // chwile uderzeń przy aucie w kadrze (dźwięk zgrzytu, wstrząs, zwolnienie) i gęstość stawki — dla każdego kandydata
  for (const c of Object.values(out).flat()) if (c && runOf(c)) { c.hits = F.eventsNear(runOf(c), c.focus, c.t - 4, c.t + 14); c.dens = dens(c); }
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
      if ((!bestM || n > bestM.n) && !r.ev.some(e => Math.abs(e.t - t) < 5)) bestM = { kind: 'pack', sim: 'new', track: r.track, diff: r.diff, seed: r.seed, t, focus: c, n };
    }
  }
  return bestM;
}

// ─── 3. montaż ───
const view = (c, cam, extra = {}) => Object.assign({ sim: c.sim, spec: { track: c.track, diff: c.diff, seed: c.seed }, t0: +c.t.toFixed(2), focus: c.focus, cam, audio: true }, extra);
function speedAt(sp, i) {
  if (!sp || !sp.length) return 1;
  if (i <= sp[0][0]) return sp[0][1];
  for (let k = 1; k < sp.length; k++) if (i <= sp[k][0]) return sp[k - 1][1] + (sp[k][1] - sp[k - 1][1]) * (i - sp[k - 1][0]) / Math.max(1, sp[k][0] - sp[k - 1][0]);
  return sp[sp.length - 1][1];
}
// czas symulacji [s od t0 ujęcia] po klatce f / klatka, w której symulacja przejdzie simT (przy zmiennej prędkości odtwarzania)
function simAt(sp, f) { let s = 0; for (let i = 0; i <= f; i++) s += speedAt(sp, i) / FPS; return s; }
function frameAt(sp, simT) { let s = 0; for (let i = 0; i < 20000; i++) { s += speedAt(sp, i) / FPS; if (s >= simT - 1e-9) return i; } return 0; }
// kluczowe uderzenie kraksy: pierwsze z najmocniejszych (kontakt albo ściana, nie sam obrót) w 6 s od początku — do niego
// dopasowujemy zwolnienie, błysk i wstrząs; lekkie otarcia i obroty przed nim widać w pierwszej sekundzie ujęcia
const firstHit = c => {
  const l = (c.hits || []).filter(h => h.k !== 'spin' && h.t >= c.t - 0.2 && h.t <= c.t + 6), g = Math.max(0, ...l.map(h => h.g));
  return l.find(h => h.g >= g * 0.9) || { t: c.t, g: 0.6 };
};
// zgrzyty i wstrząsy w klatkach ujęcia dla uderzeń przy aucie w kadrze
function evFx(v, cand, frames, gain = 1) {
  const crunch = [], shakes = [];
  for (const h of cand.hits || []) {
    if (h.k === 'spin' || h.t < v.t0) continue;
    const f = frameAt(v.speed, h.t - v.t0);
    if (f >= frames - 6 || crunch.some(([g]) => Math.abs(g - f) < 8) || crunch.length >= 6) continue;
    crunch.push([f, +(h.g * gain).toFixed(2)]); shakes.push([f, +(0.3 + h.g * 0.7).toFixed(2)]);
  }
  return { crunch, shakes };
}
// chwila akcji względem t kandydata (trzy rzędy od początku, koło w koło ok. 2,4 s, zmiana kolejności 2,6 s po t)
const KEY = { threewide: 0.8, sidebyside: 2.4, overtake: 2.6 };
const actionT0 = (c, frames, speed) => +(c.t + (KEY[c.kind] || 0) - frames / FPS * speed * 0.45).toFixed(2);

function edl(S, B, P) {
  const shots = [], used = [], b = n => n * BEAT;
  const shot = (id, beats, o) => { const s = Object.assign({ id, layout: 'full', frames: b(beats), mus: 'drive' }, o); s.sfx = Object.assign({ hits: [], booms: [], crunch: [], drops: [], rolls: [], risers: [], fills: [] }, o.sfx); s.ov = [{ type: 'vig', from: 0 }, ...(s.ov || [])]; shots.push(s); return s; };
  const same = (a, c) => a.sim === c.sim && a.track === c.track && a.diff === c.diff && a.seed === c.seed && Math.abs(a.t - c.t) < 8;
  // kolejny niewykorzystany kandydat z list (ujęcia montażu się nie powtarzają, dopóki starczy scen)
  const take = (...lists) => { for (const l of lists) for (const c of l || []) if (c && !used.some(u => same(u, c))) { used.push(c); return c; } return lists.flat().find(Boolean); };
  [S.cold, S.spOld, S.spNew, S.scOld, S.scNew, S.rdOld, S.rdNew].forEach(c => c && used.push(c));

  // liczby z benchmarku: jedna przy superspeedwayu, trzy na koniec — każda inna (bez powtarzania tej samej liczby)
  const stats = {
    sp: pickStat(B, [
      { key: 'wallHard', grp: 'wall', label: 'mocnych uderzeń w ścianę', where: 'superspeedway, poziom 10', f: r => r.track === 'speedway' && r.diff === 10, min: 3 },
      { key: 'contacts', grp: 'contact', label: 'kontaktów w pociągu', where: 'superspeedway', f: r => r.track === 'speedway' },
      { key: 'spins', grp: 'spins', label: 'obrotów', where: 'superspeedway', f: r => r.track === 'speedway' }]),
  };
  const SLAM = [{ key: 'spins', label: 'obrotów' }, { key: 'chains', label: 'karamboli' }, { key: 'scrapeT', grp: 'scrape', label: 'jazdy po bandzie', unit: ' s', min: 20 },
    { key: 'contactsHard', grp: 'contact', label: 'mocnych kontaktów' }, { key: 'wallHits', grp: 'wall', label: 'uderzeń w ścianę' }, { key: 'grassT', label: 'jazdy po trawie', unit: ' s', min: 20 }, { key: 'resets', label: 'rozbitych aut' }];
  const slams = SLAM.filter(s => !stats.sp || (s.grp || s.key) !== stats.sp.grp).map(s => Object.assign({}, s, { o: sum(B.old, s.key), n: sum(B.new, s.key) }))
    .filter(s => s.o >= (s.min || 5) && pct(s.o, s.n) <= -30).slice(0, 3).map(s => Object.assign(s, { value: pctR(s.o, s.n) }));

  const PRZED = { type: 'tag', kind: 'before', text: 'Przed', sub: 'stare AI', from: 0 }, PO = { type: 'tag', kind: 'after', text: 'Po', sub: 'nowe AI', from: 0 };
  const CH = (num, title) => ({ type: 'chapter', num, title, from: 0, to: 58, out: 6 });
  const redHit = (f, view) => [{ type: 'flash', from: f, len: 12, peak: 0.45, color: '#e5484d', view }, { type: 'shake', from: f, len: 12, amp: 0.9 }];

  // ── 1. zimne otwarcie: błysk ze środka kraksy, potem statyw tuż przy torze, stawka nadjeżdża, uderzenie i zwolnienie ──
  const c = S.cold, h0 = firstHit(c);
  shot('00-zapowiedz', 0.5, { mus: 'intro', views: [view(c, { type: 'heli', back: 9, up: 3, lead: 6, fov: 58, punch: 1.35, punchLen: 12 }, { t0: +(h0.t + 0.5).toFixed(2), speed: [[0, 0.3]] })],
    ov: [{ type: 'shake', from: 0, len: 12, amp: 1.2 }], sfx: { hits: [[0, 0.8]] } });
  const sp1 = [[0, 1], [30, 1], [36, 0.15], [100, 0.15], [118, 1], [150, 1.5]], F1 = 36, n1 = b(7.5);
  const v1 = view(c, { type: 'tripod', ahead: 120, edge: -1, off: 1.5, h: 2.5, size: 7 }, { t0: +(h0.t - simAt(sp1, F1)).toFixed(2), speed: sp1 });
  const fx1 = evFx(v1, c, n1); v1.shakes = fx1.shakes;
  shot('01-otwarcie', 7.5, { mus: 'intro', views: [v1],
    ov: [{ type: 'flash', from: 0, len: 8, peak: 1 }, { type: 'bars', from: 0, h: 0.1 }, { type: 'flash', from: F1, len: 8, peak: 0.6 }, { type: 'shake', from: F1, len: 16, amp: 1.5 },
      { type: 'punch', text: 'Kraksa za kraksą', small: 'Stare AI', color: 'red', pos: 'tl', from: F1, to: n1 - 24, out: 8 }],
    sfx: { booms: [F1], crunch: fx1.crunch } });
  // ── 2. tytuł: wbity w kadr na uderzeniu ──
  const tw = take(S.wide);
  shot('02-tytul', 4, { mus: 'title', gameGain: 0.35, views: [view(tw, { type: 'track', back: 6, side: 3.5, h: 0.8, lead: 14, fov: 72 }, { t0: actionT0(tw, b(4), 1.3), speed: [[0, 1.3]], filter: 'blur(3px) brightness(0.42)' })],
    ov: [{ type: 'flash', from: 0, len: 10, peak: 1 }, { type: 'speed', from: 0, op: 0.22 }, { type: 'title', sub: 'Nowe AI', from: 0, to: b(4), out: 3 }, { type: 'shake', from: 0, len: 12, amp: 1.6 }],
    sfx: { hits: [[0, 1]] } });

  // ── 3. przed / po: uderzenie w starym AI ok. 1,2 s po cięciu, zwolnienie, czerwony błysk; to samo miejsce w nowym AI ──
  const low = { type: 'heli', back: 10, up: 3.4, lead: 12, fov: 66 };
  const so = S.spOld, h3 = firstHit(so), sp3 = [[0, 1], [64, 1], [72, 0.3], [124, 0.3], [136, 1.2]], F3 = 72;
  const v3 = view(so, low, { t0: +(h3.t - simAt(sp3, F3)).toFixed(2), speed: sp3 }), fx3 = evFx(v3, so, b(8)); v3.shakes = fx3.shakes;
  shot('03-speedway-przed', 8, { views: [v3], ov: [PRZED, CH('01', 'Superspeedway'), ...redHit(F3)], sfx: { crunch: fx3.crunch, hits: [[F3, 0.5]] } });
  const sn = S.spNew, t4 = sn.alt ? actionT0(sn, b(6), 1.15) : sn.t - (so.t - v3.t0);
  shot('04-speedway-po', 6, { views: [view(sn, Object.assign({ punch: 1.2 }, low), { t0: +t4.toFixed(2), speed: [[0, 1.15]] })],
    ov: [PO, ...(stats.sp ? [{ type: 'stat', value: stats.sp.value, unit: '%', label: stats.sp.label, from: b(1), to: b(6) - 3, out: 4, pos: 'top', x: 0.68 }] : [])],
    sfx: { hits: stats.sp ? [[b(1), 0.7]] : [] } });
  // owal: nisko na bandzie — auto starego AI szoruje o ścianę tuż pod kamerą; nowe AI przejeżdża z odstępem
  const sc = S.scOld, wallCam = { type: 'tripod', aheadT: 1.5, wall: sc.side || 1, off: -0.6, h: 2.3, size: 5, maxFov: 70 };
  const sp5 = [[0, 1], [70, 1], [80, 0.3], [150, 0.3], [162, 1]];
  const v5 = view(sc, wallCam, { t0: +(sc.t - 0.3).toFixed(2), speed: sp5 });
  shot('05-owal-przed', 8, { views: [v5], ov: [PRZED, CH('02', 'Owal 1,5 mili')], sfx: { hits: [[b(3), 0.45]] } });
  const scn = S.scNew;
  shot('06-owal-po', 6, { views: [view(scn, wallCam, { t0: +scn.t.toFixed(2) })],
    ov: [PO, ...(scn.touch === 0 ? [{ type: 'punch', text: 'Z dala od bandy.', small: 'Nowe AI', color: 'green', pos: P ? 'bl' : 'tr', from: b(1), to: b(6) - 3, out: 4 }] : [])], sfx: { hits: [[b(1), 0.6]] } });
  // tory drogowe: poziomo obok siebie (lewa połowa zwalnia przy uderzeniu), pionowo jedno po drugim
  const ro = S.rdOld, rn = S.rdNew, h7 = firstHit(ro), cam7 = { type: 'heli', back: 14, up: 6, lead: 14, fov: 62 };
  const clean7 = rn.incidents === 0 ? [{ type: 'punch', text: 'Zero kontaktu.', small: 'Nowe AI', color: 'green', pos: P ? 'bl' : 'tr' }] : [];
  const toMontage = n => ({ rolls: [[b(n - 4), b(n - 1)]], drops: [[b(n - 1), b(n)]], risers: [[b(n - 6), b(n - 1)]] });   // werbel, narastanie i ćwierćnuta ciszy przed montażem
  if (!P) {
    const sp7 = [[0, 1], [66, 1], [72, 0.2], [200, 0.2], [215, 1]], F7 = 72;
    const vo = view(ro, cam7, { t0: +(h7.t - simAt(sp7, F7)).toFixed(2), speed: sp7 }), fx7 = evFx(vo, ro, b(12)); vo.shakes = fx7.shakes;
    const vn = view(rn, cam7, { t0: +(rn.t - (ro.t - vo.t0)).toFixed(2) });
    shot('07-drogowe-porownanie', 12, { layout: 'split', views: [vo, vn],
      ov: [Object.assign({ view: 0 }, PRZED), Object.assign({ view: 1 }, PO), CH('03', 'Tory drogowe'), ...redHit(F7, 0), ...clean7.map(o => Object.assign(o, { from: b(4), to: b(11), out: 4 }))],
      sfx: Object.assign({ crunch: fx7.crunch, hits: [[F7, 0.5], ...(clean7.length ? [[b(4), 0.55]] : [])] }, toMontage(12)) });
  } else {
    const sp7 = [[0, 1], [44, 1], [50, 0.25], [110, 0.25], [122, 1]], F7 = 50;
    const vo = view(ro, cam7, { t0: +(h7.t - simAt(sp7, F7)).toFixed(2), speed: sp7 }), fx7 = evFx(vo, ro, b(6)); vo.shakes = fx7.shakes;
    shot('07a-drogowe-przed', 6, { views: [vo], ov: [PRZED, CH('03', 'Tory drogowe'), ...redHit(F7)], sfx: { crunch: fx7.crunch, hits: [[F7, 0.5]] } });
    shot('07b-drogowe-po', 6, { views: [view(rn, Object.assign({ punch: 1.2 }, cam7), { t0: +(rn.t - (ro.t - vo.t0)).toFixed(2) })],
      ov: [PO, ...clean7.map(o => Object.assign(o, { from: b(1), to: b(5), out: 4 }))], sfx: Object.assign({ hits: clean7.length ? [[b(1), 0.55]] : [] }, toMontage(6)) });
  }

  // ── 4. montaż nowego AI: coraz krótsze ujęcia, nisko i szybko; uderzenie na każdym cięciu ──
  const trackR = { type: 'track', back: 5, side: 3, h: 0.6, lead: 12, fov: 75 }, trackL = Object.assign({}, trackR, { side: -3 });
  const heliLow = { type: 'heli', back: 8, up: 2.5, lead: 12, fov: 68 }, hood = { type: 'game', mode: 2 };
  const M = [
    [[S.wide], trackR, 6, 1.4, 'Trzy rzędy.'],
    [[S.side], heliLow, 4, 1.3, 'Koło w koło.'],
    [[S.pass], trackL, 4, 1.4, 'Czyste wyprzedzenie.'],
    [[S.pack], heliLow, 2, 1.5],
    [[S.side, S.pass], hood, 2, 1.3],
    [[S.wide], trackL, 2, 1.5],
    [[S.pass, S.side], heliLow, 1, 1.6],
    [[S.pack, S.wide], trackR, 1, 1.6],
    [[S.wide, S.side], hood, 1, 1.5],
    [[S.side, S.pass, S.pack], trackR, 1, 1.6],
  ];
  M.forEach(([lists, cam, beats, speed, chip], k) => {
    const cand = take(...lists); if (!cand) return;
    const n = b(beats), dir = k % 2 ? -1 : 1;
    const cm = Object.assign({ punch: beats >= 4 ? 1.25 : 1.15, punchLen: beats >= 2 ? 10 : 6 }, cam, k ? { whip: dir * (beats >= 2 ? 9 : 6) } : {});
    shot(`08-montaz-${k + 1}`, beats, { mus: 'montage', views: [view(cand, cm, { t0: actionT0(cand, n, speed), speed: [[0, speed]] })],
      ov: [k ? (beats >= 4 ? { type: 'flash', from: 0, len: 4, peak: 0.85 } : { type: 'blur', from: 0, len: 6, px: 30 }) : { type: 'flash', from: 0, len: 12, peak: 1 },
        { type: 'speed', from: 0, op: beats >= 2 ? 0.28 : 0.4 }, ...(k ? [] : [{ type: 'shake', from: 0, len: 14, amp: 1.4 }]),
        ...(chip ? [{ type: 'chip', text: chip, from: 3, to: n - 3, in: 6, out: 5 }] : [])],
      sfx: { hits: [[0, k ? (beats >= 2 ? 0.6 : 0.45) : 1]], fills: beats >= 4 ? [[n - BEAT, n]] : [] } });
  });
  // ── 5. liczby: trzy wbicia na cały kadr, po jednym na uderzenie ──
  slams.forEach((s, k) => {
    const bg = take(S.pack, S.wide, S.side, S.pass);
    shot(`09-liczba-${k + 1}`, 3, { mus: 'slam', gameGain: 0.45, views: [view(bg, k % 2 ? trackL : heliLow, { t0: actionT0(bg, b(3), 1.4), speed: [[0, 1.4]], filter: 'brightness(0.36) blur(2px)' })],
      ov: [{ type: 'flash', from: 0, len: 7, peak: 0.9 }, { type: 'speed', from: 0, op: 0.3 }, { type: 'slam', value: s.value, unit: '%', label: s.label, from: 0 }, { type: 'shake', from: 0, len: 10, amp: 1.3 }],
      sfx: { hits: [[0, 0.9]] } });
  });
  // ── 6. logo na uderzeniu, hasło, twarde cięcie do czerni z basem ──
  const last = shots[shots.length - 1]; last.sfx.drops.push([last.frames - BEAT, last.frames]);   // ćwierćnuta ciszy przed logo
  const oc = take(S.pack, S.wide);
  shot('10-koniec', 9, { mus: 'outro', gameGain: 0, views: [view(oc, heliLow, { t0: actionT0(oc, b(6), 1.2), speed: [[0, 1.2]], filter: 'brightness(0.3) blur(5px)' })],
    ov: [{ type: 'flash', from: 0, len: 10, peak: 1 }, { type: 'title', sub: 'Nowe AI', line: 'Ścigają się.|Nie rozbijają.', lineAt: b(2), from: 0, to: b(6) - 1, out: 1 },
      { type: 'shake', from: 0, len: 12, amp: 1.8 }, { type: 'shake', from: b(2), len: 10, amp: 1.1 }, { type: 'black', from: b(6) }],
    sfx: { hits: [[0, 1], [b(2), 0.8]], booms: [b(6)], drops: [[b(5), b(9)]] } });
  return { shots, stats, slams };
}

// ─── 5. dźwięk ───
function soundtrack(shots, caps, name) {
  let at = 0; const parts = [], crunch = [], plan = { total: 0, bpm: BPM, sections: [], hits: [], risers: [], whooshes: [], booms: [], drops: [], rolls: [], fills: [] };
  shots.forEach((s, k) => {
    const dur = s.frames / FPS, x = s.sfx || {}, T = f => at + f / FPS;
    parts.push({ at, dur, files: caps[k].audio, gain: s.gameGain, sps: (s.views || []).map(v => u => speedAt(v.speed, u * FPS)) });
    plan.sections.push({ from: at, to: at + dur, kind: s.mus || 'drive', n: k });
    for (const [f, g] of x.hits || []) plan.hits.push([T(f), g]);
    for (const f of x.booms || []) plan.booms.push(T(f));
    for (const [f, g] of x.crunch || []) crunch.push([T(f), g]);
    for (const key of ['drops', 'rolls', 'risers', 'fills']) for (const [a, c] of x[key] || []) plan[key].push([T(a), T(c)]);
    if (k && !(x.hits || []).some(([f]) => f < 3)) plan.whooshes.push(at);
    at += dur;
  });
  plan.total = at;
  log('dźwięk: muzyka i efekty…');
  SND.writeWav(path.join(WORK, `${name}-muzyka.wav`), SND.music(plan));
  SND.writeWav(path.join(WORK, `${name}-gra.wav`), SND.gameTrack(parts, at, crunch));
  return at;
}

// ─── 6. ffmpeg ───
function ff(a) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' }); }
// głośność: pomiar EBU R128 miksu, potem jedno stałe wzmocnienie + limiter — dynamika zostaje (montaż głośniej niż objaśnienia),
// zamiast loudnorm w trybie dynamicznym, który spłaszcza całość
function loudness(inputs, chain) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...inputs, '-filter_complex', `${chain},loudnorm=I=-14:TP=-1.2:print_format=json[a]`, '-map', '[a]', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.stderr || ''); if (!m) throw new Error('pomiar głośności: ' + (r.stderr || '').slice(-400));
  return JSON.parse(m[0]);
}
function assemble(caps, name, outName, total) {
  const list = path.join(WORK, `${name}-lista.txt`);
  fs.writeFileSync(list, caps.map(c => `file '${c.file.replace(/\\/g, '/')}'`).join('\n'));
  const video = ['-f', 'concat', '-safe', '0', '-i', list];
  const venc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', String(FPS), '-g', '120', '-movflags', '+faststart'];
  const aenc = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'];
  const game = path.join(WORK, `${name}-gra.wav`), mus = path.join(WORK, `${name}-muzyka.wav`);
  for (const [suffix, target, auds, pre] of [['', -14, [game, mus], '[A0]volume=0.8[g];[A1]volume=0.85[m];[g][m]amix=inputs=2:normalize=0:duration=first'], ['-bez-muzyki', -16, [game], '[A0]anull']]) {
    const m = loudness(auds.flatMap(f => ['-i', f]), pre.replace(/\[A(\d)\]/g, '[$1:a]'));
    const gain = (target - +m.input_i).toFixed(2);
    log(`ffmpeg: ${outName}${suffix}.mp4… (miks ${(+m.input_i).toFixed(1)} LUFS, LRA ${m.input_lra} → wzmocnienie ${gain} dB)`);
    ff([...video, ...auds.flatMap(f => ['-i', f]), '-filter_complex', `${pre.replace(/\[A(\d)\]/g, (_, d) => `[${+d + 1}:a]`)},volume=${gain}dB,alimiter=limit=0.84:attack=1:release=80:level=disabled[a]`,
      '-map', '0:v', '-map', '[a]', ...venc, ...aenc, '-t', total.toFixed(3), path.join(OUT, `${outName}${suffix}.mp4`)]);
  }
}

// przypis do opisu filmu: skąd liczby
function description(B, stats, slams) {
  const races = B.new.length, tracks = new Set(B.new.map(r => r.track)).size, diffs = [...new Set(B.new.map(r => r.diff))].join(', ');
  const lines = ['Slipstream 500 — nowe AI rywali', '',
    `Liczby w filmie pochodzą z benchmarku: ${races} wyścigów samych kierowców AI (${tracks} torów, poziomy trudności ${diffs}), te same starty dla starego i nowego AI.`, ''];
  if (stats.sp) lines.push(`• ${stats.sp.value}% ${stats.sp.label}: ${stats.sp.detail}`);
  for (const s of slams) lines.push(`• ${s.value}% ${s.label}: ${fmt(s.o, s.unit ? 0 : 0)}${s.unit || ''} → ${fmt(s.n)}${s.unit || ''} (wszystkie tory)`);
  lines.push('', 'Wszystkie ujęcia to prawdziwe wyścigi w grze, nagrane klatka po klatce; „przed” = poprzednia wersja AI na tym samym starcie.');
  return lines.join('\n') + '\n';
}

(async () => {
  const t0 = Date.now();
  const B = { old: await bench(OLD), new: await bench(NEW) };
  const S = await scenes();
  const L = edl(S, B, false);
  fs.writeFileSync(path.join(WORK, 'montaz.json'), JSON.stringify({ scenes: S, stats: L.stats, slams: L.slams, shots: L.shots }, null, 1));
  log('statystyki:', JSON.stringify(L.stats), '\nliczby na koniec:', L.slams.map(s => `${s.label} ${Math.round(s.o)}→${Math.round(s.n)} (${s.value}%)`).join(', '));
  log('gęstość stawki „po”:', ['spNew', 'scNew', 'rdNew'].map(k => `${k} ${S[k] && S[k].dens}`).join(', '));
  fs.writeFileSync(path.join(OUT, 'opis.txt'), description(B, L.stats, L.slams));
  const formats = PREVIEW ? [['podglad', 960, 540, 'trailer-podglad'], ...(flag('vertical') ? [['podglad-pionowo', 540, 960, 'trailer-podglad-pionowy']] : [])]
    : [['poziomo', 1920, 1080, 'trailer'], ...(flag('vertical') ? [['pionowo', 1080, 1920, 'trailer-pionowy']] : [])];
  for (const [name, w, h, outName] of formats) {
    const { shots } = edl(S, B, h > w);
    const list = ONLY ? shots.filter(s => ONLY.some(o => s.id.startsWith(o))) : shots;
    log(`nagrywanie ${name} ${w}×${h}: ${list.length} ujęć, ${list.reduce((a, s) => a + s.frames, 0)} klatek (${(shots.reduce((a, s) => a + s.frames, 0) / FPS).toFixed(1)} s całość)…`);
    const caps = await captureShots(list, { repo: REPO, sims: SIMS, work: path.join(WORK, 'ujecia'), width: w, height: h, force: flag('force'), log });
    const bad = caps.flatMap(c => c.mismatch);
    if (bad.length) log('UWAGA: wyścig w przeglądarce rozjechał się z Node w: ' + bad.join('; '));
    if (ONLY) { log('ujęcia:\n' + caps.map(c => '  ' + c.file).join('\n')); continue; }
    const total = soundtrack(shots, caps, name);
    assemble(caps, name, outName, total);
    // kadry: wybrane chwile ujęć
    let at = 0; const mid = {};
    for (const s of shots) { mid[s.id] = at + s.frames / FPS * (/otwarcie/.test(s.id) ? 0.3 : /tytul/.test(s.id) ? 0.7 : /koniec/.test(s.id) ? 0.45 : 0.55); at += s.frames / FPS; }
    const pick = Object.keys(mid).filter(id => /otwarcie|tytul|speedway-przed|speedway-po|owal-przed|drogowe|montaz-1$|montaz-2$|liczba-1|koniec/.test(id));
    const tag = /pionowo/.test(name) ? 'pion-' : '';
    pick.forEach((id, k) => ff(['-ss', mid[id].toFixed(3), '-i', path.join(OUT, `${outName}.mp4`), '-frames:v', '1', path.join(OUT, `kadr-${tag}${String(k + 1).padStart(2, '0')}-${id.replace(/^\d+[ab]?-/, '')}.png`)]));
  }
  log(`gotowe w ${((Date.now() - t0) / 60000).toFixed(1)} min → ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
