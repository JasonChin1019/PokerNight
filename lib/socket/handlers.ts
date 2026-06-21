import type { Server, Socket } from "socket.io";
import type {
  Table,
  CreateRoomPayload,
  JoinRoomPayload,
  PlayerActionPayload,
  HandResultPayload,
  RequestCheekyBetPayload,
  RespondCheekyBetPayload,
  RequestCardPeekPayload,
  RespondCardPeekPayload,
} from "../poker/types";
import {
  createRoom,
  getRoom,
  buildSnapshot,
  seatPlayer,
  addSpectator,
  removeSpectator,
  seatBySession,
  enqueuePlayer,
  removeFromQueue,
  drainQueue,
  inQueue,
  chooseQueueSeat,
} from "../poker/rooms";
import { emptySeat } from "../poker/types";
import {
  startHand,
  applyAction,
  advanceStreet,
  awardPot,
  donateChips,
  rollbackHand,
  undoLastAction,
  swapSeats,
  requestCheekyBet,
  respondCheekyBet,
  requestCardPeek,
  respondCardPeek,
  revealHand,
  endGame,
  setSevenDeuce,
  offerBuyIn,
  respondBuyIn,
  reassignHostIfNeeded,
  TURN_MS,
  type EngineResult,
  type CheekySettlement,
} from "../poker/table";
import { estimateEquity } from "../poker/equity";

// Per-room turn timer handles (auto-fold/check on timeout). One per room.
const turnTimers = new Map<string, NodeJS.Timeout>();

