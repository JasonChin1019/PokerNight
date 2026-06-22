import {
  type Table,
  type Seat,
  type GameMode,
  type PlayerActionPayload,
  type Card,
  type CheekyBet,
  type CardPeekRequest,
  type SessionStats,
  type SeatStats,
  type SidePot,
  type RequestCheekyBetPayload,
  type SessionRecapPayload,
  type RecapStanding,
  emptySeat,
} from "./types";
import { randomUUID } from "crypto";
import { shuffledDeck } from "./deck";
import { evaluateSeat, determineWinners } from "./evaluate";
import { computeSidePots, type Contribution } from "./sidepots";

export const TURN_MS = 20_000;

// ---------- result types (consumed by the socket layer) ----------

export type Reveal = {
  seatIndex: number;
  nickname: string;
  holeCards: [Card, Card];
  bestCards: Card[]; // the 5 cards forming this hand
  handName: string;
  handDescr: string;
};
export type PotAward = { winners: number[]; amount: number };
export type ShowdownResult = {
  reveals: Reveal[];
  potsAwarded: PotAward[];
  handCategory?: string; // pokersolver name or host tag → win-animation tier
};

// A settled cheeky bet, for the socket layer to notify both bettors privately.
export type CheekySettlement = {
  betId: string;
  bettorSessionId: string;
  opponentSessionId: string;
  bettorNickname: string;
  opponentNickname: string;
  amount: number;
  bettorDelta: number; // chips gained(+)/lost(−) by the bettor
  opponentDelta: number;
  result: NonNullable<CheekyBet["result"]>;
  message: string;
};

// Engine mutators push log lines here and optionally a showdown result and any
// cheeky-bet settlements produced this tick.
export type EngineResult = {
  logs: string[];
  showdown?: ShowdownResult;
  cheeky?: CheekySettlement[];
  sevenDeuce?: { winners: string[]; perPlayer: number }; // 7-2 rule fired this hand
};

// ---------- creation ----------

export type CreateOpts = {
  roomCode: string;
  hostSessionId: string;
  mode: GameMode;
  maxSeats: number;
  buyIn: number;
  smallBlind: number;
  bigBlind: number;
  minRaise?: number; // host-configured min bet/raise floor; defaults to bigBlind
  turnMs?: number; // 0 = no timer; undefined = default
  sevenDeuce?: number; // 7-2 rule payout per player; 0/undefined = off
};

export function createTable(o: CreateOpts): Table {
  const posInt = (n: number, label: string) => {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a whole number above 0.`);
  };
  posInt(o.buyIn, "Buy-in");
  posInt(o.smallBlind, "Small blind");
  posInt(o.bigBlind, "Big blind");
  if (o.bigBlind < o.smallBlind) throw new Error("Big blind can't be smaller than the small blind.");
  const minRaise = o.minRaise ?? o.bigBlind;
  posInt(minRaise, "Min raise");
  return {
    roomCode: o.roomCode,
    hostSessionId: o.hostSessionId,
    mode: o.mode,
    maxSeats: Math.min(9, Math.max(2, o.maxSeats)),
    seats: Array.from({ length: Math.min(9, Math.max(2, o.maxSeats)) }, emptySeat),
    spectators: [],
    queue: [],
    deck: [],
    communityCards: [],
    pot: 0,
    tipJar: 0,
    dealerIndex: -1,
    sbIndex: -1,
    bbIndex: -1,
    smallBlind: o.smallBlind,
    bigBlind: o.bigBlind,
    buyIn: o.buyIn,
    sevenDeuce: o.sevenDeuce ?? 0,
    pendingSevenDeuce: null,
    round: "waiting",
    currentActorIndex: -1,
    minRaise,
    minRaiseDefault: minRaise,
    turnMs: o.turnMs ?? TURN_MS,
    turnDeadline: null,
    handNumber: 0,
    handLog: [],
    handHistory: [],
    actionHistory: [],
    cheekyBets: [],
    cardPeekRequests: [],
    pendingBuyIns: {},
    sessionStats: { handsPlayed: 0, biggestPot: null, perSeat: {} },
    createdAt: Date.now(),
  };
}

// ---------- small predicates / helpers ----------

const occupied = (s: Seat) => s.status !== "empty" && s.sessionId !== "";
const inHand = (s: Seat) => s.status === "active" || s.status === "all-in";
const canAct = (s: Seat) => s.status === "active";

function highestBet(t: Table): number {
  return Math.max(0, ...t.seats.map((s) => s.currentBet));
}

function occupiedIndexes(t: Table): number[] {
  return t.seats.map((_, i) => i).filter((i) => occupied(t.seats[i]));
}

function inHandIndexes(t: Table): number[] {
  return t.seats.map((_, i) => i).filter((i) => inHand(t.seats[i]));
}

// In-hand seats clockwise starting after `from` (which is included last).
function inHandAfter(t: Table, from: number): number[] {
  const n = t.seats.length;
  const res: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (inHand(t.seats[i])) res.push(i);
  }
  return res;
}

function nextActor(t: Table, from: number): number {
  const order = inHandAfter(t, from);
  const next = order.find((i) => canAct(t.seats[i]));
  return next === undefined ? -1 : next;
}

function log(r: EngineResult, t: Table, msg: string) {
  t.handLog.push(msg);
  r.logs.push(msg);
}

// ---------- snapshots (history + undo) ----------

function cloneState(t: Table): Omit<Table, "handHistory" | "actionHistory"> {
  const { handHistory, actionHistory, ...rest } = t;
  return structuredClone(rest);
}

function snapshotHand(t: Table) {
  t.handHistory.push({
    handNumber: t.handNumber,
    timestamp: Date.now(),
    summary: `Hand #${t.handNumber}`,
    state: cloneState(t),
  });
  while (t.handHistory.length > 25) t.handHistory.shift();
}

