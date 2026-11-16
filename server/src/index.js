import express from 'express';
import http from 'http';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import { config, findProductionConfigProblems } from './config/config.js';
import { connectDB, getDatabaseInfo } from './config/db.js';
import { socketService } from './services/socketService.js';
import { simulatorService } from './services/simulatorService.js';
import { seedInitialData } from './utils/seedData.js';
import { ensureTelemetryRetention } from './utils/telemetryRetention.js';
import { Telemetry } from './models/Telemetry.js';

import telemetryRoutes from './routes/telemetryRoutes.js';
import deviceRoutes from './routes/deviceRoutes.js';
import alertRoutes from './routes/alertRoutes.js';
import simulatorRoutes from './routes/simulatorRoutes.js';
import authRoutes from './routes/authRoutes.js';
import copilotRoutes from './routes/copilotRoutes.js';
import simRoutes from './routes/simRoutes.js';
import actionRoutes from './routes/actionRoutes.js';
import observabilityRoutes from './routes/observabilityRoutes.js';
import benchmarkRoutes from './routes/benchmarkRoutes.js';
import corridorRoutes from './routes/corridorRoutes.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

if (config.nodeEnv !== 'test') {
  app.use(morgan('short'));
}

// Serve client dist build if present (standalone / Docker single-service mode)
const clientDistPath = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
}

// Lazy single-flight initialization for Vercel serverless Express invocations
let serverlessReadyPromise = null;
const SERVERLESS_DB_BYPASS_PATHS = new Set([
  '/api/health',
  '/api/sim/state',
  '/api/sim/scenarios',
  '/api/sim/counterfactual',
]);

async function ensureServerlessReady() {
  if (!serverlessReadyPromise) {
    serverlessReadyPromise = (async () => {
      const configProblems = findProductionConfigProblems();
      if (configProblems.length > 0) {
        for (const problem of configProblems) console.error(`[Config] FATAL: ${problem}`);
        throw new Error('Refusing to start in production with unsafe configuration.');
      }
      await connectDB();
      await seedInitialData();
      // Keep TTL retention check non-blocking on cold starts so initial requests respond immediately
      ensureTelemetryRetention(Telemetry).catch((err) => {
        console.error(`[DB] Could not apply telemetry retention: ${err.message}`);
      });
    })().catch((err) => {
      serverlessReadyPromise = null;
      throw err;
    });
  }
  return serverlessReadyPromise;
}

if (process.env.VERCEL) {
  app.all('/socket.io*', (req, res) => {
    res.status(503).json({
      success: false,
      code: 'WS_UNAVAILABLE',
      error: 'WebSocket transport is unavailable in serverless Express mode; use HTTP polling fallback.',
    });
  });

  app.use(async (req, res, next) => {
    const hasCredentials = Boolean(req.headers.authorization || req.headers['x-api-key']);
    if (!hasCredentials && req.method === 'GET' && SERVERLESS_DB_BYPASS_PATHS.has(req.path)) {
      return next();
    }
    try {
      await ensureServerlessReady();
      next();
    } catch (err) {
      next(err);
    }
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'MetroPulse BLR Telemetry Server',
    environment: config.nodeEnv,
    database: getDatabaseInfo(),
    demoPersonas: config.demoPersonas,
    websocketSupported: !process.env.VERCEL,
  });
});

// Mount Routes
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/simulator', simulatorRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/copilot', copilotRoutes);
app.use('/api/sim', simRoutes);
app.use('/api/actions', actionRoutes);
app.use('/api/observability', observabilityRoutes);
app.use('/api/benchmarks', benchmarkRoutes);
app.use('/api/corridor', corridorRoutes);

// Fallback to client index.html for SPA routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }
  res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
    if (err) {
      res.status(200).send('MetroPulse BLR Telemetry API Server running. Open Vite frontend on port 5173.');
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[ServerError]', err.stack || err.message);
  }
  res.status(status).json({
    success: false,
    error: status === 413 ? 'Payload too large (max 1mb)' : err.message || 'Internal server error',
    message: err.message,
  });
});

// Boot Sequence
async function startServer() {
  try {
    // 1. Connect to Database
    const configProblems = findProductionConfigProblems();
    if (configProblems.length > 0) {
      for (const problem of configProblems) console.error(`[Config] FATAL: ${problem}`);
      throw new Error('Refusing to start in production with unsafe configuration.');
    }

    await connectDB();

    // Keep the telemetry expiry (TTL index) in line with TELEMETRY_TTL_SEC
    try {
      const retention = await ensureTelemetryRetention(Telemetry);
      const note =
        retention.action === 'updated'
          ? ` (changed from ${retention.previousSec}s)`
          : retention.action === 'created'
            ? ' (index created)'
            : '';
      const removedNote = retention.removed.length > 0 ? `; removed old expiry index ${retention.removed.join(', ')}` : '';
      console.log(`[DB] Telemetry retention: ${retention.ttlSec}s after storage${note}${removedNote}`);
    } catch (err) {
      console.error(`[DB] Could not apply telemetry retention: ${err.message}`);
    }

    // 2. Seed Initial Devices & Admin User
    await seedInitialData();

    // 3. Initialize Socket.IO
    socketService.init(server, config.clientUrl);

    // 4. Start HTTP Server
    server.listen(config.port, () => {
      console.log(`====================================================`);
      console.log(`🚀 MetroPulse BLR Telemetry Engine running on port ${config.port}`);
      console.log(`📡 WebSocket server live with Room selective distribution`);
      console.log(`📊 Health check: http://localhost:${config.port}/api/health`);
      console.log(`====================================================`);

      // 5. Start background virtual device simulator (default SIM_EMIT_HZ=2 Hz => 24 events/sec)
      if (config.simulatorEnabled) {
        simulatorService.start();
      }
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  simulatorService.stop();
  server.close(() => {
    console.log('HTTP & Socket.IO server closed.');
    process.exit(0);
  });
});

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (isMain) {
  startServer();
}

export default app;
export { app, server, startServer };
