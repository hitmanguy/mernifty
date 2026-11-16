import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { io as ioClient } from 'socket.io-client';
import { authenticate, publicReadOrAuth, requireRole } from '../middleware/auth.js';
import { metricsService } from '../services/metricsService.js';
import { socketService } from '../services/socketService.js';
import { extractPersistedCount, makeBatchPayload, summarizeLatencySamples } from '../../../scripts/bench/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BENCH_RESULTS_DIR = path.resolve(__dirname, '../../../benchmarks/results');

const router = express.Router();

let activeLiveProbe = false;

function listBenchmarkRuns() {
  if (!fs.existsSync(BENCH_RESULTS_DIR)) {
    return { runs: [], hasLatestMarkdown: false };
  }

  const files = fs
    .readdirSync(BENCH_RESULTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();

  const runs = [];
  for (const filename of files) {
    try {
      const fullPath = path.join(BENCH_RESULTS_DIR, filename);
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (parsed.kind === 'load-benchmark') {
        runs.push({
          filename,
          kind: 'load-benchmark',
          generatedAt: parsed.generatedAt,
          metadata: parsed.metadata,
          summary: parsed.summary,
          otelComparisonScenario: parsed.otelComparisonScenario || null,
          ingestScenarios: parsed.ingestScenarios || [],
          fanoutScenarios: parsed.fanoutScenarios || [],
        });
      } else {
        runs.push({
          filename,
          kind: parsed.kind || 'control-study',
          study: parsed.study || null,
          generatedAt: parsed.generatedAt || null,
          runtimeSec: parsed.runtimeSec || null,
          networkSummary: parsed.networkSummary || null,
          config: parsed.config || null,
          metadata: parsed.metadata || null,
          summary: parsed.summary || null,
          cells: Array.isArray(parsed.cells) ? parsed.cells : [],
        });
      }
    } catch {
      // Skip malformed JSON files cleanly
    }
  }

  const hasLatestMarkdown = fs.existsSync(path.join(BENCH_RESULTS_DIR, 'latest.md'));
  return { runs, hasLatestMarkdown };
}

function postLoopbackBatch(baseUrl, authHeader, payload) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL('/api/telemetry/batch', baseUrl);
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(payload);
    const t0 = performance.now();
    const req = transport.request(
      targetUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rttMs = performance.now() - t0;
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, rttMs });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Loopback batch timeout')));
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// GET /api/benchmarks — lists recorded benchmark result files (metadata + summary)
router.get('/', publicReadOrAuth, (req, res) => {
  const { runs, hasLatestMarkdown } = listBenchmarkRuns();
  res.json({
    success: true,
    activeLiveProbe,
    hasLatestMarkdown,
    runs,
  });
});

