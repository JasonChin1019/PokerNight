# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PokerNight: real-time Texas Hold'em for a private friend group, virtual chips only. The README covers the user-facing feature set, deploy steps, and project layout — read it for those. This file covers the non-obvious architecture and commands.

## Working in this repo

Keep ponytail mode active for all development here: laziest solution that actually works — stdlib and native platform features before dependencies, one line before fifty, no speculative abstractions. The codebase is deliberately small (in-memory state, no DB, one process); keep it that way unless a change genuinely needs more.

## Commands

```bash
npm run dev          # tsx watch server.ts — Next.js + Socket.io, hot reload, :3000
npm test             # vitest run (engine unit tests)
npm run test:watch   # vitest watch
npm run build        # next build
npm start            # production: cross-env NODE_ENV=production tsx server.ts
npm run lint         # next lint
```

Run a single test by file or name:
```bash
npx vitest run lib/poker/engine.test.ts
npx vitest run -t "side pot"
```

E2E socket smoke tests run against a *running* server (see README): `node scripts/smoke.mjs <port>`.

## Architecture

**One process, one HTTP server.** `server.ts` mounts the Next.js request handler and a Socket.io server on the same `createServer`. No CORS in prod (same-origin), permissive in dev for LAN testing. There is no database — all state is `Map<roomCode, Table>` in `lib/poker/rooms.ts` and dies on restart.

**Three layers, strictly separated:**

1. `lib/poker/` — the authoritative game engine. Pure logic, no Socket.io, no React. `table.ts` is the betting state machine (streets, showdown, side pots, history/rollback, cheeky bets, peeks). Engine mutators return an `EngineResult` (`{ logs, showdown?, cheeky? }`) — they never emit; they hand data back to the socket layer. This is the layer that has unit tests.
2. `lib/socket/handlers.ts` — translates socket events → engine calls → broadcasts. Owns all per-recipient emission and the per-room turn timers.
3. `app/` + `components/` + `lib/client/socket.ts` — the Next.js App Router UI. Client identity is a nickname + random `sessionId` in `localStorage` (no accounts); the same `sessionId` reclaims a seat on reconnect.

**Per-recipient sanitized snapshots — the core invariant.** Never emit raw `Table`. `broadcast()` calls `buildSnapshot(t, sessionId)` once per connected socket so each recipient sees only what they're allowed to: a player sees their own hole cards, not opponents'. Two deliberate exceptions, both spectator-only and full-deal-only: `broadcastEquity()` sends Monte-Carlo win-% and opponents' cards to sockets with **no seat** in the room. If you add data to `Table`, decide its visibility in `buildSnapshot` or it leaks.

**Private emits bypass the room broadcast.** Cheeky-bet settlements and card-peek results go `io.to(socketId)` to the two involved players with per-recipient framing — never the whole room. Follow that pattern for anything one player shouldn't see another receive.

**Game modes diverge in the engine, not the transport.** `full-deal` = server shuffles/deals/evaluates (uses `pokersolver` via `deck.ts`/`evaluate.ts`, runs showdown + equity). `chips-only` = no cards ever touch the server; the app is a pot/bet tracker and the host advances streets and awards pots manually. Guard mode-specific paths on `t.mode`.

**Turn timer.** One `setTimeout` per room in `handlers.ts`, re-armed on every broadcast. On expiry it auto-checks (or folds if facing a bet) only if it's still the same actor's turn — it captures the actor index at arm time to avoid racing a real action.

Path alias: `@/*` → repo root (tsconfig).

## Not shipped code

`*.dc.html` and `support*.js` (and `pokernight-claude-*.md`) are Claude Design reference artifacts / build prompts, not part of the running app. Don't edit them to change app behavior, and don't treat the `(new design)` / `(new features)` copies as live source.
