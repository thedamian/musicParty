export interface Song {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnail: string;
}

export interface PublicItem extends Song {
  id: string;
  addedAt: number;
  mine: boolean;
}

export interface PublicState {
  nowPlaying: (PublicItem & { position: number; paused: boolean }) | null;
  upcoming: PublicItem[];
  speakerOnline: boolean;
  maxPerGuest: number;
}

type Props = Record<string, string | boolean | number | ((e: Event) => void) | undefined>;

/** Tiny DOM builder. Text always goes through textContent, so YouTube titles can't inject HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = 'toast'), 3500);
}

export interface Connection {
  send(message: unknown): boolean;
}

/** WebSocket to /ws that reconnects forever with backoff. The server pushes the full state. */
export function connect(
  query: string,
  handlers: { onState(state: PublicState): void; onOpen?(): void; onClose?(): void },
): Connection {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: number | undefined;

  const open = () => {
    clearTimeout(timer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
    ws.onopen = () => {
      attempt = 0;
      handlers.onOpen?.();
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string; state?: PublicState };
        if (msg.type === 'state' && msg.state) handlers.onState(msg.state);
      } catch {
        // ignore malformed messages
      }
    };
    ws.onclose = () => {
      ws = null;
      handlers.onClose?.();
      timer = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
    };
  };

  // Phones drop sockets while asleep; reconnect right away when the page is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !ws) open();
  });
  open();

  return {
    send(message) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(message));
      return true;
    },
  };
}
