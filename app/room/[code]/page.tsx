"use client";

import { useParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { getSocket, getSessionId, getNickname } from "@/lib/client/socket";
import { PlayingCard, CardBack } from "@/components/Card";
import { WinAnimation } from "@/components/WinAnimation";
import NumField from "@/components/NumField";
import { getAnimationTier } from "@/lib/poker/animation";
import type {
  Card,
  RoomSnapshot,
  PublicSeat,
  HandResultPayload,
  CheekyPrediction,
  CheekyBetRequestPayload,
  CheekyBetSettledPayload,
  CardPeekRequestEventPayload,
  CardPeekResultPayload,
  SessionRecapPayload,
  SevenDeucePayload,
} from "@/lib/poker/types";

const fmt = (n: number) => n.toLocaleString("en-US");

// Pre-selected action to auto-play on your turn (no waiting around).
type PreAction = "check-fold" | "call-any" | "fold" | null;

const AVATAR_COLORS = [
  "#3f8fd0",
  "#c77dba",
  "#6db86d",
  "#d4654f",
  "#5bb5b0",
  "#b08968",
  "#9a86d4",
  "#d0a13f",
  "#5f9ea0",
];
function colorFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}
// Chips each seat took from the showdown, summed across every pot they won.
function winningsBySeat(result: HandResultPayload): Record<number, number> {
  const w: Record<number, number> = {};
  for (const pot of result.potsAwarded) {
    const share = Math.floor(pot.amount / pot.winners.length);
    for (const s of pot.winners) w[s] = (w[s] ?? 0) + share;
  }
  return w;
}

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = (params.code || "").toUpperCase();

  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [result, setResult] = useState<HandResultPayload | null>(null);
  // per-seat winnings shown on the felt after a hand, cleared when the next starts
  const [winnings, setWinnings] = useState<Record<number, number>>({});
  const [equity, setEquity] = useState<Record<number, number>>({});
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now());
  const [showTip, setShowTip] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCheeky, setShowCheeky] = useState(false);
  const [cheekyIncoming, setCheekyIncoming] = useState<CheekyBetRequestPayload | null>(null);
  const [cheekySettled, setCheekySettled] = useState<CheekyBetSettledPayload | null>(null);
  const [peekTarget, setPeekTarget] = useState<number | null>(null);
  const [peekIncoming, setPeekIncoming] = useState<CardPeekRequestEventPayload | null>(null);
  const [peekReveal, setPeekReveal] = useState<CardPeekResultPayload | null>(null);
  const [recap, setRecap] = useState<SessionRecapPayload | null>(null);
  const [sevenDeuceNotice, setSevenDeuceNotice] = useState<SevenDeucePayload | null>(null);
  const [tip, setTip] = useState<{ from: string; amount: number } | null>(null);
  // per-seat action chat bubbles (fold/call/bet/raise/all-in), cleared after 2s
  const [actions, setActions] = useState<
    Record<number, { type: string; amount: number; id: number }>
  >({});
  // queued action that fires automatically the moment it becomes your turn
  const [preAction, setPreAction] = useState<PreAction>(null);
  const [showSeating, setShowSeating] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showSetChips, setShowSetChips] = useState(false);
  const [undoPopup, setUndoPopup] = useState<string | null>(null);
  const [rulePopup, setRulePopup] = useState<{ title: string; message: string } | null>(null);
  const [hostChanged, setHostChanged] = useState<string | null>(null);
  const [cheekyLocked, setCheekyLocked] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  const dealHand = useRef<number | undefined>(undefined);
  const notifiedBets = useRef<Set<string>>(new Set());

  // ---- socket wiring ----
  useEffect(() => {
    const socket = getSocket();
    const role =
      new URLSearchParams(window.location.search).get("role") === "spectator"
        ? "spectator"
        : "player";
    const join = () =>
      socket.emit("join_room", {
        roomCode: code,
        nickname: getNickname() || "Player",
        sessionId: getSessionId(),
        role,
      });

    socket.on("connect", join);
    if (socket.connected) join();

    socket.on("room_state", (s: RoomSnapshot) => {
      setSnap(s);
      if (s.round !== "waiting") {
        setResult(null); // new hand cleared the overlay
        setWinnings({}); // and the on-felt win summary
      }
    });
    socket.on("equity_update", (p: { perSeatWinPct: Record<number, number> }) =>
      setEquity(p.perSeatWinPct)
    );
    socket.on("hand_result", (r: HandResultPayload) => {
      setResult(r);
      setWinnings(winningsBySeat(r));
    });
    socket.on("error", (e: { message: string }) => {
      setToast(e.message);
      setTimeout(() => setToast(""), 3000);
    });

    socket.on("cheeky_bet_request", (p: CheekyBetRequestPayload) =>
      setCheekyIncoming(p)
    );
    socket.on("cheeky_bet_settled", (p: CheekyBetSettledPayload) => {
      setCheekySettled(p);
      setCheekyIncoming(null);
      setShowCheeky(false);
    });
    socket.on("card_peek_request", (p: CardPeekRequestEventPayload) =>
      setPeekIncoming(p)
    );
    socket.on("card_peek_result", (p: CardPeekResultPayload) => {
      setPeekReveal(p);
      setPeekTarget(null);
    });
    socket.on("session_recap", (p: SessionRecapPayload) => setRecap(p));
    socket.on("seven_deuce", (p: SevenDeucePayload) => setSevenDeuceNotice(p));
    socket.on("action_undone", (p: { message: string }) => setUndoPopup(p.message));
    socket.on("rule_changed", (p: { title: string; message: string }) => setRulePopup(p));
    socket.on("host_changed", (p: { nickname: string }) => setHostChanged(p.nickname));

    socket.on("tip_received", (p: { from: string; amount: number }) => {
      setTip(p);
      setTimeout(() => setTip(null), 4000);
    });

    socket.on(
      "player_acted",
      (p: { seatIndex: number; type: string; amount: number }) => {
        const id = Date.now() + Math.random();
        setActions((a) => ({ ...a, [p.seatIndex]: { type: p.type, amount: p.amount, id } }));
        setTimeout(() => {
          setActions((a) => {
            if (a[p.seatIndex]?.id !== id) return a; // a newer action replaced it
            const next = { ...a };
            delete next[p.seatIndex];
            return next;
          });
        }, 2000);
      }
    );

    return () => {
      socket.off("connect", join);
      socket.off("room_state");
      socket.off("equity_update");
      socket.off("hand_result");
      socket.off("error");
      socket.off("cheeky_bet_request");
      socket.off("cheeky_bet_settled");
      socket.off("card_peek_request");
      socket.off("card_peek_result");
      socket.off("session_recap");
      socket.off("seven_deuce");
      socket.off("action_undone");
      socket.off("rule_changed");
      socket.off("host_changed");
      socket.off("tip_received");
      socket.off("player_acted");
    };
  }, [code]);

  // tick for the turn countdown
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Auto-play a queued pre-action the instant it becomes your turn. These three
  // are unambiguous regardless of what opponents did, so no re-confirm needed.
  // A new hand voids any stale pre-action before it could fire (the same
  // snapshot can both open a hand and make it your turn).
  const lastHand = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!snap) return;
    if (snap.handNumber !== lastHand.current) {
      lastHand.current = snap.handNumber;
      setPreAction(null);
      return;
    }
    if (!preAction || snap.yourSeatIndex === null) return;
    const myTurn =
      snap.currentActorIndex === snap.yourSeatIndex && snap.round !== "waiting";
    if (!myTurn) return;
    const me = snap.seats[snap.yourSeatIndex];
    const toCall = Math.max(0, ...snap.seats.map((s) => s.currentBet)) - me.currentBet;
    const type =
      preAction === "fold"
        ? "fold"
        : preAction === "call-any"
        ? toCall > 0
          ? "call"
          : "check"
        : toCall > 0
        ? "fold"
        : "check"; // check-fold
    setPreAction(null);
    getSocket().emit("player_action", { type });
  }, [snap, preAction]);

  // Flash a faded "Dealing next hand…" label as each new hand begins (skips the
  // first snapshot so it doesn't fire on join/refresh mid-game).
  useEffect(() => {
    if (!snap) return;
    if (snap.handNumber === dealHand.current) return;
    const first = dealHand.current === undefined;
    dealHand.current = snap.handNumber;
    if (first || snap.round === "waiting") return;
    setDealing(true);
    const id = setTimeout(() => setDealing(false), 1100);
    return () => clearTimeout(id);
  }, [snap]);

  // Pop a notification the moment a cheeky bet you're part of locks in, naming
  // both players. Fires for both the bettor and the opponent (each sees the bet).
  useEffect(() => {
    if (!snap) return;
    for (const b of snap.cheekyBets) {
      if (b.status === "accepted" && !notifiedBets.current.has(b.id)) {
        notifiedBets.current.add(b.id);
        const bettor = snap.seats[b.bettorSeatIndex]?.nickname ?? "?";
        const opp = snap.seats[b.opponentSeatIndex]?.nickname ?? "?";
        setCheekyLocked(`${bettor} ↔ ${opp} · ${fmt(b.amount)} chips on the line`);
        setTimeout(() => setCheekyLocked(null), 4000);
      }
    }
  }, [snap]);

  const emit = (event: string, payload?: unknown) => {
    navigator.vibrate?.(10); // haptic press feedback where supported
    getSocket().emit(event, payload);
  };

  if (!snap) return <Waking />;

  const me = snap.yourSeatIndex !== null ? snap.seats[snap.yourSeatIndex] : null;
  const isLobby = snap.round === "waiting" && snap.handNumber === 0;

  const iAmFolded = me?.status === "folded";
  const someoneElseFolded = snap.seats.some(
    (s) => s.occupied && s.status === "folded" && !s.isYou
  );
  const canCheeky =
    snap.mode === "full-deal" &&
    !snap.youAreSpectator &&
    !!iAmFolded &&
    someoneElseFolded;

  const leave = () => {
    // Seated players (not busted spectators) must wait for the gap between hands.
    if (me && snap.round !== "waiting") {
      setToast("You can only leave between hands.");
      setTimeout(() => setToast(""), 3000);
      return;
    }
    emit("leave_room");
    router.push("/");
  };

  return (
    <main className="relative mx-auto flex h-[100dvh] max-w-md flex-col overflow-hidden bg-screen">
      <TopBar
        snap={snap}
        now={now}
        canCheeky={canCheeky}
        onCheeky={() => setShowCheeky(true)}
        onMenu={() => setMenuOpen((v) => !v)}
      />
      <TurnTimerBar snap={snap} now={now} />

      {isLobby ? (
        <Lobby snap={snap} onStart={() => emit("start_hand")} />
      ) : (
        <TableView
          snap={snap}
          equity={equity}
          result={result}
          winnings={winnings}
          now={now}
          actions={actions}
          canPeek={!!iAmFolded && snap.mode === "full-deal" && !snap.youAreSpectator}
          onPeek={(seatIndex) => setPeekTarget(seatIndex)}
        />
      )}

      {!isLobby && (
        <BottomArea
          snap={snap}
          now={now}
          emit={emit}
          preAction={preAction}
          setPreAction={setPreAction}
        />
      )}

      {dealing && (
        <div className="pointer-events-none absolute inset-0 z-[42] flex items-center justify-center">
          <div className="-translate-y-10 animate-pn-fade font-display text-2xl font-bold tracking-wide text-cream/35">
            Dealing next hand…
          </div>
        </div>
      )}

      {result &&
        (snap.mode === "full-deal" && result.revealedHands.length > 0 ? (
          <ShowdownReveal
            snap={snap}
            result={result}
            community={snap.communityCards}
            onContinue={() => setResult(null)}
            onStartHand={() => emit("start_hand")}
          />
        ) : (
          <ShowdownOverlay
            snap={snap}
            result={result}
            onContinue={() => setResult(null)}
            onStartHand={() => emit("start_hand")}
          />
        ))}

      {menuOpen && (
        <MoreMenu
          snap={snap}
          onClose={() => setMenuOpen(false)}
          onTip={() => {
            setMenuOpen(false);
            setShowTip(true);
          }}
          onHistory={() => {
            setMenuOpen(false);
            setShowHistory(true);
          }}
          onSeating={() => {
            setMenuOpen(false);
            setShowSeating(true);
          }}
          onRules={() => {
            setMenuOpen(false);
            setShowRules(true);
          }}
          onSetChips={() => {
            setMenuOpen(false);
            setShowSetChips(true);
          }}
          onEndGame={() => {
            setMenuOpen(false);
            emit("end_game");
          }}
          onLeave={() => {
            setMenuOpen(false);
            leave();
          }}
        />
      )}

      {showCheeky && me && (
        <CheekyBetModal
          snap={snap}
          onClose={() => setShowCheeky(false)}
          emit={emit}
        />
      )}
      {cheekyIncoming && (
        <CheekyIncomingModal
          req={cheekyIncoming}
          onClose={() => setCheekyIncoming(null)}
          emit={emit}
        />
      )}
      {cheekySettled && (
        <CheekySettledModal
          settled={cheekySettled}
          onClose={() => setCheekySettled(null)}
        />
      )}

      {peekTarget !== null && (
        <PeekRequestModal
          snap={snap}
          targetSeatIndex={peekTarget}
          onClose={() => setPeekTarget(null)}
          emit={emit}
        />
      )}
      {peekIncoming && (
        <PeekIncomingModal
          req={peekIncoming}
          onClose={() => setPeekIncoming(null)}
          emit={emit}
        />
      )}
      {peekReveal && (
        <PeekRevealModal reveal={peekReveal} onClose={() => setPeekReveal(null)} />
      )}

      {recap && <RecapOverlay recap={recap} onClose={() => setRecap(null)} onLeave={leave} />}

      {showTip && me && (
        <TipModal snap={snap} onClose={() => setShowTip(false)} emit={emit} />
      )}
      {showHistory && (
        <HistoryDrawer snap={snap} onClose={() => setShowHistory(false)} emit={emit} />
      )}
      {showSeating && (
        <SeatingModal snap={snap} onClose={() => setShowSeating(false)} emit={emit} />
      )}
      {showRules && (
        <RulesModal snap={snap} onClose={() => setShowRules(false)} emit={emit} />
      )}
      {showSetChips && (
        <SetChipsModal snap={snap} onClose={() => setShowSetChips(false)} emit={emit} />
      )}
      {snap.yourBuyInOffer !== null && (
        <BuyInOffer amount={snap.yourBuyInOffer} emit={emit} />
      )}
      {sevenDeuceNotice && (
        <SevenDeuceNotice
          notice={sevenDeuceNotice}
          onClose={() => setSevenDeuceNotice(null)}
        />
      )}
      {undoPopup && (
        <UndoPopup message={undoPopup} onClose={() => setUndoPopup(null)} />
      )}
      {rulePopup && (
        <RuleChangePopup popup={rulePopup} onClose={() => setRulePopup(null)} />
      )}
      {snap.youMustChooseHost && <HostDecisionModal snap={snap} emit={emit} />}
      {hostChanged && (
        <HostChangedPopup nickname={hostChanged} onClose={() => setHostChanged(null)} />
      )}

      {tip && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-[85] flex justify-center px-6">
          <div className="flex animate-pn-pop items-center gap-3 rounded-2xl border border-amber/40 bg-panel-2 px-4 py-3 shadow-[0_18px_44px_rgba(0,0,0,.55)]">
            <span className="text-2xl">🎁</span>
            <div>
              <div className="font-display text-sm font-bold text-cream">
                {tip.from} just sent you a tip!
              </div>
              <div className="font-display text-lg font-bold text-amber">+{fmt(tip.amount)} chips</div>
            </div>
          </div>
        </div>
      )}

      {cheekyLocked && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-[86] flex justify-center px-6">
          <div className="flex animate-pn-pop items-center gap-2 rounded-2xl border border-amber/40 bg-panel-2 px-4 py-2.5 shadow-[0_18px_44px_rgba(0,0,0,.55)]">
            <span className="text-lg text-amber">♦</span>
            <div className="font-display text-[13px] font-bold text-cream">
              Cheeky bet locked · <span className="text-amber">{cheekyLocked}</span>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute inset-x-0 top-24 z-[80] flex justify-center px-6">
          <div className="rounded-xl border border-clay/40 bg-panel px-4 py-2.5 text-sm text-clay-soft shadow-xl">
            {toast}
          </div>
        </div>
      )}
    </main>
  );
}

