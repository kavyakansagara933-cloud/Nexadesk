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
 */

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// Each room = { hostSocket, clientSocket|null }, keyed by pairing code
const rooms = new Map();

/**
 * Generates a unique 6-character uppercase pairing code.
 */
function generatePairingCode() {
  let code;

  do {
    code = crypto
      .randomBytes(4)
      .toString("hex")
      .slice(0, 6)
      .toUpperCase();
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
 * Create the WebSocket signaling server.
 */
const wss = new WebSocketServer({
  port: PORT,
});

wss.on("connection", (socket) => {
  // Track the room and role of this connection so it can be
  // cleaned up properly when the peer disconnects.
  socket.roomCode = null;
  socket.role = null;

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

    switch (msg.type) {
      /* ---------- HOST REGISTRATION ---------- */

      case "host-register": {
        const code = generatePairingCode();

        rooms.set(code, {
          hostSocket: socket,
          clientSocket: null,
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
        const room = rooms.get(msg.code);

        if (!room) {
          send(socket, {
            type: "error",
            message: "Invalid pairing code",
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

        socket.roomCode = msg.code;
        socket.role = "client";

        // Tell both peers that pairing is complete and the
        // WebRTC handshake can begin.
        send(room.hostSocket, {
          type: "peer-joined",
        });

        send(socket, {
          type: "joined",
          code: msg.code,
        });

        console.log(
          `[room ${msg.code}] client joined`
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

    if (!room) {
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
});


console.log(
  `NexaDesk signaling server listening on ws://localhost:${PORT}`
);