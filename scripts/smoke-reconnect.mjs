// Reconnect path: a refreshed tab (same sessionId) keeps its seat & chips.
import { io } from "socket.io-client";
const PORT = process.argv[2] || 3939;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => io(URL, { forceNew: true, transports: ["websocket"] });

const create = (sock) => new Promise((r) => sock.emit("create_room", { nickname: "Alice", sessionId: "A", mode: "full-deal", maxSeats: 2, buyIn: 1000, smallBlind: 10, bigBlind: 20 }, r));
const join = (sock, code, id, nick) => new Promise((r) => sock.emit("join_room", { roomCode: code, nickname: nick, sessionId: id, role: "player" }, r));

(async () => {
  const A = mk();
  let aSnap; A.on("room_state", (s) => (aSnap = s));
  const { roomCode } = await create(A);

  let B = mk();
  let bSnap; B.on("room_state", (s) => (bSnap = s));
  await join(B, roomCode, "B", "Bob");
  await wait(150);
  A.emit("start_hand");
  await wait(300);
  const seatBefore = bSnap.yourSeatIndex;
  const chipsBefore = bSnap.seats[seatBefore].chips;
  const cardsBefore = JSON.stringify(bSnap.seats[seatBefore].holeCards);

  // simulate refresh: drop the socket, make a brand-new one, rejoin same session
  B.close();
  await wait(300);
  B = mk();
  B.on("room_state", (s) => (bSnap = s));
  await join(B, roomCode, "B", "Bob");
  await wait(300);

  const seatAfter = bSnap.yourSeatIndex;
  const chipsAfter = bSnap.seats[seatAfter].chips;
  const cardsAfter = JSON.stringify(bSnap.seats[seatAfter].holeCards);

  console.log("seat:", seatBefore, "->", seatAfter, "| chips:", chipsBefore, "->", chipsAfter);
  console.log("same hole cards restored:", cardsBefore === cardsAfter);
  console.log("RESULT:", seatBefore === seatAfter && chipsBefore === chipsAfter && cardsBefore === cardsAfter ? "PASS ✅" : "FAIL ❌");
  process.exit(0);
})();
