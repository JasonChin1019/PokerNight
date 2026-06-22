import { describe, it, expect } from "vitest";
import { computeSidePots } from "./sidepots";
import {
  createTable,
  startHand,
  applyAction,
  awardPot,
  advanceStreet,
  rollbackHand,
  reassignHostIfNeeded,
  hostBuyIn,
  transferHost,
  setSevenDeuce,
  setMinRaise,
  requestCheekyBet,
  respondCheekyBet,
  offerBuyIn,
  respondBuyIn,
  buildRecap,
  potBreakdown,
  revealHand,
} from "./table";
import { buildSnapshot } from "./rooms";
import { getAnimationTier } from "./animation";
import { enqueuePlayer, drainQueue, seatBySession } from "./rooms";
import { emptySeat, type Table } from "./types";

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
      revealed: false,
      status: "sitting-out",
      currentBet: 0,
      committed: 0,
      buyInTotal: c,
      hasActed: false,
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

  it("reveals a folded hand to the whole table between hands", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    startHand(t);
    // seat 0 (the requester) folds, hand plays out, we're now between hands.
    applyAction(t, t.currentActorIndex, { type: "fold" });
    applyAction(t, t.currentActorIndex, { type: "fold" });
    expect(t.round).toBe("waiting");
    // A folded player's own cards are hidden until they choose to reveal.
    const folded = t.seats.findIndex((s) => s.status === "folded");
    expect(buildSnapshot(t, `s${folded}`).seats[folded].holeCards).toBeNull();
    revealHand(t, folded);
    // Now everyone — even an unrelated viewer — sees those cards face-up.
    const seen = buildSnapshot(t, "s1").seats[folded];
    expect(seen.revealed).toBe(true);
    expect(seen.holeCards).toHaveLength(2);
    // A fresh hand clears the reveal flag again.
    startHand(t);
    expect(t.seats[folded].revealed).toBe(false);
  });
});

describe("7-2 rule", () => {
  it("pays an offsuit-7-2 winner from every other player", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    t.sevenDeuce = 25;
    startHand(t);
    // Everyone holds offsuit 7-2, so whoever wins triggers the rule.
    t.seats.forEach((s) => {
      s.holeCards = [
        { rank: "7", suit: "spades" },
        { rank: "2", suit: "hearts" },
      ];
    });
    // 3-handed: the dealer is UTG and acts first, having posted no blind.
    const utg = t.currentActorIndex;
    applyAction(t, t.currentActorIndex, { type: "fold" });
    applyAction(t, t.currentActorIndex, { type: "fold" });
    expect(t.round).toBe("waiting");
    expect(t.seats.reduce((n, s) => n + s.chips, 0)).toBe(3000); // conserved
    expect(t.seats[utg].chips).toBe(975); // folded with no blind, paid 25 to winner
  });

  it("does nothing when the winner isn't holding 7-2", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    t.sevenDeuce = 25;
    startHand(t);
    // No one holds 7-2, so the rule never fires.
    t.seats.forEach((s) => {
      s.holeCards = [
        { rank: "A", suit: "spades" },
        { rank: "K", suit: "spades" },
      ];
    });
    const utg = t.currentActorIndex;
    applyAction(t, t.currentActorIndex, { type: "fold" });
    applyAction(t, t.currentActorIndex, { type: "fold" });
    // utg folded preflop with no blind and no 7-2 win anywhere → untouched.
    expect(t.seats[utg].chips).toBe(1000);
  });
});

describe("live pot breakdown", () => {
  it("splits into a main pot and a side pot once a player is all-in", () => {
    const t = seed("full-deal", [50, 1000, 1000]);
    // P0 all-in for 50; P1 and P2 keep betting to 200 each.
    t.seats[0].committed = 50;
    t.seats[0].status = "all-in";
    t.seats[1].committed = 200;
    t.seats[1].status = "active";
    t.seats[2].committed = 200;
    t.seats[2].status = "active";
    t.pot = 450;
    const pots = potBreakdown(t);
    expect(pots).toEqual([
      { amount: 150, eligibleSeatIndexes: [0, 1, 2] }, // main: 50×3
      { amount: 300, eligibleSeatIndexes: [1, 2] }, // side: 150×2
    ]);
  });

  it("is empty between hands", () => {
    const t = seed("full-deal", [1000, 1000]);
    expect(potBreakdown(t)).toEqual([]); // pot is 0
  });

  it("does not split on uneven bets when nobody is all-in", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    // Blinds posted / an uncalled bet — uneven commitments, but no all-in.
    t.seats[0].committed = 10;
    t.seats[0].status = "active";
    t.seats[1].committed = 200;
    t.seats[1].status = "active";
    t.seats[2].committed = 0;
    t.pot = 210;
    expect(potBreakdown(t)).toEqual([]);
  });
});

