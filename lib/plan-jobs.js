import pg from 'pg';
import { parsePostgresConnectionString, postgresSslFromConnectionOptions } from './postgres.js';

const { Pool } = pg;

export const PLAN_JOBS_TABLE = 'plan_jobs';
export const PLAN_STAGES = new Set([
  'collect',
  'fact_check',
  'infer',
  'levels',
  'plan',
  'send',
  'done',
]);

const OUTPUT_COLUMNS = new Set([
  'collect_output',
  'factcheck_output',
  'infer_output',
  'levels_output',
  'plan_output',
]);
const DEFAULT_PLAN_STALE_MS = 120_000;
const DEFAULT_PLAN_MAX_RETRIES = 2;

let pool;
let schemaReady;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function readBooleanEnv(env, name, defaultValue) {
  const value = readEnv(env, name).toLowerCase();
  if (!value) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function readPositiveIntEnv(env, name, defaultValue) {
  const value = readEnv(env, name);
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function planPostgresConfig(env = process.env) {
  const connectionString = readEnv(env, 'POSTGRES_URL') || readEnv(env, 'DATABASE_URL');
  const host = readEnv(env, 'POSTGRES_HOST') || readEnv(env, 'PGHOST');
  const port = readEnv(env, 'POSTGRES_PORT') || readEnv(env, 'PGPORT');
  const user = readEnv(env, 'POSTGRES_USER') || readEnv(env, 'POSTGRES_USERNAME') || readEnv(env, 'PGUSER');
  const password = readEnv(env, 'POSTGRES_PASSWORD') || readEnv(env, 'PGPASSWORD');
  const database = readEnv(env, 'POSTGRES_DATABASE') || readEnv(env, 'POSTGRES_DB') || readEnv(env, 'PGDATABASE');
  const parsedPort = Number.parseInt(port, 10);
  const missing = [];

  if (!connectionString) {
    if (!host) missing.push('POSTGRES_HOST');
    if (!port) missing.push('POSTGRES_PORT');
    if (port && (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535)) {
      missing.push('POSTGRES_PORT must be a valid TCP port');
    }
    if (!user) missing.push('POSTGRES_USER or POSTGRES_USERNAME');
    if (!password) missing.push('POSTGRES_PASSWORD');
    if (!database) missing.push('POSTGRES_DATABASE or POSTGRES_DB');
  }

  return {
    connectionString,
    host,
    port: parsedPort,
    user,
    password,
    database,
    ssl: readBooleanEnv(env, 'POSTGRES_SSL', Boolean(env?.VERCEL)),
    maxConnections: readPositiveIntEnv(env, 'POSTGRES_MAX_CONNECTIONS', 1),
    configured: Boolean(connectionString || missing.length === 0),
    missing,
  };
}

function getPool(env = process.env) {
  const config = planPostgresConfig(env);
  if (!config.configured) return null;
  if (pool) return pool;

  const connectionOptions = config.connectionString
    ? parsePostgresConnectionString(config.connectionString)
    : {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
      };
  const connectionSsl = postgresSslFromConnectionOptions(connectionOptions);

  pool = new Pool({
    ...connectionOptions,
    max: config.maxConnections,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: connectionSsl ?? (config.ssl ? { rejectUnauthorized: false } : false),
  });

  return pool;
}

export function readPlanJobConfig(env = process.env) {
  return {
    staleMs: readPositiveIntEnv(env, 'PLAN_STALE_MS', DEFAULT_PLAN_STALE_MS),
    maxRetries: readPositiveIntEnv(env, 'PLAN_MAX_RETRIES', DEFAULT_PLAN_MAX_RETRIES),
  };
}

export function normalizePlanJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    symbol: row.symbol,
    resolvedSymbol: row.resolved_symbol,
    alertable: Boolean(row.alertable),
    direction: row.direction,
    horizon: row.horizon,
    stage: row.stage,
    status: row.status,
    lockedAt: row.locked_at?.toISOString?.() ?? row.locked_at,
    retryCount: Number(row.retry_count ?? 0),
    replySentAt: row.reply_sent_at?.toISOString?.() ?? row.reply_sent_at,
    error: row.error,
    collectOutput: row.collect_output ?? null,
    factcheckOutput: row.factcheck_output ?? null,
    inferOutput: row.infer_output ?? null,
    levelsOutput: row.levels_output ?? null,
    planOutput: row.plan_output ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export async function ensurePlanJobsSchema(client = getPool()) {
  if (!client) return false;

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${PLAN_JOBS_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      resolved_symbol TEXT,
      alertable BOOLEAN NOT NULL DEFAULT FALSE,
      direction TEXT NOT NULL DEFAULT 'both',
      horizon TEXT NOT NULL DEFAULT '1-4w',
      stage TEXT NOT NULL DEFAULT 'collect',
      status TEXT NOT NULL DEFAULT 'pending',
      locked_at TIMESTAMPTZ,
      retry_count INT NOT NULL DEFAULT 0,
      reply_sent_at TIMESTAMPTZ,
      error TEXT,
      collect_output JSONB,
      factcheck_output JSONB,
      infer_output JSONB,
      levels_output JSONB,
      plan_output JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS ${PLAN_JOBS_TABLE}_status_created_at_idx
    ON ${PLAN_JOBS_TABLE} (status, created_at)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS ${PLAN_JOBS_TABLE}_open_chat_symbol_idx
    ON ${PLAN_JOBS_TABLE} (chat_id, UPPER(COALESCE(resolved_symbol, symbol)))
    WHERE status NOT IN ('done', 'failed')
  `);

  return true;
}

async function ensureDefaultPlanJobsSchema() {
  const db = getPool();
  if (!db) return false;
  if (schemaReady) return schemaReady;

  schemaReady = ensurePlanJobsSchema(db).catch(error => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

export async function withPlanJobsClient(fn) {
  const db = getPool();
  if (!db) return null;
  const ready = await ensureDefaultPlanJobsSchema();
  if (!ready) return null;

  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function jobJson(value) {
  return value == null ? null : JSON.stringify(value);
}

export async function insertPlanJob(fields = {}, { client } = {}) {
  const db = client ?? getPool();
  if (!db) return null;
  if (!client) {
    const ready = await ensureDefaultPlanJobsSchema();
    if (!ready) return null;
  }

  const result = await db.query(
    `
      INSERT INTO ${PLAN_JOBS_TABLE} (
        chat_id,
        symbol,
        resolved_symbol,
        alertable,
        direction,
        horizon,
        stage,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'collect', 'pending')
      RETURNING *
    `,
    [
      String(fields.chatId),
      String(fields.symbol),
      fields.resolvedSymbol == null ? null : String(fields.resolvedSymbol),
      Boolean(fields.alertable),
      String(fields.direction || 'both'),
      String(fields.horizon || '1-4w'),
    ],
  );

  return normalizePlanJobRow(result.rows[0]);
}

export async function findOpenJob(chatId, symbol, { client } = {}) {
  const db = client ?? getPool();
  if (!db) return null;
  if (!client) {
    const ready = await ensureDefaultPlanJobsSchema();
    if (!ready) return null;
  }

  const result = await db.query(
    `
      SELECT *
      FROM ${PLAN_JOBS_TABLE}
      WHERE chat_id = $1
        AND status NOT IN ('done', 'failed')
        AND UPPER(COALESCE(resolved_symbol, symbol)) = UPPER($2)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `,
    [String(chatId), String(symbol)],
  );

  return normalizePlanJobRow(result.rows[0]);
}

export async function listPlanJobs(chatId, { symbol, limit = 5, client } = {}) {
  const db = client ?? getPool();
  if (!db) return null;
  if (!client) {
    const ready = await ensureDefaultPlanJobsSchema();
    if (!ready) return null;
  }

  const params = [String(chatId)];
  const normalizedLimit = Math.min(10, Math.max(1, Number.parseInt(limit, 10) || 5));
  let symbolFilter = '';
  if (symbol) {
    params.push(String(symbol));
    symbolFilter = `AND UPPER(COALESCE(resolved_symbol, symbol)) = UPPER($${params.length})`;
  }
  params.push(normalizedLimit);

  const result = await db.query(
    `
      SELECT *
      FROM ${PLAN_JOBS_TABLE}
      WHERE chat_id = $1
        ${symbolFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params,
  );

  return result.rows.map(normalizePlanJobRow);
}

export async function claimOneJob(client = getPool()) {
  if (!client) return null;
  if (client === pool) {
    const ready = await ensureDefaultPlanJobsSchema();
    if (!ready) return null;
  }

  const result = await client.query(`
    UPDATE ${PLAN_JOBS_TABLE}
    SET status = 'running',
        locked_at = NOW(),
        updated_at = NOW()
    WHERE id = (
      SELECT id
      FROM ${PLAN_JOBS_TABLE}
      WHERE status = 'pending'
        AND stage <> 'done'
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);

  return normalizePlanJobRow(result.rows[0]);
}

export async function claimOneJobAtStage(client = getPool(), stage) {
  if (!client) return null;
  if (!PLAN_STAGES.has(String(stage)) || stage === 'done') {
    throw new Error(`Unsupported claim stage: ${stage}`);
  }
  if (client === pool) {
    const ready = await ensureDefaultPlanJobsSchema();
    if (!ready) return null;
  }

  const result = await client.query(
    `
      UPDATE ${PLAN_JOBS_TABLE}
      SET status = 'running',
          locked_at = NOW(),
          updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM ${PLAN_JOBS_TABLE}
        WHERE status = 'pending'
          AND stage = $1
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `,
    [String(stage)],
  );

  return normalizePlanJobRow(result.rows[0]);
}

export async function commitStage(client, jobId, {
  outputColumn,
  output,
  nextStage,
  nextStatus = 'pending',
} = {}) {
  if (!client) throw new Error('commitStage requires a PostgreSQL client.');
  if (!PLAN_STAGES.has(String(nextStage))) throw new Error(`Unsupported next plan stage: ${nextStage}`);
  if (outputColumn && !OUTPUT_COLUMNS.has(outputColumn)) {
    throw new Error(`Unsupported plan output column: ${outputColumn}`);
  }

  await client.query('BEGIN');
  try {
    const params = outputColumn
      ? [jobJson(output), String(nextStage), String(nextStatus), jobId]
      : [String(nextStage), String(nextStatus), jobId];
    const outputAssignment = outputColumn ? `${outputColumn} = $1::jsonb,` : '';
    const stageIndex = outputColumn ? 2 : 1;
    const statusIndex = outputColumn ? 3 : 2;
    const idIndex = outputColumn ? 4 : 3;

    const result = await client.query(
      `
        UPDATE ${PLAN_JOBS_TABLE}
        SET ${outputAssignment}
            stage = $${stageIndex},
            status = $${statusIndex},
            locked_at = NULL,
            retry_count = 0,
            updated_at = NOW()
        WHERE id = $${idIndex}
        RETURNING *
      `,
      params,
    );

    await client.query('COMMIT');
    return normalizePlanJobRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function reapStaleJobs(client = getPool(), options = {}) {
  if (!client) return { reaped: [], failed: [] };
  const config = { ...readPlanJobConfig(), ...options };

  const result = await client.query(
    `
      UPDATE ${PLAN_JOBS_TABLE}
      SET retry_count = retry_count + 1,
          status = CASE
            WHEN retry_count + 1 > $2 THEN 'failed'
            ELSE 'pending'
          END,
          locked_at = NULL,
          error = CASE
            WHEN retry_count + 1 > $2 THEN 'Plan job exceeded retry budget after stale lock.'
            ELSE error
          END,
          updated_at = NOW()
      WHERE status = 'running'
        AND locked_at < NOW() - ($1::int * INTERVAL '1 millisecond')
      RETURNING *
    `,
    [config.staleMs, config.maxRetries],
  );

  const rows = result.rows.map(normalizePlanJobRow);
  return {
    reaped: rows.filter(row => row.status === 'pending'),
    failed: rows.filter(row => row.status === 'failed'),
  };
}

export async function markFailed(client = getPool(), jobId, reason = 'Plan job failed.') {
  if (!client) return null;

  const result = await client.query(
    `
      UPDATE ${PLAN_JOBS_TABLE}
      SET status = 'failed',
          locked_at = NULL,
          error = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [jobId, String(reason)],
  );

  return normalizePlanJobRow(result.rows[0]);
}

export async function markReplySent(client = getPool(), jobId) {
  if (!client) return null;

  const result = await client.query(
    `
      UPDATE ${PLAN_JOBS_TABLE}
      SET reply_sent_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND reply_sent_at IS NULL
      RETURNING *
    `,
    [jobId],
  );

  return normalizePlanJobRow(result.rows[0]);
}
