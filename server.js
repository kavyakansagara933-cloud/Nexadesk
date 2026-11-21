
/**
 * NexaDesk Signaling Server
 * -------------------------
 * The server pairs a Windows Host and an Android Client, then relays only
 * the WebRTC setup messages (offer, answer and ICE candidates). Screen video
 * and remote-control data travel directly between the peers over WebRTC.
 *
 * Security protections:
 * - Six-character pairing codes from a 32-character alphabet.
 * - Five failed pairing attempts per client IP in one minute, then a
 *   five-minute per-IP block.
 * - A server-process-wide limit of 60 failed pairing attempts per minute,
 *   followed by a five-minute cooldown for further INVALID codes.
 * - Unused pairing codes expire after ten minutes.
 * - WebSocket messages are limited to 64 KB.
 * - Ping/pong heartbeat terminates dead connections.
 *
 * The global limiter is in memory. If you scale this service to multiple
 * Render instances, move the rate-limit state to a shared store (for example,
 * Redis/Render Key Value) so all instances enforce the same global limit.
 */

const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const net = require("net");

const PORT = Number(process.env.PORT) || 8080;

/* ---------------- SETTINGS ---------------- */

function positiveIntegerFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// An unused pairing code stops working after this long.
const ROOM_TTL_MS = positiveIntegerFromEnv(
  "ROOM_TTL_MS",
  10 * 60 * 1000
);

// Wrong pairing codes allowed per address within the rolling time window.
const MAX_FAILED_PER_IP = positiveIntegerFromEnv("MAX_FAILED_PER_IP", 5);
const FAIL_WINDOW_MS = positiveIntegerFromEnv(
  "FAIL_WINDOW_MS",
  60 * 1000
);
const BLOCK_MS = positiveIntegerFromEnv("BLOCK_MS", 5 * 60 * 1000);

// Wrong pairing codes allowed across this server process within the window.
const MAX_FAILED_GLOBAL = positiveIntegerFromEnv(
  "MAX_FAILED_GLOBAL",
  60
);

// Signaling messages are small; video and control data do not pass here.
const MAX_MESSAGE_BYTES = 64 * 1024;

// How often to check that WebSocket connections are still alive.
const HEARTBEAT_MS = 30 * 1000;

// 32 readable characters; excludes 0/O and 1/I.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/* ---------------- STATE ---------------- */

// Each room = { hostSocket, clientSocket, createdAt }, keyed by pairing code.
const rooms = new Map();

// IP address -> { fails: [timestamps], blockedUntil }.
const failedByAddress = new Map();

// Rolling list of invalid-code attempts across this Node.js process.
let failedGlobal = [];
let globalBlockedUntil = 0;

/* ---------------- HELPERS ---------------- */

/** Generate a unique, unpredictable six-character pairing code. */
function generatePairingCode() {
  let code;

  do {
    code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));

  return code;
}

/** Safely send a JSON message to an open WebSocket. */
function send(socket, message) {
  if (!socket || socket.readyState !== socket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error("WebSocket send failed:", error.message);
    return false;
  }
}

/** Return a normalized IP address, or null when the value is not an IP. */
function normalizeIp(value) {
  if (typeof value !== "string") {
    return null;
  }

  const address = value.trim();
  return net.isIP(address) ? address.toLowerCase() : null;
}

/**
 * Get the client IP used for per-address limits.
 *
 * On Render, public traffic passes through Cloudflare. Render documents
 * CF-Connecting-IP as the original client address; Cloudflare overwrites
 * caller-supplied values for requests reaching the Render service.
 *
 * Do not use the leftmost X-Forwarded-For value here: callers can supply
 * spoofed values in that header unless the trusted proxy chain is parsed.
 *
 * For local development, fall back to the direct socket address.
 */
function getClientAddress(request) {
  const cloudflareAddress = normalizeIp(
    request.headers["cf-connecting-ip"]
  );

  if (cloudflareAddress) {
    return cloudflareAddress;
  }

  return normalizeIp(request.socket.remoteAddress) || "unknown";
}

function isAddressBlocked(address, now) {
  const record = failedByAddress.get(address);
  return Boolean(record && record.blockedUntil > now);
}

function isGlobalBlocked(now) {
  return globalBlockedUntil > now;
}

/**
 * Record one incorrect pairing code.
 * Returns whether this address or the whole process is now in cooldown.
 */
