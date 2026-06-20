"use client";

import { io, type Socket } from "socket.io-client";

// One shared socket for the whole client session. Survives client-side nav;
// reconnects (new socket id) on a full reload — the room page re-joins by
// sessionId so the server restores the seat.
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) socket = io({ autoConnect: true });
  return socket;
}

// Stable per-browser identity for reconnects (no auth — build prompt §2).
export function getSessionId(): string {
  let id = localStorage.getItem("pn_session");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("pn_session", id);
  }
  return id;
}

export function getNickname(): string {
  return localStorage.getItem("pn_nick") || "";
}

export function setNickname(n: string) {
  localStorage.setItem("pn_nick", n);
}
