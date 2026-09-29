#!/usr/bin/env node
/* Benchmark AI: wyścigi samych kierowców AI bez grafiki, liczy uderzenia w bandy, kontakty, obroty, resety, DNF i czasy okrążeń,
   początki serii kontaktów (chains: styk aut, które przez 3 s nikogo nie dotykały) i wyprzedzenia (passes: zmiany kolejności par aut na torze).
   --verbose: przy każdym styku stan obu aut (tryb AI, pas, cel boczny, granice sideLimit, prędkość boczna).
   Użycie: node tools/aibench.js [--tracks a,b] [--diff 1,5,10] [--seeds 3] [--laps N] [--damage simple|full|none] [--tires normal|off|fast] [--solo] [--json] [--verbose]
           [--jobs N] (wyścigi równolegle w wątkach, domyślnie liczba rdzeni) [--save plik.json] [--base plik.json] (porównanie z zapisanym wynikiem) [--sim plik.js] */
'use strict';
const path = require('path'), os = require('os'), fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; }, flag = k => args.includes('--' + k);
// --sim plik.js: inna wersja symulacji (np. wyjęta z gita) — porównanie bez przełączania kodu
const Sim = require(arg('sim') ? path.resolve(arg('sim')) : path.join(__dirname, '..', 'sim.js'));
const TRACKS = (arg('tracks') || Object.keys(Sim.TRACKS).join(',')).split(',');
const DIFFS = (arg('diff') || '3,7,10').split(',').map(Number);
const SEEDS = +arg('seeds', 2), LAPS = arg('laps'), DAMAGE = arg('damage', 'simple'), TIRES = arg('tires', 'normal');
const SOLO = flag('solo'), VERBOSE = flag('verbose'), JSONOUT = flag('json'), MAXT = +arg('maxt', 1200);