function snapshotAction(t: Table) {
  t.actionHistory.push(cloneState(t) as Table);
}

// ---------- chip movement ----------

function putChips(t: Table, seat: Seat, want: number): number {
  const amount = Math.min(want, seat.chips);
  seat.chips -= amount;
  seat.currentBet += amount;
  seat.committed += amount;
  t.pot += amount;
  if (seat.chips === 0 && amount > 0 && inHand(seat)) seat.status = "all-in";
  return amount;
}

// ---------- start a hand ----------

export function startHand(t: Table): EngineResult {
  const r: EngineResult = { logs: [] };
  const funded = occupiedIndexes(t).filter((i) => t.seats[i].chips > 0);
  if (funded.length < 2) throw new Error("Need at least 2 players with chips.");

  // Reset every occupied seat for the new hand (stacks untouched). Busted
  // players stay off the table until they accept a buy-in.
  for (const s of t.seats) {
    if (s.status === "empty" || s.status === "busted") continue;
    s.currentBet = 0;
    s.committed = 0;
    s.hasActed = false;
    s.holeCards = null;
    s.revealed = false;
    s.status = s.chips > 0 ? "active" : "sitting-out";
  }
  t.pot = 0;
  t.communityCards = [];
  t.deck = [];
  t.round = "waiting";
  // Cheeky bets / peeks are per-hand; a fresh hand voids any stragglers.
  t.cheekyBets = [];
  t.cardPeekRequests = [];
  // A rule change made during the previous hand takes effect now.
  if (t.pendingSevenDeuce !== null) {
    t.sevenDeuce = t.pendingSevenDeuce;
    t.pendingSevenDeuce = null;
  }
  t.handNumber++;

  // Snapshot the clean pre-blind/pre-deal state, then reset the per-action undo.
  snapshotHand(t);
  t.actionHistory = [];

  // Move the button to the next funded seat (wraps from -1 on hand #1).
  const fundedNow = occupiedIndexes(t).filter((i) => t.seats[i].chips > 0);
  t.dealerIndex =
    inHandAfter(t, t.dealerIndex).find((i) => fundedNow.includes(i)) ??
    fundedNow[0];

  if (t.mode === "full-deal") {
    t.deck = shuffledDeck();
    for (const i of inHandIndexes(t)) {
      t.seats[i].holeCards = [t.deck.pop()!, t.deck.pop()!];
    }
  }

  postBlinds(t, r);
  t.round = "preflop";
  t.minRaise = t.minRaiseDefault;
  log(r, t, `Hand #${t.handNumber} started.`);
  return r;
}

function postBlinds(t: Table, r: EngineResult) {
  const players = inHandIndexes(t);
  let sb: number, bb: number, first: number;
  if (players.length === 2) {
    sb = t.dealerIndex;
    bb = players.find((i) => i !== t.dealerIndex)!;
    first = sb; // heads-up: button/SB acts first preflop
  } else {
    const after = inHandAfter(t, t.dealerIndex);
    sb = after[0];
    bb = after[1];
    first = after[2]; // UTG
  }
  t.sbIndex = sb;
  t.bbIndex = bb;
  putChips(t, t.seats[sb], t.smallBlind);
  putChips(t, t.seats[bb], t.bigBlind);
  log(r, t, `${t.seats[sb].nickname} posts SB ${t.smallBlind}.`);
  log(r, t, `${t.seats[bb].nickname} posts BB ${t.bigBlind}.`);
  t.currentActorIndex = canAct(t.seats[first]) ? first : nextActor(t, first);
  setDeadline(t);
}

function setDeadline(t: Table) {
  t.turnDeadline =
    t.currentActorIndex >= 0 && t.turnMs > 0 ? Date.now() + t.turnMs : null;
}

// ---------- player actions ----------

export function applyAction(
  t: Table,
  seatIndex: number,
  action: PlayerActionPayload
): EngineResult {
  const r: EngineResult = { logs: [] };
  if (seatIndex !== t.currentActorIndex) throw new Error("Not your turn.");
  const seat = t.seats[seatIndex];
  if (!canAct(seat)) throw new Error("You can't act right now.");

  snapshotAction(t); // enables host single-step undo
  const hb = highestBet(t);
  const toCall = hb - seat.currentBet;

  switch (action.type) {
    case "fold": {
      seat.status = "folded";
      log(r, t, `${seat.nickname} folds.`);
      break;
    }
    case "check": {
      if (toCall > 0) throw new Error("Can't check — there's a bet to call.");
      log(r, t, `${seat.nickname} checks.`);
      break;
    }
    case "call": {
      if (toCall <= 0) throw new Error("Nothing to call — check instead.");
      const paid = putChips(t, seat, toCall);
      log(r, t, `${seat.nickname} calls ${paid}.`);
      break;
    }
    case "bet": {
      if (hb > 0) throw new Error("There's already a bet — raise instead.");
      const amount = action.amount ?? 0;
      const allIn = amount >= seat.currentBet + seat.chips;
      if (!allIn && amount < t.minRaiseDefault)
        throw new Error(`Minimum bet is ${t.minRaiseDefault}.`);
      const paid = putChips(t, seat, amount - seat.currentBet);
      t.minRaise = seat.currentBet;
      reopen(t, seatIndex);
      log(r, t, `${seat.nickname} bets ${paid}.`);
      break;
    }
    case "raise": {
      if (hb === 0) throw new Error("Nothing to raise — bet instead.");
      const target = action.amount ?? 0;
      const increment = target - hb;
      const allIn = target >= seat.currentBet + seat.chips;
      if (target <= hb) throw new Error("Raise must exceed the current bet.");
      if (!allIn && increment < t.minRaise)
        throw new Error(`Minimum raise is to ${hb + t.minRaise}.`);
      putChips(t, seat, target - seat.currentBet);
      if (increment >= t.minRaise) {
        t.minRaise = increment; // full raise reopens the action
        reopen(t, seatIndex);
      }
      log(r, t, `${seat.nickname} raises to ${seat.currentBet}.`);
      break;
    }
    case "all-in": {
      const paid = putChips(t, seat, seat.chips);
      const increment = seat.currentBet - hb;
      if (increment >= t.minRaise) {
        t.minRaise = increment;
        reopen(t, seatIndex);
      }
      log(r, t, `${seat.nickname} is all-in for ${paid}.`);
      break;
    }
  }

  seat.hasActed = true;
  t.currentActorIndex = nextActor(t, seatIndex);
  setDeadline(t);
  settle(t, r);
  return r;
}

