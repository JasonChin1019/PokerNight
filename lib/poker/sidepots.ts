import type { SidePot } from "./types";

export type Contribution = {
  seatIndex: number;
  committed: number; // total chips this seat put into the pot this hand
  folded: boolean; // folded seats forfeit eligibility but their chips stay in
  inHand: boolean; // seat actually participated this hand (not empty/sitting-out)
};

/**
 * Split total contributions into pot layers by distinct all-in levels.
 *
 * Each layer caps at the next-higher contribution boundary, so a player who is
 * all-in for less only competes for the chips up to their own commitment.
 * Folded players' chips remain in the pots but they are not eligible to win.
 *
 * The returned pots are ordered main-pot-first.
 */
export function computeSidePots(contributions: Contribution[]): SidePot[] {
  const participants = contributions.filter((c) => c.inHand && c.committed > 0);
  if (participants.length === 0) return [];

  // Distinct contribution boundaries, ascending.
  const levels = Array.from(
    new Set(participants.map((c) => c.committed))
  ).sort((a, b) => a - b);

  const pots: SidePot[] = [];
  let prev = 0;

  for (const level of levels) {
    const layerSize = level - prev;
    if (layerSize <= 0) {
      prev = level;
      continue;
    }
    // Everyone who committed at least `level` contributes one layer slice.
    const contributors = participants.filter((c) => c.committed >= level);
    const amount = layerSize * contributors.length;
    // Only non-folded contributors at this layer can win it.
    const eligibleSeatIndexes = contributors
      .filter((c) => !c.folded)
      .map((c) => c.seatIndex);

    if (amount > 0) {
      // Merge into the previous pot if eligibility is identical (keeps the
      // common no-all-in case as a single main pot).
      const last = pots[pots.length - 1];
      if (last && sameSet(last.eligibleSeatIndexes, eligibleSeatIndexes)) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligibleSeatIndexes });
      }
    }
    prev = level;
  }

  return pots;
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}