// deterministyczny Math.random (mulberry32)
function seedRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function runRace(track, diff, seed) {
  seedRandom(seed * 7919 + diff * 131 + track.length);
  const def = Sim.TRACKS[track];
  const laps = LAPS ? +LAPS : def.lapsOpt[0];
  // attract: 10 aut AI, bez gracza; wyścig do pełnych okrążeń liczymy sami
  const race = new Sim.Race({ track, laps: 999, difficulty: diff, damage: DAMAGE, tires: TIRES, attract: true });
  if (SOLO) { race.cars = race.cars.slice(0, 1); race.order = race.cars.slice(); }
  // attract = rozrzut umiejętności ±1,5 — tutaj stawka ma dokładnie zadany poziom (jak w prawdziwym wyścigu przy 10+)
  for (const c of race.cars) { const sk = diff >= 10 ? 10 : Sim.clamp(diff + (Math.random() - 0.5) * 0.8, 1, 10); c.driver = new Sim.Driver(c, race, sk); }
  const tr = race.track, st = {
    track, diff, seed, wallHits: 0, wallHard: 0, wallMaxV: 0, contacts: 0, contactsHard: 0, resets: 0, dnf: 0, spins: 0, grassT: 0,
    lapTimes: [], bestLap: Infinity, lineTime: race.lines[race.bestLine].time, hitsAt: [], simT: 0, pitStops: 0,
  };
  const spinning = new Set(), passSign = new Map(), passRes = new Map();
  st.passes = 0; st.contactsAt = []; st.spinsAt = [];
  // każdy styk z bandą (także lekkie otarcia poniżej progu zdarzenia 'wall')
  st.scrapes = 0; st.scrapeT = 0; st.scrapesAt = [];
  const inWall = new Map(), origWalls = race.walls.bind(race);
  race.walls = c => {
    const vx = c.vx, vy = c.vy; origWalls(c);
    const dv = Math.hypot(c.vx - vx, c.vy - vy), touching = c.scrape > 0 && dv > 0.05;
    if (touching) { st.scrapeT += Sim.SUB; if (!inWall.get(c)) { st.scrapes++; if (VERBOSE) st.scrapesAt.push({ t: +race.t.toFixed(1), car: c.number, s: Math.round(c.s), d: +c.d.toFixed(1), spd: Math.round(c.speed * 3.6), mode: c.driver.mode, pit: !!c.pit, dv: +dv.toFixed(2), sinceContact: c.lastContact != null ? +(race.t - c.lastContact).toFixed(1) : null, side: +Math.min(99, ...race.cars.filter(o => o !== c && o.status !== 'out' && Math.abs(tr.ds(c.s, o.s)) < 6).map(o => Math.abs(o.d - c.d))).toFixed(1) }); } }
    inWall.set(c, touching);
  };
  // stan obu aut przy styku: tryb AI, pas, cel boczny, granice sideLimit, prędkość boczna — widać manewr, który zaczął kraksę
  const dr = x => ({ n: x.number, mode: x.driver.mode, mT: +x.driver.modeT.toFixed(1), lane: x.driver.lane == null ? null : +x.driver.lane.toFixed(1), d: +x.d.toFixed(1), dS: +x.driver.dS.toFixed(1), lo: +Math.max(-99, x.driver.lo).toFixed(1), hi: +Math.min(99, x.driver.hi).toFixed(1), v: +x.speed.toFixed(1), draft: +x.draft.toFixed(2), psi: +Sim.angDiff(x.psi, tr.frame(x.s).th).toFixed(2), vd: +(x.vx * tr.frame(x.s).nx + x.vy * tr.frame(x.s).ny).toFixed(2), sk: +x.driver.skill.toFixed(1), pit: !!x.pit });
  const pairInfo = (kind, a, b, v) => { const [r, f] = tr.ds(a.s, b.s) > 0 ? [a, b] : [b, a]; return { kind, t: +race.t.toFixed(1), v: +v.toFixed(1), s: Math.round(r.s), turn: tr.inTurn(r.s), ds: +tr.ds(r.s, f.s).toFixed(1), dd: +(f.d - r.d).toFixed(1), rear: dr(r), front: dr(f) }; };
  // początek serii: styk dwóch aut, z których żadne nie dotykało nikogo przez 3 s (także lekki, poniżej progu zdarzenia 'contact')
  st.chains = 0;
  const origPair = race.carPair.bind(race), fresh = x => x.lastContact == null || race.t - x.lastContact > 3;
  race.carPair = (A, B) => {
    const f = fresh(A) && fresh(B), vx = A.vx, vy = A.vy; origPair(A, B);
    if (f && A.lastContact === race.t) { const v = 1.7 * Math.hypot(A.vx - vx, A.vy - vy); if (v > 1.5) { st.chains++; if (VERBOSE) st.contactsAt.push(pairInfo('first', A, B, v)); } }
  };
  // reset: stan auta tuż przed postawieniem z powrotem na tor (prędkość, kąt do osi toru, tryb AI, czas od ostatniego styku)
  st.resetsAt = [];
  const origReset = race.resetCar.bind(race);
  race.resetCar = c => { if (VERBOSE) st.resetsAt.push({ t: +race.t.toFixed(1), car: c.number, s: Math.round(c.s), d: +c.d.toFixed(1), spd: Math.round(c.speed * 3.6), head: +Sim.angDiff(c.psi, tr.frame(c.s).th).toFixed(2), mode: c.driver.mode, surf: c.surface, sinceContact: c.lastContact != null ? +(race.t - c.lastContact).toFixed(1) : null }); return origReset(c); };
  const dt = Sim.SUB;
  let t = 0;
  const target = laps * tr.len;
  while (t < MAXT) {
    race.tick(dt); t += dt;
    for (const e of race.events) {
      if (e.type === 'wall') {
        st.wallHits++; if (e.v > 12) st.wallHard++; st.wallMaxV = Math.max(st.wallMaxV, e.v);
        const c = e.car, dr = c.driver;
        st.hitsAt.push({ t: +race.t.toFixed(1), car: c.number, s: Math.round(c.s), d: +c.d.toFixed(1), v: +e.v.toFixed(1), spd: Math.round(c.speed * 3.6), mode: dr.mode, lane: dr.lane == null ? null : +dr.lane.toFixed(1), dS: +dr.dS.toFixed(1), pit: !!c.pit, lastContact: c.lastContact != null ? +(race.t - c.lastContact).toFixed(1) : null });
      } else if (e.type === 'contact') {
        st.contacts++; if (e.v > 8) st.contactsHard++;
        if (VERBOSE) st.contactsAt.push(pairInfo('contact', e.a, e.b, e.v));
      }
      else if (e.type === 'reset') st.resets++;
      else if (e.type === 'dnf') st.dnf++;
      else if (e.type === 'pitstop') st.pitStops++;
    }
    race.events.length = 0;
    // wyprzedzenia: zmiana kolejności pary aut jadących po torze (bez boksu, resetu i aut poza wyścigiem)
    if (race.sub % 24 === 0 && race.phase !== 'pace') {
      const on = c => c.status === 'racing' && !c.pit;
      for (const a of race.cars) for (const b of race.cars) {
        if (a.id >= b.id) continue;
        const key = a.id * 64 + b.id;
        if (!on(a) || !on(b) || a.resets + b.resets !== passRes.get(key)) { passSign.delete(key); passRes.set(key, a.resets + b.resets); continue; }
        const sg = Math.sign(a.prog - b.prog), prev = passSign.get(key);
        if (prev && sg && prev !== sg && Math.abs(a.prog - b.prog) < 60) st.passes++;
        if (sg) passSign.set(key, sg);
      }
    }
    // obrót: kąt znoszenia nadwozia (nos względem kierunku jazdy) — nie kierunek osi toru: linia wyścigowa sama potrafi
    // przeciąć oś pod dużym kątem (indy, wyjście z R15 ~0,58 rad), a auto jedzie wtedy czysto; koniec obrotu dopiero poniżej 0,12 rad
    if (race.sub % 24 === 0) for (const c of race.cars) {
      if (c.status !== 'racing' || c.pit) continue;
      const slip = Math.abs(Math.atan2(c.v, Math.max(1, c.u)));
      if (slip > 0.25 && c.speed > 5) { if (!spinning.has(c)) { spinning.add(c); st.spins++; if (VERBOSE) st.spinsAt.push({ t: +race.t.toFixed(1), car: c.number, s: Math.round(c.s), d: +c.d.toFixed(1), spd: Math.round(c.speed * 3.6), mode: c.driver.mode, sinceContact: c.lastContact != null ? +(race.t - c.lastContact).toFixed(1) : null }); } } else if (slip < 0.12 || c.speed <= 5) spinning.delete(c);
      if (c.surface === 'grass') st.grassT += dt * 24;
    }
    // koniec: pierwszy auto, które przejechało zadany dystans od zielonej flagi
    if (race.phase !== 'pace' && race.cars.some(c => c.prog >= target)) break;
  }
  st.simT = +t.toFixed(1);
  for (const c of race.cars) {
    for (const lt of c.laps) st.lapTimes.push(lt);
    if (c.bestLap < st.bestLap) st.bestLap = c.bestLap;
  }
  const lt = st.lapTimes.filter(x => x > 0).sort((a, b) => a - b);
  st.medLap = lt.length ? lt[Math.floor(lt.length / 2)] : NaN;
  st.finished = race.cars.filter(c => c.status === 'racing').length;
  st.laps = laps;
  return st;
}

