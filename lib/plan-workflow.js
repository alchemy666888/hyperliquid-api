import { ASSETS, getHyperliquidSnapshot } from './hyperliquid.js';
import { requestAiChat, requestAiJson } from './ai-client.js';
import { searchForContext } from './search.js';
import {
  buildSearchApiParams,
  extractSearchQuery as defaultExtractSearchQuery,
  getSearchExtractionCache,
} from './intelligence/search-query.js';
import {
  getPostgresStatus,
  saveDecisionTreeAlerts,
  saveTelegramChatMessage,
} from './postgres.js';
import { sendTelegramMessage } from './telegram-client.js';
import { normalizePlanRulesToAlerts } from './plan-alerts.js';
import { assemblePlan, formatPlanReply } from './plan-command.js';
import {
  commitStage as defaultCommitStage,
  markReplySent as defaultMarkReplySent,
} from './plan-jobs.js';

const PLAN_SEARCH_RESULT_LIMIT = 6;
const FACT_CHECK_MAX_TOKENS = 900;
const INFERENCE_MAX_TOKENS = 900;
const LEVELS_MAX_TOKENS = 900;
const NEUTRAL_STAGE_PROHIBITION = 'Do not emit entry, stop, target, position size, or buy/sell/long/short recommendations in this stage.';

const STAGE_TRANSITIONS = {
  collect: { outputColumn: 'collect_output', nextStage: 'fact_check' },
  fact_check: { outputColumn: 'factcheck_output', nextStage: 'infer' },
  infer: { outputColumn: 'infer_output', nextStage: 'levels' },
  levels: { outputColumn: 'levels_output', nextStage: 'plan' },
  plan: { outputColumn: 'plan_output', nextStage: 'send' },
};

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlanSymbol(value) {
  return String(value ?? '').trim().toUpperCase().replace(/^XYZ:/, '').replace(/[^A-Z0-9]/g, '');
}

function jobValue(job, camel, snake) {
  return job?.[camel] ?? job?.[snake] ?? null;
}

function jobFields(job = {}) {
  return {
    id: job.id,
    chatId: jobValue(job, 'chatId', 'chat_id'),
    symbol: job.symbol,
    resolvedSymbol: jobValue(job, 'resolvedSymbol', 'resolved_symbol') ?? job.symbol,
    alertable: Boolean(job.alertable),
    direction: job.direction || 'both',
    horizon: job.horizon || '1-4w',
    stage: job.stage || 'collect',
    replySentAt: jobValue(job, 'replySentAt', 'reply_sent_at'),
  };
}

function stageOutput(job, stage) {
  if (stage === 'collect') return jobValue(job, 'collectOutput', 'collect_output');
  if (stage === 'fact_check') return jobValue(job, 'factcheckOutput', 'factcheck_output');
  if (stage === 'infer') return jobValue(job, 'inferOutput', 'infer_output');
  if (stage === 'levels') return jobValue(job, 'levelsOutput', 'levels_output');
  if (stage === 'plan') return jobValue(job, 'planOutput', 'plan_output');
  return null;
}

function findSnapshotAsset(snapshot, symbol) {
  const input = normalizePlanSymbol(symbol);
  return (snapshot?.assets ?? []).find(asset => {
    const label = normalizePlanSymbol(asset.symbol);
    const coin = normalizePlanSymbol(String(asset.coin ?? '').replace(/^xyz:/i, ''));
    const base = label.endsWith('USDT') ? label.slice(0, -4) : label;
    return input === label || input === coin || input === base;
  }) ?? null;
}

function snapshotForPrompt(asset, snapshot) {
  if (!asset) return null;
  return {
    timestamp: snapshot?.timestamp,
    interval: snapshot?.interval,
    symbol: asset.symbol,
    price: asset.price,
    regime: asset.regime,
    indicators: asset.indicators ?? null,
    lastCandle: asset.lastCandle ?? null,
    candlesUsed: asset.candlesUsed ?? null,
  };
}

