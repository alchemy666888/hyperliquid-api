import { getHyperliquidSnapshot } from './hyperliquid.js';
import { getPostgresStatus } from './postgres.js';
import { processDecisionTreeAlerts } from './alert-processor.js';
import { sendTelegramMessage } from './telegram-client.js';

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

export async function refreshMarketDataAndProcessAlerts() {
  const snapshot = await getHyperliquidSnapshot();
  let alerts = { enabled: false, checked: 0, triggered: 0 };
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const postgresStatus = getPostgresStatus();

  if (token && postgresStatus.configured) {
    try {
      alerts = await processDecisionTreeAlerts(
        snapshot,
        (chatId, text) => sendTelegramMessage(token, chatId, text),
      );
    } catch (error) {
      console.error('decision-tree alert processing error:', error);
      alerts = {
        enabled: true,
        checked: 0,
        triggered: 0,
        error: 'Decision-tree alert processing failed',
      };
    }
  }

  return { snapshot, alerts };
}
