import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { initDatabase } from './models/index.js';
import { initRedis } from './config/redis.js';
import { setIo } from './services/dispatch.service.js';
import { setupDriverSocket } from './sockets/driver.socket.js';
import { setupRiderSocket } from './sockets/rider.socket.js';
import { setupOpsSocket, getLiveSnapshot } from './sockets/ops.socket.js';
import { logger, setOpsLogEmitter } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 8000,
});

app.use(express.json());
app.use(logger.httpMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health & Ops State APIs
app.get('/api/test', (_req, res) => {
  res.json({
    message: 'Backend connected successfully!',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    h3Res: env.h3Res,
    batchSize: env.batchSize,
    uptime: process.uptime(),
  });
});

app.get('/api/state', async (_req, res) => {
  try {
    const snap = await getLiveSnapshot();
    res.json({
      ...snap,
      logs: logger.getRecentLogs(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Setup Socket.IO Namespaces
setIo(io);
setOpsLogEmitter((event, payload) => {
  io.of('/ops').emit(event, payload);
});

setupDriverSocket(io);
setupRiderSocket(io);
setupOpsSocket(io);

// Server startup
async function start() {
  logger.info(`Starting Ride-Dispatch Server in ${process.env.NODE_ENV || 'development'} mode...`);

  try {
    await initDatabase();
  } catch (e) {
    logger.error(`PostgreSQL connection failed: ${e.message}`);
    process.exit(1);
  }

  try {
    await initRedis();
  } catch (e) {
    logger.warn(`Redis connection note: ${e.message}`);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${env.port} is already in use! Kill previous node process or change PORT.`);
    } else {
      logger.error(`Server error: ${err.message}`);
    }
  });

  server.listen(env.port, () => {
    logger.ok(`Server listening on http://localhost:${env.port}`);
    logger.info(`Ops Dashboard: http://localhost:${env.port}`);
    logger.info(`Dispatch: Batch Broadcast (Top ${env.batchSize} drivers, ${env.offerTimeoutMs / 1000}s timeout)`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.warn('[Server] Unhandled rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.message);
});

start();

export { app, server, io };
