import '../../lib/telegram-log-forwarder.js';
import {
  PLAN_RUNNER_STAGES,
  normalizeRunnerStage,
  runPlanStageOnce,
} from '../../lib/plan-stage-runner.js';

function requestStage(req) {
  const value = req.query?.stage;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const stage = normalizeRunnerStage(requestStage(req));
  if (!stage) {
    res.status(400).json({
      error: 'Unsupported plan stage.',
      allowedStages: [...PLAN_RUNNER_STAGES],
      status: 'error',
    });
    return;
  }

  try {
    const result = await runPlanStageOnce(stage);
    const failed = result?.event === 'plan_stage_runner_failed'
      || result?.event === 'plan_stage_runner_unavailable'
      || result?.event === 'plan_stage_runner_invalid_stage';
    res.status(failed ? 500 : 200).json({
      status: failed ? 'error' : 'ok',
      result,
    });
  } catch (error) {
    console.error('plan runner api error:', error);
    res.status(500).json({
      error: error.message,
      status: 'error',
    });
  }
}