// A full bet/raise reopens the betting: everyone else who can still act must
// respond again. (A short all-in does not call this.)
function reopen(t: Table, actorIndex: number) {
  t.seats.forEach((s, i) => {
    if (i !== actorIndex && canAct(s)) s.hasActed = false;
  });
}

function bettingRoundComplete(t: Table): boolean {
  const actors = t.seats.filter(canAct);
  if (actors.length === 0) return true;
  const hb = highestBet(t);
  return actors.every((s) => s.hasActed && s.currentBet === hb);
}

// ---------- street progression ----------

// Called after each action. Full-deal mode auto-runs streets/showdown;
// chips-only mode waits for the host's advance_street.
function settle(t: Table, r: EngineResult) {
  const contenders = inHandIndexes(t);
  if (contenders.length === 1) {
    awardByFold(t, r, contenders[0]);
    return;
  }
  if (!bettingRoundComplete(t)) return;

  if (t.mode === "chips-only") {
    // Host advances the street manually. Leave currentBet/hasActed intact so
    // advanceStreet's completeness gate still sees a settled round.
    t.currentActorIndex = -1;
    t.turnDeadline = null;
    return;
  }

  // Round is settled. Clear per-street bets.
  for (const s of t.seats) {
    s.currentBet = 0;
    if (canAct(s)) s.hasActed = false;
  }
  t.minRaise = t.minRaiseDefault;
  t.currentActorIndex = -1;
  t.turnDeadline = null;

  // Full-deal: if nobody can act anymore (all-in), run the board out.
  const stillBetting = t.seats.filter(canAct).length > 1;
  if (!stillBetting) {
    runOut(t);
    runShowdown(t, r);
    return;
  }
  dealNextStreet(t, r);
}

function dealNextStreet(t: Table, r: EngineResult) {
  if (t.round === "preflop") {
    t.communityCards.push(t.deck.pop()!, t.deck.pop()!, t.deck.pop()!);
    t.round = "flop";
  } else if (t.round === "flop") {
    t.communityCards.push(t.deck.pop()!);
    t.round = "turn";
  } else if (t.round === "turn") {
    t.communityCards.push(t.deck.pop()!);
    t.round = "river";
  } else {
    runShowdown(t, r);
    return;
  }
  startBettingStreet(t);
  log(r, t, `Dealt the ${t.round}.`);
}

function startBettingStreet(t: Table) {
  t.currentActorIndex = nextActor(t, t.dealerIndex);
  setDeadline(t);
}

function runOut(t: Table) {
  while (t.communityCards.length < 5) t.communityCards.push(t.deck.pop()!);
  t.round = "river";
}

// Host-driven street advance (chips-only mode only).
export function advanceStreet(t: Table): EngineResult {
  const r: EngineResult = { logs: [] };
  if (t.mode !== "chips-only") throw new Error("Streets advance automatically.");
  // Allow advancing whenever no bet is left unmatched (a fresh street, or one
  // everybody has called). Blocks advancing over an outstanding bet.
  const hb = highestBet(t);
  if (t.seats.some((s) => canAct(s) && s.currentBet !== hb))
    throw new Error("Someone still has a bet to call.");
  for (const s of t.seats) {
    s.currentBet = 0;
    if (canAct(s)) s.hasActed = false;
  }
  t.minRaise = t.minRaiseDefault;
  const order: Record<string, Table["round"]> = {
    preflop: "flop",
    flop: "turn",
    turn: "river",
    river: "showdown",
  };
  const next = order[t.round];
  if (!next) throw new Error("Can't advance from here.");
  t.round = next;
  if (next === "showdown") {
    t.currentActorIndex = -1;
    t.turnDeadline = null;
    log(r, t, "Showdown — host to award the pot.");
  } else {
    startBettingStreet(t);
    log(r, t, `Host dealt the ${next}.`);
  }
  return r;
}

// ---------- awarding pots ----------

function contributions(t: Table): Contribution[] {
  return t.seats.map((s, i) => ({
    seatIndex: i,
    committed: s.committed,
    folded: s.status === "folded",
    inHand: s.committed > 0,
  }));
}

// Live pot breakdown for the snapshot. Only meaningful once a player is all-in
// and others keep betting above them — otherwise uneven commitments (posted
// blinds, an uncalled bet) would split into spurious "side pots". Returns []
// in every other case so the UI just shows the single total pot.
export function potBreakdown(t: Table): SidePot[] {
  if (t.pot === 0) return []; // between hands
  if (!t.seats.some((s) => s.status === "all-in")) return []; // no all-in → one pot
  const pots = computeSidePots(contributions(t));
  return pots.length > 1 ? pots : []; // all-in but nothing contested above it yet
}

function distribute(t: Table, amount: number, winners: number[]): PotAward {
  const share = Math.floor(amount / winners.length);
  let remainder = amount - share * winners.length;
  // Odd chips go to the first winner clockwise from the dealer.
  const ordered = inHandAfter(t, t.dealerIndex).filter((i) => winners.includes(i));
  const oddOrder = ordered.length ? ordered : winners;
  for (const i of winners) t.seats[i].chips += share;
  for (let k = 0; k < remainder; k++) t.seats[oddOrder[k % oddOrder.length]].chips += 1;
  return { winners, amount };
}

