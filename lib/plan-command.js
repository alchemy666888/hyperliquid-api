import { ASSETS, getHyperliquidSnapshot } from './hyperliquid.js';
import { requestAiChat, requestAiJson } from './ai-client.js';
import { searchForContext } from './search.js';
import {
  buildSearchApiParams,
  extractSearchQuery as defaultExtractSearchQuery,
  getSearchExtractionCache,
} from './intelligence/search-query.js';
import {
  normalizeConditionKind,
  SUPPORTED_PRICE_KINDS,
  SUPPORTED_TECHNICAL_KINDS,
} from './decision-tree-alerts.js';
import {
  escapeTelegramHtml,
  formatTelegramDate,
  htmlMessage,
  telegramTableMessage,
} from './telegram-format.js';
import { getPostgresStatus } from './postgres.js';
import {
  ensurePlanJobsSchema,
  findOpenJob,
  insertPlanJob,
  listPlanJobs as listStoredPlanJobs,
} from './plan-jobs.js';

const DEFAULT_DIRECTION = 'both';
const DEFAULT_HORIZON = '1-4w';
const DIRECTIONS = new Set(['long', 'short', 'both']);
const HORIZON_PATTERN = /^\d+(?:-\d+)?[hdwmy]$/i;
const PLAN_SEARCH_RESULT_LIMIT = 6;
const FACT_CHECK_MAX_TOKENS = 900;
const INFERENCE_MAX_TOKENS = 900;
const PLAN_ASSEMBLY_MAX_TOKENS = 1600;
const PLAN_ASSEMBLY_TIMEOUT_MS = 20_000;
const NEUTRAL_STAGE_PROHIBITION = 'Do not emit entry, stop, target, position size, or buy/sell/long/short recommendations in this stage.';
const TRACKED_SYMBOL_LIST = ASSETS.map(asset => asset.label).join(', ');
const PLAN_STAGE_STEPS = {
  collect: ['Collect', 1],
  fact_check: ['Fact check', 2],
  infer: ['Infer', 3],
  levels: ['Levels', 4],
  plan: ['Plan', 5],
  send: ['Send', 6],
  done: ['Done', 6],
};
const PLAN_PENDING_STALE_MS = 3 * 60 * 1000;

function normalizePlanSymbol(value) {
  return String(value ?? '').trim().toUpperCase().replace(/^XYZ:/, '').replace(/[^A-Z0-9]/g, '');
}

