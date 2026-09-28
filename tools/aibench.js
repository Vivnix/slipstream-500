#!/usr/bin/env node
/* Benchmark AI: wyścigi samych kierowców AI bez grafiki, liczy uderzenia w bandy, kontakty, obroty, resety, DNF i czasy okrążeń.
   Użycie: node tools/aibench.js [--tracks a,b] [--diff 1,5,10] [--seeds 3] [--laps N] [--damage simple|full|none] [--tires normal|off|fast] [--solo] [--json] [--verbose] */
'use strict';
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'sim.js'));

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; }, flag = k => args.includes('--' + k);
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
  const spinning = new Set();
  // każdy styk z bandą (także lekkie otarcia poniżej progu zdarzenia 'wall')
  st.scrapes = 0; st.scrapeT = 0; st.scrapesAt = [];
  const inWall = new Map(), origWalls = race.walls.bind(race);
  race.walls = c => {
    const vx = c.vx, vy = c.vy; origWalls(c);
    const dv = Math.hypot(c.vx - vx, c.vy - vy), touching = c.scrape > 0 && dv > 0.05;
    if (touching) { st.scrapeT += Sim.SUB; if (!inWall.get(c)) { st.scrapes++; if (VERBOSE) st.scrapesAt.push({ t: +race.t.toFixed(1), car: c.number, s: Math.round(c.s), d: +c.d.toFixed(1), spd: Math.round(c.speed * 3.6), mode: c.driver.mode, pit: !!c.pit, dv: +dv.toFixed(2), sinceContact: c.lastContact != null ? +(race.t - c.lastContact).toFixed(1) : null }); } }
    inWall.set(c, touching);
  };
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
      } else if (e.type === 'contact') { st.contacts++; if (e.v > 8) st.contactsHard++; }
      else if (e.type === 'reset') st.resets++;
      else if (e.type === 'dnf') st.dnf++;
      else if (e.type === 'pitstop') st.pitStops++;
    }
    race.events.length = 0;
    if (race.sub % 24 === 0) for (const c of race.cars) {
      if (c.status !== 'racing' || c.pit) continue;
      const head = Math.abs(Sim.angDiff(c.psi, tr.frame(c.s).th)), slip = Math.abs(Math.atan2(c.v, Math.max(1, c.u)));
      if ((head > 0.6 || slip > 0.25) && c.speed > 5) { if (!spinning.has(c)) { spinning.add(c); st.spins++; } } else spinning.delete(c);
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

const all = [];
for (const track of TRACKS) for (const diff of DIFFS) for (let seed = 1; seed <= SEEDS; seed++) {
  const t0 = Date.now();
  const st = runRace(track, diff, seed);
  st.wall = Date.now() - t0;
  all.push(st);
  if (!JSONOUT) {
    console.log(`${track.padEnd(13)} d${String(diff).padEnd(3)} s${seed}  scrapes ${String(st.scrapes).padStart(3)} ${st.scrapeT.toFixed(1).padStart(4)}s  walls ${String(st.wallHits).padStart(3)} (hard ${String(st.wallHard).padStart(2)}, max ${st.wallMaxV.toFixed(1).padStart(4)})  contacts ${String(st.contacts).padStart(3)} (hard ${String(st.contactsHard).padStart(2)})  spins ${String(st.spins).padStart(2)}  resets ${String(st.resets).padStart(2)}  dnf ${st.dnf}  grass ${st.grassT.toFixed(1).padStart(5)}s  best ${st.bestLap.toFixed(2)} med ${st.medLap.toFixed(2)} line ${st.lineTime.toFixed(2)}  pits ${st.pitStops}  [${st.wall}ms]`);
    if (VERBOSE) { for (const h of st.hitsAt) console.log('    hit', JSON.stringify(h)); for (const h of st.scrapesAt) console.log('    scrape', JSON.stringify(h)); }
  }
}
if (JSONOUT) console.log(JSON.stringify(all, null, 1));
else {
  const sum = k => all.reduce((a, s) => a + s[k], 0);
  console.log(`\nTOTAL  scrapeT ${sum('scrapeT').toFixed(1)}s  walls ${sum('wallHits')} (hard ${sum('wallHard')})  contacts ${sum('contacts')} (hard ${sum('contactsHard')})  spins ${sum('spins')}  resets ${sum('resets')}  dnf ${sum('dnf')}  grass ${sum('grassT').toFixed(1)}s`);
}