function awardByFold(t: Table, r: EngineResult, winnerIndex: number) {
  const amount = t.pot;
  const award = distribute(t, amount, [winnerIndex]);
  // Surface the win like a showdown so the client shows the pot amount taken
  // (felt "won X" badge + result overlay). No cards revealed — everyone mucked.
  r.showdown = { reveals: [], potsAwarded: [award] };
  endHand(
    t,
    r,
    `${t.seats[winnerIndex].nickname} won ${amount} (all others folded).`,
    [winnerIndex]
  );
}

// Full-deal automatic showdown.
function runShowdown(t: Table, r: EngineResult) {
  t.round = "showdown";
  const live = inHandIndexes(t).filter((i) => t.seats[i].status !== "folded");
  const evals = live.map((i) =>
    evaluateSeat(i, t.seats[i].holeCards!, t.communityCards)
  );
  const reveals: Reveal[] = evals.map((e) => ({
    seatIndex: e.seatIndex,
    nickname: t.seats[e.seatIndex].nickname,
    holeCards: t.seats[e.seatIndex].holeCards!,
    bestCards: e.bestCards,
    handName: e.name,
    handDescr: e.descr,
  }));

  const pots = computeSidePots(contributions(t));
  const potsAwarded: PotAward[] = [];
  for (const pot of pots) {
    const eligibleEvals = evals.filter((e) =>
      pot.eligibleSeatIndexes.includes(e.seatIndex)
    );
    const winners = determineWinners(eligibleEvals);
    if (winners.length) potsAwarded.push(distribute(t, pot.amount, winners));
  }

  // Win-animation category = the strongest hand among seats that took chips.
  const winnerSeats = new Set(potsAwarded.flatMap((p) => p.winners));
  for (const i of winnerSeats) t.seats[i].revealed = true; // auto-flip winner face-up in the waiting screen
  const winnerEvals = evals.filter((e) => winnerSeats.has(e.seatIndex));
  const topSeats = determineWinners(winnerEvals);
  const handCategory = winnerEvals.find((e) => topSeats.includes(e.seatIndex))?.name;

  const summary = summarize(t, potsAwarded);
  r.showdown = { reveals, potsAwarded, handCategory };
  endHand(t, r, summary, [...winnerSeats]);
}

// Chips-only manual award by the host. `handCategory` is purely cosmetic — it
// only picks the win animation, since the server never saw the real cards.
export function awardPot(
  t: Table,
  winningSeatIndexes: number[],
  handCategory?: string,
  sevenDeuce = false // host declares the winner won with offsuit 7-2
): EngineResult {
  const r: EngineResult = { logs: [] };
  if (t.mode !== "chips-only") throw new Error("Pots are awarded automatically.");
  if (t.round !== "showdown") throw new Error("Can only award at showdown.");
  if (winningSeatIndexes.length === 0) throw new Error("Pick at least one winner.");

  const pots = computeSidePots(contributions(t));
  const potsAwarded: PotAward[] = [];
  for (const pot of pots) {
    const winners = winningSeatIndexes.filter((i) =>
      pot.eligibleSeatIndexes.includes(i)
    );
    const finalWinners = winners.length ? winners : winningSeatIndexes;
    potsAwarded.push(distribute(t, pot.amount, finalWinners));
  }
  if (pots.length === 0 && t.pot > 0) {
    potsAwarded.push(distribute(t, t.pot, winningSeatIndexes));
  }
  r.showdown = { reveals: [], potsAwarded, handCategory };
  if (sevenDeuce) applySevenDeuceManual(t, r, winningSeatIndexes);
  endHand(t, r, summarize(t, potsAwarded), winningSeatIndexes);
  return r;
}

// 7-2 rule: a winner holding the worst starting hand — an offsuit 7 and 2 —
// collects `t.sevenDeuce` chips from every other seated player.
function isOffsuitSevenDeuce(cards: Card[] | null): boolean {
  if (!cards || cards.length !== 2) return false;
  const ranks = cards.map((c) => c.rank);
  return ranks.includes("7") && ranks.includes("2") && cards[0].suit !== cards[1].suit;
}

// Transfer the 7-2 payout to one winner. ponytail: no cap — a player can go
// negative and must buy back in (host's buy-in offer).
function payoutSevenDeuce(t: Table, w: number) {
  const win = t.seats[w];
  let collected = 0;
  t.seats.forEach((s, i) => {
    if (i === w || s.status === "empty" || !s.sessionId) return;
    s.chips -= t.sevenDeuce;
    collected += t.sevenDeuce;
  });
  win.chips += collected;
}

// Record the announcement so the socket layer can pop the "everyone must pay X"
// modal for the whole room.
function announceSevenDeuce(t: Table, r: EngineResult, winners: number[]) {
  if (!winners.length) return;
  const names = winners.map((w) => t.seats[w].nickname);
  r.sevenDeuce = { winners: names, perPlayer: t.sevenDeuce };
  log(r, t, `${names.join(" & ")} won with 7-2 — everyone pays ${t.sevenDeuce} (7-2 rule).`);
}

// Full-deal: auto-detect winners who actually held offsuit 7-2.
function applySevenDeuce(t: Table, r: EngineResult, winnerSeats: number[]) {
  if (t.sevenDeuce <= 0 || t.mode !== "full-deal") return;
  const fired: number[] = [];
  for (const w of new Set(winnerSeats)) {
    const win = t.seats[w];
    if (!win || !isOffsuitSevenDeuce(win.holeCards)) continue;
    payoutSevenDeuce(t, w);
    fired.push(w);
  }
  announceSevenDeuce(t, r, fired);
}

// Chips-only: the host declares the 7-2 win when awarding (server never saw cards).
function applySevenDeuceManual(t: Table, r: EngineResult, winnerSeats: number[]) {
  if (t.sevenDeuce <= 0) return;
  const fired = [...new Set(winnerSeats)].filter((w) => t.seats[w]);
  for (const w of fired) payoutSevenDeuce(t, w);
  announceSevenDeuce(t, r, fired);
}

