import { Engine, Player, autoSwingPoint } from './synth.js';
import { RANGES, generateSolo } from './improv.js';
import { buildBacking } from './backing.js';
import { displayFifths, renderNotation, spellNote, spelledName } from './notation.js';
import { FLAT_NAMES, TRUMPET_TRANSPOSE, keyFromChords, keyName, midiToFreq, parseBarCell, mod12 } from './music.js';
import { TabListener, canCaptureTabAudio, decodeToMono } from './capture.js';
import { YouTubePlayer, parseYouTubeId } from './youtube.js';
import { deleteSong, loadSongs, saveSong } from './storage.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  song: null,
  solo: null,
  backing: null,
  rendered: null,
  renderedSolo: null,
  written: true,
  videoId: null,
  listener: null,
  busy: false,
  activeNote: -1,
  activeBar: -1,
  activeSystem: -1,
};

const engine = new Engine();
const player = new Player(engine);
let ytPlayer = null;

const formatHz = (hz) => hz.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const a4 = () => clamp(Number($('opt-a4').value) || 440, 415, 466);

/* Status and errors */

function showError(message) {
  $('error-box').textContent = message;
  $('error-box').hidden = false;
}

function clearError() {
  $('error-box').hidden = true;
}

function setStatus(text, fraction) {
  $('status').hidden = text === null;
  if (text === null) return;
  $('status-text').textContent = text;
  $('progress').hidden = fraction === undefined;
  if (fraction !== undefined) $('progress').value = fraction;
}

function setBusy(busy) {
  state.busy = busy;
  $('yt-learn').disabled = busy || !state.videoId || !canCaptureTabAudio();
  $('file-learn').disabled = busy;
  $('chords-use').disabled = busy;
  $('yt-show').disabled = busy;
}

/* Tabs */

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(tab);
    const next = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i + tabs.length - 1) % tabs.length], Home: tabs[0], End: tabs.at(-1) }[e.key];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    next.focus();
  });
}

/* YouTube */

async function showVideo(id) {
  clearError();
  setStatus('Ładuję film z YouTube');
  try {
    ytPlayer ??= new YouTubePlayer($('video-frame'), {
      onEnded: () => state.listener && finishListening(),
      onError: (message) => showError(message),
    });
    await ytPlayer.load(id);
    state.videoId = id;
    setStatus(null);
    setBusy(false);
  } catch (error) {
    setStatus(null);
    showError(error.message);
  }
}

$('yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parseYouTubeId($('yt-url').value);
  if (!id) {
    $('yt-url').setAttribute('aria-invalid', 'true');
    showError('To nie wygląda na link do filmu z YouTube. Wklej adres w postaci youtube.com/watch?v=… albo youtu.be/….');
    return;
  }
  $('yt-url').removeAttribute('aria-invalid');
  showVideo(id);
});

if (!canCaptureTabAudio()) {
  $('yt-support').textContent = 'Ta przeglądarka nie udostępnia dźwięku karty, więc nie mogę słuchać filmu. Użyj Chrome lub Edge na komputerze albo wybierz plik audio lub własne akordy.';
}

/* Listening to the tab */

let listenFinishing = false;

async function startListening() {
  clearError();
  if (!state.videoId || state.busy) return;
  stopPlayback();
  const listener = new TabListener();
  try {
    await listener.start({
      onLevel: (level) => {
        $('listen-meter').style.transform = `scaleX(${Math.min(1, level * 6)})`;
      },
      onTick: (seconds) => {
        $('listen-time').textContent = formatTime(seconds);
      },
      onEnded: () => finishListening(),
    });
  } catch (error) {
    showError(error.message);
    return;
  }
  state.listener = listener;
  listenFinishing = false;
  setBusy(true);
  $('listen-box').hidden = false;
  $('listen-time').textContent = '0:00';
  ytPlayer.playFromStart();
  setTimeout(() => {
    if (state.listener === listener && !ytPlayer.isPlaying) {
      setStatus('Film jeszcze nie gra. Kliknij „Odtwórz” w odtwarzaczu YouTube, a ja zacznę słuchać od tego momentu.');
    }
  }, 2500);
}

async function finishListening() {
  if (!state.listener || listenFinishing) return;
  listenFinishing = true;
  const listener = state.listener;
  state.listener = null;
  ytPlayer.pause();
  $('listen-box').hidden = true;
  setStatus('Dekoduję nagranie');
  try {
    const blob = await listener.stop();
    const { samples, sampleRate } = await decodeToMono(await blob.arrayBuffer());
    const title = ytPlayer.title || 'Utwór z YouTube';
    await learn(samples, sampleRate, { id: `yt-${state.videoId}`, title, source: 'youtube', videoId: state.videoId });
  } catch (error) {
    setStatus(null);
    showError(error.message);
    setBusy(false);
  }
}

