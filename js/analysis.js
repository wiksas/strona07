import { DETECTABLE_QUALITIES, QUALITIES, estimateKey, formatChord, mod12, prefersFlats } from './music.js';

const TARGET_SR = 11025;
const FFT_SIZE = 4096;
const HOP = 512;
const MAX_SECONDS = 360;
const MIN_SECONDS = 12;
const SWITCH_PENALTY = 0.08;
const DIATONIC_BONUS = 0.04;

export class AnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function downsample(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_SR));
  const sr = sampleRate / factor;
  if (factor === 1) return { data: Float32Array.from(samples), sr };
  const half = factor * 4;
  const taps = new Float32Array(2 * half + 1);
  const cutoff = 0.45 / factor;
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const sinc = i === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i);
    const window = 0.5 + 0.5 * Math.cos((Math.PI * i) / (half + 1));
    taps[i + half] = sinc * window;
    sum += taps[i + half];
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  const outLength = Math.floor(samples.length / factor);
  const out = new Float32Array(outLength);
  const n = samples.length;
  for (let o = 0; o < outLength; o++) {
    const start = o * factor - half;
    let acc = 0;
    for (let k = 0; k < taps.length; k++) {
      const idx = start + k;
      if (idx >= 0 && idx < n) acc += samples[idx] * taps[k];
    }
    out[o] = acc;
  }
  return { data: out, sr };
}

function makeFFT(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

/**
 * One pass over the signal: spectral flux (onset strength), per-frame energy and
 * spectral peaks. Two real frames share one complex FFT (frame A in re, B in im).
 */
function spectralPass(data, sr, onProgress) {
  const frames = Math.floor((data.length - FFT_SIZE) / HOP) + 1;
  const fft = makeFFT(FFT_SIZE);
  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
  const binHz = sr / FFT_SIZE;
  const kFluxLo = Math.ceil(60 / binHz);
  const kFluxHi = Math.floor(4000 / binHz);
  const kPeakLo = Math.ceil(70 / binHz);
  const kPeakHi = Math.floor(2200 / binHz);
  const ampScale = 4 / FFT_SIZE;

  const flux = new Float32Array(frames);
  const energy = new Float32Array(frames);
  const peakStart = new Uint32Array(frames + 1);
  const peakFreq = [];
  const peakAmp = [];
  const prevLog = new Float32Array(kFluxHi + 2);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const amps = [new Float32Array(kFluxHi + 2), new Float32Array(kFluxHi + 2)];

  const consume = (f, a) => {
    let fl = 0;
    let en = 0;
    let max = 0;
    for (let k = kFluxLo; k <= kFluxHi; k++) {
      const v = a[k];
      const lg = Math.log1p(v * 1000);
      const diff = lg - prevLog[k];
      if (diff > 0) fl += diff;
      prevLog[k] = lg;
      en += v * v;
      if (k >= kPeakLo && k <= kPeakHi && v > max) max = v;
    }
    flux[f] = f === 0 ? 0 : fl;
    energy[f] = en;
    peakStart[f] = peakFreq.length;
    const floor = Math.max(max * 0.15, 1e-3);
    for (let k = kPeakLo; k <= kPeakHi; k++) {
      const v = a[k];
      if (v > floor && v > a[k - 1] && v >= a[k + 1]) {
        const al = Math.log(a[k - 1] + 1e-9);
        const be = Math.log(v);
        const ga = Math.log(a[k + 1] + 1e-9);
        const denom = al - 2 * be + ga;
        const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (al - ga)) / denom)) : 0;
        peakFreq.push((k + delta) * binHz);
        peakAmp.push(v);
      }
    }
  };

  for (let f = 0; f < frames; f += 2) {
    const hasB = f + 1 < frames;
    const offA = f * HOP;
    const offB = (f + 1) * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = data[offA + i] * hann[i];
      im[i] = hasB ? data[offB + i] * hann[i] : 0;
    }
    fft(re, im);
    const [ampA, ampB] = amps;
    for (let k = 1; k <= kFluxHi + 1; k++) {
      const nk = FFT_SIZE - k;
      const sRe = re[k] + re[nk];
      const sIm = im[k] - im[nk];
      const dRe = re[k] - re[nk];
      const dIm = im[k] + im[nk];
      ampA[k] = 0.5 * Math.hypot(sRe, sIm) * ampScale;
      ampB[k] = 0.5 * Math.hypot(dRe, dIm) * ampScale;
    }
    consume(f, ampA);
    if (hasB) consume(f + 1, ampB);
    if ((f & 255) === 0) onProgress(f / frames);
  }
  peakStart[frames] = peakFreq.length;
  return { frames, flux, energy, peakStart, peakFreq, peakAmp };
}

