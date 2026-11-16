import mongoose from 'mongoose';
import { config } from './config.js';

let mongodInstance = null;
// 'external' | 'in-memory' | 'disconnected' (reported by /api/health)
let databaseType = 'disconnected';

export function getDatabaseInfo() {
  return {
    type: databaseType,
    connected: mongoose.connection.readyState === 1,
    persistent: databaseType === 'external',
  };
}

export async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    if (databaseType === 'disconnected') databaseType = 'external';
    return;
  }

  // Option 1: Try connecting to configured MONGODB_URI
  try {
    const dbTargetKind = /^mongodb\+srv:/i.test(config.mongoUri) ? 'Atlas' : 'local/external';
    console.log(`[DB] Connecting to MongoDB (${dbTargetKind})...`);
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      socketTimeoutMS: 45000,
    });
    databaseType = 'external';
    console.log('[DB] Successfully connected to MongoDB server.');
    return;
  } catch (err) {
    // In production an in-memory database would silently lose all history on restart,
    // so a failed connection stops the server instead of falling back.
    if (config.nodeEnv === 'production') {
      console.error(`[DB] FATAL: could not connect to MongoDB in production (${err.message}).`);
      throw err;
    }
    console.warn(`[DB] Could not connect to local/external MongoDB (${err.message}).`);
    console.log('[DB] Launching in-memory MongoDB instance for seamless standalone operation...');
  }

  // Option 2: Fallback to MongoMemoryServer
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongodInstance = await MongoMemoryServer.create({
      instance: {
        dbName: 'metropulse',
      },
    });
    const uri = mongodInstance.getUri();
    console.log(`[DB] MongoMemoryServer started successfully at ${uri}`);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 60000,
    });
    databaseType = 'in-memory';
    console.log('[DB] Connected to in-memory MongoDB database (development only; data is lost on restart).');
  } catch (memErr) {
    console.error('[DB] MongoMemoryServer initialization error:', memErr.message);
    console.warn('[DB] Continuing with memory store fallback if needed.');
  }

  // Handle Mongoose connection events
  mongoose.connection.on('disconnected', () => {
    console.warn('[DB] Mongoose disconnected. Auto-reconnecting...');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[DB] Mongoose connection error:', err.message);
  });
}

export async function disconnectDB() {
  try {
    await mongoose.disconnect();
    if (mongodInstance) {
      await mongodInstance.stop();
    }
  } catch (err) {
    console.error('[DB] Error during disconnect:', err.message);
  }
}