$('yt-learn').addEventListener('click', startListening);
$('listen-stop').addEventListener('click', finishListening);

/* Learning from a file */

$('file-learn').addEventListener('click', async () => {
  clearError();
  const file = $('file-input').files[0];
  if (!file) {
    showError('Najpierw wybierz plik z nagraniem.');
    return;
  }
  stopPlayback();
  setBusy(true);
  setStatus('Wczytuję plik');
  try {
    const { samples, sampleRate } = await decodeToMono(await file.arrayBuffer());
    await learn(samples, sampleRate, { id: `file-${file.name}-${file.size}`, title: file.name.replace(/\.[^.]+$/, ''), source: 'file' });
  } catch (error) {
    setStatus(null);
    showError(error.message);
    setBusy(false);
  }
});

/* Analysis */

function runAnalysis(samples, sampleRate, onProgress) {
  const inline = async () => {
    const { analyzeAudio } = await import('./analysis.js');
    return analyzeAudio(samples, sampleRate, onProgress);
  };
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    } catch {
      inline().then(resolve, reject);
      return;
    }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.fraction, data.label);
      else {
        worker.terminate();
        if (data.type === 'done') resolve(data.result);
        else reject(new Error(data.message));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      inline().then(resolve, reject);
    };
    worker.postMessage({ samples, sampleRate });
  });
}

async function learn(samples, sampleRate, meta) {
  setStatus('Analizuję nagranie', 0);
  const result = await runAnalysis(samples, sampleRate, (fraction, label) => setStatus(`${label}`, fraction));
  setStatus(null);
  setBusy(false);
  const song = {
    ...meta,
    bpm: Math.round(result.bpm),
    key: { tonic: result.key.tonic, mode: result.key.mode },
    bars: result.bars,
    activity: result.activity,
    info: `${result.bars.length} taktów w wykrytym obiegu (zgodność powtórzeń ${Math.round(result.formScore * 100)}%). Przeanalizowano ${result.analyzedBars} taktów z nagrania trwającego ${formatTime(result.duration)}.`,
  };
  setSong(song, { persist: true, scroll: true });
}

/* Manual chords */

const EXAMPLE_CHART = 'Dm7 | G7 | Cmaj7 | Cmaj7';

$('chords-example').addEventListener('click', () => {
  $('chords-text').value = EXAMPLE_CHART;
  $('chords-bpm').value = '120';
});

$('chords-use').addEventListener('click', () => {
  clearError();
  const cells = $('chords-text').value.split(/[|\n]/).map((c) => c.trim()).filter(Boolean);
  if (cells.length === 0) {
    showError('Wpisz akordy, na przykład: Dm7 | G7 | Cmaj7 | Cmaj7.');
    return;
  }
  if (cells.length > 64) {
    showError('Mogę zagrać najwyżej 64 takty naraz.');
    return;
  }
  const bars = [];
  for (const [i, cell] of cells.entries()) {
    const chords = parseBarCell(cell);
    if (!chords) {
      showError(`Takt ${i + 1} („${cell}”): nie rozpoznaję akordu. Obsługuję maj7, 7, m7, m7b5 i dim7, najwyżej cztery akordy w takcie.`);
      return;
    }
    bars.push(cell.split(/[\s,]+/).filter(Boolean));
  }
  const bpm = clamp(Math.round(Number($('chords-bpm').value) || 120), 40, 300);
  const key = keyFromChords(bars.flat().map((t) => parseBarCell(t)[0]));
  setSong({ id: 'manual', title: 'Własne akordy', source: 'manual', bpm, key, bars, activity: 0.4, info: `${bars.length} taktów wpisanych ręcznie.` }, { persist: false, scroll: true });
});

/* Song model and learned section */

function parseBars() {
  const parsed = [];
  for (const cell of state.song.bars) {
    const chords = parseBarCell(cell.join(' '));
    if (!chords) return null;
    parsed.push(chords);
  }
  return parsed;
}

function persist() {
  const song = state.song;
  if (song.source === 'manual') return;
  saveSong({ id: song.id, title: song.title, source: song.source, videoId: song.videoId, bpm: song.bpm, key: song.key, bars: song.bars, activity: song.activity, info: song.info });
  renderSaved();
}

