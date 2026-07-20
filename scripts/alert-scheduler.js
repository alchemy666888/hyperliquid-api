import '../lib/telegram-log-forwarder.js';
import { refreshMarketDataAndProcessAlerts } from '../lib/alert-runner.js';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

function readPositiveIntEnv(name, defaultValue) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

const intervalMs = readPositiveIntEnv('ALERT_SCHEDULER_INTERVAL_MS', DEFAULT_INTERVAL_MS);
let timer;
let running = false;
let stopped = false;

async function runOnce() {
  if (running) {
    console.warn('Previous alert scheduler run is still active; skipping this tick.');
    return;
  }

  running = true;
  const startedAt = new Date();
  try {
    console.log(`Alert scheduler tick started at ${startedAt.toISOString()}`);
    const { snapshot, alerts } = await refreshMarketDataAndProcessAlerts();
    console.log(JSON.stringify({
      event: 'alert_scheduler_tick_complete',
      timestamp: new Date().toISOString(),
      snapshotTimestamp: snapshot.timestamp,
      persistence: snapshot.persistence,
      alerts,
    }));
  } catch (error) {
    console.error('Alert scheduler tick failed:', error);
  } finally {
    running = false;
  }
}

function stop(signal) {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  console.log(`Alert scheduler received ${signal}; shutting down.`);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

console.log(`Alert scheduler starting with ${intervalMs}ms interval.`);
await runOnce();
if (!stopped) {
  timer = setInterval(runOnce, intervalMs);
}