export function registerSocketHandlers(io: Server) {
  io.on("connection", (socket: Socket) => {
    socket.on("create_room", (p: CreateRoomPayload, ack?: (r: unknown) => void) => {
      try {
        const t = createRoom({
          hostSessionId: p.sessionId,
          mode: p.mode,
          maxSeats: p.maxSeats,
          buyIn: p.buyIn,
          smallBlind: p.smallBlind,
          bigBlind: p.bigBlind,
          turnMs: p.turnSeconds != null ? p.turnSeconds * 1000 : undefined,
          sevenDeuce: p.sevenDeuce,
        });
        seatPlayer(t, p.sessionId, p.nickname, socket.id);
        bind(socket, t.roomCode, p.sessionId);
        ack?.({ ok: true, roomCode: t.roomCode });
        broadcast(io, t);
      } catch (e) {
        fail(socket, ack, e);
      }
    });

    socket.on("join_room", (p: JoinRoomPayload, ack?: (r: unknown) => void) => {
      try {
        const t = getRoom(p.roomCode);
        if (!t) throw new Error("Room not found — check the code.");
        if (p.role === "spectator") {
          addSpectator(t, p.sessionId, p.nickname, socket.id);
        } else if (seatBySession(t, p.sessionId) >= 0) {
          // reclaiming an existing seat (reconnect) — always allowed
          seatPlayer(t, p.sessionId, p.nickname, socket.id);
          removeSpectator(t, p.sessionId);
          removeFromQueue(t, p.sessionId);
        } else if (t.handNumber > 0) {
          // game already underway: queue + spectate until the next hand
          addSpectator(t, p.sessionId, p.nickname, socket.id);
          enqueuePlayer(t, p.sessionId, p.nickname, socket.id);
        } else {
          seatPlayer(t, p.sessionId, p.nickname, socket.id);
          removeSpectator(t, p.sessionId);
        }
        bind(socket, t.roomCode, p.sessionId);
        ack?.({ ok: true, roomCode: t.roomCode });
        broadcast(io, t);
      } catch (e) {
        fail(socket, ack, e);
      }
    });

    socket.on("start_hand", () =>
      run(io, socket, true, (t) => {
        drainQueue(t); // seat anyone who joined since the last hand
        return startHand(t);
      })
    );

    socket.on("player_action", (p: PlayerActionPayload) =>
      run(io, socket, false, (t) => {
        const seat = seatBySession(t, socket.data.sessionId);
        if (seat < 0) throw new Error("You're not seated.");
        const res = applyAction(t, seat, p);
        // drives the per-player action chat bubble on the client
        io.in(t.roomCode).emit("player_acted", {
          seatIndex: seat,
          type: p.type,
          amount: p.amount ?? 0,
        });
        return res;
      })
    );

    socket.on("advance_street", () => run(io, socket, true, (t) => advanceStreet(t)));

    // a player flips their own hand face-up for the table, between hands
    socket.on("reveal_hand", () =>
      run(io, socket, false, (t) => {
        const seat = seatBySession(t, socket.data.sessionId);
        if (seat < 0) throw new Error("You're not seated.");
        return revealHand(t, seat);
      })
    );

    socket.on(
      "award_pot",
      (p: { winningSeatIndexes: number[]; handCategory?: string; sevenDeuce?: boolean }) =>
        run(io, socket, true, (t) =>
          awardPot(t, p.winningSeatIndexes, p.handCategory, p.sevenDeuce)
        )
    );

    socket.on(
      "donate_chips",
      (p: { toSeatIndex?: number; toTipJar?: boolean; amount: number }) =>
        run(io, socket, false, (t) => {
          const seat = seatBySession(t, socket.data.sessionId);
          if (seat < 0) throw new Error("Only seated players can send chips.");
          const res = donateChips(t, seat, p);
          if (p.toSeatIndex !== undefined) {
            const to = t.seats[p.toSeatIndex];
            if (to?.socketId)
              io.to(to.socketId).emit("tip_received", {
                from: t.seats[seat].nickname,
                amount: p.amount,
              });
          }
          return res;
        })
    );

    socket.on("rollback_hand", (p: { targetHandNumber: number }) =>
      run(io, socket, true, (t) => rollbackHand(t, p.targetHandNumber))
    );

    socket.on("undo_last_action", () => {
      const t = room(socket);
      if (!t) return socket.emit("error", { message: "You're not in a room." });
      if (t.hostSessionId !== socket.data.sessionId)
        return socket.emit("error", { message: "Only the host can do that." });
      try {
        const result = undoLastAction(t);
        // dedicated popup so the host sees exactly what was reverted
        io.in(t.roomCode).emit("action_undone", {
          message: result.logs[result.logs.length - 1] ?? "Undid the last action.",
        });
        emitResult(io, t, result);
        broadcast(io, t);
      } catch (e) {
        fail(socket, undefined, e);
      }
    });

    // host rearranges seats between hands (move a player, or swap two)
    socket.on("swap_seats", (p: { a: number; b: number }) =>
      run(io, socket, true, (t) => swapSeats(t, p.a, p.b))
    );

    // host toggles/edits the 7-2 rule mid-game
    socket.on("set_seven_deuce", (p: { amount: number }) =>
      run(io, socket, true, (t) => {
        const deferred = t.round !== "waiting"; // a hand is live → only next round
        const res = setSevenDeuce(t, p.amount);
        const amt = Math.max(0, Math.round(p.amount));
        io.in(t.roomCode).emit("rule_changed", {
          title: amt > 0 ? "7-2 rule turned ON" : "7-2 rule turned OFF",
          message:
            (amt > 0 ? `Win with offsuit 7-2 and everyone pays ${amt} chips. ` : "") +
            (deferred
              ? "Applies to the NEXT hand — the current hand is unaffected."
              : "Applies to the next hand."),
        });
        return res;
      })
    );

    // host offers a player a buy-in; player accepts/declines on their screen
    socket.on("offer_buyin", (p: { seatIndex: number; amount: number }) =>
      run(io, socket, true, (t) => offerBuyIn(t, p.seatIndex, p.amount))
    );

    socket.on("respond_buyin", (p: { accept: boolean }) => {
      const t = room(socket);
      if (!t) return socket.emit("error", { message: "You're not in a room." });
      try {
        emitResult(io, t, respondBuyIn(t, socket.data.sessionId, p.accept));
        broadcast(io, t);
      } catch (e) {
        fail(socket, undefined, e);
      }
    });

    // a queued player picks which open seat they'll drop into next hand
    socket.on("choose_seat", (p: { seatIndex: number }) => {
      const t = room(socket);
      if (!t) return;
      chooseQueueSeat(t, socket.data.sessionId, p.seatIndex);
      broadcast(io, t);
    });

    // ----- cheeky bets (full-deal only) -----
    socket.on("request_cheeky_bet", (p: RequestCheekyBetPayload) =>
      seated(io, socket, (t, seat) => {
        const bet = requestCheekyBet(t, seat, p);
        const oppSock = t.seats[bet.opponentSeatIndex].socketId;
        if (oppSock)
          io.to(oppSock).emit("cheeky_bet_request", {
            betId: bet.id,
            fromNickname: t.seats[seat].nickname,
            prediction: bet.bettorPrediction,
            amount: bet.amount,
          });
        broadcast(io, t);
      })
    );

    socket.on("respond_cheeky_bet", (p: RespondCheekyBetPayload) =>
      seated(io, socket, (t, seat) => {
        const { result } = respondCheekyBet(t, p.betId, p.accept, seat);
        emitResult(io, t, result); // logs + any settlements
        broadcast(io, t);
      })
    );

    // ----- card peeks (full-deal only) -----
    socket.on("request_card_peek", (p: RequestCardPeekPayload) =>
      seated(io, socket, (t, seat) => {
        const peek = requestCardPeek(t, seat, p.targetSeatIndex);
        const tgtSock = t.seats[peek.targetSeatIndex].socketId;
        if (tgtSock)
          io.to(tgtSock).emit("card_peek_request", {
            requestId: peek.id,
            fromNickname: t.seats[seat].nickname,
          });
        broadcast(io, t);
      })
    );

    socket.on("respond_card_peek", (p: RespondCardPeekPayload) =>
      seated(io, socket, (t, seat) => {
        const { result, reveal } = respondCardPeek(t, p.requestId, p.accept, seat);
        if (reveal) {
          const reqSock = t.seats[reveal.requesterSeatIndex].socketId;
          // Private reveal — the cards reach only the requester's socket.
          if (reqSock)
            io.to(reqSock).emit("card_peek_result", {
              targetSeatIndex: reveal.targetSeatIndex,
              nickname: reveal.nickname,
              holeCards: reveal.holeCards,
            });
        }
        emitResult(io, t, result);
        broadcast(io, t);
      })
    );

    socket.on("end_game", () => {
      const t = room(socket);
      if (!t) return socket.emit("error", { message: "You're not in a room." });
      if (t.hostSessionId !== socket.data.sessionId)
        return socket.emit("error", { message: "Only the host can do that." });
      const { result, recap } = endGame(t);
      io.in(t.roomCode).emit("session_recap", recap);
      emitResult(io, t, result);
      broadcast(io, t);
    });

    socket.on("leave_room", () => {
      const t = room(socket);
      if (!t) return;
      removeSpectator(t, socket.data.sessionId);
      removeFromQueue(t, socket.data.sessionId);
      const seat = seatBySession(t, socket.data.sessionId);
      if (seat >= 0) {
        const s = t.seats[seat];
        // Pulling a seat mid-hand would corrupt the pot/turn order. Busted
        // players hold no stake in the live hand, so they may leave anytime.
        if (s.status !== "busted" && t.round !== "waiting")
          return socket.emit("error", { message: "You can only leave between hands." });
        t.handLog.push(`${s.nickname} left the table.`);
        t.seats[seat] = emptySeat();
        const newHost = reassignHostIfNeeded(t);
        if (newHost) t.handLog.push(`${newHost} is now the host.`);
      }
      socket.leave(t.roomCode);
      broadcast(io, t);
    });

    socket.on("disconnect", () => {
      const t = room(socket);
      if (!t) return;
      const seat = seatBySession(t, socket.data.sessionId);
      if (seat >= 0 && t.seats[seat].socketId === socket.id) {
        t.seats[seat].socketId = null;
      }
      removeSpectator(t, socket.data.sessionId);
      removeFromQueue(t, socket.data.sessionId);
      broadcast(io, t);
    });
  });
}

