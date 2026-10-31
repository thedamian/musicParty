import { Innertube } from 'youtubei.js';
import { config } from './config.js';

export interface Song {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  thumbnail: string;
}

export interface SearchResult {
  results: Song[];
  source: 'youtube-api' | 'fallback';
}

const API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID = /^[\w-]{11}$/;
const thumbnailFor = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/**
 * Songs we have shown to someone in search results. Adding to the queue looks the video up
 * here, so titles and durations always come from YouTube, never from the client.
 */
const known = new Map<string, { song: Song; at: number }>();
const KNOWN_TTL_MS = 24 * 60 * 60 * 1000;
const KNOWN_MAX = 5000;

const cache = new Map<string, { at: number; value: SearchResult }>();
const CACHE_MAX = 500;

/** The API key's daily quota resets at midnight Pacific time; don't retry before then. */
let apiBlockedUntil = 0;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`YouTube API ${status} ${reason}`);
  }
}

export function apiAvailable(): boolean {
  return Boolean(config.youtubeApiKey) && Date.now() >= apiBlockedUntil;
}

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

export async function search(rawQuery: string): Promise<SearchResult> {
  const query = buildQuery(rawQuery);
  const cacheKey = query.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < config.search.cacheMinutes * 60_000) {
    hit.value.results.forEach(remember);
    return hit.value;
  }

  let value: SearchResult | null = null;
  if (apiAvailable()) {
    try {
      value = { results: await apiSearch(query), source: 'youtube-api' };
    } catch (err) {
      handleApiError(err);
      if (!config.search.fallback) throw err;
    }
  }
  if (!value) {
    if (!config.search.fallback) throw new Error('No YouTube API key configured and SEARCH_FALLBACK is off.');
    value = { results: await fallbackSearch(query), source: 'fallback' };
  }

  value.results.forEach(remember);
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

/** Metadata for a video someone wants to queue, or null if we can't vouch for it. */
export async function lookup(videoId: string): Promise<Song | null> {
  const entry = known.get(videoId);
  if (entry && Date.now() - entry.at < KNOWN_TTL_MS) return entry.song;
  if (!apiAvailable()) return null;
  try {
    const [song] = await apiVideos([videoId]);
    if (song) remember(song);
    return song ?? null;
  } catch (err) {
    handleApiError(err);
    return null;
  }
}

function buildQuery(raw: string): string {
  const query = raw.replace(/\s+/g, ' ').trim();
  const suffix = config.search.suffix;
  if (!suffix || query.toLowerCase().includes(suffix.toLowerCase())) return query;
  return `${query} ${suffix}`;
}

function remember(song: Song) {
  known.delete(song.videoId);
  known.set(song.videoId, { song, at: Date.now() });
  if (known.size > KNOWN_MAX) known.delete(known.keys().next().value!);
}

function fitsQueue(song: Song): boolean {
  const { minSongSeconds, maxSongSeconds } = config.queue;
  return song.durationSec >= minSongSeconds && (!maxSongSeconds || song.durationSec <= maxSongSeconds);
}

// ---------------------------------------------------------------------------------------------
// YouTube Data API v3. search.list costs 100 quota units, videos.list costs 1.

async function apiSearch(query: string): Promise<Song[]> {
  const { categoryId, regionCode, safeSearch, maxResults } = config.search;
  const params = new URLSearchParams({
    part: 'id',
    type: 'video',
    q: query,
    // Ask for extra so we still have enough after dropping songs that are too long or short.
    maxResults: String(Math.min(50, maxResults * 2)),
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    safeSearch,
  });
  if (categoryId) params.set('videoCategoryId', categoryId);
  if (regionCode) params.set('regionCode', regionCode);
  const data = (await apiGet('search', params)) as { items?: { id?: { videoId?: string } }[] };
  const ids = (data.items ?? []).map((i) => i.id?.videoId).filter(isVideoId);
  if (!ids.length) return [];
  return (await apiVideos(ids)).filter(fitsQueue).slice(0, maxResults);
}

interface ApiVideo {
  id: string;
  snippet?: { title?: string; channelTitle?: string; liveBroadcastContent?: string };
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean };
}

/** Full details for up to 50 videos, in the order given, skipping live and non-embeddable ones. */
async function apiVideos(ids: string[]): Promise<Song[]> {
  const params = new URLSearchParams({ part: 'snippet,contentDetails,status', id: ids.join(',') });
  const data = (await apiGet('videos', params)) as { items?: ApiVideo[] };
  const byId = new Map((data.items ?? []).map((v) => [v.id, v]));
  const songs: Song[] = [];
  for (const id of ids) {
    const v = byId.get(id);
    if (!v || v.status?.embeddable === false || (v.snippet?.liveBroadcastContent ?? 'none') !== 'none') continue;
    songs.push({
      videoId: id,
      title: v.snippet?.title ?? 'Untitled',
      channel: v.snippet?.channelTitle ?? '',
      durationSec: parseIsoDuration(v.contentDetails?.duration ?? ''),
      thumbnail: thumbnailFor(id),
    });
  }
  return songs;
}

async function apiGet(endpoint: string, params: URLSearchParams): Promise<unknown> {
  params.set('key', config.youtubeApiKey);
  const res = await fetch(`${API}/${endpoint}?${params}`, { signal: AbortSignal.timeout(8000) });
  const body = (await res.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error?.errors?.[0]?.reason ?? 'unknown');
  return body;
}

function handleApiError(err: unknown) {
  if (err instanceof ApiError && (err.reason === 'quotaExceeded' || err.reason === 'dailyLimitExceeded')) {
    apiBlockedUntil = nextPacificMidnight();
    console.warn(`[youtube] API quota used up; using fallback search until ${new Date(apiBlockedUntil).toISOString()}`);
  } else {
    console.error('[youtube]', err instanceof Error ? err.message : err);
  }
}

function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

function nextPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return now.getTime() - sinceMidnight + 24 * 60 * 60 * 1000 + 60_000;
}

// ---------------------------------------------------------------------------------------------
// Keyless fallback: YouTube's own web search (via youtubei.js). Can't filter by category or
// embeddability; the speaker skips anything that refuses to play.

let innertube: Promise<Innertube> | null = null;

async function fallbackSearch(query: string, retry = true): Promise<Song[]> {
  innertube ??= Innertube.create({ retrieve_player: false, location: config.search.regionCode || undefined });
  try {
    const yt = await innertube;
    const res = await yt.search(query, { type: 'video' });
    const songs: Song[] = [];
    for (const node of res.results) {
      if (node.type !== 'Video') continue;
      const v = node as unknown as {
        video_id?: string;
        title?: { toString(): string };
        author?: { name?: string };
        duration?: { seconds?: number };
        is_live?: boolean;
        is_upcoming?: boolean;
      };
      if (!isVideoId(v.video_id) || v.is_live || v.is_upcoming) continue;
      const song: Song = {
        videoId: v.video_id,
        title: v.title?.toString() || 'Untitled',
        channel: v.author?.name ?? '',
        durationSec: v.duration?.seconds ?? 0,
        thumbnail: thumbnailFor(v.video_id),
      };
      if (fitsQueue(song)) songs.push(song);
      if (songs.length >= config.search.maxResults) break;
    }
    return songs;
  } catch (err) {
    innertube = null; // the session may have gone stale; start a fresh one
    if (retry) return fallbackSearch(query, false);
    throw err;
  }
}
