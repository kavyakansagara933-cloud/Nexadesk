# NexaDesk Signaling Server

The matchmaking piece of NexaDesk. WebRTC lets two peers (the NexaDesk Host and the NexaDesk client) stream screen + control data directly to each other, but they first need a way to *find* each other and exchange connection details.

That's what this server does — it does **not** touch any screen-share or control data itself, only the initial handshake.

## How it works

1. NexaDesk Host connects and sends `{ "type": "host-register" }`

2. Server generates a 6-character pairing code and creates a room, replies with `{ "type": "host-registered", "code": "K3F9QZ" }`

3. You type that code into the NexaDesk client

4. Client connects and sends `{ "type": "client-join", "code": "K3F9QZ" }`

5. Server pairs them in the room and tells both sides

6. From here, the server just relays `offer` / `answer` / `ice-candidate` messages between whoever is in the same room — it doesn't need to understand their contents, WebRTC handles that logic on each end

7. Once the WebRTC handshake completes, host and client talk **directly**, peer-to-peer — this server is no longer involved until the next pairing

## Running locally

```bash
npm install
npm start