import { randomInt } from "crypto";
import {
  type Table,
  type RoomSnapshot,
  type PublicSeat,
  type PublicCheekyBet,
} from "./types";
import { createTable, potBreakdown, type CreateOpts } from "./table";

// In-memory store. One process, one Map — no DB (build prompt §2).
// ponytail: in-memory only; survives nothing. Add Redis if you ever scale past one dyno.
const rooms = new Map<string, Table>();

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I

export function genRoomCode(): string {
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}

export function getRoom(code: string): Table | undefined {
  return rooms.get(code.toUpperCase());
}

export function createRoom(opts: Omit<CreateOpts, "roomCode">): Table {
  const roomCode = genRoomCode();
  const table = createTable({ ...opts, roomCode });
  rooms.set(roomCode, table);
  return table;
}

export function deleteRoom(code: string) {
  rooms.delete(code.toUpperCase());
}

export function seatBySession(t: Table, sessionId: string): number {
  return t.seats.findIndex((s) => s.sessionId === sessionId && s.status !== "empty");
}

export function firstEmptySeat(t: Table): number {
  return t.seats.findIndex((s) => s.status === "empty");
}

// Seat a player (returns seat index) or throw if the table is full. A free
// `preferred` seat is honoured; otherwise the first open chair is used.
export function seatPlayer(
  t: Table,
  sessionId: string,
  nickname: string,
  socketId: string,
  preferred?: number
): number {
  const existing = seatBySession(t, sessionId);
  if (existing >= 0) {
    // reconnect
    t.seats[existing].socketId = socketId;
    t.seats[existing].nickname = nickname;
    return existing;
  }
  const idx =
    preferred != null && t.seats[preferred]?.status === "empty"
      ? preferred
      : firstEmptySeat(t);
  if (idx < 0) throw new Error("Table is full — join as a spectator.");
  t.seats[idx] = {
    socketId,
    sessionId,
    nickname,
    chips: t.buyIn,
    holeCards: null,
    revealed: false,
    status: "sitting-out", // dealt in next hand
    currentBet: 0,
    committed: 0,
    buyInTotal: t.buyIn,
    hasActed: false,
  };
  return idx;
}

export function addSpectator(
  t: Table,
  sessionId: string,
  nickname: string,
  socketId: string
) {
  const existing = t.spectators.find((s) => s.sessionId === sessionId);
  if (existing) {
    existing.socketId = socketId;
    existing.nickname = nickname;
    return;
  }
  t.spectators.push({ socketId, sessionId, nickname });
}

export function removeSpectator(t: Table, sessionId: string) {
  t.spectators = t.spectators.filter((s) => s.sessionId !== sessionId);
}

// ---------- join queue (mid-game players wait here, spectating) ----------

export function inQueue(t: Table, sessionId: string): boolean {
  return t.queue.some((q) => q.sessionId === sessionId);
}

export function enqueuePlayer(
  t: Table,
  sessionId: string,
  nickname: string,
  socketId: string
) {
  const existing = t.queue.find((q) => q.sessionId === sessionId);
  if (existing) {
    existing.nickname = nickname;
    existing.socketId = socketId;
    return;
  }
  t.queue.push({ sessionId, nickname, socketId });
}

export function removeFromQueue(t: Table, sessionId: string) {
  t.queue = t.queue.filter((q) => q.sessionId !== sessionId);
}

// Record a queued player's seat choice (validated against an empty seat at
// drain time, so a seat that fills up first just falls back to the next open).
export function chooseQueueSeat(t: Table, sessionId: string, seatIndex: number) {
  const q = t.queue.find((q) => q.sessionId === sessionId);
  if (q) q.preferredSeat = seatIndex;
}

// Seat as many queued players as there are open chairs, FIFO. Called right
// before a new hand is dealt so they get dealt in. Honours each player's pick.
export function drainQueue(t: Table) {
  while (t.queue.length && firstEmptySeat(t) >= 0) {
    const q = t.queue.shift()!;
    const sock = t.spectators.find((s) => s.sessionId === q.sessionId)?.socketId;
    seatPlayer(t, q.sessionId, q.nickname, sock ?? q.socketId, q.preferredSeat);
    removeSpectator(t, q.sessionId);
  }
}

// ---------- sanitized snapshot, per recipient (build prompt §8) ----------

