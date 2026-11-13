import { GLYPHS } from './glyphs.js';
import { FLAT_NAMES, TRUMPET_TRANSPOSE, formatChord, keyFifths, mod12 } from './music.js';
import { buildSlots } from './improv.js';

const LETTERS = 'CDEFGAB';
const BASE_PC = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
const SIG_STEPS_SHARP = [8, 5, 9, 6, 3, 7, 4];
const SIG_STEPS_FLAT = [4, 7, 3, 6, 2, 5, 1];
const HEAD_W = 1.18;
const STEM_T = 0.12;
const ACC_SYMBOL = { '-1': '♭', 0: '', 1: '♯' };

const keyMapCache = new Map();

function keyMap(fifths) {
  if (keyMapCache.has(fifths)) return keyMapCache.get(fifths);
  const sigAcc = new Array(7).fill(0);
  for (let i = 0; i < Math.abs(fifths); i++) sigAcc[(fifths > 0 ? SHARP_ORDER : FLAT_ORDER)[i]] = Math.sign(fifths);
  const map = new Array(12).fill(null);
  for (let l = 0; l < 7; l++) map[mod12(BASE_PC[l] + sigAcc[l])] = { letter: l, acc: sigAcc[l] };
  const neutral = { 1: [0, 1], 3: [2, -1], 6: [3, 1], 8: [5, -1], 10: [6, -1] };
  for (let pc = 0; pc < 12; pc++) {
    if (map[pc]) continue;
    if (fifths === 0) {
      map[pc] = { letter: neutral[pc][0], acc: neutral[pc][1] };
      continue;
    }
    const natural = BASE_PC.indexOf(pc);
    if (natural >= 0) {
      map[pc] = { letter: natural, acc: 0 };
      continue;
    }
    const acc = fifths > 0 ? 1 : -1;
    for (let l = 0; l < 7; l++) if (mod12(BASE_PC[l] + acc) === pc) map[pc] = { letter: l, acc };
  }
  const result = { map, sigAcc };
  keyMapCache.set(fifths, result);
  return result;
}

/** Spells a MIDI note for a key signature: letter index, accidental (-1, 0, 1), octave, diatonic staff step. */
export function spellNote(midi, fifths) {
  const { letter, acc } = keyMap(fifths).map[mod12(midi)];
  const octave = Math.floor((midi - BASE_PC[letter] - acc) / 12) - 1;
  return { letter, acc, octave, step: (octave - 4) * 7 + letter - 2 };
}

export function spelledName(spelled) {
  return `${LETTERS[spelled.letter]}${ACC_SYMBOL[spelled.acc]}${spelled.octave}`;
}

/** Concert key of the chart -> fifths of the key signature shown for the chosen notation. */
export function displayFifths(key, written) {
  const tonic = written ? mod12(key.tonic + TRUMPET_TRANSPOSE) : key.tonic;
  return keyFifths(tonic, key.mode);
}

function splitNote(pos, len) {
  const pieces = [];
  while (len > 0) {
    for (const d of [8, 6, 4, 3, 2, 1]) {
      const ok = d === 1 || d === 2 || (d === 3 && pos % 4 === 0) || (d === 4 && pos % 4 === 0) || (d === 6 && pos === 0) || (d === 8 && pos === 0);
      if (d <= len && pos + d <= 8 && ok) {
        pieces.push({ pos, len: d });
        pos += d;
        len -= d;
        break;
      }
    }
  }
  return pieces;
}

function splitRest(pos, len) {
  const pieces = [];
  while (len > 0) {
    for (const d of [8, 4, 2, 1]) {
      const ok = d === 1 || (d === 2 && pos % 2 === 0) || (d === 4 && pos % 4 === 0) || (d === 8 && pos === 0);
      if (d <= len && pos + d <= 8 && ok) {
        pieces.push({ pos, len: d });
        pos += d;
        len -= d;
        break;
      }
    }
  }
  return pieces;
}

/** Cuts the solo into bars of eight eighths, splitting notes with ties and filling gaps with rests. */
function layoutBars(notes, barCount) {
  const bars = Array.from({ length: barCount }, () => []);
  const totalE = barCount * 8;
  let cursor = 0;
  const addRest = (from, to) => {
    let e = from;
    while (e < to) {
      const bar = Math.floor(e / 8);
      const room = Math.min(to, (bar + 1) * 8) - e;
      for (const p of splitRest(e - bar * 8, room)) bars[bar].push({ type: 'rest', ...p });
      e += room;
    }
  };
  notes.forEach((note, index) => {
    const start = Math.round(note.start * 2);
    const len = Math.min(Math.round(note.dur * 2), totalE - start);
    if (len <= 0) return;
    addRest(cursor, start);
    let e = start;
    let first = true;
    while (e < start + len) {
      const bar = Math.floor(e / 8);
      const room = Math.min(start + len, (bar + 1) * 8) - e;
      for (const p of splitNote(e - bar * 8, room)) {
        bars[bar].push({ type: 'note', index, midi: note.midi, tieFrom: !first, ...p });
        first = false;
      }
      e += room;
    }
    cursor = start + len;
  });
  addRest(cursor, totalE);
  return bars;
}