function recordFailedAttempt(address, now) {
  let record = failedByAddress.get(address);

  if (!record) {
    record = { fails: [], blockedUntil: 0 };
  }

  // Per-address rolling window.
  record.fails = record.fails.filter(
    (timestamp) => now - timestamp < FAIL_WINDOW_MS
  );
  record.fails.push(now);

  if (record.fails.length >= MAX_FAILED_PER_IP) {
    record.blockedUntil = now + BLOCK_MS;
    record.fails = [];
    console.warn(`[security] Address temporarily blocked: ${address}`);
  }

  failedByAddress.set(address, record);

  // Server-process-wide rolling window.
  failedGlobal = failedGlobal.filter(
    (timestamp) => now - timestamp < FAIL_WINDOW_MS
  );
  failedGlobal.push(now);

  if (failedGlobal.length >= MAX_FAILED_GLOBAL) {
    globalBlockedUntil = now + BLOCK_MS;
    failedGlobal = [];
    console.warn("[security] Global invalid-code cooldown started.");
  }

  return {
    addressBlocked: record.blockedUntil > now,
    globalBlocked: isGlobalBlocked(now),
  };
}

/** Close and remove a room, notifying whichever peers are still connected. */
function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) {
    return;
  }

  rooms.delete(code);

  for (const socket of [room.hostSocket, room.clientSocket]) {
    if (socket && socket.roomCode === code) {
      socket.roomCode = null;
      socket.role = null;
      send(socket, { type: "peer-disconnected", reason });
    }
  }

  console.log(`[room ${code}] closed (${reason})`);
}

function sendPairingError(socket, message) {
  send(socket, { type: "error", message });
}

/* ---------------- SERVER ---------------- */

const wss = new WebSocketServer({
  port: PORT,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
});

