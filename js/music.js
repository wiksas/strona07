export const A4_DEFAULT = 440;

// Bb trumpet: written pitch is a major second above the sounding (concert) pitch.
export const TRUMPET_TRANSPOSE = 2;

export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Equal temperament: f = A4 * 2^((n - 69) / 12), with MIDI note 69 = A4.
export function midiToFreq(midi, a4 = A4_DEFAULT) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function freqToMidi(freq, a4 = A4_DEFAULT) {
  return 69 + 12 * Math.log2(freq / a4);
}

export const mod12 = (n) => ((n % 12) + 12) % 12;

export const QUALITIES = {
  maj7: { label: 'maj7', tones: [0, 4, 7, 11], guide: [4, 11], scale: [0, 2, 4, 5, 7, 9, 11], color: [2, 6, 9] },
  7: { label: '7', tones: [0, 4, 7, 10], guide: [4, 10], scale: [0, 2, 4, 5, 7, 9, 10], color: [2, 9, 1, 3, 8] },
  m7: { label: 'm7', tones: [0, 3, 7, 10], guide: [3, 10], scale: [0, 2, 3, 5, 7, 9, 10], color: [2, 5, 9] },
  m7b5: { label: 'm7b5', tones: [0, 3, 6, 10], guide: [3, 10], scale: [0, 2, 3, 5, 6, 8, 10], color: [2, 5] },
  dim7: { label: 'dim7', tones: [0, 3, 6, 9], guide: [3, 9], scale: [0, 2, 3, 5, 6, 8, 9, 11], color: [2, 5] },
};

export const DETECTABLE_QUALITIES = ['maj7', '7', 'm7', 'm7b5'];

const ROOT_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parses "Dm7", "Bbmaj7", "F#7", "Ebm7b5" into { root, quality }. Returns null if unrecognised. */
export function parseChord(text) {
  const m = /^([A-Ga-g])([#b♯♭]?)(.*)$/.exec(text.trim());
  if (!m) return null;
  let root = ROOT_BASE[m[1].toUpperCase()];
  const acc = m[2];
  if (acc === '#' || acc === '♯') root += 1;
  if (acc === 'b' || acc === '♭') root -= 1;
  const t = m[3].replace(/\s+/g, '').replace(/♭/g, 'b').replace(/♯/g, '#');
  let quality;
  if (/^(maj|ma|M|Δ|△)/.test(t) || /^(6|69|add)/.test(t) || t === '') quality = 'maj7';
  else if (/^(m7b5|min7b5|-7b5|ø)/i.test(t)) quality = 'm7b5';
  else if (/^(dim|o|°)/.test(t)) quality = 'dim7';
  else if (/^(m|min|-)/.test(t)) quality = 'm7';
  else if (/^(7|9|11|13|sus|alt|dom|\+|aug)/.test(t)) quality = '7';
  else return null;
  return { root: mod12(root), quality };
}

/** Splits one bar cell ("Dm7 G7") into chords. Returns null when any token is invalid. */
export function parseBarCell(text) {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return null;
  const chords = [];
  for (const token of tokens) {
    const chord = parseChord(token);
    if (!chord) return null;
    chords.push(chord);
  }
  return chords;
}

export function chordKey(chord) {
  return `${chord.root}:${chord.quality}`;
}

export function formatChord(chord, preferFlats = true, unicode = false) {
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  let root = names[mod12(chord.root)];
  let quality = chord.quality === 'maj7' ? 'maj7' : chord.quality === 'dim7' ? 'dim7' : QUALITIES[chord.quality].label;
  if (unicode) {
    root = root.replace('b', '♭').replace('#', '♯');
    quality = quality.replace('b5', '♭5');
  }
  return root + quality;
}

/** Beat lengths of each chord in a 4/4 bar holding n chords. */
export function barSlotBeats(n) {
  return { 1: [4], 2: [2, 2], 3: [2, 1, 1], 4: [1, 1, 1, 1] }[n];
}

// Krumhansl-Schmuckler key profiles.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Best-fit key for a 12-bin pitch-class profile. */
export function estimateKey(chroma) {
  let best = { tonic: 0, mode: 'major', score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = new Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[mod12(tonic + i)];
    const major = correlation(rotated, KS_MAJOR);
    const minor = correlation(rotated, KS_MINOR);
    if (major > best.score) best = { tonic, mode: 'major', score: major };
    if (minor > best.score) best = { tonic, mode: 'minor', score: minor };
  }
  return best;
}

export function keyFromChords(chords) {
  const profile = new Array(12).fill(0);
  for (const chord of chords) {
    for (const interval of QUALITIES[chord.quality].tones) profile[mod12(chord.root + interval)] += 1;
    profile[chord.root] += 0.5;
  }
  const { tonic, mode } = estimateKey(profile);
  return { tonic, mode };
}

/** Number of sharps (positive) or flats (negative) in the key signature. */
export function keyFifths(tonic, mode) {
  const majorTonic = mode === 'minor' ? mod12(tonic + 3) : tonic;
  const k = (majorTonic * 7) % 12;
  return k > 6 ? k - 12 : k;
}

export function prefersFlats(tonic, mode) {
  return keyFifths(tonic, mode) <= 0;
}

export function keyName(tonic, mode) {
  const flats = prefersFlats(tonic, mode);
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  return `${names[mod12(tonic)]} ${mode === 'minor' ? 'moll' : 'dur'}`;
}

export function noteName(midi, unicode = true) {
  const names = FLAT_NAMES;
  let n = names[mod12(midi)];
  if (unicode) n = n.replace('b', '♭');
  return `${n}${Math.floor(midi / 12) - 1}`;
}
