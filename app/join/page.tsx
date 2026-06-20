"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSocket, getSessionId, getNickname, setNickname } from "@/lib/client/socket";

export default function JoinPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [nickname, setNick] = useState("");
  useEffect(() => {
    setNick(getNickname());
    // Pre-fill the room code when arriving via a QR deep link (?code=ROOMCODE).
    const fromLink = new URLSearchParams(window.location.search).get("code");
    if (fromLink) setCode(fromLink.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  }, []);
  const [role, setRole] = useState<"player" | "spectator">("player");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function submit() {
    if (code.trim().length < 4) return setErr("Enter the room code.");
    if (!nickname.trim()) return setErr("Pick a nickname first.");
    setBusy(true);
    setErr("");
    setNickname(nickname.trim());
    const roomCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    getSocket().emit(
      "join_room",
      { roomCode, nickname: nickname.trim(), sessionId: getSessionId(), role },
      (r: { ok: boolean; message?: string }) => {
        if (r.ok) router.push(`/room/${roomCode}?role=${role}`);
        else {
          setErr(r.message || "Couldn't join.");
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
        <h1 className="font-display text-2xl font-bold">Join a game</h1>
      </header>

      <div className="flex flex-1 flex-col gap-6 py-3">
        <div>
          <div className="mb-2.5 text-center text-[12.5px] font-semibold tracking-wide text-muted">
            ROOM CODE
          </div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="4R9KZ"
            maxLength={6}
            className="input text-center font-display text-2xl font-bold tracking-[6px]"
          />
        </div>

        <div>
          <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted">
            YOUR NICKNAME
          </div>
          <input
            value={nickname}
            onChange={(e) => setNick(e.target.value)}
            placeholder="e.g. Sam"
            maxLength={16}
            className="input"
          />
        </div>

        <div>
          <div className="mb-2.5 text-[12.5px] font-semibold tracking-wide text-muted">
            HOW DO YOU WANT TO JOIN?
          </div>
          <div className="flex gap-2.5 rounded-2xl border border-white/[0.07] bg-field-2 p-1.5">
            {(["player", "spectator"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`h-[50px] flex-1 rounded-xl font-display text-[15px] font-bold ${
                  role === r ? "bg-amber text-amber-ink" : "text-muted-3"
                }`}
              >
                {r === "player" ? "Play" : "Spectate"}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
            <span className="text-base text-amber">{role === "player" ? "♠" : "◉"}</span>
            <p className="text-[13.5px] leading-relaxed text-muted-4">
              {role === "player"
                ? "You'll be dealt into the next hand with a fresh chip stack."
                : "Spectators watch the table. If the host deals cards online, you'll see every hand face-up with live win odds."}
            </p>
          </div>
        </div>

        {err && <p className="text-sm text-clay-soft">{err}</p>}
      </div>

      <button
        onClick={submit}
        disabled={busy}
        className="mt-3 h-14 rounded-2xl bg-amber font-display text-lg font-bold text-amber-ink shadow-[0_8px_22px_rgba(224,162,59,.26)] disabled:opacity-60"
      >
        {busy ? "Joining…" : role === "player" ? "Join as player" : "Watch as spectator"}
      </button>
    </main>
  );
}