// ---------------- waking / loading ----------------
function Waking() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-3 w-3 animate-pn-blink rounded-full bg-amber"
            style={{ animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </div>
      <div className="font-display text-lg font-bold">Waking up the table…</div>
      <p className="max-w-xs text-sm text-muted">
        Free hosting naps after a while — the first connection can take 30–50
        seconds. Hang tight.
      </p>
    </main>
  );
}

// ---------------- top bar ----------------
function TopBar({
  snap,
  now,
  canCheeky,
  onCheeky,
  onMenu,
}: {
  snap: RoomSnapshot;
  now: number;
  canCheeky: boolean;
  onCheeky: () => void;
  onMenu: () => void;
}) {
  const secs = snap.turnDeadline
    ? Math.max(0, Math.ceil((snap.turnDeadline - now) / 1000))
    : null;
  const timerLabel =
    snap.turnSeconds === 0 ? "Off" : secs !== null ? `${secs}s` : `${snap.turnSeconds}s`;
  const urgent = secs !== null && secs <= 5;
  return (
    <div className="z-30 flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-2">
        {snap.youAreSpectator ? (
          <span className="flex items-center gap-2 rounded-full bg-live-red/[0.16] px-3 py-1.5 text-[12.5px] font-extrabold tracking-wide text-live-soft">
            <span className="h-2 w-2 animate-pn-blink rounded-full bg-live-red" />
            LIVE · SPECTATING
          </span>
        ) : (
          <span className="rounded-lg bg-white/[0.06] px-3 py-1.5 font-display text-[13px] font-bold tracking-widest text-cream-2">
            {snap.roomCode}
          </span>
        )}
        <QueueStrip queue={snap.queue} />
      </div>
      <div className="flex items-center gap-2">
        <span
          title="Turn timer"
          className={`flex h-9 items-center gap-1 rounded-xl border px-2.5 font-display text-[12.5px] font-bold ${
            urgent
              ? "animate-pn-blink border-live-red/50 bg-live-red/[0.16] text-live-soft"
              : "border-white/10 bg-black/25 text-cream-2"
          }`}
        >
          ⏱ {timerLabel}
        </span>
        {canCheeky && (
          <button
            onClick={onCheeky}
            className="flex h-9 items-center gap-1.5 rounded-xl border border-amber/50 bg-amber/[0.13] px-3 font-display text-[12.5px] font-bold text-amber"
          >
            ♦ Cheeky bet
          </button>
        )}
        <button
          onClick={onMenu}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/25 text-lg text-cream-2"
          title="More"
        >
          ⋯
        </button>
      </div>
    </div>
  );
}

// Small horizontal list of players waiting to be dealt in (joined mid-game).
// Sits next to the room code; empty queue renders nothing.
function QueueStrip({ queue }: { queue: string[] }) {
  if (queue.length === 0) return null;
  return (
    <div
      className="flex items-center gap-1 rounded-lg bg-white/[0.04] px-1.5 py-1"
      title={`Waiting to join: ${queue.join(", ")}`}
    >
      <span className="px-0.5 text-[9px] font-bold tracking-wide text-muted-2">NEXT</span>
      {queue.slice(0, 4).map((name, i) => (
        <Avatar key={i} name={name} className="h-5 w-5 rounded-md text-[9px]" />
      ))}
      {queue.length > 4 && (
        <span className="text-[10px] font-bold text-muted-2">+{queue.length - 4}</span>
      )}
    </div>
  );
}

// Full-width depleting bar pinned to the top of the screen, mirroring the
// showdown "auto in Xs" progress bar. Only shown during an active timed turn.
function TurnTimerBar({ snap, now }: { snap: RoomSnapshot; now: number }) {
  if (!snap.turnDeadline || snap.turnSeconds === 0) return null;
  const remaining = Math.max(0, snap.turnDeadline - now);
  const frac = Math.min(1, remaining / (snap.turnSeconds * 1000));
  const urgent = remaining <= 5000;
  return (
    <div className="absolute inset-x-0 top-0 z-40 h-1.5 bg-white/10">
      <div
        className={`h-full transition-[width] duration-500 ease-linear ${
          urgent ? "bg-live-red" : "bg-amber"
        }`}
        style={{ width: `${frac * 100}%` }}
      />
    </div>
  );
}

// Popover from the ⋯ button: Hand history, host-only End game, Leave table.
function MoreMenu({
  snap,
  onClose,
  onTip,
  onHistory,
  onSeating,
  onRules,
  onSetChips,
  onEndGame,
  onLeave,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  onTip: () => void;
  onHistory: () => void;
  onSeating: () => void;
  onRules: () => void;
  onSetChips: () => void;
  onEndGame: () => void;
  onLeave: () => void;
}) {
  return (
    <>
      <div onClick={onClose} className="absolute inset-0 z-[54] animate-pn-fade" />
      <div className="absolute right-4 top-[68px] z-[55] w-48 animate-pn-pop rounded-2xl border border-white/12 bg-panel-2 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,.55)]">
        {snap.yourSeatIndex !== null && (
          <button
            onClick={onTip}
            className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-cream"
          >
            🎁 Tip
          </button>
        )}
        <button
          onClick={onHistory}
          className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-cream"
        >
          ⟲ Hand history
        </button>
        {snap.youAreHost && (
          <button
            onClick={onSeating}
            className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-cream"
          >
            ⇄ Arrange seating
          </button>
        )}
        {snap.youAreHost && (
          <button
            onClick={onSetChips}
            className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-cream"
          >
            🪙 Set chips
          </button>
        )}
        {snap.mode === "full-deal" && (
          <button
            onClick={onRules}
            className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-cream"
          >
            ♦ Rules
          </button>
        )}
        {snap.youAreHost && (
          <button
            onClick={onEndGame}
            className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-amber"
          >
            ♠ End game · recap
          </button>
        )}
        <div className="mx-2.5 my-1 h-px bg-white/[0.07]" />
        <button
          onClick={onLeave}
          className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] font-semibold text-clay-soft"
        >
          ⏻ Leave table
        </button>
      </div>
    </>
  );
}

// A round felt table for the seating screens: positions one rendered node per
// seat around the same ellipse the live table uses. `areaRef` is exposed so the
// host drag layer can hit-test pointer coordinates back to a seat.
function SeatTable({
  count,
  mySeat,
  renderSeat,
  areaRef,
}: {
  count: number;
  mySeat: number | null;
  renderSeat: (i: number) => React.ReactNode;
  areaRef?: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={areaRef}
      className="relative mx-auto aspect-square w-full max-w-[330px]"
      style={{ touchAction: "none" }}
    >
      <div className="absolute inset-2 rounded-full border-[10px] border-wood bg-[radial-gradient(ellipse_at_50%_40%,#2f6e51,#1c4434_72%)] shadow-[inset_0_2px_24px_rgba(0,0,0,.45)]">
        <div className="absolute inset-3 rounded-full border border-amber/20" />
      </div>
      {Array.from({ length: count }, (_, i) => {
        const p = seatXY(i, mySeat, count);
        return (
          <div
            key={i}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
          >
            {renderSeat(i)}
          </div>
        );
      })}
    </div>
  );
}

// Host seat arranger (full screen): drag a player to another chair to move or
// swap them. Pointer-based so it works on touch and mouse. Between hands only.
function SeatingModal({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const count = snap.maxSeats;
  const locked = snap.round !== "waiting";
  const areaRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number } | null>(null);
  const [over, setOver] = useState<number | null>(null);

  // nearest seat (incl. empty) under a screen point, or null if past all of them
  const seatAt = (clientX: number, clientY: number) => {
    const el = areaRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * 100;
    const py = ((clientY - r.top) / r.height) * 100;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const p = seatXY(i, snap.yourSeatIndex, count);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD < 18 ? best : null;
  };

  const onDown = (i: number) => (e: React.PointerEvent) => {
    if (locked || !snap.seats[i].occupied) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ from: i, x: e.clientX, y: e.clientY });
    setOver(i);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, x: e.clientX, y: e.clientY });
    setOver(seatAt(e.clientX, e.clientY));
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const target = seatAt(e.clientX, e.clientY);
    if (target != null && target !== drag.from) emit("swap_seats", { a: drag.from, b: target });
    setDrag(null);
    setOver(null);
  };

  return (
    <div className="absolute inset-0 z-[88] flex animate-pn-fade flex-col bg-screen px-5 pb-8 pt-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-xl font-bold text-cream">Arrange seating</h2>
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.06] text-cream-2"
        >
          ✕
        </button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        {locked
          ? "You can only rearrange between hands."
          : "Drag a player to another chair to move or swap them."}
      </p>

      <div className="flex flex-1 items-center justify-center">
        <SeatTable
          count={count}
          mySeat={snap.yourSeatIndex}
          areaRef={areaRef}
          renderSeat={(i) => {
            const s = snap.seats[i];
            const filled = s?.occupied;
            const isOver = over === i;
            const isDragged = drag?.from === i;
            if (!filled)
              return (
                <div
                  className={`flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed text-[11px] font-bold ${
                    isOver ? "border-amber bg-amber/[0.18] text-amber" : "border-white/20 text-muted-2"
                  }`}
                >
                  {i + 1}
                </div>
              );
            return (
              <div
                onPointerDown={onDown(i)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                className="flex cursor-grab flex-col items-center gap-1 active:cursor-grabbing"
                style={{ touchAction: "none", opacity: isDragged ? 0.3 : 1 }}
              >
                <Avatar
                  name={s.nickname}
                  className={`h-14 w-14 rounded-full text-base ${isOver && !isDragged ? "ring-2 ring-amber" : ""}`}
                />
                <span className="max-w-[64px] truncate text-[11px] font-bold text-cream">
                  {s.nickname}
                </span>
              </div>
            );
          }}
        />
      </div>

      {/* the floating avatar that follows the finger while dragging */}
      {drag && (
        <div
          className="pointer-events-none fixed z-[95] -translate-x-1/2 -translate-y-1/2"
          style={{ left: drag.x, top: drag.y }}
        >
          <Avatar
            name={snap.seats[drag.from].nickname}
            className="h-16 w-16 rounded-full text-lg shadow-[0_10px_30px_rgba(0,0,0,.6)]"
          />
        </div>
      )}
    </div>
  );
}

// Queued player's seat chooser (full screen): the live table with open chairs
// highlighted — tap an empty seat to pick where (between whom) you'll sit.
function QueueSeatModal({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  return (
    <div className="absolute inset-0 z-[88] flex animate-pn-fade flex-col bg-screen px-5 pb-8 pt-16">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-xl font-bold text-cream">Pick your seat</h2>
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.06] text-cream-2"
        >
          ✕
        </button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        Tap an open chair to choose where you&apos;ll sit next hand.
      </p>

      <div className="flex flex-1 items-center justify-center">
        <SeatTable
          count={snap.maxSeats}
          mySeat={null}
          renderSeat={(i) => {
            const s = snap.seats[i];
            if (s?.occupied)
              return (
                <div className="flex flex-col items-center gap-1">
                  <Avatar name={s.nickname} className="h-14 w-14 rounded-full text-base" />
                  <span className="max-w-[64px] truncate text-[11px] font-bold text-cream-2">
                    {s.nickname}
                  </span>
                </div>
              );
            const chosen = snap.yourQueuedSeat === i;
            return (
              <button
                onClick={() => emit("choose_seat", { seatIndex: i })}
                className={`flex h-14 w-14 items-center justify-center rounded-full border-2 text-[12px] font-bold ${
                  chosen
                    ? "border-amber bg-amber/[0.22] text-amber"
                    : "border-dashed border-white/25 bg-white/[0.04] text-muted-2"
                }`}
              >
                {chosen ? "✓" : "Sit"}
              </button>
            );
          }}
        />
      </div>
    </div>
  );
}

// Popup announcing exactly what the host's "undo last action" reverted.
function UndoPopup({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const id = setTimeout(onClose, 4000);
    return () => clearTimeout(id);
  }, [onClose]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-[90] flex justify-center px-6">
      <div
        onClick={onClose}
        className="pointer-events-auto flex max-w-sm animate-pn-pop items-start gap-3 rounded-2xl border border-amber/40 bg-panel-2 px-4 py-3 shadow-[0_18px_44px_rgba(0,0,0,.55)]"
      >
        <span className="text-xl">↩️</span>
        <div>
          <div className="font-display text-sm font-bold text-amber">Action undone</div>
          <div className="mt-0.5 text-[13px] text-cream-2">{message}</div>
        </div>
      </div>
    </div>
  );
}

