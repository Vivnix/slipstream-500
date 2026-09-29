/* Wideo: oprawa dźwiękowa liczona w Node (bez próbek z zewnątrz) — muzyka zwiastuna w d-moll, 150 BPM, i efekty:
   uderzenia (sub + „braam” + talerz), narastania, werbel przed montażem, wyciszenia na jedną ćwierćnutę, przeloty,
   zgrzyt blachy przy kraksach. Plus zszycie dźwięku gry z ujęć.
   Wszystko do WAV 48 kHz stereo 16 bit; miks końcowy i głośność robi ffmpeg w render.js. */
'use strict';
const fs = require('fs');
const SR = 48000, TAU = Math.PI * 2;

class Buf {
  constructor(sec) { this.n = Math.ceil(sec * SR); this.L = new Float32Array(this.n); this.R = new Float32Array(this.n); }
  add(i, l, r) { if (i >= 0 && i < this.n) { this.L[i] += l; this.R[i] += r; } }
  mix(b, g = 1) { for (let i = 0; i < this.n && i < b.n; i++) { this.L[i] += b.L[i] * g; this.R[i] += b.R[i] * g; } }
}
function readWav(file) {
  const b = fs.readFileSync(file), ch = b.readUInt16LE(22);
  let p = 12; while (b.toString('ascii', p, p + 4) !== 'data') p += 8 + b.readUInt32LE(p + 4);
  const n = b.readUInt32LE(p + 4) / 2 / ch, o = { n, L: new Float32Array(n), R: new Float32Array(n) };
  for (let i = 0; i < n; i++) { o.L[i] = b.readInt16LE(p + 8 + i * ch * 2) / 32768; o.R[i] = b.readInt16LE(p + 8 + (i * ch + ch - 1) * 2) / 32768; }
  return o;
}
function writeWav(file, buf, peak = 0.89) {
  let m = 1e-9; for (let i = 0; i < buf.n; i++) m = Math.max(m, Math.abs(buf.L[i]), Math.abs(buf.R[i]));
  const g = m > peak ? peak / m : 1, d = Buffer.alloc(44 + buf.n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + buf.n * 4, 4); d.write('WAVE', 8); d.write('fmt ', 12); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(SR, 24); d.writeUInt32LE(SR * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(buf.n * 4, 40);
  for (let i = 0; i < buf.n; i++) { d.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf.L[i] * g)) * 32767), 44 + i * 4); d.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf.R[i] * g)) * 32767), 46 + i * 4); }
  fs.writeFileSync(file, d);
}

// ─── klocki DSP ───
let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, noise = () => rnd() * 2 - 1;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
// filtr stanowy (Chamberlin/TPT) — lp/bp/hp z częstotliwością zmienną w czasie
function svf() { let a = 0, b = 0; return (x, f, q = 0.7) => { const g = Math.tan(Math.PI * Math.min(f, SR * 0.45) / SR), k = 1 / q, h = 1 / (1 + g * (g + k)); const hp = (x - (k + g) * a - b) * h, bp = g * hp + a; a = g * hp + bp; const lp = g * bp + b; b = g * bp + lp; return { lp, bp, hp }; }; }
const saw = ph => 2 * (ph - Math.floor(ph + 0.5));
const midi = n => 440 * Math.pow(2, (n - 69) / 12);
const pan = (p) => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

