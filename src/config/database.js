import { Sequelize } from 'sequelize';
import pg from 'pg';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

const { Client } = pg;

/**
 * Automatically creates the database (e.g. ride_match) if it does not exist yet
 * by connecting to the default 'postgres' database first.
 */
async function ensureDatabaseExists() {
  const adminClient = new Client({
    host: env.db.host,
    port: env.db.port,
    user: env.db.username,
    password: env.db.password,
    database: 'postgres',
  });

  try {
    await adminClient.connect();
    const checkRes = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [env.db.database]
    );

    if (checkRes.rowCount === 0) {
      logger.info(`[DB] Database "${env.db.database}" not found. Creating it automatically...`);
      await adminClient.query(`CREATE DATABASE "${env.db.database}"`);
      logger.ok(`[DB] Database "${env.db.database}" created successfully!`);
    }
  } catch (err) {
    logger.error(`[DB] Database check/create failed: ${err.message}`);
    throw err;
  } finally {
    try {
      await adminClient.end();
    } catch (_) {}
  }
}

export const sequelize = new Sequelize(
  env.db.database,
  env.db.username,
  env.db.password,
  {
    host: env.db.host,
    port: env.db.port,
    dialect: 'postgres',
    logging: env.db.logging ? (msg) => logger.debug(msg) : false,
    pool: {
      max: 15,
      min: 2,
      acquire: 30000,
      idle: 10000,
    },
  }
);

export async function initDatabase() {
  try {
    // 1. Ensure the database itself exists
    await ensureDatabaseExists();

    // 2. Connect to the target database and sync all tables
    await sequelize.authenticate();
    logger.ok(`[DB] Connected to database "${env.db.database}" successfully.`);
    await sequelize.sync({ alter: true });
    logger.ok('[DB] All tables (riders, drivers, rides, ride_offers) synchronized successfully.');
  } catch (error) {
    logger.error(`[DB] PostgreSQL initialization error: ${error.message}`);
    throw error;
  }
}
