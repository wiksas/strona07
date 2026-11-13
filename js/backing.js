import { QUALITIES, mod12 } from './music.js';
import { buildSlots, mulberry32 } from './improv.js';

const BASS_LO = 28;
const BASS_HI = 50;
const COMP_TOP = 78;

function bassCandidates(chord, intervals) {
  const set = new Set(intervals.map((i) => mod12(chord.root + i)));
  const out = [];
  for (let m = BASS_LO; m <= BASS_HI; m++) if (set.has(mod12(m))) out.push(m);
  return out;
}

function pickNear(cands, target, rng, jitter) {
  let best = cands[0];
  let bestScore = Infinity;
  for (const m of cands) {
    const score = Math.abs(m - target) + rng() * jitter;
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** Rootless voicing stacked upward from the third: 3rd, 5th, 7th, 9th. */
function voicing(chord, around) {
  const q = QUALITIES[chord.quality];
  const intervals = [q.tones[1], q.tones[2], q.tones[3], 14];
  const ceiling = around + 6;
  const out = [ceiling - mod12(ceiling - (chord.root + intervals[0]))];
  for (const interval of intervals.slice(1)) {
    let m = out[out.length - 1] + 1;
    while (mod12(m) !== mod12(chord.root + interval)) m++;
    out.push(m);
  }
  return out[out.length - 1] > COMP_TOP ? out.map((m) => m - 12) : out;
}

/** Walking bass, rootless comping and a swing ride pattern for a chord chart. */
export function buildBacking(bars, seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const slots = buildSlots(bars);
  const totalBeats = bars.length * 4;
  const slotIndexAtBeat = (b) => {
    let s = 0;
    while (s < slots.length - 1 && slots[s + 1].start <= b) s++;
    return s;
  };
  const rootsFor = (chord) => bassCandidates(chord, [0]).filter((m) => m >= 31 && m <= 43);

  const bass = [];
  let prev = null;
  for (let b = 0; b < totalBeats; b++) {
    const si = slotIndexAtBeat(b);
    const slot = slots[si];
    const next = slots[(si + 1) % slots.length];
    let midi;
    if (b === slot.start) {
      const roots = rootsFor(slot.chord);
      midi = prev === null ? roots[0] : pickNear(roots, prev, rng, 0.5);
    } else if (b === slot.start + slot.beats - 1) {
      midi = pickNear(rootsFor(next.chord), prev, rng, 0.5) + (rng() < 0.5 ? 1 : -1);
    } else {
      const q = QUALITIES[slot.chord.quality];
      const cands = bassCandidates(slot.chord, [...q.tones, ...q.scale]).filter((m) => m !== prev);
      midi = pickNear(cands, prev + (rng() < 0.5 ? 2 : -2), rng, 2);
    }
    bass.push({ start: b, dur: 0.95, midi });
    prev = midi;
  }

  const comp = [];
  let lastCenter = 62;
  const hit = (start, dur) => {
    const midis = voicing(slots[slotIndexAtBeat(Math.floor(start))].chord, lastCenter);
    lastCenter = midis.reduce((a, b) => a + b, 0) / midis.length;
    comp.push({ start, dur, midis });
  };
  const patterns = [
    [[0, 1.5], [1.5, 0.5]],
    [[1, 0.6], [3, 0.6]],
    [[0, 0.6], [2.5, 0.5]],
  ];
  for (let bar = 0; bar < bars.length; bar++) {
    const pattern = patterns[Math.floor(rng() * patterns.length)];
    const hits = new Map(pattern.map(([offset, dur]) => [bar * 4 + offset, dur]));
    for (const slot of slots) {
      if (slot.bar === bar && slot.start % 4 !== 0 && !hits.has(slot.start)) hits.set(slot.start, 0.8);
    }
    [...hits.entries()].sort((a, b) => a[0] - b[0]).forEach(([start, dur]) => hit(start, dur));
  }

  const ride = [];
  for (let b = 0; b < totalBeats; b++) {
    ride.push({ start: b, accent: b % 4 === 0 ? 1 : 0.8 });
    if (b % 2 === 1) {
      ride.push({ start: b + 0.5, accent: 0.55 });
      ride.push({ start: b, hat: true, accent: 0.7 });
    }
  }
  return { bass, comp, ride };
}