describe("buy-ins and host chip control", () => {
  it("tracks buy-ins so the recap shows true up/down", () => {
    const t = seed("full-deal", [1000, 1000]);
    t.seats[0].chips = 0; // P0 busted out
    // P0 takes a 1000 rebuy via the host's buy-in offer.
    offerBuyIn(t, 0, 1000);
    respondBuyIn(t, "s0", true);
    expect(t.seats[0].chips).toBe(1000);
    expect(t.seats[0].buyInTotal).toBe(2000); // initial + rebuy
    // P1 won 500 off P0 over the night (simulate by moving chips).
    t.seats[1].chips = 1500;
    const recap = buildRecap(t);
    const p0 = recap.standings.find((s) => s.sessionId === "s0")!;
    const p1 = recap.standings.find((s) => s.sessionId === "s1")!;
    expect(p0.buyIn).toBe(2000);
    expect(p0.netChips).toBe(1000 - 2000); // down 1000
    expect(p1.netChips).toBe(1500 - 1000); // up 500
  });

  it("offers a buy-in the player must accept", () => {
    const t = seed("full-deal", [1000, 1000]);
    t.seats[0].chips = 0;
    offerBuyIn(t, 0, 750);
    expect(t.pendingBuyIns["s0"]).toBe(750);
    // declined: nothing changes
    respondBuyIn(t, "s0", false);
    expect(t.seats[0].chips).toBe(0);
    expect(t.pendingBuyIns["s0"]).toBeUndefined();
    // offered again and accepted
    offerBuyIn(t, 0, 750);
    respondBuyIn(t, "s0", true);
    expect(t.seats[0].chips).toBe(750);
    expect(t.seats[0].buyInTotal).toBe(1750);
  });

  it("doesn't drop a mid-hand buy-in into the live hand", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    t.seats[0].chips = 0; // P0 is broke and won't be dealt
    startHand(t); // P0 sits out this hand (no cards)
    expect(t.seats[0].status).toBe("sitting-out");
    offerBuyIn(t, 0, 1000);
    respondBuyIn(t, "s0", true);
    // Bought in, but must NOT be active/holding cards in the current hand.
    expect(t.seats[0].chips).toBe(1000);
    expect(t.seats[0].status).toBe("sitting-out");
    expect(t.seats[0].holeCards).toBeNull();
    // Finish the hand, then they're dealt in next hand.
    while (t.round !== "waiting") {
      const i = t.currentActorIndex;
      if (i < 0) break;
      const toCall = Math.max(...t.seats.map((s) => s.currentBet)) - t.seats[i].currentBet;
      applyAction(t, i, toCall > 0 ? { type: "call" } : { type: "check" });
    }
    startHand(t);
    expect(t.seats[0].status).not.toBe("sitting-out");
    expect(t.seats[0].holeCards).not.toBeNull();
  });

  it("busts broke players to spectator and only an accepted buy-in revives them", () => {
    const t = seed("chips-only", [100, 100, 100]);
    t.sevenDeuce = 100;
    // P1 wins with 7-2; P0 and P2 each pay 100 → both hit 0 chips.
    t.round = "showdown";
    t.pot = 0;
    t.seats.forEach((s) => (s.status = "active"));
    awardPot(t, [1], undefined, true); // ends the hand → busts the broke ones
    expect(t.seats[0].status).toBe("busted");
    expect(t.seats[2].status).toBe("busted");
    expect(t.seats[1].status).not.toBe("busted");
    // Busted players still show in the recap (so they see how far down they are).
    expect(buildRecap(t).standings.some((s) => s.sessionId === "s0")).toBe(true);
    // A declined offer leaves them busted.
    offerBuyIn(t, 0, 100);
    respondBuyIn(t, "s0", false);
    expect(t.seats[0].status).toBe("busted");
    // Accepted between hands → back in, active and dealt next hand.
    offerBuyIn(t, 0, 100);
    respondBuyIn(t, "s0", true);
    expect(t.seats[0].chips).toBe(100);
    expect(t.seats[0].status).toBe("active");
  });
});

