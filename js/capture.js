export const MAX_SECONDS = 360;

export function canCaptureTabAudio() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent);
}

export class CaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Records the audio of the current browser tab (the embedded YouTube player included). */
export class TabListener {
  async start({ onLevel, onTick, onEnded }) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: true,
      });
    } catch (error) {
      if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
        throw new CaptureError('denied', 'Nie udostępniono karty. Kliknij „Naucz się utworu” jeszcze raz i wybierz kartę „Trąbka Jam”.');
      }
      throw new CaptureError('unsupported', 'Ta przeglądarka nie pozwoliła uruchomić nasłuchu. Użyj Chrome lub Edge na komputerze albo wgraj plik audio.');
    }
    const audioTracks = stream.getAudioTracks();
    stream.getVideoTracks().forEach((track) => track.stop());
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new CaptureError('no-audio', 'Karta została udostępniona bez dźwięku. Spróbuj jeszcze raz i zaznacz „Udostępnij dźwięk karty”.');
    }

    this.audioStream = new MediaStream(audioTracks);
    this.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.recorder = new MediaRecorder(this.audioStream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size > 0 && this.chunks.push(e.data);
    this.recorder.start(1000);
    this.startedAt = performance.now();

    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.audioStream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      onLevel(Math.sqrt(sum / buffer.length));
      const seconds = (performance.now() - this.startedAt) / 1000;
      onTick(seconds);
      if (seconds >= MAX_SECONDS) onEnded();
    }, 100);
    audioTracks[0].addEventListener('ended', () => onEnded());
  }

  /** Stops recording and resolves with the recorded blob. */
  stop() {
    clearInterval(this.timer);
    return new Promise((resolve) => {
      const finish = () => {
        this.audioStream.getTracks().forEach((track) => track.stop());
        this.ctx.close();
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
      };
      if (this.recorder.state === 'inactive') finish();
      else {
        this.recorder.onstop = finish;
        this.recorder.stop();
      }
    });
  }
}

/** Decodes audio bytes to mono PCM, keeping at most MAX_SECONDS. */
export async function decodeToMono(arrayBuffer) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctor(1, 1, 44100);
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new CaptureError('decode', 'Nie mogę odczytać tego nagrania jako dźwięku. Spróbuj pliku MP3, WAV, M4A, OGG lub FLAC.');
  }
  const length = Math.min(buffer.length, Math.floor(buffer.sampleRate * MAX_SECONDS));
  const samples = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) samples[i] += channel[i] / buffer.numberOfChannels;
  }
  return { samples, sampleRate: buffer.sampleRate };
}
