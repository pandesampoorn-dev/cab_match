import winston from 'winston';
import path from 'node:path';
import fs from 'node:fs';

const logsDir = path.resolve('logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const recentLogs = [];
const MAX_LOGS = 200;
let opsEmitter = null;

export function setOpsLogEmitter(fn) {
  opsEmitter = fn;
}

// Custom transport to pipe Winston logs into the Ops dashboard live stream & memory buffer
class OpsDashboardTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    const entry = {
      at: Date.now(),
      level: info.level,
      msg: info.message,
    };

    recentLogs.unshift(entry);
    if (recentLogs.length > MAX_LOGS) recentLogs.length = MAX_LOGS;

    if (opsEmitter) {
      try {
        opsEmitter('log', entry);
      } catch (_) {}
    }

    callback();
  }
}

// Console format with colors and timestamp
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'hh:mm:ss A' }),
  winston.format.colorize({ all: false }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `\x1b[2m${timestamp}\x1b[0m [${level}] ${message}`;
  })
);

// File format with JSON
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Create Winston Logger instance
const winstonInstance = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
    }),
    new OpsDashboardTransport(),
  ],
});

export const logger = {
  info: (msg) => winstonInstance.info(msg),
  warn: (msg) => winstonInstance.warn(msg),
  error: (msg) => winstonInstance.error(msg),
  debug: (msg) => winstonInstance.debug(msg),
  // Domain specific aliases
  ride: (msg) => winstonInstance.info(`[RIDE] ${msg}`),
  ok: (msg) => winstonInstance.info(`[OK] ${msg}`),

  getRecentLogs: () => [...recentLogs],

  /**
   * Express HTTP Request logging middleware
   */
  httpMiddleware: (req, res, next) => {
    const start = Date.now();
    const { method, originalUrl } = req;

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const msg = `${method} ${originalUrl} -> ${status} (${duration}ms)`;
      if (status >= 500) winstonInstance.error(msg);
      else if (status >= 400) winstonInstance.warn(msg);
      else winstonInstance.info(msg);
    });

    next();
  },
};

export default logger;
