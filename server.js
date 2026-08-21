/**
 * Macky Signaling Server
 * ------------------------
 * WebRTC needs two peers (the Electron host and the Android client) to exchange
 * some setup information before they can talk to each other directly:
 *   - SDP offer/answer  -> describes what media/data each side supports
 *   - ICE candidates     -> possible network paths to reach each side
 *
 * WebRTC does NOT define how peers find each other or exchange this info -
 * that's "signaling", and it's up to us to build it. That's all this server does.
 * Once the handshake completes, the actual screen-share + control data flows
 * PEER-TO-PEER, not through this server. This server is just a matchmaker.
 *
 * Flow:
 *   1. Host connects, sends { type: "host-register" }
 *   2. Server generates a 6-character pairing code, creates a "room", replies
 *      with { type: "host-registered", code }
 *   3. Client connects, sends { type: "client-join", code }
 *   4. Server puts the client in that room, tells both sides the room is ready
 *   5. Server just relays "offer", "answer", "ice-candidate" messages between
 *      whoever is in the same room, without looking at their contents
 */

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// Each room = { hostSocket, clientSocket|null }, keyed by pairing code
const rooms = new Map();

function generatePairingCode() {
  // 6 uppercase alphanumeric characters, e.g. "K3F9QZ"
  // Regenerate on collision (astronomically unlikely, but be correct anyway)
  let code;
  do {
    code = crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket) => {
  // Track which room this socket belongs to and whether it's the host,
  // so we can clean up properly when it disconnects.
  socket.roomCode = null;
  socket.role = null; // "host" | "client"

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      send(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "host-register": {
        const code = generatePairingCode();
        rooms.set(code, { hostSocket: socket, clientSocket: null });
        socket.roomCode = code;
        socket.role = "host";
        send(socket, { type: "host-registered", code });
        console.log(`[room ${code}] host registered`);
        break;
      }

      case "client-join": {
        const room = rooms.get(msg.code);
        if (!room) {
          send(socket, { type: "error", message: "Invalid pairing code" });
          return;
        }
        if (room.clientSocket) {
          send(socket, { type: "error", message: "Room already has a client" });
          return;
        }

        room.clientSocket = socket;
        socket.roomCode = msg.code;
        socket.role = "client";

        // Tell both sides they're paired and can start the WebRTC handshake
        send(room.hostSocket, { type: "peer-joined" });
        send(socket, { type: "joined", code: msg.code });
        console.log(`[room ${msg.code}] client joined`);
        break;
      }

      // These three message types are just relayed to whoever is on the
      // other side of the room - the server doesn't need to understand them.
      case "offer":
      case "answer":
      case "ice-candidate": {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        const target = socket.role === "host" ? room.clientSocket : room.hostSocket;
        send(target, { ...msg, from: socket.role });
        break;
      }

      default:
        send(socket, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  socket.on("close", () => {
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    // Let the other peer know their partner dropped, then clean up the room.
    const other = socket.role === "host" ? room.clientSocket : room.hostSocket;
    send(other, { type: "peer-disconnected" });

    rooms.delete(code);
    console.log(`[room ${code}] closed (${socket.role} disconnected)`);
  });
});

console.log(`Macky signaling server listening on ws://localhost:${PORT}`);