function setSong(song, { persist: save, scroll }) {
  stopPlayback();
  state.song = song;
  $('learned-empty').hidden = true;
  $('learned').hidden = false;
  $('song-title').textContent = song.title;
  $('bpm-input').value = song.bpm;
  $('key-tonic').value = String(song.key.tonic);
  $('key-mode').value = song.key.mode;
  $('form-info').textContent = song.info;
  renderChart();
  $('chart-error').hidden = true;
  if (save) persist();
  generate();
  if (scroll) $('nauka').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

function renderChart() {
  const chart = $('chart');
  chart.replaceChildren();
  state.song.bars.forEach((cell, i) => {
    const label = document.createElement('label');
    label.className = 'bar';
    label.dataset.bar = i;
    const no = document.createElement('span');
    no.className = 'bar-no';
    no.textContent = `Takt ${i + 1}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = cell.join(' ');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.bar = i;
    label.append(no, input);
    chart.append(label);
  });
}

$('chart').addEventListener('change', (e) => {
  const input = e.target;
  const i = Number(input.dataset.bar);
  const chords = parseBarCell(input.value);
  if (!chords) {
    input.setAttribute('aria-invalid', 'true');
    $('chart-error').textContent = `Takt ${i + 1} („${input.value}”): nie rozpoznaję akordu. Obsługuję maj7, 7, m7, m7b5 i dim7, najwyżej cztery akordy w takcie.`;
    $('chart-error').hidden = false;
    return;
  }
  input.removeAttribute('aria-invalid');
  state.song.bars[i] = input.value.split(/[\s,]+/).filter(Boolean);
  if (!$('chart').querySelector('[aria-invalid="true"]')) $('chart-error').hidden = true;
  persist();
  generate();
});

$('chart-add').addEventListener('click', () => {
  if (state.song.bars.length >= 64) return;
  state.song.bars.push([...state.song.bars.at(-1).slice(-1)]);
  renderChart();
  persist();
  generate();
});

$('chart-remove').addEventListener('click', () => {
  if (state.song.bars.length <= 1) return;
  state.song.bars.pop();
  renderChart();
  persist();
  generate();
});

function setBpm(value) {
  const bpm = clamp(Math.round(value) || state.song.bpm, 40, 300);
  stopPlayback();
  state.song.bpm = bpm;
  $('bpm-input').value = bpm;
  persist();
}

$('bpm-input').addEventListener('change', () => setBpm(Number($('bpm-input').value)));
$('bpm-half').addEventListener('click', () => setBpm(state.song.bpm / 2));
$('bpm-double').addEventListener('click', () => setBpm(state.song.bpm * 2));

const tonicSelect = $('key-tonic');
FLAT_NAMES.forEach((name, i) => {
  const option = document.createElement('option');
  option.value = String(i);
  option.textContent = [1, 3, 8, 10].includes(i) ? name.replace('b', '♭') : i === 6 ? 'F♯' : name;
  tonicSelect.append(option);
});

function onKeyChange() {
  state.song.key = { tonic: Number(tonicSelect.value), mode: $('key-mode').value };
  persist();
  renderScore();
}
tonicSelect.addEventListener('change', onKeyChange);
$('key-mode').addEventListener('change', onKeyChange);

/* Saved songs */

function renderSaved() {
  const list = loadSongs();
  $('saved-empty').hidden = list.length > 0;
  const ul = $('saved-list');
  ul.replaceChildren();
  for (const song of list) {
    const li = document.createElement('li');
    li.className = 'saved-item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn saved-open';
    const title = document.createElement('span');
    title.className = 'saved-title';
    title.textContent = song.title;
    const meta = document.createElement('span');
    meta.className = 'saved-meta';
    meta.textContent = `${song.bpm} BPM, ${keyName(song.key.tonic, song.key.mode)}, ${song.bars.length} taktów`;
    open.append(title, meta);
    open.addEventListener('click', () => openSaved(song));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-icon';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Usuń z pamięci: ${song.title}`);
    del.addEventListener('click', () => {
      deleteSong(song.id);
      renderSaved();
    });
    li.append(open, del);
    ul.append(li);
  }
}

async function openSaved(song) {
  clearError();
  if (song.videoId) {
    selectTab($('tab-youtube'));
    $('yt-url').value = `https://www.youtube.com/watch?v=${song.videoId}`;
    showVideo(song.videoId);
  }
  setSong({ ...song, bars: song.bars.map((b) => [...b]) }, { persist: false, scroll: true });
}

/* Solo generation and notation */

function currentDensity() {
  const v = $('opt-density').value;
  return v === 'auto' ? clamp(0.25 + 0.6 * (state.song.activity ?? 0.4), 0.2, 0.85) : Number(v);
}

function makeChorus(parsedBars) {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  return {
    solo: generateSolo({ bars: parsedBars, density: currentDensity(), range: RANGES[$('opt-range').value], seed }),
    backing: buildBacking(parsedBars, seed),
  };
}

function generate() {
  const parsed = parseBars();
  if (!parsed) return;
  stopPlayback();
  const chorus = makeChorus(parsed);
  state.solo = chorus.solo;
  state.backing = chorus.backing;
  $('play').disabled = false;
  $('regen').disabled = false;
  renderScore();
}

function renderScore() {
  const parsed = parseBars();
  if (!state.song || !state.solo || !parsed) return;
  $('notation-empty').hidden = true;
  $('staff').hidden = false;
  $('notes-details').hidden = false;
  state.rendered = renderNotation($('staff'), { notes: state.solo.notes, bars: parsed, key: state.song.key, written: state.written });
  state.renderedSolo = state.solo;
  state.activeNote = -1;
  state.activeBar = -1;
  renderNotesTable();
}

function renderNotesTable() {
  const concertFifths = displayFifths(state.song.key, false);
  const writtenFifths = displayFifths(state.song.key, true);
  const rows = state.solo.notes.map((n, i) => {
    const beat = n.start % 4;
    const place = `${Math.floor(beat) + 1}${beat % 1 ? ' i' : ''}`;
    const concert = spelledName(spellNote(n.midi, concertFifths));
    const written = spelledName(spellNote(n.midi + TRUMPET_TRANSPOSE, writtenFifths));
    return `<tr data-note="${i}"><td>${Math.floor(n.start / 4) + 1}</td><td>${place}</td><td>${concert}</td><td>${written}</td><td>${formatHz(midiToFreq(n.midi, a4()))}</td></tr>`;
  });
  $('notes-table').innerHTML = rows.join('');
}

$('regen').addEventListener('click', generate);
for (const id of ['opt-density', 'opt-range']) {
  $(id).addEventListener('change', () => state.song && generate());
}
$('opt-swing').addEventListener('change', stopPlayback);
$('opt-a4').addEventListener('change', () => {
  $('opt-a4').value = a4();
  stopPlayback();
  if (state.solo) renderNotesTable();
});

for (const radio of document.querySelectorAll('input[name="view"]')) {
  radio.addEventListener('change', () => {
    state.written = $('view-written').checked;
    $('view-hint').textContent = state.written
      ? 'Nuty i akordy o sekundę wielką wyżej niż brzmią, tak jak czyta je trębacz.'
      : 'Nuty i akordy tak, jak brzmią naprawdę (wysokość koncertowa).';
    renderScore();
  });
}

let resizeTimer = 0;
let lastWidth = 0;
new ResizeObserver(() => {
  const width = $('staff').clientWidth;
  if (!state.solo || $('staff').hidden || width === lastWidth) {
    lastWidth = width;
    return;
  }
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderScore, 150);
}).observe($('staff'));

