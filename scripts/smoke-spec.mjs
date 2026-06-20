// Spectator path: must receive everyone's hole cards + equity (full-deal).
import { io } from "socket.io-client";
const PORT = process.argv[2] || 3939;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => io(URL, { forceNew: true, transports: ["websocket"] });

const A = mk(), B = mk(), S = mk();
let sSnap, equity;
S.on("room_state", (s) => (sSnap = s));
S.on("equity_update", (p) => (equity = p.perSeatWinPct));

const create = () => new Promise((r) => A.emit("create_room", { nickname: "Alice", sessionId: "A", mode: "full-deal", maxSeats: 3, buyIn: 1000, smallBlind: 10, bigBlind: 20 }, r));
const join = (c, id, nick, role) => new Promise((r) => (id === "B" ? B : S).emit("join_room", { roomCode: c, nickname: nick, sessionId: id, role }, r));

(async () => {
  const { roomCode } = await create();
  await join(roomCode, "B", "Bob", "player");
  await join(roomCode, "S", "Sky", "spectator");
  await wait(200);
  A.emit("start_hand");
  await wait(600); // let equity Monte Carlo run
  const allCardsVisible = sSnap.seats.filter((s) => s.occupied && s.status !== "empty").every((s) => Array.isArray(s.holeCards) && s.holeCards.length === 2);
  const hasEquity = equity && Object.keys(equity).length >= 2;
  console.log("spectator sees all hole cards:", allCardsVisible);
  console.log("spectator got equity:", hasEquity, equity);
  console.log("RESULT:", allCardsVisible && hasEquity ? "PASS ✅" : "FAIL ❌");
  process.exit(0);
})();
