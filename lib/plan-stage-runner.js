import {
  claimOneJobAtStage,
  markFailed,
  readPlanJobConfig,
  reapStaleJobs,
  withPlanJobsClient,
} from './plan-jobs.js';
import { advanceOneStage } from './plan-workflow.js';
import { sendTelegramMessage } from './telegram-client.js';
import { saveTelegramChatMessage } from './postgres.js';
import { telegramTableMessage } from './telegram-format.js';

export const PLAN_RUNNER_STAGES = new Set([
  'collect',
  'fact_check',
  'infer',
  'levels',
  'plan',
  'send',
]);

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRunnerStage(value) {
  const stage = String(value ?? '').trim().toLowerCase().replaceAll('-', '_');
  return PLAN_RUNNER_STAGES.has(stage) ? stage : '';
}

function failureMessage(job, reason, stage) {
  const failedStage = stage ?? job?.stage;
  const rows = [
    ['Symbol', job?.resolvedSymbol ?? job?.symbol ?? 'unknown'],
  ];
  if (failedStage) rows.push(['Stage', failedStage]);
  rows.push(
    ['Status', reason || 'The plan workflow could not complete.'],
    ['Next', 'Try /plan again later.'],
  );
  return telegramTableMessage('SwingScope plan failed', rows);
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
    console.warn('Plan runner could not push failure message: missing TELEGRAM_BOT_TOKEN.');
    return false;
  }

  const reply = failureMessage(job, reason, job?.stage);
  await sender(token, chatId, reply.text, { parseMode: reply.parseMode });
  await persistFailureMessage({ chatId, reply, deps });
  return true;
}

export async function runPlanStageOnce(stageInput, deps = {}) {
  const stage = normalizeRunnerStage(stageInput);
  if (!stage) {
    return {
      event: 'plan_stage_runner_invalid_stage',
      status: 'error',
      stage: String(stageInput ?? ''),
      allowedStages: [...PLAN_RUNNER_STAGES],
    };
  }

  const withClient = deps.withPlanJobsClient ?? withPlanJobsClient;
  const config = {
    ...readPlanJobConfig(),
    ...(deps.staleMs ? { staleMs: deps.staleMs } : {}),
    ...(deps.maxRetries ? { maxRetries: deps.maxRetries } : {}),
  };
  const reap = deps.reapStaleJobs ?? reapStaleJobs;
  const claim = deps.claimOneJobAtStage ?? claimOneJobAtStage;
  const advance = deps.advanceOneStage ?? advanceOneStage;
  const failJob = deps.markFailed ?? markFailed;

  const claimResult = await withClient(async (client) => {
    const reaped = await reap(client, config);
    const job = await claim(client, stage);
    return { job, reaped };
  });

  if (!claimResult) {
    return {
      event: 'plan_stage_runner_unavailable',
      status: 'error',
      stage,
      reason: 'postgres-not-configured',
    };
  }

  const { job, reaped } = claimResult;
  for (const failedJob of reaped.failed ?? []) {
    await pushFailure(failedJob, failedJob.error, deps);
  }

  if (!job) {
    return {
      event: 'plan_stage_runner_noop',
      stage,
      reaped: reaped.reaped?.length ?? 0,
      failed: reaped.failed?.length ?? 0,
    };
  }

  try {
    const advanced = await advance(job, deps);
    return {
      event: 'plan_stage_runner_complete',
      stage,
      jobId: job.id,
      symbol: job.resolvedSymbol ?? job.symbol,
      advanced,
      reaped: reaped.reaped?.length ?? 0,
      failed: reaped.failed?.length ?? 0,
    };
  } catch (error) {
    const reason = error?.message ?? 'Plan stage failed.';
    const failedStage = error?.stage ?? job.stage ?? stage;
    await withClient(client => failJob(client, job.id, reason));
    await pushFailure({ ...job, stage: failedStage }, reason, deps);
    return {
      event: 'plan_stage_runner_failed',
      stage: failedStage,
      runnerStage: stage,
      jobId: job.id,
      symbol: job.resolvedSymbol ?? job.symbol,
      error: reason,
    };
  }
}
