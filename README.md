# Macky Signaling Server

The matchmaking piece of Macky. WebRTC lets two peers (the Electron host and
the Android client) stream screen + control data directly to each other, but
they first need a way to *find* each other and exchange connection details.
That's what this server does — it does **not** touch any screen-share or
control data itself, only the initial handshake.

## How it works

1. Host connects and sends `{ "type": "host-register" }`
2. Server generates a 6-character pairing code and creates a room, replies
   with `{ "type": "host-registered", "code": "K3F9QZ" }`
3. You type that code into the Android client
4. Client connects and sends `{ "type": "client-join", "code": "K3F9QZ" }`
5. Server pairs them in the room and tells both sides
6. From here, the server just relays `offer` / `answer` / `ice-candidate`
   messages between whoever is in the same room — it doesn't need to
   understand their contents, WebRTC handles that logic on each end
7. Once the WebRTC handshake completes, host and client talk **directly**,
   peer-to-peer — this server is no longer involved until the next pairing

## Running locally

```bash
npm install
npm start
```

Server starts on `ws://localhost:8080` by default (override with `PORT` env var).

## Testing it manually (before we build the Electron/RN clients)

You can simulate both sides with a WebSocket CLI tool like `wscat`:

```bash
npm install -g wscat

# Terminal 1 (acts as host)
wscat -c ws://localhost:8080
> {"type":"host-register"}
# copy the code you get back, e.g. "code":"K3F9QZ"

# Terminal 2 (acts as client)
wscat -c ws://localhost:8080
> {"type":"client-join","code":"K3F9QZ"}
```

If terminal 1 receives `{"type":"peer-joined"}` and terminal 2 receives
`{"type":"joined","code":"K3F9QZ"}`, the pairing logic works correctly.

## Deploying

Push this folder to its own GitHub repo (or a subfolder of the main Macky
repo), then connect it to [Render](https://render.com) or
[Railway](https://railway.app) as a Node.js web service. Both auto-deploy on
push and give you a public `wss://` URL that the host and client apps will
use instead of `localhost`.