export function buildSnapshot(t: Table, viewerSessionId: string): RoomSnapshot {
  const rawSeat = seatBySession(t, viewerSessionId);
  // A busted player still holds a seat record but is off the table — treat them
  // as a spectator in their own view (and deny X-ray).
  const youAreBusted = rawSeat >= 0 && t.seats[rawSeat].status === "busted";
  const mySeat = youAreBusted ? -1 : rawSeat;
  const isSpectator = mySeat < 0;
  const isHost = t.hostSessionId === viewerSessionId;
  const isQueued = inQueue(t, viewerSessionId);
  // A full-deal spectator sees everyone's cards; a player only their own.
  // Queued and busted players are spectating but not entitled to X-ray.
  const seeAllCards = isSpectator && !youAreBusted && t.mode === "full-deal" && !isQueued;

  const seats: PublicSeat[] = t.seats.map((s, i) => {
    // Busted seats render as empty chairs — the player has left the table.
    const occupied = s.status !== "empty" && s.status !== "busted" && s.sessionId !== "";
    const mine = occupied && s.sessionId === viewerSessionId;
    // Cheeky-bet counterparties see each other's cards at showdown so the side
    // bet's outcome is visible even if one of them folded the main pot.
    const cheekyReveal =
      t.round === "showdown" &&
      mySeat >= 0 &&
      t.cheekyBets.some(
        (b) =>
          (b.status === "accepted" || b.status === "settled") &&
          ((b.bettorSeatIndex === mySeat && b.opponentSeatIndex === i) ||
            (b.opponentSeatIndex === mySeat && b.bettorSeatIndex === i))
      );
    // A seat's cards show if: it's mine — always while a hand is live, even after
    // folding (between hands a folded hand stays hidden until I opt to reveal);
    // spectator X-ray on a live hand; the player voluntarily revealed; or it's my
    // cheeky counterparty at showdown.
    const reveal =
      occupied &&
      (s.revealed ||
        (mine && (s.status !== "folded" || t.round !== "waiting")) ||
        (seeAllCards && s.status !== "folded") ||
        cheekyReveal);
    return {
      seatIndex: i,
      occupied,
      nickname: s.nickname,
      chips: s.chips,
      status: s.status,
      currentBet: s.currentBet,
      holeCards: reveal ? s.holeCards : null,
      revealed: occupied && s.revealed,
      connected: s.socketId !== null,
      isYou: mine,
      isHost: occupied && s.sessionId === t.hostSessionId,
      isDealer: i === t.dealerIndex,
      isSmallBlind: i === t.sbIndex,
      isBigBlind: i === t.bbIndex,
      isActor: i === t.currentActorIndex,
    };
  });

  // Cheeky bets / peek requests are only ever shown to the viewer who is a
  // party to them — never leaked to the rest of the table (build prompt §11–12).
  const cheekyBets: PublicCheekyBet[] =
    mySeat < 0
      ? []
      : t.cheekyBets
          .filter(
            (b) =>
              b.status !== "declined" &&
              (b.bettorSeatIndex === mySeat || b.opponentSeatIndex === mySeat)
          )
          .map((b) => ({
            id: b.id,
            bettorSeatIndex: b.bettorSeatIndex,
            opponentSeatIndex: b.opponentSeatIndex,
            amount: b.amount,
            status: b.status,
            result: b.result,
            bettorPrediction: b.bettorPrediction,
            iAmBettor: b.bettorSeatIndex === mySeat,
          }));
  const incomingPeekRequests =
    mySeat < 0
      ? []
      : t.cardPeekRequests
          .filter((p) => p.status === "pending" && p.targetSeatIndex === mySeat)
          .map((p) => ({ id: p.id, fromSeatIndex: p.requesterSeatIndex }));

  const snap: RoomSnapshot = {
    roomCode: t.roomCode,
    mode: t.mode,
    maxSeats: t.maxSeats,
    round: t.round,
    pot: t.pot,
    sidePots: potBreakdown(t),
    tipJar: t.tipJar,
    communityCards: t.communityCards,
    dealerIndex: t.dealerIndex,
    currentActorIndex: t.currentActorIndex,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    buyIn: t.buyIn,
    sevenDeuce: t.sevenDeuce,
    minRaise: t.minRaise,
    minRaiseDefault: t.minRaiseDefault,
    handNumber: t.handNumber,
    turnSeconds: Math.round(t.turnMs / 1000),
    turnDeadline: t.turnDeadline,
    seats,
    spectatorCount: t.spectators.length,
    queue: t.queue.map((q) => q.nickname),
    youAreHost: isHost,
    youAreSpectator: isSpectator,
    youAreQueued: isQueued,
    yourQueuedSeat:
      t.queue.find((q) => q.sessionId === viewerSessionId)?.preferredSeat ?? null,
    yourSeatIndex: mySeat < 0 ? null : mySeat,
    log: t.handLog.slice(-40),
    cheekyBets,
    incomingPeekRequests,
    yourBuyInOffer: t.pendingBuyIns[viewerSessionId] ?? null,
    youAreBusted,
    youMustChooseHost: isHost && youAreBusted,
  };

  // Everyone can view hand history (read-only); only the host gets the
  // undo/rollback affordance (canUndo) and acts on it.
  snap.handHistory = t.handHistory.map((h) => ({
    handNumber: h.handNumber,
    summary: h.summary,
    timestamp: h.timestamp,
  }));
  if (isHost) snap.canUndo = t.actionHistory.length > 0;

  return snap;
}
