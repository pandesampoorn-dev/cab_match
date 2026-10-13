import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';

const connection = {
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
};

export const dispatchQueue = new Queue('dispatch-queue', {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
  },
});

let timeoutHandler = async () => {};

export function registerTimeoutHandler(fn) {
  timeoutHandler = fn;
}

export const dispatchWorker = new Worker(
  'dispatch-queue',
  async (job) => {
    if (job.name === 'batch-timeout') {
      await timeoutHandler(job.data);
    }
  },
  { connection }
);

dispatchWorker.on('error', (err) => {
  console.warn('[BullMQ Worker] Error:', err.message);
});
