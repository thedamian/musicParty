import path from 'node:path';

/** Project root (one level above dist/). */
export const ROOT = path.resolve(import.meta.dirname, '..');

// Load .env from the project root. Variables already set in the real environment win.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const str = (name: string, fallback: string): string => {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw.trim();
};

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
};

export const config = {
  port: num('PORT', 5004),
  host: str('HOST', '0.0.0.0'),
  /** Shown on the speaker screen and encoded in its QR code. Empty = derived from the request. */
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),
  /** Honour X-Forwarded-For / X-Forwarded-Proto from a reverse proxy on this machine. */
  trustProxy: bool('TRUST_PROXY', true),
  dataDir: path.resolve(ROOT, str('DATA_DIR', 'data')),

  youtubeApiKey: str('YOUTUBE_API_KEY', ''),
  search: {
    /** Appended to every search, e.g. "official audio" or "lyrics". */
    suffix: str('SEARCH_SUFFIX', ''),
    /** YouTube video category; 10 = Music. Empty = any category. API only. */
    categoryId: str('SEARCH_CATEGORY_ID', '10'),
    regionCode: str('SEARCH_REGION_CODE', 'US'),
    safeSearch: str('SEARCH_SAFE', 'moderate'),
    maxResults: Math.min(50, Math.max(1, num('SEARCH_MAX_RESULTS', 15))),
    /** Use keyless YouTube search when there is no API key or its daily quota is used up. */
    fallback: bool('SEARCH_FALLBACK', true),
    cacheMinutes: num('SEARCH_CACHE_MINUTES', 360),
    perMinute: num('SEARCH_PER_MINUTE', 10),
  },

  queue: {
    minSongSeconds: num('MIN_SONG_SECONDS', 60),
    maxSongSeconds: num('MAX_SONG_MINUTES', 10) * 60,
    maxPerGuest: num('MAX_SONGS_PER_GUEST', 3),
    maxLength: num('MAX_QUEUE', 200),
    addsPerMinute: num('ADDS_PER_MINUTE', 10),
  },
};