function kick(B, t, g = 1, long = false) {
  const i0 = Math.round(t * SR), n = Math.round((long ? 1.4 : 0.42) * SR); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR, f = 44 + 120 * Math.exp(-u * 30), e = Math.exp(-u * (long ? 2.6 : 8)); ph += f / SR; const s = Math.tanh(Math.sin(TAU * ph) * e * 1.4) + (i < 90 ? noise() * 0.35 * (1 - i / 90) : 0); B.add(i0 + i, s * g, s * g); }
}
function snare(B, t, g = 1) {
  const i0 = Math.round(t * SR), n = Math.round(0.28 * SR), f = svf(), f2 = svf(); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR; ph += 190 / SR; const s = f(noise(), 2600, 0.6).bp * Math.exp(-u * 15) * 1.7 + f2(noise(), 6500, 0.7).hp * Math.exp(-u * 22) * 0.5 + Math.sin(TAU * ph) * Math.exp(-u * 28) * 0.6; B.add(i0 + i, s * g * 0.95, s * g); }
}
function hat(B, t, g = 1, open = false) {
  const i0 = Math.round(t * SR), n = Math.round((open ? 0.25 : 0.06) * SR), f = svf();
  for (let i = 0; i < n; i++) { const s = f(noise(), 8000, 0.8).hp * Math.exp(-i / SR * (open ? 12 : 60)); B.add(i0 + i, s * g * 0.8, s * g); }
}
function crash(B, t, g = 1) {
  const i0 = Math.round(t * SR), n = Math.round(1.6 * SR), fl = svf(), fr = svf();
  for (let i = 0; i < n; i++) { const u = i / SR, e = Math.exp(-u * 2.6) * Math.min(1, u / 0.002); B.add(i0 + i, fl(noise(), 5200, 0.6).hp * e * g, fr(noise(), 5400, 0.6).hp * e * g); }
}
function tom(B, t, g = 1, p = 0, f0 = 70) {
  const i0 = Math.round(t * SR), n = Math.round(0.5 * SR), f = svf(), [l, r] = pan(p); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR, fr = f0 + f0 * 0.9 * Math.exp(-u * 18); ph += fr / SR; const s = Math.sin(TAU * ph) * Math.exp(-u * 7) + f(noise(), 900, 1).bp * Math.exp(-u * 25) * 0.6; B.add(i0 + i, s * g * l, s * g * r); }
}
// „braam”: rozstrojone piły w akordzie, filtr otwiera się i gaśnie, nasycenie
function braam(B, t, notes, g = 1, dur = 3.2) {
  const i0 = Math.round(t * SR), n = Math.round(dur * SR), fl = svf(), fr = svf();
  const osc = notes.flatMap(m => [-11, -4, 4, 11].map((dt, k) => ({ f: midi(m) * Math.pow(2, dt / 1200), ph: rnd(), p: (k % 2 ? 1 : -1) * 0.6 })));
  for (let i = 0; i < n; i++) {
    const u = i / SR, env = Math.min(1, u / 0.02) * Math.exp(-u * 1.2), cut = 180 + 3000 * Math.exp(-u * 2) * Math.min(1, u / 0.05);
    let l = 0, r = 0; for (const o of osc) { o.ph += o.f / SR; const s = saw(o.ph); l += s * (1 - o.p) * 0.5; r += s * (1 + o.p) * 0.5; }
    l = Math.tanh(fl(l * 0.35, cut, 1.2).lp * 1.8) * env; r = Math.tanh(fr(r * 0.35, cut, 1.2).lp * 1.8) * env;
    B.add(i0 + i, l * g, r * g);
  }
}
function sub(B, t, g = 1, f0 = 62, f1 = 28, dur = 2.2) {
  const i0 = Math.round(t * SR), n = Math.round(dur * SR); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR, f = f1 + (f0 - f1) * Math.exp(-u * 2.2); ph += f / SR; const s = Math.sin(TAU * ph) * Math.exp(-u * 1.6) * Math.min(1, u / 0.005); B.add(i0 + i, s * g, s * g); }
}
function impact(B, t, g = 1) {
  sub(B, t, 1.1 * g); kick(B, t, 0.9 * g, true);
  const i0 = Math.round(t * SR), f = svf();
  for (let i = 0; i < 0.9 * SR; i++) { const u = i / SR, s = f(noise(), 300 + 3000 * Math.exp(-u * 9), 0.7).lp * Math.exp(-u * 5) * 0.9 * g; B.add(i0 + i, s * (0.8 + rnd() * 0.2), s * (0.8 + rnd() * 0.2)); }
}
// narastanie do chwili t1: szum w paśmie idącym w górę + piła w górę, na końcu cisza (uderzenie robi reszta)
function riser(B, t0, t1, g = 1) {
  const i0 = Math.round(t0 * SR), n = Math.round((t1 - t0) * SR), fl = svf(), fr = svf(); let ph = 0, ph2 = 0.3;
  for (let i = 0; i < n; i++) {
    const x = i / n, e = Math.pow(x, 2.2), fq = 300 * Math.pow(25, x), pf = 90 * Math.pow(6, x);
    ph += pf / SR; ph2 += pf * 1.007 / SR;
    const s = saw(ph) * 0.35 + saw(ph2) * 0.35;
    const l = fl(noise() + s, fq, 2.2).bp, r = fr(noise() + s, fq * 1.05, 2.2).bp;
    B.add(i0 + i, l * e * g, r * e * g);
  }
}
function whoosh(B, t, g = 1, dur = 0.5, dir = 1) {
  const i0 = Math.round((t - dur * 0.6) * SR), n = Math.round(dur * SR), f = svf();
  for (let i = 0; i < n; i++) { const x = i / n, e = Math.sin(Math.PI * Math.pow(x, 0.8)) ** 2, fq = 350 + 3200 * Math.sin(Math.PI * x), s = f(noise(), fq, 1.3).bp * e * g, [l, r] = pan(dir * (x * 1.6 - 0.8)); B.add(i0 + i, s * l, s * r); }
}
// zgrzyt blachy przy uderzeniu: trzask szumu (pasmo 2–3 kHz), metaliczne dzwonienie (nieharmoniczne alikwoty), tąpnięcie basu, odłamki
function crunch(B, t, g = 1) {
  const i0 = Math.round(t * SR), n = Math.round(0.9 * SR), f1 = svf(), f2 = svf(), f3 = svf();
  const parts = [[523, 0.5], [1187, 0.34], [1973, 0.24], [2791, 0.16], [3620, 0.1]].map(([f, a]) => ({ f: f * (0.85 + rnd() * 0.3), a, ph: rnd() }));
  const debris = Array.from({ length: 5 }, () => [0.03 + rnd() * 0.3, 0.2 + rnd() * 0.4]);
  let ph = 0; const p = (rnd() - 0.5) * 0.6, [pl, pr] = pan(p);
  for (let i = 0; i < n; i++) {
    const u = i / SR;
    let s = f1(noise(), 2400, 0.9).bp * Math.exp(-u * 20) * 1.8 + f2(noise(), 700, 1.1).bp * Math.exp(-u * 12) * 0.9;
    let ring = 0; for (const o of parts) { o.ph += o.f / SR; ring += Math.sin(TAU * o.ph) * o.a; } s += ring * Math.exp(-u * 6) * 0.4 * Math.min(1, u / 0.003);
    ph += (34 + 60 * Math.exp(-u * 22)) / SR; s += Math.sin(TAU * ph) * Math.exp(-u * 8) * 1.1;
    for (const [d, a] of debris) if (u > d && u < d + 0.05) s += f3(noise(), 3800, 1.5).bp * Math.exp(-(u - d) * 80) * a * 1.6;
    s = Math.tanh(s * 1.4) * g;
    B.add(i0 + i, s * pl * 1.3, s * pr * 1.3);
  }
}