// ---------- host chip management / buy-ins ----------

// Host offers a player a buy-in; it sits pending until they accept or decline.
export function offerBuyIn(t: Table, seatIndex: number, amount: number): EngineResult {
  const r: EngineResult = { logs: [] };
  const s = t.seats[seatIndex];
  if (!s || s.status === "empty") throw new Error("No player in that seat.");
  amount = Math.round(amount);
  if (amount <= 0) throw new Error("Buy-in must be positive.");
  t.pendingBuyIns[s.sessionId] = amount;
  log(r, t, `Host offered ${s.nickname} a ${amount} buy-in.`);
  return r;
}

// Player accepts/declines the host's pending buy-in offer.
export function respondBuyIn(t: Table, sessionId: string, accept: boolean): EngineResult {
  const r: EngineResult = { logs: [] };
  const amount = t.pendingBuyIns[sessionId];
  if (amount == null) return r; // nothing pending (or already handled)
  delete t.pendingBuyIns[sessionId];
  const i = t.seats.findIndex((s) => s.sessionId === sessionId && s.status !== "empty");
  if (i < 0) return r;
  const s = t.seats[i];
  if (!accept) {
    log(r, t, `${s.nickname} declined the buy-in.`);
    return r;
  }
  applyBuyIn(t, s, amount);
  log(r, t, `${s.nickname} bought in for ${amount}${t.round === "waiting" ? "" : " — in next hand"}.`);
  return r;
}

// Add chips and, if it pulls them off zero, bring a busted/sitting-out player
// back. Mid-hand they can't be dealt in — stay sitting-out so the next startHand
// seats them; don't drop them into a live hand with no cards.
function applyBuyIn(t: Table, s: Seat, amount: number) {
  s.chips += amount;
  s.buyInTotal += amount;
  if (s.chips > 0 && (s.status === "busted" || s.status === "sitting-out")) {
    s.status = t.round === "waiting" ? "active" : "sitting-out";
  }
}

// The busted host buys themselves back in and keeps the badge.
export function hostBuyIn(t: Table, sessionId: string, amount: number): EngineResult {
  const r: EngineResult = { logs: [] };
  if (sessionId !== t.hostSessionId) throw new Error("Only the host can do that.");
  amount = Math.round(amount);
  if (amount <= 0) throw new Error("Buy-in must be positive.");
  const s = t.seats.find((x) => x.sessionId === sessionId && x.status !== "empty");
  if (!s) throw new Error("No host seat.");
  applyBuyIn(t, s, amount);
  log(r, t, `${s.nickname} bought back in for ${amount} and stays host.`);
  return r;
}

// The host hands the badge to a seated player who still has chips.
export function transferHost(t: Table, fromSessionId: string, toSeatIndex: number): EngineResult {
  const r: EngineResult = { logs: [] };
  if (fromSessionId !== t.hostSessionId) throw new Error("Only the host can do that.");
  const s = t.seats[toSeatIndex];
  if (!s || !s.sessionId || s.status === "empty" || s.status === "busted")
    throw new Error("Pick a player who's still in.");
  t.hostSessionId = s.sessionId;
  log(r, t, `${s.nickname} is now the host.`);
  return r;
}

// At hand end, anyone out of chips drops off the table (status "busted") and
// spectates until the host offers a buy-in they accept. Keeps their seat record
// so they stay addressable and still show in the end-of-game recap.
function bustOutBrokePlayers(t: Table, r: EngineResult) {
  for (const s of t.seats) {
    if (s.status === "empty" || s.status === "busted" || !s.sessionId) continue;
    if (s.chips > 0) continue;
    s.status = "busted";
    s.holeCards = null;
    log(r, t, `${s.nickname} is out of chips — spectating until they buy back in.`);
  }
}

// Hand the host badge to a viable seated player when the current host has left
// the table. Returns the new host's nickname, or null if the host still holds a
// seat (even busted — they get the buy-in/transfer prompt) or nobody can take over.
export function reassignHostIfNeeded(t: Table): string | null {
  const cur = t.seats.find((s) => s.sessionId === t.hostSessionId);
  // A busted host keeps the badge and is prompted (socket layer) to buy back in
  // or hand off. Only auto-reassign once the host has truly left the table.
  if (cur && cur.status !== "empty") return null;
  const next = t.seats.find(
    (s) => s.sessionId !== "" && s.status !== "empty" && s.status !== "busted"
  );
  if (!next) return null;
  t.hostSessionId = next.sessionId;
  return next.nickname;
}

// Host toggles/edits the 7-2 rule live. amount <= 0 turns it off. A change made
// mid-hand is held in pendingSevenDeuce and applied at the next startHand, so it
// never alters the hand already in progress.
export function setSevenDeuce(t: Table, amount: number): EngineResult {
  const r: EngineResult = { logs: [] };
  const v = Math.max(0, Math.round(amount));
  const label = v > 0 ? `7-2 rule set to ${v} chips` : "7-2 rule turned off";
  if (t.round === "waiting") {
    t.sevenDeuce = v;
    log(r, t, `${label}.`);
  } else {
    t.pendingSevenDeuce = v;
    log(r, t, `${label} — applies next hand.`);
  }
  return r;
}

// Host changes the min bet/raise floor live. Takes effect from the next street
// (or hand); we don't lower the current street's ratcheted minRaise mid-round.
export function setMinRaise(t: Table, amount: number): EngineResult {
  const r: EngineResult = { logs: [] };
  const v = Math.round(amount);
  if (!Number.isInteger(v) || v <= 0) throw new Error("Min raise must be a whole number above 0.");
  t.minRaiseDefault = v;
  if (t.round === "waiting") t.minRaise = v;
  log(r, t, `Min raise set to ${v} chips.`);
  return r;
}

