import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { Device } from '../models/Device.js';
import { User } from '../models/User.js';
import { DeviceKey, hashDeviceKey } from '../models/DeviceKey.js';
import { INITIAL_DEVICES } from '../services/simulatorService.js';

const LEGACY_ADMIN_EMAIL = 'admin@metropulse.io';
const LEGACY_ADMIN_PASSWORDS = ['AdminPassword123!', 'admin123'];
const LEGACY_API_KEY = 'blr_traffic_key_live_command_center_2026';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_KEYS_PATH = path.resolve(__dirname, '../../.env.local-keys');

const ALL_ZONES = [
  'south-bangalore',
  'east-bangalore',
  'north-bangalore',
  'central-bangalore',
];

function resolvePassword(envKey, fallbackEnvKey = null) {
  if (process.env[envKey]) {
    return { password: process.env[envKey], generated: false };
  }
  if (fallbackEnvKey && process.env[fallbackEnvKey]) {
    return { password: process.env[fallbackEnvKey], generated: false };
  }
  return {
    password: crypto.randomBytes(12).toString('base64url'),
    generated: true,
  };
}

/**
 * Idempotent cleanup of legacy seeded admin credentials (exposed git password / static apiKey)
 * and any User.apiKey field matching the leaked legacy key.
 */
export async function cleanupLegacySeededAuth() {
  let deletedUsers = 0;
  let clearedApiKeys = 0;
  let deletedDeviceKeys = 0;

  const candidates = await User.collection
    .find({
      $or: [{ email: LEGACY_ADMIN_EMAIL }, { apiKey: LEGACY_API_KEY }],
    })
    .toArray();

  for (const doc of candidates) {
    let usesLegacyPassword = false;
    if (doc.email === LEGACY_ADMIN_EMAIL && typeof doc.password === 'string') {
      for (const candidatePw of LEGACY_ADMIN_PASSWORDS) {
        if (await bcrypt.compare(candidatePw, doc.password)) {
          usesLegacyPassword = true;
          break;
        }
      }
    }

    if (doc.apiKey === LEGACY_API_KEY || usesLegacyPassword) {
      const delRes = await User.collection.deleteOne({ _id: doc._id });
      deletedUsers += delRes.deletedCount || 0;
    }
  }

  const unsetRes = await User.collection.updateMany(
    { apiKey: LEGACY_API_KEY },
    { $unset: { apiKey: '' } }
  );
  clearedApiKeys = unsetRes.modifiedCount || 0;

  const dkRes = await DeviceKey.deleteMany({ keyHash: hashDeviceKey(LEGACY_API_KEY) });
  deletedDeviceKeys = dkRes.deletedCount || 0;

  if (deletedUsers > 0 || clearedApiKeys > 0 || deletedDeviceKeys > 0) {
    console.log(
      `[Seed] Legacy auth cleanup: deletedUsers=${deletedUsers}, clearedApiKeys=${clearedApiKeys}, deletedDeviceKeys=${deletedDeviceKeys}`
    );
  }

  return { deletedUsers, clearedApiKeys, deletedDeviceKeys };
}

