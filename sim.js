/* Slipstream 500 — symulacja: tor, fizyka samochodu, aerodynamika, uszkodzenia i AI.
   Brak zależności od DOM — działa w przeglądarce (window.Sim) i w Node (module.exports). */
(function (root, factory) {
  const Sim = factory();
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = 9.81, AIR = 1.225, PI = Math.PI, DEG = PI / 180;
  const SUB = 1 / 240;                       // krok fizyki
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  const mod = (a, n) => ((a % n) + n) % n;

  // Każdy samochód jest fizycznie identyczny. Poziom trudności NIE zmienia tych liczb.
  const CAR = {
    mass: 1550, iz: 2900, a: 1.34, b: 1.45, h: 0.46,
    length: 5.2, width: 1.95,
    mu: 1.08, rearMu: 1.05, loadSens: 0.11,
    B: 24, C: 1.45,                          // Pacejka (szczyt ~4,5° kąta znoszenia)
    crr: 0.013, brakeMu: 0.95, brakeFront: 0.64,
    aeroFront: 0.42,
    maxDrive: 8200,                          // moment × przełożenie / promień koła — limit siły przy małej prędkości
  };
  CAR.wb = CAR.a + CAR.b;
  const NF0 = CAR.mass * G * CAR.b / CAR.wb, NR0 = CAR.mass * G * CAR.a / CAR.wb;
  const PEAK_SLIP = Math.tan(PI / (2 * CAR.C)) / CAR.B;

  const TRACKS = {
    speedway: {
      id: 'speedway', name: 'Superspeedway', tag: '2,5 mili · 31°',
      blurb: 'Gaz do dechy przez całe okrążenie. Samotnie jesteś wolny — w pociągu tunelu aerodynamicznego leci się o kilkanaście km/h szybciej.',
      L: 1000, R: 325, W: 20, bankTurn: 31, bankStraight: 4, prog: 3, apron: 9, grass: 40,
      power: 388000, cdA: 0.95, clA: 1.9, vGear: 200, transition: 240, laps: 8, pace: 40,
    },
    intermediate: {
      id: 'intermediate', name: 'Owal 1,5 mili', tag: '1,47 mili · 22°',
      blurb: 'Tu trzeba odpuszczać gaz na wejściu. Brudne powietrze za rywalem zabiera docisk przodu, auto zaczyna „pchać” w zakręcie.',
      L: 520, R: 210, W: 17, bankTurn: 22, bankStraight: 5, prog: 3, apron: 8, grass: 30,
      power: 500000, cdA: 1.0, clA: 2.9, vGear: 90, transition: 160, laps: 12, pace: 35,
    },
    short: {
      id: 'short', name: 'Krótki owal', tag: '0,54 mili · 26°',
      blurb: 'Pół mili ścisku. Hamowanie przed każdym zakrętem, dopychanie zderzakiem i walka o dolną linię.',
      L: 190, R: 78, W: 15, bankTurn: 26, bankStraight: 7, prog: 2, apron: 6, grass: 16,
      power: 500000, cdA: 1.0, clA: 2.9, vGear: 60, transition: 70, laps: 25, pace: 25,
    },
  };

  // ───────────────────────────── TOR ─────────────────────────────
  class Track {
    constructor(def) {
      Object.assign(this, def);
      this.len = 2 * this.L + 2 * PI * this.R;
      this.halfW = this.W / 2;
      this.outerWall = this.halfW + 0.3;
      this.innerWall = -(this.halfW + this.apron + this.grass);
      this.bT = this.bankTurn * DEG; this.bS = this.bankStraight * DEG; this.bP = this.prog * DEG;
      const PR = PI * this.R;
      this.turns = [[this.L / 2, this.L / 2 + PR], [1.5 * this.L + PR, this.len - this.L / 2]];
    }
    geom(sg) {
      const L = this.L, R = this.R, PR = PI * R;
      if (sg < L) return { x: -L / 2 + sg, y: -R, th: 0, nx: 0, ny: -1, arc: 0 };
      sg -= L;
      if (sg < PR) { const t = -PI / 2 + sg / R, c = Math.cos(t), s = Math.sin(t); return { x: L / 2 + R * c, y: R * s, th: t + PI / 2, nx: c, ny: s, arc: 1 }; }
      sg -= PR;
      if (sg < L) return { x: L / 2 - sg, y: R, th: PI, nx: 0, ny: 1, arc: 0 };
      sg -= L;
      const t = PI / 2 + sg / R, c = Math.cos(t), s = Math.sin(t);
      return { x: -L / 2 + R * c, y: R * s, th: t + PI / 2, nx: c, ny: s, arc: 1 };
    }
    frame(s) { return this.geom(mod(s + this.L / 2, this.len)); }
    toWorld(s, d) { const f = this.frame(s); return { x: f.x + f.nx * d, y: f.y + f.ny * d }; }
    toLocal(x, y) {
      const L = this.L, R = this.R, PR = PI * R; let sg, d;
      if (x >= -L / 2 && x <= L / 2) {
        if (y < 0) { sg = x + L / 2; d = -y - R; }
        else { sg = L + PR + (L / 2 - x); d = y - R; }
      } else if (x > L / 2) {
        const dx = x - L / 2; sg = L + (Math.atan2(y, dx) + PI / 2) * R; d = Math.hypot(dx, y) - R;
      } else {
        const dx = x + L / 2; let t = Math.atan2(y, dx); if (t < 0) t += 2 * PI;
        sg = 2 * L + PR + (t - PI / 2) * R; d = Math.hypot(dx, y) - R;
      }
      return { s: mod(sg - L / 2, this.len), d };
    }
    turnFactor(s) {
      let best = 0;
      for (const [a, b] of this.turns) {
        const p = mod(s - a, this.len), span = b - a;
        const inside = p <= span ? Math.min(p, span - p) : -Math.min(p - span, this.len - p);
        best = Math.max(best, smooth(clamp(inside / this.transition + 0.5, 0, 1)));
      }
      return best;
    }
    inTurn(s) { for (const [a, b] of this.turns) { if (mod(s - a, this.len) <= b - a) return true; } return false; }
    bank(s, d) {
      if (d < -this.halfW) return 0;
      const f = this.turnFactor(s), t = clamp((d + this.halfW) / this.W, 0, 1);
      return lerp(this.bS, this.bT, f) + this.bP * f * (t - 0.5);
    }
    height(s, d) {
      if (d < -this.halfW) return 0;
      const f = this.turnFactor(s), dd = Math.min(d, this.halfW) + this.halfW, t = dd / this.W;
      return dd * Math.tan(lerp(this.bS, this.bT, f) + this.bP * f * (t / 2 - 0.5));
    }
    curvature(s, d) { return this.frame(s).arc ? 1 / (this.R + d) : 0; }
    // znakowana odległość wzdłuż toru b względem a, w zakresie [-len/2, len/2]
    ds(a, b) { let x = b - a; if (x > this.len / 2) x -= this.len; else if (x < -this.len / 2) x += this.len; return x; }
  }

  // ─────────────────────── MODEL OPON / NOŚNOŚCI ───────────────────────
  function tireMu(N, N0) { return clamp(1 - CAR.loadSens * (N / N0 - 1), 0.6, 1.15); }
  function driveForce(tr, u, powerMul) { return Math.min(CAR.maxDrive * powerMul, tr.power * powerMul / Math.max(u, 1)); }
  function pacejka(alpha) { return Math.sin(CAR.C * Math.atan(CAR.B * alpha)); }

  // zapas przyczepności bocznej w ustalonym zakręcie (to samo co w fizyce, w wersji „stacjonarnej”)
  function latMargin(tr, v, k, beta, grip, dfMul) {
    const m = CAR.mass, q = 0.5 * AIR * v * v, aIn = v * v * k;
    const sb = Math.sin(beta), cb = Math.cos(beta);
    const Nb = m * (G * cb + aIn * sb), DF = tr.clA * q * dfMul;
    const Nf = Nb * CAR.b / CAR.wb + DF * CAR.aeroFront, Nr = Nb * CAR.a / CAR.wb + DF * (1 - CAR.aeroFront);
    const need = Math.abs(m * (aIn - G * sb * cb));
    const capF = CAR.mu * grip * tireMu(Nf, NF0) * Nf;
    const capR0 = CAR.mu * CAR.rearMu * grip * tireMu(Nr, NR0) * Nr, drag = tr.cdA * q;
    const capR = Math.sqrt(Math.max(0, capR0 * capR0 - drag * drag));
    return Math.min(capF - need * CAR.b / CAR.wb, capR - need * CAR.a / CAR.wb);
  }
  function cornerSpeed(tr, k, beta, grip = 1, dfMul = 1) {
    if (k < 1e-5) return 200;
    let lo = 5, hi = 160;
    if (latMargin(tr, hi, k, beta, grip, dfMul) >= 0) return 200;
    for (let i = 0; i < 28; i++) { const v = (lo + hi) / 2; if (latMargin(tr, v, k, beta, grip, dfMul) >= 0) lo = v; else hi = v; }
    return lo;
  }

  // ───────────────────────────── SAMOCHÓD ─────────────────────────────
  class Car {
    constructor(o) {
      Object.assign(this, o);
      this.x = 0; this.y = 0; this.psi = 0; this.vx = 0; this.vy = 0; this.r = 0;
      this.delta = 0; this.throttle = 0; this.brake = 0;
      this.cmd = { delta: 0, throttle: 0, brake: 0 };
      this.ctl = { steer: 0, throttle: 0, brake: 0 };
      this.s = 0; this.d = 0; this.prog = 0; this.lapsDone = -1;
      this.u = 0; this.v = 0; this.speed = 0; this.axf = 0; this.latG = 0; this.lonG = 0;
      this.slipF = 0; this.slipR = 0; this.wheelspin = 0; this.surface = 'asphalt';
      this.draft = 0; this.dirty = 0; this.aeroLoose = 0; this.sideDrag = 0; this.push = 0;
      this.dmg = { front: 0, rear: 0, left: 0, right: 0, engine: 0, temp: 92, toe: 0, wearF: 0, flatF: false, flatR: false, health: 1 };
      this.fx = { power: 1, drag: 1, df: 1, gripF: 1, gripR: 1, toe: 0 };
      this.status = 'racing'; this.dnfReason = ''; this.dnfT = 0;
      this.hit = 0; this.scrape = 0; this.lastHitT = -9;
      this.lapStartT = null; this.lastLap = null; this.bestLap = Infinity; this.laps = [];
      this.finishT = null; this.finishPos = 0; this.resets = 0; this.stuckT = 0;
    }
  }

  // ───────────────────────────── WYŚCIG ─────────────────────────────
  class Race {
    constructor(opt) {
      this.opt = Object.assign({ track: 'speedway', laps: 8, difficulty: 5, damage: 'simple', grid: 8, assists: true, attract: false }, opt);
      this.track = new Track(TRACKS[this.opt.track]);
      this.laps = this.opt.laps;
      this.t = 0; this.acc = 0; this.sub = 0;
      this.phase = 'pace'; this.greenT = null; this.finishedCount = 0; this.leaderLap = 0;
      this.events = [];
      this.buildTables();
      this.buildField();
    }

    buildTables() {
      const tr = this.track, NL = 9;
      this.step = 4; this.n = Math.ceil(tr.len / this.step);
      this.lanes = []; for (let i = 0; i < NL; i++) this.lanes.push(-tr.halfW + 1.2 + i * (tr.W - 2.4) / (NL - 1));
      this.laneV = this.lanes.map(d => this.tableFor(() => d));
      const lo = -tr.halfW + 1.6, mid = -tr.halfW + 5, hi = tr.halfW - 2.4;
      const swoop = s => {
        let w = 0;
        for (const [a, b] of tr.turns) {
          const lead = Math.min(tr.L * 0.35, tr.R * 0.8), span = b - a + 2 * lead, p = mod(s - (a - lead), tr.len);
          if (p < span) w = Math.max(w, 0.5 - 0.5 * Math.cos(2 * PI * p / span));
        }
        return lerp(hi - 1, lo, w);
      };
      const defs = { bottom: () => lo, second: () => mid, top: () => hi, swoop };
      this.lines = {};
      for (const k in defs) { const v = this.tableFor(defs[k]); this.lines[k] = { d: defs[k], v, time: this.lineTime(defs[k], v) }; }
      this.bestLine = Object.keys(this.lines).sort((a, b) => this.lines[a].time - this.lines[b].time)[0];
    }
    tableFor(dfn) {
      const tr = this.track, v = new Float32Array(this.n), h = 6;
      for (let i = 0; i < this.n; i++) {
        const s = i * this.step;
        const p0 = tr.toWorld(s - h, dfn(s - h)), p1 = tr.toWorld(s, dfn(s)), p2 = tr.toWorld(s + h, dfn(s + h));
        const a = Math.hypot(p1.x - p0.x, p1.y - p0.y), b = Math.hypot(p2.x - p1.x, p2.y - p1.y), c = Math.hypot(p2.x - p0.x, p2.y - p0.y);
        const cr = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x));
        const k = 2 * cr / Math.max(1e-6, a * b * c);
        v[i] = Math.min(tr.vGear, cornerSpeed(tr, k, tr.bank(s, dfn(s))));
      }
      return v;
    }
    lineTime(dfn, vl) {
      const tr = this.track, n = this.n, v = new Float32Array(n), len = new Float32Array(n);
      for (let i = 0; i < n; i++) { const a = tr.toWorld(i * this.step, dfn(i * this.step)), b = tr.toWorld((i + 1) * this.step, dfn((i + 1) * this.step)); len[i] = Math.hypot(b.x - a.x, b.y - a.y); }
      let vc = 30;
      for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
        const q = 0.5 * AIR * vc * vc, a = (driveForce(tr, vc, 1) - tr.cdA * q - CAR.crr * CAR.mass * G) / CAR.mass;
        vc = Math.min(vl[i], Math.sqrt(Math.max(1, vc * vc + 2 * a * len[i]))); v[i] = vc;
      }
      for (let pass = 0; pass < 2; pass++) for (let j = n - 1; j >= 0; j--) { const nx = v[(j + 1) % n]; v[j] = Math.min(v[j], Math.sqrt(nx * nx + 2 * 8.5 * len[j])); }
      let t = 0; for (let i = 0; i < n; i++) t += len[i] / Math.max(1, v[i]);
      return t;
    }
    vAt(table, s) { return table[Math.floor(mod(s, this.track.len) / this.step) % this.n]; }
    vLane(s, d) {
      const L = this.lanes, n = L.length;
      const f = clamp((d - L[0]) / (L[n - 1] - L[0]) * (n - 1), 0, n - 1), i = Math.min(n - 2, Math.floor(f)), t = f - i;
      return lerp(this.vAt(this.laneV[i], s), this.vAt(this.laneV[i + 1], s), t);
    }

    buildField() {
      const tr = this.track, o = this.opt;
      const roster = [
        { name: 'K. Nowak', number: 7, color: '#d7263d', color2: '#f4f1de' },
        { name: 'T. Walsh', number: 12, color: '#1f4e9c', color2: '#f4c20d' },
        { name: 'R. Duarte', number: 19, color: '#1b998b', color2: '#0b1320' },
        { name: 'M. Brenner', number: 21, color: '#f4c20d', color2: '#1d1d1d' },
        { name: 'D. Okafor', number: 33, color: '#6a4c93', color2: '#ffffff' },
        { name: 'S. Lindqvist', number: 44, color: '#ff7f11', color2: '#101820' },
        { name: 'A. Moreau', number: 51, color: '#2e2e33', color2: '#ff3c38' },
        { name: 'J. Kowalczyk', number: 66, color: '#e9ecef', color2: '#c1121f' },
        { name: 'B. Hollis', number: 77, color: '#3a7d44', color2: '#f2e8cf' },
        { name: 'L. Ferraz', number: 88, color: '#0096c7', color2: '#ffffff' },
      ];
      const player = { name: 'TY', number: 10, color: '#f4c20d', color2: '#101012', isPlayer: true };
      const field = o.attract ? roster.slice(0, 10) : roster.slice(0, 9);
      shuffle(field);
      if (!o.attract) field.splice(clamp(o.grid, 1, 10) - 1, 0, player);
      this.cars = field.map((c, i) => new Car(Object.assign({ id: i, grid: i + 1, isPlayer: false }, c)));
      this.player = this.cars.find(c => c.isPlayer) || null;
      const rowGap = 12, dIn = -tr.halfW + 2.2, dOut = -tr.halfW + 5.8;
      this.cars.forEach((c, i) => {
        const row = Math.floor(i / 2), col = i % 2;
        const s = mod(-60 - row * rowGap - col * 1.5, tr.len), d = col ? dOut : dIn;
        const p = tr.toWorld(s, d), f = tr.frame(s);
        c.x = p.x; c.y = p.y; c.psi = f.th; c.s = s; c.d = d;
        c.prog = tr.ds(0, s); c.gridLane = d;
        c.vx = Math.cos(f.th) * tr.pace; c.vy = Math.sin(f.th) * tr.pace;
        const skill = c.isPlayer ? 10 : clamp(o.difficulty + (Math.random() - 0.5) * (o.attract ? 3 : 0.8), 1, 10);
        c.driver = new Driver(c, this, skill);
      });
      this.order = this.cars.slice();
    }

    effects(car) {
      const m = this.opt.damage, D = car.dmg, f = car.fx;
      f.power = 1; f.drag = 1; f.df = 1; f.gripF = 1; f.gripR = 1; f.toe = 0;
      if (m === 'simple') {
        const h = D.health; f.power = 0.84 + 0.16 * h; f.drag = 1 + 0.22 * (1 - h); f.df = 1 - 0.2 * (1 - h);
      } else if (m === 'full') {
        const aero = clamp(0.6 * Math.max(D.front, D.rear) + 0.2 * (D.left + D.right), 0, 1);
        const susp = clamp(0.35 * Math.max(D.left, D.right) + 0.15 * D.front, 0, 1);
        const heat = D.temp > 128 ? clamp(1 - (D.temp - 128) / 35, 0.35, 1) : 1;
        f.power = (1 - 0.55 * clamp(D.engine, 0, 1)) * heat;
        f.drag = 1 + 0.45 * aero + (D.flatF ? 0.12 : 0) + (D.flatR ? 0.12 : 0);
        f.df = 1 - 0.5 * aero;
        f.gripF = (1 - 0.22 * susp) * (1 - 0.25 * clamp(D.wearF, 0, 1)) * (D.flatF ? 0.42 : 1);
        f.gripR = (1 - 0.18 * susp) * (D.flatR ? 0.42 : 1);
        f.toe = D.toe;
      }
      return f;
    }

    physics(car, dt) {
      const tr = this.track, m = CAR.mass;
      const fr = tr.frame(car.s), e = car.fx;
      let beta = 0, surf = 1, rollX = 0;
      if (car.d >= -tr.halfW) { beta = tr.bank(car.s, car.d); car.surface = 'asphalt'; }
      else if (car.d >= -tr.halfW - tr.apron) { surf = 0.96; car.surface = 'apron'; }
      else { surf = 0.55; rollX = 0.12; car.surface = 'grass'; }
      const cps = Math.cos(car.psi), sps = Math.sin(car.psi);
      const u = car.vx * cps + car.vy * sps, v = -car.vx * sps + car.vy * cps;
      const V2 = car.vx * car.vx + car.vy * car.vy, V = Math.sqrt(V2), q = 0.5 * AIR * V2;
      const cdA = tr.cdA * e.drag * Math.max(0.55, 1 - car.draft + car.sideDrag);
      const df = tr.clA * q * e.df;
      const dfF = df * CAR.aeroFront * (1 - car.dirty), dfR = df * (1 - CAR.aeroFront) * (1 - car.aeroLoose);
      const tx = Math.cos(fr.th), ty = Math.sin(fr.th), vt = car.vx * tx + car.vy * ty;
      const kap = fr.arc && car.d > -tr.halfW - tr.apron ? 1 / (tr.R + car.d) : 0;
      const aIn = vt * vt * kap, sb = Math.sin(beta), cb = Math.cos(beta);
      const Nb = Math.max(0.3 * m * G, m * (G * cb + aIn * sb));
      const wt = m * car.axf * CAR.h / CAR.wb;
      const Nf = Math.max(300, Nb * CAR.b / CAR.wb - wt + dfF), Nr = Math.max(300, Nb * CAR.a / CAR.wb + wt + dfR);
      const capF = CAR.mu * surf * e.gripF * tireMu(Nf, NF0) * Nf;
      const capR = CAR.mu * CAR.rearMu * surf * e.gripR * tireMu(Nr, NR0) * Nr;
      const dl = car.delta + e.toe, uu = Math.max(Math.abs(u), 4), dir = u >= -0.5 ? 1 : -1;
      const aF = dl * dir - Math.atan((v + CAR.a * car.r) / uu), aR = -Math.atan((v - CAR.b * car.r) / uu);
      car.slipF = aF; car.slipR = aR;
      let drive = 0;
      if (car.throttle > 0) {
        const lim = clamp((tr.vGear - u) / 2, 0, 1);
        drive = car.throttle * driveForce(tr, u, e.power) * lim;
      }
      const brakeF = car.brake * CAR.brakeMu * (capF + capR);
      const sg = u > 0.3 ? 1 : u < -0.3 ? -1 : 0;
      let FxF = clamp(-brakeF * CAR.brakeFront * sg, -capF, capF);
      let FxR = drive - brakeF * (1 - CAR.brakeFront) * sg;
      car.wheelspin = FxR > capR ? (FxR - capR) / capR : 0;
      FxR = clamp(FxR, -capR, capR);
      const fyF = Math.sqrt(Math.max(0, capF * capF - FxF * FxF)) * pacejka(aF);
      const fyR = Math.sqrt(Math.max(0, capR * capR - FxR * FxR)) * pacejka(aR);
      const roll = (CAR.crr + rollX) * (Nf + Nr) * clamp(u / 0.5, -1, 1);
      const cd = Math.cos(dl), sd = Math.sin(dl);
      const Fx = FxF * cd - fyF * sd + FxR - roll;
      const Fy = FxF * sd + fyF * cd + fyR;
      const Mz = CAR.a * (FxF * sd + fyF * cd) - CAR.b * fyR;
      let Fwx = Fx * cps - Fy * sps, Fwy = Fx * sps + Fy * cps;
      if (V > 0.01) { const Fd = cdA * q; Fwx -= Fd * car.vx / V; Fwy -= Fd * car.vy / V; }
      const gs = m * G * sb * cb; Fwx -= fr.nx * gs; Fwy -= fr.ny * gs;
      car.vx += Fwx / m * dt; car.vy += Fwy / m * dt; car.r += Mz / CAR.iz * dt;
      if (V < 3) { car.r *= 1 - Math.min(1, 3 * dt); if (car.brake > 0.1 && V < 0.8) { car.vx *= 0.9; car.vy *= 0.9; } }
      car.psi += car.r * dt; car.x += car.vx * dt; car.y += car.vy * dt;
      car.axf += (Fx / m - car.axf) * Math.min(1, dt * 8);
      car.u = u; car.v = v; car.speed = V; car.latG = Fy / m / G; car.lonG = car.axf / G;
      car.gripUse = Math.max(Math.abs(fyF) / Math.max(1, capF), Math.abs(fyR) / Math.max(1, capR));
      car.capR = capR; car.fyR = fyR;
    }

    // wejście gracza → polecenia (z asystami)
    playerCmd(car) {
      const V = car.speed, c = car.ctl;
      // pełne wychylenie ≈ skręt potrzebny na łuk przed autem + zapas na granicę przyczepności
      const kAhead = this.track.curvature(car.s + V * 0.4, clamp(car.d, -this.track.halfW, this.track.halfW));
      const dmax = clamp(CAR.wb * kAhead + 0.011 + 32 / Math.max(1, V * V), 0.02, 0.42);
      let dl = c.steer * dmax, th = c.throttle;
      if (this.opt.assists && V > 8) {
        const rExp = car.u * Math.tan(dl) / (CAR.wb * (1 + 0.0004 * car.u * car.u));
        const over = car.r - rExp;
        if (Math.abs(over) > 0.04) dl -= 0.35 * (over - Math.sign(over) * 0.04);
        th = Math.min(th, tractionThrottle(this, car, 0.93));
      }
      car.cmd.delta = dl; car.cmd.throttle = th; car.cmd.brake = c.brake;
    }

    actuate(car, dt) {
      const rate = 1.4 * dt;
      car.delta += clamp(car.cmd.delta - car.delta, -rate, rate);
      car.throttle += clamp(car.cmd.throttle - car.throttle, -8 * dt, 6 * dt);
      car.brake += clamp(car.cmd.brake - car.brake, -8 * dt, 6 * dt);
    }

    update(frameDt) {
      this.acc += Math.min(frameDt, 0.1);
      while (this.acc >= SUB) { this.acc -= SUB; this.tick(SUB); }
    }

    tick(dt) {
      const tr = this.track;
      if (this.sub++ % 4 === 0) this.aiTick(dt * 4);
      for (const c of this.cars) {
        if (c.status === 'out') continue;
        if (c.isPlayer && c.status === 'racing' && this.phase !== 'pace') this.playerCmd(c);
        this.actuate(c, dt);
        this.physics(c, dt);
        c.hit = Math.max(0, c.hit - dt * 3); c.scrape = Math.max(0, c.scrape - dt * 4);
      }
      for (const c of this.cars) if (c.status !== 'out') this.walls(c);
      const act = this.cars.filter(c => c.status !== 'out');
      for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) this.carPair(act[i], act[j]);
      for (const c of this.cars) if (c.status !== 'out') this.progress(c);
      this.t += dt;
    }

    aiTick(dt) {
      this.aero();
      for (const c of this.cars) {
        if (c.status === 'out') continue;
        this.effects(c);
        this.thermal(c, dt);
        if (!c.isPlayer || this.phase === 'pace' || c.status !== 'racing') c.driver.update(dt);
        if (c.status === 'dnf' && this.t - c.dnfT > 7) { c.status = 'out'; this.events.push({ type: 'out', car: c }); }
      }
      this.standings();
      if (this.phase === 'pace') {
        const pole = this.cars[0];
        if (pole.prog >= 0) { this.phase = 'green'; this.greenT = this.t; this.events.push({ type: 'green' }); }
      }
    }

    // tunel aerodynamiczny, brudne powietrze, „aero-loose”, side-draft
    aero() {
      const tr = this.track, cs = this.cars;
      for (const c of cs) { c.draft = 0; c.dirty = 0; c.aeroLoose = 0; c.sideDrag = 0; c.push = 0; c.drafter = null; }
      for (const a of cs) {
        if (a.status === 'out') continue;
        let keep = 1, dirty = 0;
        for (const b of cs) {
          if (b === a || b.status === 'out') continue;
          const ds = tr.ds(a.s, b.s), dd = b.d - a.d;
          if (Math.abs(dd) > 5 || Math.abs(ds) > 80) continue;
          const lat = Math.exp(-(dd / 1.7) * (dd / 1.7));
          if (ds > CAR.length) {             // b przed a: a jedzie w tunelu
            const gap = ds - CAR.length;
            const lon = Math.exp(-gap / 30);
            keep *= 1 - 0.32 * lon * lat;
            dirty = Math.max(dirty, 0.38 * Math.exp(-gap / 14) * lat * (tr.inTurn(a.s) ? 1 : 0.4));
            if (!a.drafter || ds < tr.ds(a.s, a.drafter.s)) a.drafter = b;
          } else if (ds < -CAR.length && ds > -CAR.length - 10) {   // b tuż za a: popycha powietrze
            const gap = -ds - CAR.length;
            a.push = Math.max(a.push, 0.07 * Math.exp(-gap / 4) * lat);
            a.aeroLoose = Math.max(a.aeroLoose, 0.32 * Math.exp(-gap / 3.5) * lat * (tr.inTurn(a.s) ? 1 : 0.3));
          } else if (Math.abs(ds) <= CAR.length && Math.abs(dd) > 1.8 && Math.abs(dd) < 3.6 && ds > 0.8) {
            // b z tyłu ćwiartki a (ds>0 → a jest za b?) → a to samochód z tyłu, b wyprzedza; side-draft spowalnia b
            b.sideDrag = Math.max(b.sideDrag, 0.06 * (1 - Math.abs(ds) / CAR.length));
          }
        }
        a.draft = Math.min(0.38, 1 - keep + a.push);
        a.dirty = dirty;
      }
    }

    thermal(c, dt) {
      if (this.opt.damage !== 'full') return;
      const D = c.dmg;
      let target = 92 + D.engine * 70 + D.front * 30;
      if (c.drafter && tr_gap(this.track, c) < 2.5) target += 16;   // chłodnica zasłonięta zderzakiem rywala
      D.temp += (target - D.temp) * Math.min(1, dt * 0.08);
      if (D.front > 0.45 && c.speed > 20) {
        D.wearF += dt * 0.012 * (D.front - 0.45) * 4;
        if (D.wearF >= 1 && !D.flatF) { D.flatF = true; this.events.push({ type: 'flat', car: c }); }
      }
      if (c.status === 'racing') {
        if (D.temp > 150) { D.cook = (D.cook || 0) + dt; if (D.cook > 6) this.dnf(c, 'Przegrzany silnik'); } else D.cook = 0;
        if (D.engine >= 1) this.dnf(c, 'Silnik');
      }
    }

    dnf(c, why) {
      if (c.status !== 'racing') return;
      c.status = 'dnf'; c.dnfReason = why; c.dnfT = this.t;
      this.events.push({ type: 'dnf', car: c, why });
    }

    damage(c, vn, lx, ly, wall) {
      const mode = this.opt.damage;
      const sev = vn - 2.2;
      c.hit = Math.max(c.hit, clamp(vn / 12, 0, 1));
      if (mode === 'none' || sev <= 0 || c.status === 'finished') return;
      const D = c.dmg;
      if (mode === 'simple') { D.health = Math.max(0.3, D.health - sev * 0.016); return; }
      const amt = sev * 0.034 * (wall ? 1.1 : 1);
      const zone = Math.abs(lx) > 1.7 ? (lx > 0 ? 'front' : 'rear') : (ly > 0 ? 'left' : 'right');
      D[zone] = Math.min(1.5, D[zone] + amt);
      if (zone === 'front') D.engine += amt * 0.45;
      if (zone === 'left' || zone === 'right' || zone === 'front') D.toe += (zone === 'right' ? -1 : zone === 'left' ? 1 : (Math.random() - 0.5)) * amt * 0.012;
      D.toe = clamp(D.toe, -0.02, 0.02);
      if (sev > 6 && Math.random() < 0.18 + sev * 0.02) {
        if (lx > 0) { if (!D.flatF) { D.flatF = true; this.events.push({ type: 'flat', car: c }); } }
        else if (!D.flatR) { D.flatR = true; this.events.push({ type: 'flat', car: c }); }
      }
      D.health = 1 - clamp((D.front + D.rear + D.left + D.right) / 3, 0, 1);
      if (vn > 23) this.dnf(c, 'Wypadek');
      else if (D.front > 1.25 || D.rear > 1.35 || D.left + D.right > 2.2) this.dnf(c, 'Zbyt duże uszkodzenia');
    }

    walls(c) {
      const tr = this.track, hl = CAR.length / 2, hw = CAR.width / 2;
      const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
      let best = null;
      for (const [lx, ly] of [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]]) {
        const px = c.x + lx * cp - ly * sp, py = c.y + lx * sp + ly * cp;
        const L = tr.toLocal(px, py);
        let pen = L.d - tr.outerWall, sgn = -1;
        if (pen <= 0) { pen = tr.innerWall - L.d; sgn = 1; }
        if (pen > 0 && (!best || pen > best.pen)) best = { pen, px, py, s: L.s, sgn, lx, ly };
      }
      if (!best) return;
      const f = tr.frame(best.s);
      const vn = contact(c, best.px, best.py, f.nx * best.sgn, f.ny * best.sgn, best.pen, 0.25, 0.32);
      if (vn > 0) {
        c.scrape = Math.max(c.scrape, clamp(c.speed / 60, 0.2, 1));
        c.r *= 0.985;
        this.damage(c, vn, best.lx, best.ly, true);
        if (vn > 6) this.events.push({ type: 'wall', car: c, v: vn });
      }
    }

    carPair(A, B) {
      const dx = B.x - A.x, dy = B.y - A.y;
      if (dx * dx + dy * dy > 36) return;
      const oa = obb(A), ob = obb(B), axes = [oa.f, oa.l, ob.f, ob.l];
      let minO = Infinity, nx = 0, ny = 0, minAx = 0;
      for (let ai = 0; ai < 4; ai++) {
        const ax = axes[ai];
        const dist = dx * ax[0] + dy * ax[1];
        const rA = oa.hl * Math.abs(oa.f[0] * ax[0] + oa.f[1] * ax[1]) + oa.hw * Math.abs(oa.l[0] * ax[0] + oa.l[1] * ax[1]);
        const rB = ob.hl * Math.abs(ob.f[0] * ax[0] + ob.f[1] * ax[1]) + ob.hw * Math.abs(ob.l[0] * ax[0] + ob.l[1] * ax[1]);
        const o = rA + rB - Math.abs(dist);
        if (o <= 0) return;
        if (o < minO) { minO = o; minAx = ai; const s = dist >= 0 ? 1 : -1; nx = ax[0] * s; ny = ax[1] * s; }
      }
      // punkt styku: wierzchołki wchodzące w drugą bryłę
      let px = 0, py = 0, cnt = 0;
      for (const p of cornersOf(ob)) if (inside(oa, p)) { px += p[0]; py += p[1]; cnt++; }
      for (const p of cornersOf(oa)) if (inside(ob, p)) { px += p[0]; py += p[1]; cnt++; }
      if (cnt) { px /= cnt; py /= cnt; } else { px = (A.x + B.x) / 2; py = (A.y + B.y) / 2; }
      if (minAx === 1 || minAx === 3) {
        // styk bokiem (drzwi o drzwi): nacisk rozkłada się na wspólnym odcinku karoserii
        const f = minAx === 1 ? oa.f : ob.f;
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const q of cornersOf(oa)) { const v = q[0] * f[0] + q[1] * f[1]; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
        for (const q of cornersOf(ob)) { const v = q[0] * f[0] + q[1] * f[1]; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
        const mid = (Math.max(a0, b0) + Math.min(a1, b1)) / 2, cur = px * f[0] + py * f[1];
        px += f[0] * (mid - cur); py += f[1] * (mid - cur);
      }
      A.x -= nx * minO / 2; A.y -= ny * minO / 2; B.x += nx * minO / 2; B.y += ny * minO / 2;
      const m = CAR.mass, I = CAR.iz;
      const rax = px - A.x, ray = py - A.y, rbx = px - B.x, rby = py - B.y;
      const vax = A.vx - A.r * ray, vay = A.vy + A.r * rax, vbx = B.vx - B.r * rby, vby = B.vy + B.r * rbx;
      const rvx = vbx - vax, rvy = vby - vay, vn = rvx * nx + rvy * ny;
      if (vn >= 0) return;
      const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx;
      const j = -(1.18) * vn / (2 / m + ran * ran / I + rbn * rbn / I);
      A.vx -= j * nx / m; A.vy -= j * ny / m; A.r -= ran * j / I;
      B.vx += j * nx / m; B.vy += j * ny / m; B.r += rbn * j / I;
      const tx = -ny, ty = nx, vt = rvx * tx + rvy * ty, rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
      let jt = -vt / (2 / m + rat * rat / I + rbt * rbt / I); jt = clamp(jt, -0.25 * j, 0.25 * j);
      A.vx -= jt * tx / m; A.vy -= jt * ty / m; A.r -= rat * jt / I;
      B.vx += jt * tx / m; B.vy += jt * ty / m; B.r += rbt * jt / I;
      const imp = -vn;
      const la = toLocalPt(A, px, py), lb = toLocalPt(B, px, py);
      this.damage(A, imp, la[0], la[1], false); this.damage(B, imp, lb[0], lb[1], false);
      if (imp > 5) this.events.push({ type: 'contact', a: A, b: B, v: imp });
      A.lastContact = B.lastContact = this.t;
    }

    progress(c) {
      const tr = this.track, L = tr.toLocal(c.x, c.y);
      c.prog += tr.ds(c.s, L.s); c.s = L.s; c.d = L.d;
      if (this.phase === 'pace') return;
      const done = Math.floor(c.prog / tr.len);
      if (done > c.lapsDone) {
        c.lapsDone = done;
        if (c.status !== 'racing') return;
        if (done >= 1 && c.lapStartT != null) {
          const lt = this.t - c.lapStartT; c.lastLap = lt; c.laps.push(lt);
          if (lt < c.bestLap) c.bestLap = lt;
        }
        c.lapStartT = this.t;
        if (done > this.leaderLap) {
          this.leaderLap = done;
          if (done === this.laps - 1 && !this.opt.attract) this.events.push({ type: 'white' });
        }
        if (done >= this.laps && c.status === 'racing' && !this.opt.attract) {
          c.status = 'finished'; c.finishT = this.t; c.finishPos = ++this.finishedCount;
          if (c.finishPos === 1) { this.phase = 'checkered'; this.firstFinishT = this.t; this.events.push({ type: 'checkered', car: c }); }
          this.events.push({ type: 'finish', car: c });
        }
      }
    }

    resetCar(c) {
      const tr = this.track;
      const d = -tr.halfW - tr.apron * 0.5;
      let s = c.s;
      // nie ustawiaj na innym aucie
      for (let k = 0; k < 20; k++) { if (!this.cars.some(o => o !== c && o.status !== 'out' && Math.abs(tr.ds(s, o.s)) < 9 && Math.abs(o.d - d) < 3)) break; s -= 10; }
      const p = tr.toWorld(s, d), f = tr.frame(s);
      c.prog += tr.ds(c.s, s);
      c.x = p.x; c.y = p.y; c.psi = f.th; c.r = 0; c.s = s; c.d = d;
      const v0 = 18; c.vx = Math.cos(f.th) * v0; c.vy = Math.sin(f.th) * v0;
      c.delta = 0; c.resets++; c.stuckT = 0;
      if (c.driver) c.driver.reset();
      this.events.push({ type: 'reset', car: c });
    }

    standings() {
      this.order = this.cars.slice().sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.status === 'finished' && b.status === 'finished') return a.finishPos - b.finishPos;
        return b.prog - a.prog;
      });
      this.order.forEach((c, i) => { c.pos = i + 1; });
    }
    gapToLeader(c) {
      const lead = this.order[0];
      if (c === lead) return 0;
      if (lead.status === 'finished' && c.status === 'finished') return c.finishT - lead.finishT;
      return (lead.prog - c.prog) / Math.max(25, lead.speed * 0.9);
    }
    lapsDown(c) { const lead = this.order[0]; return Math.floor((lead.prog - c.prog) / this.track.len); }
    get done() {
      if (this.opt.attract) return false;
      const p = this.player;
      if (this.cars.every(c => c.status !== 'racing')) return true;
      return !!(p && p.status !== 'racing' && this.finishedCount > 0 && this.t - Math.max(p.finishT ?? p.dnfT, this.firstFinishT ?? 0) > 9);
    }
  }
  function rank(c) { return c.status === 'finished' ? 0 : (c.status === 'racing' ? 1 : 2); }
  function tr_gap(tr, c) { return tr.ds(c.s, c.drafter.s) - CAR.length; }

  function contact(c, px, py, nx, ny, pen, e, mu) {
    c.x += nx * pen; c.y += ny * pen;
    const m = CAR.mass, I = CAR.iz, rx = px - c.x, ry = py - c.y;
    const vpx = c.vx - c.r * ry, vpy = c.vy + c.r * rx, vn = vpx * nx + vpy * ny;
    if (vn >= 0) return 0;
    const rn = rx * ny - ry * nx, jn = -(1 + e) * vn / (1 / m + rn * rn / I);
    c.vx += jn * nx / m; c.vy += jn * ny / m; c.r += rn * jn / I;
    const tx = -ny, ty = nx;
    const vtx = c.vx - c.r * ry, vty = c.vy + c.r * rx, vt = vtx * tx + vty * ty;
    const rt = rx * ty - ry * tx;
    let jt = -vt / (1 / m + rt * rt / I); jt = clamp(jt, -mu * jn, mu * jn);
    c.vx += jt * tx / m; c.vy += jt * ty / m; c.r += rt * jt / I;
    return -vn;
  }
  function obb(c) {
    const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
    return { x: c.x, y: c.y, f: [cp, sp], l: [-sp, cp], hl: CAR.length / 2, hw: CAR.width / 2 };
  }
  function cornersOf(o) {
    const r = [];
    for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) r.push([o.x + o.f[0] * o.hl * a + o.l[0] * o.hw * b, o.y + o.f[1] * o.hl * a + o.l[1] * o.hw * b]);
    return r;
  }
  function inside(o, p) {
    const dx = p[0] - o.x, dy = p[1] - o.y;
    return Math.abs(dx * o.f[0] + dy * o.f[1]) <= o.hl + 0.05 && Math.abs(dx * o.l[0] + dy * o.l[1]) <= o.hw + 0.05;
  }
  function toLocalPt(c, px, py) {
    const dx = px - c.x, dy = py - c.y, cp = Math.cos(c.psi), sp = Math.sin(c.psi);
    return [dx * cp + dy * sp, -dx * sp + dy * cp];
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // ───────────────────────────── KIEROWCA AI ─────────────────────────────
  // Umiejętność 1–10 zmienia wyłącznie to, JAK kierowca wykorzystuje identyczny samochód:
  // ile zapasu przyczepności zostawia, gdzie hamuje, jak dobiera linię, jak czyta tunel i ruch.
  class Driver {
    constructor(car, race, skill) {
      this.car = car; this.race = race; this.skill = skill;
      const k = this.k = (skill - 1) / 9;
      this.use = 0.9 + 0.08 * k;                   // wykorzystanie granicy przyczepności
      this.decel = 6.0 + 3.2 * k;                    // jak mocno odważy się hamować
      this.reaction = 0.42 - 0.3 * k;                // czas reakcji na ruch
      this.laneRate = 2.2 + 1.6 * k;                 // tempo zmiany pasa [m/s]
      this.sep = 2.2 + 0.5 * k;                      // margines boczny
      this.aggr = 0.3 + Math.random() * 0.7;
      this.noiseAmp = 0.0045 * (1 - k) + 0.0006;
      this.wander = (1 - k) * 0.9;
      this.ph = [Math.random() * 9, Math.random() * 9, Math.random() * 9];
      const lines = race.lines;
      // na superspeedwayu jeździ się pasami (dół / środek / góra), nie „linią wyścigową”
      const names = race.track.id === 'speedway' ? ['bottom', 'bottom', 'second', 'top'] : Object.keys(lines);
      const best = race.track.id === 'speedway' ? 'bottom' : race.bestLine;
      this.lineName = Math.random() < 0.3 + 0.7 * k ? best : names[Math.floor(Math.random() * names.length)];
      this.reset();
    }
    reset() {
      this.mode = 'line'; this.lane = null; this.passCar = null; this.decT = 0; this.modeT = 0;
      this.dS = this.car.d; this.lo = -99; this.hi = 99; this.mistake = 0; this.mistakeT = 0; this.blockT = 0; this.t = 0; this.followV = 999;
    }
    lineD(s) { return this.race.lines[this.lineName].d(s); }
    planD(s) { return this.lane != null ? this.lane : this.lineD(s) + Math.sin(this.t * 0.23 + this.ph[2]) * this.wander; }
    vlim(s) { return this.lane != null ? this.race.vLane(s, this.lane) : this.race.vAt(this.race.lines[this.lineName].v, s); }

    update(dt) {
      const c = this.car, race = this.race, tr = race.track;
      this.t += dt;
      if (c.status === 'dnf') { c.cmd.throttle = 0; c.cmd.brake = 0.35; c.cmd.delta = 0; return; }
      if (race.phase === 'pace') return this.pace(dt);
      // zablokowany / obrócony → reset
      const f = tr.frame(c.s), head = angDiff(c.psi, f.th);
      if ((c.speed < 4 || Math.abs(head) > 1.9) && c.status === 'racing') { c.stuckT += dt; if (c.stuckT > 2.5) return race.resetCar(c); } else c.stuckT = 0;
      this.decT -= dt; this.modeT += dt; this.blockT -= dt; this.cool = (this.cool || 0) - dt;
      if (this.decT <= 0) { this.decide(); this.decT = this.reaction * (0.7 + Math.random() * 0.6); }
      // błędy (niski poziom)
      this.mistakeT -= dt;
      if (this.mistakeT <= 0 && Math.random() < dt * 0.05 * (1 - this.k) * (1 - this.k)) { this.mistake = 0.5 + Math.random() * 0.6; this.mistakeT = 8; }
      this.mistake = Math.max(0, this.mistake - dt);
      // cel boczny z marginesem na sąsiadów
      let dT = clamp(this.planD(c.s + 15), -tr.halfW + 1.15, tr.halfW - 1.25);
      if (c.status === 'finished') dT = clamp(this.lineD(c.s), -tr.halfW + 1.2, tr.halfW - 1.3);
      dT = this.sideLimit(dT);
      // w łuku zjazd w dół (zacieśnianie promienia) tylko powoli; na zewnątrz swobodniej
      const turn = tr.inTurn(c.s);
      const lrDown = this.laneRate * (turn ? 0.3 : 1), lrUp = this.laneRate * (turn ? 0.7 : 1);
      this.dS += clamp(dT - this.dS, -lrDown * dt, lrUp * dt);
      this.dS = clamp(this.dS, Math.min(this.lo, this.hi), Math.max(this.lo, this.hi));
      this.steer(dt);
      this.speed(dt);
    }

    sideLimit(dT) {
      const c = this.car, tr = this.race.track;
      let lo = -tr.halfW - 2, hi = tr.halfW - 1.1; this.hiCar = false;
      for (const o of this.race.cars) {
        if (o === c || o.status === 'out') continue;
        const ds = tr.ds(c.s, o.s), dd = o.d - c.d;
        const overlap = Math.abs(ds) < CAR.length + 0.3;
        // auto w tym samym pasie z przodu/z tyłu to sprawa odstępu, nie manewru bocznego
        if (!overlap && Math.abs(dd) < 1.5) continue;
        const ahead = (o.speed - c.speed) * 0.6;          // przewidywanie
        if (ds > CAR.length + 1.2 + Math.max(0, -ahead) || ds < -CAR.length - 1.2 - Math.max(0, ahead)) continue;
        if (o.d > c.d) { hi = Math.min(hi, o.d - this.sep); this.hiCar = true; } else lo = Math.max(lo, o.d + this.sep);
      }
      if (lo > hi) { const m = (lo + hi) / 2; this.lo = this.hi = m; return m; }
      this.lo = lo; this.hi = hi;
      return clamp(dT, lo, hi);
    }

    decide() {
      const c = this.car, race = this.race, tr = race.track, k = this.k;
      if (c.status === 'finished') { this.lane = null; return; }
      let ahead = null, aheadDs = 1e9;
      const myD = this.lane != null ? this.lane : this.lineD(c.s + 20);
      for (const o of race.cars) {
        if (o === c || o.status === 'out') continue;
        const ds = tr.ds(c.s, o.s);
        if (ds > 0 && ds < 110 && Math.abs(o.d - myD) < 2.3 && ds < aheadDs) { ahead = o; aheadDs = ds; }
      }
      this.ahead = ahead; this.aheadDs = aheadDs;
      if (this.mode === 'pass') {
        const pc = this.passCar;
        const dsp = pc ? tr.ds(c.s, pc.s) : -99;
        if (!pc || pc.status === 'out' || dsp < -(CAR.length + 3) || this.modeT > 14) { this.mode = 'line'; this.lane = null; this.passCar = null; }
        else if (dsp > 20 && this.modeT > 4) { this.mode = 'line'; this.lane = null; this.passCar = null; }
        else if (this.modeT > 3 && dsp > CAR.length + 1 && c.speed <= pc.speed + 0.2 && this.laneFree(pc.d, -10, dsp - 3)) {
          // atak utknął bez pomocy z tyłu — wróć do tunelu za rywalem
          this.mode = 'line'; this.lane = clamp(pc.d, -tr.halfW + 1.2, tr.halfW - 1.3); this.passCar = null; this.cool = 4;
        }
        else return;
      }
      if (ahead) {
        const gap = aheadDs - CAR.length, closing = c.speed - ahead.speed;
        const wrecked = ahead.status === 'dnf' || ahead.speed < c.speed * 0.6;
        const trig = wrecked ? 90 : clamp(closing * (1.2 + 1.6 * k) + 3 + (1 - k) * (Math.random() * 10 - 3), 2, 45);
        const drafting = tr.id !== 'short' && gap < 25 && c.draft > 0.12;
        const needRun = tr.id === 'speedway' ? 1.2 - 0.5 * k : 0.4 - 0.3 * k;
        let wantPass = gap < trig && (closing > needRun || wrecked) && !(this.cool > 0);
        // slingshot: dobry kierowca wychodzi z tunelu z nadwyżką prędkości tuż za rywalem
        if (!wantPass && drafting && k > 0.35 && gap < 4 + 6 * k && closing > 0.6 - 0.3 * k && !(this.cool > 0) && Math.random() < k * 0.25) wantPass = true;
        // manewr ustawia się przed zakrętem — w łuku tylko omijanie wraku
        if (wantPass && tr.inTurn(c.s) && !wrecked) wantPass = false;
        if (wantPass) {
          const opts = [];
          for (const side of [-1, 1]) {
            const d = ahead.d + side * 3.5;
            if (d < -tr.halfW + 1.1 || d > tr.halfW - 1.2) continue;
            let free = true, help = 0;
            for (const o of race.cars) {
              if (o === c || o === ahead || o.status === 'out') continue;
              const ds = tr.ds(c.s, o.s);
              if (Math.abs(o.d - d) < 2.6 && ds > -12 - 6 * (1 - k) * 0 && ds < gap + 16) free = false;
              if (Math.abs(o.d - d) < 2.2 && ds > gap && ds < gap + 45) help = 1;
              if (Math.abs(o.d - d) < 2.4 && ds < -2 && ds > -30 && o.speed > c.speed + 1) help += 0.5;   // ktoś z tyłu dopchnie
            }
            if (!free && Math.random() > 0.08 * (1 - k)) continue;      // słaby kierowca czasem wjedzie w zajęty pas
            if (!wrecked && !this.feasible(d)) continue;
            const score = (side < 0 ? 0.6 : 0) + help * k * 1.5 + Math.random() * (1 - k) + (tr.inTurn(c.s + 60) && side < 0 ? 0.5 : 0);
            opts.push({ d, score });
          }
          if (opts.length) {
            opts.sort((a, b) => b.score - a.score);
            this.mode = 'pass'; this.lane = opts[0].d; this.passCar = ahead; this.modeT = 0; return;
          }
        }
      }
      // szukanie tunelu: przejdź za samochód z przodu w innym pasie
      if (!ahead || aheadDs > 60) {
        if (tr.id !== 'short' && Math.random() < 0.15 + 0.6 * k) {
          let tgt = null, bd = 1e9;
          for (const o of race.cars) {
            if (o === c || o.status !== 'racing') continue;
            const ds = tr.ds(c.s, o.s);
            if (ds > 10 && ds < 70 && ds < bd) { tgt = o; bd = ds; }
          }
          if (tgt && Math.abs(tgt.d - myD) > 2 && this.laneFree(tgt.d, -12, bd - 8) && this.feasible(tgt.d)) { this.lane = clamp(tgt.d, -tr.halfW + 1.2, tr.halfW - 1.3); this.mode = 'draft'; this.draftCar = tgt; this.modeT = 0; return; }
        }
      }
      if (this.mode === 'draft') {
        const dc = this.draftCar, g = dc ? tr.ds(c.s, dc.s) : -1;
        if (!dc || dc.status !== 'racing' || g < 3 || g > 80 || this.modeT > 12) { this.mode = 'line'; this.lane = null; this.draftCar = null; }
        else if (Math.abs(dc.d - c.d) < 3 && this.laneFree(dc.d, -8, g - 4)) { this.lane = clamp(dc.d, -tr.halfW + 1.2, tr.halfW - 1.3); return; }
      }
      // w tunelu trzymaj się osi auta z przodu (wyrównanie pociągu)
      if (tr.id !== 'short' && ahead && aheadDs < 45 && ahead.status === 'racing' && Math.random() < 0.3 + 0.7 * k && !tr.inTurn(c.s + 20)) {
        if (this.mode === 'line' && this.laneFree(ahead.d, -8, aheadDs - 4)) { this.lane = clamp(ahead.d, -tr.halfW + 1.2, tr.halfW - 1.3); return; }
      }
      // blokowanie: dobry, agresywny kierowca zamyka pas atakującemu
      if (k > 0.4 && this.blockT <= 0 && !tr.inTurn(c.s) && !tr.inTurn(c.s + c.u * 1.5)) {
        for (const o of race.cars) {
          if (o === c || o.status !== 'racing') continue;
          const ds = tr.ds(c.s, o.s), dd = o.d - c.d;
          if (ds < -6.5 && ds > -22 && o.speed - c.speed > 1.2 && Math.abs(dd) > 1.4 && Math.abs(dd) < 4.2 && Math.random() < this.aggr * k * 0.5) {
            if (this.laneFree(o.d, -6, 12) && this.feasible(o.d)) { this.lane = clamp(o.d, -tr.halfW + 1.2, tr.halfW - 1.3); this.mode = 'block'; this.modeT = 0; this.blockT = 5; return; }
          }
        }
      }
      if (this.mode === 'block' && this.modeT > 3) { this.mode = 'line'; this.lane = null; }
      // w ruchu trzymaj swój pas zamiast nurkować linią wyścigową przez sąsiadów
      const traffic = race.cars.some(o => o !== c && o.status !== 'out' && Math.abs(tr.ds(c.s, o.s)) < 22 && Math.abs(o.d - c.d) < 5);
      if (this.mode === 'line') {
        if (traffic) { if (this.lane == null) { const d = clamp(this.dS, -tr.halfW + 1.2, tr.halfW - 1.3); if (this.feasible(d) || tr.inTurn(c.s)) this.lane = d; } }
        else if (this.lane != null && this.laneFree(this.lineD(c.s + 20), -10, 20)) this.lane = null;
      }
    }

    // czy da się jechać pasem d bez hamowania ponad możliwości (strefa hamowania / łuk tuż przed nami)
    feasible(d) {
      const c = this.car, u = c.u;
      for (let x = 0; x <= Math.max(60, u * 2.2); x += 8) {
        const v = this.race.vLane(c.s + x, d) * this.use;
        if (Math.sqrt(v * v + 2 * this.decel * 0.7 * x) < u - 1) return false;
      }
      return true;
    }
    laneFree(d, from, to) {
      const c = this.car, tr = this.race.track;
      for (const o of this.race.cars) {
        if (o === c || o.status === 'out') continue;
        const ds = tr.ds(c.s, o.s);
        if (Math.abs(o.d - d) < 2.5 && ds > from && ds < to) return false;
      }
      return true;
    }

    steer(dt) {
      const c = this.car, tr = this.race.track;
      const u = Math.max(5, c.u);
      const Lk = clamp(0.42 * u + 9, 12, 52);
      let dAhead = this.dS + (this.lane == null && this.mode !== 'pace' ? (this.lineD(c.s + Lk) - this.lineD(c.s + 15)) : 0);
      if (this.lo != null) dAhead = clamp(dAhead, Math.min(this.lo, this.hi), Math.max(this.lo, this.hi));
      const p = tr.toWorld(c.s + Lk, dAhead);
      const cp = Math.cos(c.psi), sp = Math.sin(c.psi);
      const dx = (p.x - c.x) * cp + (p.y - c.y) * sp, dy = -(p.x - c.x) * sp + (p.y - c.y) * cp;
      const kap = 2 * dy / (dx * dx + dy * dy);
      const rDes = u * kap;
      // człon całkujący błąd boczny — kompensuje podsterowność w długim łuku
      const eLat = this.lane != null ? c.d - this.dS : 0;
      this.iLat = clamp((this.iLat || 0) * (this.lane != null ? 1 : 1 - dt) + eLat * dt, -2, 2);
      let dl = Math.atan(CAR.wb * kap) + 0.09 * (rDes - c.r) + 0.0025 * eLat + 0.004 * this.iLat;
      // kontra przy uślizgu tyłu (lepszy kierowca szybciej i dokładniej)
      const over = c.r - rDes;
      if (Math.abs(over) > 0.05) dl -= (0.2 + 0.25 * this.k) * (over - Math.sign(over) * 0.05);
      dl += this.noiseAmp * (Math.sin(this.t * 1.7 + this.ph[0]) * 0.7 + Math.sin(this.t * 4.3 + this.ph[1]) * 0.3);
      const dmax = Math.max(0.05, 0.5 / (1 + u / 7));
      c.cmd.delta = clamp(dl, -dmax, dmax);
    }

    speed(dt) {
      const c = this.car, race = this.race, tr = race.track, k = this.k;
      const u = c.u;
      let vt = 999;
      const grip = Math.min(c.fx.gripF, c.fx.gripR);
      // brudne powietrze / auto tuż za tylnym zderzakiem zabierają docisk — dobry kierowca to czuje i odpuszcza
      const aeroLoss = (0.25 + 0.2 * k) * Math.max(c.dirty, c.aeroLoose);
      const gs = Math.sqrt(grip * (0.7 + 0.3 * c.fx.df)) * (1 - aeroLoss);
      const horizon = Math.max(60, u * u / (2 * this.decel) + 40);
      for (let x = 0; x <= horizon; x += 8) {
        const v = this.vlim(c.s + x) * this.use * gs;
        vt = Math.min(vt, Math.sqrt(v * v + 2 * this.decel * x));
      }
      if (c.status === 'finished') vt = Math.min(vt, 0.72 * this.vlim(c.s));
      // podążanie za autem z przodu
      const a = this.ahead;
      if (a && a.status !== 'out' && this.mode !== 'pass') {
        const gap = tr.ds(c.s, a.s) - CAR.length;
        if (Math.abs(a.d - c.d) < 2.2 && gap < 45) {
          const turnish = tr.inTurn(c.s) || tr.inTurn(c.s + 40);
          const want = tr.id === 'speedway' ? (turnish ? lerp(8, 2.2, k) : lerp(6, 0.3, k)) : tr.id === 'intermediate' ? lerp(8, 2.5, k) : (turnish ? lerp(8, 2.5, k) : lerp(8, 1.2, k));
          // prędkość, z której zdążę wytracić różnicę do auta z przodu na dostępnym dystansie
          const room = gap - want, dec = 2.5 + 2.5 * k;
          const vf = room > 0 ? a.speed + Math.sqrt(2 * dec * room) : a.speed + room * 1.5;
          vt = Math.min(vt, Math.max(0, vf));
        }
      }
      if (this.mode === 'pass' && this.passCar && Math.abs(this.passCar.d - c.d) < 2.0) {
        const gap = tr.ds(c.s, this.passCar.s) - CAR.length;
        if (gap > -2 && gap < 12) { const room = gap - lerp(3, 0.5, k); vt = Math.min(vt, this.passCar.speed + (room > 0 ? Math.sqrt(2 * 4 * room) : room * 1.5)); }
      }
      const err = vt - u;
      let th, br = 0;
      if (err > 2) th = 1;
      else if (err > -0.6) th = clamp(0.3 + err * (0.3 + 0.2 * k), 0, 1);
      else {
        th = 0; br = clamp((-err - 0.6) * (0.08 + 0.1 * k), 0, 1);
        const lat = c.capR ? Math.abs(c.fyR) / c.capR : 0;           // hamowanie w zakręcie: zostaw oponom zapas na skręt
        br = Math.min(br, Math.sqrt(Math.max(0, 1 - lat * lat)) * (0.75 + 0.25 * k) + 0.08);
      }
      th = Math.min(th, tractionThrottle(race, c, 0.8 + 0.17 * k));
      if (Math.abs(c.slipR) > PEAK_SLIP * (1.1 - 0.2 * k)) th *= 0.5;
      // auto wypycha na zewnątrz ponad zamierzoną linię (push) — odpuść gaz, zwłaszcza gdy ktoś jedzie wyżej
      const push = c.d - this.dS;
      if (push > 0.25 && tr.inTurn(c.s) && this.hiCar && this.hi - c.d < 1.5) {
        th *= clamp(1 - (push - 0.25) * (1.5 + 3 * k), 0, 1);
      }
      if (this.mistake > 0) { th *= 0.25; }
      c.cmd.throttle = th; c.cmd.brake = br;
    }

    pace(dt) {
      const c = this.car, race = this.race, tr = race.track;
      this.lane = c.gridLane; this.dS = c.gridLane;
      this.steer(dt);
      const idx = race.cars.indexOf(c);
      let vt = tr.pace;
      if (idx >= 2) { const fw = race.cars[idx - 2]; const gap = tr.ds(c.s, fw.s) - CAR.length; vt = fw.speed + (gap - 6.8) * 0.6; }
      else if (idx === 1) { const fw = race.cars[0]; vt = fw.speed + (tr.ds(c.s, fw.s) + 1.5) * 0.6; }
      const err = vt - c.u;
      c.cmd.throttle = clamp(0.35 + err * 0.3, 0, 1); c.cmd.brake = err < -1 ? clamp(-err * 0.1, 0, 0.6) : 0;
    }
  }
  // gaz, przy którym tylna opona zostaje w kole tarcia przy danym obciążeniu bocznym
  function tractionThrottle(race, c, util) {
    if (!c.capR) return 1;
    const fx = Math.sqrt(Math.max(0, (c.capR * util) ** 2 - c.fyR * c.fyR));
    return clamp(fx / driveForce(race.track, c.u, c.fx.power), 0.05, 1);
  }
  function angDiff(a, b) { let d = a - b; while (d > PI) d -= 2 * PI; while (d < -PI) d += 2 * PI; return d; }

  return { TRACKS, Track, Race, Car, Driver, CAR, SUB, cornerSpeed, PEAK_SLIP, clamp, lerp, mod };
});
