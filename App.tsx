/**
 * NexaDesk Android Client - Stage 3 (view + touch + keyboard)
 * -----------------------------------------------------------
 * Enter the pairing code shown in NexaDesk Host, connect through the
 * signaling server, watch the host's screen and control it by touch
 * and keyboard.
 *
 * Keyboard: tap "Keyboard" (top left) to open the phone's on-screen
 * keyboard. Whatever you type appears on the host. A key bar gives
 * Esc, Tab, arrows, Delete, Enter and more. Ctrl, Alt and Shift are
 * "sticky": tap one, then tap a letter (for example Ctrl, then C).
 *
 * Touch gestures work like a laptop trackpad:
 *   - Drag one finger ........ move the cursor
 *   - Tap .................... left click (two quick taps = double click)
 *   - Tap, then press + drag . drag and drop
 *   - Tap with two fingers ... right click
 *   - Drag with two fingers .. scroll
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
  GestureResponderEvent,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  StatusBar,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputKeyPressEvent,
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

/* ---------------- TOUCH SETTINGS ---------------- */

// How far the cursor travels for a finger movement. 1 = a swipe across
// the whole view moves the cursor across the whole host screen.
const CURSOR_SENSITIVITY = 1.6;

// Finger movement (in pixels) smaller than this still counts as a tap.
const TAP_SLOP = 10;

// A touch must end within this time (ms) to count as a tap.
const TAP_MAX_MS = 250;

// Touching again within this time (ms) after a tap starts a drag.
const TAP_DRAG_WINDOW_MS = 300;

// Finger movement (in pixels) that makes one host scroll step.
// Smaller = faster scrolling.
const SCROLL_PX_PER_STEP = 5;

// true: fingers move the content (swipe up = page goes down),
// like a phone. false: like a mouse wheel.
const NATURAL_SCROLL = true;

// Skip mouse moves while this many bytes are still waiting to be sent.
const MAX_BUFFERED_BYTES = 4096;

/* ---------------- KEYBOARD SETTINGS ---------------- */

type Mods = { ctrl: boolean; alt: boolean; shift: boolean };

const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

// Browser-style key codes the host understands (see host keymap.js).
const MOD_CODES: Record<keyof Mods, string> = {
  ctrl: 'ControlLeft',
  alt: 'AltLeft',
  shift: 'ShiftLeft',
};

// Buttons that stay "on" until the next key is pressed.
const MOD_BUTTONS: { label: string; mod: keyof Mods }[] = [
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: 'Shift', mod: 'shift' },
];

// Buttons that press one key.
const KEY_BUTTONS: { label: string; code: string }[] = [
  { label: 'Esc', code: 'Escape' },
  { label: 'Tab', code: 'Tab' },
  { label: 'Win', code: 'MetaLeft' },
  { label: '←', code: 'ArrowLeft' },
  { label: '↑', code: 'ArrowUp' },
  { label: '↓', code: 'ArrowDown' },
  { label: '→', code: 'ArrowRight' },
  { label: 'Home', code: 'Home' },
  { label: 'End', code: 'End' },
  { label: 'Del', code: 'Delete' },
  { label: '⌫', code: 'Backspace' },
  { label: '↵', code: 'Enter' },
];

