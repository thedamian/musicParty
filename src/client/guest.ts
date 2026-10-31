import { $, connect, formatTime, h, toast, type PublicItem, type PublicState, type Song } from './shared.js';

type Result = Song & { queued: boolean };

let state: PublicState | null = null;
let stateAt = 0;
let results: Result[] = [];
const adding = new Set<string>();

// Get the anonymous guest cookie before opening the socket, so the server knows which songs are ours.
fetch('/api/session', { credentials: 'same-origin' })
  .catch(() => null)
  .finally(() =>
    connect('', {
      onState(s) {
        state = s;
        stateAt = Date.now();
        render();
      },
      onClose() {
        setStatus('Reconnecting…', 'warn');
      },
    }),
  );

// ---- search -----------------------------------------------------------------------------------

const form = $<HTMLFormElement>('search-form');
const input = $<HTMLInputElement>('q');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return input.focus();
  input.blur(); // closes the phone keyboard so the results are visible
  const button = form.querySelector('button')!;
  button.disabled = true;
  button.textContent = 'Searching…';
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const body = (await res.json()) as { results?: Result[]; error?: string };
    if (!res.ok) throw new Error(body.error ?? 'Search failed.');
    results = body.results ?? [];
    renderResults();
    $('results-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Search failed.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Search';
  }
});

$('clear-results').addEventListener('click', () => {
  results = [];
  input.value = '';
  renderResults();
});

async function add(song: Result) {
  adding.add(song.videoId);
  renderResults();
  try {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: song.videoId }),
    });
    const body = (await res.json()) as { error?: string };
    if (res.status === 409) song.queued = true;
    if (!res.ok) throw new Error(body.error ?? 'Could not add that song.');
    song.queued = true;
    toast(`Added “${song.title}”`);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Could not add that song.', 'error');
  } finally {
    adding.delete(song.videoId);
    renderResults();
  }
}

async function removeMine(item: PublicItem) {
  const res = await fetch(`/api/queue/${item.id}`, { method: 'DELETE' }).catch(() => null);
  if (!res?.ok) toast('That song is no longer waiting.', 'error');
}

// ---- rendering --------------------------------------------------------------------------------

function setStatus(text: string, kind: 'ok' | 'warn') {
  const el = $('status');
  el.textContent = text;
  el.className = `pill ${kind}`;
}

function render() {
  if (!state) return;
  setStatus(state.speakerOnline ? 'Live' : 'Speaker offline', state.speakerOnline ? 'ok' : 'warn');
  renderNow();
  renderQueue();
  renderResults();
}

function renderNow() {
  const now = state?.nowPlaying;
  const el = $('now');
  if (!now) {
    el.replaceChildren(h('p', { class: 'empty', text: 'Nothing is playing. Search for a song to get the party going!' }));
    return;
  }
  el.replaceChildren(
    h('img', { class: 'art', src: now.thumbnail, alt: '', loading: 'lazy' }),
    h(
      'div',
      { class: 'info' },
      h('span', { class: 'label', text: now.paused ? 'Paused' : 'Now playing' }),
      h('strong', { class: 'title', text: now.title }),
      h('span', { class: 'sub', text: now.channel }),
      h('div', { class: 'progress' }, h('div', { class: 'bar', id: 'now-bar' })),
    ),
  );
  tick();
}

function renderQueue() {
  if (!state) return;
  const list = $('queue');
  const now = state.nowPlaying;
  let wait = now ? Math.max(0, now.durationSec - currentPosition()) : 0;
  list.replaceChildren(
    ...state.upcoming.map((item, i) => {
      const startsIn = wait;
      wait += item.durationSec;
      return h(
        'li',
        { class: `row${item.mine ? ' mine' : ''}` },
        h('span', { class: 'num', text: String(i + 1) }),
        h('img', { class: 'thumb', src: item.thumbnail, alt: '', loading: 'lazy' }),
        h(
          'div',
          { class: 'info' },
          h('strong', { class: 'title', text: item.title }),
          h(
            'span',
            { class: 'sub' },
            item.mine ? h('span', { class: 'badge', text: 'Yours' }) : null,
            `${item.channel} · ${formatTime(item.durationSec)}`,
            item.mine ? ` · in ~${Math.max(1, Math.round(startsIn / 60))} min` : '',
          ),
        ),
        item.mine
          ? h('button', { class: 'icon', 'aria-label': `Remove ${item.title}`, text: '✕', onclick: () => removeMine(item) })
          : null,
      );
    }),
  );
  $('queue-empty').hidden = state.upcoming.length > 0;
  const mine = state.upcoming.filter((i) => i.mine).length;
  $('mine-count').textContent = state.maxPerGuest ? `Your songs: ${mine}/${state.maxPerGuest}` : '';
}

function renderResults() {
  $('results-wrap').hidden = results.length === 0;
  const inQueue = new Set([state?.nowPlaying?.videoId, ...(state?.upcoming ?? []).map((i) => i.videoId)]);
  $('results').replaceChildren(
    ...results.map((song) => {
      const queued = song.queued || inQueue.has(song.videoId);
      const busy = adding.has(song.videoId);
      return h(
        'li',
        { class: 'row' },
        h('img', { class: 'thumb', src: song.thumbnail, alt: '', loading: 'lazy' }),
        h(
          'div',
          { class: 'info' },
          h('strong', { class: 'title', text: song.title }),
          h('span', { class: 'sub', text: `${song.channel} · ${formatTime(song.durationSec)}` }),
        ),
        h('button', {
          class: queued ? 'add done' : 'add',
          disabled: queued || busy,
          text: queued ? 'Queued' : busy ? 'Adding…' : 'Add',
          onclick: () => add(song),
        }),
      );
    }),
  );
}

function currentPosition(): number {
  const now = state?.nowPlaying;
  if (!now) return 0;
  const elapsed = now.paused || !state?.speakerOnline ? 0 : (Date.now() - stateAt) / 1000;
  return Math.min(now.position + elapsed, now.durationSec);
}

function tick() {
  const bar = document.getElementById('now-bar');
  const now = state?.nowPlaying;
  if (bar && now?.durationSec) bar.style.width = `${(currentPosition() / now.durationSec) * 100}%`;
}
setInterval(tick, 1000);
