/**
 * NexaDesk Signaling Server
 * -------------------------
 * WebRTC needs two peers (the NexaDesk Host and the client application) to
 * exchange some setup information before they can talk to each other directly:
 *   - SDP offer/answer  -> describes what media/data each side supports
 *   - ICE candidates    -> possible network paths to reach each side
 *
 * WebRTC does NOT define how peers find each other or exchange this information.
 * That's called "signaling", and it is handled by this server.
 *
 * Once the WebRTC handshake completes, the actual screen sharing and control
 * data flows PEER-TO-PEER, not through this server. This server only acts as
 * a matchmaker and relays the initial signaling messages.
 *
 * Flow:
 *   1. NexaDesk Host connects and sends { type: "host-register" }
 *   2. The server generates a 6-character pairing code, creates a room,
 *      and replies with { type: "host-registered", code }
 *   3. A client connects and sends { type: "client-join", code }
 *   4. The server puts the client in that room and tells both sides
 *      that the room is ready
 *   5. The server relays "offer", "answer", and "ice-candidate" messages
 *      between peers in the same room
 *
 * Protection against guessing pairing codes:
 *   - Codes use 32 easy-to-read characters (about a billion combinations)
 *   - A code that nobody joins expires after ROOM_TTL_MS
 *   - Wrong guesses are limited per address and across the whole server
 */

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

/* ---------------- SETTINGS ---------------- */

// An unused pairing code stops working after this long.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 10 * 60 * 1000;

// Wrong pairing codes allowed per address within the window,
// before that address is blocked for BLOCK_MS.
const MAX_FAILED_PER_IP = Number(process.env.MAX_FAILED_PER_IP) || 5;
const FAIL_WINDOW_MS = Number(process.env.FAIL_WINDOW_MS) || 60 * 1000;
const BLOCK_MS = Number(process.env.BLOCK_MS) || 5 * 60 * 1000;

// Wrong pairing codes allowed across ALL addresses per window.
// Stops guessing that is spread over many addresses.
const MAX_FAILED_GLOBAL = Number(process.env.MAX_FAILED_GLOBAL) || 60;

// Signaling messages are small. Anything bigger is refused.
const MAX_MESSAGE_BYTES = 64 * 1024;

// How often to check that connections are still alive.
const HEARTBEAT_MS = 30 * 1000;

// Letters and digits that are easy to read and not easily confused
// (no 0/O or 1/I).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;


// Each room = { hostSocket, clientSocket|null, createdAt }, keyed by code
const rooms = new Map();

// address -> { fails: [timestamps], blockedUntil }
const failedByAddress = new Map();

// timestamps of recent wrong codes, from any address
let failedGlobal = [];


/* ---------------- HELPERS ---------------- */

/**
 * Generates a unique pairing code.
 * crypto.randomInt picks every character evenly and unpredictably.
 */
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

/**
 * Safely sends a JSON message through a WebSocket.
 */
function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/**
 * Finds the address of the connecting device. Behind a hosting proxy
 * (such as Render) the real address is in the X-Forwarded-For header.
 */
function getAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }

  return request.socket.remoteAddress || "unknown";
}

/**
 * Returns true if this address is currently blocked from joining.
 */
function isBlocked(address, now) {
  const record = failedByAddress.get(address);

  return Boolean(record && record.blockedUntil > now);
}

/**
 * Records a wrong pairing code. Returns true if this address (or the
 * whole server) has now made too many wrong guesses.
 */
function recordFailure(address, now) {
  // Per address.
  const record = failedByAddress.get(address) || {
    fails: [],
    blockedUntil: 0,
  };

  record.fails = record.fails.filter((t) => now - t < FAIL_WINDOW_MS);
  record.fails.push(now);

  if (record.fails.length >= MAX_FAILED_PER_IP) {
    record.blockedUntil = now + BLOCK_MS;
    record.fails = [];
  }

  failedByAddress.set(address, record);

  // Across the whole server.
  failedGlobal = failedGlobal.filter((t) => now - t < FAIL_WINDOW_MS);
  failedGlobal.push(now);

  return (
    record.blockedUntil > now ||
    failedGlobal.length >= MAX_FAILED_GLOBAL
  );
}

/**
 * Closes a room and tells both devices.
 */
function closeRoom(code, reason) {
  const room = rooms.get(code);

  if (!room) {
    return;
  }

  rooms.delete(code);

  send(room.hostSocket, { type: "peer-disconnected", reason });
  send(room.clientSocket, { type: "peer-disconnected", reason });

  console.log(`[room ${code}] closed (${reason})`);
}


