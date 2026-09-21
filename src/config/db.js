import mongoose from 'mongoose';
import { env } from './env.js';

const CONNECT_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5000,
};

export async function connectDB() {
  mongoose.connection.on('connected', () => {
    console.log('[db] MongoDB connected');
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('[db] MongoDB reconnected');
  });

  mongoose.connection.on('error', (err) => {
    // Log the error type/code but never the URI which may contain credentials
    console.error(`[db] MongoDB error: ${err.name} - ${err.message}`);
  });

  try {
    await mongoose.connect(env.MONGODB_URI, CONNECT_OPTIONS);
  } catch (err) {
    console.error(`[db] Initial connection failed: ${err.message}`);
    process.exit(1);
  }
}

export function getDBStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return states[mongoose.connection.readyState] ?? 'unknown';
}

function gracefulShutdown(signal) {
  console.log(`[db] ${signal} received – closing MongoDB connection`);
  mongoose.connection.close(false).then(() => {
    console.log('[db] MongoDB connection closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
