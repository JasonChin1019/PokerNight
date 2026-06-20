import type { Card } from "./types";
import { freshDeck, cardToSolver } from "./deck";
import { Hand } from "pokersolver";
import { randomInt } from "crypto";

type Contender = { seatIndex: number; hole: [Card, Card] };

/**
 * Monte Carlo win-% per still-in seat. Deals the unseen cards out `iters` times,
 * evaluates each runout with pokersolver, tallies wins (ties count fractionally).
 * Spectator-only feature, so accuracy over speed is fine; 2000 iters is plenty.
 */
export function estimateEquity(
  contenders: Contender[],
  community: Card[],
  iters = 2000
): Record<number, number> {
  const result: Record<number, number> = {};
  for (const c of contenders) result[c.seatIndex] = 0;
  if (contenders.length === 0) return result;
  if (contenders.length === 1) {
    result[contenders[0].seatIndex] = 100;
    return result;
  }

  const seen = new Set<string>();
  for (const c of contenders) for (const card of c.hole) seen.add(key(card));
  for (const card of community) seen.add(key(card));
  const stub = freshDeck().filter((card) => !seen.has(key(card)));
  const need = 5 - community.length;

  for (let i = 0; i < iters; i++) {
    const drawn = sample(stub, need);
    const board = [...community, ...drawn].map(cardToSolver);
    const hands = contenders.map((c) =>
      Hand.solve([...c.hole.map(cardToSolver), ...board])
    );
    const winners = Hand.winners(hands);
    const share = 1 / winners.length;
    contenders.forEach((c, idx) => {
      if (winners.includes(hands[idx])) result[c.seatIndex] += share;
    });
  }

  for (const c of contenders) {
    result[c.seatIndex] = Math.round((result[c.seatIndex] / iters) * 100);
  }
  return result;
}

const key = (c: Card) => `${c.rank}${c.suit}`;

// Draw `n` distinct cards from the stub without mutating it (partial shuffle).
function sample(stub: Card[], n: number): Card[] {
  const a = stub.slice();
  for (let i = 0; i < n; i++) {
    const j = i + randomInt(a.length - i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