// ---------- helpers ----------

function bind(socket: Socket, roomCode: string, sessionId: string) {
  socket.data.roomCode = roomCode;
  socket.data.sessionId = sessionId;
  socket.join(roomCode);
}

function room(socket: Socket): Table | undefined {
  return socket.data.roomCode ? getRoom(socket.data.roomCode) : undefined;
}

function fail(socket: Socket, ack: ((r: unknown) => void) | undefined, e: unknown) {
  const message = e instanceof Error ? e.message : "Something went wrong.";
  ack?.({ ok: false, message });
  socket.emit("error", { message });
}

// Run an engine mutation for the socket's room, then broadcast the results.
// `hostOnly` gates the host-restricted controls.
function run(
  io: Server,
  socket: Socket,
  hostOnly: boolean,
  fn: (t: Table) => EngineResult
) {
  const t = room(socket);
  if (!t) return socket.emit("error", { message: "You're not in a room." });
  if (hostOnly && t.hostSessionId !== socket.data.sessionId)
    return socket.emit("error", { message: "Only the host can do that." });
  try {
    const result = fn(t);
    emitResult(io, t, result);
    broadcast(io, t);
  } catch (e) {
    fail(socket, undefined, e);
  }
}

// Run a mutation that needs the caller's seat index (cheeky bets / peeks). The
// fn does its own private emits + broadcast; we only resolve the seat and catch.
function seated(
  io: Server,
  socket: Socket,
  fn: (t: Table, seat: number) => void
) {
  const t = room(socket);
  if (!t) return socket.emit("error", { message: "You're not in a room." });
  try {
    const seat = seatBySession(t, socket.data.sessionId);
    if (seat < 0) throw new Error("You're not seated.");
    fn(t, seat);
  } catch (e) {
    fail(socket, undefined, e);
  }
}

