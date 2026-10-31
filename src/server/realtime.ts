import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { guestId } from './guests.js';
import type { EndResult, PartyQueue } from './queue.js';

/**
 * One WebSocket endpoint, /ws. Guests (/ws) only listen: they get the queue every time it
 * changes. The speaker (/ws?role=speaker) also tells the server when a song ends, fails, is
 * skipped or removed, and reports its playback position.
 */

type Speaker = { type: 'ended' | 'error' | 'skip'; itemId: string; code?: number }
  | { type: 'remove'; itemId: string }
  | { type: 'progress'; itemId: string; position: number; paused: boolean };

interface Client {
  ws: WebSocket;
  guestId: string | null;
  speaker: boolean;
  alive: boolean;
}

const MAX_CLIENTS = 2000;
const PROGRESS_BROADCAST_MS = 10_000;

export function attachRealtime(server: Server, queue: PartyQueue) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Set<Client>();
  let lastProgressBroadcast = 0;

  const speakerOnline = () => [...clients].some((c) => c.speaker);
  const send = (c: Client) => {
    if (c.ws.readyState === c.ws.OPEN) {
      c.ws.send(JSON.stringify({ type: 'state', state: queue.view(c.guestId, speakerOnline(), c.speaker) }));
    }
  };
  const broadcast = () => clients.forEach(send);
  queue.onChange(broadcast);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || clients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, guestId: guestId(req), speaker: url.searchParams.get('role') === 'speaker', alive: true };
      const wasOnline = speakerOnline();
      clients.add(client);
      if (client.speaker) console.log('[speaker] connected');

      ws.on('pong', () => (client.alive = true));
      ws.on('message', (data, isBinary) => {
        if (!client.speaker || isBinary) return;
        let msg: Speaker;
        try {
          msg = JSON.parse(data.toString()) as Speaker;
        } catch {
          return;
        }
        if (typeof msg?.itemId !== 'string') return;
        if (msg.type === 'ended' || msg.type === 'error' || msg.type === 'skip') {
          const result: EndResult = msg.type === 'ended' ? 'played' : msg.type === 'skip' ? 'skipped' : 'error';
          if (msg.type === 'error') console.warn(`[speaker] video failed to play (YouTube error ${msg.code ?? '?'})`);
          queue.finish(msg.itemId, result);
        } else if (msg.type === 'remove') {
          queue.remove(msg.itemId, null);
        } else if (msg.type === 'progress') {
          if (!queue.progress(msg.itemId, Number(msg.position), Boolean(msg.paused))) return;
          // Guests interpolate the progress bar themselves; an occasional sync is plenty.
          if (Date.now() - lastProgressBroadcast > PROGRESS_BROADCAST_MS) {
            lastProgressBroadcast = Date.now();
            broadcast();
          }
        }
      });
      ws.on('close', () => {
        clients.delete(client);
        if (client.speaker) {
          console.log('[speaker] disconnected');
          if (!speakerOnline()) broadcast();
        }
      });

      if (client.speaker && !wasOnline) broadcast();
      else send(client);
    });
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return () => ({ clients: clients.size, speakerOnline: speakerOnline() });
}
