/**
 * NexaDesk Android Client - Stage 1 (view only)
 * ---------------------------------------------
 * Enter the pairing code shown in NexaDesk Host, connect through the
 * signaling server, and watch the host's screen.
 *
 * Flow (same as the browser test client):
 *   1. Join a room using the pairing code
 *   2. Receive the host's SDP offer
 *   3. Create and send an SDP answer
 *   4. Exchange ICE candidates
 *   5. Show the incoming screen stream
 *   6. Receive the "control" DataChannel (used for touch/keys in Stage 2)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';

const SIGNALING_SERVER_URL = 'wss://macky-signaling-server.onrender.com';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function App() {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState(
    'Enter the pairing code shown in NexaDesk Host.',
  );
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const controlChannelRef = useRef<any>(null);

  // ICE candidates that arrive before the host's offer has been applied.
  const pendingCandidatesRef = useRef<any[]>([]);
  const remoteDescriptionSetRef = useRef(false);

  /* ---------------- CLEAN UP ---------------- */

  const disconnect = useCallback(() => {
    controlChannelRef.current?.close?.();
    controlChannelRef.current = null;

    peerRef.current?.close();
    peerRef.current = null;

    socketRef.current?.close();
    socketRef.current = null;

    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;

    setStream(null);
    setBusy(false);
  }, []);

  // Close everything if the app screen is destroyed.
  useEffect(() => disconnect, [disconnect]);

  /* ---------------- WEBRTC ---------------- */

  const handleOffer = async (offer: any, socket: WebSocket) => {
    const peer = new RTCPeerConnection(RTC_CONFIG);
    peerRef.current = peer;

    // The host creates the "control" DataChannel; we just receive it.
    peer.addEventListener('datachannel', (event: any) => {
      if (event.channel.label === 'control') {
        controlChannelRef.current = event.channel;

        event.channel.addEventListener('open', () => {
          console.log('Control DataChannel opened.');
        });

        event.channel.addEventListener('close', () => {
          console.log('Control DataChannel closed.');
        });
      }
    });

    // The host's screen arrives as a video track.
    peer.addEventListener('track', (event: any) => {
      if (event.streams && event.streams[0]) {
        setStream(event.streams[0]);
        setStatus("Connected - streaming NexaDesk Host's screen.");
      }
    });

    peer.addEventListener('icecandidate', (event: any) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate,
          }),
        );
      }
    });

    peer.addEventListener('connectionstatechange', () => {
      console.log('WebRTC connection state:', peer.connectionState);

      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'disconnected'
      ) {
        setStatus('Connection lost.');
      }
    });

    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    remoteDescriptionSetRef.current = true;

    // Apply any ICE candidates that arrived early.
    for (const candidate of pendingCandidatesRef.current) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Failed to add queued ICE candidate:', err);
      }
    }
    pendingCandidatesRef.current = [];

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'answer', answer }));
      console.log('Answer sent.');
    }
  };

  /* ---------------- SIGNALING ---------------- */

  const connect = () => {
    const pairingCode = code.trim().toUpperCase();

    if (pairingCode.length !== 6) {
      setStatus('Enter the 6-character code shown in NexaDesk Host.');
      return;
    }

    setBusy(true);
    setStatus(
      'Connecting to signaling server... (the first connection can take up to a minute)',
    );

    const socket = new WebSocket(SIGNALING_SERVER_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus('Connected. Joining room...');
      socket.send(JSON.stringify({ type: 'client-join', code: pairingCode }));
    };

    socket.onmessage = async (event: any) => {
      const msg = JSON.parse(event.data);
      console.log('[received]', msg.type);

      if (msg.type === 'joined') {
        setStatus("Joined. Waiting for host's offer...");
      }

      if (msg.type === 'error') {
        setStatus(`Error: ${msg.message}`);
        disconnect();
      }

      if (msg.type === 'offer') {
        setStatus('Offer received. Creating answer...');

        try {
          await handleOffer(msg.offer, socket);
        } catch (err) {
          console.error('Failed to handle offer:', err);
          setStatus('Could not set up the connection.');
          disconnect();
        }
      }

      if (msg.type === 'ice-candidate') {
        const peer = peerRef.current;

        // Wait for the offer to be applied first.
        if (!peer || !remoteDescriptionSetRef.current) {
          pendingCandidatesRef.current.push(msg.candidate);
        } else {
          try {
            await peer.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (err) {
            console.warn('Failed to add ICE candidate:', err);
          }
        }
      }

      if (msg.type === 'peer-disconnected') {
        setStatus('NexaDesk Host disconnected.');
        disconnect();
      }
    };

    socket.onclose = () => {
      setBusy(false);
    };

    socket.onerror = () => {
      setStatus('Connection error. Check your internet and try again.');
      disconnect();
    };
  };

  /* ---------------- SCREEN ---------------- */

  if (stream) {
    return (
      <View style={styles.videoScreen}>
        <StatusBar hidden />
        <RTCView
          streamURL={stream.toURL()}
          style={styles.video}
          objectFit="contain"
        />
        <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
          <Text style={styles.disconnectText}>Disconnect</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView
          style={styles.center}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Text style={styles.title}>NexaDesk</Text>

          <TextInput
            style={styles.input}
            value={code}
            onChangeText={text => setCode(text.toUpperCase())}
            placeholder="PAIR CODE"
            placeholderTextColor="#5a5a6a"
            maxLength={6}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />

          <TouchableOpacity
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={connect}
            disabled={busy}
          >
            <Text style={styles.buttonText}>Join</Text>
          </TouchableOpacity>

          <Text style={styles.status}>{status}</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#14151a',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#9a9ab0',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 24,
  },
  input: {
    width: 200,
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
    paddingVertical: 10,
    backgroundColor: '#1e1f28',
    borderWidth: 1,
    borderColor: '#2a2a35',
    borderRadius: 6,
    color: '#e8e8ea',
  },
  button: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 32,
    backgroundColor: '#7c9eff',
    borderRadius: 6,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#14151a',
    fontWeight: '600',
    fontSize: 16,
  },
  status: {
    marginTop: 24,
    fontSize: 13,
    color: '#8a8a9a',
    textAlign: 'center',
  },
  videoScreen: {
    flex: 1,
    backgroundColor: '#000',
  },
  video: {
    flex: 1,
  },
  disconnectBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(20,21,26,0.8)',
    borderRadius: 6,
  },
  disconnectText: {
    color: '#e8e8ea',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default App;