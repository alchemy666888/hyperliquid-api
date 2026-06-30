import pg from 'pg';

const { Pool } = pg;

const SNAPSHOTS_TABLE = 'hyperliquid_snapshots';

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

  pool = new Pool({
    connectionString: config.connectionString || undefined,
    host: config.connectionString ? undefined : config.host,
    port: config.connectionString ? undefined : config.port,
    user: config.connectionString ? undefined : config.user,
    password: config.connectionString ? undefined : config.password,
    database: config.connectionString ? undefined : config.database,
    max: config.maxConnections,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
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
