import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Song } from './youtube.js';

export interface QueueItem extends Song {
  id: string;
  guestId: string;
  addedAt: number;
}

export interface NowPlaying extends QueueItem {
  startedAt: number;
  /** Last position the speaker reported, so a reloaded speaker can pick up where it was. */
  position: number;
  paused: boolean;
}

export type EndResult = 'played' | 'skipped' | 'error';

export interface HistoryEntry {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  addedAt: number;
  startedAt: number;
  endedAt: number;
  result: EndResult;
}

export interface PublicItem extends Song {
  id: string;
  addedAt: number;
  mine: boolean;
}

export interface PublicState {
  /** position: seconds into the song right now (as best the server knows). */
  nowPlaying: (PublicItem & { position: number; paused: boolean }) | null;
  upcoming: PublicItem[];
  speakerOnline: boolean;
  maxPerGuest: number;
}

export type AddResult = { ok: true; item: QueueItem } | { ok: false; status: number; error: string };

const STATE_FILE = path.join(config.dataDir, 'queue.json');
const HISTORY_FILE = path.join(config.dataDir, 'history.jsonl');
const RECENT_HISTORY = 200;

/**
 * The party queue: one song playing plus the songs waiting, in the order they were added.
 * The server is the only source of truth; the speaker and guests just render what it sends.
 * Saved to data/queue.json on every change, and every finished song is appended to
 * data/history.jsonl.
 */
export class PartyQueue {
  nowPlaying: NowPlaying | null = null;
  upcoming: QueueItem[] = [];
  /** Most recent finished songs, newest last. */
  readonly history: HistoryEntry[] = [];
  private reportedAt = Date.now();
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners: (() => void)[] = [];

