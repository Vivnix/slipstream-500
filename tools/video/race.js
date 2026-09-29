/* Wideo: wspólne dla Node (wyszukiwarka scen) i przeglądarki (nagrywarka) — wyścig samych AI złożony dokładnie jak w tools/aibench.js.
   Math.random jest podmieniany na ziarnisty mulberry32 tylko na czas budowy wyścigu i race.tick — grafika w przeglądarce losuje dalej
   prawdziwym Math.random, więc wyścig w grze zgadza się z wyścigiem w Node tick w tick. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.VideoRace = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // deterministyczny Math.random (mulberry32) — ten sam co w aibench.js
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const withRnd = (rnd, f) => { const real = Math.random; Math.random = rnd; try { return f(); } finally { Math.random = real; } };

  // spec: { track, diff, seed } — ziarno liczone jak w aibench.js, więc seed N to ten sam wyścig co w benchmarku
  function makeRace(Sim, spec) {
    const rnd = rng(spec.seed * 7919 + spec.diff * 131 + spec.track.length);
    const race = withRnd(rnd, () => {
      const r = new Sim.Race({ track: spec.track, laps: 999, difficulty: spec.diff, damage: 'simple', tires: 'normal', attract: true });
      for (const c of r.cars) { const sk = spec.diff >= 10 ? 10 : Sim.clamp(spec.diff + (Math.random() - 0.5) * 0.8, 1, 10); c.driver = new Sim.Driver(c, r, sk); }
      return r;
    });
    race.vRnd = rnd; race.vSim = Sim;
    return race;
  }
  // n kroków fizyki (1/240 s) z ziarnistym losowaniem
  function tickN(race, n, each) {
    const SUB = race.vSim.SUB;
    withRnd(race.vRnd, () => { for (let i = 0; i < n; i++) { race.tick(SUB); if (each) each(race); } });
  }
  // do chwili t [s od startu symulacji]
  function runTo(race, t, each) {
    const n = Math.round((t - race.t) / race.vSim.SUB);
    if (n > 0) tickN(race, n, each);
  }
  // odcisk stanu do sprawdzenia zgodności Node ↔ przeglądarka
  const fingerprint = race => race.cars.map(c => [c.number, +c.s.toFixed(3), +c.d.toFixed(3), +c.speed.toFixed(3)]);

  return { rng, makeRace, tickN, runTo, fingerprint };
});
