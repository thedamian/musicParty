import { config } from './config.js'; // first: loads .env before anything reads it
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { clientIp, guestId, newGuestCookie, publicUrl, RateLimiter } from './guests.js';
import { PartyQueue } from './queue.js';
import { attachRealtime } from './realtime.js';
import { apiAvailable, isVideoId, lookup, search } from './youtube.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Pretty URLs for the two pages. */
const PAGES: Record<string, string> = { '/': '/index.html', '/speaker': '/speaker.html', '/speaker/': '/speaker.html' };

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  // YouTube's embedded player refuses to play without a Referer, so don't use no-referrer.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "img-src 'self' data: https://i.ytimg.com",
    "connect-src 'self' ws: wss:",
    "style-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const queue = new PartyQueue();
const searchLimiter = new RateLimiter(config.search.perMinute);
const addLimiter = new RateLimiter(config.queue.addsPerMinute);
const qrCache = new Map<string, string>();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    else res.end();
  });
});
const stats = attachRealtime(server, queue);

async function handle(req: IncomingMessage, res: ServerResponse) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, youtubeApi: apiAvailable(), queued: queue.upcoming.length, ...stats() });
  }

  // Guests call this first; it hands out the anonymous guest cookie.
  if (pathname === '/api/session' && req.method === 'GET') {
    if (!guestId(req)) res.setHeader('Set-Cookie', newGuestCookie(req).cookie);
    return sendJson(res, 200, { publicUrl: publicUrl(req), maxPerGuest: config.queue.maxPerGuest });
  }

  if (pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return sendJson(res, 400, { error: 'Type something to search for.' });
    if (q.length > 100) return sendJson(res, 400, { error: 'That search is too long.' });
    if (!searchLimiter.allow(clientIp(req))) {
      return sendJson(res, 429, { error: 'Slow down a little. Try searching again in a minute.' });
    }
    try {
      const { results, source } = await search(q);
      return sendJson(res, 200, { source, results: results.map((s) => ({ ...s, queued: queue.includes(s.videoId) })) });
    } catch (err) {
      console.error('[search]', err instanceof Error ? err.message : err);
      return sendJson(res, 502, { error: 'Search is not working right now. Please try again.' });
    }
  }

  if (pathname === '/api/queue' && req.method === 'POST') {
    const guest = guestId(req);
    if (!guest) return sendJson(res, 401, { error: 'Please reload the page and try again.' });
    if (!addLimiter.allow(guest) || !addLimiter.allow(`ip:${clientIp(req)}`)) {
      return sendJson(res, 429, { error: 'Slow down a little. Try again in a minute.' });
    }
    const body = (await readJson(req)) as { videoId?: unknown } | null;
    if (!isVideoId(body?.videoId)) return sendJson(res, 400, { error: 'Pick a song from the search results.' });
    const song = await lookup(body.videoId);
    if (!song) return sendJson(res, 404, { error: 'Search for that song again, then add it.' });
    const result = queue.add(song, guest);
    return result.ok ? sendJson(res, 201, { id: result.item.id }) : sendJson(res, result.status, { error: result.error });
  }

  const remove = /^\/api\/queue\/([0-9a-f-]{36})$/.exec(pathname);
  if (remove && req.method === 'DELETE') {
    const guest = guestId(req);
    if (!guest || !queue.remove(remove[1], guest)) return sendJson(res, 404, { error: 'That song is no longer waiting.' });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    return sendJson(res, 200, { history: queue.history.slice(-limit).reverse() });
  }

  if (pathname === '/qr.svg') {
    const target = publicUrl(req);
    let svg = qrCache.get(target);
    if (!svg) {
      svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      qrCache.set(target, svg);
    }
    res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'public, max-age=3600' });
    return res.end(req.method === 'HEAD' ? undefined : svg);
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  return serveStatic(req, res, PAGES[pathname] ?? pathname);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 404, 'Not found');

  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

server.listen(config.port, config.host, () => {
  console.log(`Music Party listening on http://${config.host}:${config.port}`);
  console.log(`  guests: /   speaker: /speaker`);
  console.log(
    `  search: ${config.youtubeApiKey ? 'YouTube Data API' : 'no YOUTUBE_API_KEY'}` +
      `${config.search.fallback ? ', keyless fallback on' : ''}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    queue.flush().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