function estimateTuning(pass) {
  let c = 0;
  let s = 0;
  let w = 0;
  for (let i = 0; i < pass.peakFreq.length; i++) {
    const m = 69 + 12 * Math.log2(pass.peakFreq[i] / 440);
    const dev = m - Math.round(m);
    const weight = Math.sqrt(pass.peakAmp[i]);
    c += weight * Math.cos(2 * Math.PI * dev);
    s += weight * Math.sin(2 * Math.PI * dev);
    w += weight;
  }
  if (w === 0 || Math.hypot(c, s) / w < 0.2) return 0;
  return Math.atan2(s, c) / (2 * Math.PI);
}

function buildChroma(pass, tuning) {
  const chroma = new Float32Array(pass.frames * 12);
  for (let f = 0; f < pass.frames; f++) {
    const base = f * 12;
    for (let i = pass.peakStart[f]; i < pass.peakStart[f + 1]; i++) {
      const freq = pass.peakFreq[i];
      const m = 69 + 12 * Math.log2(freq / 440) - tuning;
      const r = Math.round(m);
      if (Math.abs(m - r) > 0.35) continue;
      chroma[base + mod12(r)] += Math.sqrt(pass.peakAmp[i]) / (1 + freq / 1000);
    }
    let sum = 0;
    for (let p = 0; p < 12; p++) sum += chroma[base + p];
    if (sum > 0) for (let p = 0; p < 12; p++) chroma[base + p] /= sum;
  }
  return chroma;
}

function onsetEnvelope(flux) {
  const n = flux.length;
  const env = new Float32Array(n);
  const radius = 16;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += flux[j];
    env[i] = Math.max(0, flux[i] - sum / (hi - lo + 1));
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (env[i] > max) max = env[i];
  if (max > 0) for (let i = 0; i < n; i++) env[i] /= max;
  return env;
}

function sampleAt(env, t) {
  const i = Math.floor(t);
  if (i < 0 || i >= env.length - 1) return 0;
  const fr = t - i;
  return env[i] * (1 - fr) + env[i + 1] * fr;
}

/** Comb-filter tempo search with a mild preference for mid-range tempi. */
function estimateTempo(env, fps) {
  let best = { score: -1, bpm: 120, offset: 0, period: (60 / 120) * fps };
  const n = env.length;
  for (let bpm = 55; bpm <= 240; bpm += 0.5) {
    const period = (60 / bpm) * fps;
    const phases = Math.max(8, Math.round(period * 2));
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 130) / 0.8) ** 2);
    for (let ph = 0; ph < phases; ph++) {
      const offset = (ph / phases) * period;
      let sum = 0;
      let count = 0;
      for (let t = offset; t < n - 1; t += period) {
        sum += sampleAt(env, t);
        count++;
      }
      if (count < 4) continue;
      const score = (sum / count) * prior;
      if (score > best.score) best = { score, bpm, offset, period };
    }
  }
  return best;
}

function countOnsets(env) {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < env.length; i++) {
    sum += env[i];
    sq += env[i] * env[i];
  }
  const mean = sum / env.length;
  const std = Math.sqrt(Math.max(0, sq / env.length - mean * mean));
  const threshold = mean + 0.8 * std;
  let count = 0;
  for (let i = 2; i < env.length - 2; i++) {
    if (env[i] > threshold && env[i] >= env[i - 1] && env[i] > env[i + 1] && env[i] > env[i - 2] && env[i] >= env[i + 2]) count++;
  }
  return count;
}

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
};

const TEMPLATE_WEIGHTS = {
  maj7: { 0: 1, 4: 0.8, 7: 0.7, 11: 0.6 },
  7: { 0: 1, 4: 0.8, 7: 0.7, 10: 0.7 },
  m7: { 0: 1, 3: 0.8, 7: 0.7, 10: 0.6 },
  m7b5: { 0: 1, 3: 0.8, 6: 0.7, 10: 0.6 },
};

function buildTemplates() {
  const templates = [];
  for (let root = 0; root < 12; root++) {
    for (const quality of DETECTABLE_QUALITIES) {
      const vec = new Float64Array(12);
      for (const [interval, weight] of Object.entries(TEMPLATE_WEIGHTS[quality])) vec[mod12(root + Number(interval))] = weight;
      templates.push({ root, quality, vec });
    }
  }
  return templates;
}