// Emit per-recipient room_state to everyone in the room (sanitized), plus the
// spectator-only equity update for full-deal mode. Also (re)arms the turn timer.
async function broadcast(io: Server, t: Table) {
  const sockets = await io.in(t.roomCode).fetchSockets();
  for (const s of sockets) {
    s.emit("room_state", buildSnapshot(t, s.data.sessionId));
  }
  broadcastEquity(io, t, sockets);
  armTurnTimer(io, t);
}

// Equity + opponents' cards reach spectator sockets ONLY (build prompt §8).
function broadcastEquity(io: Server, t: Table, sockets: { emit: Function; data: any }[]) {
  if (t.mode !== "full-deal") return;
  const live = t.seats
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status === "active" || s.status === "all-in");
  if (live.length < 2 || t.round === "waiting" || t.round === "showdown") return;
  const contenders = live
    .filter(({ s }) => s.holeCards)
    .map(({ s, i }) => ({ seatIndex: i, hole: s.holeCards! }));
  const perSeatWinPct = estimateEquity(contenders, t.communityCards);
  for (const s of sockets) {
    // pure spectators only — not seated, not queued to join
    if (seatBySession(t, s.data.sessionId) < 0 && !inQueue(t, s.data.sessionId)) {
      s.emit("equity_update", { perSeatWinPct });
    }
  }
}

function emitResult(io: Server, t: Table, result: EngineResult) {
  for (const line of result.logs) {
    io.in(t.roomCode).emit("action_log", { message: line });
  }
  if (result.showdown) {
    const winners = Array.from(
      new Set(result.showdown.potsAwarded.flatMap((p) => p.winners))
    );
    const payload: HandResultPayload = {
      winners,
      revealedHands: result.showdown.reveals,
      potsAwarded: result.showdown.potsAwarded,
      summary: t.handLog[t.handLog.length - 1] ?? "",
      handCategory: result.showdown.handCategory, // drives the win animation
    };
    io.in(t.roomCode).emit("hand_result", payload);
  }
  if (result.cheeky?.length) emitCheekySettlements(io, t, result.cheeky);
  if (result.sevenDeuce) io.in(t.roomCode).emit("seven_deuce", result.sevenDeuce);
}

// A settled cheeky bet is private to its two players — each gets their own
// win/loss framing, never the whole table.
function emitCheekySettlements(io: Server, t: Table, settlements: CheekySettlement[]) {
  for (const s of settlements) {
    const bSeat = seatBySession(t, s.bettorSessionId);
    const oSeat = seatBySession(t, s.opponentSessionId);
    const bSock = bSeat >= 0 ? t.seats[bSeat].socketId : null;
    const oSock = oSeat >= 0 ? t.seats[oSeat].socketId : null;
    if (bSock)
      io.to(bSock).emit("cheeky_bet_settled", {
        betId: s.betId,
        result: s.result,
        youWon: s.bettorDelta > 0,
        delta: s.bettorDelta,
        amount: s.amount,
        youNickname: s.bettorNickname,
        themNickname: s.opponentNickname,
        message: s.message,
      });
    if (oSock)
      io.to(oSock).emit("cheeky_bet_settled", {
        betId: s.betId,
        result: s.result,
        youWon: s.opponentDelta > 0,
        delta: s.opponentDelta,
        amount: s.amount,
        youNickname: s.opponentNickname,
        themNickname: s.bettorNickname,
        message: s.message,
      });
  }
}

// ---------- turn timer ----------

function armTurnTimer(io: Server, t: Table) {
  const prev = turnTimers.get(t.roomCode);
  if (prev) clearTimeout(prev);
  if (t.currentActorIndex < 0 || !t.turnDeadline) return;

  const actorAtArm = t.currentActorIndex;
  const delay = Math.max(0, t.turnDeadline - Date.now());
  io.in(t.roomCode).emit("turn_timer", { deadline: t.turnDeadline });

  const handle = setTimeout(() => {
    // Still the same player's turn? Auto-check if possible, else fold.
    if (t.currentActorIndex !== actorAtArm) return;
    const seat = t.seats[actorAtArm];
    if (!seat || seat.status !== "active") return;
    const hb = Math.max(0, ...t.seats.map((s) => s.currentBet));
    const type = hb - seat.currentBet > 0 ? "fold" : "check";
    try {
      const result = applyAction(t, actorAtArm, { type });
      emitResult(io, t, result);
      broadcast(io, t);
    } catch {
      /* race with a real action — ignore */
    }
  }, delay + 250); // small grace so a click landing right at the deadline wins

  turnTimers.set(t.roomCode, handle);
}