function fallbackSearchContext(error, query) {
  return {
    source: 'searchapi-io',
    query,
    timestamp: new Date().toISOString(),
    ok: false,
    error: error?.message ? `SearchApi.io search failed: ${error.message}` : String(error),
    results: [],
  };
}

function skippedSearchContext(query, reason) {
  return {
    source: 'searchapi-io',
    query,
    timestamp: new Date().toISOString(),
    ok: false,
    skipped: true,
    reason,
    results: [],
  };
}

function aiFailureMessage(result, fallback) {
  if (Array.isArray(result?.missing) && result.missing.length) {
    return `${fallback} Missing ${result.missing.join(', ')}.`;
  }
  return result?.error ?? fallback;
}

export class PlanStageError extends Error {
  constructor(message, { stage, missing = [], cause } = {}) {
    super(message);
    this.name = 'PlanStageError';
    this.stage = stage;
    this.missing = missing;
    this.cause = cause;
  }
}

function throwAiStageError(stage, result) {
  throw new PlanStageError(
    aiFailureMessage(result, `AI unavailable during ${stage}.`),
    { stage, missing: result?.missing ?? [] },
  );
}

async function runCollectStage(job, deps = {}) {
  const fields = jobFields(job);
  const getSnapshot = deps.getHyperliquidSnapshot ?? deps.getSnapshot ?? getHyperliquidSnapshot;
  const getSearch = deps.getSearch ?? searchForContext;
  const aiJson = deps.aiJson ?? deps.deepSeekJson ?? requestAiJson;
  const extractSearchQuery = deps.extractSearchQuery ?? defaultExtractSearchQuery;
  const extractionCache = deps.extractionCache === undefined
    ? getSearchExtractionCache()
    : deps.extractionCache;
  const notes = [];
  let snapshot = null;
  let snapshotAsset = null;

  if (fields.alertable) {
    try {
      snapshot = await getSnapshot();
      snapshotAsset = findSnapshotAsset(snapshot, fields.resolvedSymbol);
      if (!snapshotAsset) notes.push(`Live Hyperliquid snapshot did not include ${fields.resolvedSymbol}.`);
    } catch (error) {
      notes.push(`Live Hyperliquid snapshot unavailable: ${error.message}`);
    }
  }

  const currentMessage = [
    `${fields.symbol} swing trading research`,
    `direction ${fields.direction}`,
    `horizon ${fields.horizon}`,
    'latest catalysts technical setup news earnings macro',
  ].join(' ');

  let extracted;
  try {
    extracted = await extractSearchQuery({
      message: currentMessage,
      aiJson,
      cache: extractionCache,
    });
  } catch (error) {
    extracted = {
      q: currentMessage,
      gl: 'us',
      hl: 'en',
      freshness: 'd',
      needs_search: true,
      source: 'extractor-error',
      error: error.message,
    };
  }

  const params = buildSearchApiParams(extracted);
  let webSearchContext;
  if (!params) {
    webSearchContext = skippedSearchContext(extracted?.q || currentMessage, 'empty-search-query');
  } else {
    try {
      webSearchContext = await getSearch({
        params,
        limit: PLAN_SEARCH_RESULT_LIMIT,
      });
    } catch (error) {
      webSearchContext = fallbackSearchContext(error, params.q);
    }
  }

  if (!webSearchContext?.ok || !(webSearchContext.results ?? []).length) {
    notes.push('Current web results could not be verified.');
  }

  return {
    stage: 'collect',
    symbol: fields.symbol,
    resolvedSymbol: fields.resolvedSymbol,
    alertable: fields.alertable,
    direction: fields.direction,
    horizon: fields.horizon,
    snapshot: snapshotForPrompt(snapshotAsset, snapshot),
    search: webSearchContext,
    searchExtraction: extracted,
    notes,
    generatedAt: new Date().toISOString(),
  };
}