function diatonicChordSet(tonic, mode) {
  const major = mode === 'minor' ? mod12(tonic + 3) : tonic;
  const set = new Set();
  const degrees = [
    [0, 'maj7'],
    [2, 'm7'],
    [4, 'm7'],
    [5, 'maj7'],
    [7, '7'],
    [9, 'm7'],
    [11, 'm7b5'],
  ];
  for (const [offset, quality] of degrees) set.add(`${mod12(major + offset)}:${quality}`);
  if (mode === 'minor') set.add(`${mod12(tonic + 7)}:7`);
  return set;
}

function viterbi(emissions, stateCount, penalty) {
  const slots = emissions.length;
  const back = new Array(slots);
  let prev = Float64Array.from(emissions[0]);
  back[0] = new Int16Array(stateCount).fill(-1);
  for (let t = 1; t < slots; t++) {
    let bestState = 0;
    for (let s = 1; s < stateCount; s++) if (prev[s] > prev[bestState]) bestState = s;
    const switchScore = prev[bestState] - penalty;
    const next = new Float64Array(stateCount);
    const bp = new Int16Array(stateCount);
    for (let s = 0; s < stateCount; s++) {
      if (prev[s] >= switchScore) {
        next[s] = prev[s] + emissions[t][s];
        bp[s] = s;
      } else {
        next[s] = switchScore + emissions[t][s];
        bp[s] = bestState;
      }
    }
    back[t] = bp;
    prev = next;
  }
  let state = 0;
  for (let s = 1; s < stateCount; s++) if (prev[s] > prev[state]) state = s;
  const path = new Array(slots);
  for (let t = slots - 1; t >= 0; t--) {
    path[t] = state;
    if (t > 0) state = back[t][state];
  }
  return path;
}

function detectForm(slotKeys) {
  const barCount = Math.floor(slotKeys.length / 2);
  const whole = { length: barCount, score: 0 };
  if (barCount < 8) return whole;
  const maxPeriod = Math.min(64, Math.floor(barCount / 2));
  const scores = [];
  for (let period = 4; period <= maxPeriod; period++) {
    let match = 0;
    let total = 0;
    for (let b = 0; b + period < barCount; b++) {
      for (let h = 0; h < 2; h++) {
        total++;
        if (slotKeys[2 * b + h] === slotKeys[2 * (b + period) + h]) match++;
      }
    }
    scores.push({ period, score: total > 0 ? match / total : 0 });
  }
  const top = Math.max(...scores.map((s) => s.score));
  if (top < 0.55) return { length: Math.min(barCount, 32), score: top };
  const chosen = scores.find((s) => s.score >= top - 0.04);
  return { length: chosen.period, score: chosen.score };
}

function consolidate(slotChords, slotKeys, formLength) {
  const bars = [];
  const barCount = Math.floor(slotChords.length / 2);
  for (let q = 0; q < formLength; q++) {
    const pair = [];
    for (let h = 0; h < 2; h++) {
      const votes = new Map();
      for (let b = q; b < barCount; b += formLength) {
        const key = slotKeys[2 * b + h];
        const entry = votes.get(key) ?? { count: 0, chord: slotChords[2 * b + h] };
        entry.count++;
        votes.set(key, entry);
      }
      let winner = null;
      for (const entry of votes.values()) if (!winner || entry.count > winner.count) winner = entry;
      pair.push(winner.chord);
    }
    bars.push(pair);
  }
  return bars;
}

/**
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {(fraction: number, label: string) => void} [onProgress]
 */