// wątek roboczy: jeden wyścig
if (!isMainThread) {
  const st = runRace(workerData.track, workerData.diff, workerData.seed);
  if (!isFinite(st.bestLap)) st.bestLap = null;
  parentPort.postMessage(st);
  return;
}

const JOBS = Math.max(1, +arg('jobs', os.cpus().length));
const KEYS = ['scrapeT', 'wallHits', 'wallHard', 'contacts', 'contactsHard', 'spins', 'resets', 'dnf', 'grassT', 'chains', 'passes'];
const fmtLine = st => `${st.track.padEnd(13)} d${String(st.diff).padEnd(3)} s${st.seed}  scrapes ${String(st.scrapes).padStart(5)} ${st.scrapeT.toFixed(1).padStart(5)}s  walls ${String(st.wallHits).padStart(3)} (hard ${String(st.wallHard).padStart(2)}, max ${st.wallMaxV.toFixed(1).padStart(4)})  contacts ${String(st.contacts).padStart(3)} (hard ${String(st.contactsHard).padStart(2)})  spins ${String(st.spins).padStart(2)}  resets ${String(st.resets).padStart(2)}  dnf ${st.dnf}  grass ${st.grassT.toFixed(1).padStart(5)}s  best ${st.bestLap.toFixed(2)} med ${st.medLap.toFixed(2)} line ${st.lineTime.toFixed(2)}  pits ${st.pitStops}  chains ${st.chains}  passes ${st.passes}  [${st.wall}ms]`;

