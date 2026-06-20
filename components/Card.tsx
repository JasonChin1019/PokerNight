import type { Card as TCard, Suit } from "@/lib/poker/types";

const SUIT_SYMBOL: Record<Suit, string> = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
};

const isRed = (s: Suit) => s === "hearts" || s === "diamonds";

export function PlayingCard({
  card,
  className = "h-[58px] w-[42px] text-xl",
  faded = false,
}: {
  card: TCard;
  className?: string;
  faded?: boolean;
}) {
  const color = isRed(card.suit) ? "text-card-red" : "text-card-ink";
  return (
    <div
      className={`flex animate-pn-pop flex-col items-center justify-center rounded-md bg-card-face leading-none shadow-[0_5px_12px_rgba(0,0,0,.4)] ${
        faded ? "opacity-75" : ""
      } ${className}`}
    >
      <span className={`font-display font-bold ${color}`}>{card.rank}</span>
      <span className={`text-[0.7em] ${color}`}>{SUIT_SYMBOL[card.suit]}</span>
    </div>
  );
}

// Felt-green card back, for opponents' face-down hole cards / undealt board.
export function CardBack({
  className = "h-[58px] w-[42px]",
}: {
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center rounded-md border border-amber/40 bg-felt-card shadow-[0_4px_10px_rgba(0,0,0,.35)] ${className}`}
    >
      <div className="h-3.5 w-3.5 rotate-45 border border-amber/45 bg-amber/20" />
    </div>
  );
}