function summarize(t: Table, awards: PotAward[]): string {
  const total: Record<number, number> = {};
  for (const a of awards)
    for (const w of a.winners)
      total[w] = (total[w] ?? 0) + Math.floor(a.amount / a.winners.length);
  const parts = Object.entries(total).map(
    ([i, amt]) => `${t.seats[+i].nickname} won ${amt}`
  );
  return `Hand #${t.handNumber} — ${parts.join(", ") || "no winner"}`;
}

function endHand(
  t: Table,
  r: EngineResult,
  summary: string,
  winnerSeats: number[] = []
) {
  const potThisHand = t.pot; // read before zeroing — drives biggestPot
  // ----- session stats -----
  const st = t.sessionStats;
  st.handsPlayed++;
  if (!st.biggestPot || potThisHand > st.biggestPot.amount) {
    st.biggestPot = { amount: potThisHand, handNumber: t.handNumber };
  }
  for (const s of t.seats) {
    if (s.status === "empty" || !s.sessionId) continue;
    const stat = ensureStat(t, s.sessionId, s.nickname);
    if (s.status === "folded") stat.foldCount++;
  }
  for (const w of new Set(winnerSeats)) {
    const s = t.seats[w];
    if (s && s.sessionId) ensureStat(t, s.sessionId, s.nickname).handsWon++;
  }
  // ----- 7-2 rule: a winner holding offsuit 7-2 collects from everyone else -----
  applySevenDeuce(t, r, winnerSeats);
  // ----- settle any folded-player side wagers for this hand -----
  settleCheekyBets(t, r);

  t.pot = 0;
  t.currentActorIndex = -1;
  t.turnDeadline = null;
  t.round = "waiting"; // donations allowed in the gap before the next hand
  bustOutBrokePlayers(t, r);
  const newHost = reassignHostIfNeeded(t); // host busted out → keep the game runnable
  if (newHost) log(r, t, `${newHost} is now the host.`);
  log(r, t, summary);
  const entry = t.handHistory.find((h) => h.handNumber === t.handNumber);
  if (entry) entry.summary = summary;
}

// ---------- session stats ----------

function ensureStat(t: Table, sessionId: string, nickname: string): SeatStats {
  let stat = t.sessionStats.perSeat[sessionId];
  if (!stat) {
    stat = { nickname, handsWon: 0, foldCount: 0, cheekyBetsWon: 0 };
    t.sessionStats.perSeat[sessionId] = stat;
  }
  stat.nickname = nickname; // keep latest nickname
  return stat;
}

// Compile the end-of-night recap (build prompt §15). Pure read of current state.
export function buildRecap(t: Table): SessionRecapPayload {
  const standings: RecapStanding[] = t.seats
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status !== "empty" && s.sessionId)
    .map(({ s, i }) => {
      const stat = t.sessionStats.perSeat[s.sessionId];
      return {
        seatIndex: i,
        sessionId: s.sessionId,
        nickname: s.nickname,
        chips: s.chips,
        buyIn: s.buyInTotal,
        netChips: s.chips - s.buyInTotal,
        handsWon: stat?.handsWon ?? 0,
        foldCount: stat?.foldCount ?? 0,
        cheekyBetsWon: stat?.cheekyBetsWon ?? 0,
      };
    })
    .sort((a, b) => b.chips - a.chips);
  return {
    handsPlayed: t.sessionStats.handsPlayed,
    biggestPot: t.sessionStats.biggestPot,
    durationMs: Date.now() - t.createdAt,
    standings,
  };
}

// Host-triggered (or auto when one funded seat remains) end of the session.
export function endGame(t: Table): { result: EngineResult; recap: SessionRecapPayload } {
  const r: EngineResult = { logs: [] };
  log(r, t, "Host ended the game — that's a wrap.");
  return { result: r, recap: buildRecap(t) };
}

// ---------- history controls ----------

export function rollbackHand(t: Table, targetHandNumber: number): EngineResult {
  const r: EngineResult = { logs: [] };
  const snap = t.handHistory.find((h) => h.handNumber === targetHandNumber);
  if (!snap) throw new Error("That hand is no longer in history.");
  const restored = structuredClone(snap.state);
  const keptHistory = t.handHistory.filter((h) => h.handNumber < targetHandNumber);
  Object.assign(t, restored);
  t.handHistory = keptHistory;
  t.actionHistory = [];
  t.handNumber = targetHandNumber - 1; // next start_hand replays this hand
  log(r, t, `Host rolled back to before Hand #${targetHandNumber}.`);
  return r;
}

export function undoLastAction(t: Table): EngineResult {
  const r: EngineResult = { logs: [] };
  const prev = t.actionHistory.pop();
  if (!prev) throw new Error("Nothing to undo this hand.");
  // Whatever log lines exist now but not in the restored state are exactly the
  // action(s) being reverted — surface them so the host sees what changed.
  const reverted = t.handLog.slice(prev.handLog.length).join(" ").trim();
  Object.assign(t, prev); // prev lacks handHistory/actionHistory, so those survive
  log(r, t, reverted ? `Host undid: ${reverted}` : "Host undid the last action.");
  return r;
}

// Swap the contents of two seats (move a player, or trade two players). Only
// between hands — mid-hand it would scramble bets, the button and turn order.
export function swapSeats(t: Table, a: number, b: number): EngineResult {
  const r: EngineResult = { logs: [] };
  if (t.round !== "waiting")
    throw new Error("You can only rearrange seats between hands.");
  if (a === b || a < 0 || b < 0 || a >= t.seats.length || b >= t.seats.length)
    throw new Error("Pick two different seats.");
  const before = `${t.seats[a].nickname || "Empty"}`;
  const after = `${t.seats[b].nickname || "Empty"}`;
  [t.seats[a], t.seats[b]] = [t.seats[b], t.seats[a]];
  log(r, t, `Host rearranged seats ${a + 1} (${after}) ↔ ${b + 1} (${before}).`);
  return r;
}