async function runFactCheckStage(job, deps = {}) {
  const fields = jobFields(job);
  const collect = stageOutput(job, 'collect') ?? {};
  const aiChat = deps.aiChat ?? deps.deepSeekChat ?? requestAiChat;
  const result = await aiChat({
    temperature: 0,
    maxTokens: FACT_CHECK_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: [
          'You are the fact-check stage of a staged swing-trading research workflow.',
          'Surface factual claims with source attribution, separate verified facts from unverifiable items, and label uncertainty clearly.',
          'If current web results are unavailable or empty, state that current web results could not be verified and use only the supplied snapshot plus model knowledge.',
          NEUTRAL_STAGE_PROHIBITION,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          symbol: fields.symbol,
          resolvedSymbol: fields.resolvedSymbol,
          alertable: fields.alertable,
          direction: fields.direction,
          horizon: fields.horizon,
          snapshot: collect.snapshot,
          searchResults: collect.search?.results ?? [],
          searchContext: collect.search,
          notes: collect.notes,
        }),
      },
    ],
  });

  if (!result.ok) throwAiStageError('fact_check', result);

  return {
    stage: 'fact_check',
    facts: result.text,
    provider: result.provider,
    notes: [],
    generatedAt: new Date().toISOString(),
  };
}

async function runInferStage(job, deps = {}) {
  const fields = jobFields(job);
  const collect = stageOutput(job, 'collect') ?? {};
  const factCheck = stageOutput(job, 'fact_check') ?? {};
  const aiChat = deps.aiChat ?? deps.deepSeekChat ?? requestAiChat;
  const result = await aiChat({
    temperature: 0.1,
    maxTokens: INFERENCE_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: [
          'You are the inference stage of a staged swing-trading research workflow.',
          'Use only the verified facts, snapshot inputs, and explicitly labeled assumptions to infer drivers, risks, and scenario pressure for both sides.',
          'Keep this stage neutral and avoid concrete levels.',
          NEUTRAL_STAGE_PROHIBITION,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          symbol: fields.symbol,
          resolvedSymbol: fields.resolvedSymbol,
          alertable: fields.alertable,
          direction: fields.direction,
          horizon: fields.horizon,
          factCheck: factCheck.facts,
          snapshot: collect.snapshot,
          searchContext: collect.search,
        }),
      },
    ],
  });

  if (!result.ok) throwAiStageError('infer', result);

  return {
    stage: 'infer',
    inference: result.text,
    provider: result.provider,
    notes: [],
    generatedAt: new Date().toISOString(),
  };
}

async function runLevelsStage(job, deps = {}) {
  const fields = jobFields(job);
  const collect = stageOutput(job, 'collect') ?? {};
  const factCheck = stageOutput(job, 'fact_check') ?? {};
  const infer = stageOutput(job, 'infer') ?? {};
  const aiChat = deps.aiChat ?? deps.deepSeekChat ?? requestAiChat;
  const result = await aiChat({
    temperature: 0,
    maxTokens: LEVELS_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: [
          'You are the neutral levels stage of a staged swing-trading research workflow.',
          'Derive important support, resistance, volatility, trend, and monitorable signal areas from the verified facts and supplied 4H snapshot fields.',
          'Do not convert these areas into an execution plan in this stage.',
          NEUTRAL_STAGE_PROHIBITION,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          symbol: fields.symbol,
          resolvedSymbol: fields.resolvedSymbol,
          alertable: fields.alertable,
          direction: fields.direction,
          horizon: fields.horizon,
          facts: factCheck.facts,
          inference: infer.inference,
          snapshot: collect.snapshot,
        }),
      },
    ],
  });

  if (!result.ok) throwAiStageError('levels', result);

  return {
    stage: 'levels',
    levels: result.text,
    provider: result.provider,
    notes: [],
    generatedAt: new Date().toISOString(),
  };
}