/** Key code for a typed letter or digit, used for shortcuts like Ctrl+C. */
function codeForChar(char: string): string | null {
  if (/^[a-z]$/i.test(char)) {
    return `Key${char.toUpperCase()}`;
  }

  if (/^[0-9]$/.test(char)) {
    return `Digit${char}`;
  }

  return null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round5 = (value: number) => Math.round(value * 100000) / 100000;


function App() {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState(
    'Enter the pairing code shown in NexaDesk Host.',
  );
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [controlReady, setControlReady] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [mods, setMods] = useState<Mods>(NO_MODS);

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const controlChannelRef = useRef<any>(null);

  // ICE candidates that arrive before the host's offer has been applied.
  const pendingCandidatesRef = useRef<any[]>([]);
  const remoteDescriptionSetRef = useRef(false);

  // Where the cursor is on the host, as fractions of its screen (0 to 1).
  const cursorRef = useRef({
    x: 0.5,
    y: 0.5,
    sentX: -1,
    sentY: -1,
    synced: false,
    frameRequested: false,
  });

  // State of the touch gesture that is in progress.
  const gestureRef = useRef({
    startTime: 0,
    maxTouches: 0,
    lastCount: 0,
    lastX: 0,
    lastY: 0,
    totalMove: 0,
    scrollAccum: 0,
    dragCandidate: false,
    dragging: false,
    lastTapEnd: 0,
  });

  // Same as `mods`, readable straight away inside event handlers.
  const modsRef = useRef<Mods>(NO_MODS);

  // Hidden text box that opens the phone's on-screen keyboard.
  const keyboardInputRef = useRef<React.ElementRef<typeof TextInput>>(null);

  // Size of the touch area on screen.
  const layoutRef = useRef({ width: 1, height: 1 });

  /* ---------------- CONTROL COMMANDS ---------------- */

  /** Sends a command to the host. Returns false if the channel isn't open. */
  const sendCommand = useCallback((command: object) => {
    const channel = controlChannelRef.current;

    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    channel.send(JSON.stringify(command));
    return true;
  }, []);

  /** Sends the cursor position if it changed since the last one sent. */
  const flushMove = useCallback(
    (force = false) => {
      const cursor = cursorRef.current;

      if (!force && cursor.x === cursor.sentX && cursor.y === cursor.sentY) {
        return;
      }

      // The connection is backed up - skip this move instead of queueing it.
      const channel = controlChannelRef.current;
      if (!force && channel && channel.bufferedAmount > MAX_BUFFERED_BYTES) {
        return;
      }

      if (
        sendCommand({
          type: 'mouse-move',
          x: round5(cursor.x),
          y: round5(cursor.y),
        })
      ) {
        cursor.sentX = cursor.x;
        cursor.sentY = cursor.y;
      }
    },
    [sendCommand],
  );

  /** Sends at most one move per screen frame. */
  const scheduleMove = useCallback(() => {
    const cursor = cursorRef.current;

    if (cursor.frameRequested) {
      return;
    }

    cursor.frameRequested = true;

    requestAnimationFrame(() => {
      cursor.frameRequested = false;
      flushMove();
    });
  }, [flushMove]);

  /* ---------------- KEYBOARD ---------------- */

  const setModifiers = (next: Mods) => {
    modsRef.current = next;
    setMods(next);
  };

  /** Presses and releases one key, together with any sticky modifiers. */
  const tapKey = (code: string) => {
    const active = (Object.keys(MOD_CODES) as (keyof Mods)[])
      .filter(mod => modsRef.current[mod])
      .map(mod => MOD_CODES[mod]);

    for (const modCode of active) {
      sendCommand({ type: 'key-down', code: modCode });
    }

    sendCommand({ type: 'key-down', code });
    sendCommand({ type: 'key-up', code });

    for (const modCode of [...active].reverse()) {
      sendCommand({ type: 'key-up', code: modCode });
    }

    // Sticky modifiers are used up by one key.
    if (active.length > 0) {
      setModifiers(NO_MODS);
    }
  };

  /** Called whenever the phone's keyboard produces text. */
  const onKeyboardText = (text: string) => {
    if (!text) {
      return;
    }

    const anyModifier =
      modsRef.current.ctrl || modsRef.current.alt || modsRef.current.shift;

    // Ctrl/Alt/Shift + a letter or digit: send it as a shortcut.
    if (anyModifier && text.length === 1) {
      const code = codeForChar(text);

      if (code) {
        tapKey(code);
        keyboardInputRef.current?.clear();
        return;
      }
    }

    // Everything else is typed as plain text on the host.
    sendCommand({ type: 'key-text', text });

    // Empty the box so it only ever holds the newest key.
    keyboardInputRef.current?.clear();
  };

  const onKeyboardKeyPress = (event: TextInputKeyPressEvent) => {
    if (event.nativeEvent.key === 'Backspace') {
      tapKey('Backspace');
    }
  };

  const toggleKeyboard = () => {
    if (keyboardOpen) {
      keyboardInputRef.current?.blur();
      setKeyboardOpen(false);
    } else {
      setKeyboardOpen(true);
      setTimeout(() => keyboardInputRef.current?.focus(), 50);
    }
  };

  const toggleModifier = (mod: keyof Mods) => {
    setModifiers({ ...modsRef.current, [mod]: !modsRef.current[mod] });
  };

  /* ---------------- CLEAN UP ---------------- */

  const disconnect = useCallback(() => {
    // Let go of the mouse button if a drag was in progress.
    if (gestureRef.current.dragging) {
      sendCommand({ type: 'mouse-up' });
      gestureRef.current.dragging = false;
    }

    cursorRef.current.synced = false;

    modsRef.current = NO_MODS;
    setMods(NO_MODS);
    setKeyboardOpen(false);

    controlChannelRef.current?.close?.();
    controlChannelRef.current = null;

    peerRef.current?.close();
    peerRef.current = null;

    socketRef.current?.close();
    socketRef.current = null;

    pendingCandidatesRef.current = [];
    remoteDescriptionSetRef.current = false;

    setStream(null);
    setControlReady(false);
    setBusy(false);
  }, [sendCommand]);

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
          setControlReady(true);
        });

        event.channel.addEventListener('close', () => {
          console.log('Control DataChannel closed.');
          setControlReady(false);
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

  /* ---------------- TOUCH GESTURES ---------------- */

  // Hide the gesture hints after a few seconds.
  useEffect(() => {
    if (!stream) {
      setShowHint(true);
      return;
    }

    const timer = setTimeout(() => setShowHint(false), 7000);
    return () => clearTimeout(timer);
  }, [stream]);

  /** Makes the host cursor match our position the first time we touch. */
  const ensureSynced = () => {
    const cursor = cursorRef.current;

    if (!cursor.synced) {
      cursor.synced = true;
      flushMove(true);
    }
  };

  const onGestureStart = (event: GestureResponderEvent) => {
    const g = gestureRef.current;
    const now = Date.now();

    g.startTime = now;
    g.maxTouches = event.nativeEvent.touches.length;
    g.lastCount = 0;
    g.totalMove = 0;
    g.scrollAccum = 0;
    g.dragging = false;

    // Touching again right after a tap: it may become a drag.
    g.dragCandidate = now - g.lastTapEnd < TAP_DRAG_WINDOW_MS;

    ensureSynced();
  };

  const onGestureMove = (event: GestureResponderEvent) => {
    const g = gestureRef.current;
    const touches = event.nativeEvent.touches;
    const count = touches.length;

    if (count === 0) {
      return;
    }

    if (count > g.maxTouches) {
      g.maxTouches = count;
    }

    // Average position of all fingers on the screen.
    let x = 0;
    let y = 0;
    for (const touch of touches) {
      x += touch.pageX;
      y += touch.pageY;
    }
    x /= count;
    y /= count;

    // A finger was added or removed: start measuring from here
    // so the cursor doesn't jump.
    if (count !== g.lastCount) {
      g.lastCount = count;
      g.lastX = x;
      g.lastY = y;
      return;
    }

    const dx = x - g.lastX;
    const dy = y - g.lastY;
    g.lastX = x;
    g.lastY = y;
    g.totalMove += Math.abs(dx) + Math.abs(dy);

    /* ----- two fingers: scroll ----- */
    if (count >= 2) {
      if (g.totalMove < TAP_SLOP) {
        return;
      }

      g.scrollAccum += NATURAL_SCROLL ? -dy : dy;

      const steps = Math.trunc(g.scrollAccum / SCROLL_PX_PER_STEP);

      if (steps !== 0) {
        g.scrollAccum -= steps * SCROLL_PX_PER_STEP;
        sendCommand({ type: 'mouse-scroll', amount: steps });
      }

      return;
    }

    /* ----- one finger: move (or drag) ----- */

    // Still small enough to be a tap.
    if (g.totalMove < TAP_SLOP && !g.dragging) {
      return;
    }

    // Tap, then press and move: hold the mouse button down.
    if (g.dragCandidate && !g.dragging) {
      flushMove();
      sendCommand({ type: 'mouse-down' });
      g.dragging = true;
    }

    const cursor = cursorRef.current;
    const { width, height } = layoutRef.current;

    cursor.x = clamp01(cursor.x + (dx / width) * CURSOR_SENSITIVITY);
    cursor.y = clamp01(cursor.y + (dy / height) * CURSOR_SENSITIVITY);

    scheduleMove();
  };

  const onGestureEnd = () => {
    const g = gestureRef.current;
    const duration = Date.now() - g.startTime;
    const isTap = g.totalMove < TAP_SLOP && duration < TAP_MAX_MS;

    if (g.dragging) {
      // Finish the drag.
      flushMove();
      sendCommand({ type: 'mouse-up' });
      g.dragging = false;
    } else if (isTap) {
      flushMove();

      if (g.maxTouches >= 2) {
        // Two-finger tap: right click.
        sendCommand({ type: 'mouse-right-click' });
      } else {
        // One-finger tap: press and release the left button. Two quick
        // taps become a double-click, handled by Windows itself.
        sendCommand({ type: 'mouse-down' });
        sendCommand({ type: 'mouse-up' });
        g.lastTapEnd = Date.now();
      }
    }

    g.dragCandidate = false;
    g.lastCount = 0;
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: event => onGestureStartRef.current(event),
      onPanResponderMove: event => onGestureMoveRef.current(event),
      onPanResponderRelease: () => onGestureEndRef.current(),
      onPanResponderTerminate: () => onGestureEndRef.current(),
    }),
  ).current;

  // The handlers above are created once, so they call the latest
  // versions of our functions through these refs.
  const onGestureStartRef = useRef(onGestureStart);
  const onGestureMoveRef = useRef(onGestureMove);
  const onGestureEndRef = useRef(onGestureEnd);
  onGestureStartRef.current = onGestureStart;
  onGestureMoveRef.current = onGestureMove;
  onGestureEndRef.current = onGestureEnd;

  const onTouchAreaLayout = (event: LayoutChangeEvent) => {
    layoutRef.current = {
      width: Math.max(1, event.nativeEvent.layout.width),
      height: Math.max(1, event.nativeEvent.layout.height),
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

        {/* Invisible layer that catches finger gestures. */}
        <View
          style={StyleSheet.absoluteFill}
          onLayout={onTouchAreaLayout}
          {...panResponder.panHandlers}
        />

        {!controlReady && (
          <View style={styles.pill} pointerEvents="none">
            <Text style={styles.pillText}>Control channel connecting...</Text>
          </View>
        )}

        {showHint && controlReady && (
          <View style={styles.pill} pointerEvents="none">
            <Text style={styles.pillText}>
              Drag: move · Tap: click · 2-finger tap: right click · 2-finger
              drag: scroll
            </Text>
          </View>
        )}

        {/* Hidden box that brings up the phone's keyboard. */}
        <TextInput
          ref={keyboardInputRef}
          style={styles.hiddenInput}
          onChangeText={onKeyboardText}
          onKeyPress={onKeyboardKeyPress}
          onSubmitEditing={() => tapKey('Enter')}
          onBlur={() => setKeyboardOpen(false)}
          submitBehavior="submit"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          importantForAutofill="no"
          keyboardType="visible-password"
        />

        {keyboardOpen && (
          <View style={styles.keyBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={styles.keyBarContent}
            >
              {MOD_BUTTONS.map(button => (
                <TouchableOpacity
                  key={button.mod}
                  style={[styles.keyBtn, mods[button.mod] && styles.keyBtnOn]}
                  onPress={() => toggleModifier(button.mod)}
                >
                  <Text
                    style={[
                      styles.keyBtnText,
                      mods[button.mod] && styles.keyBtnTextOn,
                    ]}
                  >
                    {button.label}
                  </Text>
                </TouchableOpacity>
              ))}

              {KEY_BUTTONS.map(button => (
                <TouchableOpacity
                  key={button.code}
                  style={styles.keyBtn}
                  onPress={() => tapKey(button.code)}
                >
                  <Text style={styles.keyBtnText}>{button.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <TouchableOpacity
          style={[styles.topBtn, styles.keyboardToggle]}
          onPress={toggleKeyboard}
        >
          <Text style={styles.disconnectText}>
            {keyboardOpen ? 'Hide keyboard' : 'Keyboard'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.topBtn, styles.disconnectBtn]}
          onPress={disconnect}
        >
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
  pill: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    maxWidth: '90%',
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(20,21,26,0.8)',
    borderRadius: 16,
  },
  pillText: {
    color: '#e8e8ea',
    fontSize: 12,
    textAlign: 'center',
  },
  topBtn: {
    position: 'absolute',
    top: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(20,21,26,0.8)',
    borderRadius: 6,
  },
  disconnectBtn: {
    right: 12,
  },
  keyboardToggle: {
    left: 12,
  },
  hiddenInput: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
  },
  keyBar: {
    position: 'absolute',
    top: 56,
    left: 0,
    right: 0,
  },
  keyBarContent: {
    paddingHorizontal: 12,
    gap: 8,
  },
  keyBtn: {
    minWidth: 44,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(20,21,26,0.85)',
    borderWidth: 1,
    borderColor: '#2a2a35',
    borderRadius: 6,
  },
  keyBtnOn: {
    backgroundColor: '#7c9eff',
    borderColor: '#7c9eff',
  },
  keyBtnText: {
    color: '#e8e8ea',
    fontSize: 14,
    fontWeight: '600',
  },
  keyBtnTextOn: {
    color: '#14151a',
  },
  disconnectText: {
    color: '#e8e8ea',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default App;