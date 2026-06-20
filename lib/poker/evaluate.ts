import { Hand } from "pokersolver";
import type { Card } from "./types";
import { cardToSolver, solverToCard } from "./deck";

export type EvaluatedHand = {
  seatIndex: number;
  name: string; // "Two Pair"
  descr: string; // "Two Pair, K's & 8's"
  bestCards: Card[]; // the 5 cards that make the hand
  hand: Hand; // raw pokersolver hand for tie comparison
};

// Evaluate best 5-of-7 for a single seat given its 2 hole cards + 5 community.
export function evaluateSeat(
  seatIndex: number,
  holeCards: [Card, Card],
  community: Card[]
): EvaluatedHand {
  const cardStrings = [...holeCards, ...community].map(cardToSolver);
  const hand = Hand.solve(cardStrings);
  const bestCards = hand.cards.map((c) => solverToCard(String(c)));
  return { seatIndex, name: hand.name, descr: hand.descr, bestCards, hand };
}

// Given the contenders for a (side) pot, return the seat indexes that win it.
// Ties return multiple seat indexes; the caller handles odd-chip distribution.
export function determineWinners(
  contenders: EvaluatedHand[]
): number[] {
  if (contenders.length === 0) return [];
  if (contenders.length === 1) return [contenders[0].seatIndex];
  const winningHands = Hand.winners(contenders.map((c) => c.hand));
  const winners: number[] = [];
  for (const c of contenders) {
    if (winningHands.includes(c.hand)) winners.push(c.seatIndex);
  }
  return winners;
}