function readPositiveIntEnv(name, defaultValue) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parsePlanNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(String(value).replaceAll(',', '').replace(/^\$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePlanArgs(args = []) {
  const tokens = Array.isArray(args) ? args : [];
  const symbol = String(tokens[0] ?? '').trim();
  let direction = DEFAULT_DIRECTION;
  let horizon = DEFAULT_HORIZON;

  for (const token of tokens.slice(1)) {
    const value = String(token ?? '').trim();
    const lower = value.toLowerCase();
    if (DIRECTIONS.has(lower)) {
      direction = lower;
      continue;
    }
    if (HORIZON_PATTERN.test(value)) {
      horizon = lower;
    }
  }

  return { symbol, direction, horizon };
}

export function resolvePlanSymbol(symbolInput, assets = ASSETS) {
  const symbol = normalizePlanSymbol(symbolInput);
  if (!symbol) return { resolvedSymbol: '', alertable: false, asset: null };

  const asset = assets.find(item => {
    const label = normalizePlanSymbol(item.label ?? item.symbol);
    const coin = normalizePlanSymbol(String(item.coin ?? '').replace(/^xyz:/i, ''));
    const base = label.endsWith('USDT') ? label.slice(0, -4) : label;
    return symbol === label || symbol === coin || symbol === base;
  });

  return {
    resolvedSymbol: asset?.label ?? asset?.symbol ?? symbol,
    alertable: Boolean(asset),
    asset: asset ?? null,
  };
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

async function collectResearchInputs({
  symbol,
  resolvedSymbol,
  alertable,
  direction,
  horizon,
  deps = {},
}) {
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

  if (alertable) {
    try {
      snapshot = await getSnapshot();
      snapshotAsset = findSnapshotAsset(snapshot, resolvedSymbol);
      if (!snapshotAsset) {
        notes.push(`Live Hyperliquid snapshot did not include ${resolvedSymbol}.`);
      }
    } catch (error) {
      notes.push(`Live Hyperliquid snapshot unavailable: ${error.message}`);
    }
  }

  const currentMessage = [
    `${symbol} swing trading research`,
    `direction ${direction}`,
    `horizon ${horizon}`,
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
    snapshot: snapshotForPrompt(snapshotAsset, snapshot),
    search: webSearchContext,
    searchExtraction: extracted,
    notes,
  };
}

function aiUnavailableResult(stage, result, partial = {}) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  return {
    ok: false,
    status: 'ai-unavailable',
    stage,
    error: result?.error ?? 'AI could not complete the research stage.',
    missing,
    ...partial,
  };
}

export async function runResearchStages({
  symbol,
  resolvedSymbol,
  alertable,
  direction,
  horizon,
  deps = {},
} = {}) {
  const aiChat = deps.aiChat ?? deps.deepSeekChat ?? requestAiChat;
  const stageOrder = [];

  try {
    stageOrder.push('collect');
    const collect = await collectResearchInputs({
      symbol,
      resolvedSymbol,
      alertable,
      direction,
      horizon,
      deps,
    });

    stageOrder.push('fact-check');
    const factCheck = await aiChat({
      temperature: 0,
      maxTokens: FACT_CHECK_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content: [
            'You are the fact-check stage of a staged swing-trading research workflow.',
            'Surface factual claims with source attribution, separate verified facts from unverifiable items, and label uncertainty clearly.',
            NEUTRAL_STAGE_PROHIBITION,
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            symbol,
            resolvedSymbol,
            alertable,
            direction,
            horizon,
            snapshot: collect.snapshot,
            searchResults: collect.search?.results ?? [],
            searchContext: collect.search,
            notes: collect.notes,
          }),
        },
      ],
    });

    if (!factCheck.ok) {
      return aiUnavailableResult('fact-check', factCheck, { collect, stageOrder });
    }

    stageOrder.push('infer');
    const inference = await aiChat({
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
            symbol,
            resolvedSymbol,
            alertable,
            direction,
            horizon,
            factCheck: factCheck.text,
            snapshot: collect.snapshot,
            searchContext: collect.search,
          }),
        },
      ],
    });

    if (!inference.ok) {
      return aiUnavailableResult('infer', inference, {
        collect,
        facts: factCheck.text,
        stageOrder,
      });
    }

    return {
      ok: true,
      symbol,
      resolvedSymbol,
      alertable,
      direction,
      horizon,
      snapshot: collect.snapshot,
      search: collect.search,
      searchExtraction: collect.searchExtraction,
      facts: factCheck.text,
      inference: inference.text,
      notes: collect.notes,
      stageOrder,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'stage-error',
      stage: stageOrder.at(-1) ?? 'collect',
      error: error.message,
      symbol,
      resolvedSymbol,
      alertable,
      direction,
      horizon,
      stageOrder,
    };
  }
}

function snapshotLevelAnchors(snapshot) {
  const indicators = snapshot?.indicators ?? {};
  return {
    price: snapshot?.price ?? null,
    regime: snapshot?.regime ?? null,
    ema20: indicators.ema20 ?? null,
    ema50: indicators.ema50 ?? null,
    rsi14: indicators.rsi14 ?? null,
    macd: indicators.macd ?? null,
    bollinger: indicators.bollinger ?? null,
    atr14: indicators.atr14 ?? null,
    atr20Avg: indicators.atr20Avg ?? null,
    adx14: indicators.adx14 ?? null,
    plusDI: indicators.plusDI ?? null,
    minusDI: indicators.minusDI ?? null,
    recentHigh20: indicators.recentHigh20 ?? null,
    recentLow20: indicators.recentLow20 ?? null,
    lastVolume: indicators.lastVolume ?? null,
    avgVolume20: indicators.avgVolume20 ?? null,
    volumeSpikeRatio: indicators.volumeSpikeRatio ?? null,
    lastCandle: snapshot?.lastCandle ?? null,
  };
}

function normalizePlanSide(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    entries: Array.isArray(value.entries) ? value.entries : [],
    stop: value.stop ?? value.invalidation ?? null,
    targets: Array.isArray(value.targets) ? value.targets : [],
    rationale: String(value.rationale ?? '').trim(),
  };
}

