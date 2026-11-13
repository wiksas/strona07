const KEY = 'trabka-jam:songs:v1';
const LIMIT = 20;

export function loadSongs() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function saveSong(song) {
  const list = loadSongs().filter((s) => s.id !== song.id);
  list.unshift({ ...song, savedAt: Date.now() });
  return write(list.slice(0, LIMIT));
}

export function deleteSong(id) {
  write(loadSongs().filter((s) => s.id !== id));
}