const num = (v) => Number(v.toFixed(2));

function glyph(name, x, y, sp, extra = '') {
  return `<path d="${GLYPHS[name].d}" transform="translate(${num(x)} ${num(y)}) scale(${sp})" ${extra}/>`;
}

/**
 * Renders the solo as a lead sheet in SVG. Returns lookup tables so the caller can
 * highlight the sounding note and bar.
 *
 * @param {HTMLElement} container
 * @param {{notes: {start:number,dur:number,midi:number}[], bars: object[][], key: {tonic:number, mode:string}, written: boolean}} options
 */
export function renderNotation(container, { notes, bars, key, written }) {
  const transpose = written ? TRUMPET_TRANSPOSE : 0;
  const fifths = displayFifths(key, written);
  const { sigAcc } = keyMap(fifths);
  const W = Math.max(280, Math.floor(container.clientWidth));
  const sp = W < 480 ? 6.2 : W < 800 ? 7 : 7.6;
  const sigCount = Math.abs(fifths);
  const clefW = GLYPHS.gClef.w * sp;
  const headW = 2 + clefW + 6 + sigCount * 1.15 * sp + 8;
  const rightMargin = 6;
  const avail = W - headW - rightMargin;
  const minBarW = 8 * sp * 2.4;
  const perSystem = Math.max(1, Math.min(4, Math.floor(avail / minBarW)));
  const barW = avail / perSystem;
  const chordRow = 24;
  const topMargin = 4.5 * sp;
  const bottomMargin = 5.2 * sp;
  const systemH = chordRow + topMargin + 4 * sp + bottomMargin + 6;
  const barItems = layoutBars(notes, bars.length);
  const slots = buildSlots(bars);
  const flatsForChords = fifths <= 0;
  const systemCount = Math.ceil(bars.length / perSystem);
  const H = systemCount * systemH + 4;

  const parts = [];

  for (let s = 0; s < systemCount; s++) {
    const y0 = 2 + s * systemH;
    const staffTop = y0 + chordRow + topMargin;
    const staffBottom = staffTop + 4 * sp;
    const yOfStep = (step) => staffBottom - (step * sp) / 2;
    const firstBar = s * perSystem;
    const lastBar = Math.min(bars.length, firstBar + perSystem) - 1;
    const xEnd = headW + (lastBar - firstBar + 1) * barW;

    parts.push(`<g class="system" data-system="${s}" data-first-bar="${firstBar}" data-last-bar="${lastBar}">`);
    for (let line = 0; line < 5; line++) {
      const y = staffTop + line * sp;
      parts.push(`<line class="staff-line" x1="0" x2="${num(xEnd)}" y1="${num(y)}" y2="${num(y)}"/>`);
    }
    parts.push(`<line class="barline" x1="0.5" x2="0.5" y1="${num(staffTop)}" y2="${num(staffBottom)}"/>`);
    parts.push(`<g class="clef">${glyph('gClef', 2, staffBottom - sp, sp)}</g>`);
    const sigSteps = fifths > 0 ? SIG_STEPS_SHARP : SIG_STEPS_FLAT;
    for (let i = 0; i < sigCount; i++) {
      const name = fifths > 0 ? 'sharp' : 'flat';
      parts.push(glyph(name, 2 + clefW + 6 + i * 1.15 * sp, yOfStep(sigSteps[i]), sp));
    }
    parts.push(`<text class="bar-number" x="2" y="${num(y0 + 14)}">${firstBar + 1}</text>`);

    for (let b = firstBar; b <= lastBar; b++) {
      const x0 = headW + (b - firstBar) * barW;
      const padL = 1.9 * sp + 2;
      const padR = 5;
      const xAt = (pos) => x0 + padL + (pos / 8) * (barW - padL - padR);
      parts.push(`<rect class="bar-hl" data-bar="${b}" x="${num(x0)}" y="${num(staffTop - 2.5 * sp)}" width="${num(barW)}" height="${num(4 * sp + 5 * sp)}"/>`);

      for (const slot of slots.filter((sl) => sl.bar === b)) {
        const chord = { root: mod12(slot.chord.root + transpose), quality: slot.chord.quality };
        const x = xAt((slot.start - b * 4) * 2) - 2;
        parts.push(`<text class="chord" x="${num(x)}" y="${num(y0 + chordRow - 6)}">${formatChord(chord, flatsForChords, true)}</text>`);
      }

      const accState = new Map();
      const items = barItems[b];
      const prepared = items.map((item) => {
        if (item.type === 'rest') return item;
        const spelled = spellNote(item.midi + transpose, fifths);
        const keyId = `${spelled.letter}:${spelled.octave}`;
        const current = accState.has(keyId) ? accState.get(keyId) : sigAcc[spelled.letter];
        const showAcc = current !== spelled.acc;
        accState.set(keyId, spelled.acc);
        return { ...item, spelled, showAcc, x: xAt(item.pos), y: yOfStep(spelled.step) };
      });

      const beamed = new Set();
      const beams = [];
      for (let i = 0; i < prepared.length - 1; i++) {
        const a = prepared[i];
        const c = prepared[i + 1];
        if (a.type === 'note' && c.type === 'note' && a.len === 1 && c.len === 1 && a.pos % 2 === 0 && c.pos === a.pos + 1 && !beamed.has(i)) {
          beamed.add(i);
          beamed.add(i + 1);
          beams.push([a, c]);
        }
      }
      const beamPair = new Map();
      for (const pair of beams) {
        const down = (pair[0].spelled.step + pair[1].spelled.step) / 2 >= 4;
        pair.down = down;
        beamPair.set(pair[0], pair);
        beamPair.set(pair[1], pair);
      }

      for (const item of prepared) {
        if (item.type === 'rest') {
          const mid = staffTop + 2 * sp;
          if (item.len === 8) {
            parts.push(glyph('restWhole', x0 + barW / 2 - 0.56 * sp, staffTop + sp, sp, 'class="rest"'));
          } else if (item.len === 4) {
            parts.push(glyph('restHalf', xAt(item.pos), mid, sp, 'class="rest"'));
          } else if (item.len === 2) {
            parts.push(glyph('restQuarter', xAt(item.pos), mid, sp, 'class="rest"'));
          } else {
            parts.push(glyph('rest8th', xAt(item.pos), mid, sp, 'class="rest"'));
          }
          continue;
        }
        const { x, y, spelled } = item;
        const pair = beamPair.get(item);
        const stemDown = pair ? pair.down : spelled.step >= 4;
        const g = [`<g class="note" data-note="${item.index}">`];
        for (let ls = -2; ls >= spelled.step; ls -= 2) {
          const ly = yOfStep(ls);
          g.push(`<line class="ledger" x1="${num(x - 0.45 * sp)}" x2="${num(x + (HEAD_W + 0.45) * sp)}" y1="${num(ly)}" y2="${num(ly)}"/>`);
        }
        for (let ls = 10; ls <= spelled.step; ls += 2) {
          const ly = yOfStep(ls);
          g.push(`<line class="ledger" x1="${num(x - 0.45 * sp)}" x2="${num(x + (HEAD_W + 0.45) * sp)}" y1="${num(ly)}" y2="${num(ly)}"/>`);
        }
        if (item.showAcc) {
          const name = spelled.acc === 1 ? 'sharp' : spelled.acc === -1 ? 'flat' : 'natural';
          g.push(glyph(name, x - (GLYPHS[name].w + 0.3) * sp, y, sp));
        }
        const headName = item.len >= 8 ? 'noteheadWhole' : item.len >= 4 ? 'noteheadHalf' : 'noteheadBlack';
        g.push(glyph(headName, x, y, sp));
        if (item.len === 3 || item.len === 6) {
          const dotY = spelled.step % 2 === 0 ? y - 0.5 * sp : y;
          g.push(`<circle cx="${num(x + (HEAD_W + 0.55) * sp)}" cy="${num(dotY)}" r="${num(0.2 * sp)}"/>`);
        }
        if (item.len < 8) {
          const stemX = stemDown ? x + (STEM_T / 2) * sp : x + (HEAD_W - STEM_T / 2) * sp;
          const mid = staffTop + 2 * sp;
          const tipRaw = stemDown ? Math.max(y + 3.5 * sp, mid) : Math.min(y - 3.5 * sp, mid);
          item.stemX = stemX;
          item.tip = tipRaw;
          item.stemDown = stemDown;
          item.group = g;
        }
        item.stemStartY = stemDown ? y + 0.17 * sp : y - 0.17 * sp;
        parts.push(g);
      }

      for (const pair of beams) {
        const [a, c] = pair;
        const down = pair.down;
        const tips = [a.tip, c.tip];
        if (down) {
          const bottom = Math.max(...tips);
          a.tip = Math.max(bottom - sp, Math.min(bottom, tips[0]));
          c.tip = Math.max(bottom - sp, Math.min(bottom, tips[1]));
        } else {
          const top = Math.min(...tips);
          a.tip = Math.min(top + sp, Math.max(top, tips[0]));
          c.tip = Math.min(top + sp, Math.max(top, tips[1]));
        }
        const th = 0.5 * sp * (down ? -1 : 1);
        const x1 = a.stemX - (STEM_T / 2) * sp;
        const x2 = c.stemX + (STEM_T / 2) * sp;
        parts.push(`<polygon class="beam" points="${num(x1)},${num(a.tip)} ${num(x2)},${num(c.tip)} ${num(x2)},${num(c.tip + th)} ${num(x1)},${num(a.tip + th)}"/>`);
      }

      for (const item of prepared) {
        if (item.type !== 'note' || item.stemX === undefined) continue;
        const stem = `<line class="stem" x1="${num(item.stemX)}" x2="${num(item.stemX)}" y1="${num(item.stemStartY)}" y2="${num(item.tip)}"/>`;
        item.group.push(stem);
        if (item.len === 1 && !beamPair.has(item)) {
          const flag = item.stemDown ? 'flag8thDown' : 'flag8thUp';
          item.group.push(glyph(flag, item.stemX - (STEM_T / 2) * sp, item.tip, sp));
        }
      }

      const isFinal = b === bars.length - 1;
      const bx = x0 + barW;
      if (isFinal) {
        parts.push(`<line class="barline" x1="${num(bx - 3.5)}" x2="${num(bx - 3.5)}" y1="${num(staffTop)}" y2="${num(staffBottom)}"/>`);
        parts.push(`<line class="barline thick" x1="${num(bx - 0.9)}" x2="${num(bx - 0.9)}" y1="${num(staffTop)}" y2="${num(staffBottom)}"/>`);
      } else {
        parts.push(`<line class="barline" x1="${num(bx)}" x2="${num(bx)}" y1="${num(staffTop)}" y2="${num(staffBottom)}"/>`);
      }
      barItems[b] = prepared;
    }
    parts.push('</g>');
  }

  const flat = parts.map((p) => (Array.isArray(p) ? `${p.join('')}</g>` : p)).join('');
  const tieSvg = buildTies(barItems, sp, headW, barW, bars.length, perSystem, systemH, chordRow, topMargin);
  const label = `Zapis nutowy improwizacji: ${bars.length} taktów, ${notes.length} nut. Pełna lista nut znajduje się w tabeli poniżej.`;
  container.innerHTML = `<svg class="staff-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">${flat}${tieSvg}</svg>`;

  const svg = container.firstElementChild;
  const noteEls = new Map();
  for (const el of svg.querySelectorAll('[data-note]')) {
    const index = Number(el.dataset.note);
    if (!noteEls.has(index)) noteEls.set(index, []);
    noteEls.get(index).push(el);
  }
  const barEls = [...svg.querySelectorAll('.bar-hl')];
  const systemEls = [...svg.querySelectorAll('.system')].map((el) => ({
    el,
    firstBar: Number(el.dataset.firstBar),
    lastBar: Number(el.dataset.lastBar),
  }));
  return { svg, noteEls, barEls, systemEls, fifths };
}

