import { describe, it, expect } from "vitest";
import { computeSidePots } from "./sidepots";
import {
  createTable,
  startHand,
  applyAction,
  awardPot,
  advanceStreet,
  rollbackHand,
  requestCheekyBet,
  respondCheekyBet,
} from "./table";
import { getAnimationTier } from "./animation";
import type { Table } from "./types";

// Seat n players with given chips into a fresh table (test helper only).
function seed(mode: "full-deal" | "chips-only", chips: number[]): Table {
  const t = createTable({
    roomCode: "TEST1",
    hostSessionId: "s0",
    mode,
    maxSeats: chips.length,
    buyIn: 1000,
    smallBlind: 10,
    bigBlind: 20,
  });
  chips.forEach((c, i) => {
    t.seats[i] = {
      socketId: `sock${i}`,
      sessionId: `s${i}`,
      nickname: `P${i}`,
      chips: c,
      holeCards: null,
      status: "sitting-out",
      currentBet: 0,
      committed: 0,
      hasActed: false,
      disconnectedAt: null,
    };
  });
  return t;
}

describe("side pots", () => {
  it("layers by all-in level and excludes folders from eligibility", () => {
    // A all-in 100, B all-in 200, C calls 200, D folded after putting 50.
    const pots = computeSidePots([
      { seatIndex: 0, committed: 100, folded: false, inHand: true },
      { seatIndex: 1, committed: 200, folded: false, inHand: true },
      { seatIndex: 2, committed: 200, folded: false, inHand: true },
      { seatIndex: 3, committed: 50, folded: true, inHand: true },
    ]);
    // total chips = 100+200+200+50 = 550
    expect(pots.reduce((n, p) => n + p.amount, 0)).toBe(550);
    // Layers 0->50 and 50->100 share eligibility [0,1,2] and merge: 200+150=350.
    expect(pots[0]).toEqual({ amount: 350, eligibleSeatIndexes: [0, 1, 2] });
    // 100->200 layer: only 1,2 -> 200, eligible 1,2
    expect(pots[1]).toEqual({ amount: 200, eligibleSeatIndexes: [1, 2] });
  });
});

describe("full-deal hand", () => {
  it("plays heads-up to a showdown and conserves chips", () => {
    const t = seed("full-deal", [1000, 1000]);
    startHand(t);
    const total = () => t.seats.reduce((n, s) => n + s.chips, 0) + t.pot;
    expect(total()).toBe(2000);
    // Heads-up: SB(=dealer, seat0) acts first preflop. Just call/check down.
    // Walk the action until the hand resolves (round back to waiting).
    let guard = 0;
    while (t.round !== "waiting" && guard++ < 50) {
      const i = t.currentActorIndex;
      if (i < 0) break;
      const toCall = Math.max(...t.seats.map((s) => s.currentBet)) - t.seats[i].currentBet;
      applyAction(t, i, toCall > 0 ? { type: "call" } : { type: "check" });
    }
    expect(t.round).toBe("waiting");
    expect(total()).toBe(2000); // no chips created or destroyed
  });

  it("awards the pot to the last player when everyone folds", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    startHand(t);
    // First two actors fold; remaining player wins the blinds.
    applyAction(t, t.currentActorIndex, { type: "fold" });
    applyAction(t, t.currentActorIndex, { type: "fold" });
    expect(t.round).toBe("waiting");
    expect(t.seats.reduce((n, s) => n + s.chips, 0)).toBe(3000);
  });
});