describe("host transfer", () => {
  it("keeps a busted host (they get prompted), auto-reassigns only once they leave", () => {
    const t = seed("chips-only", [1000, 1000]);
    expect(reassignHostIfNeeded(t)).toBeNull(); // host fine → unchanged
    expect(t.hostSessionId).toBe("s0");

    t.seats[0].status = "busted"; // host out of chips → keeps badge, gets the prompt
    expect(reassignHostIfNeeded(t)).toBeNull();
    expect(t.hostSessionId).toBe("s0");

    t.seats[0].status = "empty"; // host actually left the table → hand off
    expect(reassignHostIfNeeded(t)).toBe("P1");
    expect(t.hostSessionId).toBe("s1");
  });

  it("host buys back in and stays host", () => {
    const t = seed("chips-only", [1000, 1000]);
    t.seats[0].chips = 0;
    t.seats[0].status = "busted";
    hostBuyIn(t, "s0", 500);
    expect(t.seats[0].chips).toBe(500);
    expect(t.seats[0].status).toBe("active"); // round is "waiting"
    expect(t.hostSessionId).toBe("s0");
  });

  it("transfers host only to a seated player with chips", () => {
    const t = seed("chips-only", [1000, 1000]);
    t.seats[0].status = "busted";
    transferHost(t, "s0", 1);
    expect(t.hostSessionId).toBe("s1");
    // a non-host can't transfer; can't hand off to a busted/empty seat
    expect(() => transferHost(t, "s0", 0)).toThrow();
  });
});