// prosty pogłos (Freeverb: 8 grzebieni + 4 wszechprzepustowe na kanał)
function reverb(B, wet = 0.3, room = 0.84) {
  const out = new Buf(B.n / SR);
  for (const [src, dst, sp] of [[B.L, out.L, 0], [B.R, out.R, 23]]) {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(d => ({ b: new Float32Array(Math.round((d + sp) * SR / 44100)), i: 0, f: 0 }));
    const aps = [556, 441, 341, 225].map(d => ({ b: new Float32Array(Math.round((d + sp) * SR / 44100)), i: 0 }));
    for (let i = 0; i < B.n; i++) {
      const x = src[i] * 0.015; let y = 0;
      for (const c of combs) { const o = c.b[c.i]; c.f = o * 0.8 + c.f * 0.2; c.b[c.i] = x + c.f * room; if (++c.i >= c.b.length) c.i = 0; y += o; }
      for (const a of aps) { const o = a.b[a.i]; a.b[a.i] = y + o * 0.5; if (++a.i >= a.b.length) a.i = 0; y = o - y; }
      dst[i] = y * wet * 3;
    }
  }
  return out;
}

// ─── muzyka ───
// plan: { total, bpm, sections: [{ from, to, kind: 'intro'|'title'|'drive'|'montage'|'slam'|'outro', n }], hits: [[t, siła]], booms: [t],
//         risers: [[t0, t1]], rolls: [[t0, t1]] (werbel), fills: [[t0, t1]] (tomy), drops: [[t0, t1]] (cisza w muzyce), whooshes: [t] }
// Siatka rytmu liczona od t = 0; wszystkie cięcia leżą na ćwierćnutach (ujęcia mają całkowitą liczbę BEAT klatek).
function music(plan) {
  seed = 12345;
  const T = plan.total + 3, bed = new Buf(T), send = new Buf(T), fx = new Buf(T), fxs = new Buf(T), beat = 60 / plan.bpm, bar = beat * 4;
  const secs = plan.sections.map((s, k, a) => Object.assign({}, s, { fin: !a[k - 1] || a[k - 1].kind !== s.kind, fout: !a[k + 1] || a[k + 1].kind !== s.kind }));
  const secAt = t => { for (const s of secs) if (t >= s.from && t < s.to) return s; return null; };
  const drops = plan.drops || [], inside = (l, t) => l.find(([a, b]) => t >= a - 1e-6 && t < b - 1e-6);
  const dropG = t => { let g = 1; for (const [a, b] of drops) if (t > a - 0.01 && t < b + 0.01) g = Math.min(g, clamp(Math.max(a - t, t - b) / 0.01, 0, 1)); return g; };
  // akordy: d-moll – B – F – C; w montażu po taktach, gdzie indziej zmiana na każdym cięciu (harmonia idzie z obrazem)
  const prog = [[38, 50, 53, 57], [34, 46, 50, 53], [41, 48, 53, 57], [36, 48, 52, 55]];
  const chordAt = (t, s) => prog[(s.kind === 'montage' ? Math.floor(t / bar + 1e-6) : s.n + Math.floor((t - s.from) / bar + 1e-6)) % 4];
  const LV = { intro: 0.75, title: 0.95, drive: 0.8, montage: 1.2, slam: 0.7, outro: 0.6 };
  const bassF = svf(), arpF = svf(), padFL = svf(), padFR = svf(), leadF = svf();
  let bph = 0, aph = 0, lph = 0, pph = [0, 0, 0, 0];
  const n = Math.round(plan.total * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, s = secAt(t); if (!s) continue;
    const dg = dropG(t); if (dg <= 0) continue;
    const bt = t / beat, chord = chordAt(t, s), e8 = (bt * 2) % 1, in8 = Math.floor(bt * 2) % 8, e16 = (bt * 4) % 1, in16 = Math.floor(bt * 4) % 16;
    const sg = (s.fin ? Math.min(1, (t - s.from) / 0.004) : 1) * (s.fout ? Math.min(1, (s.to - t) / 0.004) : 1) * dg * LV[s.kind];
    if (s.kind === 'intro' || s.kind === 'slam' || s.kind === 'outro') {
      // dron: D1 + A1, filtr otwiera się w otwarciu; przy liczbach pulsuje ósemkami
      const x = (t - s.from) / (s.to - s.from), f = s.kind === 'outro' ? 500 * (1 - x) + 140 : s.kind === 'slam' ? 700 : 160 + 700 * x;
      pph[0] += midi(26) / SR; pph[1] += midi(33) / SR * 1.003; pph[2] += midi(26) / SR * 0.997;
      const raw = saw(pph[0]) + saw(pph[1]) * 0.7 + saw(pph[2]) * 0.8;
      const pulse = s.kind === 'slam' ? 0.5 + 0.5 * Math.exp(-e8 * 5) : 1;
      const l = padFL(raw, f, 0.9).lp * 0.34 * pulse * sg, r = padFR(raw, f * 1.04, 0.9).lp * 0.34 * pulse * sg;
      bed.add(i, l, r); send.add(i, l * 0.5, r * 0.5);
      continue;
    }
    const mont = s.kind === 'montage' || s.kind === 'title';
    // bas: ósemki (w montażu szesnastki), pryma z oktawą na „i” — piła przez filtr, mocno nasycona
    const step = mont ? e16 : e8, bn = chord[0] + ((mont ? in16 % 4 === 2 : in8 === 3 || in8 === 6) ? 12 : 0);
    bph += midi(bn) / SR;
    const benv = Math.exp(-step * (mont ? 4 : 3.5)) * Math.min(1, step * 300);
    const bcut = (mont ? 1300 : 600) * (0.6 + 0.9 * benv);
    const b = Math.tanh(bassF(saw(bph) + 0.5 * saw(bph * 1.005), bcut, 1.4).lp * 1.8) * benv * 0.45 * sg;
    bed.add(i, b, b);
    // arpeggio szesnastkami
    const an = chord[[1, 2, 3, 2][in16 % 4]] + 12 + (in16 >= 8 && mont ? 12 : 0);
    aph += midi(an) / SR;
    const a = arpF(saw(aph), 1200 + (mont ? 2800 : 900) * Math.exp(-e16 * 5), 2).lp * Math.exp(-e16 * 7) * (mont ? 0.15 : 0.08) * sg;
    const [pl, pr] = pan(Math.sin(bt * 0.9) * 0.5); bed.add(i, a * pl, a * pr); send.add(i, a * 0.6 * pl, a * 0.6 * pr);
    // w montażu ostry „lead” na ćwierćnutach (kwinta nad prymą akordu)
    if (mont) {
      lph += midi(chord[0] + 31) / SR;
      const le = Math.exp(-(bt % 1) * 5), ld = leadF(saw(lph) + saw(lph * 1.006), 900 + 3000 * le, 1.5).lp * le * 0.07 * sg;
      bed.add(i, ld, ld); send.add(i, ld * 0.8, ld * 0.8);
    }
    // plama akordu w tle
    for (let k = 1; k < 4; k++) pph[k] += midi(chord[k]) / SR * (1 + k * 0.0015);
    const pad = (saw(pph[1]) + saw(pph[2]) + saw(pph[3])) * (mont ? 0.05 : 0.035) * sg;
    const ql = padFL(pad, mont ? 1700 : 900, 0.7).lp, qr = padFR(pad, mont ? 1800 : 950, 0.7).lp;
    bed.add(i, ql, qr); send.add(i, ql, qr);
  }
  // perkusja po siatce szesnastek
  for (let k = 0; k * beat / 4 < plan.total; k++) {
    const t = k * beat / 4, s = secAt(t); if (!s || s.to - t < 0.02 || dropG(t) < 0.5) continue;
    const q = k % 16, g = LV[s.kind], roll = inside(plan.rolls || [], t), fill = inside(plan.fills || [], t);
    if (roll) {   // werbel: szesnastki, w drugiej połowie trzydziestodwójki, coraz głośniej
      const x = (t - roll[0]) / (roll[1] - roll[0]);
      snare(bed, t, 0.25 + 0.75 * x); snare(send, t, 0.2 * x);
      if (x >= 0.5) snare(bed, t + beat / 8, 0.25 + 0.75 * x);
      if (q % 4 === 0) kick(bed, t, 0.9);
      continue;
    }
    if (fill) {   // przejście na tomach przed cięciem
      const x = (t - fill[0]) / Math.max(1e-3, fill[1] - fill[0]);
      tom(bed, t, 0.75, 0.8 - x * 1.6, 110 - 50 * x); tom(send, t, 0.3, 0, 110 - 50 * x);
      if (q % 4 === 0) kick(bed, t, 1.0);
      continue;
    }
    if (s.kind === 'drive') {   // pół-tempo: stopa na 1 i przed 4, werbel na 3
      if (q === 0) kick(bed, t, 1.0 * g / 0.8); if (q === 10) kick(bed, t, 0.7);
      if (q === 8) { snare(bed, t, 0.9); snare(send, t, 0.5); }
      if (q % 2 === 0) hat(bed, t, q % 4 === 2 ? 0.16 : 0.1); if (q === 14) hat(bed, t, 0.2, true);
    } else if (s.kind === 'montage' || s.kind === 'title') {   // cztery na podłogę, werbel na 2 i 4, otwarte hi-haty na „i”
      if (q % 4 === 0) kick(bed, t, 1.15);
      if (q === 4 || q === 12) { snare(bed, t, 1.15); snare(send, t, 0.55); }
      hat(bed, t, q % 2 ? 0.1 : 0.14); if (q % 4 === 2) hat(bed, t, 0.28, true);
    } else if (s.kind === 'intro' && q === 0) { kick(bed, t, 0.6); kick(bed, t + 0.17, 0.4); }     // bicie serca
  }
  // przyciszenie podkładu pod uderzeniami (żeby uderzenie „wybijało” się z muzyki)
  const hits = (plan.hits || []).map(h => Array.isArray(h) ? h : [h, 1]);
  const duck = new Float32Array(bed.n).fill(1);
  for (const [t, g] of [...hits, ...(plan.booms || []).map(t => [t, 1])]) {
    const i0 = Math.round(t * SR);
    for (let i = Math.max(0, i0 - 96); i < Math.min(bed.n, i0 + 0.9 * SR); i++) { const u = (i - i0) / SR, d = Math.min(1, g) * 0.65 * (u < 0 ? 1 + u / 0.002 : Math.exp(-u / 0.28)); duck[i] = Math.min(duck[i], 1 - Math.max(0, d)); }
  }
  const rev = reverb(send, 0.55, 0.86);
  for (let i = 0; i < bed.n; i++) { bed.L[i] = (bed.L[i] + rev.L[i]) * duck[i]; bed.R[i] = (bed.R[i] + rev.R[i]) * duck[i]; }
  // efekty (bez przyciszania)
  for (const [t0, t1] of plan.risers || []) { riser(fx, t0, t1, 0.36); riser(fxs, t0, t1, 0.2); }
  for (const [t, g] of hits) {
    impact(fx, t, 0.95 * g); impact(fxs, t, 0.45 * g);
    if (g >= 0.7) { const c = secAt(t + 0.01), ch = c && c.kind !== 'intro' ? chordAt(t + 0.01, c) : prog[0]; braam(fx, t, [ch[0] - 12, ch[0], ch[0] + 7, ch[1], ch[2]], 0.55 * g); braam(fxs, t, [ch[0] - 12, ch[0], ch[0] + 7], 0.4 * g); crash(fx, t, 0.35 * g); crash(fxs, t, 0.2 * g); }
    else { snare(fx, t, 0.9 * g); crash(fx, t, 0.3 * g); }
  }
  for (const t of plan.booms || []) { sub(fx, t, 1.3, 55, 24, 3.5); braam(fx, t, [25, 37, 44], 0.4, 4.5); braam(fxs, t, [25, 37, 44], 0.5, 4.5); }
  for (const [k, t] of (plan.whooshes || []).entries()) whoosh(fx, t, 0.5, 0.5, k % 2 ? -1 : 1);
  bed.mix(fx); bed.mix(reverb(fxs, 0.55, 0.86));
  // miękkie nasycenie sumy
  for (let i = 0; i < bed.n; i++) { bed.L[i] = Math.tanh(bed.L[i] * 0.9); bed.R[i] = Math.tanh(bed.R[i] * 0.9); }
  return bed;
}