function conditionPriceValue(condition, ...keys) {
  for (const key of keys) {
    const parsed = parsePlanNumber(condition?.[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function hasRequiredConditionFields(condition, kind) {
  if (SUPPORTED_PRICE_KINDS.has(kind)) {
    if (kind === 'above') {
      return conditionPriceValue(condition, 'lowerPrice', 'upperPrice', 'price', 'threshold') != null;
    }
    if (kind === 'below') {
      return conditionPriceValue(condition, 'upperPrice', 'lowerPrice', 'price', 'threshold') != null;
    }
    return conditionPriceValue(condition, 'lowerPrice', 'lower') != null
      && conditionPriceValue(condition, 'upperPrice', 'upper') != null;
  }

  if (kind === 'rsi_below' || kind === 'rsi_above') {
    return parsePlanNumber(condition?.indicatorParams?.threshold ?? condition?.threshold) != null;
  }

  return SUPPORTED_TECHNICAL_KINDS.has(kind);
}

function normalizePlanCondition(condition, direction) {
  const side = String(condition?.side ?? '').trim().toLowerCase();
  if ((direction === 'long' || direction === 'short') && side && side !== direction) return null;

  const conditionKind = normalizeConditionKind(condition?.conditionKind ?? condition?.kind);
  if (!conditionKind || !hasRequiredConditionFields(condition, conditionKind)) return null;

  return {
    ...condition,
    conditionKind,
    kind: conditionKind,
  };
}

function sanitizePlanPayload(payload, { direction }) {
  const plan = {
    analysisSummary: String(payload?.analysisSummary ?? payload?.summary ?? '').trim(),
    conditions: (Array.isArray(payload?.conditions) ? payload.conditions : [])
      .map(condition => normalizePlanCondition(condition, direction))
      .filter(Boolean),
  };

  if (direction !== 'short') {
    const long = normalizePlanSide(payload?.long);
    if (long) plan.long = long;
  }

  if (direction !== 'long') {
    const short = normalizePlanSide(payload?.short);
    if (short) plan.short = short;
  }

  return plan;
}

function fallbackPlanFromInference(inference, error) {
  const text = typeof inference === 'string' ? inference : inference?.inference;
  return {
    analysisSummary: [
      String(text ?? '').trim() || 'The neutral inference stage completed, but the executable JSON plan could not be assembled.',
      error ? `Plan assembly degradation: ${error}` : '',
    ].filter(Boolean).join('\n'),
    conditions: [],
    degraded: true,
  };
}

export async function assemblePlan({
  symbol,
  resolvedSymbol,
  inference,
  facts,
  levels,
  snapshot,
  direction,
  horizon,
  deps = {},
} = {}) {
  const aiJson = deps.aiJson ?? deps.deepSeekJson ?? requestAiJson;
  const timeoutMs = deps.planAssemblyTimeoutMs
    ?? readPositiveIntEnv('PLAN_ASSEMBLY_TIMEOUT_MS', PLAN_ASSEMBLY_TIMEOUT_MS);
  const result = await aiJson({
    temperature: 0,
    maxTokens: PLAN_ASSEMBLY_MAX_TOKENS,
    timeoutMs,
    messages: [
      {
        role: 'system',
        content: [
          'You are the final plan-assembly stage of a staged swing-trading research workflow.',
          'Only this stage may emit concrete entry, stop, target, invalidation, and monitorable trigger conditions.',
          'Return strict JSON only with keys analysisSummary, long, short, and conditions.',
          'For each requested side include entries[], stop, targets[], and rationale.',
          'conditions[] must use only these conditionKind values: above, below, between, rsi_below, rsi_above, macd_cross_up, macd_cross_down, ema_cross_up, ema_cross_down.',
          'Each condition must include symbol, conditionKind, needed price bounds or indicator params, and actionText or label.',
          'Do not include unsupported indicators or unevaluatable conditions.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          symbol,
          resolvedSymbol,
          direction,
          horizon,
          facts,
          neutralInference: inference,
          neutralLevels: levels,
          levelAnchors: snapshotLevelAnchors(snapshot),
        }),
      },
    ],
  });

  if (!result?.ok) {
    return {
      ok: false,
      error: result?.error ?? 'AI returned no usable plan JSON.',
      missing: result?.missing ?? [],
      plan: fallbackPlanFromInference(inference, result?.error),
    };
  }

  const plan = sanitizePlanPayload(result.json, { direction });
  if (!plan.analysisSummary) {
    plan.analysisSummary = String(inference ?? '').trim() || 'Analysis summary unavailable.';
  }

  return { ok: true, plan, raw: result.json };
}

function planText(value) {
  return escapeTelegramHtml(value == null || value === '' ? 'n/a' : value);
}

function planCode(value) {
  return `<code>${planText(value)}</code>`;
}

function stringifyPlanValue(value) {
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? 'n/a');
}

function humanizePlanKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/^./, char => char.toUpperCase());
}