function RuleChangePopup({
  popup,
  onClose,
}: {
  popup: { title: string; message: string };
  onClose: () => void;
}) {
  useEffect(() => {
    const id = setTimeout(onClose, 5000);
    return () => clearTimeout(id);
  }, [onClose]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-[90] flex justify-center px-6">
      <div
        onClick={onClose}
        className="pointer-events-auto flex max-w-sm animate-pn-pop items-start gap-3 rounded-2xl border border-amber/40 bg-panel-2 px-4 py-3 shadow-[0_18px_44px_rgba(0,0,0,.55)]"
      >
        <span className="text-xl">📢</span>
        <div>
          <div className="font-display text-sm font-bold text-amber">{popup.title}</div>
          <div className="mt-0.5 text-[13px] text-cream-2">{popup.message}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------- lobby ----------------
function Lobby({ snap, onStart }: { snap: RoomSnapshot; onStart: () => void }) {
  const seated = snap.seats.filter((s) => s.occupied);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState("");
  useEffect(() => {
    const link = `${window.location.origin}/join?code=${snap.roomCode}`;
    QRCode.toDataURL(link, { margin: 1, width: 240 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [snap.roomCode]);
  return (
    <div className="flex flex-1 flex-col overflow-hidden px-5 pb-6">
      <div className="mt-1 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">Lobby</h1>
        <span className="flex items-center gap-1.5 rounded-full bg-green/[0.12] px-3 py-1.5 text-xs font-bold text-green-soft">
          <span className="h-1.5 w-1.5 animate-pn-blink rounded-full bg-green" /> Open
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-2xl border border-amber/20 bg-gradient-to-br from-amber/[0.16] to-amber/[0.05] p-4">
        <div>
          <div className="text-[11.5px] font-bold tracking-widest text-amber-soft">
            ROOM CODE
          </div>
          <div className="mt-0.5 font-display text-3xl font-bold tracking-[3px]">
            {snap.roomCode}
          </div>
        </div>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(snap.roomCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="h-11 rounded-xl bg-amber px-4 font-display text-sm font-bold text-amber-ink"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {qr && (
        <div className="mt-3 flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-field p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr}
            alt="Scan to join"
            className="h-[88px] w-[88px] flex-none rounded-lg bg-white p-1"
          />
          <div className="text-[13px] leading-relaxed text-muted-4">
            <span className="font-bold text-cream">Scan to join</span>
            <br />
            Point a phone camera here to drop straight into the nickname screen.
          </div>
        </div>
      )}

      <div className="flex items-center justify-between px-1 py-3 text-[13px]">
        <span className="font-semibold text-muted">
          PLAYERS · {seated.length} of {snap.maxSeats}
        </span>
        <span className="text-muted-2">
          {fmt(snap.buyIn)} buy-in · {snap.smallBlind}/{snap.bigBlind}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto pb-2">
        {seated.map((s) => (
          <div
            key={s.seatIndex}
            className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-field p-3"
          >
            <Avatar name={s.nickname} className="h-11 w-11 rounded-xl text-base" />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold">{s.nickname}</span>
                {s.isHost && (
                  <span className="rounded bg-amber/[0.14] px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide text-amber">
                    HOST
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted">Seat {s.seatIndex + 1}</div>
            </div>
            <span className={s.connected ? "text-[12.5px] font-bold text-green" : "text-[12.5px] text-muted"}>
              {s.connected ? "Ready" : "Away"}
            </span>
          </div>
        ))}
        {seated.length < snap.maxSeats && (
          <div className="flex items-center gap-3 rounded-2xl border border-dashed border-white/10 p-3 text-[13.5px] text-muted-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.04] text-xl text-muted-2">
              +
            </div>
            Waiting for friends to join…
          </div>
        )}
      </div>

      {snap.youAreHost ? (
        <div className="pt-3">
          <button
            onClick={onStart}
            disabled={seated.length < 2}
            className="h-14 w-full rounded-2xl bg-amber font-display text-lg font-bold text-amber-ink shadow-[0_8px_22px_rgba(224,162,59,.26)] disabled:opacity-50"
          >
            Start game
          </button>
          <p className="mt-2 text-center text-xs text-muted-2">
            {seated.length < 2 ? "Need at least 2 players" : "Deal the first hand"}
          </p>
        </div>
      ) : (
        <p className="pt-3 text-center text-sm text-muted-2">
          Waiting for the host to start…
        </p>
      )}
    </div>
  );
}

// ---------------- table ----------------
function seatXY(seatIndex: number, mySeat: number | null, count: number) {
  // Place seats around an ellipse; the viewer (or seat 0) sits at the bottom.
  const anchor = mySeat ?? 0;
  const k = (seatIndex - anchor + count) % count;
  const angle = Math.PI / 2 + (k * 2 * Math.PI) / count; // bottom = PI/2
  return { x: 50 + 40 * Math.cos(angle), y: 48 + 42 * Math.sin(angle) };
}
// A single card sailing from the dealer to its destination. Positions are in %
// of the table box (measured from the real DOM so cards land exactly on the
// hole-card slot / board slot). `face` flips a board card up on arrival.
type Flight = {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  delay: number;
  rot: number;
  kind: "hole" | "burn" | "board";
  face?: Card;
};

const HOLE_FLIGHT_MS = 320;
const BOARD_FLIGHT_MS = 520; // slower: the card scales up + flips as it travels

// Drives the deal-out flourish (full-deal only): card backs fly from the
// dealer's seat to each player at a new hand, then a burn + the flop/turn/river
// as the board fills. Board cards scale to full size and flip face-up on the
// way in. Returns the in-flight cards, gates so the static hole cards / board
// appear only once their flying card has landed, and refs to attach so target
// positions can be measured from the live layout.
// ponytail: cosmetic only — the server already dealt everything; an all-in
// runout (board jumps straight to 5) collapses to one burn + a fan of cards.
function useDealAnimation(snap: RoomSnapshot) {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [go, setGo] = useState(false);
  const [boardShown, setBoardShown] = useState(snap.communityCards.length);
  const [holesReady, setHolesReady] = useState(true);
  const prevHand = useRef<number | undefined>(undefined);
  const prevComm = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fid = useRef(0);
  const mounted = useRef(true);

  const tableRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const potRef = useRef<HTMLDivElement>(null);
  const holeRefs = useRef<Map<number, HTMLElement>>(new Map());
  const setHoleRef = (i: number) => (el: HTMLElement | null) => {
    if (el) holeRefs.current.set(i, el);
    else holeRefs.current.delete(i);
  };

  // Track mount instead of clearing timers on unmount: React's dev StrictMode
  // double-invokes mount effects, and a blanket clearTimeout there would kill
  // the very first hand's "show hole cards" timer before it fires. Guarding
  // state writes with `mounted` is enough — stale timers just no-op.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (snap.mode !== "full-deal") {
      setBoardShown(snap.communityCards.length);
      setHolesReady(true);
      return;
    }
    const table = tableRef.current;
    if (!table) return;
    const trect = table.getBoundingClientRect();
    // center of an element as a % of the table box
    const pctOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: ((r.left + r.width / 2 - trect.left) / trect.width) * 100,
        y: ((r.top + r.height / 2 - trect.top) / trect.height) * 100,
      };
    };
    const holePct = (i: number) => {
      const el = holeRefs.current.get(i);
      return el ? pctOf(el) : seatXY(i, snap.yourSeatIndex, snap.maxSeats);
    };
    const dealer = holePct(snap.dealerIndex);

    const clearTimers = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    const run = (fl: Flight[], totalMs: number, done: () => void) => {
      setFlights(fl);
      setGo(false);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => mounted.current && setGo(true))
      );
      timers.current.push(
        setTimeout(() => {
          if (!mounted.current) return;
          setFlights([]);
          setGo(false);
          done();
        }, totalMs)
      );
    };

    // ---- new hand: deal two hole cards to each player, left of the dealer ----
    if (snap.handNumber !== prevHand.current) {
      prevHand.current = snap.handNumber;
      prevComm.current = 0;
      clearTimers();
      // Joined/refreshed mid-hand (past preflop): sync, don't animate.
      if (snap.round !== "preflop" || snap.communityCards.length > 0) {
        setBoardShown(snap.communityCards.length);
        prevComm.current = snap.communityCards.length;
        setHolesReady(true);
        setFlights([]);
        return;
      }
      setBoardShown(0);
      const order: number[] = [];
      for (let i = 1; i <= snap.maxSeats; i++) {
        const idx = (snap.dealerIndex + i) % snap.maxSeats;
        const s = snap.seats[idx];
        if (s.occupied && (s.status === "active" || s.status === "all-in")) order.push(idx);
      }
      if (order.length === 0) {
        setHolesReady(true);
        return;
      }
      setHolesReady(false);
      const fl: Flight[] = [];
      let k = 0;
      const START = 550; // the little pause before cards start flying
      for (let pass = 0; pass < 2; pass++) {
        for (const idx of order) {
          const to = holePct(idx);
          fl.push({
            id: fid.current++,
            kind: "hole",
            x0: dealer.x,
            y0: dealer.y,
            x1: to.x + (pass ? 4 : -4),
            y1: to.y,
            delay: START + k * 85,
            rot: pass ? 7 : -7,
          });
          k++;
        }
      }
      run(fl, START + k * 85 + HOLE_FLIGHT_MS + 60, () => setHolesReady(true));
      return;
    }

    // ---- same hand: board grew → burn one, then deal the new street ----
    if (snap.communityCards.length > prevComm.current) {
      const from = prevComm.current;
      const to = snap.communityCards.length;
      prevComm.current = to;
      clearTimers();
      setHolesReady(true); // the hole deal is over by the time a street arrives
      const slotEls = boardRef.current ? Array.from(boardRef.current.children) : [];
      const slotPct = (i: number) =>
        slotEls[i] ? pctOf(slotEls[i]) : { x: 50 + (i - 2) * 10, y: 42 };
      // Burn spot: just to the right of the pot pill (where it gets set alight).
      const pot = potRef.current;
      const burnSpot = pot
        ? (() => {
            const p = pot.getBoundingClientRect();
            return {
              x: ((p.right - trect.left) / trect.width) * 100 + 6,
              y: ((p.top + p.height / 2 - trect.top) / trect.height) * 100,
            };
          })()
        : { x: 64, y: 30 };
      const fl: Flight[] = [
        // the burn card — flies to the burn spot beside the pot, then ignites
        { id: fid.current++, kind: "burn", x0: dealer.x, y0: dealer.y, x1: burnSpot.x, y1: burnSpot.y, delay: 0, rot: -12 },
      ];
      const BURN = 360;
      for (let j = 0; j < to - from; j++) {
        const slot = from + j;
        const tgt = slotPct(slot);
        fl.push({
          id: fid.current++,
          kind: "board",
          face: snap.communityCards[slot],
          x0: dealer.x,
          y0: dealer.y,
          x1: tgt.x,
          y1: tgt.y,
          delay: BURN + j * 170,
          rot: 0,
        });
        // reveal the static board card right as the flying one lands & finishes flipping
        timers.current.push(
          setTimeout(() => mounted.current && setBoardShown(slot + 1), BURN + j * 170 + BOARD_FLIGHT_MS)
        );
      }
      run(fl, BURN + (to - from) * 170 + BOARD_FLIGHT_MS + 80, () => setBoardShown(to));
      return;
    }

    // board reset (handled by the new-hand branch) → keep gate in sync
    if (snap.communityCards.length < prevComm.current) {
      prevComm.current = snap.communityCards.length;
      setBoardShown(snap.communityCards.length);
    }
  }, [snap]);

  return { flights, go, boardShown, holesReady, tableRef, boardRef, potRef, setHoleRef };
}
function TableView({
  snap,
  equity,
  result,
  winnings,
  now,
  actions,
  canPeek,
  onPeek,
}: {
  snap: RoomSnapshot;
  equity: Record<number, number>;
  result: HandResultPayload | null;
  winnings: Record<number, number>;
  now: number;
  actions: Record<number, { type: string; amount: number; id: number }>;
  canPeek: boolean;
  onPeek: (seatIndex: number) => void;
}) {
  const count = snap.maxSeats;
  const { flights, go, boardShown, holesReady, tableRef, boardRef, potRef, setHoleRef } =
    useDealAnimation(snap);
  return (
    <div ref={tableRef} className="relative flex-1">
      {/* felt */}
      <div className="absolute inset-x-3 bottom-3 top-2 rounded-[46%] border-[11px] border-wood bg-[radial-gradient(ellipse_at_50%_40%,#2f6e51,#1c4434_72%)] shadow-[inset_0_2px_30px_rgba(0,0,0,.45),0_14px_36px_rgba(0,0,0,.5)]">
        <div className="absolute inset-2 rounded-[44%] border border-amber/20" />
      </div>

      {/* center: pot + community / street */}
      <div className="absolute left-1/2 top-[38%] z-[6] flex w-full -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
        {snap.sidePots.length > 1 ? (
          <div className="flex flex-col items-center gap-1">
            {snap.sidePots.map((p, i) => (
              <div key={i} className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1">
                <span className="text-[10px] font-bold tracking-wider text-amber-soft">
                  {i === 0 ? "MAIN" : `SIDE ${i}`}
                </span>
                <span className="font-display text-base font-bold">{fmt(p.amount)}</span>
                <div className="flex -space-x-1.5">
                  {p.eligibleSeatIndexes.map((si) => (
                    <Avatar
                      key={si}
                      name={snap.seats[si]?.nickname ?? ""}
                      className="h-5 w-5 rounded-full text-[8px] ring-1 ring-black/50"
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div ref={potRef} className="flex items-center gap-2 rounded-full bg-black/40 px-4 py-1.5">
            <span className="text-[11px] font-bold tracking-widest text-amber-soft">POT</span>
            <span className="font-display text-lg font-bold">{fmt(snap.pot)}</span>
          </div>
        )}

        {snap.mode === "full-deal" ? (
          <div ref={boardRef} className="flex gap-1.5">
            {[0, 1, 2, 3, 4].map((i) =>
              i < boardShown && snap.communityCards[i] ? (
                <PlayingCard key={i} card={snap.communityCards[i]} />
              ) : (
                <CardBack key={i} />
              )
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex gap-1.5">
              {(["flop", "turn", "river"] as const).map((st) => {
                const reached =
                  ["flop", "turn", "river", "showdown"].indexOf(snap.round) >=
                  ["flop", "turn", "river"].indexOf(st);
                return (
                  <span
                    key={st}
                    className={`rounded-lg px-3 py-1.5 font-display text-xs font-bold ${
                      reached
                        ? "border border-amber/30 bg-amber/[0.16] text-amber"
                        : "bg-white/5 text-muted-2"
                    }`}
                  >
                    {st.toUpperCase()}
                  </span>
                );
              })}
            </div>
            <div className="text-[11.5px] text-white/35">
              ♠ cards are physical — tracking chips only
            </div>
          </div>
        )}
      </div>

      {/* seats */}
      {snap.seats.map((s) => {
        if (!s.occupied) return null;
        const xy = seatXY(s.seatIndex, snap.yourSeatIndex, count);
        const dx = 50 - xy.x;
        const dy = 48 - xy.y;
        const len = Math.hypot(dx, dy) || 1;
        return (
          <SeatView
            key={s.seatIndex}
            seat={s}
            pos={{ left: `${xy.x}%`, top: `${xy.y}%` }}
            inward={{ x: dx / len, y: dy / len }}
            isDealer={s.isDealer}
            isSmallBlind={s.isSmallBlind}
            isBigBlind={s.isBigBlind}
            isActor={s.isActor && snap.round !== "waiting"}
            deadline={snap.turnDeadline}
            now={now}
            equity={snap.youAreSpectator ? equity[s.seatIndex] : undefined}
            won={result?.winners.includes(s.seatIndex) ?? false}
            wonAmount={winnings[s.seatIndex]}
            action={actions[s.seatIndex]}
            bigBlind={snap.bigBlind}
            peekable={canPeek && s.status === "folded" && !s.isYou}
            onPeek={() => onPeek(s.seatIndex)}
            hideHole={!holesReady}
            holeRef={setHoleRef(s.seatIndex)}
          />
        );
      })}

      {/* cards in flight from the dealer (deal-out / burn / board) */}
      {flights.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-[15] [perspective:700px]">
          {flights.map((f) => {
            const ms = f.kind === "board" ? BOARD_FLIGHT_MS : HOLE_FLIGHT_MS;
            return (
              <div
                key={f.id}
                className="absolute [transform-style:preserve-3d]"
                style={{
                  left: `${go ? f.x1 : f.x0}%`,
                  top: `${go ? f.y1 : f.y0}%`,
                  transform: "translate(-50%,-50%)",
                  transition: `left ${ms}ms ease-out, top ${ms}ms ease-out`,
                  transitionDelay: `${f.delay}ms`,
                }}
              >
                {f.kind === "board" ? (
                  // grows to full size as a back, THEN flips face-up — so the
                  // rank/suit on the face never visibly scale (see pn-deal-card)
                  <div
                    className="animate-pn-deal-card relative h-[58px] w-[42px] [transform-style:preserve-3d]"
                    style={{ animationDelay: `${f.delay}ms` }}
                  >
                    <div className="absolute inset-0 [backface-visibility:hidden]">
                      <CardBack className="h-full w-full" />
                    </div>
                    <div
                      className="absolute inset-0 [backface-visibility:hidden]"
                      style={{ transform: "rotateY(180deg)" }}
                    >
                      {f.face && <PlayingCard card={f.face} className="h-full w-full text-base" />}
                    </div>
                  </div>
                ) : f.kind === "burn" ? (
                  // lands at the burn spot, then goes up in flames
                  <div className="relative">
                    <CardBack
                      className="h-9 w-[26px]"
                      style={{ animation: `pn-burn 800ms ease-in ${ms}ms forwards`, transform: `rotate(${f.rot}deg)` }}
                    />
                    <span
                      className="absolute inset-0 flex items-center justify-center text-2xl"
                      style={{ animation: `pn-flame 850ms ease-out ${ms + 60}ms both` }}
                    >
                      🔥
                    </span>
                  </div>
                ) : (
                  <CardBack className="h-9 w-[26px]" style={{ transform: `rotate(${f.rot}deg)` }} />
                )}
              </div>
            );
          })}
        </div>
      )}

      <CheekyBetTags snap={snap} />
    </div>
  );
}

// Active cheeky bets the viewer is part of, parked in the middle of the felt:
// two avatars with a ↔ arrow and the stake between them. Stacks if several.
function CheekyBetTags({ snap }: { snap: RoomSnapshot }) {
  // Keep accepted bets pinned to the felt; at showdown also keep settled ones up
  // (with their result) so the outcome doesn't vanish the instant they resolve.
  const live = snap.cheekyBets.filter(
    (b) => b.status === "accepted" || (b.status === "settled" && snap.round === "showdown")
  );
  if (live.length === 0) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-[60%] z-[7] flex w-full -translate-x-1/2 flex-col items-center gap-1.5">
      {live.map((b) => {
        const bettor = snap.seats[b.bettorSeatIndex];
        const opp = snap.seats[b.opponentSeatIndex];
        const outcome =
          b.status !== "settled" || !b.result
            ? null
            : b.result === "push"
            ? "Push — stakes returned"
            : `${(b.result === "bettor-won" ? bettor : opp).nickname} wins ${fmt(b.amount)}`;
        return (
          <div
            key={b.id}
            className="flex animate-pn-pop flex-col items-center gap-1 rounded-2xl border border-amber/30 bg-black/55 px-3 py-1.5 shadow-[0_6px_16px_rgba(0,0,0,.45)]"
          >
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-center">
                <Avatar name={bettor.nickname} className="h-6 w-6 rounded-full text-[10px]" />
                <span className="mt-0.5 text-[9px] font-bold text-cream-2">{bettor.nickname}</span>
              </div>
              <div className="flex flex-col items-center px-0.5">
                <span className="text-[13px] leading-none text-amber">↔</span>
                <span className="mt-0.5 font-display text-[11px] font-bold leading-none text-amber-soft">
                  {fmt(b.amount)}
                </span>
              </div>
              <div className="flex flex-col items-center">
                <Avatar name={opp.nickname} className="h-6 w-6 rounded-full text-[10px]" />
                <span className="mt-0.5 text-[9px] font-bold text-cream-2">{opp.nickname}</span>
              </div>
            </div>
            {outcome && (
              <span className="font-display text-[10px] font-bold text-amber">{outcome}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SeatView({
  seat,
  pos,
  inward,
  isDealer,
  isSmallBlind,
  isBigBlind,
  isActor,
  deadline,
  now,
  equity,
  won,
  wonAmount,
  action,
  bigBlind,
  peekable,
  onPeek,
  hideHole,
  holeRef,
}: {
  seat: PublicSeat;
  pos: { left: string; top: string };
  inward: { x: number; y: number };
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  isActor: boolean;
  deadline: number | null;
  now: number;
  equity?: number;
  won: boolean;
  wonAmount?: number;
  action?: { type: string; amount: number; id: number };
  bigBlind: number;
  peekable: boolean;
  onPeek: () => void;
  hideHole: boolean;
  holeRef: (el: HTMLDivElement | null) => void;
}) {
  const folded = seat.status === "folded";
  const secs =
    isActor && deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  return (
    <div
      className="absolute z-[8] w-24 -translate-x-1/2 -translate-y-1/2 text-center"
      style={{ left: pos.left, top: pos.top, opacity: folded && !seat.revealed ? 0.45 : 1 }}
      onClick={peekable ? onPeek : undefined}
      role={peekable ? "button" : undefined}
    >
      {/* hole cards: face-up if revealed to us, backs for opponents mid-hand.
          A voluntarily-revealed hand (between hands) flips around for everyone. */}
      <div
        ref={holeRef}
        className={`relative z-[1] -mb-3 flex h-9 items-end justify-center gap-1 ${
          seat.isYou && seat.holeCards
            ? "cursor-zoom-in transition-transform duration-150 hover:z-30 hover:-translate-y-3 hover:scale-[1.6]"
            : ""
        }`}
      >
        {hideHole ? null : seat.holeCards
          ? seat.holeCards.map((c, i) => (
              <span
                key={i}
                className={seat.revealed ? "inline-block animate-pn-flip-in" : ""}
                style={seat.revealed ? { animationDelay: `${i * 0.12}s` } : undefined}
              >
                <PlayingCard card={c} className="h-9 w-[26px] text-xs" />
              </span>
            ))
          : !folded && (seat.status === "active" || seat.status === "all-in") && (
              <>
                <CardBack className="h-9 w-[26px] -rotate-6" />
                <CardBack className="h-9 w-[26px] rotate-6" />
              </>
            )}
      </div>

      {/* avatar */}
      <div className="relative mx-auto h-[52px] w-[52px]" style={{ width: 52, height: 52 }}>
        {action && (
          <ActionBubble key={action.id} action={action} bigBlind={bigBlind} />
        )}
        {isActor && (
          <div
            className="absolute -inset-1 rounded-full border-[3px] border-amber"
            style={{ animation: "pn-pulse 1.6s infinite" }}
          />
        )}
        <Avatar
          name={seat.nickname}
          className={`h-[52px] w-[52px] rounded-full text-[17px] ${
            won ? "ring-[3px] ring-green" : isActor ? "" : ""
          }`}
          style={{ width: 52, height: 52, opacity: seat.connected ? 1 : 0.5 }}
        />
        {secs !== null && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber px-1 font-display text-[11px] font-bold text-amber-ink">
            {secs}
          </span>
        )}
        {equity !== undefined && !folded && (
          <span className="absolute -right-7 top-1/2 -translate-y-1/2 rounded-lg border border-black/20 bg-black/65 px-1.5 py-0.5 font-display text-[11px] font-bold text-cream shadow">
            {equity}%
          </span>
        )}
        {isDealer && (
          <span className="absolute -bottom-1 -left-1 flex h-5 w-5 items-center justify-center rounded-full bg-cream font-display text-[10px] font-bold text-card-ink">
            D
          </span>
        )}
        {isSmallBlind && (
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber font-display text-[9px] font-bold text-amber-ink">
            SB
          </span>
        )}
        {isBigBlind && (
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber font-display text-[9px] font-bold text-amber-ink">
            BB
          </span>
        )}
        {folded && (
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-[#3a2420] px-1.5 py-0.5 text-[9px] font-extrabold tracking-wide text-[#c98b7d]">
            FOLD
          </span>
        )}
        {peekable && (
          <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-amber/50 bg-panel-2 text-[10px] text-amber">
            ◉
          </span>
        )}
      </div>

      {/* name + stack */}
      <div
        className={`mt-2 inline-flex flex-col items-center rounded-lg border bg-black/40 px-2.5 py-1 ${
          won ? "border-green/60" : "border-white/[0.07]"
        }`}
      >
        <span className="text-xs font-bold leading-tight">{seat.nickname}</span>
        <span className="font-display text-xs font-bold leading-tight text-amber">
          {fmt(seat.chips)}
        </span>
      </div>

      {/* won-this-hand badge — stays on the felt until the next hand starts */}
      {wonAmount ? (
        <div className="mt-1 inline-block animate-pn-pop rounded-full bg-green px-2.5 py-0.5 font-display text-[11px] font-bold text-amber-ink shadow-[0_3px_10px_rgba(0,0,0,.4)]">
          won {fmt(wonAmount)}
        </div>
      ) : null}

      {/* current bet — placed on the felt in front of the player, toward the pot */}
      {seat.currentBet > 0 && (
        <div
          className="absolute left-1/2 top-1/2 z-[9] inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5"
          style={{
            transform: `translate(-50%, -50%) translate(${inward.x * 80}px, ${inward.y * 80}px)`,
          }}
        >
          <span className="h-3 w-3 rounded-full border-2 border-dashed border-amber-deep bg-amber" />
          <span className="font-display text-[11.5px] font-bold text-amber-soft">
            {fmt(seat.currentBet)}
          </span>
        </div>
      )}
    </div>
  );
}

function Avatar({
  name,
  className = "",
  style,
}: {
  name: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`flex items-center justify-center font-display font-bold text-white shadow-[0_4px_10px_rgba(0,0,0,.4)] ${className}`}
      style={{ background: colorFor(name), ...style }}
    >
      {initials(name)}
    </div>
  );
}

// Per-action chat bubble that pops above a player's avatar for 2s. Each action
// gets its own little animation (smoke / point / rising arrows / slam).
function ActionBubble({
  action,
  bigBlind,
}: {
  action: { type: string; amount: number };
  bigBlind: number;
}) {
  const { type, amount } = action;
  const shell =
    "pointer-events-none absolute -top-9 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap";
  const pill =
    "relative animate-pn-bubble rounded-xl px-2 py-1 font-display text-[11px] font-extrabold shadow-[0_4px_10px_rgba(0,0,0,.4)]";

  if (type === "fold") {
    // smoke puffs ring the bubble (not inside it)
    const puffs = [
      "left-1/2 -top-2 -translate-x-1/2",
      "-left-2 top-1/2 -translate-y-1/2",
      "-right-2 top-1/2 -translate-y-1/2",
      "left-1 -bottom-2",
      "right-1 -bottom-2",
    ];
    return (
      <div className={shell}>
        {puffs.map((p, i) => (
          <span
            key={i}
            className={`absolute h-3.5 w-3.5 rounded-full bg-white/40 blur-[2px] ${p}`}
            style={{ animation: "pn-smoke 1s ease-out forwards", animationDelay: `${i * 0.07}s` }}
          />
        ))}
        <div className={`${pill} bg-[#3a3a3a] text-white/70`}>Fold</div>
      </div>
    );
  }

  if (type === "call" || type === "check") {
    return (
      <div className={shell}>
        <div className={`${pill} bg-[#2f6e51] text-cream`}>
          <span className="mr-1 inline-block animate-pn-point">👉</span>
          {type === "call" ? "Call!" : "Check"}
        </div>
      </div>
    );
  }

  if (type === "all-in") {
    return (
      <div className={shell} style={{ animation: "pn-shake .4s ease 2" }}>
        <div className={`${pill} animate-pn-slam bg-live-red px-2.5 text-[13px] text-white`}>
          ALL IN
        </div>
      </div>
    );
  }

  // bet / raise — arrows + money signs float AROUND the pill (not inside, so the
  // bubble keeps a fixed size); more arrows for a bigger raise.
  const arrows = Math.min(5, Math.max(1, Math.round(amount / Math.max(1, bigBlind * 2))));
  const spots = [
    "left-1/2 -top-3.5 -translate-x-1/2",
    "-left-4 top-0",
    "-right-4 top-0",
    "left-0 -top-3",
    "right-0 -top-3",
  ];
  return (
    <div className={shell}>
      {Array.from({ length: arrows }).map((_, i) => (
        <span
          key={i}
          className={`absolute text-[11px] animate-pn-rise ${spots[i % spots.length]}`}
          style={{ animationDelay: `${i * 0.1}s` }}
        >
          💲
        </span>
      ))}
      <div className={`${pill} bg-amber text-amber-ink`}>
        {type === "bet" ? "Bet" : "Raise"}
      </div>
    </div>
  );
}

// ---------------- bottom area (action / host / spectator / status) ----------------
function BottomArea({
  snap,
  now,
  emit,
  preAction,
  setPreAction,
}: {
  snap: RoomSnapshot;
  now: number;
  emit: (e: string, p?: unknown) => void;
  preAction: PreAction;
  setPreAction: (p: PreAction) => void;
}) {
  const me = snap.yourSeatIndex !== null ? snap.seats[snap.yourSeatIndex] : null;
  const myTurn = me !== null && snap.currentActorIndex === snap.yourSeatIndex && snap.round !== "waiting";
  const bettingSettled = snap.currentActorIndex < 0 && snap.round !== "waiting";

  if (snap.youAreSpectator) return <SpectatorStrip snap={snap} emit={emit} />;

  if (myTurn && me) return <ActionBar snap={snap} me={me} emit={emit} />;

  if (snap.mode === "chips-only" && snap.youAreHost && snap.round === "showdown")
    return <AwardPicker snap={snap} emit={emit} />;

  if (snap.mode === "chips-only" && snap.youAreHost && bettingSettled)
    return <DealStrip snap={snap} emit={emit} />;

  // It's not your turn yet but you're live in the hand — let yourself pre-arm
  // an action so it fires automatically when the turn reaches you.
  const canPreAct = me?.status === "active" && snap.round !== "waiting" && !bettingSettled;

  // Between hands you can flip your own hand face-up for the table (full-deal):
  // anyone who was dealt in this hand — folded or not — and hasn't shown yet.
  const canReveal =
    snap.mode === "full-deal" &&
    snap.round === "waiting" &&
    me != null &&
    !me.revealed &&
    (me.status === "active" || me.status === "all-in" || me.status === "folded");

  // between hands / waiting for others (bottom bar sits a touch higher: pb-10).
  // Transparent gradient (not a solid bar) so it stops covering the player's own
  // chips on short screens — the felt shows through the top, text stays readable.
  return (
    <div className="z-20 bg-gradient-to-t from-screen/90 via-screen/55 to-transparent px-5 pb-10 pt-6">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted">
          {snap.round === "waiting"
            ? "Between hands"
            : snap.currentActorIndex >= 0
            ? `Waiting for ${snap.seats[snap.currentActorIndex]?.nickname ?? "…"}…`
            : "Waiting…"}
        </span>
        <div className="flex gap-2">
          {canReveal && (
            <button
              onClick={() => emit("reveal_hand")}
              className="rounded-xl border border-amber/50 bg-amber/[0.13] px-4 py-2 font-display text-[14px] font-bold text-amber"
            >
              Reveal hand
            </button>
          )}
          {snap.youAreHost && snap.round === "waiting" && (
            <button
              onClick={() => emit("start_hand")}
              className="rounded-xl bg-amber px-4 py-2 font-display text-[14px] font-bold text-amber-ink"
            >
              Deal next hand
            </button>
          )}
        </div>
      </div>

      {canPreAct && <PreActionBar preAction={preAction} setPreAction={setPreAction} />}
    </div>
  );
}

// Three pre-arm toggles shown while you wait for your turn. Tapping the active
// one again cancels. Resolution happens on your turn (see RoomPage effect).
function PreActionBar({
  preAction,
  setPreAction,
}: {
  preAction: PreAction;
  setPreAction: (p: PreAction) => void;
}) {
  const opts: [PreAction, string][] = [
    ["check-fold", "Check / Fold"],
    ["call-any", "Check / Call"],
    ["fold", "Fold"],
  ];
  const toggle = (p: PreAction) => setPreAction(preAction === p ? null : p);
  return (
    <div className="mt-3 flex gap-2">
      {opts.map(([p, label]) => {
        const on = preAction === p;
        return (
          <button
            key={p}
            onClick={() => toggle(p)}
            className={`h-11 flex-1 rounded-xl border font-display text-[13px] font-bold transition-colors ${
              on
                ? "border-amber bg-amber/[0.18] text-amber"
                : "border-white/12 bg-white/[0.04] text-cream-2"
            }`}
          >
            {on && "✓ "}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ActionBar({
  snap,
  me,
  emit,
}: {
  snap: RoomSnapshot;
  me: PublicSeat;
  emit: (e: string, p?: unknown) => void;
}) {
  const highest = Math.max(0, ...snap.seats.map((s) => s.currentBet));
  const toCall = Math.max(0, highest - me.currentBet);
  const maxTotal = me.currentBet + me.chips; // all-in total this street
  const isBet = highest === 0;
  const minTotal = isBet
    ? Math.min(maxTotal, snap.bigBlind)
    : Math.min(maxTotal, highest + snap.minRaise);
  const [amount, setAmount] = useState(minTotal);

  // keep slider valid as state changes
  const amt = Math.min(Math.max(amount, minTotal), maxTotal);
  const canRaise = maxTotal > highest; // have chips to raise/bet at all

  // Free-typing bet box: holds raw text while editing so it can be cleared
  // fully; only commits on Enter/blur, snapping to the min bet if out of range.
  const [betText, setBetText] = useState<string | null>(null);
  const commitBet = () => {
    const n = parseInt(betText ?? "", 10);
    setAmount(Number.isFinite(n) && n >= minTotal && n <= maxTotal ? n : minTotal);
    setBetText(null);
  };

  const send = (type: string, a?: number) => emit("player_action", { type, amount: a });
  const quick = (target: number) => setAmount(Math.min(maxTotal, Math.max(minTotal, target)));

  return (
    <div className="z-20 border-t border-white/[0.06] bg-gradient-to-t from-bar from-70% to-transparent px-4 pb-10 pt-3.5">
      <div className="mb-2.5 flex items-center justify-between text-[13px]">
        <span className="font-semibold text-muted">
          Your turn ·{" "}
          <span className="text-amber">
            {toCall > 0 ? `to call ${fmt(toCall)}` : "check or bet"}
          </span>
        </span>
        {canRaise && (
          <span className="font-display text-[15px] font-bold">
            {isBet ? `Bet ${fmt(amt)}` : `Raise to ${fmt(amt)}`}
          </span>
        )}
      </div>

      {canRaise && (
        <div className="mb-3 flex items-center gap-2.5">
          <input
            type="number"
            inputMode="numeric"
            min={minTotal}
            max={maxTotal}
            value={betText ?? amt}
            onFocus={() => setBetText(String(amt))}
            onChange={(e) => setBetText(e.target.value)}
            onBlur={commitBet}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="h-9 w-[64px] flex-none rounded-lg border border-white/12 bg-field px-2 text-center font-display text-[13px] font-bold text-amber outline-none focus:border-amber/50"
          />
          <input
            type="range"
            min={minTotal}
            max={maxTotal}
            value={amt}
            onChange={(e) => setAmount(+e.target.value)}
            className="h-2 flex-1 accent-amber"
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => quick(me.currentBet + Math.round(snap.pot / 2))}
              className="rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1.5 font-display text-[11.5px] font-bold text-cream-2"
            >
              ½ Pot
            </button>
            <button
              onClick={() => quick(me.currentBet + snap.pot)}
              className="rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1.5 font-display text-[11.5px] font-bold text-cream-2"
            >
              Pot
            </button>
            <button
              onClick={() => quick(maxTotal)}
              className="rounded-lg border border-amber/40 bg-amber/[0.12] px-2.5 py-1.5 font-display text-[11.5px] font-bold text-amber"
            >
              All-in
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2.5">
        <button
          onClick={() => send("fold")}
          className="h-14 flex-1 rounded-2xl border border-clay/40 bg-clay/10 font-display text-base font-bold text-clay-soft"
        >
          Fold
        </button>
        <button
          onClick={() => send(toCall > 0 ? "call" : "check")}
          className="h-14 flex-[1.2] rounded-2xl border border-white/14 bg-white/[0.06] font-display text-base font-bold text-cream"
        >
          {toCall > 0 ? `Call ${fmt(Math.min(toCall, me.chips))}` : "Check"}
        </button>
        {canRaise && (
          <button
            onClick={() =>
              amt >= maxTotal ? send("all-in") : send(isBet ? "bet" : "raise", amt)
            }
            className="h-14 flex-[1.4] rounded-2xl bg-amber font-display text-base font-bold text-amber-ink shadow-[0_8px_20px_rgba(224,162,59,.3)]"
          >
            {amt >= maxTotal ? "All-in" : isBet ? `Bet ${fmt(amt)}` : `Raise ${fmt(amt)}`}
          </button>
        )}
      </div>
    </div>
  );
}

function DealStrip({
  snap,
  emit,
}: {
  snap: RoomSnapshot;
  emit: (e: string, p?: unknown) => void;
}) {
  const nextLabel: Record<string, string> = {
    preflop: "Deal flop",
    flop: "Deal turn",
    turn: "Deal river",
    river: "Go to showdown",
  };
  return (
    <div className="z-20 border-t border-white/[0.06] bg-gradient-to-t from-bar from-70% to-transparent px-4 pb-7 pt-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="rounded bg-amber/[0.14] px-2 py-0.5 text-[10px] font-extrabold tracking-wide text-amber">
          HOST
        </span>
        <span className="text-[12.5px] font-semibold text-muted">
          Advance the round as you deal the real deck
        </span>
      </div>
      <button
        onClick={() => emit("advance_street")}
        className="h-[52px] w-full rounded-2xl bg-amber py-3.5 font-display text-base font-bold text-amber-ink shadow-[0_8px_20px_rgba(224,162,59,.28)]"
      >
        {nextLabel[snap.round] ?? "Advance"}
      </button>
    </div>
  );
}

function AwardPicker({
  snap,
  emit,
}: {
  snap: RoomSnapshot;
  emit: (e: string, p?: unknown) => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const [sevenDeuce, setSevenDeuce] = useState(false); // host declares a 7-2 win
  const candidates = snap.seats.filter((s) => s.occupied && s.status !== "folded");
  const toggle = (i: number) =>
    setSel((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));
  return (
    <div className="z-20 border-t border-white/[0.06] bg-bar px-4 pb-7 pt-3.5">
      <div className="mb-2.5 rounded-2xl border border-amber/30 bg-amber/10 px-4 py-3">
        <div className="font-bold text-amber">Pick the winner(s) of the {fmt(snap.pot)} pot</div>
        <div className="mt-0.5 text-[12.5px] text-muted-4">
          Tap players who showed the best hand. Ties split the pot.
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {candidates.map((s) => (
          <button
            key={s.seatIndex}
            onClick={() => toggle(s.seatIndex)}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
              sel.includes(s.seatIndex)
                ? "border-amber bg-amber/20 text-cream"
                : "border-white/12 bg-white/[0.04] text-cream-2"
            }`}
          >
            <Avatar name={s.nickname} className="h-7 w-7 rounded-lg text-[11px]" />
            <span className="text-[13px] font-bold">{s.nickname}</span>
            {sel.includes(s.seatIndex) && <span className="text-amber">✓</span>}
          </button>
        ))}
      </div>
      {snap.sevenDeuce > 0 && (
        <button
          onClick={() => setSevenDeuce((v) => !v)}
          className={`mb-3 flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left ${
            sevenDeuce ? "border-amber bg-amber/[0.16] text-amber" : "border-white/12 bg-white/[0.04] text-cream-2"
          }`}
        >
          <span
            className={`flex h-5 w-5 flex-none items-center justify-center rounded border-2 text-[12px] font-extrabold text-amber-ink ${
              sevenDeuce ? "border-amber bg-amber" : "border-white/30"
            }`}
          >
            {sevenDeuce ? "✓" : ""}
          </span>
          <span className="text-[13px] font-bold">
            Won with 7-2 — everyone pays {snap.sevenDeuce}
          </span>
        </button>
      )}
      <button
        onClick={() =>
          sel.length &&
          emit("award_pot", {
            winningSeatIndexes: sel,
            sevenDeuce,
          })
        }
        disabled={!sel.length}
        className="h-[52px] w-full rounded-2xl bg-amber py-3.5 font-display text-base font-bold text-amber-ink disabled:opacity-40"
      >
        Award {fmt(snap.pot)}
      </button>
    </div>
  );
}

function SpectatorStrip({
  snap,
  emit,
}: {
  snap: RoomSnapshot;
  emit: (e: string, p?: unknown) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  if (snap.youAreBusted) {
    return (
      <div className="z-20 bg-gradient-to-t from-bar from-[72%] to-transparent px-4 pb-10 pt-4">
        <div className="rounded-2xl border border-clay-soft/25 bg-clay-soft/[0.08] px-4 py-3.5 text-center">
          <div className="text-[11.5px] font-bold tracking-wide text-clay-soft">OUT OF CHIPS</div>
          <div className="mt-1 text-sm text-cream-2">
            You&apos;re spectating until the host offers you a buy-in. Accept it to rejoin next hand.
          </div>
        </div>
      </div>
    );
  }
  if (snap.youAreQueued) {
    const ahead = snap.queue.indexOf(getNickname() || "");
    const openSeats = snap.seats.filter((s) => !s.occupied).length;
    const chosen = snap.yourQueuedSeat;
    return (
      <div className="z-20 bg-gradient-to-t from-bar from-[72%] to-transparent px-4 pb-10 pt-4">
        <div className="rounded-2xl border border-amber/25 bg-amber/[0.08] px-4 py-3.5">
          <div className="text-center text-[11.5px] font-bold tracking-wide text-amber">
            WAITING FOR GAME
          </div>
          <div className="mt-1 text-center text-sm text-cream-2">
            You&apos;ll be dealt in when the next hand starts
            {ahead > 0 ? ` · ${ahead} ahead of you` : ""}. Spectating until then.
          </div>
          {openSeats > 0 && (
            <button
              onClick={() => setShowPicker(true)}
              className="mt-3 h-11 w-full rounded-xl border border-amber/40 bg-amber/[0.12] font-display text-[13.5px] font-bold text-amber"
            >
              {chosen !== null ? `Seat ${chosen + 1} picked · change` : "Pick your seat"}
            </button>
          )}
        </div>
        {showPicker && (
          <QueueSeatModal snap={snap} onClose={() => setShowPicker(false)} emit={emit} />
        )}
      </div>
    );
  }
  return (
    <div className="z-20 bg-gradient-to-t from-bar from-[72%] to-transparent px-4 pb-10 pt-4">
      <div className="rounded-2xl border border-white/[0.08] bg-black/30 px-4 py-3.5 text-center">
        <div className="text-[11.5px] font-bold tracking-wide text-muted">SPECTATING</div>
        <div className="mt-1 text-sm text-cream-2">
          {snap.mode === "full-deal"
            ? "You can see every hand face-up. Equity updates live as the board runs out."
            : "Cards are physical — you see the same chip view as everyone else."}
        </div>
      </div>
    </div>
  );
}

// ---------------- overlays ----------------

// Reorder the winning five so the winner's own hole cards sit in the middle,
// flanked by the board cards used. Tags each card so the holes can be ringed.
function centerHoleCards(
  best: Card[],
  hole: Card[]
): { card: Card; isHole: boolean }[] {
  const tagged = best.map((card) => ({
    card,
    isHole: hole.some((h) => h.rank === card.rank && h.suit === card.suit),
  }));
  const holes = tagged.filter((c) => c.isHole);
  const board = tagged.filter((c) => !c.isHole);
  const half = Math.ceil(board.length / 2);
  return [...board.slice(0, half), ...holes, ...board.slice(half)];
}

// Cinematic full-deal showdown (single screen): every player still in the hand
// has their cards shake, then flip face-up; then the winner is announced, their
// best five lock together, and the tier WinAnimation plays — all in place.
// Players dismiss with Continue; the host can force everyone into the next hand.
function ShowdownReveal({
  snap,
  result,
  community,
  onContinue,
  onStartHand,
}: {
  snap: RoomSnapshot;
  result: HandResultPayload;
  community: RoomSnapshot["communityCards"];
  onContinue: () => void;
  onStartHand: () => void;
}) {
  // hole cards revealed so far (0 → 1 → 2), then the winner "form" screen
  const [revealed, setRevealed] = useState(0);
  const [phase, setPhase] = useState<"reveal" | "form">("reveal");
  const [animDone, setAnimDone] = useState(false);
  const tier = getAnimationTier(result.handCategory);
  const winner =
    result.revealedHands.find((h) => result.winners.includes(h.seatIndex)) ??
    result.revealedHands[0];

  useEffect(() => {
    const t1 = setTimeout(() => setRevealed(1), 2000); // 2s, then first card
    const t2 = setTimeout(() => setRevealed(2), 3000); // 1s, then second card
    const t3 = setTimeout(() => setPhase("form"), 5000); // 2s pause, then winner
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <div className="absolute inset-0 z-[45] flex flex-col items-center justify-center gap-6 bg-[rgba(6,10,7,.82)] px-5 backdrop-blur-sm">
      {phase !== "form" ? (
        <>
          <div className="font-display text-sm font-bold tracking-widest text-amber-soft">
            SHOWDOWN
          </div>
          {/* the board, so players can see the full five the whole time */}
          <div className="flex items-end gap-1.5">
            {community.map((c, i) => (
              <PlayingCard key={`b${i}`} card={c} className="h-[52px] w-[37px] text-base" />
            ))}
          </div>
          <div className="flex flex-wrap items-start justify-center gap-x-6 gap-y-5">
            {result.revealedHands.map((h) => (
              <div key={h.seatIndex} className="flex flex-col items-center gap-2">
                <div className="flex gap-1.5">
                  {h.holeCards.map((c, i) =>
                    i < revealed ? (
                      <PlayingCard key={i} card={c} />
                    ) : (
                      <span key={i} className="animate-pn-jitter">
                        <CardBack className="h-[58px] w-[42px]" />
                      </span>
                    )
                  )}
                </div>
                <span className="text-xs font-bold text-cream-2">{h.nickname}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
        <div className="relative flex animate-pn-up flex-col items-center gap-4">
          {/* confetti raining around the winner, like the raise money signs */}
          {Array.from({ length: 12 }).map((_, i) => (
            <span
              key={i}
              className="pointer-events-none absolute animate-pn-rise text-lg"
              style={{
                left: `${8 + (i * 84) / 12}%`,
                top: `${i % 2 ? "-8%" : "12%"}`,
                animationDelay: `${(i % 6) * 0.12}s`,
              }}
            >
              🎉
            </span>
          ))}
          <div className="font-display text-base font-extrabold tracking-wide text-amber">
            {winner?.nickname} wins · {winner?.handName}
          </div>
          {/* the five community cards that were on the table */}
          <div className="flex items-end gap-1.5">
            {community.map((c, i) => (
              <PlayingCard key={`b${i}`} card={c} className="h-[46px] w-[33px] text-sm" />
            ))}
          </div>
          {/* the winning five, with the winner's own cards highlighted in the center */}
          <div className="flex items-end gap-1.5">
            {centerHoleCards(winner?.bestCards ?? [], winner?.holeCards ?? []).map(
              ({ card: c, isHole }, i) => (
                <span
                  key={i}
                  className={`inline-block animate-pn-up rounded-md ${
                    isHole ? "ring-2 ring-amber" : ""
                  }`}
                  style={{ animationDelay: `${i * 0.12}s` }}
                >
                  <PlayingCard card={c} className="h-[58px] w-[42px] text-base" />
                </span>
              )
            )}
          </div>
          <div className="text-[13px] font-semibold text-cream-2">{winner?.handDescr}</div>

          {/* everyone's hand: the winner beaming, the losers crying */}
          {result.revealedHands.length > 0 && (
            <div className="flex flex-wrap items-start justify-center gap-x-5 gap-y-3">
              {result.revealedHands.map((h) => {
                const won = result.winners.includes(h.seatIndex);
                return (
                  <div key={h.seatIndex} className="relative flex flex-col items-center gap-1">
                    <div className="relative text-2xl">
                      {won ? "😄" : "😢"}
                      {/* tears falling from the losers' faces */}
                      {!won &&
                        [0, 1].map((d) => (
                          <span
                            key={d}
                            className="pointer-events-none absolute top-[60%] animate-pn-drip text-[11px]"
                            style={{
                              left: d ? "62%" : "30%",
                              animationDelay: `${d * 0.5}s`,
                            }}
                          >
                            💧
                          </span>
                        ))}
                    </div>
                    <div className="flex gap-1">
                      {h.holeCards.map((c, i) => (
                        <PlayingCard
                          key={i}
                          card={c}
                          className="h-10 w-[28px] text-xs"
                          faded={!won}
                        />
                      ))}
                    </div>
                    <span className="text-[11px] font-bold text-cream-2">{h.nickname}</span>
                    <span className="text-[10px] text-muted">{h.handDescr}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-1 flex gap-2.5">
            <button
              onClick={onContinue}
              className="h-12 rounded-2xl bg-white/[0.08] px-7 font-display text-base font-bold text-cream"
            >
              Continue
            </button>
            {snap.youAreHost && (
              <button
                onClick={onStartHand}
                className="h-12 rounded-2xl bg-amber px-7 font-display text-base font-bold text-amber-ink shadow-[0_8px_20px_rgba(224,162,59,.3)]"
              >
                Start next hand
              </button>
            )}
          </div>
        </div>
        {/* tier moment from the old showdown panel, layered over the full screen */}
        {tier !== "neutral" && !animDone && (
          <WinAnimation
            tier={tier}
            cards={winner?.holeCards}
            onComplete={() => setAnimDone(true)}
          />
        )}
        </>
      )}
    </div>
  );
}

function ShowdownOverlay({
  snap,
  result,
  onContinue,
  onStartHand,
}: {
  snap: RoomSnapshot;
  result: HandResultPayload;
  onContinue: () => void;
  onStartHand: () => void;
}) {
  const winnerNames = result.winners
    .map((i) => snap.seats[i]?.nickname)
    .filter(Boolean)
    .join(", ");
  const potWon = result.potsAwarded.reduce((n, p) => n + p.amount, 0);
  const [animDone, setAnimDone] = useState(false);
  const tier = getAnimationTier(result.handCategory);
  // Cards to spin for the small/medium tiers — the winning seat's hole cards.
  const winnerCards =
    result.revealedHands.find((h) => result.winners.includes(h.seatIndex))
      ?.holeCards ?? [];
  return (
    <>
      <div className="absolute inset-0 z-40 animate-pn-fade bg-[rgba(8,12,9,.55)] backdrop-blur-sm" />
      {!animDone && tier !== "neutral" && (
        <WinAnimation
          tier={tier}
          cards={winnerCards}
          onComplete={() => setAnimDone(true)}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 z-[41] animate-pn-up rounded-t-3xl border-t border-amber/25 bg-panel px-5 pb-7 pt-5 shadow-[0_-20px_50px_rgba(0,0,0,.5)]">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
        <div className="mb-4">
          <h2 className="font-display text-xl font-bold">Showdown</h2>
        </div>

        <div className="mb-4 flex max-h-[40dvh] flex-col gap-2.5 overflow-y-auto">
          {result.revealedHands.length === 0 && (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 text-center text-sm text-muted">
              {winnerNames
                ? `${winnerNames} won ${fmt(potWon)} from the pot.`
                : "Pot awarded."}
            </div>
          )}
          {result.revealedHands.map((h) => {
            const won = result.winners.includes(h.seatIndex);
            return (
              <div
                key={h.seatIndex}
                className={`flex items-center gap-3 rounded-2xl p-3.5 ${
                  won
                    ? "border-[1.5px] border-amber/50 bg-gradient-to-br from-amber/[0.18] to-amber/[0.05]"
                    : "border border-white/[0.07] bg-white/[0.03]"
                }`}
              >
                <Avatar name={h.nickname} className="h-11 w-11 rounded-xl text-base" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold">{h.nickname}</span>
                    {won && (
                      <span className="rounded bg-amber px-1.5 py-0.5 text-[9.5px] font-extrabold tracking-wide text-amber-ink">
                        WINNER
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold text-amber-soft">
                    {h.handDescr}
                  </div>
                </div>
                <div className="flex gap-1">
                  {h.holeCards.map((c, i) => (
                    <PlayingCard key={i} card={c} className="h-11 w-[30px] text-sm" faded={!won} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-2.5">
          <button
            onClick={onContinue}
            className="h-14 flex-1 rounded-2xl bg-white/[0.08] font-display text-base font-bold text-cream"
          >
            Continue
          </button>
          {snap.youAreHost && (
            <button
              onClick={onStartHand}
              className="h-14 flex-1 rounded-2xl bg-amber font-display text-base font-bold text-amber-ink"
            >
              Start next hand
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function TipModal({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const others = snap.seats.filter((s) => s.occupied && !s.isYou);
  const [target, setTarget] = useState<number | null>(others[0]?.seatIndex ?? null);
  const [amount, setAmount] = useState(50);
  const me = snap.yourSeatIndex !== null ? snap.seats[snap.yourSeatIndex] : null;

  const send = () => {
    if (!me || target === null || amount <= 0 || amount > me.chips) return;
    emit("donate_chips", { toSeatIndex: target, amount });
    onClose();
  };

  return (
    <>
      <div onClick={onClose} className="absolute inset-0 z-50 animate-pn-fade bg-[rgba(8,12,9,.62)] backdrop-blur-sm" />
      <div className="absolute inset-x-4 top-1/2 z-[51] -translate-y-1/2 animate-pn-pop rounded-3xl border border-white/10 bg-panel-2 p-5 shadow-[0_30px_70px_rgba(0,0,0,.6)]">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-xl font-bold">Tip</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-cream-2">
            ✕
          </button>
        </div>
        <p className="mb-4 text-[13px] text-muted">
          Gift chips to another player.
        </p>
        <div className="mb-4 flex gap-2.5 overflow-x-auto px-1 py-1.5">
          {others.map((s) => (
            <button
              key={s.seatIndex}
              onClick={() => setTarget(s.seatIndex)}
              className="flex flex-none flex-col items-center gap-1.5"
            >
              <Avatar
                name={s.nickname}
                className={`h-[52px] w-[52px] rounded-full text-base ${
                  target === s.seatIndex
                    ? "ring-2 ring-amber ring-offset-2 ring-offset-panel-2"
                    : "opacity-70"
                }`}
              />
              <span className="text-[11px] text-muted">{s.nickname}</span>
            </button>
          ))}
        </div>
        <div className="mb-2.5 flex gap-2.5">
          {[25, 50, 100].map((v) => (
            <button
              key={v}
              onClick={() => setAmount(v)}
              className={`h-11 flex-1 rounded-xl font-display text-[15px] font-bold ${
                amount === v
                  ? "border-[1.5px] border-amber bg-amber/[0.14] text-amber"
                  : "border border-white/12 bg-white/[0.04] text-cream-2"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <NumField
          value={amount}
          onChange={setAmount}
          min={1}
          max={me?.chips ?? undefined}
          className={`input mb-1.5 font-display font-bold ${
            [25, 50, 100].includes(amount) ? "text-cream-2" : "border-amber text-amber"
          }`}
        />
        {me && amount > me.chips && (
          <p className="mb-2 text-[12px] text-clay-soft">You only have {fmt(me.chips)} chips.</p>
        )}
        <button
          onClick={send}
          disabled={target === null || amount <= 0 || !me || amount > me.chips}
          className="h-14 w-full rounded-2xl bg-amber font-display text-base font-bold text-amber-ink disabled:opacity-40"
        >
          Send {amount}
          {target !== null ? ` to ${snap.seats[target]?.nickname}` : ""}
        </button>
      </div>
    </>
  );
}

// Host edits the 7-2 rule live: toggle it on/off and set the chip amount.
function RulesModal({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const ro = !snap.youAreHost; // non-hosts can look, not touch
  const [on, setOn] = useState(snap.sevenDeuce > 0);
  const [amount, setAmount] = useState(snap.sevenDeuce > 0 ? snap.sevenDeuce : 50);
  const [minR, setMinR] = useState(snap.minRaiseDefault);

  const save = () => {
    emit("set_seven_deuce", { amount: on ? Math.max(1, amount) : 0 });
    if (minR !== snap.minRaiseDefault) emit("set_min_raise", { amount: Math.max(1, minR) });
    onClose();
  };

  return (
    <>
      <div onClick={onClose} className="absolute inset-0 z-50 animate-pn-fade bg-[rgba(8,12,9,.62)] backdrop-blur-sm" />
      <div className="absolute inset-x-4 top-1/2 z-[51] -translate-y-1/2 animate-pn-pop rounded-3xl border border-white/10 bg-panel-2 p-5 shadow-[0_30px_70px_rgba(0,0,0,.6)]">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-xl font-bold">Custom rules</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-cream-2">
            ✕
          </button>
        </div>
        <button
          onClick={() => !ro && setOn((v) => !v)}
          disabled={ro}
          className={`mt-3 flex w-full items-start gap-3 rounded-2xl border p-4 text-left ${
            on ? "border-amber/35 bg-amber/10" : "border-white/[0.08] bg-white/[0.03]"
          }`}
        >
          <span
            className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-lg border-2 text-[15px] font-extrabold text-amber-ink ${
              on ? "border-amber bg-amber" : "border-white/30"
            }`}
          >
            {on ? "✓" : ""}
          </span>
          <span>
            <span className="block font-bold">7-2 rule {ro && <span className="text-muted">· {on ? "On" : "Off"}</span>}</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted">
              Win a hand holding an offsuit 7 and 2 and every other player pays you the amount below.
            </span>
          </span>
        </button>
        {on && (
          <div className="mt-4">
            <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted">
              CHIPS FROM EACH PLAYER
            </div>
            <input
              type="number"
              min={1}
              value={amount}
              disabled={ro}
              onChange={(e) => setAmount(Math.max(1, +e.target.value))}
              className="input font-display font-bold text-amber disabled:opacity-70"
            />
          </div>
        )}
        <div className="mt-5">
          <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted">
            MIN RAISE / MIN BET
            {ro && <span className="ml-1 text-muted">· {snap.minRaiseDefault}</span>}
          </div>
          {ro ? (
            <div className="input font-display font-bold text-amber opacity-70">
              {snap.minRaiseDefault}
            </div>
          ) : (
            <NumField
              value={minR}
              onChange={setMinR}
              min={1}
              className="input font-display font-bold text-amber"
            />
          )}
          <p className="mt-1.5 text-[12px] leading-snug text-muted">
            Smallest bet or raise allowed — can be below the small blind. Applies from the next street.
          </p>
        </div>
        {ro ? (
          <p className="mt-5 text-center text-[12px] text-muted">Only the host can change rules.</p>
        ) : (
          <button
            onClick={save}
            className="mt-5 h-14 w-full rounded-2xl bg-amber font-display text-base font-bold text-amber-ink"
          >
            Save
          </button>
        )}
      </div>
    </>
  );
}

// Host offers a player a buy-in (the table buy-in or a custom amount); the
// player accepts or declines on their own screen.
function SetChipsModal({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  // seated players plus busted ones (off the table, waiting to buy back in)
  const players = snap.seats.filter((s) => s.occupied || s.status === "busted");
  const [target, setTarget] = useState<number | null>(players[0]?.seatIndex ?? null);
  const buyIn = snap.buyIn || 100;
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState(buyIn);
  const sel = target !== null ? snap.seats[target] : null;

  const offer = () => {
    if (target === null || amount <= 0) return;
    emit("offer_buyin", { seatIndex: target, amount });
    onClose();
  };

  return (
    <>
      <div onClick={onClose} className="absolute inset-0 z-50 animate-pn-fade bg-[rgba(8,12,9,.62)] backdrop-blur-sm" />
      <div className="absolute inset-x-4 top-1/2 z-[51] -translate-y-1/2 animate-pn-pop rounded-3xl border border-white/10 bg-panel-2 p-5 shadow-[0_30px_70px_rgba(0,0,0,.6)]">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-xl font-bold">Set chips</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-cream-2">
            ✕
          </button>
        </div>
        <p className="mb-4 text-[13px] text-muted">
          Offer a buy-in the player accepts on their screen.
        </p>
        <div className="mb-4 flex gap-2.5 overflow-x-auto px-1 py-1.5">
          {players.map((s) => (
            <button
              key={s.seatIndex}
              onClick={() => setTarget(s.seatIndex)}
              className="flex flex-none flex-col items-center gap-1.5"
            >
              <Avatar
                name={s.nickname}
                className={`h-[52px] w-[52px] rounded-full text-base ${
                  target === s.seatIndex
                    ? "ring-2 ring-amber ring-offset-2 ring-offset-panel-2"
                    : "opacity-70"
                }`}
              />
              <span className="text-[11px] text-muted">{s.nickname}</span>
              {s.status === "busted" ? (
                <span className="text-[10px] font-extrabold tracking-wide text-clay-soft">OUT</span>
              ) : (
                <span className={`text-[11px] font-bold ${s.chips < 0 ? "text-clay-soft" : "text-cream-2"}`}>
                  {s.chips}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mb-2.5 flex gap-2.5">
          <button
            onClick={() => {
              setCustom(false);
              setAmount(buyIn);
            }}
            className={`h-12 flex-1 rounded-xl font-display text-[15px] font-bold ${
              !custom
                ? "border-[1.5px] border-amber bg-amber/[0.14] text-amber"
                : "border border-white/12 bg-white/[0.04] text-cream-2"
            }`}
          >
            Buy-in · {buyIn}
          </button>
          <button
            onClick={() => setCustom(true)}
            className={`h-12 flex-1 rounded-xl font-display text-[15px] font-bold ${
              custom
                ? "border-[1.5px] border-amber bg-amber/[0.14] text-amber"
                : "border border-white/12 bg-white/[0.04] text-cream-2"
            }`}
          >
            Custom
          </button>
        </div>
        {custom && (
          <input
            type="number"
            min={1}
            value={amount}
            autoFocus
            onChange={(e) => setAmount(Math.max(1, +e.target.value))}
            className="input mb-2.5 font-display font-bold text-amber"
          />
        )}
        <button
          onClick={offer}
          disabled={target === null}
          className="h-12 w-full rounded-xl bg-amber font-display text-[15px] font-bold text-amber-ink disabled:opacity-40"
        >
          Offer buy-in {sel ? `to ${sel.nickname}` : ""}
        </button>
      </div>
    </>
  );
}

// Player-facing prompt when the host offers them a buy-in.
function BuyInOffer({
  amount,
  emit,
}: {
  amount: number;
  emit: (e: string, p?: unknown) => void;
}) {
  return (
    <>
      <div className="absolute inset-0 z-[58] animate-pn-fade bg-[rgba(8,12,9,.7)] backdrop-blur-sm" />
      <div className="absolute inset-x-4 top-1/2 z-[59] -translate-y-1/2 animate-pn-pop rounded-3xl border border-amber/30 bg-panel-2 p-6 text-center shadow-[0_30px_70px_rgba(0,0,0,.6)]">
        <div className="mb-1 text-3xl">🪙</div>
        <h2 className="font-display text-xl font-bold">Buy in?</h2>
        <p className="mb-5 mt-1 text-[14px] text-muted">
          The host is offering you{" "}
          <span className="font-bold text-amber">{amount}</span> chips.
        </p>
        <div className="flex gap-2.5">
          <button
            onClick={() => emit("respond_buyin", { accept: false })}
            className="h-12 flex-1 rounded-xl border border-white/12 font-display text-[15px] font-bold text-cream-2"
          >
            No thanks
          </button>
          <button
            onClick={() => emit("respond_buyin", { accept: true })}
            className="h-12 flex-1 rounded-xl bg-amber font-display text-[15px] font-bold text-amber-ink"
          >
            Buy in {amount}
          </button>
        </div>
      </div>
    </>
  );
}

// The host busted out: buy back in (and stay host) or hand the badge to a
// player who still has chips. Blocking — there's no dismiss; the host must pick.
function HostDecisionModal({
  snap,
  emit,
}: {
  snap: RoomSnapshot;
  emit: (e: string, p?: unknown) => void;
}) {
  const candidates = snap.seats.filter((s) => s.occupied && !s.isYou && s.chips > 0);
  const [mode, setMode] = useState<"choose" | "buyin" | "transfer">("choose");
  const [amount, setAmount] = useState(snap.buyIn || 100);
  const [target, setTarget] = useState<number | null>(candidates[0]?.seatIndex ?? null);

  return (
    <>
      <div className="absolute inset-0 z-[58] animate-pn-fade bg-[rgba(8,12,9,.78)] backdrop-blur-sm" />
      <div className="absolute inset-x-4 top-1/2 z-[59] -translate-y-1/2 animate-pn-pop rounded-3xl border border-amber/30 bg-panel-2 p-6 shadow-[0_30px_70px_rgba(0,0,0,.6)]">
        <div className="mb-1 text-center text-3xl">👑</div>
        <h2 className="text-center font-display text-xl font-bold">You&apos;re out of chips</h2>
        <p className="mb-5 mt-1 text-center text-[13px] text-muted">
          You&apos;re the host. Buy back in to keep hosting, or hand the badge to another player.
        </p>

        {mode === "choose" && (
          <div className="flex flex-col gap-2.5">
            <button
              onClick={() => setMode("buyin")}
              className="h-12 w-full rounded-xl bg-amber font-display text-[15px] font-bold text-amber-ink"
            >
              Buy back in
            </button>
            <button
              onClick={() => setMode("transfer")}
              disabled={candidates.length === 0}
              className="h-12 w-full rounded-xl border border-white/12 font-display text-[15px] font-bold text-cream-2 disabled:opacity-40"
            >
              Transfer host{candidates.length === 0 ? " (no one with chips)" : ""}
            </button>
          </div>
        )}

        {mode === "buyin" && (
          <div className="flex flex-col gap-2.5">
            <input
              type="number"
              min={1}
              value={amount}
              autoFocus
              onChange={(e) => setAmount(Math.max(1, +e.target.value))}
              className="input font-display font-bold text-amber"
            />
            <button
              onClick={() => emit("host_buyin", { amount })}
              disabled={amount <= 0}
              className="h-12 w-full rounded-xl bg-amber font-display text-[15px] font-bold text-amber-ink disabled:opacity-40"
            >
              Buy in {amount} &amp; stay host
            </button>
            <button
              onClick={() => setMode("choose")}
              className="h-11 w-full rounded-xl border border-white/12 font-display text-sm font-bold text-cream-2"
            >
              Back
            </button>
          </div>
        )}

        {mode === "transfer" && (
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-2.5 overflow-x-auto px-1 py-1.5">
              {candidates.map((s) => (
                <button
                  key={s.seatIndex}
                  onClick={() => setTarget(s.seatIndex)}
                  className="flex flex-none flex-col items-center gap-1.5"
                >
                  <Avatar
                    name={s.nickname}
                    className={`h-[52px] w-[52px] rounded-full text-base ${
                      target === s.seatIndex
                        ? "ring-2 ring-amber ring-offset-2 ring-offset-panel-2"
                        : "opacity-70"
                    }`}
                  />
                  <span className="text-[11px] text-muted">{s.nickname}</span>
                  <span className="text-[11px] font-bold text-cream-2">{s.chips}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => target !== null && emit("transfer_host", { seatIndex: target })}
              disabled={target === null}
              className="h-12 w-full rounded-xl bg-amber font-display text-[15px] font-bold text-amber-ink disabled:opacity-40"
            >
              Make {target !== null ? snap.seats[target]?.nickname : ""} host
            </button>
            <button
              onClick={() => setMode("choose")}
              className="h-11 w-full rounded-xl border border-white/12 font-display text-sm font-bold text-cream-2"
            >
              Back
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// Room-wide popup announcing the host changed (auto-dismisses).
function HostChangedPopup({ nickname, onClose }: { nickname: string; onClose: () => void }) {
  useEffect(() => {
    const id = setTimeout(onClose, 4000);
    return () => clearTimeout(id);
  }, [onClose]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-[90] flex justify-center px-6">
      <div
        onClick={onClose}
        className="pointer-events-auto flex max-w-sm animate-pn-pop items-center gap-3 rounded-2xl border border-amber/40 bg-panel-2 px-4 py-3 shadow-[0_18px_44px_rgba(0,0,0,.55)]"
      >
        <span className="text-xl">👑</span>
        <div>
          <div className="font-display text-sm font-bold text-amber">Host changed</div>
          <div className="mt-0.5 text-[13px] text-cream-2">{nickname} is now the host.</div>
        </div>
      </div>
    </div>
  );
}

// Room-wide announcement when the 7-2 rule fires.
function SevenDeuceNotice({
  notice,
  onClose,
}: {
  notice: SevenDeucePayload;
  onClose: () => void;
}) {
  return (
    <>
      <div className="absolute inset-0 z-[60] animate-pn-fade bg-[rgba(8,12,9,.72)] backdrop-blur-sm" />
      <div className="absolute inset-x-4 top-1/2 z-[61] -translate-y-1/2 animate-pn-pop rounded-3xl border border-amber/30 bg-panel-2 p-6 text-center shadow-[0_30px_70px_rgba(0,0,0,.6)]">
        <div className="mb-2 text-3xl">7️⃣2️⃣</div>
        <p className="font-display text-lg font-bold leading-snug">
          Everyone must pay {notice.winners.join(" & ")} because of the 7-2 rule
        </p>
        <p className="mt-1 text-[13px] text-muted">{notice.perPlayer} chips each</p>
        <button
          onClick={onClose}
          className="mt-5 h-12 w-full rounded-xl bg-amber font-display text-[15px] font-bold text-amber-ink"
        >
          Continue
        </button>
      </div>
    </>
  );
}

function HistoryDrawer({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const hands = [...(snap.handHistory ?? [])].reverse();
  const [confirm, setConfirm] = useState<number | null>(null);
  return (
    <>
      <div onClick={onClose} className="absolute inset-0 z-50 animate-pn-fade bg-[rgba(8,12,9,.6)] backdrop-blur-sm" />
      <div className="absolute inset-x-0 bottom-0 z-[51] flex h-[78%] animate-pn-up flex-col rounded-t-3xl border-t border-white/10 bg-panel shadow-[0_-20px_50px_rgba(0,0,0,.6)]">
        <div className="px-5 pb-1.5 pt-4">
          <div className="mx-auto mb-3.5 h-1 w-10 rounded-full bg-white/20" />
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-bold">Hand history</h2>
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-cream-2">
              ✕
            </button>
          </div>
          {snap.youAreHost && (
            <button
              onClick={() => emit("undo_last_action")}
              disabled={!snap.canUndo}
              className="mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/14 bg-white/[0.05] font-display text-sm font-bold text-cream-2 disabled:opacity-40"
            >
              ↩ Undo last action
            </button>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 pb-6 pt-3.5">
          {hands.length === 0 && (
            <p className="py-8 text-center text-sm text-muted">No hands played yet.</p>
          )}
          {hands.map((h) => {
            const later = snap.handNumber - h.handNumber;
            return (
              <div
                key={h.handNumber}
                className={`rounded-2xl border bg-field p-3.5 ${
                  confirm === h.handNumber ? "border-clay/40" : "border-white/[0.06]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold">{h.summary}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {new Date(h.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                  {snap.youAreHost && (
                    <button
                      onClick={() => setConfirm(h.handNumber)}
                      className="flex-none rounded-lg border border-white/12 bg-white/[0.04] px-2.5 py-1.5 font-display text-[11.5px] font-bold text-muted-3"
                    >
                      Roll back
                    </button>
                  )}
                </div>
                {snap.youAreHost && confirm === h.handNumber && (
                  <div className="mt-3 rounded-xl border border-clay/30 bg-clay/10 p-3">
                    <div className="text-[13.5px] font-bold text-clay-soft">
                      Roll back to before Hand #{h.handNumber}?
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-snug text-muted-4">
                      This permanently undoes {later} later hand(s) and restores every
                      stack to this point.
                    </div>
                    <div className="mt-3 flex gap-2.5">
                      <button
                        onClick={() => setConfirm(null)}
                        className="h-10 flex-1 rounded-xl border border-white/14 bg-white/[0.05] font-display text-[13px] font-bold text-cream-2"
                      >
                        Keep playing
                      </button>
                      <button
                        onClick={() => {
                          emit("rollback_hand", { targetHandNumber: h.handNumber });
                          setConfirm(null);
                          onClose();
                        }}
                        className="h-10 flex-1 rounded-xl bg-clay font-display text-[13px] font-bold text-white"
                      >
                        Roll back
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ---------------- cheeky bets ----------------
function CheekyBetModal({
  snap,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const me = snap.seats.find((s) => s.isYou);
  const folded = snap.seats.filter(
    (s) => s.occupied && s.status === "folded" && !s.isYou
  );
  const [target, setTarget] = useState<number | null>(folded[0]?.seatIndex ?? null);
  const [pred, setPred] = useState<CheekyPrediction>("mine-better");
  const targetSeat = target !== null ? snap.seats[target] : null;
  // both sides must cover the wager, so the cap is the smaller stack
  const maxWager = Math.max(
    1,
    Math.min(me?.chips ?? 1, targetSeat?.chips ?? me?.chips ?? 1)
  );
  const [amount, setAmount] = useState(Math.min(20, maxWager));
  // free-typing box: hold raw text while editing, commit (clamped) on blur/Enter
  const [betText, setBetText] = useState<string | null>(null);
  const commit = () => {
    const n = parseInt(betText ?? "", 10);
    setAmount(Number.isFinite(n) ? Math.min(Math.max(n, 1), maxWager) : amount);
    setBetText(null);
  };
  const amt = Math.min(Math.max(amount, 1), maxWager);

  const send = () => {
    if (target === null) return;
    emit("request_cheeky_bet", {
      opponentSeatIndex: target,
      prediction: pred,
      amount: amt,
    });
    onClose();
  };

  return (
    <ModalShell onClose={onClose} accent>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg text-amber">♦</span>
          <h2 className="font-display text-xl font-bold">Cheeky bet</h2>
        </div>
        <CloseX onClose={onClose} />
      </div>
      <p className="mb-4 mt-1.5 text-[13px] leading-snug text-muted">
        You&apos;ve folded — wager on whose hand wins at showdown. Settles
        automatically.
      </p>

      <Label>PICK A FOLDED OPPONENT</Label>
      <div className="mb-4 flex gap-3">
        {folded.map((s) => (
          <button
            key={s.seatIndex}
            onClick={() => setTarget(s.seatIndex)}
            className="flex flex-col items-center gap-1.5"
          >
            <Avatar
              name={s.nickname}
              className={`h-[52px] w-[52px] rounded-2xl text-base ${
                target === s.seatIndex ? "ring-2 ring-amber" : "opacity-70"
              }`}
            />
            <span className="text-xs font-semibold text-cream-2">{s.nickname}</span>
          </button>
        ))}
        {folded.length === 0 && (
          <p className="text-[13px] text-muted">No other folded players right now.</p>
        )}
      </div>

      <Label>YOUR CALL</Label>
      <div className="mb-4 flex gap-2.5">
        {(
          [
            ["mine-better", "My hand wins"],
            ["theirs-better", "Theirs wins"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setPred(v)}
            className={`h-12 flex-1 rounded-xl border font-display text-[13.5px] font-bold ${
              pred === v
                ? "border-amber bg-amber/[0.14] text-amber"
                : "border-white/12 bg-white/[0.04] text-cream-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Label>WAGER</Label>
      <div className="mb-3.5 flex items-center gap-2.5">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={maxWager}
          value={betText ?? amt}
          onFocus={() => setBetText(String(amt))}
          onChange={(e) => setBetText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-12 w-[88px] flex-none rounded-xl border border-white/12 bg-field px-2 text-center font-display text-[16px] font-bold text-amber outline-none focus:border-amber/50"
        />
        <input
          type="range"
          min={1}
          max={maxWager}
          value={amt}
          onChange={(e) => setAmount(+e.target.value)}
          className="h-2 flex-1 accent-amber"
        />
        <button
          onClick={() => setAmount(maxWager)}
          className="h-11 flex-none rounded-xl border border-amber/40 bg-amber/[0.12] px-3 font-display text-[12px] font-bold text-amber"
        >
          Max
        </button>
      </div>
      <InfoNote>Both stakes lock in escrow until the board runs out.</InfoNote>
      <button
        onClick={send}
        disabled={target === null}
        className="h-14 w-full rounded-2xl bg-amber font-display text-base font-bold text-amber-ink disabled:opacity-40"
      >
        Send {amt}-chip bet{targetSeat ? ` to ${targetSeat.nickname}` : ""}
      </button>
    </ModalShell>
  );
}

function CheekyIncomingModal({
  req,
  onClose,
  emit,
}: {
  req: CheekyBetRequestPayload;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  // The prediction is the bettor's. "mine-better" => they bet *their* hand wins.
  const theirHand = req.prediction === "mine-better";
  const respond = (accept: boolean) => {
    emit("respond_cheeky_bet", { betId: req.betId, accept });
    onClose();
  };
  return (
    <ModalShell onClose={onClose} accent>
      <div className="px-1 text-center">
        <Avatar
          name={req.fromNickname}
          className="mx-auto mb-3.5 h-[60px] w-[60px] rounded-2xl text-xl"
        />
        <h2 className="font-display text-xl font-bold">
          {req.fromNickname} wants a cheeky bet
        </h2>
        <p className="mt-2 px-1.5 text-sm leading-relaxed text-muted-4">
          {req.fromNickname} bets <b className="text-amber">{req.amount}</b> that{" "}
          <b className="text-cream">{theirHand ? "their" : "your"}</b> hand beats{" "}
          {theirHand ? "yours" : "theirs"} at showdown.
        </p>
      </div>
      <div className="mt-5 flex gap-2.5">
        <button
          onClick={() => respond(false)}
          className="h-14 flex-1 rounded-2xl border-[1.5px] border-clay/40 bg-clay/10 font-display text-base font-bold text-clay-soft"
        >
          Decline
        </button>
        <button
          onClick={() => respond(true)}
          className="h-14 flex-[1.3] rounded-2xl bg-amber font-display text-base font-bold text-amber-ink"
        >
          Accept · {req.amount}
        </button>
      </div>
    </ModalShell>
  );
}

function CheekySettledModal({
  settled,
  onClose,
}: {
  settled: CheekyBetSettledPayload;
  onClose: () => void;
}) {
  const push = settled.result === "push";
  const winner = settled.youWon ? settled.youNickname : settled.themNickname;
  const loser = settled.youWon ? settled.themNickname : settled.youNickname;
  return (
    <ModalShell onClose={onClose}>
      <div className="px-1 text-center">
        <h2
          className={`font-display text-xl font-bold ${
            push ? "text-cream" : "text-amber"
          }`}
        >
          {push ? "Cheeky bet pushed" : `${winner} beat ${loser}`}
        </h2>

        {/* loser (grey) → amount → winner (lit). Push shows both lit, no arrow. */}
        <div className="mt-5 flex items-center justify-center gap-3">
          <CheekyFace
            name={push ? settled.themNickname : loser}
            lit={push}
            tag={push ? "Push" : "Folded out"}
          />
          <div className="flex flex-col items-center">
            <span className="font-display text-base font-bold text-amber">
              {push ? "↔" : "→"}
            </span>
            <span className="mt-0.5 font-display text-[13px] font-bold text-amber-soft">
              {fmt(settled.amount)}
            </span>
          </div>
          <CheekyFace
            name={push ? settled.youNickname : winner}
            lit
            tag={push ? "Push" : "Win"}
            win={!push}
          />
        </div>

        <p className="mt-4 text-sm text-muted-4">
          {settled.delta !== 0 ? (
            <b className={settled.youWon ? "text-green" : "text-clay-soft"}>
              {settled.delta > 0 ? `+${settled.delta}` : settled.delta} chips
            </b>
          ) : (
            <span>Stakes returned</span>
          )}{" "}
          from escrow.
        </p>
      </div>
      <button
        onClick={onClose}
        className="mt-5 h-14 w-full rounded-2xl bg-amber font-display text-base font-bold text-amber-ink"
      >
        Back to table
      </button>
    </ModalShell>
  );
}

// One side of a settled cheeky bet: avatar + name + a small tag, greyed when
// it lost, ringed green when it won.
function CheekyFace({
  name,
  lit,
  tag,
  win,
}: {
  name: string;
  lit: boolean;
  tag: string;
  win?: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center gap-1.5"
      style={{ opacity: lit ? 1 : 0.4, filter: lit ? "none" : "grayscale(1)" }}
    >
      <Avatar
        name={name}
        className={`h-[60px] w-[60px] rounded-2xl text-xl ${win ? "ring-2 ring-green" : ""}`}
      />
      <span className="text-[13px] font-bold text-cream">{name}</span>
      <span
        className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide ${
          win ? "bg-green/[0.16] text-green" : "bg-white/[0.06] text-muted-2"
        }`}
      >
        {tag}
      </span>
    </div>
  );
}

// ---------------- card peeks ----------------
function PeekRequestModal({
  snap,
  targetSeatIndex,
  onClose,
  emit,
}: {
  snap: RoomSnapshot;
  targetSeatIndex: number;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const tgt = snap.seats[targetSeatIndex];
  const ask = () => {
    emit("request_card_peek", { targetSeatIndex });
    onClose();
  };
  return (
    <ModalShell onClose={onClose} center>
      <Avatar
        name={tgt.nickname}
        className="mx-auto mb-3.5 h-[60px] w-[60px] rounded-2xl text-xl"
      />
      <h2 className="font-display text-xl font-bold">Peek at {tgt.nickname}&apos;s hand?</h2>
      <p className="mt-2 px-1 text-[13.5px] leading-relaxed text-muted-4">
        You&apos;ve both folded, so it&apos;s fair game. {tgt.nickname} has to
        accept — and only you will see the cards.
      </p>
      <div className="mt-5 flex gap-2.5">
        <button
          onClick={onClose}
          className="h-13 flex-1 rounded-2xl border border-white/14 bg-white/[0.05] py-3.5 font-display text-[15px] font-bold text-cream-2"
        >
          Cancel
        </button>
        <button
          onClick={ask}
          className="h-13 flex-[1.3] rounded-2xl bg-amber py-3.5 font-display text-[15px] font-bold text-amber-ink"
        >
          Ask to see
        </button>
      </div>
    </ModalShell>
  );
}

function PeekIncomingModal({
  req,
  onClose,
  emit,
}: {
  req: CardPeekRequestEventPayload;
  onClose: () => void;
  emit: (e: string, p?: unknown) => void;
}) {
  const respond = (accept: boolean) => {
    emit("respond_card_peek", { requestId: req.requestId, accept });
    onClose();
  };
  return (
    <ModalShell onClose={onClose} center>
      <div className="mb-3 text-4xl">◉</div>
      <h2 className="font-display text-xl font-bold">
        {req.fromNickname} wants to peek
      </h2>
      <p className="mt-2 px-1 text-[13.5px] leading-relaxed text-muted-4">
        You&apos;ve both folded. Show {req.fromNickname} your hand? Only they will
        see it.
      </p>
      <div className="mt-5 flex gap-2.5">
        <button
          onClick={() => respond(false)}
          className="flex-1 rounded-2xl border border-white/14 bg-white/[0.05] py-3.5 font-display text-[15px] font-bold text-cream-2"
        >
          Keep hidden
        </button>
        <button
          onClick={() => respond(true)}
          className="flex-[1.3] rounded-2xl bg-amber py-3.5 font-display text-[15px] font-bold text-amber-ink"
        >
          Show them
        </button>
      </div>
    </ModalShell>
  );
}

function PeekRevealModal({
  reveal,
  onClose,
}: {
  reveal: CardPeekResultPayload;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose} center>
      <div className="mb-1 flex items-center justify-center gap-2">
        <Avatar name={reveal.nickname} className="h-7 w-7 rounded-lg text-[11px]" />
        <h2 className="font-display text-lg font-bold">{reveal.nickname} showed you</h2>
      </div>
      <div className="my-6 flex justify-center gap-3">
        {reveal.holeCards.map((c, i) => (
          <PlayingCard key={i} card={c} className="h-[104px] w-[74px] text-[34px]" />
        ))}
      </div>
      <div className="inline-flex items-center gap-2 rounded-xl border border-amber/20 bg-amber/[0.10] px-3.5 py-2 text-[12.5px] text-amber-soft">
        🔒 Private — only you can see this
      </div>
      <button
        onClick={onClose}
        className="mt-5 h-13 w-full rounded-2xl bg-amber py-3.5 font-display text-[15px] font-bold text-amber-ink"
      >
        Done
      </button>
    </ModalShell>
  );
}

// ---------------- recap ----------------
function RecapOverlay({
  recap,
  onClose,
  onLeave,
}: {
  recap: SessionRecapPayload;
  onClose: () => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const mins = Math.round(recap.durationMs / 60000);
  const medal = (i: number) =>
    ["#e0a23b", "#cdd6cf", "#b9842a"][i] ?? "#5d6b62";

  const summaryText = () => {
    const lines = recap.standings.map(
      (p, i) =>
        `${i + 1}. ${p.nickname} — ${fmt(p.chips)} (${
          p.netChips >= 0 ? "+" : ""
        }${fmt(p.netChips)})`
    );
    const biggest = recap.biggestPot
      ? `Biggest pot: ${fmt(recap.biggestPot.amount)} (Hand #${recap.biggestPot.handNumber})`
      : "";
    return `🃏 PokerNight recap — ${recap.handsPlayed} hands\n${biggest}\n\n${lines.join("\n")}`;
  };

  const copy = () => {
    navigator.clipboard?.writeText(summaryText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="absolute inset-0 z-[60] flex animate-pn-fade flex-col bg-screen">
      <div className="px-6 pb-2.5 pt-6 text-center">
        <div className="font-display text-[13px] font-bold tracking-[3px] text-amber">
          ♠ THAT&apos;S A WRAP
        </div>
        <div className="mt-1.5 text-[13px] text-muted">
          {recap.handsPlayed} hands · {mins}m at the table
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <div className="mb-4 flex gap-3">
          <div className="flex-1 rounded-2xl border border-white/[0.06] bg-field p-3.5">
            <div className="text-[11px] font-bold tracking-wide text-muted">
              HANDS PLAYED
            </div>
            <div className="mt-1 font-display text-[26px] font-bold">
              {recap.handsPlayed}
            </div>
          </div>
          <div className="flex-1 rounded-2xl border border-amber/[0.22] bg-gradient-to-br from-amber/[0.16] to-amber/[0.04] p-3.5">
            <div className="text-[11px] font-bold tracking-wide text-amber-soft">
              BIGGEST POT
            </div>
            <div className="mt-1 font-display text-[26px] font-bold text-amber">
              {recap.biggestPot ? fmt(recap.biggestPot.amount) : "—"}
            </div>
            {recap.biggestPot && (
              <div className="text-[11px] text-muted">
                Hand #{recap.biggestPot.handNumber}
              </div>
            )}
          </div>
        </div>

        <div className="mb-2.5 text-[11.5px] font-bold tracking-wide text-muted">
          FINAL STANDINGS
        </div>
        <div className="flex flex-col gap-2.5">
          {recap.standings.map((p, i) => (
            <div
              key={p.sessionId}
              className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-field p-3"
            >
              <div
                className="w-6 text-center font-display text-[15px] font-bold"
                style={{ color: medal(i) }}
              >
                {i + 1}
              </div>
              <Avatar name={p.nickname} className="h-10 w-10 rounded-xl text-sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{p.nickname}</div>
                <div className="mt-0.5 text-[11.5px] text-muted">
                  {p.handsWon} won · {p.foldCount} folds · bought in {fmt(p.buyIn)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-display text-base font-bold">{fmt(p.chips)}</div>
                <div
                  className={`font-display text-xs font-bold ${
                    p.netChips >= 0 ? "text-green" : "text-clay-soft"
                  }`}
                >
                  {p.netChips >= 0 ? "+" : ""}
                  {fmt(p.netChips)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5 border-t border-white/[0.06] px-5 pb-7 pt-3.5">
        <button
          onClick={copy}
          className="h-14 w-full rounded-2xl bg-amber font-display text-base font-bold text-amber-ink shadow-[0_8px_22px_rgba(224,162,59,.26)]"
        >
          {copied ? "Copied to clipboard ✓" : "Copy summary"}
        </button>
        <div className="flex gap-2.5">
          <button
            onClick={onClose}
            className="h-13 flex-1 rounded-2xl border border-white/14 bg-white/[0.04] py-3.5 font-display text-[15px] font-bold text-cream"
          >
            Back to table
          </button>
          <button
            onClick={onLeave}
            className="h-13 flex-1 rounded-2xl border border-white/14 bg-white/[0.04] py-3.5 font-display text-[15px] font-bold text-cream"
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- small modal primitives ----------------
function ModalShell({
  children,
  onClose,
  accent = false,
  center = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  accent?: boolean;
  center?: boolean;
}) {
  return (
    <>
      <div
        onClick={onClose}
        className="absolute inset-0 z-50 animate-pn-fade bg-[rgba(8,12,9,.62)] backdrop-blur-sm"
      />
      <div
        className={`absolute inset-x-4 top-1/2 z-[51] -translate-y-1/2 animate-pn-pop rounded-3xl border bg-panel-2 p-5 shadow-[0_30px_70px_rgba(0,0,0,.6)] ${
          accent ? "border-amber/25" : "border-white/10"
        } ${center ? "text-center" : ""}`}
      >
        {children}
      </div>
    </>
  );
}

function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-cream-2"
    >
      ✕
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 text-[11.5px] font-bold tracking-wide text-muted">
      {children}
    </div>
  );
}

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber/20 bg-amber/[0.08] px-3.5 py-2.5 text-[12.5px] text-amber-soft">
      <span>ⓘ</span> {children}
    </div>
  );
}
