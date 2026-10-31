import { $, connect, formatTime, h, toast, type PublicState } from './shared.js';

/**
 * The speaker: one YouTube player that lives for the whole party. The server owns the queue;
 * whenever its "now playing" changes we load that video into the same player, and when a song
 * ends we tell the server, which answers with the next one. YouTube never gets to pick what
 * plays next, and its end-of-video suggestions are always hidden behind our cover.
 */

// Minimal typings for the YouTube IFrame Player API.
interface YTPlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    options: {
      width?: string;
      height?: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?(): void;
        onStateChange?(e: { data: number }): void;
        onError?(e: { data: number }): void;
      };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const UNSTARTED = -1;
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

type Finish = { type: 'ended' | 'error' | 'skip'; itemId: string; code?: number };
type CoverMode = 'loading' | 'paused' | 'next' | 'empty' | 'blocked' | 'failing' | null;

/** After this many videos in a row fail, stop skipping: the problem is probably this phone. */
const MAX_ERRORS_IN_A_ROW = 3;

let state: PublicState | null = null;
let player: YTPlayer | null = null;
let playerReady = false;
let started = false;
/** Queue item id of the video currently loaded in the player. */
let loadedId: string | null = null;
/** A finish message the server hasn't acted on yet; re-sent after a reconnect. */
let pending: Finish | null = null;
let userPaused = false;
let blockedTimer: number | undefined;
let errorsInRow = 0;

const conn = connect('?role=speaker', {
  onState(s) {
    state = s;
    if (pending && s.nowPlaying?.id !== pending.itemId) pending = null;
    render();
    sync();
  },
  onOpen() {
    $('conn').hidden = true;
    if (pending) conn.send(pending);
  },
  onClose() {
    $('conn').hidden = false;
  },
});

fetch('/api/session')
  .then((r) => r.json() as Promise<{ publicUrl?: string }>)
  .then(({ publicUrl }) => {
    const url = (publicUrl ?? location.origin).replace(/^https?:\/\//, '');
    document.querySelectorAll('.join-url').forEach((el) => (el.textContent = url));
  })
  .catch(() => {});

// ---- YouTube player ---------------------------------------------------------------------------

window.onYouTubeIframeAPIReady = () => {
  player = new window.YT!.Player($('player'), {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1,
      controls: 0, // our own buttons only, so nobody taps into YouTube
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3, // no annotations
      rel: 0, // related videos limited to the same channel (YouTube can't turn them off fully)
      playsinline: 1, // iOS: play inside the page instead of going fullscreen
      enablejsapi: 1,
      origin: location.origin,
    },
    events: {
      onReady() {
        playerReady = true;
        sync();
      },
      onStateChange: onPlayerState,
      onError(e) {
        const itemId = loadedId;
        clearTimeout(blockedTimer);
        if (++errorsInRow >= MAX_ERRORS_IN_A_ROW) {
          // Don't burn through everyone's songs if YouTube is unreachable from this phone.
          cover('failing');
          return;
        }
        cover('next');
        toast(`Couldn't play “${state?.nowPlaying?.title ?? 'that song'}”. Skipping it.`, 'error');
        window.setTimeout(() => finish('error', e.data, itemId), 2000);
      },
    },
  });
};
document.head.append(h('script', { src: 'https://www.youtube.com/iframe_api', async: true }));

/** Make the player match the server's "now playing". Safe to call any number of times. */
function sync() {
  if (!state || !player || !playerReady || !started) return;
  const now = state.nowPlaying;
  if ((now?.id ?? null) === loadedId) return;

  loadedId = now?.id ?? null;
  userPaused = false;
  clearTimeout(blockedTimer);
  if (!now) {
    player.stopVideo();
    cover('empty');
    return;
  }
  // Resume where a previous speaker session left off (page reload, server restart).
  const resume = now.position > 5 && now.position < now.durationSec - 10 ? Math.floor(now.position) : 0;
  cover('loading');
  player.loadVideoById({ videoId: now.videoId, startSeconds: resume });
  // Browsers can block playback that doesn't follow a tap. If it hasn't started, ask for one.
  blockedTimer = window.setTimeout(() => {
    const s = player?.getPlayerState();
    if (loadedId === now.id && !userPaused && s !== PLAYING && s !== BUFFERING) cover('blocked');
  }, 5000);
}

function onPlayerState(e: { data: number }) {
  switch (e.data) {
    case PLAYING:
      clearTimeout(blockedTimer);
      errorsInRow = 0;
      cover(null);
      reportProgress();
      break;
    case PAUSED:
      if (cover.mode !== 'next') cover('paused');
      reportProgress();
      break;
    case ENDED:
      cover('next'); // hide YouTube's end screen before it can suggest anything
      finish('ended');
      break;
    case UNSTARTED:
    case BUFFERING:
      break;
  }
  renderControls();
}

function finish(type: Finish['type'], code?: number, itemId = loadedId) {
  if (!itemId || itemId !== loadedId || pending?.itemId === itemId) return;
  pending = { type, itemId, code };
  conn.send(pending);
}

