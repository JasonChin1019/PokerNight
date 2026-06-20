import { randomInt } from "crypto";
import {
  type Table,
  type RoomSnapshot,
  type PublicSeat,
  type PublicCheekyBet,
} from "./types";
import { createTable, type CreateOpts } from "./table";

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

// Seat a player (returns seat index) or throw if the table is full.
export function seatPlayer(
  t: Table,
  sessionId: string,
  nickname: string,
  socketId: string
): number {
  const existing = seatBySession(t, sessionId);
  if (existing >= 0) {
    // reconnect
    t.seats[existing].socketId = socketId;
    t.seats[existing].nickname = nickname;
    t.seats[existing].disconnectedAt = null;
    return existing;
  }
  const idx = firstEmptySeat(t);
  if (idx < 0) throw new Error("Table is full — join as a spectator.");
  t.seats[idx] = {
    socketId,
    sessionId,
    nickname,
    chips: t.buyIn,
    holeCards: null,
    status: "sitting-out", // dealt in next hand
    currentBet: 0,
    committed: 0,
    hasActed: false,
    disconnectedAt: null,
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

// ---------- sanitized snapshot, per recipient (build prompt §8) ----------

export function buildSnapshot(t: Table, viewerSessionId: string): RoomSnapshot {
  const mySeat = seatBySession(t, viewerSessionId);
  const isSpectator = mySeat < 0;
  const isHost = t.hostSessionId === viewerSessionId;
  // A full-deal spectator sees everyone's cards; a player only their own.
  const seeAllCards = isSpectator && t.mode === "full-deal";

  const seats: PublicSeat[] = t.seats.map((s, i) => {
    const occupied = s.status !== "empty" && s.sessionId !== "";
    const mine = occupied && s.sessionId === viewerSessionId;
    const reveal = occupied && (mine || seeAllCards) && s.status !== "folded";
    return {
      seatIndex: i,
      occupied,
      nickname: s.nickname,
      chips: s.chips,
      status: s.status,
      currentBet: s.currentBet,
      holeCards: reveal ? s.holeCards : null,
      connected: s.socketId !== null,
      isYou: mine,
      isHost: occupied && s.sessionId === t.hostSessionId,
      isDealer: i === t.dealerIndex,
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
    sidePots: t.sidePots,
    tipJar: t.tipJar,
    communityCards: t.communityCards,
    dealerIndex: t.dealerIndex,
    currentActorIndex: t.currentActorIndex,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    buyIn: t.buyIn,
    minRaise: t.minRaise,
    handNumber: t.handNumber,
    turnSeconds: Math.round(t.turnMs / 1000),
    turnDeadline: t.turnDeadline,
    seats,
    spectatorCount: t.spectators.length,
    youAreHost: isHost,
    youAreSpectator: isSpectator,
    yourSeatIndex: mySeat < 0 ? null : mySeat,
    log: t.handLog.slice(-40),
    cheekyBets,
    incomingPeekRequests,
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
