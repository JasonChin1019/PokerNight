"use client";

import { useEffect, useMemo } from "react";
import type { Card as TCard } from "@/lib/poker/types";
import { type AnimationTier, TIER_DURATION_MS } from "@/lib/poker/animation";
import { SUIT_SYMBOL, isRed } from "./Card";

const BADGE: Record<AnimationTier, string | null> = {
  bluff: "BLUFF CAUGHT",
  small: "Pair!",
  medium: "TWO PAIR",
  monster: "MONSTER HAND",
  neutral: null,
};

// A short, non-blocking themed moment layered over the showdown (build prompt
// §14). Plays once, then calls onComplete; gameplay is never gated on it.
export function WinAnimation({
  tier,
  cards,
  onComplete,
}: {
  tier: AnimationTier;
  cards?: TCard[];
  onComplete: () => void;
}) {
  useEffect(() => {
    const id = setTimeout(onComplete, TIER_DURATION_MS[tier]);
    return () => clearTimeout(id);
  }, [tier, onComplete]);

  // Confetti pieces (monster only) — fixed per mount so they don't reshuffle.
  const confetti = useMemo(
    () =>
      Array.from({ length: 18 }, () => ({
        left: `${Math.random() * 100}%`,
        bg: ["#e0a23b", "#6db86d", "#d4654f", "#f1ede4"][
          Math.floor(Math.random() * 4)
        ],
        size: 6 + Math.random() * 6,
        delay: `${Math.random() * 0.6}s`,
        dur: `${1.6 + Math.random() * 1.1}s`,
      })),
    []
  );

  if (tier === "neutral") return null;
  const badge = BADGE[tier];
  const spinCards = (cards ?? []).slice(0, tier === "medium" ? 4 : 2);

  return (
    <div
      className="animate-pn-zip-out pointer-events-none absolute inset-x-0 top-[120px] z-[42] flex flex-col items-center"
      style={{ animationDuration: `${TIER_DURATION_MS[tier]}ms` }}
    >
      {tier === "monster" && (
        <>
          <div className="absolute inset-x-0 -top-40 bottom-[-200px] overflow-hidden">
            {confetti.map((c, i) => (
              <div
                key={i}
                className="absolute top-0 rounded-[2px] animate-pn-confetti"
                style={{
                  left: c.left,
                  width: c.size,
                  height: c.size * 1.6,
                  background: c.bg,
                  animationDelay: c.delay,
                  animationDuration: c.dur,
                  animationIterationCount: "infinite",
                  animationTimingFunction: "linear",
                }}
              />
            ))}
          </div>
          <div className="flex h-[74px] w-[74px] animate-pn-glow items-center justify-center rounded-full bg-amber/[0.15] text-[34px]">
            ♠
          </div>
        </>
      )}

      {(tier === "small" || tier === "medium") && (
        <div className="flex gap-2" style={{ perspective: 600 }}>
          {(spinCards.length ? spinCards : [null, null]).map((c, i) => (
            <div
              key={i}
              className="flex h-[62px] w-11 animate-pn-flip flex-col items-center justify-center rounded-md bg-card-face shadow-[0_8px_18px_rgba(0,0,0,.45),0_0_18px_rgba(224,162,59,.35)]"
              style={{ animationDelay: `${i * 0.12}s` }}
            >
              {c ? (
                <>
                  <span
                    className={`font-display text-[22px] font-bold ${
                      isRed(c.suit) ? "text-card-red" : "text-card-ink"
                    }`}
                  >
                    {c.rank}
                  </span>
                  <span
                    className={`text-[18px] ${
                      isRed(c.suit) ? "text-card-red" : "text-card-ink"
                    }`}
                  >
                    {SUIT_SYMBOL[c.suit]}
                  </span>
                </>
              ) : (
                <span className="text-[22px] text-amber-deep">♠</span>
              )}
            </div>
          ))}
        </div>
      )}

      {tier === "bluff" && (
        <div className="animate-pn-bounce text-[52px]">😂</div>
      )}

      {badge && (
        <div className="mt-3.5 rounded-full border border-amber/40 bg-black/55 px-[18px] py-1.5 font-display text-base font-extrabold tracking-wide text-amber">
          {badge}
        </div>
      )}
      {tier === "bluff" && (
        <div className="mt-1.5 text-[13px] text-cream-2">Fell for the bluff</div>
      )}
    </div>
  );
}
