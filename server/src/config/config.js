import dotenv from 'dotenv';
dotenv.config();

const DEV_JWT_SECRET = 'metropulse_super_secret_jwt_key_2026_dev';

/**
 * Checks that a production deployment has the settings it cannot run safely without.
 * Returns a list of human-readable problems (empty when the configuration is fine).
 *
 * - JWT_SECRET: the development default is public in this repository, so anyone could
 *   forge an admin token against a server that still uses it.
 * - MONGODB_URI: without it the server would fall back to an in-memory database and
 *   lose all stored telemetry on every restart.
 */
export function findProductionConfigProblems(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const problems = [];
  if (!env.JWT_SECRET || env.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET must be set to a private value in production (the development default is public).');
  } else if (env.JWT_SECRET.length < 24) {
    problems.push('JWT_SECRET must be at least 24 characters long in production.');
  }
  if (!env.MONGODB_URI) {
    problems.push('MONGODB_URI must be set in production (for example a MongoDB Atlas connection string).');
  }
  return problems;
}

const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;

export const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  clientUrl: process.env.CLIENT_URL || (vercelHost ? `https://${vercelHost}` : 'http://localhost:5173'),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/metropulse',
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  nodeEnv: process.env.NODE_ENV || 'development',
  simulatorEnabled: process.env.SIMULATOR_ENABLED !== 'false',
  batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS, 10) || 1000,
  batchSize: parseInt(process.env.BATCH_SIZE, 10) || 500,
  // How long telemetry is kept in MongoDB. At the default 24 events/s each stored reading is
  // about 2.6 KB, so one hour levels off near 230 MB: safe within a 512 MB Atlas free cluster.
  telemetryTtlSec: parseInt(process.env.TELEMETRY_TTL_SEC, 10) || 3600,
  publicReadonly: process.env.PUBLIC_READONLY !== 'false',
  demoPersonas:
    process.env.DEMO_PERSONAS !== undefined
      ? process.env.DEMO_PERSONAS === 'true'
      : process.env.NODE_ENV !== 'production',
};
