/* Wideo: skrypt wstrzykiwany przez DevTools do każdej ramki przed skryptami strony (Page.addScriptToEvaluateOnNewDocument).
   Gra nie dostaje requestAnimationFrame — każdą klatkę liczy i rysuje reżyser (director.html) krokiem dokładnie 1/60 s.
   ?vtrack=… — tor dla wyścigu w menu (świat budowany raz), ?audio=N — dźwięk gry renderowany offline do bufora N próbek:
   AudioContext gry zastępuje OfflineAudioContext, który reżyser przesuwa klatka po klatce (suspend/resume). */
(() => {
  window.requestAnimationFrame = () => 0;
  const q = new URLSearchParams(location.search);
  if (!/\/v\/[^/]+\//.test(location.pathname)) return;
  try {
    localStorage.setItem('s500.cfg', JSON.stringify({ gfx: 'high', track: q.get('vtrack') || 'speedway' }));
    localStorage.setItem('s500.sound', 'true');
    localStorage.removeItem('s500.snd');
  } catch (e) { /* bez pamięci — domyślne ustawienia */ }
  const n = +q.get('audio');
  if (!n) return;
  const OAC = window.OfflineAudioContext;
  class VideoAudio extends OAC {
    constructor() { super(2, n, 48000); window.__vac = this; this.vStarted = false; }
    get state() { return 'running'; }                       // gra aktualizuje dźwięk tylko przy działającym kontekście
    resume() { return Promise.resolve(); }
    suspend(t) { return t === undefined ? Promise.resolve() : super.suspend(t); }   // usypianie karty w tle — ignorujemy
    // przesunięcie renderowania do chwili t [s] (reżyser, po każdej klatce)
    vAdvance(t) {
      const p = super.suspend(t);
      if (!this.vStarted) { this.vStarted = true; this.vDone = super.startRendering(); } else OAC.prototype.resume.call(this);
      return p;
    }
    vFinish() { if (!this.vStarted) { this.vStarted = true; this.vDone = super.startRendering(); } else OAC.prototype.resume.call(this); return this.vDone; }
  }
  window.AudioContext = VideoAudio; window.webkitAudioContext = VideoAudio;
})();