function formatPlanItemSummary(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return stringifyPlanValue(item);
  }

  const type = item.type == null || item.type === '' ? '' : String(item.type);
  const price = item.price == null || item.price === '' ? '' : String(item.price);
  if (type && price) return `${type} @ ${price}`;
  if (type) return type;
  if (price) return price;
  return stringifyPlanValue(item);
}

function formatPlanItemDetails(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];

  const lines = [];
  if (item.rationale) {
    lines.push(`   <i>Why:</i> ${planText(item.rationale)}`);
  }

  for (const [key, value] of Object.entries(item)) {
    if (['type', 'price', 'rationale'].includes(key)) continue;
    lines.push(`   <i>${planText(humanizePlanKey(key))}:</i> ${planText(stringifyPlanValue(value))}`);
  }

  return lines;
}

function formatPlanItems(label, values) {
  const lines = [`<b>${planText(label)}</b>`];
  if (!Array.isArray(values) || !values.length) {
    lines.push(planCode('n/a'));
    return lines.join('\n');
  }

  values.forEach((value, index) => {
    lines.push(`${index + 1}. ${planCode(formatPlanItemSummary(value))}`);
    lines.push(...formatPlanItemDetails(value));
  });

  return lines.join('\n');
}

function formatExecutionSide(label, side) {
  if (!side) return '';
  return [
    `<b>${planText(label)}</b>`,
    formatPlanItems('Entries', side.entries),
    `<b>Stop / invalidation</b>\n${planCode(side.stop ?? 'n/a')}`,
    formatPlanItems('Targets', side.targets),
    side.rationale ? `<b>Rationale</b>\n${planText(side.rationale)}` : '',
  ].filter(Boolean).join('\n\n');
}

function statusLineFor({ pipeline, savedAlerts, rejected = [], notes = [] }) {
  const saved = Array.isArray(savedAlerts) ? savedAlerts : [];
  const savedCount = saved.length;
  const symbol = pipeline?.resolvedSymbol ?? pipeline?.symbol ?? '';

  if (!pipeline?.alertable) {
    return `Alerts skipped — ${symbol} is not one of the 12 tracked symbols (${TRACKED_SYMBOL_LIST}).`;
  }

  const saveFailureNote = notes.find(note =>
    /persistence|postgres|save failed|could not save|not saved/i.test(String(note))
  );
  if (saveFailureNote) return `Alerts not saved: ${saveFailureNote}`;

  const rejectedText = rejected.length
    ? ` ${rejected.length} generated condition${rejected.length === 1 ? '' : 's'} rejected.`
    : '';
  return `Alerts saved: ${savedCount} for ${symbol}.${rejectedText}`;
}

export function formatPlanReply({
  pipeline = {},
  savedAlerts = [],
  rejected = [],
  notes = [],
} = {}) {
  const plan = pipeline.plan ?? {};
  const symbol = pipeline.resolvedSymbol ?? pipeline.symbol ?? 'symbol';
  const analysis = plan.analysisSummary
    || pipeline.inference
    || pipeline.facts
    || 'Analysis unavailable.';
  const execution = [
    formatExecutionSide('Long', plan.long),
    formatExecutionSide('Short', plan.short),
  ].filter(Boolean).join('\n\n') || 'No executable levels were assembled.';
  const allNotes = [
    ...notes,
    ...(Array.isArray(pipeline.notes) ? pipeline.notes : []),
  ].filter(Boolean);
  const noteText = allNotes.length
    ? `\n\n<b>Notes</b>\n${allNotes.map((note, index) => `${index + 1}. ${planText(note)}`).join('\n')}`
    : '';
  const status = statusLineFor({ pipeline, savedAlerts, rejected, notes: allNotes });
  const raw = [
    `<b>SwingScope plan</b>\n${planCode(symbol)}`,
    `<b>Analysis</b>\n${planText(analysis)}`,
    `<b>Execution</b>\n${execution}`,
    `<b>Status</b>\n${planText(status)}${noteText}`,
  ].join('\n\n');

  return htmlMessage(raw);
}

