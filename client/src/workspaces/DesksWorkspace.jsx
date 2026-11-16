import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { ShieldAlert, RotateCcw, Wifi } from 'lucide-react';
import {
  decodeZoneBatch,
  decodeJunctionBatch,
  DEFAULT_WIRE_SCHEMA,
} from '../shared/wire';
import { fmtInt, zoneLabel } from '../utils/semantics';

const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function payloadByteSize(payload) {
  try {
    const str = JSON.stringify(payload ?? '');
    return TEXT_ENCODER ? TEXT_ENCODER.encode(str).length : str.length;
  } catch {
    return 0;
  }
}

const DESK_SPECS = [
  {
    id: 'south',
    title: 'South Desk',
    persona: 'south-operator',
    targetRole: 'operator · south-bangalore',
    defaultSubs: {
      city: true,
      engineering: false,
      zones: ['south-bangalore'],
      junctions: [],
      alerts: ['south-bangalore'],
    },
    probeSubs: {
      city: true,
      engineering: false,
      zones: ['central-bangalore'],
      junctions: [],
      alerts: ['south-bangalore'],
    },
    probeLabel: "Attempt forbidden 'central-bangalore'",
  },
  {
    id: 'east',
    title: 'East Desk',
    persona: 'east-operator',
    targetRole: 'operator · east-bangalore',
    defaultSubs: {
      city: true,
      engineering: false,
      zones: ['east-bangalore'],
      junctions: [],
      alerts: ['east-bangalore'],
    },
    probeSubs: {
      city: true,
      engineering: false,
      zones: ['north-bangalore'],
      junctions: [],
      alerts: ['east-bangalore'],
    },
    probeLabel: "Attempt forbidden 'north-bangalore'",
  },
  {
    id: 'viewer',
    title: 'City Viewer',
    persona: 'viewer',
    targetRole: 'viewer · city summary + alerts only',
    defaultSubs: {
      city: true,
      engineering: false,
      zones: [],
      junctions: [],
      alerts: ['all'],
    },
    probeSubs: {
      city: true,
      engineering: true,
      zones: [],
      junctions: [],
      alerts: ['all'],
    },
    probeLabel: "Attempt forbidden 'engineering'",
  },
];

