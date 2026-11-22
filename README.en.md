# 🎧 Sincro

[Español](README.md) · [English](README.en.md) · [MIT License](LICENSE)

A **free, account-less, bot-less** web app to listen to **the same thing at the same time** with your friends (YouTube / YouTube Music) while you chat on Discord — no screen sharing. Think Spotify Jam, but with YouTube.

**How it works:** no audio is streamed. The server only keeps the room *state* (which video, at which second, playing/paused) and every person plays it in their own browser with the official YouTube player. That's why it's free, and everyone uses their own account (with Premium logged in, you normally see no ads). Technical details: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) (Spanish).

> **Each group self-hosts its own copy** (on a PC or a VPS). Nobody pays for a central server and nobody depends on anyone.

## Quick start (5 minutes)

1. Install [Node.js](https://nodejs.org) 18+.
2. Download this repo (*Code → Download ZIP*) or `git clone https://github.com/YOUR_USER/sincro.git`.
3. In the project folder:
   ```bash
   npm install
   npm start
   ```
4. Open <http://localhost:3000>, pick a nickname and create a room.
5. **To let friends in** without opening router ports, use a free Cloudflare tunnel (no account):
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Share the `https://something.trycloudflare.com` URL it prints, plus the room code. The quick-tunnel URL changes every time you restart it.

## Features

- **Private** (code/link) and **public** (listed) rooms. No sign-up, just a nickname.
- Host controls everything; can promote **admins** ⭐, kick/ban, and optionally let everyone add songs.
- **Shared queue** (paste youtube.com / youtu.be / music.youtube.com links), drag to reorder, play next, **playlists** (first 50 videos), room **history**.
- Optional **search by name** (needs a free YouTube Data API key + access codes so strangers can't burn your quota).
- **Captions/quality** via native YouTube controls (CC · HD button) for yourself; host/admins also get YouTube's keyboard (forward jumps propagate to the room).
- **Fullscreen** with the room chat on the side.
- **Chat** with separate nickname and text colors, **reactions** and **custom emotes** (`:name:`, PNG, 25 per room).
- Customizable **dark theme** with readability protection; **Spanish and English** UI.
- Reconnects automatically (20 s grace keeps your role). Rooms live in memory (no database) and disappear when everyone leaves.

## Configuration

Everything is optional. Copy `.env.example` to `.env`:

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `YOUTUBE_API_KEY` | Enables name search (YouTube Data API v3, free quota ≈100 searches/day) |
| `SEARCH_ACCESS_CODES` | `name:code,...` (min. 8 chars). Search only works with a code |
| `SEARCH_PUBLIC=1` | Open search to everyone (quota runs out fast) |
| `SEARCH_DAILY_MAX` | Own daily cap (default 90) |

`.env` and `iniciar.bat` are in `.gitignore`: your secrets never reach the repo. **Never commit your API key.**

## Hosting

Needs a Node-capable host with HTTPS (not GitHub Pages). Options: your PC + Cloudflare tunnel (free), a cheap VPS, or Docker (`docker build -t sincro . && docker run -p 3000:3000 --env-file .env sincro`). Free tiers like Render may sleep after ~15 min idle and lose in-memory rooms on restart.

## Tests

```bash
npm test          # WebSocket protocol, real clients (97 checks)
npm run test:ui   # UI with jsdom (136 checks)
```

## Limits

Desktop only (mobile browsers pause YouTube when the screen locks). Some videos block embedding. Without Premium, ads can desync you for a few seconds (it resyncs by itself).

## Legal

Not affiliated with or endorsed by YouTube/Google. Uses the official embedded player and your own API key; hosts are responsible for complying with [YouTube's terms](https://www.youtube.com/t/terms). Software provided "as is" (see [LICENSE](LICENSE)).

## ☕ Support

Free and open source. If it's useful and you'd like to buy me a coffee (totally optional): [Cafecito](https://cafecito.app/firewrathness) · [Ko-fi](https://ko-fi.com/firewrathness). A ⭐ also helps!