function planUsageMessage() {
  return telegramTableMessage('SwingScope plan usage', [
    ['Syntax', '/plan <symbol> [long|short|both] [horizon]'],
    ['Example', '/plan MU long 2w'],
    ['Tracked', TRACKED_SYMBOL_LIST],
  ]);
}

function planPersistenceUnavailableMessage(status, error) {
  const rows = [
    ['Status', '/plan requires database persistence, which is unavailable.'],
  ];
  if (status?.missing?.length) rows.push(['Missing', status.missing.join(', ')]);
  if (error?.message) rows.push(['Error', error.message]);
  return telegramTableMessage('SwingScope plan unavailable', rows);
}

function planAlreadyQueuedMessage(symbol) {
  return telegramTableMessage('SwingScope plan already running', [
    ['Status', `${symbol} is already being analyzed for this chat.`],
    ['Next', 'Wait for the pushed plan before queueing another run for this symbol.'],
  ]);
}

function planQueuedMessage({ symbol, direction, horizon, alertable }) {
  return telegramTableMessage('SwingScope plan queued', [
    ['Status', `Accepted — analyzing ${symbol}. The workflow is in progress and I'll send the plan here shortly.`],
    ['Progress', 'Queued at collect (step 1/6)'],
    ['Direction', direction],
    ['Horizon', horizon],
    ['Mode', alertable ? 'Alerts enabled for tracked symbol' : 'Analysis only; alerts skipped for non-tracked symbol'],
  ]);
}

function planStageProgress(job = {}) {
  const [label, step] = PLAN_STAGE_STEPS[job.stage] ?? [job.stage || 'unknown', 0];
  if (job.status === 'done') return 'Done';
  if (job.status === 'failed') return `Failed at ${label}`;
  const prefix = job.status === 'running' ? 'Running' : 'Waiting';
  return `${prefix}: ${label} (step ${step || '?'}/6)`;
}

function planStatusText(job = {}) {
  if (job.status === 'done') return 'Done — final reply sent or completed.';
  if (job.status === 'failed') return `Failed — ${job.error || 'no error detail recorded.'}`;
  if (job.status === 'running') return 'In progress — scheduler is working on this stage now.';
  return 'In progress — queued for the next scheduler tick.';
}

function formatPlanJobLine(job) {
  const symbol = job.resolvedSymbol ?? job.symbol ?? 'symbol';
  return `${symbol} | ${planStageProgress(job)} | ${job.direction}/${job.horizon}`;
}

function planJobTimestamp(job = {}) {
  const value = job.updatedAt ?? job.createdAt;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'under 1 minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${remainder ? ` ${remainder} min` : ''}`;
}

function pendingSchedulerWarning(job, now = new Date()) {
  if (job.status !== 'pending' || job.stage !== 'collect') return '';
  const timestamp = planJobTimestamp(job);
  if (!timestamp) return '';
  const ageMs = now.getTime() - timestamp.getTime();
  if (ageMs < PLAN_PENDING_STALE_MS) return '';
  return `No external runner call has picked this up for ${formatAge(ageMs)}. Call /api/plan-runner/collect from your external scheduler.`;
}

