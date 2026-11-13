import { midiToFreq } from './music.js';

const BRASS_HARMONICS = [0, 1, 0.85, 0.75, 0.55, 0.4, 0.28, 0.2, 0.14, 0.1, 0.07, 0.05];

export class Engine {
  constructor() {
    this.ctx = null;
    this.a4 = 440;
    this.volumes = { solo: 0.9, bass: 0.7, comp: 0.5, ride: 0.5 };
    this.buses = null;
    this.session = null;
  }

  ensure() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.ratio.value = 4;
      this.master.connect(compressor).connect(this.ctx.destination);
      const real = new Float32Array(BRASS_HARMONICS.length);
      this.brassWave = this.ctx.createPeriodicWave(real, Float32Array.from(BRASS_HARMONICS));
      const length = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Fresh output buses so stopping can cut every scheduled note at once. */
  beginSession() {
    this.endSession();
    const ctx = this.ensure();
    const out = ctx.createGain();
    out.connect(this.master);
    const buses = {};
    for (const name of Object.keys(this.volumes)) {
      buses[name] = ctx.createGain();
      buses[name].gain.value = this.volumes[name];
      buses[name].connect(out);
    }
    this.session = out;
    this.buses = buses;
  }

  endSession() {
    if (!this.session) return;
    const out = this.session;
    const now = this.ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0, now + 0.04);
    setTimeout(() => out.disconnect(), 120);
    this.session = null;
    this.buses = null;
  }

  setVolume(name, value) {
    this.volumes[name] = value;
    if (this.buses) this.buses[name].gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  noiseSource(when, offsetSeed) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(when, (offsetSeed % 1.5) * 1.0);
    return src;
  }

  trumpet(midi, when, dur, level = 1) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi, this.a4);
    const length = Math.max(dur, 0.07);
    const end = when + length;

    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    const oscillators = [0, 5].map((cents) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(this.brassWave);
      osc.frequency.value = freq;
      osc.detune.value = cents;
      osc.connect(mix);
      osc.start(when);
      osc.stop(end + 0.3);
      return osc;
    });

    if (length > 0.45) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.4;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, when);
      depth.gain.linearRampToValueAtTime(11, when + Math.min(0.7, length * 0.8));
      lfo.connect(depth);
      for (const osc of oscillators) depth.connect(osc.detune);
      lfo.start(when);
      lfo.stop(end + 0.3);
    }

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.Q.value = 0.9;
    lowpass.frequency.setValueAtTime(freq * 2.2, when);
    lowpass.frequency.linearRampToValueAtTime(Math.min(freq * 7, 9000), when + 0.05);
    lowpass.frequency.linearRampToValueAtTime(Math.min(freq * 4.5, 6000), when + 0.28);
    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.frequency.value = 1400;
    formant.Q.value = 0.8;
    formant.gain.value = 4;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(0.9 * level, when + 0.03);
    amp.gain.setTargetAtTime(0.65 * level, when + 0.03, 0.09);
    amp.gain.setTargetAtTime(0.0001, end - 0.025, 0.03);
    mix.connect(lowpass).connect(formant).connect(amp).connect(this.buses.solo);

    const chiff = this.noiseSource(when, freq);
    const chiffFilter = ctx.createBiquadFilter();
    chiffFilter.type = 'bandpass';
    chiffFilter.frequency.value = 2600;
    chiffFilter.Q.value = 1;
    const chiffAmp = ctx.createGain();
    chiffAmp.gain.setValueAtTime(0.05 * level, when);
    chiffAmp.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    chiff.connect(chiffFilter).connect(chiffAmp).connect(this.buses.solo);
    chiff.stop(when + 0.06);
  }

  bassNote(midi, when, dur) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi, this.a4);
    const end = when + dur;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 520;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(0.85, when + 0.01);
    amp.gain.setTargetAtTime(0.45, when + 0.012, 0.2);
    amp.gain.setTargetAtTime(0.0001, end - 0.03, 0.04);
    for (const [type, gain] of [['triangle', 0.8], ['sine', 0.6]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(lowpass);
      osc.start(when);
      osc.stop(end + 0.3);
    }
    lowpass.connect(amp).connect(this.buses.bass);
  }

  compChord(midis, when, dur) {
    const ctx = this.ctx;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2400;
    const amp = ctx.createGain();
    const peak = 0.34 / Math.sqrt(midis.length);
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.006);
    amp.gain.setTargetAtTime(0.0001, when + 0.02, Math.max(0.08, dur * 0.3));
    for (const midi of midis) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(midi, this.a4);
      osc.connect(lowpass);
      osc.start(when);
      osc.stop(when + dur + 0.6);
    }
    lowpass.connect(amp).connect(this.buses.comp);
  }

  ridePing(when, accent, hat) {
    const ctx = this.ctx;
    const src = this.noiseSource(when, when * 7.31);
    const filter = ctx.createBiquadFilter();
    filter.type = hat ? 'highpass' : 'bandpass';
    filter.frequency.value = hat ? 5200 : 9000;
    filter.Q.value = 0.7;
    const amp = ctx.createGain();
    const peak = (hat ? 0.22 : 0.16) * accent;
    const decay = hat ? 0.05 : 0.22;
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    src.connect(filter).connect(amp).connect(this.buses.ride);
    src.stop(when + decay + 0.02);
    if (!hat) {
      const ping = ctx.createOscillator();
      ping.type = 'triangle';
      ping.frequency.value = 5200;
      const pingAmp = ctx.createGain();
      pingAmp.gain.setValueAtTime(0.0001, when);
      pingAmp.gain.exponentialRampToValueAtTime(0.03 * accent, when + 0.002);
      pingAmp.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);
      ping.connect(pingAmp).connect(this.buses.ride);
      ping.start(when);
      ping.stop(when + 0.32);
    }
  }

  click(when, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = accent ? 1500 : 1000;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(0.5, when + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(amp).connect(this.buses.ride);
    osc.start(when);
    osc.stop(when + 0.06);
  }

  /** Plain sine at the given frequency, for checking pitch against a tuner. */
  referenceTone(freq, seconds = 2) {
    const ctx = this.ensure();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(0.35, now + 0.04);
    amp.gain.setValueAtTime(0.35, now + seconds - 0.1);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    osc.connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + seconds + 0.05);
  }
}

