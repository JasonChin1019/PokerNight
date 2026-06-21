import Link from "next/link";

export default function Landing() {
  return (
    <main className="relative mx-auto flex min-h-screen max-w-md flex-col overflow-hidden px-7 pb-12 pt-14">
      {/* subtle card/chip motif — never casino neon */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-8 -top-10 font-display text-[230px] text-amber/[0.04]">
          ♠
        </div>
        <div className="absolute bottom-32 -right-8 text-[180px] text-white/[0.025]">
          ♦
        </div>
        <div className="absolute right-[-40px] top-32 h-32 w-32 rounded-full border-[18px] border-amber/[0.06]" />
        <div className="absolute bottom-60 left-[-26px] h-20 w-20 rounded-full border-[13px] border-green/[0.05]" />
      </div>

      <div className="relative flex flex-1 flex-col justify-center gap-5">
        <div className="flex items-center">
          <div className="flex h-20 w-14 -rotate-[9deg] flex-col justify-between rounded-lg bg-card-face p-2 shadow-2xl">
            <span className="font-display text-lg font-bold leading-none text-card-ink">A</span>
            <span className="self-end text-sm text-card-ink">♠</span>
          </div>
          <div className="flex h-20 w-14 -translate-x-3 rotate-6 flex-col justify-between rounded-lg bg-card-face p-2 shadow-2xl">
            <span className="font-display text-lg font-bold leading-none text-card-red">A</span>
            <span className="self-end text-sm text-card-red">♥</span>
          </div>
        </div>
        <div>
          <h1 className="font-display text-5xl font-extrabold leading-none tracking-tight">
            Poker<span className="text-amber">Night</span>
          </h1>
          <p className="mt-3 max-w-[280px] text-base leading-relaxed text-muted">
            Your group&apos;s virtual table. Chips or Cards, we have it both.
          </p>
        </div>
      </div>

      <div className="relative flex flex-col gap-3">
        <Link
          href="/create"
          className="flex h-[60px] items-center justify-center rounded-2xl bg-amber py-4 font-display text-lg font-bold text-amber-ink shadow-[0_8px_24px_rgba(224,162,59,.28)] transition-transform active:scale-[0.97]"
        >
          Create game
        </Link>
        <Link
          href="/join"
          className="flex h-[60px] items-center justify-center rounded-2xl border border-white/15 bg-white/[0.04] py-4 font-display text-lg font-bold text-cream transition-transform active:scale-[0.97]"
        >
          Join game
        </Link>
        <p className="mt-1.5 text-center text-xs text-muted-2">
          Pocket Rockets guaranteed if you pay the developer.
        </p>
      </div>
    </main>
  );
}
