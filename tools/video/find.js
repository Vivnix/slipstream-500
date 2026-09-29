/* Wideo: wyszukiwarka scen — wyścigi samych AI bez grafiki (jak aibench.js), zapis przebiegu co 0,1 s i punktacja chwil:
   kraksy w stawce, jazda po bandzie, obroty na 1. okrążeniu (stare AI) oraz jazda trzema rzędami, koło w koło w zakręcie
   i czyste wyprzedzenia (nowe AI). Użycie z render.js: findScenes({ old: plik.js, new: plik.js }, opcje) → lista kandydatów. */
'use strict';
const path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const VR = require('./race.js');

const DT_S = 0.1;   // krok próbek przebiegu [s]

// ─── wątek: jeden wyścig, zapis przebiegu ───
function record({ simPath, track, diff, seed, maxT }) {
  const Sim = require(simPath), race = VR.makeRace(Sim, { track, diff, seed }), tr = race.track;
  const per = Math.round(DT_S / Sim.SUB), N = race.cars.length;
  const ev = [], samples = [];
  const touch = new Uint8Array(N), spinning = new Uint8Array(N);
  const origWalls = race.walls.bind(race);
  race.walls = c => { const vx = c.vx, vy = c.vy; origWalls(c); if (c.scrape > 0 && Math.hypot(c.vx - vx, c.vy - vy) > 0.05) touch[c.id] = 1; };
  let green = null;
  while (race.t < maxT) {
    VR.tickN(race, per);
    for (const e of race.events) {
      if (e.type === 'wall') ev.push({ k: 'wall', t: race.t, c: e.car.id, v: e.v });
      else if (e.type === 'contact') ev.push({ k: 'contact', t: race.t, c: e.a.id, o: e.b.id, v: e.v });
      else if (e.type === 'reset') ev.push({ k: 'reset', t: race.t, c: e.car.id });
      else if (e.type === 'green') green = race.t;
    }
    race.events.length = 0;
    const row = [];
    for (const c of race.cars) {
      const head = Math.abs(Sim.angDiff(c.psi, tr.frame(c.s).th)), slip = Math.abs(Math.atan2(c.v, Math.max(1, c.u)));
      const sp = c.status === 'racing' && !c.pit && (head > 0.6 || slip > 0.25) && c.speed > 5 ? 1 : 0;
      if (sp && !spinning[c.id]) ev.push({ k: 'spin', t: race.t, c: c.id });
      spinning[c.id] = sp;
      row.push([+c.s.toFixed(1), +c.d.toFixed(2), +c.prog.toFixed(1), +c.speed.toFixed(1), c.status === 'racing' && !c.pit ? 1 : 0, touch[c.id], sp, c.surface === 'grass' ? 1 : 0]);
      touch[c.id] = 0;
    }
    samples.push(row);
  }
  const k = [];
  for (let i = 0; i < tr.len; i += 5) k.push(+Math.abs(tr.frame(i).k || 0).toFixed(5));
  return { track, diff, seed, green, len: tr.len, halfW: tr.halfW, kind: tr.kind, numbers: race.cars.map(c => c.number), k, ev, samples };
}
if (!isMainThread && workerData && workerData.findJob) { parentPort.postMessage(record(workerData.findJob)); return; }

async function runAll(jobs, threads = os.cpus().length) {
  const out = new Array(jobs.length); let next = 0;
  const one = () => new Promise((res, rej) => {
    const i = next++; if (i >= jobs.length) return res(false);
    const w = new Worker(__filename, { workerData: { findJob: jobs[i] } });
    w.once('message', r => { out[i] = Object.assign(r, { sim: jobs[i].sim }); });
    w.once('error', rej); w.once('exit', () => res(true));
  });
  await Promise.all(Array.from({ length: Math.min(threads, jobs.length) }, async () => { while (await one()); }));
  return out;
}

// ─── punktacja ───
const idx = t => Math.max(0, Math.round(t / DT_S) - 1);
const curv = (run, s) => run.k[Math.floor(((s % run.len) + run.len) % run.len / 5) % run.k.length];
const sev = e => e.k === 'contact' ? Math.min(6, e.v / 3) : e.k === 'wall' ? Math.min(6, e.v / 4) : e.k === 'spin' ? 2.5 : 1.5;
const carsOf = e => e.o != null ? [e.c, e.o] : [e.c];

