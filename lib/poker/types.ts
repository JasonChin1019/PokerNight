// Core data model for PokerNight. The same Table shape backs both game modes;
// only the card / evaluation layer differs (see lib/poker/table.ts).

export type Suit = "hearts" | "diamonds" | "clubs" | "spades";
export type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A";

export type Card = { rank: Rank; suit: Suit };

export type GameMode = "chips-only" | "full-deal";

export type SeatStatus =
  | "active"
  | "folded"
  | "all-in"
  | "sitting-out"
  | "busted" // out of chips: off the table, spectating until a host buy-in is accepted
  | "empty";

export type Round =
  | "waiting"
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown";

export type Seat = {
  socketId: string | null; // null while disconnected
  sessionId: string;
  nickname: string;
  chips: number;
  holeCards: [Card, Card] | null; // always null in chips-only mode
  revealed: boolean; // player voluntarily showed their hand between hands (full-deal)
  status: SeatStatus;
  currentBet: number; // chips put in on the current street; resets each street
  committed: number; // total chips put in across the whole hand; powers side pots
  buyInTotal: number; // lifetime chips bought in (initial + host gives - takes); drives recap up/down
  hasActed: boolean;
};

export type Spectator = {
  socketId: string;
  sessionId: string;
  nickname: string;
};

// A player who joined mid-game: spectates until the next hand drains them
// into an open seat (see rooms.drainQueue). New players can't sit mid-hand.
export type QueueEntry = {
  sessionId: string;
  nickname: string;
  socketId: string;
  preferredSeat?: number; // seat they picked while waiting; falls back to first open
};

export type SidePot = { amount: number; eligibleSeatIndexes: number[] };

export type HandSnapshot = {
  handNumber: number;
  timestamp: number;
  summary: string; // e.g. "Hand #4 — Jason won 340"
  state: Omit<Table, "handHistory" | "actionHistory">; // deep clone
};

// ----- new-feature records (full-deal mode only) -----

export type CheekyPrediction = "mine-better" | "theirs-better";

export type CheekyBet = {
  id: string;
  handNumber: number;
  bettorSeatIndex: number;
  opponentSeatIndex: number;
  bettorPrediction: CheekyPrediction;
  amount: number;
  status: "pending" | "accepted" | "declined" | "settled";
  result?: "bettor-won" | "opponent-won" | "push";
};

export type CardPeekRequest = {
  id: string;
  handNumber: number;
  requesterSeatIndex: number;
  targetSeatIndex: number;
  status: "pending" | "accepted" | "declined";
};

export type SeatStats = {
  nickname: string;
  handsWon: number;
  foldCount: number;
  cheekyBetsWon: number;
};

export type SessionStats = {
  handsPlayed: number;
  biggestPot: { amount: number; handNumber: number } | null;
  perSeat: Record<string, SeatStats>; // keyed by sessionId
};

export type Table = {
  roomCode: string;
  hostSessionId: string;
  mode: GameMode;
  maxSeats: number; // 2–9, set at creation, default 6
  seats: Seat[];
  spectators: Spectator[];
  queue: QueueEntry[]; // joined mid-game; seated at next hand (FIFO)
  deck: Card[]; // unused in chips-only mode
  communityCards: Card[]; // unused in chips-only mode
  pot: number;
  tipJar: number;
  dealerIndex: number;
  sbIndex: number;
  bbIndex: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  sevenDeuce: number; // 7-2 rule: chips each other player pays a winner holding offsuit 7-2. 0 = off
  pendingSevenDeuce: number | null; // rule change made mid-hand, applied at the next startHand
  round: Round;
  currentActorIndex: number;
  minRaise: number;
  turnMs: number; // per-turn time limit; 0 = no timer
  turnDeadline: number | null;
  handNumber: number;
  handLog: string[];
  handHistory: HandSnapshot[]; // capped at last 25 hands
  actionHistory: Table[]; // resets every new hand; powers single-step undo
  // new-feature state
  cheekyBets: CheekyBet[]; // reset each hand; full-deal only
  cardPeekRequests: CardPeekRequest[]; // reset each hand; full-deal only
  pendingBuyIns: Record<string, number>; // sessionId → chips the host offered, awaiting accept/decline
  sessionStats: SessionStats;
  createdAt: number; // for recap "time at the table"
};

// ----- player actions -----

export type ActionType =
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "all-in";

export type PlayerActionPayload = {
  type: ActionType;
  amount?: number;
};

// ----- sanitized client-facing view (server computes per recipient) -----

export type PublicSeat = {
  seatIndex: number;
  occupied: boolean;
  nickname: string;
  chips: number;
  status: SeatStatus;
  currentBet: number;
  holeCards: Card[] | null; // null unless revealed to this viewer
  revealed: boolean; // this seat voluntarily showed its hand (drives the flip animation)
  connected: boolean;
  isYou: boolean;
  isHost: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  isActor: boolean;
};