/* Mix */

function applyMix() {
  const backing = Number($('vol-backing').value) / 0.6;
  engine.setVolume('solo', Number($('vol-solo').value));
  engine.setVolume('bass', $('opt-bass').checked ? 0.7 * backing : 0);
  engine.setVolume('comp', $('opt-comp').checked ? 0.5 * backing : 0);
  engine.setVolume('ride', $('opt-ride').checked ? 0.5 * backing : 0);
}
for (const id of ['vol-solo', 'vol-backing', 'opt-bass', 'opt-comp', 'opt-ride']) $(id).addEventListener('input', applyMix);
applyMix();

$('ref-tone').addEventListener('click', () => engine.referenceTone(a4(), 2));

/* Playback */

let rafId = 0;
let samplesReady = false;

function setPlayingUi(playing) {
  $('play').setAttribute('aria-pressed', String(playing));
  $('play').setAttribute('aria-label', playing ? 'Zatrzymaj odtwarzanie' : 'Odtwórz improwizację');
}

function clearHighlights() {
  for (const els of state.rendered?.noteEls.values() ?? []) els.forEach((el) => el.classList.remove('is-active'));
  state.rendered?.barEls.forEach((el) => el.classList.remove('is-playing'));
  $('chart').querySelectorAll('.bar.is-playing').forEach((el) => el.classList.remove('is-playing'));
  $('notes-table').querySelectorAll('tr.is-active').forEach((el) => el.classList.remove('is-active'));
  state.activeNote = -1;
  state.activeBar = -1;
}