// A player flips their own hand face-up for the whole table, between hands
// (full-deal only). Cards still sit on the seat until the next startHand clears
// them, so this just marks them public; buildSnapshot then sends them to all.
export function revealHand(t: Table, seatIndex: number): EngineResult {
  const r: EngineResult = { logs: [] };
  if (t.mode !== "full-deal") throw new Error("No dealt cards to reveal.");
  if (t.round !== "waiting") throw new Error("You can only reveal between hands.");
  const s = t.seats[seatIndex];
  if (!s || !s.holeCards) throw new Error("You have no hand to reveal.");
  if (s.revealed) return r; // already shown — no-op
  s.revealed = true;
  log(r, t, `${s.nickname} revealed their hand.`);
  return r;
}

// ---------- donate / tip ----------

export function donateChips(
  t: Table,
  fromSeatIndex: number,
  opts: { toSeatIndex?: number; toTipJar?: boolean; amount: number }
): EngineResult {
  const r: EngineResult = { logs: [] };
  const from = t.seats[fromSeatIndex];
  if (!from || !occupied(from)) throw new Error("Only seated players can send chips.");
  if (opts.amount <= 0) throw new Error("Amount must be positive.");
  if (opts.amount > from.chips) throw new Error("You don't have that many chips.");

  from.chips -= opts.amount;
  if (opts.toTipJar) {
    t.tipJar += opts.amount;
    log(r, t, `${from.nickname} tipped ${opts.amount} to the dealer.`);
  } else if (opts.toSeatIndex !== undefined && t.seats[opts.toSeatIndex]) {
    const to = t.seats[opts.toSeatIndex];
    to.chips += opts.amount;
    log(r, t, `${from.nickname} tipped ${opts.amount} to ${to.nickname}.`);
  } else {
    from.chips += opts.amount; // refund on bad target
    throw new Error("Pick a valid recipient.");
  }
  return r;
}

// ---------- cheeky bets (full-deal only, build prompt §11) ----------

const foldedNow = (s: Seat | undefined) => !!s && s.status === "folded";

export function requestCheekyBet(
  t: Table,
  bettorSeatIndex: number,
  p: RequestCheekyBetPayload
): CheekyBet {
  if (t.mode !== "full-deal")
    throw new Error("Cheeky bets need online-dealt cards.");
  const bettor = t.seats[bettorSeatIndex];
  const opp = t.seats[p.opponentSeatIndex];
  if (!foldedNow(bettor)) throw new Error("Only folded players can make a cheeky bet.");
  if (!foldedNow(opp)) throw new Error("That player isn't folded.");
  if (bettorSeatIndex === p.opponentSeatIndex) throw new Error("Pick someone else.");
  if (p.prediction !== "mine-better" && p.prediction !== "theirs-better")
    throw new Error("Bad prediction.");
  if (!Number.isFinite(p.amount) || p.amount <= 0)
    throw new Error("Amount must be positive.");
  if (p.amount > bettor.chips) throw new Error("You don't have that many chips.");
  if (p.amount > opp.chips) throw new Error("They can't cover that wager.");
  const dupe = t.cheekyBets.some(
    (b) =>
      b.handNumber === t.handNumber &&
      b.status === "pending" &&
      ((b.bettorSeatIndex === bettorSeatIndex &&
        b.opponentSeatIndex === p.opponentSeatIndex) ||
        (b.bettorSeatIndex === p.opponentSeatIndex &&
          b.opponentSeatIndex === bettorSeatIndex))
  );
  if (dupe) throw new Error("There's already a pending bet with them.");
  const bet: CheekyBet = {
    id: randomUUID(),
    handNumber: t.handNumber,
    bettorSeatIndex,
    opponentSeatIndex: p.opponentSeatIndex,
    bettorPrediction: p.prediction,
    amount: p.amount,
    status: "pending",
  };
  t.cheekyBets.push(bet);
  return bet;
}

export function respondCheekyBet(
  t: Table,
  betId: string,
  accept: boolean,
  responderSeatIndex?: number
): { result: EngineResult; settlements: CheekySettlement[] } {
  const r: EngineResult = { logs: [] };
  const bet = t.cheekyBets.find((b) => b.id === betId);
  if (!bet) throw new Error("That bet is gone.");
  if (bet.status !== "pending") throw new Error("Already responded.");
  if (responderSeatIndex !== undefined && bet.opponentSeatIndex !== responderSeatIndex)
    throw new Error("Not your bet to answer.");
  const bettor = t.seats[bet.bettorSeatIndex];
  const opp = t.seats[bet.opponentSeatIndex];
  if (!accept) {
    bet.status = "declined";
    log(r, t, `${opp.nickname} declined ${bettor.nickname}'s cheeky bet.`);
    return { result: r, settlements: [] };
  }
  if (bet.amount > bettor.chips || bet.amount > opp.chips)
    throw new Error("Someone can no longer cover the wager.");
  // Lock both stakes in escrow now so neither side can back out.
  bettor.chips -= bet.amount;
  opp.chips -= bet.amount;
  bet.status = "accepted";
  log(r, t, `${opp.nickname} accepted ${bettor.nickname}'s ${bet.amount}-chip cheeky bet.`);
  // If the hand already finished, settle right away; otherwise settlement
  // happens automatically at this hand's showdown (endHand → settleCheekyBets).
  const settlements = t.round === "waiting" ? settleCheekyBets(t, r) : [];
  return { result: r, settlements };
}