// A cheeky bet as shown to a viewer: the opponent's prediction is withheld
// until the bet is accepted (so a pending target can't read the wager's lean).
export type PublicCheekyBet = {
  id: string;
  bettorSeatIndex: number;
  opponentSeatIndex: number;
  amount: number;
  status: CheekyBet["status"];
  result?: CheekyBet["result"];
  bettorPrediction: CheekyPrediction | null;
  iAmBettor: boolean;
};

export type RoomSnapshot = {
  roomCode: string;
  mode: GameMode;
  maxSeats: number;
  round: Round;
  pot: number;
  sidePots: SidePot[];
  tipJar: number;
  communityCards: Card[]; // [] in chips-only mode
  dealerIndex: number;
  currentActorIndex: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  sevenDeuce: number; // 7-2 rule payout per player; 0 = off
  minRaise: number;
  handNumber: number;
  turnSeconds: number; // configured per-turn limit in seconds; 0 = no timer
  turnDeadline: number | null;
  seats: PublicSeat[];
  spectatorCount: number;
  queue: string[]; // nicknames waiting to be dealt in, in order
  youAreHost: boolean;
  youAreSpectator: boolean;
  youAreQueued: boolean; // spectating but waiting for a seat next hand
  yourQueuedSeat: number | null; // seat you picked while queued, if any
  yourSeatIndex: number | null;
  log: string[];
  // new-feature, viewer-scoped (full-deal only; absent/empty otherwise)
  cheekyBets: PublicCheekyBet[]; // only bets involving the viewer
  incomingPeekRequests: { id: string; fromSeatIndex: number }[]; // viewer is target
  // host-only extras
  handHistory?: { handNumber: number; summary: string; timestamp: number }[];
  canUndo?: boolean;
  // chips the host has offered the viewer as a buy-in, awaiting their accept/decline
  yourBuyInOffer: number | null;
  youAreBusted: boolean; // viewer is out of chips, spectating until they buy back in
};

// ----- socket event payloads (shared by client + server) -----

export type CreateRoomPayload = {
  nickname: string;
  sessionId: string;
  mode: GameMode;
  maxSeats: number;
  buyIn: number;
  smallBlind: number;
  bigBlind: number;
  turnSeconds?: number; // per-turn time limit; 0 or undefined handled by server default
  sevenDeuce?: number; // 7-2 rule payout per player; 0/undefined = off
};

export type JoinRoomPayload = {
  roomCode: string;
  nickname: string;
  sessionId: string;
  role: "player" | "spectator";
};

export type HandResultPayload = {
  winners: number[];
  revealedHands: {
    seatIndex: number;
    nickname: string;
    holeCards: Card[];
    bestCards: Card[]; // the 5 cards forming this hand
    handName: string;
    handDescr: string;
  }[];
  potsAwarded: { winners: number[]; amount: number }[];
  summary: string;
  handCategory?: string; // pokersolver hand name or host tag → win-animation tier
};

// ----- new-feature socket payloads -----

export type RequestCheekyBetPayload = {
  opponentSeatIndex: number;
  prediction: CheekyPrediction;
  amount: number;
};
export type RespondCheekyBetPayload = { betId: string; accept: boolean };
export type RequestCardPeekPayload = { targetSeatIndex: number };
export type RespondCardPeekPayload = { requestId: string; accept: boolean };

export type CheekyBetRequestPayload = {
  betId: string;
  fromNickname: string;
  prediction: CheekyPrediction;
  amount: number;
};
export type CheekyBetSettledPayload = {
  betId: string;
  result: NonNullable<CheekyBet["result"]>;
  youWon: boolean;
  delta: number; // chips gained (+) or lost (−) for the recipient
  amount: number; // the wager size
  youNickname: string; // recipient's own name
  themNickname: string; // the other party's name
  message: string;
};
export type SevenDeucePayload = { winners: string[]; perPlayer: number };
export type CardPeekRequestEventPayload = { requestId: string; fromNickname: string };
export type CardPeekResultPayload = {
  targetSeatIndex: number;
  nickname: string;
  holeCards: Card[];
};

export type RecapStanding = {
  seatIndex: number;
  sessionId: string;
  nickname: string;
  chips: number;
  buyIn: number; // total bought in over the session
  netChips: number;
  handsWon: number;
  foldCount: number;
  cheekyBetsWon: number;
};
export type SessionRecapPayload = {
  handsPlayed: number;
  biggestPot: { amount: number; handNumber: number } | null;
  durationMs: number;
  standings: RecapStanding[]; // sorted highest chips first
};

// An empty seat used to pad the seats array up to maxSeats.
export function emptySeat(): Seat {
  return {
    socketId: null,
    sessionId: "",
    nickname: "",
    chips: 0,
    holeCards: null,
    revealed: false,
    status: "empty",
    currentBet: 0,
    committed: 0,
    buyInTotal: 0,
    hasActed: false,
  };
}
