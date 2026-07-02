import pg from 'pg';

const { Pool } = pg;

const SNAPSHOTS_TABLE = 'hyperliquid_snapshots';
const ALERTS_TABLE = 'telegram_decision_tree_alerts';
const CHAT_MESSAGES_TABLE = 'telegram_chat_messages';

let pool;
let schemaReady;

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function readBooleanEnv(name, defaultValue) {
  const value = readEnv(name).toLowerCase();
  if (!value) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function readIntEnv(name, defaultValue) {
  const value = readEnv(name);
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function parsePostgresConnectionString(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('POSTGRES_URL must use postgres:// or postgresql://');
  }

  const port = url.port ? Number.parseInt(url.port, 10) : undefined;
  if (url.port && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error('POSTGRES_URL contains an invalid port');
  }

  const options = {};
  for (const [key, value] of url.searchParams.entries()) {
    options[key] = value;
  }
  const queryPort = options.port ? Number.parseInt(options.port, 10) : undefined;
  if (options.port && (!Number.isInteger(queryPort) || queryPort <= 0 || queryPort > 65535)) {
    throw new Error('POSTGRES_URL contains an invalid port');
  }

  return {
    ...options,
    host: options.host || url.hostname,
    port: queryPort ?? port,
    user: options.user || decodeURIComponent(url.username),
    password: options.password || decodeURIComponent(url.password),
    database: url.pathname ? decodeURIComponent(url.pathname.slice(1)) : undefined,
  };
}

function postgresSslFromConnectionOptions(options) {
  if (!options) return undefined;

  if (options.ssl === 'true' || options.ssl === '1') return true;
  if (options.ssl === '0' || options.ssl === 'false') return false;

  switch (options.sslmode) {
    case 'disable':
      return false;
    case 'no-verify':
      return { rejectUnauthorized: false };
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return true;
    default:
      return undefined;
  }
}

function getPostgresConfig() {
  const connectionString = readEnv('POSTGRES_URL') || readEnv('DATABASE_URL');
  const host = readEnv('POSTGRES_HOST') || readEnv('PGHOST');
  const port = readEnv('POSTGRES_PORT') || readEnv('PGPORT');
  const user = readEnv('POSTGRES_USER') || readEnv('POSTGRES_USERNAME') || readEnv('PGUSER');
  const password = readEnv('POSTGRES_PASSWORD') || readEnv('PGPASSWORD');
  const database = readEnv('POSTGRES_DATABASE') || readEnv('POSTGRES_DB') || readEnv('PGDATABASE');
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
    ssl: readBooleanEnv('POSTGRES_SSL', Boolean(process.env.VERCEL)),
    maxConnections: readIntEnv('POSTGRES_MAX_CONNECTIONS', 1),
    configured: Boolean(connectionString || missing.length === 0),
    missing,
  };
}

export function getPostgresStatus() {
  const config = getPostgresConfig();
  return {
    configured: config.configured,
    ssl: config.ssl,
    usingConnectionString: Boolean(config.connectionString),
    env: {
      hostConfigured: Boolean(config.host || config.connectionString),
      portConfigured: Boolean(config.port || config.connectionString),
      usernameConfigured: Boolean(config.user || config.connectionString),
      passwordConfigured: Boolean(config.password || config.connectionString),
      databaseConfigured: Boolean(config.database || config.connectionString),
    },
    missing: config.missing,
  };
}

