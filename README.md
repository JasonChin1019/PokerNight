# PokerNight

Real-time Texas Hold'em for a private group of friends. **Virtual chips only — no
real money, ever.** Players join a room with a short code, sit at a virtual
table, and play No-Limit Hold'em in one of two modes:

- **Online deal** (`full-deal`) — the server shuffles, deals, evaluates hands and
  runs the showdown. Spectators get an X-ray view: every hole card plus live
  Monte-Carlo win-% per player.
- **Real cards** (`chips-only`) — you deal a physical deck at the table; the app is
  purely a betting / pot tracker. The host advances streets and awards the pot
  manually. No cards are ever stored on the server.

One Node process serves the Next.js UI and the Socket.io realtime layer over a
single HTTP server. State is in-memory only — no database.

## Tech stack

- Node 20+ / TypeScript
- Next.js 14 (App Router) + Tailwind CSS
- Socket.io on a custom HTTP server (`server.ts`)
- [`pokersolver`](https://www.npmjs.com/package/pokersolver) for 7-card evaluation
- In-memory `Map<roomCode, Table>` — no persistence

## Project layout

```
server.ts              custom HTTP server: Next.js + Socket.io in one process
lib/poker/             the authoritative game engine (no UI, fully unit-tested)
  types.ts             data model + shared client/server view & event types
  deck.ts              crypto-secure shuffle + pokersolver card encoding
  evaluate.ts          best 5-of-7 + tie-breaking
  sidepots.ts          side-pot layering by all-in level
  equity.ts            Monte-Carlo win-% (spectators only)
  table.ts             betting state machine, streets, showdown, history, tips
  rooms.ts             room store + per-recipient sanitized snapshots
  engine.test.ts       unit tests (side pots, full hand, chips-only, rollback)
lib/socket/handlers.ts socket events -> engine, per-recipient broadcasting
lib/client/socket.ts   client socket + localStorage session id
app/                   landing, /create, /join, /room/[code]
components/Card.tsx    playing-card + card-back
scripts/               end-to-end socket smoke tests
```

## Local development

```bash
npm install
npm run dev        # http://localhost:3000 (hot reload via tsx watch)
```

Run the engine unit tests:

```bash
npm test
```

End-to-end socket smoke tests (against a running server):

```bash
npm run build && PORT=3939 npm start &   # start a server
node scripts/smoke.mjs 3939              # full-deal: deal a hand to showdown
node scripts/smoke-spec.mjs 3939         # spectator sees cards + equity
```

To play with friends on your LAN, run `npm run dev` and share your machine's
local IP (e.g. `http://192.168.1.20:3000`).

## Deploy to Render (free tier)

1. Push this repo to GitHub.
2. In Render, **New → Web Service**, connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Render injects `PORT` automatically — `server.ts` reads it, so leave it alone.
   - Do **not** set `NODE_ENV=production` as a build-time env var: that would prune
     the build tooling before `next build` runs. The start script sets it itself.
5. Deploy. The free tier sleeps after ~15 min idle and takes 30–50s to wake; the
   app shows a "Waking up the table…" screen on the first connection.

Because all state is in-memory, a restart (or the free-tier sleep) ends any game
in progress — fine for a Friday-night session, not for persistence.

## Notes & limits

- No accounts: a nickname + a random `sessionId` in `localStorage` is enough to
  reconnect to your seat and chip stack after a refresh or brief disconnect.
- A player whose turn it is gets a 20s timer; on timeout (or if they've
  disconnected) they auto-check, or fold if there's a bet to call.
- Hand history keeps the last 25 hands. Host-only **roll back** and **undo last
  action** always write a visible log line — no silent edits.
- Chip transfers (player→player or to the dealer "tip jar") are only allowed
  between hands.
