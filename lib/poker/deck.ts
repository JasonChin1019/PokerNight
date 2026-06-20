import { randomInt } from "crypto";
import type { Card, Rank, Suit } from "./types";

export const SUITS: Suit[] = ["hearts", "diamonds", "clubs", "spades"];
export const RANKS: Rank[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Cryptographically secure Fisher–Yates. We deliberately use crypto.randomInt,
// never Math.random — this deck decides real (virtual) money outcomes between
// friends and must be unbiased and unpredictable.
export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); // 0..i inclusive
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function shuffledDeck(): Card[] {
  return shuffle(freshDeck());
}

// ----- pokersolver interop -----
// pokersolver expects strings like "Ah", "Td", "9c". Note: 10 -> "T".
const SUIT_CHAR: Record<Suit, string> = {
  hearts: "h",
  diamonds: "d",
  clubs: "c",
  spades: "s",
};

export function cardToSolver(card: Card): string {
  const rank = card.rank === "10" ? "T" : card.rank;
  return `${rank}${SUIT_CHAR[card.suit]}`;
}

// Reverse: parse a pokersolver card string ("Ks", "Th") back to our Card.
const CHAR_SUIT: Record<string, Suit> = {
  h: "hearts",
  d: "diamonds",
  c: "clubs",
  s: "spades",
};
export function solverToCard(s: string): Card {
  const suit = CHAR_SUIT[s.slice(-1).toLowerCase()];
  const r = s.slice(0, -1);
  // pokersolver renders the wheel-straight (A-2-3-4-5) ace as "1" — keep it "A".
  return { rank: (r === "T" ? "10" : r === "1" ? "A" : r) as Rank, suit };
}