function DeskSocketCard({ spec }) {
  const [state, setState] = useState({
    connected: false,
    socketId: '',
    authUser: null,
    authNote: '',
    subscribedRooms: [],
    lastError: null,
    framesPerSec: 0,
    bytesPerSec: 0,
    totalFrames: 0,
    distinctJunctions: [],
    recentLog: [],
  });

  const socketRef = useRef(null);
  const schemaRef = useRef(DEFAULT_WIRE_SCHEMA);
  const secFramesRef = useRef(0);
  const secBytesRef = useRef(0);
  const totalFramesRef = useRef(0);
  const seenJuncTimestampsRef = useRef(new Map());
  const logRef = useRef([]);
  const logDirtyRef = useRef(false);

  const recordPacket = useCallback((eventName, payload, decodedEvents = []) => {
    const byteLen = payloadByteSize(payload);
    secFramesRef.current += 1;
    secBytesRef.current += byteLen;
    totalFramesRef.current += 1;

    const now = Date.now();
    for (const evt of decodedEvents) {
      const jId = evt.junctionId || evt.deviceId;
      if (jId) seenJuncTimestampsRef.current.set(jId, now);
    }

    const summary =
      decodedEvents.length > 0
        ? `${eventName} (${decodedEvents.length} rows: ${decodedEvents.map((e) => e.junctionId).slice(0, 3).join(', ')})`
        : `${eventName} (${byteLen} B)`;

    logRef.current = [
      { id: `${now}-${totalFramesRef.current}`, ts: new Date(now).toLocaleTimeString(), summary },
      ...logRef.current.slice(0, 5),
    ];
    logDirtyRef.current = true;
  }, []);

  useEffect(() => {
    let mounted = true;
    let sock = null;

    async function bootDesk() {
      let token = null;
      let user = null;
      let note = '';

      try {
        // Call demo-login cleanly WITHOUT mutating global localStorage hp_token
        const res = await fetch('/api/auth/demo-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona: spec.persona }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.token) {
          token = data.token;
          user = data.user || null;
        } else {
          note = data?.error || `Demo login returned HTTP ${res.status}; running unauthenticated`;
        }
      } catch (err) {
        note = err?.message || 'Demo login unavailable; running unauthenticated';
      }

      if (!mounted) return;

      const health = await fetch('/api/health')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!mounted) return;

      if (health && health.websocketSupported === false) {
        setState((prev) => ({
          ...prev,
          authUser: user,
          authNote: note || 'HTTP live-sync mode (WebSocket disabled in serverless host)',
          connected: false,
          socketId: '',
        }));
        return;
      }

      sock = io({
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        forceNew: true,
        multiplex: false,
        auth: token ? { token } : {},
      });
      socketRef.current = sock;

      setState((prev) => ({
        ...prev,
        authUser: user,
        authNote: note,
      }));

      sock.on('connect', () => {
        if (!mounted) return;
        setState((prev) => ({
          ...prev,
          connected: true,
          socketId: sock.id || '',
          lastError: null,
        }));
        sock.emit('subscribe', spec.defaultSubs);
      });

      sock.on('disconnect', () => {
        if (!mounted) return;
        setState((prev) => ({ ...prev, connected: false, socketId: '' }));
      });

      sock.on('wire:schema', (srvSchema) => {
        if (srvSchema && Array.isArray(srvSchema.junctionIds)) {
          schemaRef.current = srvSchema;
        }
      });

      sock.on('subscribed', (info) => {
        if (!mounted) return;
        const rooms = Array.isArray(info?.rooms)
          ? info.rooms
          : info?.room
            ? [info.room]
            : [];
        setState((prev) => ({
          ...prev,
          subscribedRooms: rooms,
          // A refused request is acknowledged with rejected: true right after the
          // FORBIDDEN_ZONE error; keep that error on screen instead of clearing it.
          lastError: info?.rejected ? prev.lastError : null,
        }));
      });

      sock.on('error', (errPayload) => {
        if (!mounted) return;
        setState((prev) => ({
          ...prev,
          lastError: `${errPayload?.code || 'ERROR'}: ${errPayload?.message || 'Unauthorized subscription'}`,
        }));
      });

      sock.on('connect_error', (err) => {
        if (!mounted) return;
        setState((prev) => ({
          ...prev,
          lastError: err?.message || 'Socket connect error',
        }));
      });

      sock.on('telemetry:zone', (pkt) => {
        const decoded = decodeZoneBatch(pkt, schemaRef.current);
        recordPacket('telemetry:zone', pkt, decoded);
      });

      sock.on('telemetry:junction', (pkt) => {
        const decoded = decodeJunctionBatch(pkt, schemaRef.current);
        recordPacket('telemetry:junction', pkt, decoded);
      });

      sock.on('metrics:snapshot', (pkt) => {
        recordPacket('metrics:snapshot', pkt, []);
      });

      sock.on('cf:update', (pkt) => {
        recordPacket('cf:update', pkt, []);
      });

      sock.on('alert:new', (pkt) => {
        recordPacket('alert:new', pkt, []);
      });
    }

    bootDesk();

    const rateTimer = setInterval(() => {
      if (!mounted) return;
      const now = Date.now();
      let expiredAny = false;
      const activeJuncs = [];
      for (const [jId, ts] of seenJuncTimestampsRef.current.entries()) {
        if (now - ts <= 5000) {
          activeJuncs.push(jId);
        } else {
          seenJuncTimestampsRef.current.delete(jId);
          expiredAny = true;
        }
      }
      activeJuncs.sort();

      const fps = secFramesRef.current;
      const bps = secBytesRef.current;
      secFramesRef.current = 0;
      secBytesRef.current = 0;
      const logChanged = logDirtyRef.current;
      logDirtyRef.current = false;

      setState((prev) => {
        const juncsUnchanged =
          !expiredAny &&
          !logChanged &&
          prev.distinctJunctions.length === activeJuncs.length &&
          prev.distinctJunctions.every((id, i) => id === activeJuncs[i]);
        if (
          prev.framesPerSec === fps &&
          prev.bytesPerSec === bps &&
          prev.totalFrames === totalFramesRef.current &&
          juncsUnchanged
        ) {
          return prev;
        }
        return {
          ...prev,
          framesPerSec: fps,
          bytesPerSec: bps,
          totalFrames: totalFramesRef.current,
          distinctJunctions: activeJuncs,
          recentLog: logChanged ? [...logRef.current] : prev.recentLog,
        };
      });
    }, 1000);

    return () => {
      mounted = false;
      clearInterval(rateTimer);
      if (sock) sock.disconnect();
    };
  }, [spec, recordPacket]);

  const handleProbe = () => {
    const sock = socketRef.current;
    if (!sock || !sock.connected) return;
    sock.emit('subscribe', spec.probeSubs);
  };

  const handleReset = () => {
    const sock = socketRef.current;
    if (!sock || !sock.connected) return;
    setState((prev) => ({ ...prev, lastError: null }));
    sock.emit('subscribe', spec.defaultSubs);
  };

  return (
    <section className="console-panel p-4 flex flex-col justify-between gap-3">
      <div className="space-y-3">
        {/* Desk Header */}
        <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-hairline">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-ink-primary">{spec.title}</h2>
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                  state.connected
                    ? 'border-signal-flow/40 bg-signal-flow/15 text-signal-flow'
                    : 'border-signal-gridlock/40 bg-signal-gridlock/15 text-signal-gridlock'
                }`}
              >
                <Wifi className="w-2.5 h-2.5" />
                <span>{state.connected ? 'Socket Open' : 'Disconnected'}</span>
              </span>
            </div>
            <div className="text-[11px] font-mono text-ink-muted mt-0.5">
              {state.authUser
                ? `${state.authUser.role} · ${(state.authUser.zones || []).map(zoneLabel).join(', ') || 'all'}`
                : spec.targetRole}
            </div>
          </div>
          <span className="font-mono text-[10px] text-ink-muted">
            {state.socketId ? `id:${state.socketId.slice(0, 6)}` : 'init'}
          </span>
        </div>

        {state.authNote && (
          <div role="alert" className="px-2.5 py-1.5 rounded border border-signal-heavy/40 bg-signal-heavy/10 text-[11px] text-signal-heavy">
            {state.authNote}
          </div>
        )}

        {/* Real Measured Socket Bandwidth */}
        <div className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 text-xs">
          <div className="console-inset px-2.5 py-2">
            <div className="text-[10px] text-ink-muted">Frames / s</div>
            <div className="font-mono tabular-nums text-base font-semibold text-ink-primary mt-0.5">
              {fmtInt(state.framesPerSec)}
            </div>
          </div>
          <div className="console-inset px-2.5 py-2">
            <div className="text-[10px] text-ink-muted">Bytes / s</div>
            <div className="font-mono tabular-nums text-base font-semibold text-ink-primary mt-0.5">
              {fmtInt(state.bytesPerSec)} B
            </div>
          </div>
          <div className="console-inset px-2.5 py-2">
            <div className="text-[10px] text-ink-muted">Total frames</div>
            <div className="font-mono tabular-nums text-base font-semibold text-ink-primary mt-0.5">
              {fmtInt(state.totalFrames)}
            </div>
          </div>
        </div>

        {/* Subscribed Server Rooms */}
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-ink-secondary">
            Active Server Rooms ({state.subscribedRooms.length})
          </div>
          <div aria-live="polite" className="flex flex-wrap gap-1 font-mono text-[10px]">
            {state.subscribedRooms.length === 0 ? (
              <span className="text-ink-muted">Waiting for subscribed ack...</span>
            ) : (
              state.subscribedRooms.map((r) => (
                <span key={r} className="px-1.5 py-0.5 rounded border border-hairline bg-inset text-ink-secondary">
                  {r}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Distinct Junction IDs Received (Scope Isolation Proof) */}
        <div className="space-y-1 pt-2 border-t border-hairline">
          <div className="text-[11px] font-medium text-ink-secondary">
            Distinct Junctions Decoded (5s window): {state.distinctJunctions.length}
          </div>
          <div className="min-h-[34px] flex flex-wrap items-center gap-1 font-mono text-[10px]">
            {state.distinctJunctions.length === 0 ? (
              <span className="text-ink-muted">
                {spec.id === 'viewer'
                  ? '0 raw junction frames received (subscribed to city summary + alerts only)'
                  : 'Waiting for zone frames...'}
              </span>
            ) : (
              state.distinctJunctions.map((jId) => (
                <span
                  key={jId}
                  className="px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10 text-accent-ink"
                >
                  {jId}
                </span>
              ))
            )}
          </div>
        </div>

        {/* Security & Error Box */}
        {state.lastError && (
          <div role="alert" className="px-2.5 py-2 rounded border border-signal-gridlock/40 bg-signal-gridlock/10 text-[11px] font-mono text-signal-gridlock flex items-start gap-2">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{state.lastError}</span>
          </div>
        )}

        {/* Recent Packets */}
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-ink-secondary">Live Socket Frame Tap</div>
          <div
            tabIndex={0}
            role="region"
            aria-label={`${spec.title} live socket frame log`}
            className="console-inset p-2 h-[116px] overflow-y-auto space-y-1 font-mono text-[10px]"
          >
            {state.recentLog.length === 0 ? (
              <div className="text-ink-muted">Waiting for frames on this socket...</div>
            ) : (
              state.recentLog.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-2 text-ink-secondary">
                  <span className="truncate">{entry.summary}</span>
                  <span className="text-ink-muted shrink-0">{entry.ts}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Isolation Probe Buttons */}
      <div className="pt-2 border-t border-hairline flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleProbe}
          disabled={!state.connected}
          className="px-2.5 py-1 rounded border border-hairlineStrong bg-inset hover:border-signal-gridlock text-[11px] text-ink-primary transition-colors disabled:opacity-50"
        >
          {spec.probeLabel}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!state.connected}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-hairline bg-surface hover:border-hairlineStrong text-[11px] text-ink-secondary hover:text-ink-primary"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Reset</span>
        </button>
      </div>
    </section>
  );
}

export function DesksWorkspace() {
  const [mountKey, setMountKey] = useState(0);

  return (
    <div className="max-w-[1680px] mx-auto px-3 sm:px-4 py-4 space-y-4">
      <div className="console-panel p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-ink-primary">
            Multi-Client Operator Desks &amp; Room Isolation
          </h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Three independent Socket.IO connections authenticated as separate operator personas. Each measures real received frames/s, bytes/s, and server-enforced room boundaries.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMountKey((k) => k + 1)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-hairline bg-inset hover:border-hairlineStrong text-xs text-ink-primary"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reconnect All Desks</span>
        </button>
      </div>

      <div key={mountKey} className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {DESK_SPECS.map((spec) => (
          <DeskSocketCard key={spec.id} spec={spec} />
        ))}
      </div>
    </div>
  );
}