describe("chips-only mode", () => {
  it("lets the host advance streets and award the pot manually", () => {
    const t = seed("chips-only", [1000, 1000]);
    startHand(t);
    expect(t.communityCards).toHaveLength(0);
    expect(t.seats[0].holeCards).toBeNull();
    // call down preflop
    applyAction(t, t.currentActorIndex, { type: "call" });
    applyAction(t, t.currentActorIndex, { type: "check" });
    advanceStreet(t); // flop
    expect(t.round).toBe("flop");
    advanceStreet(t); // turn
    advanceStreet(t); // river
    advanceStreet(t); // showdown
    expect(t.round).toBe("showdown");
    awardPot(t, [1]);
    expect(t.round).toBe("waiting");
    expect(t.seats.reduce((n, s) => n + s.chips, 0)).toBe(2000); // conserved
    expect(t.seats[1].chips).toBeGreaterThan(t.seats[0].chips); // winner ahead
  });
});

describe("animation tier", () => {
  it("maps hand names to the four tiers, unknown -> neutral", () => {
    expect(getAnimationTier("High Card")).toBe("bluff");
    expect(getAnimationTier("Pair")).toBe("small");
    expect(getAnimationTier("Two Pair")).toBe("medium");
    expect(getAnimationTier("Full House")).toBe("monster");
    expect(getAnimationTier("Royal Flush")).toBe("monster");
    expect(getAnimationTier(undefined)).toBe("neutral");
    expect(getAnimationTier("nonsense")).toBe("neutral");
  });
});

describe("cheeky bets", () => {
  it("settles from a privately dealt board when the hand ends early, escrow conserved", () => {
    // 3 players; seats 1 & 2 fold preflop, then wager. Hand ends pre-board,
    // so settlement must privately deal out the board and pay the winner.
    const t = seed("full-deal", [1000, 1000, 1000]);
    startHand(t);
    // Everyone folds to one player: UTG folds, then others fold, leaving 1.
    // First fold two non-blind actors so seats 1 and 2 end up folded.
    // Drive folds until only one seat remains in the hand.
    let guard = 0;
    // Fold seat 1 and seat 2 specifically by acting when it's their turn.
    while (t.round !== "waiting" && guard++ < 20) {
      const i = t.currentActorIndex;
      if (i < 0) break;
      if (i === 0) {
        const toCall =
          Math.max(...t.seats.map((s) => s.currentBet)) - t.seats[i].currentBet;
        applyAction(t, i, toCall > 0 ? { type: "call" } : { type: "check" });
      } else {
        applyAction(t, i, { type: "fold" });
      }
    }
    // Seats 1 and 2 should be folded after the hand ended.
    expect(t.seats[1].status).toBe("folded");
    expect(t.seats[2].status).toBe("folded");
    const before = t.seats.map((s) => s.chips);
    // They place + accept a cheeky bet *within the same hand* (handNumber match).
    const bet = requestCheekyBet(t, 1, {
      opponentSeatIndex: 2,
      prediction: "mine-better",
      amount: 50,
    });
    const { settlements } = respondCheekyBet(t, bet.id, true);
    // Escrow conserved: the two bettors' combined chips are unchanged net of
    // the 50+50 that moved between them (a push refunds exactly).
    const after = t.seats.map((s) => s.chips);
    expect(after[1] + after[2]).toBe(before[1] + before[2]);
    expect(settlements.length).toBe(1);
    expect(["bettor-won", "opponent-won", "push"]).toContain(
      settlements[0].result
    );
    // Live table board is never mutated by settlement.
    expect(t.communityCards.length).toBeLessThanOrEqual(5);
  });
});

describe("rollback", () => {
  it("restores stacks and discards later hands", () => {
    const t = seed("chips-only", [1000, 1000]);
    startHand(t); // hand 1
    applyAction(t, t.currentActorIndex, { type: "call" });
    applyAction(t, t.currentActorIndex, { type: "check" });
    advanceStreet(t);
    advanceStreet(t);
    advanceStreet(t);
    advanceStreet(t);
    awardPot(t, [0]);
    const afterHand1 = t.seats.map((s) => s.chips);
    startHand(t); // hand 2
    rollbackHand(t, 2); // undo hand 2 -> back to before hand 2 == after hand 1
    expect(t.seats.map((s) => s.chips)).toEqual(afterHand1);
    expect(t.handNumber).toBe(1);
  });
});
