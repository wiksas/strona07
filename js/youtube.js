export function parseYouTubeId(input) {
  const text = input.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(url.pathname)?.[1] ?? null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

let apiPromise = null;

function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('Nie mogę połączyć się z YouTube. Sprawdź internet i spróbuj ponownie.'));
    };
    document.head.append(script);
  });
  return apiPromise;
}

const ERROR_TEXT = {
  2: 'YouTube odrzucił ten link. Sprawdź, czy jest kompletny.',
  5: 'Odtwarzacz YouTube nie mógł uruchomić tego filmu.',
  100: 'Ten film nie istnieje albo jest prywatny.',
  101: 'Autor wyłączył osadzanie tego filmu na innych stronach. Użyj pliku audio albo własnych akordów.',
  150: 'Autor wyłączył osadzanie tego filmu na innych stronach. Użyj pliku audio albo własnych akordów.',
};

export class YouTubePlayer {
  constructor(frame, { onEnded, onError }) {
    this.frame = frame;
    this.onEnded = onEnded;
    this.onError = onError;
    this.player = null;
  }

  async load(videoId) {
    await loadApi();
    if (this.player) {
      this.player.cueVideoById(videoId);
      return;
    }
    this.frame.replaceChildren();
    const host = document.createElement('div');
    this.frame.append(host);
    await new Promise((resolve) => {
      this.player = new window.YT.Player(host, {
        host: 'https://www.youtube-nocookie.com',
        videoId,
        width: '640',
        height: '360',
        playerVars: { rel: 0, playsinline: 1, origin: location.origin },
        events: {
          onReady: resolve,
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.ENDED) this.onEnded();
          },
          onError: (e) => this.onError(ERROR_TEXT[e.data] ?? 'Odtwarzacz YouTube zgłosił błąd.'),
        },
      });
    });
    this.frame.querySelector('iframe')?.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
  }

  get title() {
    return this.player?.getVideoData?.().title || '';
  }

  playFromStart() {
    this.player.seekTo(0, true);
    this.player.playVideo();
  }

  pause() {
    this.player?.pauseVideo?.();
  }

  get isPlaying() {
    return this.player?.getPlayerState?.() === window.YT.PlayerState.PLAYING;
  }
}