export function analyzeAudio(samples, sampleRate, onProgress = () => {}) {
  const seconds = samples.length / sampleRate;
  if (seconds < MIN_SECONDS) throw new AnalysisError('short', 'Nagranie jest za krótkie. Potrzebuję co najmniej 12 sekund muzyki.');
  const limited = seconds > MAX_SECONDS ? samples.subarray(0, Math.floor(MAX_SECONDS * sampleRate)) : samples;

  onProgress(0.02, 'Przygotowuję dźwięk');
  const { data, sr } = downsample(limited, sampleRate);
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
  const rms = Math.sqrt(sumSq / data.length);
  if (rms < 1e-4) throw new AnalysisError('silence', 'Nagranie jest ciszą. Sprawdź, czy film grał i czy udostępniono dźwięk karty.');
  const gain = 0.1 / rms;
  for (let i = 0; i < data.length; i++) data[i] *= gain;

  const pass = spectralPass(data, sr, (p) => onProgress(0.05 + 0.6 * p, 'Analizuję widmo'));
  onProgress(0.68, 'Szukam tempa');
  const fps = sr / HOP;
  const env = onsetEnvelope(pass.flux);
  const tempo = estimateTempo(env, fps);
  const onsetsPerBeat = countOnsets(env) / Math.max(1, (env.length / tempo.period));
  const activity = Math.max(0, Math.min(1, (onsetsPerBeat - 1.2) / 3));

  onProgress(0.8, 'Rozpoznaję akordy');
  const tuning = estimateTuning(pass);
  const chroma = buildChroma(pass, tuning);

  const delay = Math.min(0.25 * tempo.period, 0.1 * fps);
  const beatChroma = [];
  const beatEnergy = [];
  for (let t = tempo.offset; t + tempo.period < pass.frames; t += tempo.period) {
    const from = Math.ceil(t + delay);
    const to = Math.max(from, Math.floor(t + tempo.period + delay - 1e-6));
    const vec = new Float64Array(12);
    let en = 0;
    let n = 0;
    for (let f = from; f <= to && f < pass.frames; f++) {
      for (let p = 0; p < 12; p++) vec[p] += chroma[f * 12 + p];
      en += pass.energy[f];
      n++;
    }
    beatChroma.push(vec);
    beatEnergy.push(n > 0 ? en / n : 0);
  }
  const sortedEnergy = [...beatEnergy].sort((a, b) => a - b);
  const energyFloor = sortedEnergy[Math.floor(sortedEnergy.length / 2)] * 0.05;
  let first = beatEnergy.findIndex((e) => e > energyFloor);
  let last = beatEnergy.length - 1;
  while (last > 0 && beatEnergy[last] <= energyFloor) last--;
  if (first < 0 || last - first + 1 < 8) throw new AnalysisError('sparse', 'Za mało materiału muzycznego do analizy akordów.');

  const globalChroma = new Float64Array(12);
  for (let i = first; i <= last; i++) for (let p = 0; p < 12; p++) globalChroma[p] += beatChroma[i][p];
  const key = estimateKey(globalChroma);

  const phaseScore = [0, 0, 0, 0];
  for (let i = first + 2; i < last; i++) {
    const pre = new Float64Array(12);
    const post = new Float64Array(12);
    for (let p = 0; p < 12; p++) {
      pre[p] = beatChroma[i - 2][p] + beatChroma[i - 1][p];
      post[p] = beatChroma[i][p] + beatChroma[i + 1][p];
    }
    phaseScore[(i - first) % 4] += 1 - cosine(pre, post);
  }
  const downbeat = phaseScore.indexOf(Math.max(...phaseScore));
  const barStart = first + downbeat;
  const barCount = Math.floor((last - barStart + 1) / 4);
  if (barCount < 4) throw new AnalysisError('sparse', 'Wykryłem mniej niż 4 takty. Spróbuj dłuższego fragmentu.');

  const templates = buildTemplates();
  const diatonic = diatonicChordSet(key.tonic, key.mode);
  const emissions = [];
  for (let slot = 0; slot < barCount * 2; slot++) {
    const vec = new Float64Array(12);
    for (let b = 0; b < 2; b++) for (let p = 0; p < 12; p++) vec[p] += beatChroma[barStart + slot * 2 + b][p];
    emissions.push(
      templates.map((tpl) => cosine(vec, tpl.vec) + (diatonic.has(`${tpl.root}:${tpl.quality}`) ? DIATONIC_BONUS : 0)),
    );
  }
  const path = viterbi(emissions, templates.length, SWITCH_PENALTY);
  const slotChords = path.map((s) => ({ root: templates[s].root, quality: templates[s].quality }));
  const slotKeys = slotChords.map((c) => `${c.root}:${c.quality}`);

  const form = detectForm(slotKeys);
  const chorus = consolidate(slotChords, slotKeys, form.length);
  const flats = prefersFlats(key.tonic, key.mode);
  const bars = chorus.map(([a, b]) =>
    a.root === b.root && a.quality === b.quality ? [formatChord(a, flats)] : [formatChord(a, flats), formatChord(b, flats)],
  );

  onProgress(1, 'Gotowe');
  return {
    duration: Math.min(seconds, MAX_SECONDS),
    bpm: Math.round(tempo.bpm * 10) / 10,
    key: { tonic: key.tonic, mode: key.mode, score: key.score },
    tuningCents: Math.round(tuning * 100),
    bars,
    analyzedBars: barCount,
    formScore: form.score,
    activity,
  };
}
