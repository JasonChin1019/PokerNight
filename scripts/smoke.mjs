// Quick end-to-end socket smoke test against a running server.
// Usage: node scripts/smoke.mjs [port]
import { io } from "socket.io-client";

const PORT = process.argv[2] || 3939;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mk() {
  return io(URL, { forceNew: true, transports: ["websocket"] });
}

const A = mk();
const B = mk();
let roomCode;
let aSnap, bSnap;
let gotResult = false;

A.on("room_state", (s) => (aSnap = s));
B.on("room_state", (s) => (bSnap = s));
A.on("hand_result", (r) => {
  gotResult = true;
  console.log("hand_result winners:", r.winners, "—", r.summary);
});
A.on("error", (e) => console.log("A error:", e.message));
B.on("error", (e) => console.log("B error:", e.message));

const ackCreate = () =>
  new Promise((res) =>
    A.emit(
      "create_room",
      { nickname: "Alice", sessionId: "A", mode: "full-deal", maxSeats: 2, buyIn: 1000, smallBlind: 10, bigBlind: 20 },
      res
    )
  );
const ackJoin = (code) =>
  new Promise((res) =>
    B.emit("join_room", { roomCode: code, nickname: "Bob", sessionId: "B", role: "player" }, res)
  );

// drive both players to call/check until the hand ends
async function playOut() {
  for (let i = 0; i < 60; i++) {
    await wait(120);
    for (const [c, snap] of [[A, aSnap], [B, bSnap]]) {
      if (!snap || snap.yourSeatIndex === null) continue;
      if (snap.currentActorIndex !== snap.yourSeatIndex) continue;
      if (snap.round === "waiting") continue;
      const me = snap.seats[snap.yourSeatIndex];
      const highest = Math.max(0, ...snap.seats.map((s) => s.currentBet));
      const toCall = highest - me.currentBet;
      c.emit("player_action", { type: toCall > 0 ? "call" : "check" });
    }
    if (gotResult) return true;
  }
  return false;
}

(async () => {
  const r = await ackCreate();
  roomCode = r.roomCode;
  console.log("created room:", roomCode, "ok:", r.ok);
  const jr = await ackJoin(roomCode);
  console.log("Bob joined ok:", jr.ok);
  await wait(200);
  A.emit("start_hand");
  await wait(300);
  console.log("after start: round =", aSnap?.round, "pot =", aSnap?.pot);
  console.log(
    "Alice sees own cards:",
    aSnap?.seats[0]?.holeCards?.length === 2,
    "| Alice sees Bob cards (should be false):",
    aSnap?.seats[1]?.holeCards !== null
  );
  const done = await playOut();
  const total = aSnap.seats.reduce((n, s) => n + s.chips, 0);
  console.log("hand finished:", done, "| chips conserved (=2000):", total);
  console.log("RESULT:", done && total === 2000 && aSnap.seats[1].holeCards === null ? "PASS ✅" : "FAIL ❌");
  A.close();
  B.close();
  process.exit(0);
})();