async function runPlanStage(job, deps = {}) {
  const fields = jobFields(job);
  const collect = stageOutput(job, 'collect') ?? {};
  const factCheck = stageOutput(job, 'fact_check') ?? {};
  const infer = stageOutput(job, 'infer') ?? {};
  const levels = stageOutput(job, 'levels') ?? {};
  const planAssembler = deps.assemblePlan ?? assemblePlan;
  const result = await planAssembler({
    symbol: fields.symbol,
    resolvedSymbol: fields.resolvedSymbol,
    inference: infer.inference,
    facts: factCheck.facts,
    levels: levels.levels,
    snapshot: collect.snapshot,
    direction: fields.direction,
    horizon: fields.horizon,
    deps,
  });

  if (!result?.ok && Array.isArray(result?.missing) && result.missing.length) {
    throwAiStageError('plan', result);
  }

  const plan = result?.plan ?? {
    analysisSummary: infer.inference ?? 'Analysis summary unavailable.',
    conditions: [],
    degraded: true,
  };
  if (!result?.ok && result?.error) plan.assemblyError = result.error;

  return {
    ...plan,
    stage: 'plan',
    generatedAt: new Date().toISOString(),
  };
}

function formatList(values) {
  if (!Array.isArray(values) || !values.length) return 'n/a';
  return values.map(value => {
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }).join(', ');
}

function rawTreeForPlan(plan = {}) {
  const sections = [];
  if (plan.long) {
    sections.push([
      'Long',
      `Entries: ${formatList(plan.long.entries)}`,
      `Stop/invalidation: ${plan.long.stop ?? 'n/a'}`,
      `Targets: ${formatList(plan.long.targets)}`,
      plan.long.rationale ? `Rationale: ${plan.long.rationale}` : '',
    ].filter(Boolean).join('\n'));
  }
  if (plan.short) {
    sections.push([
      'Short',
      `Entries: ${formatList(plan.short.entries)}`,
      `Stop/invalidation: ${plan.short.stop ?? 'n/a'}`,
      `Targets: ${formatList(plan.short.targets)}`,
      plan.short.rationale ? `Rationale: ${plan.short.rationale}` : '',
    ].filter(Boolean).join('\n'));
  }
  return sections.join('\n\n') || plan.analysisSummary || 'SwingScope plan';
}

function pipelineFromJob(job) {
  const fields = jobFields(job);
  const collect = stageOutput(job, 'collect') ?? {};
  const factCheck = stageOutput(job, 'fact_check') ?? {};
  const infer = stageOutput(job, 'infer') ?? {};
  const levels = stageOutput(job, 'levels') ?? {};
  const plan = stageOutput(job, 'plan') ?? {};
  const notes = [
    ...(Array.isArray(collect.notes) ? collect.notes : []),
    ...(Array.isArray(factCheck.notes) ? factCheck.notes : []),
    ...(Array.isArray(infer.notes) ? infer.notes : []),
    ...(Array.isArray(levels.notes) ? levels.notes : []),
    plan.assemblyError ? `Plan assembly degraded: ${plan.assemblyError}` : '',
  ].filter(Boolean);

  return {
    symbol: fields.symbol,
    resolvedSymbol: fields.resolvedSymbol,
    alertable: fields.alertable,
    direction: fields.direction,
    horizon: fields.horizon,
    snapshot: collect.snapshot,
    search: collect.search,
    searchExtraction: collect.searchExtraction,
    facts: factCheck.facts,
    inference: infer.inference,
    levels: levels.levels,
    notes,
    plan,
  };
}

function technicalSymbolList(assets = ASSETS) {
  return assets.map(asset => asset.label).join(', ');
}

async function persistOutboundMessage({ chatId, reply, deps = {} }) {
  const persist = deps.saveTelegramChatMessage ?? saveTelegramChatMessage;
  try {
    await persist({
      chatId,
      direction: 'outbound',
      messageText: reply.text,
      messageType: 'command',
    });
  } catch (error) {
    console.warn('plan outbound chat message persistence failed:', error);
  }
}

