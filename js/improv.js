import { QUALITIES, mod12 } from './music.js';

export const RANGES = {
  low: { label: 'Niski', lo: 55, hi: 72 },
  mid: { label: 'Średni', lo: 58, hi: 77 },
  high: { label: 'Wysoki', lo: 62, hi: 82 },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flattens bars of chords into slots with start/length in beats (4/4). */
export function buildSlots(bars) {
  const slots = [];
  bars.forEach((chords, barIndex) => {
    const lengths = { 1: [4], 2: [2, 2], 3: [2, 1, 1], 4: [1, 1, 1, 1] }[chords.length];
    let start = barIndex * 4;
    chords.forEach((chord, i) => {
      slots.push({ start, beats: lengths[i], chord, bar: barIndex });
      start += lengths[i];
    });
  });
  return slots;
}

function slotLookup(slots, totalBeats) {
  const byEighth = new Array(totalBeats * 2);
  let s = 0;
  for (let e = 0; e < byEighth.length; e++) {
    while (s < slots.length - 1 && slots[s + 1].start * 2 <= e) s++;
    byEighth[e] = s;
  }
  return byEighth;
}

const pcSet = (chord, intervals) => new Set(intervals.map((i) => mod12(chord.root + i)));

function candidatesIn(set, lo, hi) {
  const out = [];
  for (let m = lo; m <= hi; m++) if (set.has(mod12(m))) out.push(m);
  return out;
}

function pickDuration(rng, density, remaining, parity) {
  const weights = [
    [1, 0.25 + 0.6 * density],
    [2, (0.4 - 0.15 * density) * (parity === 1 ? 0.6 : 1)],
    [3, parity === 1 ? 0.02 : 0.1],
    [4, Math.max(0.02, 0.12 - 0.08 * density)],
  ].filter(([d]) => d <= remaining);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [d, w] of weights) {
    r -= w;
    if (r <= 0) return d;
  }
  return weights[weights.length - 1][0];
}

function makeRhythm(length, startE, density, rng) {
  const finalDur = length >= 4 && rng() < 0.8 ? 2 + Math.floor(rng() * 3) : 1;
  let remaining = length - finalDur;
  const out = [];
  let e = startE;
  while (remaining > 0) {
    const d = pickDuration(rng, density, remaining, e % 2);
    out.push(d);
    remaining -= d;
    e += d;
  }
  out.push(finalDur);
  return out;
}

function contourOffset(kind, x) {
  const amplitude = 7;
  if (kind === 'up') return amplitude * x;
  if (kind === 'down') return -amplitude * x;
  if (kind === 'arch') return amplitude * Math.sin(Math.PI * x);
  if (kind === 'valley') return -amplitude * Math.sin(Math.PI * x);
  return 0;
}

/**
 * Bebop-flavoured line generator on an eighth-note grid. Chord tones (guide tones
 * first) land on the beat, scale tones and chromatic approaches fill the offbeats,
 * phrases breathe with rests, and some rhythms are reused as motifs.
 *
 * @param {{bars: {root:number, quality:string}[][], density: number, range: {lo:number, hi:number}, seed: number}} options
 */
