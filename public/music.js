/*
 * Background music: "Shchedryk" (M. Leontovych, 1916, public domain),
 * synthesized live with the Web Audio API — bells, bass, melody, sleigh bells.
 * If LETTER_CONFIG.musicUrl is set, that audio file is played in a loop instead.
 */
window.Music = (function () {
  const BEAT = 0.4;
  const BAR = BEAT * 3;
  const LOOP_BARS = 28;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // [midi, startBeat, lengthBeats]
  const OSTINATO = [[70, 0, 1], [69, 1, 0.5], [70, 1.5, 0.5], [67, 2, 1]]; // Bb A Bb G
  const UPPER = [[74, 0, 1], [72, 1, 0.5], [74, 1.5, 0.5], [70, 2, 1]];    // D C D Bb
  const BASS = [43, 41, 39, 38];  // G F Eb D
  const TOP = [79, 77, 75, 74];   // G F Eb D (one octave up)

  let ctx = null, bus = null, master = null, noiseBuf = null;
  let timer = null, nextBarTime = 0, barIndex = 0;
  let fileAudio = null, keepAlive = null;
  let enabled = false;   // user wants music
  let running = false;   // currently sounding

  function cfgUrl() {
    return (window.LETTER_CONFIG && window.LETTER_CONFIG.musicUrl) || "";
  }

  function makeImpulse(seconds, decay) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    // iOS: a phone call or Siri leaves the context "interrupted"; pick the music up again afterwards
    ctx.onstatechange = () => {
      if (running && !document.hidden && ctx.state !== "running") setTimeout(() => { if (running) ctx.resume().catch(() => {}); }, 400);
    };
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);

    bus = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(2.8, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    bus.connect(master);
    bus.connect(reverb);
    reverb.connect(wet);
    wet.connect(master);

    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return true;
  }

  function env(g, t, peak, attack, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
  }

  function bell(t, midi, vel, decay) {
    const f = mtof(midi);
    const partials = [[1, 1], [2, 0.42], [3, 0.2], [4.17, 0.1], [5.43, 0.05]];
    const out = ctx.createGain();
    out.gain.value = vel;
    out.connect(bus);
    partials.forEach(([ratio, amp], i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      const d = decay / (1 + i * 0.9);
      env(g, t, amp, 0.004, t + d);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + d + 0.05);
    });
  }

  function bass(t, midi, len, vel) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = mtof(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.06);
    g.gain.exponentialRampToValueAtTime(vel * 0.5, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.1);
    o.connect(lp); lp.connect(g); g.connect(bus);
    o.start(t);
    o.stop(t + len + 0.2);
  }

  function melody(t, midi, len, vel) {
    const f = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.12);
    g.gain.exponentialRampToValueAtTime(vel * 0.55, t + len * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.25);
    g.connect(bus);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = f * 0.004;
    lfo.connect(lfoGain);
    [["sine", 0, 1], ["triangle", 4, 0.35]].forEach(([type, detune, amp]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      lfoGain.connect(o.frequency);
      const a = ctx.createGain();
      a.gain.value = amp;
      o.connect(a); a.connect(g);
      o.start(t); o.stop(t + len + 0.3);
    });
    lfo.start(t); lfo.stop(t + len + 0.3);
  }

  function jingle(t, vel) {
    for (let k = 0; k < 3; k++) {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 7000 + Math.random() * 2500;
      bp.Q.value = 2.5;
      const g = ctx.createGain();
      const tt = t + k * 0.018;
      env(g, tt, vel * (1 - k * 0.25), 0.002, tt + 0.12);
      s.connect(bp); bp.connect(g); g.connect(bus);
      s.start(tt); s.stop(tt + 0.2);
    }
  }

  function scheduleBar(i, t) {
    const b = i % LOOP_BARS;
    const chord = b % 4;
    const section = b < 4 ? 0 : b < 8 ? 1 : b < 16 ? 2 : b < 24 ? 3 : 4;
    const ostVel = section === 4 ? 0.2 : 0.27;

    OSTINATO.forEach(([m, s]) => bell(t + s * BEAT, m, ostVel, 1.6));
    if (section >= 1) bass(t, BASS[chord], BAR, section === 4 ? 0.16 : 0.22);
    if (section === 2 || section === 3) UPPER.forEach(([m, s]) => bell(t + s * BEAT, m, 0.13, 1.2));
    if (section === 3) melody(t, TOP[chord], BAR * 0.95, 0.07);
    if (section === 2 || section === 3) {
      for (let k = 0; k < 3; k++) jingle(t + k * BEAT, k === 0 ? 0.09 : 0.05);
    } else if (section === 1) {
      jingle(t, 0.06);
    }
  }

  function tick() {
    if (!ctx || ctx.state !== "running") return;
    while (nextBarTime < ctx.currentTime + 0.35) {
      scheduleBar(barIndex++, nextBarTime);
      nextBarTime += BAR;
    }
  }

  // Silent looping <audio> puts iOS into "playback" audio session,
  // so Web Audio is heard even with the ring/silent switch on.
  function silentWavUrl() {
    const rate = 8000, n = rate / 2;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }

  function resumeSynth() {
    if (!ctx && !init()) return;
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* ignore */ }
    if (!keepAlive) {
      keepAlive = new Audio(silentWavUrl());
      keepAlive.loop = true;
      keepAlive.setAttribute("playsinline", "");
    }
    keepAlive.play().catch(() => {});
    ctx.resume().then(() => {
      if (nextBarTime < ctx.currentTime) nextBarTime = ctx.currentTime + 0.1;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.75, ctx.currentTime + 1.5);
      tick();
    });
    if (!timer) timer = setInterval(tick, 60);
  }

  function pauseSynth() {
    if (timer) { clearInterval(timer); timer = null; }
    if (keepAlive) keepAlive.pause();
    if (!ctx) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.3);
    setTimeout(() => { if (!running && ctx) ctx.suspend(); }, 350);
  }

  function play() {
    running = true;
    const url = cfgUrl();
    if (url) {
      if (!fileAudio) {
        fileAudio = new Audio(url);
        fileAudio.loop = true;
        fileAudio.volume = 0.6;
        fileAudio.setAttribute("playsinline", "");
      }
      fileAudio.play().catch(() => {});
    } else {
      resumeSynth();
    }
  }

  function pause() {
    running = false;
    if (fileAudio) fileAudio.pause();
    else pauseSynth();
  }

  document.addEventListener("visibilitychange", () => {
    if (!enabled) return;
    if (document.hidden) pause(); else play();
  });
  window.addEventListener("pagehide", () => { if (enabled) pause(); });

  return {
    // must be called from a user gesture (tap) — required by iOS Safari
    start() { enabled = true; play(); },
    stop() { enabled = false; pause(); },
    toggle() { if (enabled) this.stop(); else this.start(); return enabled; },
    get enabled() { return enabled; }
  };
})();