describe("7-2 rule changes", () => {
  it("defers a mid-hand change to the next hand, applies it immediately between hands", () => {
    const t = seed("chips-only", [1000, 1000]);
    startHand(t); // round is now preflop — a hand is live
    setSevenDeuce(t, 100);
    expect(t.sevenDeuce).toBe(0); // current hand untouched
    expect(t.pendingSevenDeuce).toBe(100);

    t.round = "waiting"; // hand ends
    startHand(t); // next hand picks up the pending change
    expect(t.sevenDeuce).toBe(100);
    expect(t.pendingSevenDeuce).toBeNull();

    // between hands the change is live right away
    t.round = "waiting";
    setSevenDeuce(t, 0);
    expect(t.sevenDeuce).toBe(0);
    expect(t.pendingSevenDeuce).toBeNull();
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

  it("applies the host-declared 7-2 rule on award and announces it", () => {
    const t = seed("chips-only", [980, 980, 980]);
    t.sevenDeuce = 100;
    // Hand at showdown: each put 20 in, pot 60.
    t.round = "showdown";
    t.pot = 60;
    t.seats.forEach((s) => {
      s.committed = 20;
      s.status = "active";
    });
    const r = awardPot(t, [1], undefined, true);
    expect(r.sevenDeuce).toEqual({ winners: ["P1"], perPlayer: 100 });
    expect(t.seats[1].chips).toBe(1240); // 980 + 60 pot + 200 (7-2)
    expect(t.seats[0].chips).toBe(880); // paid 100
    expect(t.seats[2].chips).toBe(880); // paid 100
    expect(t.seats.reduce((n, s) => n + s.chips, 0)).toBe(3000); // conserved
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

describe("creation validation", () => {
  const base = {
    roomCode: "T",
    hostSessionId: "s0",
    mode: "full-deal" as const,
    maxSeats: 2,
    buyIn: 1000,
    smallBlind: 10,
    bigBlind: 20,
  };
  it("rejects a big blind below the small blind", () => {
    expect(() => createTable({ ...base, smallBlind: 50, bigBlind: 20 })).toThrow(/big blind/i);
  });
  it("rejects non-positive or non-integer money", () => {
    expect(() => createTable({ ...base, buyIn: 0 })).toThrow();
    expect(() => createTable({ ...base, smallBlind: -5 })).toThrow();
    expect(() => createTable({ ...base, bigBlind: 2.5 })).toThrow();
  });
  it("defaults the min raise to the big blind", () => {
    expect(createTable(base).minRaiseDefault).toBe(20);
  });
  it("honours a custom min raise below the small blind", () => {
    const t = createTable({ ...base, minRaise: 5 });
    expect(t.minRaiseDefault).toBe(5);
    expect(t.minRaise).toBe(5);
  });
});

describe("configurable min raise / min bet", () => {
  it("setMinRaise changes the floor live between hands", () => {
    const t = seed("full-deal", [1000, 1000]);
    setMinRaise(t, 5);
    expect(t.minRaiseDefault).toBe(5);
    expect(t.minRaise).toBe(5);
    expect(() => setMinRaise(t, 0)).toThrow();
  });

  it("allows a post-flop bet below the small blind once configured", () => {
    const t = seed("full-deal", [1000, 1000]); // SB 10 / BB 20
    setMinRaise(t, 5); // floor set below the small blind
    startHand(t);
    // call/check down to the flop
    let guard = 0;
    while (t.round === "preflop" && guard++ < 10) {
      const i = t.currentActorIndex;
      const toCall = Math.max(...t.seats.map((s) => s.currentBet)) - t.seats[i].currentBet;
      applyAction(t, i, toCall > 0 ? { type: "call" } : { type: "check" });
    }
    expect(t.round).toBe("flop");
    const actor = t.currentActorIndex;
    // Below the floor still rejected; a bet at the floor (5 < SB 10) is allowed.
    expect(() => applyAction(t, actor, { type: "bet", amount: 4 })).toThrow(/Minimum bet/);
    applyAction(t, actor, { type: "bet", amount: 5 });
    expect(t.seats[actor].currentBet).toBe(5);
  });
});

describe("card visibility", () => {
  it("shows a player their own cards even after they fold", () => {
    const t = seed("full-deal", [1000, 1000, 1000]);
    startHand(t);
    const folder = t.currentActorIndex;
    applyAction(t, folder, { type: "fold" });
    // Hand continues (2 left); the folder still sees their own hole cards.
    expect(t.round).not.toBe("waiting");
    expect(buildSnapshot(t, `s${folder}`).seats[folder].holeCards).toHaveLength(2);
  });

  it("reveals cheeky counterparties' cards to each other at showdown", () => {
    const t = seed("full-deal", [1000, 1000]);
    t.round = "showdown";
    t.seats[0].status = "active";
    t.seats[1].status = "folded";
    t.seats[0].holeCards = [
      { rank: "A", suit: "spades" },
      { rank: "K", suit: "spades" },
    ];
    t.seats[1].holeCards = [
      { rank: "7", suit: "hearts" },
      { rank: "2", suit: "clubs" },
    ];
    t.cheekyBets.push({
      id: "c1",
      handNumber: t.handNumber,
      bettorSeatIndex: 0,
      opponentSeatIndex: 1,
      bettorPrediction: "mine-better",
      amount: 50,
      status: "accepted",
    });
    // Seat 0 sees the folded opponent's cards because they share a cheeky bet.
    expect(buildSnapshot(t, "s0").seats[1].holeCards).toHaveLength(2);
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

describe("join queue", () => {
  it("seats queued players FIFO into open chairs at the next hand", () => {
    const t = seed("full-deal", [1000, 1000]); // 2 seats, both taken
    t.maxSeats = 3;
    t.seats.push(emptySeat()); // one open chair
    enqueuePlayer(t, "qa", "QueuedA", "sockA");
    enqueuePlayer(t, "qb", "QueuedB", "sockB");
    drainQueue(t); // only one seat free -> A sits, B still waits
    expect(seatBySession(t, "qa")).toBe(2);
    expect(seatBySession(t, "qb")).toBe(-1);
    expect(t.queue.map((q) => q.sessionId)).toEqual(["qb"]);
  });
});