wss.on("connection", (socket, request) => {
  socket.roomCode = null;
  socket.role = null;
  socket.clientAddress = getClientAddress(request);
  socket.isAlive = true;

  // A pong means the connection is still alive.
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      sendPairingError(socket, "Binary messages are not supported.");
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      sendPairingError(socket, "Invalid JSON");
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      sendPairingError(socket, "Invalid message");
      return;
    }

    if (typeof msg.type !== "string") {
      sendPairingError(socket, "Message type is required");
      return;
    }

    switch (msg.type) {

      /* ---------- HOST REGISTRATION ---------- */

      case "host-register": {
        if (socket.role && socket.role !== "host") {
          sendPairingError(
            socket,
            "This connection is already registered as a client."
          );
          return;
        }

        // Re-registering the same host replaces its previous room/code.
        if (socket.roomCode && socket.role === "host") {
          closeRoom(socket.roomCode, "host registered again");
        }

        const code = generatePairingCode();

        rooms.set(code, {
          hostSocket: socket,
          clientSocket: null,
          createdAt: Date.now(),
        });

        socket.roomCode = code;
        socket.role = "host";

        send(socket, {
          type: "host-registered",
          code,
        });

        console.log(`[room ${code}] NexaDesk Host registered`);
        break;
      }

      /* ---------- CLIENT JOIN ---------- */

      case "client-join": {
        if (socket.role) {
          sendPairingError(
            socket,
            "This connection is already registered."
          );
          return;
        }

        const now = Date.now();

        // Per-address lockout applies even if this connection now submits
        // the correct code, matching the documented five-failure rule.
        if (isAddressBlocked(socket.clientAddress, now)) {
          sendPairingError(
            socket,
            "Too many wrong codes. Try again in a few minutes."
          );
          return;
        }

        // Codes are not case-sensitive.
        const code =
          typeof msg.code === "string"
            ? msg.code.trim().toUpperCase()
            : "";

        const room = rooms.get(code);

        if (!room) {
          // The global cooldown rejects further INVALID codes, but valid
          // pairing codes remain usable so an attack cannot lock everyone
          // out of legitimate connections.
          if (isGlobalBlocked(now)) {
            sendPairingError(
              socket,
              "Too many wrong codes across the server. Try again in a few minutes."
            );
            return;
          }

          const limits = recordFailedAttempt(
            socket.clientAddress,
            now
          );

          sendPairingError(
            socket,
            limits.addressBlocked || limits.globalBlocked
              ? "Too many wrong codes. Try again in a few minutes."
              : "Invalid pairing code"
          );
          return;
        }

        if (room.clientSocket) {
          sendPairingError(socket, "Room already has a client");
          return;
        }

        room.clientSocket = socket;
        socket.roomCode = code;
        socket.role = "client";

        send(room.hostSocket, { type: "peer-joined" });
        send(socket, { type: "joined", code });

        console.log(`[room ${code}] client joined`);
        break;
      }

      /* ---------- WEBRTC SIGNALING ---------- */

      case "offer":
      case "answer":
      case "ice-candidate": {
        const room = rooms.get(socket.roomCode);

        if (!room || !socket.role) {
          sendPairingError(
            socket,
            "Join a pairing room before sending signaling messages."
          );
          return;
        }

        // The Host creates the offer; the Android Client creates the answer.
        if (msg.type === "offer" && socket.role !== "host") {
          sendPairingError(
            socket,
            "Only the host can send an offer."
          );
          return;
        }

        if (msg.type === "answer" && socket.role !== "client") {
          sendPairingError(
            socket,
            "Only the client can send an answer."
          );
          return;
        }

        const target =
          socket.role === "host"
            ? room.clientSocket
            : room.hostSocket;

        send(target, { ...msg, from: socket.role });
        break;
      }

      /* ---------- UNKNOWN MESSAGE ---------- */

      default:
        sendPairingError(
          socket,
          `Unknown message type: ${msg.type}`
        );
    }
  });

  /* ---------- DISCONNECTION ---------- */

  socket.on("close", () => {
    const code = socket.roomCode;

    if (!code) {
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      return;
    }

    // Ignore stale close events if this socket no longer owns the room slot.
    if (
      (socket.role === "host" && room.hostSocket !== socket) ||
      (socket.role === "client" && room.clientSocket !== socket)
    ) {
      return;
    }

    if (socket.role === "client") {
      // Keep the host's code usable after a client disconnects, matching the
      // Host UI's "Waiting again" state. Give the unused code a fresh TTL.
      room.clientSocket = null;
      room.createdAt = Date.now();
      socket.roomCode = null;
      socket.role = null;

      send(room.hostSocket, {
        type: "peer-disconnected",
      });

      console.log(
        `[room ${code}] client disconnected; room remains available`
      );
      return;
    }

    // If the host disconnects, its room is no longer usable.
    send(room.clientSocket, {
      type: "peer-disconnected",
    });

    rooms.delete(code);
    socket.roomCode = null;
    socket.role = null;

    console.log(`[room ${code}] closed (host disconnected)`);
  });

  socket.on("error", (error) => {
    console.error("WebSocket client error:", error.message);
  });
});

wss.on("error", (error) => {
  console.error("WebSocket server error:", error.message);
});

/* ---------------- BACKGROUND CLEAN-UP ---------------- */

// Drop connections that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

heartbeat.unref?.();

// Expire unused codes and prune old rate-limit records.
const cleanup = setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    if (!room.clientSocket && now - room.createdAt >= ROOM_TTL_MS) {
      rooms.delete(code);

      // The Host app already reacts to WebSocket close by showing that the
      // signaling connection was lost. Closing forces it to restart and get
      // a fresh code instead of continuing to display an expired code.
      sendPairingError(
        room.hostSocket,
        "Pairing code expired. Restart NexaDesk Host to get a new one."
      );

      if (room.hostSocket.roomCode === code) {
        room.hostSocket.roomCode = null;
        room.hostSocket.role = null;
      }

      if (room.hostSocket.readyState === room.hostSocket.OPEN) {
        room.hostSocket.close(4001, "Pairing code expired");
      }

      console.log(`[room ${code}] expired (nobody joined)`);
    }
  }

  for (const [address, record] of failedByAddress) {
    record.fails = record.fails.filter(
      (timestamp) => now - timestamp < FAIL_WINDOW_MS
    );

    if (record.fails.length === 0 && record.blockedUntil <= now) {
      failedByAddress.delete(address);
    }
  }

  failedGlobal = failedGlobal.filter(
    (timestamp) => now - timestamp < FAIL_WINDOW_MS
  );

  if (globalBlockedUntil <= now) {
    globalBlockedUntil = 0;
  }
}, 5000);

cleanup.unref?.();

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(cleanup);
});

console.log(
  `NexaDesk signaling server listening on port ${PORT}`
);