// kraksa: wiele aut z incydentami w oknie 6 s, blisko siebie na torze
function wrecks(run, { tMax = Infinity, W = 6 } = {}) {
  const out = [];
  const evs = run.ev.filter(e => e.t < tMax && (e.k !== 'contact' || e.v > 4) && (e.k !== 'wall' || e.v > 5));
  for (let i = 0; i < evs.length; i++) {
    const t0 = evs[i].t, inv = new Map();
    for (let j = i; j < evs.length && evs[j].t < t0 + W; j++) for (const c of carsOf(evs[j])) inv.set(c, Math.max(inv.get(c) || 0, sev(evs[j])));
    if (inv.size < 2) continue;
    const row = run.samples[idx(t0)], progs = [...inv.keys()].map(c => row[c][2]);
    if (Math.max(...progs) - Math.min(...progs) > 140) continue;
    const score = [...inv.values()].reduce((a, b) => a + b, 0) + inv.size;
    out.push({ kind: 'wreck', sim: run.sim, track: run.track, diff: run.diff, seed: run.seed, t: t0, focus: evs[i].c, cars: [...inv.keys()], score });
  }
  return dedupe(out, 12);
}

// jazda po bandzie: najdłuższe ciągi styku ze ścianą (przerwy ≤ 0,3 s), szybciej i w stawce = lepiej
function scrapes(run) {
  const out = [], N = run.numbers.length;
  for (let c = 0; c < N; c++) {
    let start = -1, gap = 0, n = 0;
    for (let i = 0; i <= run.samples.length; i++) {
      const on = i < run.samples.length && run.samples[i][c][5] && run.samples[i][c][4];
      if (on) { if (start < 0) { start = i; n = 0; } gap = 0; n++; }
      else if (start >= 0 && ++gap > 3) {
        const dur = n * DT_S, row = run.samples[start], me = row[c];
        const near = row.filter((r, j) => j !== c && r[4] && Math.abs(r[2] - me[2]) < 60).length;
        if (dur >= 0.8) out.push({ kind: 'scrape', sim: run.sim, track: run.track, diff: run.diff, seed: run.seed, t: (start + 1) * DT_S, focus: c, dur, score: Math.min(dur, 5) * (0.5 + me[3] / 80) + near * 0.3 });
        start = -1;
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// trzy rzędy: ≥3 auta w pasie 10 m wzdłuż toru, rozłożone w poprzek; im dłużej i im większa grupa wokół, tym lepiej
function threeWide(run) {
  const out = [];
  let prev = null, streak = 0;
  for (let i = 0; i < run.samples.length; i++) {
    const t = (i + 1) * DT_S; if (run.green == null || t < run.green + 10) continue;
    const row = run.samples[i], on = row.map((r, j) => [r, j]).filter(([r]) => r[4] && !r[6]);
    let best = null;
    for (const [a, ja] of on) {
      const grp = on.filter(([b]) => Math.abs(b[2] - a[2]) < 5.5).sort((x, y) => x[0][1] - y[0][1]);
      if (grp.length < 3) continue;
      let lanes = 1; for (let k = 1; k < grp.length; k++) if (grp[k][0][1] - grp[k - 1][0][1] > 2.2) lanes++;
      if (lanes < 3) continue;
      const pack = on.filter(([b]) => Math.abs(b[2] - a[2]) < 70).length;
      const sc = lanes * 2 + pack;
      if (!best || sc > best.sc) best = { sc, focus: grp[1][1] };
    }
    streak = best ? streak + 1 : 0;
    if (best && streak >= 8 && (!prev || t - prev.t > 6)) {
      const quiet = !run.ev.some(e => Math.abs(e.t - t) < 5);
      if (quiet) { prev = { kind: 'threewide', sim: run.sim, track: run.track, diff: run.diff, seed: run.seed, t: t - streak * DT_S, focus: best.focus, score: best.sc + streak * 0.2 }; out.push(prev); }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// koło w koło w zakręcie: para aut obok siebie przez ≥1,2 s w ostrym łuku, bez żadnego incydentu w pobliżu
function sideBySide(run) {
  const out = [], N = run.numbers.length, runLen = new Map();
  for (let i = 0; i < run.samples.length; i++) {
    const t = (i + 1) * DT_S, row = run.samples[i];
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
      const A = row[a], B = row[b], key = a * 64 + b;
      const ok = A[4] && B[4] && !A[6] && !B[6] && Math.abs(A[2] - B[2]) < 4.5 && Math.abs(A[1] - B[1]) > 1.9 && Math.abs(A[1] - B[1]) < 5.5 && curv(run, A[0]) > 1 / 180;
      const n = ok ? (runLen.get(key) || 0) + 1 : 0; runLen.set(key, n);
      if (n === 12) {
        const quiet = !run.ev.some(e => Math.abs(e.t - t) < 4 && (e.k !== 'wall' || e.v > 3));
        if (quiet) out.push({ kind: 'sidebyside', sim: run.sim, track: run.track, diff: run.diff, seed: run.seed, t: t - 3, focus: A[2] < B[2] ? a : b, other: A[2] < B[2] ? b : a, score: 3 + curv(run, A[0]) * 200 + (row.filter(r => r[4] && Math.abs(r[2] - A[2]) < 50).length) * 0.3 });
      }
    }
  }
  return dedupe(out.sort((a, b) => b.score - a.score), 8);
}

// wyprzedzenie: zmiana kolejności pary obok siebie (nie przez obrót/boks), cisza wokół
function overtakes(run) {
  const out = [], N = run.numbers.length, sign = new Map();
  for (let i = 0; i < run.samples.length; i++) {
    const t = (i + 1) * DT_S, row = run.samples[i];
    if (run.green == null || t < run.green + 2) continue;
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
      const A = row[a], B = row[b], key = a * 64 + b;
      if (!A[4] || !B[4] || A[6] || B[6] || Math.abs(A[2] - B[2]) > 25) { sign.delete(key); continue; }
      const sg = Math.sign(A[2] - B[2]), pv = sign.get(key);
      if (pv && sg && pv !== sg && Math.abs(A[1] - B[1]) > 1.6) {
        const quiet = !run.ev.some(e => Math.abs(e.t - t) < 3.5 && (e.k !== 'wall' || e.v > 3));
        const passer = sg > 0 ? a : b, k = curv(run, A[0]);
        if (quiet) out.push({ kind: 'overtake', sim: run.sim, track: run.track, diff: run.diff, seed: run.seed, t: t - 2.6, focus: passer, other: passer === a ? b : a, score: 2 + k * 150 + (run.kind === 'road' ? 2 : 0) + Math.min(3, Math.abs(A[1] - B[1])) * 0.3 });
      }
      if (sg) sign.set(key, sg);
    }
  }
  return dedupe(out.sort((a, b) => b.score - a.score), 8);
}

// ta sama chwila w drugim wyścigu (to samo ziarno = ta sama stawka i kolejność startowa): auto z tym numerem na tym samym miejscu toru
function aligned(runB, cand, runA) {
  const num = runA.numbers[cand.focus], c = runB.numbers.indexOf(num);
  if (c < 0) return null;
  const prog = runA.samples[idx(cand.t)][cand.focus][2];
  for (let i = 0; i < runB.samples.length; i++) if (runB.samples[i][c][2] >= prog) {
    const t = (i + 1) * DT_S;
    const incidents = runB.ev.filter(e => e.t > t - 1 && e.t < t + 7 && (e.k !== 'wall' || e.v > 3)).length;
    return { kind: 'aligned', sim: runB.sim, track: runB.track, diff: runB.diff, seed: runB.seed, t, focus: c, incidents };
  }
  return null;
}
// najczystszy odcinek wybranego auta blisko czasu t (bez styku ze ścianą i incydentów) — „po” dla jazdy po bandzie
function cleanNear(run, focus, t, dur = 5) {
  let best = null;
  for (let i = 0; i + dur / DT_S < run.samples.length; i += 5) {
    const t0 = (i + 1) * DT_S; if (run.green == null || t0 < run.green + 5) continue;
    let touch = 0, near = 0, hi = 0;
    for (let j = i; j < i + dur / DT_S; j++) { const r = run.samples[j], me = r[focus]; if (!me[4]) { touch += 99; break; } touch += r.reduce((a, x) => a + (Math.abs(x[2] - me[2]) < 80 ? x[5] : 0), 0); hi += me[1] > run.halfW - 4 ? 1 : 0; near += r.filter(x => x[4] && Math.abs(x[2] - me[2]) < 50).length; }
    const incidents = run.ev.some(e => e.t > t0 - 1 && e.t < t0 + dur + 1);
    const sc = -touch * 3 - (incidents ? 50 : 0) + near * 0.02 + hi * 0.03 - Math.abs(t0 - t) * 0.01;
    if (!best || sc > best.score) best = { kind: 'clean', sim: run.sim, track: run.track, diff: run.diff, seed: run.seed, t: t0, focus, score: sc, touch };
  }
  return best;
}

function dedupe(list, gap) {
  const out = [];
  for (const c of list.sort((a, b) => b.score - a.score)) if (!out.some(o => o.seed === c.seed && o.track === c.track && o.diff === c.diff && Math.abs(o.t - c.t) < gap)) out.push(c);
  return out;
}

module.exports = { runAll, record, wrecks, scrapes, threeWide, sideBySide, overtakes, aligned, cleanNear, DT_S };