/** Swing warp: maps straight beat positions to swung ones (offbeat eighth moves to `point`). */
export function warpBeat(beat, point) {
  const i = Math.floor(beat);
  const f = beat - i;
  return i + (f < 0.5 ? f * 2 * point : point + (f - 0.5) * 2 * (1 - point));
}

export function unwarpBeat(beat, point) {
  const i = Math.floor(beat);
  const f = beat - i;
  return i + (f < point ? f / (2 * point) : 0.5 + (f - point) / (2 * (1 - point)));
}

/** Swing point used by "auto": triplet feel at medium tempi, flattening as the tempo rises. */
export function autoSwingPoint(bpm) {
  return Math.max(0.52, Math.min(0.667, 0.667 - ((bpm - 140) / 120) * 0.14));
}

/**
 * Look-ahead scheduler. `getChorus(index)` returns { solo, backing } for each pass
 * over the chart; `timeline` records when each pass starts so the UI can follow along.
 */
export class Player {
  constructor(engine) {
    this.engine = engine;
    this.timer = null;
    this.timeline = [];
    this.playing = false;
  }

  start({ bpm, swingPoint, countIn, getChorus, a4 }) {
    this.stop();
    const engine = this.engine;
    engine.a4 = a4;
    engine.beginSession();
    this.bpm = bpm;
    this.spb = 60 / bpm;
    this.swing = swingPoint;
    this.getChorus = getChorus;
    this.timeline = [];
    this.nextIndex = 0;
    const t0 = engine.ctx.currentTime + 0.12;
    this.countInBeats = countIn ? 4 : 0;
    this.chorusT0 = t0 + this.countInBeats * this.spb;
    this.queue = [];
    this.cursor = 0;
    this.countInT0 = t0;
    this.countInDone = !countIn;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 30);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.playing) this.engine.endSession();
    this.playing = false;
  }

  timeOf(chorusT0, beat) {
    return chorusT0 + warpBeat(beat, this.swing) * this.spb;
  }

  prepareChorus() {
    const index = this.nextIndex++;
    const chorus = this.getChorus(index);
    const t0 = index === 0 ? this.chorusT0 : this.timeline[index - 1].t0 + this.timeline[index - 1].chorus.solo.totalBeats * this.spb;
    this.timeline.push({ index, t0, chorus });
    const events = [];
    for (const n of chorus.solo.notes) events.push({ beat: n.start, kind: 'solo', n });
    for (const n of chorus.backing.bass) events.push({ beat: n.start, kind: 'bass', n });
    for (const n of chorus.backing.comp) events.push({ beat: n.start, kind: 'comp', n });
    for (const n of chorus.backing.ride) events.push({ beat: n.start, kind: 'ride', n });
    events.sort((a, b) => a.beat - b.beat);
    this.queue = events.map((e) => ({ ...e, t0 }));
    this.cursor = 0;
  }

  schedule(ev) {
    const e = this.engine;
    const warp = (b) => warpBeat(b, this.swing);
    const when = ev.t0 + warp(ev.beat) * this.spb;
    const span = (n) => (warp(n.start + n.dur) - warp(n.start)) * this.spb;
    if (ev.kind === 'solo') e.trumpet(ev.n.midi, when, Math.max(0.07, span(ev.n) - (ev.n.dur <= 0.5 ? 0.03 : 0.045)));
    else if (ev.kind === 'bass') e.bassNote(ev.n.midi, when, span(ev.n));
    else if (ev.kind === 'comp') e.compChord(ev.n.midis, when, span(ev.n));
    else e.ridePing(when, ev.n.accent, Boolean(ev.n.hat));
  }

  tick() {
    const e = this.engine;
    const horizon = e.ctx.currentTime + 0.3;
    if (!this.countInDone) {
      for (let i = 0; i < this.countInBeats; i++) e.click(this.countInT0 + i * this.spb, i === 0);
      this.countInDone = true;
    }
    for (let guard = 0; guard < 4000; guard++) {
      if (this.queue.length === 0 || this.cursor >= this.queue.length) {
        const last = this.timeline[this.timeline.length - 1];
        const nextStart = last ? last.t0 + last.chorus.solo.totalBeats * this.spb : this.chorusT0;
        if (nextStart - 0.05 > horizon) break;
        this.prepareChorus();
        continue;
      }
      const ev = this.queue[this.cursor];
      if (ev.t0 + warpBeat(ev.beat, this.swing) * this.spb > horizon) break;
      this.schedule(ev);
      this.cursor++;
    }
  }

  /** Where playback is now: chorus pass and straight beat position, or null before the first pass. */
  position() {
    if (!this.playing) return null;
    const now = this.engine.ctx.currentTime - (this.engine.ctx.outputLatency || 0);
    let pass = null;
    for (const entry of this.timeline) if (entry.t0 <= now) pass = entry;
    if (!pass) return { counting: true, beat: -((this.chorusT0 - now) / this.spb) };
    return { counting: false, pass, beat: unwarpBeat((now - pass.t0) / this.spb, this.swing) };
  }
}
