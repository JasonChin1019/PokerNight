"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSocket, getSessionId, getNickname, setNickname } from "@/lib/client/socket";
import NumField from "@/components/NumField";

export default function CreatePage() {
  const router = useRouter();
  const [nickname, setNick] = useState("");
  useEffect(() => setNick(getNickname()), []);
  const [maxSeats, setMaxSeats] = useState(6);
  const [seatDir, setSeatDir] = useState(1); // 1 = went up, -1 = went down; picks pop direction
  const [buyIn, setBuyIn] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [minRaise, setMinRaise] = useState(20); // min bet/raise floor; can be < SB
  const [turnSeconds, setTurnSeconds] = useState(30); // 0 = no timer
  const [realCards, setRealCards] = useState(false);
  const [ruleOn, setRuleOn] = useState(false); // 7-2 rule toggle
  const [ruleAmount, setRuleAmount] = useState(50);
  const sevenDeuce = ruleOn ? ruleAmount : 0;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function submit() {
    if (!nickname.trim()) return setErr("Pick a nickname first.");
    for (const [v, label] of [
      [buyIn, "Buy-in"],
      [smallBlind, "Small blind"],
      [bigBlind, "Big blind"],
      [minRaise, "Min raise"],
    ] as const) {
      if (!Number.isInteger(v) || v <= 0)
        return setErr(`${label} must be a whole number above 0.`);
    }
    if (bigBlind < smallBlind)
      return setErr("Big blind can't be smaller than the small blind.");
    if (turnSeconds !== 0 && (turnSeconds < 5 || turnSeconds > 300))
      return setErr("Turn timer must be between 5 and 300 seconds, or Off.");
    setBusy(true);
    setErr("");
    setNickname(nickname.trim());
    const socket = getSocket();
    socket.emit(
      "create_room",
      {
        nickname: nickname.trim(),
        sessionId: getSessionId(),
        mode: realCards ? "chips-only" : "full-deal",
        maxSeats,
        buyIn,
        smallBlind,
        bigBlind,
        minRaise,
        turnSeconds,
        sevenDeuce,
      },
      (r: { ok: boolean; roomCode?: string; message?: string }) => {
        if (r.ok && r.roomCode) router.push(`/room/${r.roomCode}`);
        else {
          setErr(r.message || "Couldn't create the game.");
          setBusy(false);
        }
      }
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-6 pb-8 pt-12">
      <header className="flex items-center gap-3.5 pb-3">
        <Link
          href="/"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-lg text-cream"
        >
          ‹
        </Link>
        <h1 className="font-display text-2xl font-bold">New game</h1>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto py-2">
        <Field label="YOUR NICKNAME">
          <input
            value={nickname}
            onChange={(e) => setNick(e.target.value)}
            placeholder="e.g. Jordan"
            maxLength={16}
            className="input"
          />
        </Field>

        <Field label="MAX SEATS">
          <div className="flex h-[50px] items-center justify-between rounded-xl border border-white/10 bg-field px-2">
            <button
              onClick={() => {
                setSeatDir(-1);
                setMaxSeats((n) => Math.max(2, n - 1));
              }}
              className="h-9 w-9 rounded-lg bg-white/[0.06] text-xl text-cream"
            >
              –
            </button>
            <div className="font-display text-lg font-bold">
              <span
                key={maxSeats}
                className="inline-block"
                style={{ animation: `${seatDir < 0 ? "pn-pop-down" : "pn-pop-up"} .25s ease` }}
              >
                {maxSeats}
              </span>{" "}
              <span className="text-[13px] font-medium text-muted">players</span>
            </div>
            <button
              onClick={() => {
                setSeatDir(1);
                setMaxSeats((n) => Math.min(9, n + 1));
              }}
              className="h-9 w-9 rounded-lg bg-amber/[0.16] text-xl text-amber"
            >
              +
            </button>
          </div>
        </Field>

        <Field label="BUY-IN CHIPS">
          <NumField
            value={buyIn}
            onChange={setBuyIn}
            min={1}
            className="input font-display font-bold text-amber"
          />
        </Field>

        <Field label="BLINDS (SMALL / BIG)">
          <div className="flex gap-3">
            <NumField
              value={smallBlind}
              onChange={setSmallBlind}
              min={1}
              className="input font-display font-bold"
            />
            <NumField
              value={bigBlind}
              onChange={setBigBlind}
              min={1}
              className="input font-display font-bold"
            />
          </div>
        </Field>

        <Field label="MIN RAISE / MIN BET">
          <NumField
            value={minRaise}
            onChange={setMinRaise}
            min={1}
            className="input font-display font-bold"
          />
          <p className="mt-1.5 text-[12px] leading-snug text-muted">
            Smallest bet or raise allowed. Can be set below the small blind for
            tiny post-flop bets. Defaults to the big blind.
          </p>
        </Field>

        <Field label="TURN TIMER">
          <div className="flex gap-2">
            {[
              [0, "Off"],
              [30, "30s"],
              [60, "60s"],
            ].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setTurnSeconds(v as number)}
                className={`h-11 flex-1 rounded-xl font-display text-sm font-bold ${
                  turnSeconds === v
                    ? "border-[1.5px] border-amber bg-amber/[0.14] text-amber"
                    : "border border-white/12 bg-white/[0.04] text-cream-2"
                }`}
              >
                {label}
              </button>
            ))}
            <NumField
              value={turnSeconds}
              onChange={setTurnSeconds}
              min={0}
              max={300}
              placeholder="Custom"
              className={`h-11 w-[88px] rounded-xl border bg-field px-2 text-center font-display text-sm font-bold outline-none focus:border-amber/50 ${
                [0, 30, 60].includes(turnSeconds)
                  ? "border-white/12 text-cream-2"
                  : "border-amber text-amber"
              }`}
            />
          </div>
        </Field>

        <button
          onClick={() => setRealCards((v) => !v)}
          className={`flex items-start gap-3 rounded-2xl border p-4 text-left ${
            realCards
              ? "border-amber/35 bg-amber/10"
              : "border-white/[0.08] bg-white/[0.03]"
          }`}
        >
          <span
            className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-lg border-2 text-[15px] font-extrabold text-amber-ink ${
              realCards ? "border-amber bg-amber" : "border-white/30"
            }`}
          >
            {realCards ? "✓" : ""}
          </span>
          <span>
            <span className="block font-bold">We&apos;re using real physical cards</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted">
              The app will just track chips and betting — no cards dealt.
            </span>
          </span>
        </button>

        <div
          className={`rounded-2xl border p-4 text-[13.5px] leading-relaxed transition-all ${
            realCards
              ? "border-green/20 bg-green/[0.06] text-green-soft"
              : "border-white/[0.08] bg-white/[0.02] text-muted-4"
          }`}
        >
          {realCards
            ? "♣ Card settings hidden — you'll deal a real deck. The app tracks chips, blinds & the pot only."
            : "◆ Online dealing — the app shuffles, deals, evaluates hands and runs the showdown for you. 20s turn timer."}
        </div>

        <Field label="CUSTOM RULES">
            <div
              className={`rounded-2xl border p-4 ${
                ruleOn ? "border-amber/35 bg-amber/10" : "border-white/[0.08] bg-white/[0.03]"
              }`}
            >
              <button
                onClick={() => setRuleOn((v) => !v)}
                className="flex w-full items-start gap-3 text-left"
              >
                <span
                  className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-lg border-2 text-[15px] font-extrabold text-amber-ink ${
                    ruleOn ? "border-amber bg-amber" : "border-white/30"
                  }`}
                >
                  {ruleOn ? "✓" : ""}
                </span>
                <span>
                  <span className="block font-bold">7-2 rule</span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                    Win a hand holding an offsuit 7 and 2 and every other player pays you the amount below.
                  </span>
                </span>
              </button>
              {ruleOn && (
                <div className="mt-4">
                  <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted">
                    CHIPS FROM EACH PLAYER
                  </div>
                  <NumField
                    value={ruleAmount}
                    onChange={setRuleAmount}
                    min={1}
                    className="input font-display font-bold text-amber"
                  />
                </div>
              )}
            </div>
          </Field>

        {err && <p className="text-sm text-clay-soft">{err}</p>}
      </div>

      <button
        onClick={submit}
        disabled={busy}
        className="mt-3 h-14 rounded-2xl bg-amber font-display text-lg font-bold text-amber-ink shadow-[0_8px_22px_rgba(224,162,59,.26)] disabled:opacity-60"
      >
        {busy ? "Creating…" : "Create & open lobby"}
      </button>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted">
        {label}
      </div>
      {children}
    </div>
  );
}
