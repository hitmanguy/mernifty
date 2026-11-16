import crypto from 'crypto';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { ingestionBuffer } from './ingestionBuffer.js';
import { anomalyEngine } from './anomalyEngine.js';
import { socketService } from './socketService.js';
import { metricsService } from './metricsService.js';
import { INITIAL_DEVICES } from '../sim/junctions.data.js';
import { DEFAULT_NETWORK, classifyTrafficStatus } from '../sim/network.js';
import { CounterfactualPair } from '../sim/twin.js';
import { getIstHour, getTodPeriod } from '../sim/demand.js';
import { loadStudyPolicy } from '../sim/studyPolicy.js';
import { OperatorAction } from '../models/OperatorAction.js';
import { CorridorTrip } from '../models/CorridorTrip.js';
import mongoose from 'mongoose';
import { withSyncSpan, recordSimStep } from '../telemetry/instruments.js';
import { JUNCTION_COORDINATES, getIncomingApproachRoad } from '../data/junctionGraph.js';

export { INITIAL_DEVICES };

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export function formatIstClock(simDate) {
  const utcMs =
    simDate instanceof Date
      ? simDate.getTime()
      : typeof simDate === 'number'
        ? simDate
        : Date.parse(simDate);
  const safeMs = Number.isFinite(utcMs) ? utcMs : Date.now();
  const ist = new Date(safeMs + IST_OFFSET_MS);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} IST`;
}

export function parseIstClockToDate(hhmm, baseNowMs = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  const hh = m ? Math.max(0, Math.min(23, parseInt(m[1], 10))) : 18;
  const mm = m ? Math.max(0, Math.min(59, parseInt(m[2], 10))) : 30;
  const istNow = new Date(baseNowMs + IST_OFFSET_MS);
  const utcMs =
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), hh, mm, 0, 0) -
    IST_OFFSET_MS;
  return new Date(utcMs);
}

export const SCENARIO_PRESETS = [
  {
    id: 'pm-peak',
    label: 'PM peak',
    title: 'PM Peak (18:30 IST)',
    istClock: '18:30',
    demandScale: 1.2,
    chaos: null,
    description: 'Evening IT corridor rush across Silk Board, ORR & Marathahalli (18:30 IST).',
  },
  {
    id: 'am-peak',
    label: 'AM peak',
    title: 'AM Peak (09:00 IST)',
    istClock: '09:00',
    demandScale: 1.18,
    chaos: null,
    description: 'Morning inbound arterial rush toward Koramangala, Bellandur & Hebbal (09:00 IST).',
  },
  {
    id: 'pm-stalled-silkboard',
    label: 'PM + Silk Board stall',
    title: 'PM Peak + Silk Board Stall',
    istClock: '18:30',
    demandScale: 1.2,
    chaos: {
      type: 'stalled',
      junctionId: 'JNC-BLR-001',
      approachIdx: 1,
      multiplier: 4.0,
      capacityFactor: 0.15,
      durationSec: 300,
    },
    description:
      '18:30 IST evening rush with a stalled heavy vehicle blocking ORR (from east / Bellandur) at Silk Board (0.15x lane capacity).',
  },
  {
    id: 'monsoon-pm-peak',
    label: 'Monsoon PM peak',
    title: 'Monsoon + PM Peak',
    istClock: '18:30',
    demandScale: 1.2,
    chaos: {
      type: 'monsoon',
      junctionId: 'JNC-BLR-001',
      capacityFactor: 0.7,
      speedFactor: 0.75,
      durationSec: 240,
    },
    description: 'City-wide monsoon rainfall (-30% saturation flow, -25% free-flow speed) during PM rush.',
  },
  {
    id: 'ambulance-corridor',
    label: 'Ambulance corridor',
    title: 'Ambulance Corridor',
    istClock: '18:30',
    demandScale: 1.25,
    chaos: {
      type: 'ambulance',
      startJunctionId: 'JNC-BLR-008',
      destinationJunctionId: 'JNC-BLR-004',
      junctionId: 'JNC-BLR-008',
      path: [
        'JNC-BLR-008',
        'JNC-BLR-010',
        'JNC-BLR-012',
        'JNC-BLR-011',
        'JNC-BLR-003',
        'JNC-BLR-004',
      ],
      durationSec: 120,
      preempt: true,
    },
    description:
      'Emergency responder green corridor dispatch from Hebbal Flyover (008) through Mekhri, Town Hall, Richmond, and Dairy Circle to Jayadeva Hospital (004).',
  },
];

export function resolveInitialSimStart(rawSpec = process.env.SIM_START || 'auto') {
  const spec = String(rawSpec || 'auto').trim().toLowerCase();
  if (spec === 'now') {
    return {
      startTime: new Date(),
      presetId: 'live-now',
      label: 'Live IST',
      note: 'wall-clock IST',
      demandScale: 1.0,
    };
  }
  if (/^\d{1,2}:\d{2}$/.test(spec)) {
    return {
      startTime: parseIstClockToDate(spec),
      presetId: 'custom',
      label: `Custom ${spec}`,
      note: `SIM_START=${spec} IST`,
      demandScale: 1.0,
    };
  }

  // SIM_START=auto: stay on wall clock during AM/PM peak windows; otherwise boot into the most recent peak
  const nowH = getIstHour(Date.now());
  if (nowH >= 8 && nowH < 11.5) {
    return {
      startTime: new Date(),
      presetId: 'am-peak',
      label: 'AM peak',
      note: null,
      demandScale: 1.18,
    };
  }
  if (nowH >= 17 && nowH < 21) {
    return {
      startTime: new Date(),
      presetId: 'pm-peak',
      label: 'PM peak',
      note: null,
      demandScale: 1.2,
    };
  }
  if (nowH >= 11.5 && nowH < 17) {
    return {
      startTime: parseIstClockToDate('09:00'),
      presetId: 'am-peak',
      label: 'AM peak',
      note: 'off-peak wall-clock fallback',
      demandScale: 1.18,
    };
  }
  return {
    startTime: parseIstClockToDate('18:30'),
    presetId: 'pm-peak',
    label: 'PM peak',
    note: 'off-peak wall-clock fallback',
    demandScale: 1.2,
  };
}

const VALID_CONTROLLERS = new Set([
  'auto',
  'fixed-tod',
  'fixed-naive',
  'fixed-time',
  'webster',
  'max-pressure',
  'max-pressure-ca',
]);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

class SimulatorService {
  constructor() {
    this.network = DEFAULT_NETWORK;
    this.junctions = this.network.junctions;
    this.devices = this.junctions; // compatibility alias
    this.studyPolicy = loadStudyPolicy();

    this.simSpeed = Math.max(0.25, Math.min(20, parseFloat(process.env.SIM_SPEED) || 1));
    const defaultEmitHz = Math.max(0.2, Math.min(100, parseFloat(process.env.SIM_EMIT_HZ) || 2));
    this.emitHz = defaultEmitHz;
    this.targetRate = Math.round(this.emitHz * this.junctions.length);

    this.isRunning = false;
    this._physicsTimer = null;
    this._emitTimer = null;
    this._cfTimer = null;
    this._nextPhysicsAt = 0;
    this._nextEmitAt = 0;
    this._lastCfBroadcastElapsed = -1;
    this._lastServerlessStepAt = Date.now();

    this.sequenceMap = new Map();
    this.queueHistory = new Map(); // junctionId -> [{ elapsedSec, totalQueueVeh, maxQueueLengthM, avgSpeedKmph, maxVOverC }]
    this.emergencyModeJunctions = new Set();
    // Junctions held in emergency mode by an ambulance green-corridor trip (corridorService).
    // A junction leaves this set when the ambulance has passed it or the trip ends.
    this.corridorHeldJunctions = new Set();
    this.scheduledTasks = []; // { targetElapsedSec, fn }
    this.recentActions = []; // Mirror recent OperatorAction records for fast/test access

    const initialStart = resolveInitialSimStart(process.env.SIM_START || 'auto');
    this.activeScenario = initialStart.presetId;
    this.activeScenarioLabel = initialStart.label;
    this.simStartNote = initialStart.note;
    const isTestEnv = process.env.NODE_ENV === 'test' || process.argv.some((a) => a.includes('--test'));
    this._initPair(initialStart.startTime, {
      demandScale: initialStart.demandScale,
      warmupSteps: isTestEnv ? 0 : 90,
    });
  }

  _initPair(startTime = new Date(), { demandScale = 1.0, warmupSteps = 0, liveControllerFactory = 'auto' } = {}) {
    const seed = process.env.SIM_SEED ? Number(process.env.SIM_SEED) || process.env.SIM_SEED : 20261114;
    this.pair = new CounterfactualPair({
      seed,
      network: this.network,
      startTime,
      dtSec: 1,
      demandScale,
      liveControllerFactory,
      prewarmLinks: true,
    });
    this.queueHistory.clear();
    for (const j of this.junctions) {
      this.queueHistory.set(j.junctionId, []);
    }
    this._recordQueueHistoryPoint();
    if (warmupSteps > 0) {
      for (let i = 0; i < warmupSteps; i++) {
        this.pair.step();
        if (i % 5 === 4 || i === warmupSteps - 1) {
          this._recordQueueHistoryPoint();
        }
      }
    }
  }

  /**
   * Reset simulation twins (used in tests or restarts).
   */
  reset({
    startTime = new Date(),
    liveControllerFactory = 'auto',
    demandScale = 1.0,
    warmupSteps = 0,
    scenario = null,
    scenarioLabel = null,
    simStartNote = null,
  } = {}) {
    const wasRunning = this.isRunning;
    if (wasRunning) this.stop();
    this.sequenceMap.clear();
    this.emergencyModeJunctions.clear();
    this.corridorHeldJunctions.clear();
    this.scheduledTasks = [];
    this.recentActions = [];
    this._lastCfBroadcastElapsed = -1;
    anomalyEngine.reset();

    if (scenario !== null) this.activeScenario = scenario;
    if (scenarioLabel !== null) this.activeScenarioLabel = scenarioLabel;
    if (simStartNote !== undefined) this.simStartNote = simStartNote;

    this._initPair(startTime, { demandScale, warmupSteps, liveControllerFactory });
    if (wasRunning) this.start(this.targetRate);
  }

  getScenarios() {
    return SCENARIO_PRESETS;
  }

  getScenarioMeta() {
    const simTimeMs = this.pair?.live?.simTimeMs || Date.now();
    const todPeriod = getTodPeriod(simTimeMs);
    return {
      scenario: this.activeScenario,
      scenarioLabel: this.activeScenarioLabel,
      simStartNote: this.simStartNote,
      simClockIst: formatIstClock(simTimeMs),
      simTime: new Date(simTimeMs).toISOString(),
      simSpeed: this.simSpeed,
      todPeriod: todPeriod.id,
      demandScale: this.pair?.live?.demandScale ?? 1.0,
    };
  }

  applyScenario(scenarioId, { actor = 'operator' } = {}) {
    const preset = SCENARIO_PRESETS.find((p) => p.id === scenarioId);
    if (!preset) {
      throw new Error(`Unknown scenario preset: ${scenarioId}`);
    }
    return withSyncSpan(
      'sim.scenario',
      {
        attributes: {
          'operator.action': true,
          'sim.scenario': preset.id,
          'sim.actor': String(actor || 'operator'),
        },
      },
      (span) => {
        const wasRunning = this.isRunning;
        const startDate = parseIstClockToDate(preset.istClock);
        this.reset({
          startTime: startDate,
          liveControllerFactory: 'auto',
          demandScale: preset.demandScale,
          warmupSteps: 90,
          scenario: preset.id,
          scenarioLabel: preset.label,
          simStartNote: null,
        });
        // `reset` starts immediately if wasRunning was true; pause during post-warmup chaos setup if running
        if (this.isRunning) this.stop();

        if (preset.chaos?.type === 'stalled') {
          this.injectChaos(
            preset.chaos.junctionId,
            'stalledVehicle',
            preset.chaos.multiplier,
            preset.chaos.durationSec,
            {
              stalled: true,
              approachIdx: preset.chaos.approachIdx,
              capacityFactor: preset.chaos.capacityFactor,
            }
          );
        } else if (preset.chaos?.type === 'monsoon') {
          this.injectChaos(
            preset.chaos.junctionId,
            'monsoon',
            1,
            preset.chaos.durationSec,
            {
              monsoon: true,
              capacityFactor: preset.chaos.capacityFactor,
              speedFactor: preset.chaos.speedFactor,
            }
          );
        } else if (preset.chaos?.type === 'ambulance') {
          const defaultPath = Array.isArray(preset.chaos.path) && preset.chaos.path.length > 0
            ? preset.chaos.path
            : [
                'JNC-BLR-008',
                'JNC-BLR-010',
                'JNC-BLR-012',
                'JNC-BLR-011',
                'JNC-BLR-003',
                'JNC-BLR-004',
              ];
          let path = defaultPath;
          let isDynamicRerouted = false;
          let rerouteReason = null;

          // If central core is jammed/stalled, dynamically route via ORR East bypass
          const mekhriIdx = this.pair.live.junctionIndexById.get('JNC-BLR-010');
          const isMekhriJammed = mekhriIdx !== undefined && this.pair.live.incidents.has(this.pair.live.junctionApproachOffsets[mekhriIdx]);
          if (isMekhriJammed) {
            path = [
              'JNC-BLR-008',
              'JNC-BLR-006',
              'JNC-BLR-007',
              'JNC-BLR-005',
              'JNC-BLR-001',
              'JNC-BLR-004',
            ];
            isDynamicRerouted = true;
            rerouteReason = 'Dynamically rerouted via Outer Ring Road East to bypass jammed Mekhri Circle.';
            console.log(`[TrafficSimulator] ${rerouteReason}`);
          }

          this.enableEmergencyModeForPath(path);
          this.injectChaos(
            preset.chaos.junctionId || 'JNC-BLR-008',
            'ambulancePreemption',
            1,
            preset.chaos.durationSec,
            {
              ambulance: true,
              preempt: Boolean(preset.chaos.preempt),
              path,
              isDynamicRerouted,
              rerouteReason,
            }
          );
        }

        // Advance 25 more steps so incident/monsoon/emergency impact builds realistic gradients immediately
        for (let i = 0; i < 25; i++) {
          this.pair.step();
          if (i % 5 === 4) this._recordQueueHistoryPoint();
        }
        this._recordQueueHistoryPoint();

        // Run background broadcasts under ROOT_CONTEXT so simulator ticks never inherit sim.scenario's traceId
        context.with(ROOT_CONTEXT, () => {
          this.emitNetworkTelemetry();
          socketService.broadcastCounterfactual(this.getCityCounterfactual());
          socketService.broadcastScenarioUpdate(this.getScenarioMeta());
          if (wasRunning) {
            this.start(this.targetRate);
          }
        });
        span?.setAttribute('sim.clock_ist', formatIstClock(this.pair.live.simTimeMs));
        return {
          preset,
          meta: this.getScenarioMeta(),
          state: this.getState(),
        };
      }
    );
  }

  /**
   * Start both the drift-compensated physics loop (1 sim-sec/step * SIM_SPEED)
   * and decoupled telemetry emission loop (`rate` events/sec = emitHz * 12 junctions).
   */
  start(rate = null) {
    if (this.isRunning) {
      this.stop();
    }

    if (rate !== null && rate !== undefined && Number.isFinite(Number(rate))) {
      const safeRate = Math.max(1, Math.min(2000, Number(rate)));
      this.targetRate = safeRate;
      this.emitHz = Math.max(0.1, safeRate / this.junctions.length);
    } else {
      const envHz = parseFloat(process.env.SIM_EMIT_HZ) || 2;
      this.emitHz = Math.max(0.1, Math.min(100, envHz));
      this.targetRate = Math.round(this.emitHz * this.junctions.length);
    }

    this.isRunning = true;
    const now = performance.now();
    this._nextPhysicsAt = now;
    this._nextEmitAt = now;

    context.with(ROOT_CONTEXT, () => {
      this._schedulePhysicsTick();
      this._scheduleEmitTick();

      this._cfTimer = setInterval(() => {
        if (!this.isRunning) return;
        if (this.pair.live.elapsedSec !== this._lastCfBroadcastElapsed) {
          this._lastCfBroadcastElapsed = this.pair.live.elapsedSec;
          socketService.broadcastCounterfactual(this.getCityCounterfactual());
        }
      }, 1000);
      if (this._cfTimer.unref) this._cfTimer.unref();
    });

    console.log(
      `[TrafficSimulator] Physics-driven simulator active. Speed=${this.simSpeed}x (dt=1s), Emit=${this.emitHz.toFixed(2)} Hz (${this.targetRate} events/sec across ${this.junctions.length} BLR junctions).`
    );
  }

  stop() {
    this.isRunning = false;
    if (this._physicsTimer) {
      clearTimeout(this._physicsTimer);
      this._physicsTimer = null;
    }
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    if (this._cfTimer) {
      clearInterval(this._cfTimer);
      this._cfTimer = null;
    }
    console.log('[TrafficSimulator] Stopped.');
  }

  shutdown() {
    this.stop();
  }

  setRate(rate) {
    this.start(rate);
  }

  setSimSpeed(speed) {
    this.simSpeed = clamp(Number(speed) || 1, 0.25, 20);
    if (this.isRunning) {
      if (this._physicsTimer) {
        clearTimeout(this._physicsTimer);
        this._physicsTimer = null;
      }
      this._nextPhysicsAt = performance.now();
      this._schedulePhysicsTick();
    }
    socketService.broadcastScenarioUpdate(this.getScenarioMeta());
    return this.simSpeed;
  }

  _schedulePhysicsTick() {
    if (!this.isRunning) return;
    const physicsIntervalMs = Math.max(25, 1000 / this.simSpeed);
    this._nextPhysicsAt += physicsIntervalMs;

    const now = performance.now();
    // Bound drift recovery so a paused thread does not burst dozens of steps at once
    if (now - this._nextPhysicsAt > physicsIntervalMs * 4) {
      this._nextPhysicsAt = now + physicsIntervalMs;
    }
    const delayMs = Math.max(1, Math.round(this._nextPhysicsAt - now));

    this._physicsTimer = setTimeout(() => {
      if (!this.isRunning) return;
      context.with(ROOT_CONTEXT, () => {
        this.stepPhysics();
        this._schedulePhysicsTick();
      });
    }, delayMs);
    if (this._physicsTimer.unref) this._physicsTimer.unref();
  }

  /**
   * Advance counterfactual physics by 1 discrete sim-second and evaluate delayed tasks/rollouts.
   */
  stepPhysics() {
    const startNs = process.hrtime.bigint();
    this.pair.step();
    this._recordQueueHistoryPoint();
    this._stepEmergencyCorridorBroadcasts();
    this._processScheduledTasks();
    recordSimStep(Number(process.hrtime.bigint() - startNs) / 1e6);
  }

  _stepEmergencyCorridorBroadcasts() {
    const world = this.pair.live;
    if (!world.emergencies || world.emergencies.length === 0) return;

    if (!this._emergencyTracker) {
      this._emergencyTracker = new Map();
    }

    for (let i = 0; i < world.emergencies.length; i++) {
      const em = world.emergencies[i];
      let track = this._emergencyTracker.get(em.id);
      if (!track) {
        track = {
          lastLegIndex: -1,
          junctionEvents: new Map(),
          positions: [],
          startTime: new Date(),
          clearedJunctions: new Set(),
          preemptedJunctions: new Set(),
          saved: false,
        };
        this._emergencyTracker.set(em.id, track);

        socketService.io?.to('corridor').emit('corridor:started', {
          tripId: em.id,
          vehicleId: em.id,
          route: em.path,
          startJunctionId: em.path[0],
          destinationJunctionId: em.path[em.path.length - 1],
          durationSeconds: em.freeFlowTimeSec || 75,
          timestamp: new Date().toISOString(),
        });
      }

      if (em.status === 'en-route') {
        const leg = em.legs?.[em.legIndex];
        const currJId = leg?.junctionId || em.path[em.legIndex] || em.path[0];
        const prevJId =
          em.legIndex > 0
            ? em.legs?.[em.legIndex - 1]?.junctionId || em.path[em.legIndex - 1]
            : em.path[0];
        const nextJId = em.legIndex + 1 < em.path.length ? em.path[em.legIndex + 1] : currJId;

        const fromCoords = JUNCTION_COORDINATES[prevJId] || { latitude: 13.0358, longitude: 77.597 };
        const toCoords = JUNCTION_COORDINATES[currJId] || { latitude: 12.918, longitude: 77.597 };

        const legLengthM = Math.max(1, leg?.lengthM || 500);
        const fraction = Math.min(1, Math.max(0, 1 - em.remainingDistM / legLengthM));

        const latitude = Number(
          (fromCoords.latitude + (toCoords.latitude - fromCoords.latitude) * fraction).toFixed(5)
        );
        const longitude = Number(
          (fromCoords.longitude + (toCoords.longitude - fromCoords.longitude) * fraction).toFixed(5)
        );

        const speedKmph = 48;
        const etaToNextSec = Math.max(1, Math.round(em.remainingDistM / 13.33));

        let doneM = 0;
        if (Array.isArray(em.legs)) {
          for (let l = 0; l < em.legIndex; l++) doneM += em.legs[l].lengthM;
          doneM += legLengthM - em.remainingDistM;
        }
        const totalM = Math.max(1, em.totalLengthM || 1);
        const progressPct = Math.min(100, Math.max(0, Math.round((doneM / totalM) * 100)));

        const posPayload = {
          tripId: em.id,
          vehicleId: em.id,
          latitude,
          longitude,
          speedKmph,
          progressPct,
          lastJunctionId: prevJId,
          currentJunctionId: currJId,
          nextJunctionId: nextJId,
          etaToNextSec,
          route: em.path,
          timestamp: new Date().toISOString(),
        };

        if (track.positions.length < 500) {
          track.positions.push(posPayload);
        }

        const toZone = JUNCTION_COORDINATES[currJId]?.zoneId;

        // Broadcast 2 Hz position updates
        socketService.io?.to('corridor').emit('corridor:position', posPayload);
        socketService.io?.to(`junction:${currJId}`).emit('corridor:position', posPayload);
        if (toZone) {
          socketService.io?.to(`zone:${toZone}`).emit('corridor:position', posPayload);
        }

        // If leg changed or just initialized, handle preemption announcements
        if (track.lastLegIndex !== em.legIndex) {
          track.lastLegIndex = em.legIndex;

          if (!track.preemptedJunctions.has(currJId)) {
            track.preemptedJunctions.add(currJId);
            const incomingRoad = getIncomingApproachRoad(prevJId, currJId);
            const now = new Date();
            track.junctionEvents.set(currJId, {
              junctionId: currJId,
              incomingRoad,
              preemptedAt: now,
              clearedAt: null,
            });

            socketService.io
              ?.to('corridor')
              .to(`zone:${toZone}`)
              .to(`junction:${currJId}`)
              .emit('corridor:junction_preempted', {
                junctionId: currJId,
                tripId: em.id,
                incomingRoad,
                timestamp: now.toISOString(),
                adaptiveSignalMode: 'emergency-corridor',
              });

            socketService.io
              ?.to(`junction:${currJId}`)
              .to(`zone:${toZone}`)
              .emit('corridor:officer_alert', {
                junctionId: currJId,
                tripId: em.id,
                junctionName: JUNCTION_COORDINATES[currJId]?.name || currJId,
                incomingRoad,
                etaToNextSec,
                message: `Emergency Corridor active at ${JUNCTION_COORDINATES[currJId]?.name || currJId}. Signals locked GREEN on ${incomingRoad} to flush queue. Hold cross-traffic.`,
                timestamp: now.toISOString(),
              });

            socketService.io
              ?.to(`junction:${currJId}`)
              .to(`zone:${toZone}`)
              .emit('corridor:giveway', {
                junctionId: currJId,
                tripId: em.id,
                etaToNextSec,
                junctionName: JUNCTION_COORDINATES[currJId]?.name || currJId,
                incomingRoad,
                message: `Ambulance approaching ${JUNCTION_COORDINATES[currJId]?.name || currJId}. Ahead signals automatically set to GREEN on ${incomingRoad} to flush queue.`,
                timestamp: now.toISOString(),
              });
          }

          // Clear previously passed junction
          if (em.legIndex > 0) {
            const passedJId = em.legs[em.legIndex - 1]?.junctionId;
            if (passedJId && !track.clearedJunctions.has(passedJId)) {
              track.clearedJunctions.add(passedJId);
              const clearNow = new Date();
              if (track.junctionEvents.has(passedJId)) {
                track.junctionEvents.get(passedJId).clearedAt = clearNow;
              }
              const passedZone = JUNCTION_COORDINATES[passedJId]?.zoneId || 'south-bangalore';
              socketService.io
                ?.to('corridor')
                .to(`zone:${passedZone}`)
                .to(`junction:${passedJId}`)
                .emit('corridor:junction_cleared', {
                  junctionId: passedJId,
                  tripId: em.id,
                  timestamp: clearNow.toISOString(),
                  adaptiveSignalMode: 'dynamic-ai',
                });
            }
          }
        }
      } else if (em.status === 'completed' && !track.saved) {
        track.saved = true;
        const endTime = new Date();
        const durationSeconds = Math.round((endTime.getTime() - track.startTime.getTime()) / 1000);

        const lastJId = em.path[em.path.length - 1];
        if (track.junctionEvents.has(lastJId)) {
          track.junctionEvents.get(lastJId).clearedAt = endTime;
        }
        const lastZone = JUNCTION_COORDINATES[lastJId]?.zoneId || 'south-bangalore';
        socketService.io
          ?.to('corridor')
          .to(`zone:${lastZone}`)
          .to(`junction:${lastJId}`)
          .emit('corridor:junction_cleared', {
            junctionId: lastJId,
            tripId: em.id,
            timestamp: endTime.toISOString(),
            adaptiveSignalMode: 'dynamic-ai',
          });

        const summary = {
          tripId: em.id,
          vehicleId: em.id,
          startJunctionId: em.path[0],
          destinationJunctionId: em.path[em.path.length - 1],
          routeJunctionIds: em.path,
          status: 'completed',
          startTime: track.startTime,
          endTime,
          durationSeconds,
          junctionEvents: Array.from(track.junctionEvents.values()),
          positions: track.positions || [],
          isDynamicRerouted: Boolean(em.isDynamicRerouted),
          rerouteReason: em.rerouteReason || null,
        };

        if (mongoose.connection?.readyState === 1) {
          CorridorTrip.create(summary).catch((err) => {
            console.warn('[TrafficSimulator] Warning saving CorridorTrip:', err.message);
          });
        }

        socketService.io?.to('corridor').emit('corridor:ended', summary);
      }
    }
  }

  _recordQueueHistoryPoint() {
    const world = this.pair.live;
    const elapsedSec = world.elapsedSec;
    const snap = world.snapshot();

    for (let j = 0; j < world.numJunctions; j++) {
      const junc = world.junctions[j];
      const jId = junc.junctionId;
      const offset = world.junctionApproachOffsets[j];
      const count = world.junctionApproachCounts[j];

      let totalQueueVeh = 0;
      for (let a = 0; a < count; a++) {
        totalQueueVeh += world.queueVeh[offset + a];
      }
      const jSnap = snap.junctions[jId];
      const hist = this.queueHistory.get(jId);
      hist.push({
        elapsedSec,
        totalQueueVeh,
        maxQueueLengthM: jSnap.maxQueueLengthM,
        avgSpeedKmph: jSnap.avgSpeedKmph,
        vOverC: jSnap.kpi.degreeOfSaturation,
      });
      if (hist.length > 180) {
        hist.shift();
      }
    }
  }

  getQueueHistory(junctionId, windowSec = 120) {
    const hist = this.queueHistory.get(junctionId) || [];
    if (hist.length === 0) return [];
    const latestElapsed = hist[hist.length - 1].elapsedSec;
    const cutoff = latestElapsed - windowSec;
    return hist.filter((pt) => pt.elapsedSec >= cutoff);
  }

  _scheduleEmitTick() {
    if (!this.isRunning) return;
    // Cap timer frequency at 50 Hz; emit multiple batches per tick when targetRate > 600 e/s
    const batchesPerCycle = this.emitHz > 50 ? Math.max(1, Math.round(this.emitHz / 50)) : 1;
    const effectiveHz = this.emitHz / batchesPerCycle;
    const emitIntervalMs = Math.max(10, 1000 / effectiveHz);
    this._nextEmitAt += emitIntervalMs;

    const now = performance.now();
    if (now - this._nextEmitAt > emitIntervalMs * 4) {
      this._nextEmitAt = now + emitIntervalMs;
    }
    const delayMs = Math.max(1, Math.round(this._nextEmitAt - now));

    this._emitTimer = setTimeout(() => {
      if (!this.isRunning) return;
      context.with(ROOT_CONTEXT, () => {
        for (let b = 0; b < batchesPerCycle; b++) {
          this.emitNetworkTelemetry();
        }
        this._scheduleEmitTick();
      });
    }, delayMs);
    if (this._emitTimer.unref) this._emitTimer.unref();
  }

  /**
   * Emit one schema-compatible telemetry event per junction from the current `live` snapshot.
   */
  emitNetworkTelemetry() {
    const world = this.pair.live;
    const snap = world.snapshot();

    for (const junc of this.junctions) {
      const jId = junc.junctionId;
      const jSnap = snap.junctions[jId];
      const seq = (this.sequenceMap.get(jId) || 0) + 1;
      this.sequenceMap.set(jId, seq);

      const status = this.determineStatus(jSnap);
      const event = {
        eventId: `EVT-${Date.now()}-${seq}-${crypto.randomBytes(2).toString('hex')}`,
        junctionId: jId,
        deviceId: jId,
        deviceName: junc.name,
        junctionName: junc.name,
        zoneId: junc.zoneId,
        zoneName: junc.zoneName,
        category: junc.zoneId,
        timestamp: snap.simTime,
        sequence: seq,
        source: 'simulated-physics',
        data: {
          approaches: jSnap.approaches,
          vehicleMix: jSnap.vehicleMix,
          stalledVehicleDetected: jSnap.stalledVehicleDetected,
          ambulanceDetected: jSnap.ambulanceDetected,
          totalFlowVehiclesPerMin: jSnap.totalFlowVehiclesPerMin,
          maxQueueLengthM: jSnap.maxQueueLengthM,
          avgSpeedKmph: jSnap.avgSpeedKmph,
          congestionScore: jSnap.congestionScore,
          control: jSnap.control,
          kpi: jSnap.kpi,
        },
        metrics: {
          totalFlowVehiclesPerMin: jSnap.totalFlowVehiclesPerMin,
          maxQueueLengthM: jSnap.maxQueueLengthM,
          avgSpeedKmph: jSnap.avgSpeedKmph,
          congestionScore: jSnap.congestionScore,
          stalledVehicleDetected: jSnap.stalledVehicleDetected,
          ambulanceDetected: jSnap.ambulanceDetected,
        },
        status,
        location: junc.location,
      };

      const startT = performance.now();
      ingestionBuffer.enqueue(event);
      anomalyEngine.evaluate(event);
      socketService.broadcastTelemetry(event);
      const latency = Math.max(0, performance.now() - startT);
      metricsService.recordIngest(1, latency);
    }
  }

  /**
   * Build a connected corridor path of 3-4 junctions passing through `junctionId`
   * using real directed links in DEFAULT_NETWORK.
   */
  findCorridorPathThrough(junctionId, targetLength = 4) {
    const links = this.network.links;
    const outgoing = new Map();
    const incoming = new Map();
    for (const l of links) {
      if (!outgoing.has(l.fromJunction)) outgoing.set(l.fromJunction, []);
      if (!incoming.has(l.toJunction)) incoming.set(l.toJunction, []);
      outgoing.get(l.fromJunction).push(l.toJunction);
      incoming.get(l.toJunction).push(l.fromJunction);
    }

    const path = [junctionId];
    const visited = new Set(path);

    // Prepend one upstream neighbor if available so emergency approaches *into* `junctionId`
    const ups = (incoming.get(junctionId) || []).filter((id) => !visited.has(id));
    if (ups.length > 0) {
      path.unshift(ups[0]);
      visited.add(ups[0]);
    }

    // Extend downstream up to `targetLength`
    while (path.length < targetLength) {
      const tail = path[path.length - 1];
      const nexts = (outgoing.get(tail) || []).filter((id) => !visited.has(id));
      if (nexts.length === 0) break;
      path.push(nexts[0]);
      visited.add(nexts[0]);
    }

    return path;
  }

  /**
   * Hold emergency mode on a corridor trip's route (called by corridorService when a trip
   * starts). Each junction is released with releaseCorridorJunction() once the ambulance
   * has passed it, so the map stops showing it as an emergency.
   */
  holdEmergencyModeForCorridor(path) {
    for (const jId of path) this.corridorHeldJunctions.add(jId);
    this.enableEmergencyModeForPath(path);
  }

  releaseCorridorJunction(junctionId) {
    this.corridorHeldJunctions.delete(junctionId);
    this.pruneEmergencyMode();
  }

  /**
   * Drop junctions from emergency mode that nothing needs any more: no corridor trip holds
   * them and no en-route simulated emergency vehicle still has them on its path. Without this
   * the set only ever grew, so every junction an ambulance had used stayed marked as an
   * emergency on the map until the simulator was reset.
   */
  pruneEmergencyMode() {
    if (this.emergencyModeJunctions.size === 0) return;
    const stillNeeded = new Set(this.corridorHeldJunctions);
    for (const em of this.pair?.live?.emergencies || []) {
      if (em.status !== 'en-route') continue;
      for (const jId of em.path || []) stillNeeded.add(jId);
    }
    for (const jId of Array.from(this.emergencyModeJunctions)) {
      if (!stillNeeded.has(jId)) this.emergencyModeJunctions.delete(jId);
    }
  }

  isCorridorInEmergencyMode(path) {
    return path.some((jId) => this.emergencyModeJunctions.has(jId));
  }

  enableEmergencyModeForPath(path) {
    for (const jId of path) {
      this.emergencyModeJunctions.add(jId);
    }
    // Enable preemption on any matching en-route ambulances in the LIVE world only (never baseline)
    for (const em of this.pair.live.emergencies) {
      if (em.status === 'en-route' && em.path.some((id) => this.emergencyModeJunctions.has(id))) {
        em.preempt = true;
      }
    }
  }

  /**
   * Inject chaos/incidents from the Chaos Lab directly into the physical twins.
   * Applied to BOTH live and baseline twins identically under Common Random Numbers
   * (baseline NEVER receives emergency signal preemption).
   */
  injectChaos(junctionId, metric, multiplier = 2.5, durationSec = 20, flags = {}) {
    const world = this.pair.live;
    const safeDur = Math.max(5, Number(durationSec) || 20);
    const safeMult = Number(multiplier) || 2.5;
    const untilSec = world.elapsedSec + safeDur;

    // 1. Network-wide monsoon weather condition
    if (metric === 'monsoon' || flags.monsoon) {
      const cap = flags.capacityFactor ?? 0.7;
      const spd = flags.speedFactor ?? 0.75;
      this.pair.setGlobalWeather({
        type: 'monsoon',
        capacityFactor: cap,
        speedFactor: spd,
        until: untilSec,
      });
      console.log(
        `[TrafficSimulator] Injected network monsoon on BOTH twins (cap=${cap}, speed=${spd}) for ${safeDur}s`
      );
      return {
        success: true,
        type: 'monsoon',
        message: `Monsoon active across all junctions (cap=${cap}, speed=${spd}) for ${safeDur}s`,
      };
    }

    // 2. Stalled vehicle / broken-down bus -> lane capacity reduction incident
    if (flags.stalled || metric === 'stalledVehicle') {
      const capFactor = Number.isFinite(Number(flags.capacityFactor))
        ? clamp(Number(flags.capacityFactor), 0.1, 0.6)
        : clamp(1 / Math.max(1.5, safeMult), 0.15, 0.55);
      const approachIdx = Number.isInteger(flags.approachIdx) ? flags.approachIdx : 0;
      this.pair.injectIncident(junctionId, approachIdx, {
        type: 'stalled',
        capacityFactor: capFactor,
        until: untilSec,
      });
      console.log(
        `[TrafficSimulator] Injected stalled-vehicle incident at ${junctionId} approach ${approachIdx} (capFactor=${capFactor.toFixed(2)}) for ${safeDur}s`
      );
      return {
        success: true,
        type: 'stalled',
        junctionId,
        approachIdx,
        capacityFactor: Number(capFactor.toFixed(2)),
        message: `Chaos active: stalled vehicle incident on ${junctionId} approach ${approachIdx} (capFactor=${capFactor.toFixed(2)}) for ${safeDur}s`,
      };
    }

    // 3. Emergency responder dispatch along a connected corridor path
    if (flags.ambulance || metric === 'ambulancePreemption') {
      const path = Array.isArray(flags.path) && flags.path.length > 0
        ? flags.path
        : this.findCorridorPathThrough(junctionId);
      const preempt =
        typeof flags.preempt === 'boolean'
          ? flags.preempt
          : this.isCorridorInEmergencyMode(path);
      const { live: emLive } = this.pair.dispatchEmergency({ path, preempt });
      console.log(
        `[TrafficSimulator] Dispatched ambulance ${emLive.id} along ${path.join(' -> ')} (live preempt=${preempt}, baseline preempt=false)`
      );
      return {
        success: true,
        type: 'ambulance',
        emergencyId: emLive.id,
        path,
        preempt,
        message: `Emergency responder ${emLive.id} dispatched along ${path.join(' -> ')} (preempt=${preempt})`,
      };
    }

    // 4. Queue / congestion / arrival demand surge on BOTH twins
    const approachIdx = Number.isInteger(flags.approachIdx) ? flags.approachIdx : 0;
    this.pair.setDemandSurge(junctionId, safeMult, untilSec, approachIdx);
    console.log(
      `[TrafficSimulator] Injected demand surge on ${junctionId} approach ${approachIdx} (x${safeMult}) for ${safeDur}s`
    );
    return {
      success: true,
      type: 'surge',
      junctionId,
      approachIdx,
      multiplier: safeMult,
      message: `Chaos active: demand surge x${safeMult} on ${junctionId} for ${safeDur}s`,
    };
  }

  clearChaos(junctionId, { liveOnly = false } = {}) {
    if (liveOnly) {
      this.pair.live.clearIncident(junctionId);
      return;
    }
    this.pair.clearIncident(junctionId, null, { liveOnly: false });
    this.pair.clearDemandSurge(junctionId);
  }

  setController(junctionId, controllerType, actor = 'Operator') {
    if (!VALID_CONTROLLERS.has(controllerType)) {
      throw new Error(
        `Unsupported controller '${controllerType}'. Allowed: ${[...VALID_CONTROLLERS].join(', ')}`
      );
    }
    const target = junctionId === 'all' || junctionId === '*' ? '*' : junctionId;
    if (target !== '*' && !this.pair.live.junctionIndexById.has(target)) {
      throw new Error(`Unknown junctionId: ${junctionId}`);
    }

    const beforeCtrls = {};
    for (let j = 0; j < this.pair.live.numJunctions; j++) {
      const id = this.pair.live.junctions[j].junctionId;
      if (target === '*' || target === id) {
        beforeCtrls[id] = this.pair.live.controllers[j].name;
      }
    }

    this.pair.setController(target, controllerType);
    console.log(
      `[TrafficSimulator] Controller switched by ${actor} for ${target} -> ${controllerType}`
    );

    return {
      target,
      controller: controllerType,
      previousControllers: beforeCtrls,
      state: this.getState(),
    };
  }

  scheduleDelayedTask(delaySimSec, fn) {
    const targetElapsedSec = this.pair.live.elapsedSec + Math.max(1, Math.round(delaySimSec));
    this.scheduledTasks.push({ targetElapsedSec, fn });
  }

  registerPendingAction(actionRecord) {
    this.recentActions.unshift(actionRecord);
    if (this.recentActions.length > 100) {
      this.recentActions.pop();
    }

    const horizon = actionRecord.targetMeasureElapsedSec - actionRecord.elapsedSecAtAction;
    this.scheduleDelayedTask(horizon, async () => {
      await this._finalizeActionRealisedEffect(actionRecord.actionId);
    });
  }

  async _finalizeActionRealisedEffect(actionId) {
    const rec = this.recentActions.find((a) => a.actionId === actionId);
    if (!rec || rec.status !== 'pending') return;

    const world = this.pair.live;
    const jSnap = world.snapshot(rec.junctionId);
    const netSnap = world.snapshot();
    if (!jSnap) return;

    const base = rec.baselineMetricsAtAction || {};
    const actualDelayDeltaVehSec = Number(
      (jSnap.kpi.delayVehSec - (base.junctionDelayVehSec ?? 0) - (rec.predictedEffect?.baselineFutureDelayDeltaVehSec ?? 0)).toFixed(2)
    );
    const actualMaxQueueDeltaM = Number(
      (jSnap.maxQueueLengthM - (base.maxQueueLengthM ?? jSnap.maxQueueLengthM)).toFixed(2)
    );
    const actualAvgSpeedDeltaKmph = Number(
      (jSnap.avgSpeedKmph - (base.avgSpeedKmph ?? jSnap.avgSpeedKmph)).toFixed(2)
    );

    // Compare actual vs baseline twin at same junction over the identical elapsed window
    const cf = this.pair.comparison();
    const jCf = cf.byJunction[rec.junctionId];
    const cfDelaySavedDelta = jCf
      ? Number(
          (jCf.delaySavedVehSec - (base.cfDelaySavedVehSecAtAction ?? 0)).toFixed(2)
        )
      : actualDelayDeltaVehSec;

    const predDelayDelta = rec.predictedEffect?.delayDeltaVehSec ?? 0;
    const absErr = Math.abs(cfDelaySavedDelta - -predDelayDelta);
    const denom = Math.max(10, Math.abs(predDelayDelta), Math.abs(cfDelaySavedDelta));
    const predictionAccuracyPct = Number(clamp(100 * (1 - absErr / denom), 0, 100).toFixed(1));

    const realisedEffect = {
      horizonSec: 300,
      measuredAtElapsedSec: world.elapsedSec,
      measuredSimTime: new Date(world.simTimeMs).toISOString(),
      endMaxQueueLengthM: jSnap.maxQueueLengthM,
      endAvgSpeedKmph: jSnap.avgSpeedKmph,
      endCongestionScore: jSnap.congestionScore,
      endAvgDelayPerVehSec: jSnap.kpi.avgDelayPerVehSec,
      actualMaxQueueDeltaM,
      actualAvgSpeedDeltaKmph,
      actualDelaySavedVsBaselineDeltaVehSec: cfDelaySavedDelta,
      networkAvgDelayPerVehSec: netSnap.network.avgDelayPerVehSec,
      predictionAccuracyPct,
    };

    rec.realisedEffect = realisedEffect;
    rec.status = 'measured';

    try {
      await OperatorAction.updateOne(
        { actionId },
        { $set: { realisedEffect, status: 'measured' } }
      );
    } catch {
      // Safe no-op when running unit tests without active MongoDB connection
    }
  }

  _processScheduledTasks() {
    if (this.scheduledTasks.length === 0) return;
    const elapsed = this.pair.live.elapsedSec;
    const remaining = [];
    for (const task of this.scheduledTasks) {
      if (elapsed >= task.targetElapsedSec) {
        try {
          task.fn();
        } catch (err) {
          console.warn('[TrafficSimulator] Scheduled task notice:', err.message);
        }
      } else {
        remaining.push(task);
      }
    }
    this.scheduledTasks = remaining;
  }

  determineStatus(trafficData) {
    return classifyTrafficStatus(trafficData);
  }

  getStatus() {
    const simTimeMs = this.pair.live.simTimeMs;
    return {
      isRunning: this.isRunning,
      targetRate: this.targetRate,
      emitHz: Number(this.emitHz.toFixed(2)),
      simSpeed: this.simSpeed,
      simTime: new Date(simTimeMs).toISOString(),
      simClockIst: formatIstClock(simTimeMs),
      scenario: this.activeScenario,
      scenarioLabel: this.activeScenarioLabel,
      simStartNote: this.simStartNote,
      demandScale: this.pair.live.demandScale,
      elapsedSec: this.pair.live.elapsedSec,
      junctionsCount: this.junctions.length,
      activeEmergencies: this.pair.live.emergencies.filter((e) => e.status === 'en-route').length,
      weatherActive: this.pair.live.weather.active,
      sequences: Object.fromEntries(this.sequenceMap),
    };
  }

  stepServerlessIfDue() {
    if (!process.env.VERCEL || this.isRunning) return;
    const now = Date.now();
    const elapsedMs = now - (this._lastServerlessStepAt || now);
    if (elapsedMs < 350) return;
    this._lastServerlessStepAt = now;
    const steps = Math.min(25, Math.max(1, Math.round((elapsedMs / 1000) * this.simSpeed)));
    for (let i = 0; i < steps; i++) {
      this.pair.step();
      this._processScheduledTasks();
      if (i % 5 === 4 || i === steps - 1) {
        this._recordQueueHistoryPoint();
      }
    }
  }

  getState() {
    this.pruneEmergencyMode();
    const world = this.pair.live;
    const snap = world.snapshot();
    const todPeriod = getTodPeriod(world.simTimeMs);

    const junctions = world.junctions.map((junc, idx) => {
      const jId = junc.junctionId;
      const ctrl = world.controllers[idx];
      const jSnap = snap.junctions[jId];
      return {
        junctionId: jId,
        name: junc.name,
        zoneId: junc.zoneId,
        controller: ctrl.name,
        emergencyMode: this.emergencyModeJunctions.has(jId),
        describe: typeof ctrl.describe === 'function' ? ctrl.describe() : { name: ctrl.name },
        approaches: jSnap.approaches,
        vehicleMix: jSnap.vehicleMix,
        control: jSnap.control,
        kpi: jSnap.kpi,
        congestionScore: jSnap.congestionScore,
        maxQueueLengthM: jSnap.maxQueueLengthM,
        avgSpeedKmph: jSnap.avgSpeedKmph,
        status: this.determineStatus(jSnap),
      };
    });

    return {
      isRunning: this.isRunning,
      simTime: snap.simTime,
      simClockIst: formatIstClock(world.simTimeMs),
      scenario: this.activeScenario,
      scenarioLabel: this.activeScenarioLabel,
      simStartNote: this.simStartNote,
      demandScale: world.demandScale,
      elapsedSec: world.elapsedSec,
      simSpeed: this.simSpeed,
      emitHz: Number(this.emitHz.toFixed(2)),
      targetRate: this.targetRate,
      todPeriod: {
        id: todPeriod.id,
        label: todPeriod.label,
      },
      weather: world.weather.active ? { ...world.weather } : { active: false },
      activeIncidentsCount: world.incidents.size,
      activeSurgesCount: world.surges.size,
      activeDiversionsCount: world.diversions.size,
      activeEmergencies: world.emergencies
        .filter((e) => e.status === 'en-route')
        .map((e) => {
          const leg = e.legs?.[e.legIndex];
          const currJId = leg?.junctionId || e.path[e.legIndex] || e.path[0];
          const prevJId = e.legIndex > 0 ? (e.legs?.[e.legIndex - 1]?.junctionId || e.path[e.legIndex - 1]) : e.path[0];
          const nextJId = e.legIndex + 1 < e.path.length ? e.path[e.legIndex + 1] : currJId;

          const fromCoords = JUNCTION_COORDINATES[prevJId] || { latitude: 13.0358, longitude: 77.5970 };
          const toCoords = JUNCTION_COORDINATES[currJId] || { latitude: 12.9180, longitude: 77.5970 };

          const legLengthM = Math.max(1, leg?.lengthM || 500);
          const fraction = Math.min(1, Math.max(0, 1 - (e.remainingDistM / legLengthM)));

          const latitude = Number((fromCoords.latitude + (toCoords.latitude - fromCoords.latitude) * fraction).toFixed(5));
          const longitude = Number((fromCoords.longitude + (toCoords.longitude - fromCoords.longitude) * fraction).toFixed(5));

          const speedKmph = 48;
          const etaToNextSec = Math.max(1, Math.round(e.remainingDistM / 13.33));

          let doneM = 0;
          if (Array.isArray(e.legs)) {
            for (let i = 0; i < e.legIndex; i++) doneM += e.legs[i].lengthM;
            doneM += (legLengthM - e.remainingDistM);
          }
          const totalM = Math.max(1, e.totalLengthM || 1);
          const progressPct = Math.min(100, Math.max(0, Math.round((doneM / totalM) * 100)));

          return {
            id: e.id,
            vehicleId: e.id || 'AMB-BLR-01',
            path: e.path,
            legIndex: e.legIndex,
            remainingDistM: Math.round(e.remainingDistM),
            preempt: e.preempt,
            waitingAtRedSec: e.waitingAtRedSec,
            latitude,
            longitude,
            speedKmph,
            progressPct,
            lastJunctionId: prevJId,
            currentJunctionId: currJId,
            nextJunctionId: nextJId,
            etaToNextSec,
          };
        }),
      junctions,
      corridors: (this.network.links || []).map((l) => {
        const fromJ = snap.junctions[l.fromJunction];
        const toJ = snap.junctions[l.toJunction];
        const toApp = toJ?.approaches?.[l.toApproachIdx];
        const fromApp = fromJ?.approaches?.[l.fromApproachIdx];
        const approachBaseKmph =
          toApp && fromApp
            ? Math.max(toApp.avgSpeedKmph, fromApp.avgSpeedKmph) * 0.4 + Math.min(toApp.avgSpeedKmph, fromApp.avgSpeedKmph) * 0.6
            : toApp?.avgSpeedKmph ?? fromApp?.avgSpeedKmph ?? 28;
        const vc = Math.max(0, Number(toApp?.vOverC || 0));
        const qLen = Math.max(0, Number(toApp?.queueLengthM || 0));

        // Differentiate corridor capacity tiers for realistic 3-color map display:
        // 1. High-speed expressways & bypass diversion routes (Bellary NH 44 Expressway, ORR South bypass, Koramangala)
        const isBypass =
          (l.corridor.includes('Bellary') && !l.corridor.includes('Central')) ||
          l.corridor === 'ORR South' ||
          l.corridor.includes('Koramangala');

        // 2. Severe bottleneck corridors (Silk Board ORR East, Tin Factory / KR Puram, Central CBD)
        const isBottleneck =
          (l.fromJunction === 'JNC-BLR-001' && l.toJunction === 'JNC-BLR-005') ||
          (l.fromJunction === 'JNC-BLR-005' && l.toJunction === 'JNC-BLR-001') ||
          (l.toJunction === 'JNC-BLR-006' || l.fromJunction === 'JNC-BLR-006') ||
          l.corridor === 'Central';

        const freeFlowArterial = isBypass ? 48 : isBottleneck ? 22 : 36;
        const bprFactor = 1 + (isBottleneck ? 0.35 : 0.18) * Math.pow(Math.min(2.5, vc), 2.0) + Math.min(1.5, qLen / 60);
        const weatherCap = world.weather?.speedFactor ?? 1;
        const traversalKmph = (freeFlowArterial / bprFactor) * weatherCap;
        const baseSpeed = isBottleneck
          ? Math.min(approachBaseKmph, traversalKmph, 13.5)
          : isBypass
          ? Math.max(27.0, traversalKmph * 0.7 + approachBaseKmph * 0.3)
          : traversalKmph * 0.6 + approachBaseKmph * 0.4;

        const speedKmph = Number(
          clamp(
            baseSpeed,
            isBottleneck ? 8 : isBypass ? 26 : 16,
            isBottleneck ? 14.5 : isBypass ? 44 : 24.5
          ).toFixed(1)
        );
        const vOverC = Number(vc.toFixed(2));
        return {
          id: l.id,
          corridor: l.corridor,
          fromJunction: l.fromJunction,
          toJunction: l.toJunction,
          fromApproachIdx: l.fromApproachIdx,
          toApproachIdx: l.toApproachIdx,
          lengthKm: Number((l.lengthKm || 0).toFixed(2)),
          speedKmph,
          vOverC,
        };
      }),
      supervisoryPolicy: this.studyPolicy,
    };
  }

  getCounterfactual() {
    const comp = this.pair.comparison();
    const todPeriod = getTodPeriod(this.pair.live.simTimeMs);
    return {
      ...comp,
      simSpeed: this.simSpeed,
      simClockIst: formatIstClock(this.pair.live.simTimeMs),
      scenario: this.activeScenario,
      scenarioLabel: this.activeScenarioLabel,
      simStartNote: this.simStartNote,
      emitHz: Number(this.emitHz.toFixed(2)),
      todPeriod: todPeriod.id,
      weatherActive: this.pair.live.weather.active,
    };
  }

  /**
   * Slim counterfactual summary emitted over the `city` Socket.IO room (1 Hz).
   * Excludes per-junction maps (`byJunction`) and `emergency.trips` arrays; full
   * breakdown remains available via `GET /api/sim/counterfactual`.
   */
  getCityCounterfactual() {
    const full = this.getCounterfactual();
    const { byJunction, emergency, ...rest } = full;
    if (emergency && typeof emergency === 'object') {
      const { trips, ...emergencySummary } = emergency;
      rest.emergency = emergencySummary;
    }
    return rest;
  }
}

export const simulatorService = new SimulatorService();