function planStatusMessage({ jobs, symbol, now = new Date() }) {
  if (!jobs?.length) {
    return telegramTableMessage('SwingScope plan status', [
      ['Status', symbol ? `No plan jobs found for ${symbol}.` : 'No plan jobs found for this chat.'],
      ['Next', 'Queue one with /plan <symbol> [long|short|both] [horizon].'],
    ]);
  }

  if (symbol || jobs.length === 1) {
    const job = jobs[0];
    const rows = [
      ['Symbol', job.resolvedSymbol ?? job.symbol],
      ['Status', planStatusText(job)],
      ['Progress', planStageProgress(job)],
      ['Direction', job.direction],
      ['Horizon', job.horizon],
      ['Alert mode', job.alertable ? 'Tracked; alerts can be saved' : 'Analysis only; alerts skipped'],
    ];
    const schedulerWarning = pendingSchedulerWarning(job, now);
    if (schedulerWarning) rows.push(['Scheduler', schedulerWarning]);
    if (job.createdAt) rows.push(['Created', formatTelegramDate(job.createdAt)]);
    if (job.updatedAt) rows.push(['Updated', formatTelegramDate(job.updatedAt)]);
    if (job.error) rows.push(['Error', job.error]);
    return telegramTableMessage('SwingScope plan status', rows);
  }

  return telegramTableMessage('SwingScope recent plan jobs', [
    ['Status', 'Latest jobs for this chat'],
    { separator: true },
    ...jobs.map(job => [job.id ? `#${job.id}` : 'Job', formatPlanJobLine(job)]),
  ]);
}

export async function enqueuePlanJob({
  symbolInput,
  args = [],
  body,
  chatId,
  deps = {},
} = {}) {
  void body;

  try {
    const parsed = parsePlanArgs(args);
    const symbol = parsed.symbol || String(symbolInput ?? '').trim();
    if (!symbol) return planUsageMessage();

    const assets = deps.assets ?? ASSETS;
    const resolved = resolvePlanSymbol(symbol, assets);
    const postgresStatus = deps.getPostgresStatus ?? getPostgresStatus;
    const status = postgresStatus();
    if (!status.configured) return planPersistenceUnavailableMessage(status);

    const ensureJobs = deps.ensurePlanJobsSchema ?? ensurePlanJobsSchema;
    const ready = await ensureJobs();
    if (ready === false) return planPersistenceUnavailableMessage(status);

    const lookupOpenJob = deps.findOpenJob ?? findOpenJob;
    const createPlanJob = deps.insertPlanJob ?? insertPlanJob;
    const openJob = await lookupOpenJob(chatId, resolved.resolvedSymbol);
    if (openJob) return planAlreadyQueuedMessage(resolved.resolvedSymbol);

    const inserted = await createPlanJob({
      chatId,
      symbol,
      resolvedSymbol: resolved.resolvedSymbol,
      alertable: resolved.alertable,
      direction: parsed.direction,
      horizon: parsed.horizon,
    });

    if (!inserted) return planPersistenceUnavailableMessage(status);

    return planQueuedMessage({
      symbol: resolved.resolvedSymbol,
      direction: parsed.direction,
      horizon: parsed.horizon,
      alertable: resolved.alertable,
    });
  } catch (error) {
    return planPersistenceUnavailableMessage(null, error);
  }
}

export async function runPlanCommand(input = {}) {
  return enqueuePlanJob(input);
}

export async function planStatusCommand({
  symbolInput,
  args = [],
  chatId,
  deps = {},
} = {}) {
  try {
    const postgresStatus = deps.getPostgresStatus ?? getPostgresStatus;
    const status = postgresStatus();
    if (!status.configured) return planPersistenceUnavailableMessage(status);

    const ensureJobs = deps.ensurePlanJobsSchema ?? ensurePlanJobsSchema;
    const ready = await ensureJobs();
    if (ready === false) return planPersistenceUnavailableMessage(status);

    const assets = deps.assets ?? ASSETS;
    const symbol = String(args[0] ?? symbolInput ?? '').trim();
    const resolved = symbol ? resolvePlanSymbol(symbol, assets) : null;
    const listPlanJobs = deps.listPlanJobs ?? listStoredPlanJobs;
    const jobs = await listPlanJobs(chatId, {
      symbol: resolved?.resolvedSymbol,
      limit: resolved ? 1 : 5,
    });
    if (!jobs) return planPersistenceUnavailableMessage(status);

    return planStatusMessage({
      jobs,
      symbol: resolved?.resolvedSymbol,
      now: deps.now ?? new Date(),
    });
  } catch (error) {
    return planPersistenceUnavailableMessage(null, error);
  }
}