async function runSendStage(job, deps = {}) {
  const fields = jobFields(job);
  if (fields.replySentAt) {
    return { skipped: true, reason: 'reply-already-sent' };
  }

  const markReplySent = deps.markReplySent
    ?? ((jobId) => defaultMarkReplySent(deps.client, jobId));
  const guard = await markReplySent(fields.id);
  if (!guard) return { skipped: true, reason: 'reply-already-claimed' };

  const assets = deps.assets ?? ASSETS;
  const pipeline = pipelineFromJob(job);
  const normalizer = deps.normalizePlanRulesToAlerts ?? normalizePlanRulesToAlerts;
  const saveAlerts = deps.saveDecisionTreeAlerts ?? saveDecisionTreeAlerts;
  const postgresStatus = deps.getPostgresStatus ?? getPostgresStatus;
  const notes = [];
  let savedAlerts = [];
  let rejected = [];

  if (pipeline.alertable) {
    const normalized = normalizer(pipeline.plan.conditions ?? [], {
      assets,
      symbol: pipeline.resolvedSymbol,
    });
    rejected = normalized.rejected;

    if (!postgresStatus().configured) {
      notes.push('PostgreSQL persistence unavailable.');
    } else {
      try {
        const saved = await saveAlerts({
          chatId: fields.chatId,
          rawTree: rawTreeForPlan(pipeline.plan),
          rules: normalized.rules,
        });
        savedAlerts = Array.isArray(saved) ? saved : [];
        if (!saved) notes.push('PostgreSQL persistence unavailable.');
      } catch (error) {
        notes.push(`Alert save failed: ${error.message}`);
      }
    }
  } else {
    notes.push(`Alerts skipped because ${pipeline.resolvedSymbol} is not one of the 12 tracked symbols (${technicalSymbolList(assets)}).`);
  }

  const reply = formatPlanReply({
    pipeline,
    savedAlerts,
    rejected,
    notes,
  });
  const token = deps.telegramBotToken ?? readEnv('TELEGRAM_BOT_TOKEN');
  const sender = deps.sendTelegramMessage ?? sendTelegramMessage;
  if (!token && !deps.sendTelegramMessage) {
    throw new PlanStageError('Telegram bot token unavailable; could not send plan.', { stage: 'send' });
  }

  await sender(token, fields.chatId, reply.text, { parseMode: reply.parseMode });
  await persistOutboundMessage({ chatId: fields.chatId, reply, deps });

  return {
    sent: true,
    savedAlertCount: savedAlerts.length,
    rejectedCount: rejected.length,
    notes,
  };
}

async function commitJobStage(job, payload, deps = {}) {
  const commit = deps.commitStage
    ?? ((jobId, input) => defaultCommitStage(deps.client, jobId, input));
  return commit(job.id, payload);
}

export async function advanceOneStage(job, deps = {}) {
  const fields = jobFields(job);
  const stage = fields.stage;
  if (stage === 'done') return { stage, status: 'done' };

  if (stage === 'send') {
    const result = await runSendStage(job, deps);
    await commitJobStage(job, {
      nextStage: 'done',
      nextStatus: 'done',
    }, deps);
    return { stage, status: 'done', ...result };
  }

  const transition = STAGE_TRANSITIONS[stage];
  if (!transition) {
    throw new PlanStageError(`Unsupported plan stage: ${stage}`, { stage });
  }

  const existing = stageOutput(job, stage);
  const output = existing ?? await ({
    collect: runCollectStage,
    fact_check: runFactCheckStage,
    infer: runInferStage,
    levels: runLevelsStage,
    plan: runPlanStage,
  }[stage])(job, deps);

  await commitJobStage(job, {
    outputColumn: transition.outputColumn,
    output,
    nextStage: transition.nextStage,
    nextStatus: 'pending',
  }, deps);

  return {
    stage,
    status: 'advanced',
    nextStage: transition.nextStage,
    reusedOutput: Boolean(existing),
  };
}

export const planWorkflowInternals = {
  runCollectStage,
  runFactCheckStage,
  runInferStage,
  runLevelsStage,
  runPlanStage,
  runSendStage,
  pipelineFromJob,
};