function reportProgress() {
  if (!player || !loadedId || pending) return;
  const s = player.getPlayerState();
  if (s !== PLAYING && s !== PAUSED) return;
  conn.send({ type: 'progress', itemId: loadedId, position: player.getCurrentTime(), paused: s === PAUSED });
}
setInterval(reportProgress, 5000);

// ---- cover over the player --------------------------------------------------------------------

function cover(mode: CoverMode) {
  cover.mode = mode;
  const el = $('cover');
  el.className = `cover${mode ? ' show' : ''}${mode === 'blocked' ? ' blocked' : ''}`;
  const now = state?.nowPlaying;
  const art = $<HTMLImageElement>('cover-art');
  art.hidden = !now || mode === 'empty';
  if (now && !art.hidden && art.getAttribute('src') !== now.thumbnail) art.src = now.thumbnail;
  $('cover-qr').hidden = mode !== 'empty';
  $('tap-play').hidden = mode !== 'blocked';
  $('retry').hidden = mode !== 'failing';
  $('cover-text').textContent =
    mode === 'loading' ? 'Loading…'
    : mode === 'paused' ? 'Paused'
    : mode === 'next' ? 'Up next…'
    : mode === 'empty' ? 'The queue is empty. Scan to add a song!'
    : mode === 'blocked' ? 'The browser needs a tap to start the music.'
    : mode === 'failing' ? "YouTube isn't playing anything. Check this phone's internet connection."
    : '';
}
cover.mode = null as CoverMode;

$('tap-play').addEventListener('click', () => {
  player?.playVideo();
  // Some phones only accept a tap on the YouTube player itself: let the next tap through to it.
  window.setTimeout(() => {
    if (player?.getPlayerState() !== PLAYING && cover.mode === 'blocked') {
      $('cover').classList.add('passthrough');
      $('cover-text').textContent = 'Tap the video to start it.';
    }
  }, 1500);
});

$('retry').addEventListener('click', () => {
  errorsInRow = 0;
  loadedId = null; // forces sync() to load the current song again
  sync();
});

// ---- controls ---------------------------------------------------------------------------------

$('start-btn').addEventListener('click', () => {
  started = true;
  $('start').hidden = true;
  keepAwake();
  sync();
  if (!state?.nowPlaying) cover('empty');
});

$('pause').addEventListener('click', () => {
  if (!player || !loadedId) return;
  if (player.getPlayerState() === PLAYING) {
    userPaused = true;
    player.pauseVideo();
  } else {
    userPaused = false;
    player.playVideo();
  }
});

$('skip').addEventListener('click', () => {
  if (!loadedId) return;
  player?.pauseVideo();
  cover('next');
  finish('skip');
});

// Keep the phone's screen on; a sleeping phone stops the music.
let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (started && document.visibilityState === 'visible') keepAwake();
});
window.addEventListener('beforeunload', () => void wakeLock?.release());

// ---- rendering --------------------------------------------------------------------------------

function render() {
  if (!state) return;
  const now = state.nowPlaying;
  $('np-title').textContent = now?.title ?? 'Nothing playing';
  $('np-channel').textContent = now?.channel ?? 'Add a song from your phone';
  $('np-dur').textContent = now ? formatTime(now.durationSec) : '';
  if (cover.mode) cover(cover.mode); // refresh the cover art

  $('queue').replaceChildren(
    ...state.upcoming.map((item, i) =>
      h(
        'li',
        { class: 'row' },
        h('span', { class: 'num', text: String(i + 1) }),
        h('img', { class: 'thumb', src: item.thumbnail, alt: '', loading: 'lazy' }),
        h(
          'div',
          { class: 'info' },
          h('strong', { class: 'title', text: item.title }),
          h('span', { class: 'sub', text: `${item.channel} · ${formatTime(item.durationSec)}` }),
        ),
        h('button', {
          class: 'icon',
          'aria-label': `Remove ${item.title}`,
          text: '✕',
          onclick: () => conn.send({ type: 'remove', itemId: item.id }),
        }),
      ),
    ),
  );
  $('queue-empty').hidden = state.upcoming.length > 0;
  $('queue-count').textContent = state.upcoming.length ? String(state.upcoming.length) : '';
  renderControls();
}

function renderControls() {
  const hasSong = Boolean(loadedId);
  const playing = player?.getPlayerState?.() === PLAYING;
  $<HTMLButtonElement>('pause').disabled = !hasSong;
  $<HTMLButtonElement>('skip').disabled = !hasSong;
  $('pause').textContent = playing ? '⏸ Pause' : '▶ Play';
}

setInterval(() => {
  if (!player || !playerReady || !loadedId) {
    $('np-bar').style.width = '0%';
    $('np-pos').textContent = '';
    return;
  }
  const pos = player.getCurrentTime() || 0;
  const dur = player.getDuration() || state?.nowPlaying?.durationSec || 0;
  $('np-bar').style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0%';
  $('np-pos').textContent = formatTime(pos);
  // Cover the last moment of the video too, so the end screen never flashes up.
  if (dur && dur - pos < 0.4 && player.getPlayerState() === PLAYING) cover('next');
}, 250);
