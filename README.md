# 🎉 Music Party

A party jukebox. One phone is plugged into the big speaker and opens **music.bocajs.org/speaker**. Guests open **music.bocajs.org** on their own phones, search YouTube and add songs. Songs play in the order they were added, one after another, all night.

- **No accounts.** Guests are anonymous. A cookie only remembers which songs are theirs.
- **Only your queue plays.** YouTube never chooses the next video, and its suggestions at the end of a video are never shown.
- **Survives restarts.** The queue is saved to `data/queue.json`, and every song played is logged to `data/history.jsonl`.

Built with Node.js and TypeScript, using plain `node:http` and [`ws`](https://github.com/websockets/ws). No framework and no database.

## How it works

```
 guests' phones                  server (Node, :5004)                speaker phone
 ──────────────                  ────────────────────                ─────────────
 search ──GET /api/search──▶  YouTube Data API
                               (or keyless fallback)
 add    ──POST /api/queue───▶  queue (source of truth) ──WebSocket──▶ one YouTube player,
                                   ▲    saved to data/                  kept open all night
 live queue ◀──WebSocket───────────┘                                         │
                                   ▲                                         │
                                   └──── "song ended" / "skip" / "failed" ◀──┘
```

- **The server owns the queue.** Every change is pushed to every screen over a WebSocket at `/ws`, so nothing needs refreshing.
- **The speaker never reloads.** It keeps one embedded YouTube player for the whole night. Browsers only allow sound after a tap, and a reload would lose that permission, so one tap on **Start the party** covers the whole night. When a song ends, the speaker tells the server, gets the next song and loads it into the same player. If the queue is empty, the next song added starts right away.
- **YouTube can't take over the screen.** An embedded player never picks another video by itself. YouTube's own screens (end-of-video suggestions, the "more videos" panel when paused, loading) are hidden behind the speaker's cover. While a song plays, the cover is transparent but still blocks taps, so nobody can tap into YouTube.
- **Broken videos are skipped.** A video that refuses to play is skipped after 2 seconds. If 3 videos in a row fail, the problem is most likely the phone's connection, so the speaker stops and shows **Try again** instead of throwing away everyone's songs.
- **A reloaded speaker resumes the song.** The speaker reports its position every 5 seconds, so after a reload or a server restart the current song continues close to where it stopped.

### Queue rules (all adjustable in `.env`)

- A song can't be in the queue twice at the same time.
- Each guest can have up to **3** songs waiting. The song that is playing doesn't count.
- Guests can remove their own waiting songs. The speaker can pause, skip and remove any song.
- Search only shows videos between 1 and 10 minutes long, with no live streams.
- Guests see what's playing, the full queue, which songs are theirs and roughly when each of theirs will play.

## YouTube search: API key vs. keyless

**With a YouTube Data API key (recommended):** search uses the official API and is limited to the Music category and to videos that are allowed to play in embedded players. The free quota is 10,000 units per day, and **one search costs 100 units, so you get about 100 searches a day.** To make that last:

- Search runs only when someone presses Search.
- Repeated searches are answered from a cache.
- Each IP address can search 10 times a minute.

**Without a key, or once the quota is used up:** if `SEARCH_FALLBACK=true`, the server switches to YouTube's own web search (via [`youtubei.js`](https://github.com/LuanRT/YouTube.js)) until the quota resets at midnight Pacific time. It works well, but it isn't an official API and can break when YouTube changes its site. It also can't filter by category or embeddability; the speaker simply skips anything that won't play.

### Getting an API key

1. Go to <https://console.cloud.google.com/>, then create a project or pick an existing one.
2. Open **APIs & Services → Library**, search for **YouTube Data API v3** and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → API key**.
4. Click the new key, and under **API restrictions** choose **Restrict key → YouTube Data API v3**. The key is only used by the server, never sent to browsers.
5. Put it in `.env` as `YOUTUBE_API_KEY=...`.

### Search settings ("only songs")

| Setting | Default | What it does |
| --- | --- | --- |
| `SEARCH_SUFFIX` | *(empty)* | Added to every search, e.g. `official audio`, `lyrics` or `audio`. Skipped if the guest already typed it. |
| `SEARCH_CATEGORY_ID` | `10` | YouTube category. `10` = Music. Empty = any category. API only. |
| `MIN_SONG_SECONDS` | `60` | Hides Shorts and intros. |
| `MAX_SONG_MINUTES` | `10` | Hides hour-long mixes and full albums. `0` = no limit. |
| `SEARCH_REGION_CODE` | `US` | Results that can be played in your country. |
| `SEARCH_SAFE` | `moderate` | `none`, `moderate` or `strict`. API only. |

## Configuration

All settings are in `.env` in the project root. The app loads it on startup, and variables already set in the real environment take priority. `.env` is git-ignored. **Every setting has a default**, so `.env` is optional; you'll want at least `YOUTUBE_API_KEY` and `PUBLIC_URL`. See [`.env.example`](.env.example) for the full list with comments:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `5004` | |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` behind Caddy. |
| `PUBLIC_URL` | *(from request)* | `https://music.bocajs.org`. Shown on the speaker and in its QR code. |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-For`/`-Proto` from a proxy on the same machine. |
| `DATA_DIR` | `data` | Holds `queue.json` and `history.jsonl`. |
| `YOUTUBE_API_KEY` | *(empty)* | See above. |
| `SEARCH_SUFFIX`, `SEARCH_CATEGORY_ID`, `SEARCH_REGION_CODE`, `SEARCH_SAFE` | | See above. |
| `SEARCH_MAX_RESULTS` | `15` | 1–50. |
| `SEARCH_FALLBACK` | `true` | Keyless search when there's no key or the quota is used up. |
| `SEARCH_CACHE_MINUTES` | `360` | How long repeated searches are served from cache. |
| `SEARCH_PER_MINUTE` | `10` | Searches per minute per IP. |
| `MAX_SONGS_PER_GUEST` | `3` | Songs one guest can have waiting. |
| `MAX_QUEUE` | `200` | Songs waiting in total. |
| `ADDS_PER_MINUTE` | `10` | Adds per minute per guest and per IP. |

## Running locally

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env      # then set HOST=0.0.0.0 and PUBLIC_URL= (empty) for local testing
npm run dev               # builds and starts on http://localhost:5004
```

Open `http://localhost:5004/speaker` in one tab and `http://localhost:5004` in another. To try it with real phones, open `http://<your-computer's-LAN-IP>:5004` on them. The screen-wake lock only works over HTTPS, so the speaker phone can still go to sleep while you test this way.

## Deploying to the Ubuntu server

The server already has HTTPS and the `music.bocajs.org` subdomain set up. Node only listens on `127.0.0.1:5004`, behind Caddy.

```bash
# one time
sudo mkdir -p /opt/music-party && sudo chown $USER /opt/music-party
git clone <this repo> /opt/music-party
cd /opt/music-party
cp .env.example .env && nano .env          # set YOUTUBE_API_KEY and PUBLIC_URL
npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save

# updates
cd /opt/music-party && git pull && npm ci && npm run build && pm2 restart music-party
```

- **Caddy:** if `music.bocajs.org` isn't proxied to the app yet, add the block from [`deploy/Caddyfile`](deploy/Caddyfile) and reload Caddy. WebSockets need no extra setup.
- **nginx instead:** pass `Upgrade`/`Connection` headers for `/ws`, plus `X-Forwarded-For` and `X-Forwarded-Proto`.
- **systemd instead of pm2:** use [`deploy/music-party.service`](deploy/music-party.service).
- **Health check:** `curl http://127.0.0.1:5004/healthz` shows whether the YouTube API is in use, the number of queued songs, connected clients and whether the speaker is online.

## Party-day checklist for the speaker phone

- Plug it in and connect it to the speaker by Bluetooth or cable.
- Open **music.bocajs.org/speaker** in Chrome (Android) or Safari (iPhone) and tap **Start the party**. The page asks the phone to keep the screen on. If the screen still turns off, also set auto-lock to "never" for the night, **because a locked screen stops the music.**
- Keep the page open and in front. Switching apps can pause the music.
- If a song shows **Tap to play**, the browser wants another tap. That can happen when the first song is added long after you pressed Start.
- The QR code on the speaker screen takes guests straight to the site.
- YouTube may show ads on some videos. Embedded players can't block them.

## Play history

Every finished song is appended to `data/history.jsonl`, one JSON object per line: `videoId`, `title`, `channel`, `durationSec`, `addedAt`, `startedAt`, `endedAt`, and `result` (`played`, `skipped` or `error`). `GET /api/history?limit=50` returns the most recent songs, ready for a "what we played" page later.

## Project layout

```
src/server/   server.ts (HTTP + routes) · config.ts (.env) · youtube.ts (search) ·
              queue.ts (queue + persistence) · realtime.ts (WebSocket) · guests.ts (cookie, IP, rate limits)
src/client/   guest.ts · speaker.ts · shared.ts       → compiled to public/js/
public/       index.html (guests) · speaker.html · styles.css
deploy/       Caddyfile · music-party.service
```