  constructor() {
    this.load();
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  add(song: Song, guestId: string): AddResult {
    const { maxPerGuest, maxLength, minSongSeconds, maxSongSeconds } = config.queue;
    if (this.nowPlaying?.videoId === song.videoId || this.upcoming.some((i) => i.videoId === song.videoId)) {
      return { ok: false, status: 409, error: 'That song is already in the queue.' };
    }
    if (song.durationSec < minSongSeconds || (maxSongSeconds && song.durationSec > maxSongSeconds)) {
      return { ok: false, status: 400, error: 'That video is too short or too long for the party.' };
    }
    if (maxPerGuest && this.upcoming.filter((i) => i.guestId === guestId).length >= maxPerGuest) {
      return {
        ok: false,
        status: 429,
        error: `You already have ${maxPerGuest} songs waiting. Add more once one of them plays.`,
      };
    }
    if (maxLength && this.upcoming.length >= maxLength) {
      return { ok: false, status: 429, error: 'The queue is full. Try again in a few songs.' };
    }

    const item: QueueItem = { ...song, id: randomUUID(), guestId, addedAt: Date.now() };
    if (this.nowPlaying) this.upcoming.push(item);
    else this.start(item);
    console.log(`[queue] + ${song.title}`);
    this.changed();
    return { ok: true, item };
  }

  /**
   * The speaker finished (or skipped, or failed to play) item `itemId`; move on to the next one.
   * Ignored unless it is still the current song, so a late or duplicate message is harmless.
   */
  finish(itemId: string, result: EndResult): boolean {
    const current = this.nowPlaying;
    if (!current || current.id !== itemId) return false;
    this.record(current, result);
    const next = this.upcoming.shift();
    if (next) this.start(next);
    else this.nowPlaying = null;
    console.log(`[queue] ${result}: ${current.title}${next ? ` → ${next.title}` : ' (queue empty)'}`);
    this.changed();
    return true;
  }

  /** Remove a waiting song. Guests may only remove their own; the speaker passes null. */
  remove(itemId: string, guestId: string | null): boolean {
    const index = this.upcoming.findIndex((i) => i.id === itemId && (guestId === null || i.guestId === guestId));
    if (index < 0) return false;
    const [item] = this.upcoming.splice(index, 1);
    console.log(`[queue] - ${item.title}`);
    this.changed();
    return true;
  }

  /** Playback position from the speaker. Not saved to disk on its own; it rides the next save. */
  progress(itemId: string, position: number, paused: boolean): boolean {
    if (!this.nowPlaying || this.nowPlaying.id !== itemId || !Number.isFinite(position)) return false;
    this.nowPlaying.position = Math.max(0, Math.min(position, this.nowPlaying.durationSec || position));
    this.nowPlaying.paused = paused;
    this.reportedAt = Date.now();
    return true;
  }

  includes(videoId: string): boolean {
    return this.nowPlaying?.videoId === videoId || this.upcoming.some((i) => i.videoId === videoId);
  }

  /**
   * What one client sees. Guests get the position extrapolated from the speaker's last report;
   * the speaker gets the last reported position as is, so a reloaded speaker resumes there.
   */
  view(guestId: string | null, speakerOnline: boolean, forSpeaker = false): PublicState {
    const pub = (item: QueueItem): PublicItem => ({
      id: item.id,
      videoId: item.videoId,
      title: item.title,
      channel: item.channel,
      durationSec: item.durationSec,
      thumbnail: item.thumbnail,
      addedAt: item.addedAt,
      mine: guestId !== null && item.guestId === guestId,
    });
    const now = this.nowPlaying;
    let position = now?.position ?? 0;
    if (now && speakerOnline && !forSpeaker && !now.paused) {
      position = Math.min(position + (Date.now() - this.reportedAt) / 1000, now.durationSec);
    }
    return {
      nowPlaying: now ? { ...pub(now), position, paused: now.paused } : null,
      upcoming: this.upcoming.map(pub),
      speakerOnline,
      maxPerGuest: config.queue.maxPerGuest,
    };
  }

  /** Write any pending change now (used on shutdown). */
  async flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  private start(item: QueueItem) {
    this.nowPlaying = { ...item, startedAt: Date.now(), position: 0, paused: false };
    this.reportedAt = Date.now();
  }

  private changed() {
    this.scheduleSave();
    for (const fn of this.listeners) fn();
  }

  private record(item: NowPlaying, result: EndResult) {
    const entry: HistoryEntry = {
      videoId: item.videoId,
      title: item.title,
      channel: item.channel,
      durationSec: item.durationSec,
      addedAt: item.addedAt,
      startedAt: item.startedAt,
      endedAt: Date.now(),
      result,
    };
    this.history.push(entry);
    if (this.history.length > RECENT_HISTORY) this.history.shift();
    mkdir(config.dataDir, { recursive: true })
      .then(() => appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n'))
      .catch((err) => console.error('[queue] could not write history:', err));
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err) => console.error('[queue] could not save queue:', err));
    }, 250);
  }

  private async save() {
    await mkdir(config.dataDir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ nowPlaying: this.nowPlaying, upcoming: this.upcoming }, null, 2));
    await rename(tmp, STATE_FILE); // atomic: a crash mid-write never leaves a half-written file
  }

  private load() {
    try {
      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { nowPlaying?: unknown; upcoming?: unknown };
      if (Array.isArray(saved.upcoming)) this.upcoming = saved.upcoming.filter(isItem);
      if (isItem(saved.nowPlaying)) {
        this.nowPlaying = { position: 0, paused: false, startedAt: Date.now(), ...saved.nowPlaying };
      }
      console.log(`[queue] restored ${this.upcoming.length + (this.nowPlaying ? 1 : 0)} songs from ${STATE_FILE}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[queue] could not read saved queue:', err);
    }
    readFile(HISTORY_FILE, 'utf8')
      .then((text) => {
        const lines = text.trim().split('\n').slice(-RECENT_HISTORY);
        for (const line of lines) {
          try {
            this.history.push(JSON.parse(line) as HistoryEntry);
          } catch {
            // skip a damaged line
          }
        }
      })
      .catch(() => {});
  }
}

function isItem(value: unknown): value is QueueItem {
  const v = value as QueueItem;
  return Boolean(v) && typeof v.id === 'string' && typeof v.videoId === 'string' && typeof v.title === 'string';
}