// podsumowanie tor × poziom: sumy incydentów z seedów, średnia strata najlepszego / medianowego okrążenia do linii idealnej [%]
function summarize(all) {
  const g = new Map();
  for (const st of all) {
    const key = st.track + ' d' + st.diff;
    if (!g.has(key)) g.set(key, { n: 0, bestGap: 0, medGap: 0, ...Object.fromEntries(KEYS.map(k => [k, 0])) });
    const r = g.get(key); r.n++;
    for (const k of KEYS) r[k] += st[k] || 0;
    r.bestGap += (st.bestLap / st.lineTime - 1) * 100; r.medGap += (st.medLap / st.lineTime - 1) * 100;
  }
  for (const r of g.values()) { r.bestGap /= r.n; r.medGap /= r.n; }
  return g;
}
function printSummary(all, base) {
  const S = summarize(all), B = base ? summarize(base) : null;
  const delta = (v, b, dig) => ` (${v - b >= 0 ? '+' : ''}${(v - b).toFixed(dig)})`;
  console.log('\nSUMMARY  (sumy z seedów; best% / med% = strata do linii idealnej)');
  for (const [key, r] of S) {
    const b = B && B.get(key);
    const col = (k, dig = 0, w = 4) => r[k].toFixed(dig).padStart(w) + (b ? delta(r[k], b[k], dig).padEnd(9) : '');
    console.log(`${key.padEnd(17)} scrapeT ${col('scrapeT', 1, 6)} walls ${col('wallHits')} hard ${col('wallHard')} contacts ${col('contacts')} hard ${col('contactsHard')} spins ${col('spins')} resets ${col('resets')} dnf ${col('dnf')} grass ${col('grassT', 1, 5)} chains ${col('chains')} best% ${col('bestGap', 2, 5)} med% ${col('medGap', 2, 5)} passes ${col('passes')}`);
  }
  const tot = a => Object.fromEntries(KEYS.map(k => [k, a.reduce((s, x) => s + (x[k] || 0), 0)]));
  const T = tot(all), TB = base && tot(base), dig = k => k.endsWith('T') ? 1 : 0;
  console.log('\nTOTAL  ' + KEYS.map(k => `${k} ${T[k].toFixed(dig(k))}${TB ? delta(T[k], TB[k], dig(k)) : ''}`).join('  '));
}

(async () => {
  const jobs = [];
  for (const track of TRACKS) for (const diff of DIFFS) for (let seed = 1; seed <= SEEDS; seed++) jobs.push({ track, diff, seed });
  const all = new Array(jobs.length), t0 = Date.now();
  let next = 0;
  const runOne = () => new Promise((res, rej) => {
    const i = next++; if (i >= jobs.length) return res(false);
    const t1 = Date.now(), w = new Worker(__filename, { argv: process.argv.slice(2), workerData: jobs[i] });
    w.once('message', st => { st.wall = Date.now() - t1; if (st.bestLap == null) st.bestLap = Infinity; all[i] = st; });
    w.once('error', rej);
    w.once('exit', () => res(true));
  });
  await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, async () => { while (await runOne()); }));
  if (JSONOUT) return console.log(JSON.stringify(all, null, 1));
  for (const st of all) {
    console.log(fmtLine(st));
    if (VERBOSE) { for (const h of st.hitsAt) console.log('    hit', JSON.stringify(h)); for (const h of st.scrapesAt) console.log('    scrape', JSON.stringify(h)); for (const h of st.contactsAt) console.log('    contact', JSON.stringify(h)); for (const h of st.spinsAt) console.log('    spin', JSON.stringify(h)); for (const h of st.resetsAt) console.log('    reset', JSON.stringify(h)); }
  }
  const basePath = arg('base');
  printSummary(all, basePath ? JSON.parse(fs.readFileSync(basePath, 'utf8')) : null);
  const savePath = arg('save');
  if (savePath) fs.writeFileSync(savePath, JSON.stringify(all.map(({ hitsAt, scrapesAt, contactsAt, spinsAt, resetsAt, ...s }) => s)));
  console.log(`\n${jobs.length} wyścigów, ${JOBS} wątków, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
})();
