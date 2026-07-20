import '../lib/telegram-log-forwarder.js';
import { pathToFileURL } from 'node:url';
import {
  claimOneJob,
  markFailed,
  readPlanJobConfig,
  reapStaleJobs,
  withPlanJobsClient,
} from '../lib/plan-jobs.js';
import { advanceOneStage } from '../lib/plan-workflow.js';
import { sendTelegramMessage } from '../lib/telegram-client.js';
import { saveTelegramChatMessage } from '../lib/postgres.js';
import { telegramTableMessage } from '../lib/telegram-format.js';

const DEFAULT_INTERVAL_MS = 45_000;

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function readPositiveIntEnv(name, defaultValue) {
  const value = readEnv(name);
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function readPlanSchedulerIntervalMs() {
  return readPositiveIntEnv('PLAN_SCHEDULER_INTERVAL_MS', DEFAULT_INTERVAL_MS);
}

function failureMessage(job, reason) {
  return telegramTableMessage('SwingScope plan failed', [
    ['Symbol', job?.resolvedSymbol ?? job?.symbol ?? 'unknown'],
    ['Status', reason || 'The plan workflow could not complete.'],
    ['Next', 'Try /plan again later.'],
  ]);
}

async function persistFailureMessage({ chatId, reply, deps = {} }) {
  const persist = deps.saveTelegramChatMessage ?? saveTelegramChatMessage;
  try {
    await persist({
      chatId,
      direction: 'outbound',
      messageText: reply.text,
      messageType: 'command',
    });
  } catch (error) {
    console.warn('plan failure chat message persistence failed:', error);
  }
}

async function pushFailure(job, reason, deps = {}) {
  const chatId = job?.chatId ?? job?.chat_id;
  if (!chatId) return false;

  const token = deps.telegramBotToken ?? readEnv('TELEGRAM_BOT_TOKEN');
  const sender = deps.sendTelegramMessage ?? sendTelegramMessage;
  if (!token && !deps.sendTelegramMessage) {
    console.warn('Plan scheduler could not push failure message: missing TELEGRAM_BOT_TOKEN.');
    return false;
  }

  const reply = failureMessage(job, reason);
  await sender(token, chatId, reply.text, { parseMode: reply.parseMode });
  await persistFailureMessage({ chatId, reply, deps });
  return true;
}

let running = false;

export async function runOnce(deps = {}) {
  if (running) {
    console.warn('Previous plan scheduler run is still active; skipping this tick.');
    return { event: 'plan_scheduler_tick_skipped', reason: 'already-running' };
  }

  running = true;
  const startedAt = new Date();
  try {
    console.log(`Plan scheduler tick started at ${startedAt.toISOString()}`);
    const withClient = deps.withPlanJobsClient ?? withPlanJobsClient;
    const result = await withClient(async (client) => {
      const config = {
        ...readPlanJobConfig(),
        ...(deps.staleMs ? { staleMs: deps.staleMs } : {}),
        ...(deps.maxRetries ? { maxRetries: deps.maxRetries } : {}),
      };
      const reap = deps.reapStaleJobs ?? reapStaleJobs;
      const claim = deps.claimOneJob ?? claimOneJob;
      const advance = deps.advanceOneStage ?? advanceOneStage;
      const failJob = deps.markFailed ?? markFailed;
      const reaped = await reap(client, config);

      for (const failedJob of reaped.failed ?? []) {
        await pushFailure(failedJob, failedJob.error, deps);
      }

      const job = await claim(client);
      if (!job) {
        return {
          event: 'plan_scheduler_tick_noop',
          reaped: reaped.reaped?.length ?? 0,
          failed: reaped.failed?.length ?? 0,
        };
      }

      try {
        const advanced = await advance(job, { ...deps, client });
        return {
          event: 'plan_scheduler_tick_complete',
          jobId: job.id,
          symbol: job.resolvedSymbol ?? job.symbol,
          stage: job.stage,
          advanced,
          reaped: reaped.reaped?.length ?? 0,
          failed: reaped.failed?.length ?? 0,
        };
      } catch (error) {
        const reason = error?.message ?? 'Plan stage failed.';
        await failJob(client, job.id, reason);
        await pushFailure(job, reason, deps);
        return {
          event: 'plan_scheduler_tick_failed',
          jobId: job.id,
          symbol: job.resolvedSymbol ?? job.symbol,
          stage: job.stage,
          error: reason,
        };
      }
    });

    const output = result ?? { event: 'plan_scheduler_unavailable', reason: 'postgres-not-configured' };
    console.log(JSON.stringify({
      ...output,
      timestamp: new Date().toISOString(),
    }));
    return output;
  } catch (error) {
    console.error('Plan scheduler tick failed:', error);
    return {
      event: 'plan_scheduler_tick_error',
      error: error.message,
    };
  } finally {
    running = false;
  }
}

let timer;
let stopped = false;

function stop(signal) {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  console.log(`Plan scheduler received ${signal}; shutting down.`);
}

async function start() {
  const intervalMs = readPlanSchedulerIntervalMs();
  if (process.argv.includes('--once')) {
    await runOnce();
    return;
  }

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  console.log(`Plan scheduler starting with ${intervalMs}ms interval.`);
  await runOnce();
  if (!stopped) {
    timer = setInterval(runOnce, intervalMs);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  await start();
}
