/* Wideo: oprawa dźwiękowa liczona w Node (bez próbek z zewnątrz) — muzyka zwiastuna w d-moll, 120 BPM, i efekty:
   uderzenia (sub + „braam”), narastania, przeloty, zwolnienie przy kraksie, tykanie liczników. Plus zszycie dźwięku gry z ujęć.
   Wszystko do WAV 48 kHz stereo 16 bit; miks końcowy i głośność (loudnorm) robi ffmpeg w render.js. */
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
// filtr stanowy (Chamberlin/TPT) — lp/bp/hp z częstotliwością zmienną w czasie
function svf() { let a = 0, b = 0; return (x, f, q = 0.7) => { const g = Math.tan(Math.PI * Math.min(f, SR * 0.45) / SR), k = 1 / q, h = 1 / (1 + g * (g + k)); const hp = (x - (k + g) * a - b) * h, bp = g * hp + a; a = g * hp + bp; const lp = g * bp + b; b = g * bp + lp; return { lp, bp, hp }; }; }
const saw = ph => 2 * (ph - Math.floor(ph + 0.5));
const midi = n => 440 * Math.pow(2, (n - 69) / 12);
const pan = (p) => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

function kick(B, t, g = 1, long = false) {
  const i0 = Math.round(t * SR), n = Math.round((long ? 1.4 : 0.45) * SR); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR, f = 42 + 110 * Math.exp(-u * 28), e = Math.exp(-u * (long ? 2.6 : 7.5)); ph += f / SR; const s = Math.sin(TAU * ph) * e + (i < 90 ? noise() * 0.3 * (1 - i / 90) : 0); B.add(i0 + i, s * g, s * g); }
}
function snare(B, t, g = 1) {
  const i0 = Math.round(t * SR), n = Math.round(0.28 * SR), f = svf(); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR; ph += 185 / SR; const s = f(noise(), 2400, 0.6).bp * Math.exp(-u * 16) * 1.6 + Math.sin(TAU * ph) * Math.exp(-u * 30) * 0.5; B.add(i0 + i, s * g * 0.95, s * g); }
}
function hat(B, t, g = 1, open = false) {
  const i0 = Math.round(t * SR), n = Math.round((open ? 0.25 : 0.06) * SR), f = svf();
  for (let i = 0; i < n; i++) { const s = f(noise(), 8000, 0.8).hp * Math.exp(-i / SR * (open ? 12 : 60)); B.add(i0 + i, s * g * 0.8, s * g); }
}
function tom(B, t, g = 1, p = 0) {
  const i0 = Math.round(t * SR), n = Math.round(0.6 * SR), f = svf(), [l, r] = pan(p); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / SR, fr = 70 + 60 * Math.exp(-u * 18); ph += fr / SR; const s = Math.sin(TAU * ph) * Math.exp(-u * 6) + f(noise(), 900, 1).bp * Math.exp(-u * 25) * 0.6; B.add(i0 + i, s * g * l, s * g * r); }
}
// „braam”: rozstrojone piły w akordzie, filtr otwiera się i gaśnie, nasycenie
function braam(B, t, notes, g = 1, dur = 3.2) {
  const i0 = Math.round(t * SR), n = Math.round(dur * SR), fl = svf(), fr = svf();
  const osc = notes.flatMap(m => [-11, -4, 4, 11].map((dt, k) => ({ f: midi(m) * Math.pow(2, dt / 1200), ph: rnd(), p: (k % 2 ? 1 : -1) * 0.6 })));
  for (let i = 0; i < n; i++) {
    const u = i / SR, env = Math.min(1, u / 0.03) * Math.exp(-u * 1.1), cut = 180 + 2600 * Math.exp(-u * 1.8) * Math.min(1, u / 0.08);
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
function whoosh(B, t, g = 1, dur = 0.55, dir = 1) {
  const i0 = Math.round((t - dur * 0.6) * SR), n = Math.round(dur * SR), f = svf();
  for (let i = 0; i < n; i++) { const x = i / n, e = Math.sin(Math.PI * Math.pow(x, 0.8)) ** 2, fq = 350 + 3200 * Math.sin(Math.PI * x), s = f(noise(), fq, 1.3).bp * e * g, [l, r] = pan(dir * (x * 1.6 - 0.8)); B.add(i0 + i, s * l, s * r); }
}
function tick(B, t, g = 1) { const i0 = Math.round(t * SR); for (let i = 0; i < 0.03 * SR; i++) { const s = Math.sin(TAU * 2300 * i / SR) * Math.exp(-i / SR * 180) * g; B.add(i0 + i, s, s); } }

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
// plan: { total, bpm, sections: [{ from, to, kind: 'intro'|'drive'|'drive-dark'|'montage'|'break'|'outro' }], hits: [t], risers: [[t0, t1]], whooshes: [t], booms: [t], ticks: [t] }
function music(plan) {
  seed = 12345;
  const T = plan.total + 3, dry = new Buf(T), send = new Buf(T), beat = 60 / plan.bpm;
  const secAt = t => plan.sections.find(s => t >= s.from && t < s.to);
  // akordy: d-moll – B – F – C (po takcie)
  const prog = [[38, 50, 53, 57], [34, 46, 50, 53], [41, 48, 53, 57], [36, 48, 52, 55]];
  const bassF = svf(), arpF = svf(), padFL = svf(), padFR = svf();
  let bph = 0, aph = 0, pph = [0, 0, 0, 0], prevSec = null;
  const n = Math.round(plan.total * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, s = secAt(t); if (!s) continue;
    const bt = t / beat, bar = Math.floor(bt / 4), chord = prog[bar % 4], e8 = (bt * 2) % 1, in8 = Math.floor(bt * 2) % 8;
    const fadeIn = Math.min(1, (t - s.from) / 0.05), fadeOut = Math.min(1, (s.to - t) / 0.05), sg = fadeIn * fadeOut;
    if (s.kind === 'intro' || s.kind === 'break' || s.kind === 'outro') {
      // dron: D1 + A1, powoli otwierany filtr; w przerwie pulsuje ósemkami
      const x = (t - s.from) / (s.to - s.from), f = s.kind === 'outro' ? 700 * (1 - x) + 120 : 140 + 500 * x;
      pph[0] += midi(26) / SR; pph[1] += midi(33) / SR * 1.003; pph[2] += midi(26) / SR * 0.997;
      const raw = saw(pph[0]) + saw(pph[1]) * 0.7 + saw(pph[2]) * 0.8;
      const pulse = s.kind === 'break' ? 0.55 + 0.45 * Math.exp(-e8 * 6) : 1;
      const l = padFL(raw, f, 0.9).lp * 0.3 * pulse * sg, r = padFR(raw, f * 1.04, 0.9).lp * 0.3 * pulse * sg;
      dry.add(i, l, r); send.add(i, l * 0.5, r * 0.5);
      continue;
    }
    // bas ósemkami: pryma, co czwarta ósemka oktawa wyżej; ciemniej przed „PO”
    const dark = s.kind === 'drive-dark', mont = s.kind === 'montage';
    const bn = chord[0] + (in8 === 3 || in8 === 6 ? 12 : 0);
    bph += midi(bn) / SR;
    const benv = Math.exp(-e8 * (dark ? 5 : 3.5)) * Math.min(1, e8 * 400);
    const bcut = (dark ? 260 : mont ? 900 : 520) * (0.6 + 0.8 * benv);
    const b = Math.tanh(bassF(saw(bph) + 0.5 * saw(bph * 1.005), bcut, 1.4).lp * 1.6) * benv * 0.42 * sg;
    dry.add(i, b, b);
    // arpeggio szesnastkami (jasne ujęcia i montaż)
    if (!dark) {
      const in16 = Math.floor(bt * 4) % 16, e16 = (bt * 4) % 1, an = chord[[1, 2, 3, 2][in16 % 4]] + 12 + (in16 >= 8 && mont ? 12 : 0);
      aph += midi(an) / SR;
      const a = arpF(saw(aph), 1200 + (mont ? 2400 : 900) * Math.exp(-e16 * 5), 2).lp * Math.exp(-e16 * 7) * (mont ? 0.16 : 0.1) * sg;
      const [pl, pr] = pan(Math.sin(bt * 0.9) * 0.5); dry.add(i, a * pl, a * pr); send.add(i, a * 0.6 * pl, a * 0.6 * pr);
    }
    // plama akordu w tle
    for (let k = 1; k < 4; k++) pph[k] += midi(chord[k]) / SR * (1 + k * 0.0015);
    const pad = (saw(pph[1]) + saw(pph[2]) + saw(pph[3])) * (mont ? 0.05 : 0.035) * sg;
    const pl = padFL(pad, mont ? 1600 : 900, 0.7).lp, pr = padFR(pad, mont ? 1700 : 950, 0.7).lp;
    dry.add(i, pl, pr); send.add(i, pl, pr);
    prevSec = s;
  }
  // perkusja po siatce taktów
  for (let k = 0; k * beat / 4 < plan.total; k++) {
    const t = k * beat / 4, s = secAt(t); if (!s || s.to - t < 0.02) continue;
    const q = k % 16;
    if (s.kind === 'drive' || s.kind === 'montage' || s.kind === 'drive-dark') {
      if (q % 4 === 0) kick(dry, t, s.kind === 'drive-dark' ? 0.75 : 0.9);
      if (q === 4 || q === 12) { snare(dry, t, 0.55); snare(send, t, 0.4); }
      if (q % 2 === 1 && s.kind !== 'drive-dark') hat(dry, t, 0.16);
      if (s.kind === 'montage' && q % 4 === 2) hat(dry, t, 0.22, true);
      // przejście w bębnach co dwa takty w montażu
      const bar = Math.floor(k / 16);
      if (s.kind === 'montage' && bar % 2 === 1 && q >= 12) { tom(dry, t, 0.55, (q - 13.5) / 3); tom(send, t, 0.3); }
    } else if (s.kind === 'intro' && q === 0) { kick(dry, t, 0.55); kick(dry, t + beat * 0.38, 0.35); }     // bicie serca
    else if (s.kind === 'break' && q % 4 === 0) kick(dry, t, 0.5);
  }
  for (const [t0, t1] of plan.risers || []) { riser(dry, t0, t1, 0.34); riser(send, t0, t1, 0.2); }
  for (const t of plan.hits || []) { impact(dry, t, 0.9); impact(send, t, 0.5); braam(dry, t, [26, 38, 45, 50, 53], 0.55); braam(send, t, [26, 38, 45, 50, 53], 0.45); }
  for (const t of plan.booms || []) { sub(dry, t, 1.2, 55, 24, 3.5); braam(dry, t, [25, 37, 44], 0.4, 4.5); braam(send, t, [25, 37, 44], 0.5, 4.5); }
  for (const [k, t] of (plan.whooshes || []).entries()) whoosh(dry, t, 0.45, 0.55, k % 2 ? -1 : 1);
  for (const t of plan.ticks || []) tick(dry, t, 0.12);
  dry.mix(reverb(send, 0.55, 0.86));
  // miękkie nasycenie sumy
  for (let i = 0; i < dry.n; i++) { dry.L[i] = Math.tanh(dry.L[i] * 0.9); dry.R[i] = Math.tanh(dry.R[i] * 0.9); }
  return dry;
}

// dźwięk gry z ujęć: pliki WAV kolejno w czasie, krótkie przejścia na cięciach; w zwolnieniu ciszej i ciemniej
// parts: [{ at, dur, files: [plik|null, …], sp: u => prędkość odtwarzania w chwili u ujęcia }]
function gameTrack(parts, total) {
  const B = new Buf(total), fade = Math.round(0.012 * SR);
  for (const p of parts) {
    const files = p.files.filter(Boolean);
    p.files.forEach((f, k) => {
      if (!f) return;
      const w = readWav(f), i0 = Math.round(p.at * SR), n = Math.min(w.n, Math.round(p.dur * SR));
      const [gl, gr] = files.length > 1 ? (k === 0 ? [1, 0.35] : [0.35, 1]) : [1, 1];
      const g0 = files.length > 1 ? 0.8 : 1, lpL = svf(), lpR = svf();
      for (let i = 0; i < n; i++) {
        const u = i / SR, fd = Math.min(1, i / fade, (n - i) / fade);
        const sp = p.sp ? Math.max(0.05, Math.min(1, p.sp(u))) : 1;
        const cut = 500 + 17000 * sp * sp, g = g0 * fd * (0.45 + 0.55 * sp);
        B.add(i0 + i, lpL(w.L[i], cut).lp * g * gl, lpR(w.R[i], cut).lp * g * gr);
      }
    });
  }
  return B;
}

module.exports = { music, gameTrack, writeWav, readWav, Buf, SR };