// POST /api/benchmarks/live — Admin only bounded <=10s in-process ingest + fanout probe streaming to `engineering`
router.post('/live', authenticate, requireRole(['admin']), async (req, res) => {
  if (activeLiveProbe) {
    return res.status(409).json({
      success: false,
      error: 'A live benchmark probe is already running',
    });
  }

  const addr = req.socket?.server?.address?.();
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const baseUrl =
    process.env.SERVER_URL ||
    (addr && addr.port ? `http://127.0.0.1:${addr.port}` : hostHeader ? `${proto}://${hostHeader}` : null);
  if (!baseUrl) {
    return res.status(503).json({
      success: false,
      error: 'HTTP server target unavailable for live loopback probe',
    });
  }

  const rawDur = Number(req.body?.durationSec ?? 10);
  const durationSec = Number.isFinite(rawDur) ? Math.min(10, Math.max(1, rawDur)) : 10;
  const probeClientCount = Math.min(24, Math.max(4, Number(req.body?.clients ?? 12)));
  const authHeader = req.headers.authorization || '';

  activeLiveProbe = true;
  const probeSockets = [];
  let progressTimer = null;

  try {
    const zones = ['south-bangalore', 'east-bangalore', 'north-bangalore', 'central-bangalore'];

    let deliveredFrames = 0;
    let receivedBytes = 0;

    // Connect bounded viewer fan-out probe clients cleanly
    await Promise.all(
      Array.from({ length: probeClientCount }, (_, idx) =>
        new Promise((resolve) => {
          const sock = ioClient(baseUrl, {
            transports: ['websocket'],
            reconnection: false,
          });
          probeSockets.push(sock);
          const timeout = setTimeout(resolve, 2500);
          sock.once('connect', () => {
            clearTimeout(timeout);
            sock.on('telemetry:zone', (pkt) => {
              deliveredFrames += Array.isArray(pkt?.rows) ? pkt.rows.length : 1;
              receivedBytes += Buffer.byteLength(JSON.stringify(['telemetry:zone', pkt]));
            });
            sock.emit('subscribe', {
              city: false,
              zones: [zones[idx % zones.length]],
              junctions: [],
              alerts: [],
            });
            resolve();
          });
          sock.once('connect_error', () => {
            clearTimeout(timeout);
            resolve();
          });
        })
      )
    );

    const startSnap = await metricsService.getSnapshotAsync();
    const startPersisted = extractPersistedCount({
      counters: startSnap.otel?.counters || {},
      metrics: startSnap,
    });
    const rtts = [];
    let acceptedEvents = 0;
    let http429Count = 0;
    let http503Count = 0;
    const runTag = `live-${crypto.randomBytes(3).toString('hex')}`;
    let seq = 1;
    const startMs = performance.now();
    const endAtMs = startMs + durationSec * 1000;

    socketService.broadcastEngineeringEvent('bench:progress', {
      status: 'running',
      elapsedSec: 0,
      totalSec: durationSec,
      acceptedEvents: 0,
      acceptedEventsPerSec: 0,
      persistedDelta: 0,
      persistedEventsPerSec: 0,
      deliveredFrames: 0,
      deliveredFramesPerSec: 0,
      rttP95Ms: 0,
      clientCount: probeSockets.filter((s) => s.connected).length,
    });

    progressTimer = setInterval(async () => {
      try {
        const snap = await metricsService.getSnapshotAsync();
        const curPersisted = extractPersistedCount({
          counters: snap.otel?.counters || {},
          metrics: snap,
        });
        const elapsedSec = Math.max(0.1, (performance.now() - startMs) / 1000);
        const persistedDelta = Math.max(0, curPersisted - startPersisted);
        const latSummary = summarizeLatencySamples(rtts);
        socketService.broadcastEngineeringEvent('bench:progress', {
          status: 'running',
          elapsedSec: Number(Math.min(durationSec, elapsedSec).toFixed(1)),
          totalSec: durationSec,
          acceptedEvents,
          acceptedEventsPerSec: Number((acceptedEvents / elapsedSec).toFixed(1)),
          persistedDelta,
          persistedEventsPerSec: Number((persistedDelta / elapsedSec).toFixed(1)),
          deliveredFrames,
          deliveredFramesPerSec: Number((deliveredFrames / elapsedSec).toFixed(1)),
          rttP95Ms: latSummary.p95,
          clientCount: probeSockets.filter((s) => s.connected).length,
        });
      } catch {
        // ignore transient progress broadcast errors
      }
    }, 1000);
    if (progressTimer.unref) progressTimer.unref();

    // Paced bounded batch workers (2 concurrent workers, batch 50, ~10 batches/s max)
    const worker = async () => {
      while (performance.now() < endAtMs) {
        const curSeq = seq;
        seq += 50;
        const batch = makeBatchPayload({ batchSize: 50, runTag, startSeq: curSeq });
        try {
          const r = await postLoopbackBatch(baseUrl, authHeader, batch);
          rtts.push(r.rttMs);
          if (r.status === 202 || r.status === 200) {
            acceptedEvents += r.json?.acceptedCount ?? batch.length;
          } else if (r.status === 429) {
            http429Count += 1;
          } else if (r.status === 503) {
            http503Count += 1;
          }
        } catch {
          // ignore transient socket reset on shutdown
        }
        await new Promise((r) => setTimeout(r, 80));
      }
    };

    await Promise.all([worker(), worker()]);
    clearInterval(progressTimer);
    progressTimer = null;

    const totalSec = Math.max(0.1, (performance.now() - startMs) / 1000);
    const endSnap = await metricsService.getSnapshotAsync();
    const endPersisted = extractPersistedCount({
      counters: endSnap.otel?.counters || {},
      metrics: endSnap,
    });
    const persistedDelta = Math.max(0, endPersisted - startPersisted);
    const rttStats = summarizeLatencySamples(rtts);

    const result = {
      status: 'completed',
      elapsedSec: Number(totalSec.toFixed(2)),
      totalSec: durationSec,
      clientCount: probeSockets.filter((s) => s.connected).length,
      acceptedEvents,
      acceptedEventsPerSec: Number((acceptedEvents / totalSec).toFixed(1)),
      persistedDelta,
      persistedEventsPerSec: Number((persistedDelta / totalSec).toFixed(1)),
      deliveredFrames,
      deliveredFramesPerSec: Number((deliveredFrames / totalSec).toFixed(1)),
      receivedBytes,
      http429Count,
      http503Count,
      rttMs: rttStats,
      rttP95Ms: rttStats.p95,
      completedAt: new Date().toISOString(),
    };

    socketService.broadcastEngineeringEvent('bench:progress', result);
    res.json({ success: true, result });
  } catch (err) {
    socketService.broadcastEngineeringEvent('bench:progress', {
      status: 'error',
      error: err.message,
    });
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    for (const s of probeSockets) {
      try {
        s.disconnect();
      } catch {
        // ignore
      }
    }
    activeLiveProbe = false;
  }
});

export default router;