function getPool() {
  const config = getPostgresConfig();
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

async function ensureSchema() {
  const db = getPool();
  if (!db) return false;
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${SNAPSHOTS_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        interval TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'success',
        snapshot JSONB NOT NULL
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${SNAPSHOTS_TABLE}_source_interval_captured_at_idx
      ON ${SNAPSHOTS_TABLE} (source, interval, captured_at DESC)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${ALERTS_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        condition_text TEXT NOT NULL,
        condition_kind TEXT NOT NULL,
        lower_price NUMERIC,
        upper_price NUMERIC,
        action_text TEXT NOT NULL,
        raw_tree TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_matched BOOLEAN NOT NULL DEFAULT FALSE,
        last_checked_at TIMESTAMPTZ,
        last_checked_price NUMERIC,
        last_triggered_at TIMESTAMPTZ,
        last_triggered_price NUMERIC,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE ${ALERTS_TABLE}
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE ${ALERTS_TABLE}
      ADD COLUMN IF NOT EXISTS indicator_kind TEXT,
      ADD COLUMN IF NOT EXISTS indicator_threshold NUMERIC,
      ADD COLUMN IF NOT EXISTS indicator_fast INT,
      ADD COLUMN IF NOT EXISTS indicator_slow INT
    `);

    await db.query(`
      UPDATE ${ALERTS_TABLE}
      SET expires_at = created_at + INTERVAL '24 hours'
      WHERE expires_at IS NULL
    `);

    await db.query(`
      ALTER TABLE ${ALERTS_TABLE}
      ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '24 hours')
    `);

    await db.query(`
      ALTER TABLE ${ALERTS_TABLE}
      ALTER COLUMN expires_at SET NOT NULL
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${ALERTS_TABLE}_chat_id_active_idx
      ON ${ALERTS_TABLE} (chat_id, active, created_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${ALERTS_TABLE}_symbol_active_idx
      ON ${ALERTS_TABLE} (symbol, active)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${CHAT_MESSAGES_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        message_text TEXT NOT NULL,
        message_type TEXT NOT NULL,
        telegram_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${CHAT_MESSAGES_TABLE}_chat_id_created_at_idx
      ON ${CHAT_MESSAGES_TABLE} (chat_id, created_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${CHAT_MESSAGES_TABLE}_created_at_idx
      ON ${CHAT_MESSAGES_TABLE} (created_at DESC)
    `);

    return true;
  })().catch(error => {
    schemaReady = undefined;
    throw error;
  });

  return schemaReady;
}

export async function saveHyperliquidSnapshot(snapshot) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const capturedAt = snapshot.timestamp ? new Date(snapshot.timestamp) : new Date();
  const result = await pool.query(
    `
      INSERT INTO ${SNAPSHOTS_TABLE} (source, interval, captured_at, status, snapshot)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING id, captured_at
    `,
    [
      snapshot.source ?? 'hyperliquid',
      snapshot.interval ?? 'unknown',
      Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
      snapshot.status ?? 'unknown',
      JSON.stringify(snapshot),
    ],
  );

  const row = result.rows[0];
  return {
    id: row.id,
    capturedAt: row.captured_at?.toISOString?.() ?? row.captured_at,
  };
}

export function normalizeIndicatorParams(row) {
  const kind = row?.indicator_kind ?? null;
  const threshold = row?.indicator_threshold == null ? null : Number(row.indicator_threshold);
  const fast = row?.indicator_fast == null ? null : Number(row.indicator_fast);
  const slow = row?.indicator_slow == null ? null : Number(row.indicator_slow);

  if (kind == null && threshold == null && fast == null && slow == null) return null;
  return { kind, threshold, fast, slow };
}

export function alertRuleIndicatorParams(rule) {
  const params = rule?.indicatorParams ?? null;
  return [
    params?.kind ?? null,
    params?.threshold ?? null,
    params?.fast ?? null,
    params?.slow ?? null,
  ];
}

export function normalizeAlertRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    symbol: row.symbol,
    conditionText: row.condition_text,
    conditionKind: row.condition_kind,
    lowerPrice: row.lower_price == null ? null : Number(row.lower_price),
    upperPrice: row.upper_price == null ? null : Number(row.upper_price),
    actionText: row.action_text,
    rawTree: row.raw_tree,
    active: Boolean(row.active),
    lastMatched: Boolean(row.last_matched),
    lastCheckedAt: row.last_checked_at?.toISOString?.() ?? row.last_checked_at,
    lastCheckedPrice: row.last_checked_price == null ? null : Number(row.last_checked_price),
    lastTriggeredAt: row.last_triggered_at?.toISOString?.() ?? row.last_triggered_at,
    lastTriggeredPrice: row.last_triggered_price == null ? null : Number(row.last_triggered_price),
    expiresAt: row.expires_at?.toISOString?.() ?? row.expires_at,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    indicatorParams: normalizeIndicatorParams(row),
  };
}

export function normalizeTelegramChatMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    direction: row.direction,
    messageText: row.message_text,
    messageType: row.message_type,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

export async function saveTelegramChatMessage({
  chatId,
  direction,
  messageText,
  messageType = 'system',
  telegramMessageId,
} = {}) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const result = await pool.query(
    `
      INSERT INTO ${CHAT_MESSAGES_TABLE} (
        chat_id,
        direction,
        message_text,
        message_type,
        telegram_message_id
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    [
      String(chatId),
      String(direction || 'unknown'),
      String(messageText ?? ''),
      String(messageType || 'system'),
      telegramMessageId == null ? null : String(telegramMessageId),
    ],
  );

  return normalizeTelegramChatMessageRow(result.rows[0]);
}

export async function saveDecisionTreeAlerts({ chatId, rawTree, rules }) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const saved = [];

    for (const rule of rules) {
      const result = await client.query(
        `
          INSERT INTO ${ALERTS_TABLE} (
            chat_id,
            symbol,
            condition_text,
            condition_kind,
            lower_price,
            upper_price,
            action_text,
            raw_tree,
            indicator_kind,
            indicator_threshold,
            indicator_fast,
            indicator_slow,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() + INTERVAL '24 hours')
          RETURNING *
        `,
        [
          String(chatId),
          rule.symbol,
          rule.conditionText,
          rule.conditionKind,
          rule.lowerPrice,
          rule.upperPrice,
          rule.actionText,
          rawTree,
          ...alertRuleIndicatorParams(rule),
        ],
      );
      saved.push(normalizeAlertRow(result.rows[0]));
    }

    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listDecisionTreeAlerts(chatId) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const result = await pool.query(
    `
      SELECT *
      FROM ${ALERTS_TABLE}
      WHERE chat_id = $1
        AND active = TRUE
        AND expires_at > NOW()
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `,
    [String(chatId)],
  );

  return result.rows.map(normalizeAlertRow);
}

export async function getDecisionTreeAlertsForSymbol(chatId, symbol) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const result = await pool.query(
    `
      SELECT *
      FROM ${ALERTS_TABLE}
      WHERE chat_id = $1
        AND symbol = $2
        AND active = TRUE
        AND expires_at > NOW()
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `,
    [String(chatId), symbol],
  );

  return result.rows.map(normalizeAlertRow);
}

export async function clearDecisionTreeAlerts(chatId, symbol) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const params = [String(chatId)];
  let symbolFilter = '';
  if (symbol) {
    params.push(symbol);
    symbolFilter = `AND symbol = $${params.length}`;
  }

  const result = await pool.query(
    `
      UPDATE ${ALERTS_TABLE}
      SET active = FALSE
      WHERE chat_id = $1
        AND active = TRUE
        ${symbolFilter}
      RETURNING id
    `,
    params,
  );

  return result.rowCount;
}

export async function getActiveDecisionTreeAlerts() {
  const ready = await ensureSchema();
  if (!ready) return [];

  const result = await pool.query(
    `
      SELECT *
      FROM ${ALERTS_TABLE}
      WHERE active = TRUE
        AND expires_at > NOW()
      ORDER BY created_at ASC, id ASC
    `,
  );

  return result.rows.map(normalizeAlertRow);
}

export async function expireDecisionTreeAlerts() {
  const ready = await ensureSchema();
  if (!ready) return 0;

  const result = await pool.query(
    `
      UPDATE ${ALERTS_TABLE}
      SET active = FALSE
      WHERE active = TRUE
        AND expires_at <= NOW()
      RETURNING id
    `,
  );

  return result.rowCount;
}

export async function updateDecisionTreeAlertEvaluation({ id, matched, price, triggered }) {
  const ready = await ensureSchema();
  if (!ready) return null;

  const result = await pool.query(
    `
      UPDATE ${ALERTS_TABLE}
      SET last_matched = $2,
          last_checked_at = NOW(),
          last_checked_price = $3,
          last_triggered_at = CASE WHEN $4 THEN NOW() ELSE last_triggered_at END,
          last_triggered_price = CASE WHEN $4 THEN $3 ELSE last_triggered_price END
      WHERE id = $1
      RETURNING *
    `,
    [id, Boolean(matched), price, Boolean(triggered)],
  );

  return normalizeAlertRow(result.rows[0]);
}

export async function getLatestHyperliquidSnapshot() {
  const ready = await ensureSchema();
  if (!ready) return null;

  const result = await pool.query(
    `
      SELECT id, captured_at, snapshot
      FROM ${SNAPSHOTS_TABLE}
      WHERE source = $1
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `,
    ['hyperliquid'],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    capturedAt: row.captured_at?.toISOString?.() ?? row.captured_at,
    snapshot: row.snapshot,
  };
}