/* ---------------- SERVER ---------------- */

const wss = new WebSocketServer({
  port: PORT,
  maxPayload: MAX_MESSAGE_BYTES,
});

wss.on("connection", (socket, request) => {
  // Track the room and role of this connection so it can be
  // cleaned up properly when the peer disconnects.
  socket.roomCode = null;
  socket.role = null;
  socket.address = getAddress(request);
  socket.isAlive = true;

  // A reply to our heartbeat ping means the connection is still alive.
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch (err) {
      send(socket, {
        type: "error",
        message: "Invalid JSON",
      });

      return;
    }

    if (!msg || typeof msg !== "object") {
      return;
    }

    switch (msg.type) {
      /* ---------- HOST REGISTRATION ---------- */

      case "host-register": {
        // A device registering again replaces its old room.
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

        console.log(
          `[room ${code}] NexaDesk Host registered`
        );

        break;
      }


      /* ---------- CLIENT JOIN ---------- */

      case "client-join": {
        const now = Date.now();

        if (isBlocked(socket.address, now)) {
          send(socket, {
            type: "error",
            message: "Too many wrong codes. Try again in a few minutes.",
          });

          return;
        }

        // Codes are not case sensitive.
        const code =
          typeof msg.code === "string"
            ? msg.code.trim().toUpperCase()
            : "";

        const room = rooms.get(code);

        if (!room) {
          const tooMany = recordFailure(socket.address, now);

          send(socket, {
            type: "error",
            message: tooMany
              ? "Too many wrong codes. Try again in a few minutes."
              : "Invalid pairing code",
          });

          return;
        }

        if (room.clientSocket) {
          send(socket, {
            type: "error",
            message: "Room already has a client",
          });

          return;
        }

        room.clientSocket = socket;

        socket.roomCode = code;
        socket.role = "client";

        // Tell both peers that pairing is complete and the
        // WebRTC handshake can begin.
        send(room.hostSocket, {
          type: "peer-joined",
        });

        send(socket, {
          type: "joined",
          code,
        });

        console.log(
          `[room ${code}] client joined`
        );

        break;
      }


      /* ---------- WEBRTC SIGNALING ---------- */

      case "offer":
      case "answer":
      case "ice-candidate": {
        const room = rooms.get(
          socket.roomCode
        );

        if (!room) {
          return;
        }

        const target =
          socket.role === "host"
            ? room.clientSocket
            : room.hostSocket;

        send(target, {
          ...msg,
          from: socket.role,
        });

        break;
      }


      /* ---------- UNKNOWN MESSAGE ---------- */

      default:
        send(socket, {
          type: "error",
          message:
            `Unknown message type: ${msg.type}`,
        });
    }
  });


  /* ---------- DISCONNECTION ---------- */

  socket.on("close", () => {
    const code = socket.roomCode;

    if (!code) {
      return;
    }

    const room = rooms.get(code);

    // The room may already be closed, or may belong to a newer
    // connection from the same host.
    if (
      !room ||
      (socket.role === "host" && room.hostSocket !== socket) ||
      (socket.role === "client" && room.clientSocket !== socket)
    ) {
      return;
    }

    // Notify the remaining peer that the other side disconnected.
    const other =
      socket.role === "host"
        ? room.clientSocket
        : room.hostSocket;

    send(other, {
      type: "peer-disconnected",
    });

    rooms.delete(code);

    console.log(
      `[room ${code}] closed (${socket.role} disconnected)`
    );
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err.message);
  });
});


/* ---------------- BACKGROUND CLEAN-UP ---------------- */

// Drop connections that stopped answering, so dead rooms disappear.
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

// Expire pairing codes that nobody used, and forget old failed guesses.
const cleanup = setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    if (!room.clientSocket && now - room.createdAt > ROOM_TTL_MS) {
      send(room.hostSocket, {
        type: "error",
        message: "Pairing code expired. Restart the host to get a new one.",
      });

      rooms.delete(code);

      console.log(`[room ${code}] expired (nobody joined)`);
    }
  }

  for (const [address, record] of failedByAddress) {
    record.fails = record.fails.filter((t) => now - t < FAIL_WINDOW_MS);

    if (record.fails.length === 0 && record.blockedUntil <= now) {
      failedByAddress.delete(address);
    }
  }
}, 5000);

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(cleanup);
});


console.log(
  `NexaDesk signaling server listening on ws://localhost:${PORT}`
);