export function generateSolo({ bars, density, range, seed }) {
  const rng = mulberry32(seed);
  const slots = buildSlots(bars);
  const totalBeats = bars.length * 4;
  const totalE = totalBeats * 2;
  const slotAt = slotLookup(slots, totalBeats);
  const chordAt = (e) => slots[slotAt[Math.min(e, totalE - 1)]].chord;
  const center = (range.lo + range.hi) / 2;
  const notes = [];
  let e = rng() < 0.5 ? 0 : 1 + Math.floor(rng() * 3);
  let prev = Math.round(center);
  let lastRhythm = null;

  while (e < totalE) {
    let length = Math.round(6 + 4 * density + rng() * (6 + 8 * density));
    if (rng() < 0.3) length += (4 - ((e + length) % 4)) % 4;
    length = Math.min(length, totalE - e);
    let rhythm;
    if (lastRhythm && rng() < 0.3 && lastRhythm.startParity === e % 2 && lastRhythm.total <= totalE - e) {
      rhythm = lastRhythm.list.slice();
      length = lastRhythm.total;
    } else {
      rhythm = makeRhythm(length, e, density, rng);
    }
    lastRhythm = { list: rhythm, total: length, startParity: e % 2 };

    const phrase = [];
    let pos = e;
    for (const dur of rhythm) {
      phrase.push({ e: pos, dur, midi: null });
      pos += dur;
    }

    const contour = ['up', 'down', 'arch', 'valley', 'flat'][Math.floor(rng() * 5)];
    const startRef = prev;
    const lastIndex = phrase.length - 1;
    let momentum = contour === 'down' || contour === 'valley' ? -1 : 1;
    const anchorIdx = phrase.map((n, i) => (n.e % 2 === 0 || i === 0 || i === lastIndex ? i : -1)).filter((i) => i >= 0);

    anchorIdx.forEach((idx, order) => {
      const note = phrase[idx];
      const chord = chordAt(note.e);
      const q = QUALITIES[chord.quality];
      const useColor = note.dur >= 2 && idx !== lastIndex && rng() < 0.25;
      const set = pcSet(chord, useColor ? [...q.tones, ...q.color] : q.tones);
      const guide = pcSet(chord, q.guide);
      let cands = candidatesIn(set, range.lo, range.hi).filter((m) => Math.abs(m - prev) <= 9);
      if (cands.length === 0) cands = candidatesIn(set, range.lo, range.hi);
      const x = anchorIdx.length > 1 ? order / (anchorIdx.length - 1) : 0;
      let best = cands[0];
      let bestScore = -Infinity;
      for (const m of cands) {
        let score = -0.3 * Math.max(0, Math.abs(m - prev) - 3);
        if ((m - prev) * momentum > 0) score += 0.35;
        if (m === prev) score -= 0.8;
        if (guide.has(mod12(m))) score += 0.7;
        score -= 0.2 * Math.abs(m - (startRef + contourOffset(contour, x)));
        score -= 0.1 * Math.max(0, Math.abs(m - center) - 6);
        score += rng() * 1.2;
        if (score > bestScore) {
          bestScore = score;
          best = m;
        }
      }
      note.midi = best;
      momentum = best - prev;
      prev = best;
    });

    for (let i = 0; i < phrase.length; i++) {
      const note = phrase[i];
      if (note.midi !== null) continue;
      const before = phrase[i - 1].midi;
      let after = null;
      for (let j = i + 1; j < phrase.length; j++) {
        if (phrase[j].midi !== null) {
          after = phrase[j].midi;
          break;
        }
      }
      const chord = chordAt(note.e);
      const scale = candidatesIn(pcSet(chord, QUALITIES[chord.quality].scale), range.lo, range.hi);
      let pick;
      if (after !== null && Math.abs(after - before) <= 2) {
        const neighbors = [after + 1, after - 1].filter((m) => m !== before);
        pick = neighbors[Math.floor(rng() * neighbors.length)];
      } else if (after !== null && rng() < 0.4) {
        pick = after + (before < after ? -1 : 1);
      } else {
        const dir = after !== null ? Math.sign(after - before) : rng() < 0.5 ? 1 : -1;
        const between = scale.filter((m) => (dir > 0 ? m > before : m < before));
        if (between.length === 0) pick = before - dir;
        else {
          pick = between.reduce((a, b) => (Math.abs(a - before) <= Math.abs(b - before) ? a : b));
          if (after !== null && (dir > 0 ? pick > after : pick < after)) pick = after - dir;
        }
      }
      note.midi = Math.max(range.lo, Math.min(range.hi, pick));
    }

    for (const note of phrase) {
      let dur = Math.min(note.dur, totalE - note.e);
      const endE = note.e + dur;
      if (dur >= 2 && slotAt[note.e] !== slotAt[Math.min(endE, totalE) - 1]) {
        const next = slots[slotAt[note.e] + 1];
        const nextScale = pcSet(next.chord, QUALITIES[next.chord.quality].scale);
        if (!nextScale.has(mod12(note.midi))) dur = Math.max(1, next.start * 2 - note.e);
      }
      if (dur > 0) notes.push({ start: note.e / 2, dur: dur / 2, midi: note.midi });
    }
    prev = phrase[phrase.length - 1].midi;

    e = pos;
    const restLen = 2 + Math.floor(rng() * (4 - 2 * density));
    e += restLen;
    if (rng() < 0.35 && e % 2 === 0) e += 1;
  }
  return { notes, totalBeats, seed, density };
}
