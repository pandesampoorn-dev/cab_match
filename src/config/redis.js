import { Redis } from 'ioredis';
import { env } from './env.js';

export const redis = new Redis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  lazyConnect: true,
  maxRetriesPerRequest: null, // Required by BullMQ
});

redis.on('connect', () => {
  console.log('[Redis] Connected successfully.');
});

redis.on('error', (err) => {
  console.warn('[Redis] Connection warning/error:', err.message);
});

export async function initRedis() {
  try {
    await redis.connect();
  } catch (e) {
    console.warn('[Redis] Connect failed (fallback mode or reconnecting):', e.message);
  }
}
