import { createServer } from "http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import { registerSocketHandlers } from "./lib/socket/handlers";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number(process.env.PORT) || 3000;

// One Node process serves both the Next.js app and the Socket.io realtime
// layer over a single HTTP server — no CORS, one deployable, free-tier friendly.
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    try {
      // Let Next parse the URL itself — avoids the deprecated url.parse().
      handle(req, res);
    } catch (err) {
      console.error("Error handling request", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  const io = new SocketIOServer(httpServer, {
    // Same-origin in production; permissive in dev so a second device on the
    // LAN can connect while testing.
    cors: dev ? { origin: "*" } : undefined,
  });

  registerSocketHandlers(io);

  httpServer.listen(port, hostname, () => {
    console.log(`> PokerNight ready on http://localhost:${port} (dev=${dev})`);
  });
});