// Build a full 5-card board: real community + (if short) cards privately dealt
// from a deck excluding every known hole + community card. ponytail: this board
// is local to settlement — it never touches t.communityCards and is never
// broadcast, so it can't affect the real pot or what any player sees.
function completeBoard(t: Table): Card[] {
  const key = (c: Card) => c.rank + c.suit;
  if (t.communityCards.length >= 5) return t.communityCards.slice(0, 5);
  const used = new Set<string>(t.communityCards.map(key));
  for (const s of t.seats) if (s.holeCards) for (const c of s.holeCards) used.add(key(c));
  const board = [...t.communityCards];
  for (const c of shuffledDeck()) {
    if (board.length >= 5) break;
    if (!used.has(key(c))) {
      board.push(c);
      used.add(key(c));
    }
  }
  return board;
}

function settleCheekyBets(t: Table, r: EngineResult): CheekySettlement[] {
  if (t.mode !== "full-deal") return [];
  const accepted = t.cheekyBets.filter((b) => b.status === "accepted");
  if (!accepted.length) return [];
  const board = completeBoard(t);
  const out: CheekySettlement[] = [];
  for (const bet of accepted) {
    const bettor = t.seats[bet.bettorSeatIndex];
    const opp = t.seats[bet.opponentSeatIndex];
    const a = bet.amount;
    let result: NonNullable<CheekyBet["result"]>;
    if (!bettor.holeCards || !opp.holeCards) {
      result = "push"; // can't evaluate — refund both
    } else {
      const be = evaluateSeat(bet.bettorSeatIndex, bettor.holeCards, board);
      const oe = evaluateSeat(bet.opponentSeatIndex, opp.holeCards, board);
      const winners = determineWinners([be, oe]);
      const tie = winners.length !== 1;
      const bettorHandBetter = !tie && winners[0] === bet.bettorSeatIndex;
      if (tie) result = "push";
      else {
        const reality = bettorHandBetter ? "mine-better" : "theirs-better";
        result = reality === bet.bettorPrediction ? "bettor-won" : "opponent-won";
      }
    }
    let bettorDelta: number;
    let opponentDelta: number;
    if (result === "push") {
      bettor.chips += a;
      opp.chips += a; // refund both stakes
      bettorDelta = 0;
      opponentDelta = 0;
    } else if (result === "bettor-won") {
      bettor.chips += 2 * a; // own stake back + opponent's
      bettorDelta = a;
      opponentDelta = -a;
      ensureStat(t, bettor.sessionId, bettor.nickname).cheekyBetsWon++;
    } else {
      opp.chips += 2 * a;
      bettorDelta = -a;
      opponentDelta = a;
      ensureStat(t, opp.sessionId, opp.nickname).cheekyBetsWon++;
    }
    bet.result = result;
    bet.status = "settled";
    const message =
      result === "push"
        ? `Cheeky bet ${bettor.nickname} vs ${opp.nickname}: push — stakes returned.`
        : result === "bettor-won"
        ? `${bettor.nickname}'s cheeky bet vs ${opp.nickname}: ${bettor.nickname} wins ${a} chips.`
        : `${bettor.nickname}'s cheeky bet vs ${opp.nickname}: ${opp.nickname} wins ${a} chips.`;
    log(r, t, message);
    out.push({
      betId: bet.id,
      bettorSessionId: bettor.sessionId,
      opponentSessionId: opp.sessionId,
      bettorNickname: bettor.nickname,
      opponentNickname: opp.nickname,
      amount: a,
      bettorDelta,
      opponentDelta,
      result,
      message,
    });
  }
  r.cheeky = [...(r.cheeky ?? []), ...out];
  return out;
}

// ---------- card peek requests (full-deal only, build prompt §12) ----------

export function requestCardPeek(
  t: Table,
  requesterSeatIndex: number,
  targetSeatIndex: number
): CardPeekRequest {
  if (t.mode !== "full-deal") throw new Error("Peeks need online-dealt cards.");
  const req = t.seats[requesterSeatIndex];
  const tgt = t.seats[targetSeatIndex];
  if (!foldedNow(req)) throw new Error("Only folded players can peek.");
  if (!foldedNow(tgt)) throw new Error("You can only peek at a folded player.");
  if (requesterSeatIndex === targetSeatIndex) throw new Error("That's your own hand.");
  const dupe = t.cardPeekRequests.some(
    (p) =>
      p.status === "pending" &&
      p.handNumber === t.handNumber &&
      p.requesterSeatIndex === requesterSeatIndex &&
      p.targetSeatIndex === targetSeatIndex
  );
  if (dupe) throw new Error("You already asked to see their hand.");
  const peek: CardPeekRequest = {
    id: randomUUID(),
    handNumber: t.handNumber,
    requesterSeatIndex,
    targetSeatIndex,
    status: "pending",
  };
  t.cardPeekRequests.push(peek);
  return peek;
}

export function respondCardPeek(
  t: Table,
  requestId: string,
  accept: boolean,
  responderSeatIndex?: number
): {
  result: EngineResult;
  reveal?: {
    requesterSeatIndex: number;
    targetSeatIndex: number;
    nickname: string;
    holeCards: Card[];
  };
} {
  const r: EngineResult = { logs: [] };
  const peek = t.cardPeekRequests.find((p) => p.id === requestId);
  if (!peek) throw new Error("That request is gone.");
  if (peek.status !== "pending") throw new Error("Already responded.");
  if (responderSeatIndex !== undefined && peek.targetSeatIndex !== responderSeatIndex)
    throw new Error("Not your hand to show.");
  const tgt = t.seats[peek.targetSeatIndex];
  const requester = t.seats[peek.requesterSeatIndex];
  if (!accept) {
    peek.status = "declined";
    log(r, t, `${tgt.nickname} kept their folded hand hidden.`);
    return { result: r };
  }
  peek.status = "accepted";
  // The cards themselves go only to the requester's socket — never the log.
  log(r, t, `${tgt.nickname} showed their folded hand to ${requester.nickname}.`);
  return {
    result: r,
    reveal: {
      requesterSeatIndex: peek.requesterSeatIndex,
      targetSeatIndex: peek.targetSeatIndex,
      nickname: tgt.nickname,
      holeCards: tgt.holeCards ?? [],
    },
  };
}