function buildTies(barItems, sp, headW, barW, barCount, perSystem, systemH, chordRow, topMargin) {
  const out = [];
  const pos = (item, b) => {
    const s = Math.floor(b / perSystem);
    return { s, cx: item.x + (HEAD_W * sp) / 2, y: item.y };
  };
  const tieArc = (x1, x2, y, down) => {
    const dy = (down ? 1 : -1) * 0.7 * sp;
    const y0 = y + (down ? 0.55 : -0.55) * sp;
    return `<path class="tie" d="M${num(x1)} ${num(y0)} Q${num((x1 + x2) / 2)} ${num(y0 + dy)} ${num(x2)} ${num(y0)}"/>`;
  };
  let previous = null;
  barItems.forEach((items, b) => {
    for (const item of items) {
      if (item.type !== 'note') continue;
      if (item.tieFrom && previous && previous.index === item.index) {
        const a = pos(previous.item, previous.bar);
        const c = pos(item, b);
        const down = !previous.item.stemDown;
        if (a.s === c.s) {
          out.push(tieArc(a.cx + 0.4 * sp, c.cx - 0.4 * sp, a.y, down));
        } else {
          const rightEdge = headW + Math.min(perSystem, barCount - a.s * perSystem) * barW;
          out.push(tieArc(a.cx + 0.4 * sp, rightEdge - 2, a.y, down));
          out.push(tieArc(headW + 2, c.cx - 0.4 * sp, c.y, down));
        }
      }
      previous = { index: item.index, item, bar: b };
    }
  });
  return out.join('');
}
