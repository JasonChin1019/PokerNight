declare module "pokersolver" {
  export class Hand {
    name: string; // e.g. "Two Pair"
    descr: string; // e.g. "Two Pair, K's & 8's"
    rank: number;
    cards: unknown[];
    static solve(cards: string[]): Hand;
    // Returns the winning hand(s) from the list (ties return multiple).
    static winners(hands: Hand[]): Hand[];
  }
}
