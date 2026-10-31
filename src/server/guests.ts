import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { config } from './config.js';

/** Anonymous guest id, kept in a cookie so the per-guest song limit survives reloads. */
export const GUEST_COOKIE = 'mp_guest';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guestId(req: IncomingMessage): string | null {
  const value = parseCookies(req.headers.cookie)[GUEST_COOKIE];
  return value && UUID.test(value) ? value : null;
}

export function newGuestCookie(req: IncomingMessage): { id: string; cookie: string } {
  const id = randomUUID();
  const cookie = [
    `${GUEST_COOKIE}=${id}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isSecureRequest(req) ? ['Secure'] : []),
  ].join('; ');
  return { id, cookie };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as TLSSocket).encrypted) return true;
  return config.trustProxy && isLoopback(req.socket.remoteAddress) && firstHeader(req, 'x-forwarded-proto') === 'https';
}

/** Public URL guests should open, for the speaker's QR code. */
export function publicUrl(req: IncomingMessage): string {
  if (config.publicUrl) return config.publicUrl;
  const host = firstHeader(req, 'x-forwarded-host') ?? req.headers.host ?? 'localhost';
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

/**
 * The real client IP. X-Forwarded-For is only honoured when the request comes from a proxy on
 * this machine (Caddy/nginx), and then the right-most entry is used, since the client can
 * forge anything to the left of what the proxy appended.
 */
export function clientIp(req: IncomingMessage): string {
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (config.trustProxy && isLoopback(remote)) {
    const forwarded = firstHeader(req, 'x-forwarded-for')?.split(',').pop()?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return remote;
}

function isLoopback(address: string | undefined): boolean {
  const a = (address ?? '').replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

/** Token bucket per key, e.g. "10 searches per minute per IP". */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(private readonly perMinute: number) {
    setInterval(() => this.sweep(), 5 * 60_000).unref();
  }

  allow(key: string): boolean {
    if (!this.perMinute) return true;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, last: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.last) / 60_000) * this.perMinute);
    b.last = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private sweep() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(key);
  }
}