// dźwięk gry z ujęć: pliki WAV kolejno w czasie, krótkie przejścia na cięciach; w zwolnieniu ciszej i ciemniej;
// do tego zgrzyt blachy w chwilach uderzeń (czasy z przebiegu wyścigu)
// parts: [{ at, dur, files: [plik|null, …], sps: [u => prędkość odtwarzania w chwili u ujęcia, …], gain }], crunches: [[t, siła]]
function gameTrack(parts, total, crunches = []) {
  seed = 777;
  const B = new Buf(total), fade = Math.round(0.012 * SR);
  for (const p of parts) {
    const files = p.files.filter(Boolean);
    p.files.forEach((f, k) => {
      if (!f) return;
      const w = readWav(f), i0 = Math.round(p.at * SR), n = Math.min(w.n, Math.round(p.dur * SR));
      const [gl, gr] = files.length > 1 ? (k === 0 ? [1, 0.35] : [0.35, 1]) : [1, 1];
      const g0 = (files.length > 1 ? 0.8 : 1) * (p.gain == null ? 1 : p.gain), lpL = svf(), lpR = svf(), spf = p.sps && p.sps[k];
      for (let i = 0; i < n; i++) {
        const u = i / SR, fd = Math.min(1, i / fade, (n - i) / fade);
        const sp = spf ? Math.max(0.05, Math.min(1, spf(u))) : 1;
        const cut = 900 + 17000 * sp * sp, g = g0 * fd * (0.55 + 0.45 * sp);
        B.add(i0 + i, lpL(w.L[i], cut).lp * g * gl, lpR(w.R[i], cut).lp * g * gr);
      }
    });
  }
  for (const [t, g] of crunches) crunch(B, t, g);
  return B;
}

module.exports = { music, gameTrack, writeWav, readWav, Buf, SR };