async function startPlayback() {
  const parsed = parseBars();
  if (!parsed || !state.solo) {
    showError('Popraw zaznaczone akordy w tabeli, zanim zagram solo.');
    return;
  }
  clearError();
  ytPlayer?.pause();
  engine.ensure();
  if (!samplesReady) {
    $('now-name').textContent = 'Wczytuję brzmienie trąbki';
    samplesReady = await engine.loadSamples();
    $('now-name').textContent = 'Cisza';
  }
  applyMix();
  const bpm = state.song.bpm;
  const swingPoint = $('opt-swing').value === 'auto' ? autoSwingPoint(bpm) : 0.5;
  player.start({
    bpm,
    swingPoint,
    countIn: $('opt-countin').checked,
    a4: a4(),
    getChorus: (index) => {
      if (index === 0 || !$('opt-regen').checked) return { solo: state.solo, backing: state.backing };
      const chorus = makeChorus(parsed);
      state.solo = chorus.solo;
      state.backing = chorus.backing;
      return chorus;
    },
  });
  setPlayingUi(true);
  rafId = requestAnimationFrame(frame);
}

function stopPlayback() {
  if (!player.playing) return;
  player.stop();
  cancelAnimationFrame(rafId);
  setPlayingUi(false);
  clearHighlights();
  $('now-hz').textContent = '0,00';
  $('now-name').textContent = 'Cisza';
  $('now-written').textContent = '';
  $('now-bar').textContent = '';
}

function frame() {
  const pos = player.position();
  if (!pos) return;
  rafId = requestAnimationFrame(frame);
  if (pos.counting) {
    $('now-name').textContent = 'Odliczanie';
    $('now-hz').textContent = '0,00';
    $('now-written').textContent = '';
    return;
  }
  const solo = pos.pass.chorus.solo;
  if (solo !== state.renderedSolo) {
    state.solo = solo;
    state.backing = pos.pass.chorus.backing;
    renderScore();
  }
  const bar = Math.floor(pos.beat / 4);
  if (bar !== state.activeBar) {
    state.rendered.barEls[state.activeBar]?.classList.remove('is-playing');
    $('chart').querySelector('.bar.is-playing')?.classList.remove('is-playing');
    state.rendered.barEls[bar]?.classList.add('is-playing');
    $('chart').children[bar]?.classList.add('is-playing');
    state.activeBar = bar;
    $('now-bar').textContent = `Takt ${bar + 1} z ${state.song.bars.length}`;
    const system = state.rendered.systemEls.findIndex((s) => bar >= s.firstBar && bar <= s.lastBar);
    if (system !== state.activeSystem) {
      state.activeSystem = system;
      const el = state.rendered.systemEls[system]?.el;
      const rect = el?.getBoundingClientRect();
      const dockTop = innerHeight - 100;
      if (rect && (rect.top < 60 || rect.bottom > dockTop)) {
        el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
      }
    }
  }
  let index = -1;
  for (let i = 0; i < solo.notes.length; i++) {
    const n = solo.notes[i];
    if (n.start <= pos.beat && pos.beat < n.start + n.dur) {
      index = i;
      break;
    }
  }
  if (index === state.activeNote) return;
  state.rendered.noteEls.get(state.activeNote)?.forEach((el) => el.classList.remove('is-active'));
  $('notes-table').querySelector('tr.is-active')?.classList.remove('is-active');
  state.activeNote = index;
  if (index < 0) {
    $('now-name').textContent = 'Pauza';
    $('now-hz').textContent = '0,00';
    $('now-written').textContent = '';
    return;
  }
  const note = solo.notes[index];
  state.rendered.noteEls.get(index)?.forEach((el) => el.classList.add('is-active'));
  const row = $('notes-table').querySelector(`tr[data-note="${index}"]`);
  row?.classList.add('is-active');
  $('now-hz').textContent = formatHz(midiToFreq(note.midi, a4()));
  $('now-name').textContent = spelledName(spellNote(note.midi, displayFifths(state.song.key, false)));
  $('now-written').textContent = `zapis ${spelledName(spellNote(note.midi + TRUMPET_TRANSPOSE, displayFifths(state.song.key, true)))}`;
}

$('play').addEventListener('click', () => (player.playing ? stopPlayback() : startPlayback()));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && player.playing) stopPlayback();
});

renderSaved();
setBusy(false);
engine.loadSamples().then((ok) => {
  samplesReady = ok;
});