export async function seedInitialData() {
  try {
    // Fast-path: once seeded, skip multi-step upserts & user checks so serverless cold starts stay <100ms
    const [devCount, adminExists, activeKeyExists] = await Promise.all([
      Device.estimatedDocumentCount(),
      User.exists({ email: 'admin@metropulse.io' }),
      DeviceKey.exists({ active: true }),
    ]);
    if (devCount >= INITIAL_DEVICES.length && adminExists && activeKeyExists) {
      return;
    }

    await cleanupLegacySeededAuth();

    // 1. Clean up legacy non-traffic devices & bulk-upsert 12 BLR junctions in a single round-trip
    const trafficIds = INITIAL_DEVICES.map((d) => d.deviceId);
    const now = new Date();
    await Promise.all([
      Device.deleteMany({ deviceId: { $nin: trafficIds } }),
      Device.bulkWrite(
        INITIAL_DEVICES.map((dev) => ({
          updateOne: {
            filter: { deviceId: dev.deviceId },
            update: {
              $set: {
                junctionId: dev.junctionId,
                name: dev.name,
                zoneId: dev.zoneId,
                zoneName: dev.zoneName,
                category: dev.category,
                region: dev.region,
                status: 'online',
                healthScore: 100,
                lastSeen: now,
                lastLocation: dev.location,
                vehicleMix: dev.vehicleMix,
                tags: [dev.zoneId, 'bengaluru-traffic', 'smart-signal'],
              },
            },
            upsert: true,
          },
        })),
        { ordered: false }
      ),
    ]);
    console.log(`[Seed] Seeded / verified ${INITIAL_DEVICES.length} Bengaluru Smart City Traffic Junctions.`);

    // 2. Seed RBAC Demo / Operator Users (parallel & E11000-safe across concurrent cold starts)
    const userSpecs = [
      {
        email: 'admin@metropulse.io',
        name: 'Bengaluru Traffic Operations Commander',
        role: 'admin',
        zones: ALL_ZONES,
        envKey: 'DEMO_ADMIN_PASSWORD',
      },
      {
        email: 'south.operator@metropulse.io',
        name: 'South Zone Desk Operator (Silk Board / Hosur Rd)',
        role: 'operator',
        zones: ['south-bangalore'],
        envKey: 'DEMO_SOUTH_OPERATOR_PASSWORD',
        fallbackEnvKey: 'DEMO_OPERATOR_PASSWORD',
      },
      {
        email: 'east.operator@metropulse.io',
        name: 'East Zone Desk Operator (ORR / Whitefield)',
        role: 'operator',
        zones: ['east-bangalore'],
        envKey: 'DEMO_EAST_OPERATOR_PASSWORD',
        fallbackEnvKey: 'DEMO_OPERATOR_PASSWORD',
      },
      {
        email: 'viewer@metropulse.io',
        name: 'Public Mobility Observer',
        role: 'viewer',
        zones: [],
        envKey: 'DEMO_VIEWER_PASSWORD',
      },
    ];

    await Promise.all(
      userSpecs.map(async (spec) => {
        const existing = await User.findOne({ email: spec.email });
        if (!existing) {
          const { password, generated } = resolvePassword(spec.envKey, spec.fallbackEnvKey);
          try {
            await User.create({
              name: spec.name,
              email: spec.email,
              password,
              role: spec.role,
              zones: spec.zones,
            });
            if (generated && !process.env.VERCEL) {
              console.log(`[Seed] Created user ${spec.email} (role=${spec.role}) with generated password: ${password}`);
            } else {
              console.log(`[Seed] Created user ${spec.email} (role=${spec.role}, zones=[${spec.zones.join(',')}])`);
            }
          } catch (createErr) {
            if (createErr?.code !== 11000) throw createErr;
          }
        } else if (!existing.zones || existing.zones.length === 0) {
          if (spec.zones.length > 0) {
            existing.zones = spec.zones;
            await existing.save();
          }
        }
      })
    );

    // 3. Seed DeviceKey (SHA-256 hashed in DB; skip read-only filesystem writes on Vercel)
    const activeKeysCount = await DeviceKey.countDocuments({ active: true });
    if (activeKeysCount === 0) {
      const keyFromEnv = Boolean(process.env.METROPULSE_API_KEY);
      const rawKey =
        process.env.METROPULSE_API_KEY || `mpk_${crypto.randomBytes(24).toString('hex')}`;
      try {
        await DeviceKey.create({
          keyHash: hashDeviceKey(rawKey),
          prefix: rawKey.slice(0, 12),
          label: 'Bengaluru Primary Camera Telemetry Producer',
          scopes: ['ingest', 'read'],
          allowedJunctionIds: [],
          active: true,
        });
      } catch (dkErr) {
        if (dkErr?.code === 11000) return;
        throw dkErr;
      }

      if (keyFromEnv || process.env.VERCEL) {
        console.log(`[Seed] Registered DeviceKey (prefix=${rawKey.slice(0, 12)}).`);
      } else {
        try {
          fs.writeFileSync(LOCAL_KEYS_PATH, `METROPULSE_API_KEY=${rawKey}\n`, { mode: 0o600 });
          console.log(`[Seed] Generated DeviceKey (prefix=${rawKey.slice(0, 12)}). Saved to server/.env.local-keys.`);
        } catch (fsErr) {
          console.warn('[Seed] Could not write server/.env.local-keys:', fsErr.message);
        }
        console.log(`[Seed] ONE-TIME Device API Key (METROPULSE_API_KEY): ${rawKey}`);
      }
    }
  } catch (err) {
    console.warn('[Seed] Warning during data seed:', err.message);
  }
}
