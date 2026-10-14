import 'dotenv/config';

// All tunables in one place. Override any of them with environment variables.
const num = (name, def) => (process.env[name] !== undefined ? Number(process.env[name]) : def);

export const env = {
  port: num('PORT', 4000),

  // Database (PostgreSQL)
  db: {
    host: process.env.PG_HOST || 'localhost',
    port: num('PG_PORT', 5432),
    database: process.env.PG_DATABASE || 'ride_match',
    username: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    logging: process.env.PG_LOGGING === 'true',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: num('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Dispatch parameters
  batchSize: num('BATCH_SIZE', 3),
  offerTimeoutMs: num('OFFER_TIMEOUT_MS', 15000),
  locationTtlMs: num('LOCATION_TTL_MS', 30000),
  maxBatches: num('MAX_BATCHES', 3),

  // H3 resolution for supply index. 7 ~ 1.2 km hex diameter, 8 ~ 0.46 km.
  h3Res: num('H3_RES', 7),
  maxRings: num('MAX_RINGS', 8),
  ringStepMs: num('RING_STEP_MS', 350),

  // Routing engine.
  osrmUrl: process.env.OSRM_URL || 'https://router.project-osrm.org',
  osrmTimeoutMs: num('OSRM_TIMEOUT_MS', 6000),
  avgSpeedKmh: num('AVG_SPEED_KMH', 24),

  // Fare model shown on offers (Rs.)
  fare: {
    base: num('FARE_BASE', 50),
    perKm: num('FARE_PER_KM', 12),
    perMin: num('FARE_PER_MIN', 1.5),
  },

  // City center (New Delhi default)
  city: {
    lat: num('CITY_LAT', 28.625),
    lng: num('CITY_LNG', 77.215),
  },
};

// Alias config to env for compatibility
export const config = env;
export default env;
