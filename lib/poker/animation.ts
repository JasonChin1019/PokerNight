// Pure mapping from a hand-rank name to a win-animation tier (build prompt §14).
// Kept UI-free so the tier logic is unit-testable on its own. The input is
// pokersolver's hand name (full-deal mode) or the host's manual tag (chips-only).
// An unknown/missing name → "neutral" (the UI shows a plain "pot awarded" moment).

export type AnimationTier = "bluff" | "small" | "medium" | "monster" | "neutral";

// pokersolver names, lowercased. Anything Three-of-a-Kind or stronger is a monster.
const MONSTER = new Set([
  "three of a kind",
  "straight",
  "flush",
  "full house",
  "four of a kind",
  "straight flush",
  "royal flush",
]);

export function getAnimationTier(handName?: string | null): AnimationTier {
  if (!handName) return "neutral";
  const n = handName.trim().toLowerCase();
  if (n === "high card") return "bluff";
  if (n === "pair" || n === "one pair") return "small";
  if (n === "two pair" || n === "two pairs") return "medium";
  if (MONSTER.has(n)) return "monster";
  return "neutral";
}

export const TIER_DURATION_MS: Record<AnimationTier, number> = {
  bluff: 1100,
  small: 1000,
  medium: 1500,
  monster: 2500,
  neutral: 600,
};
