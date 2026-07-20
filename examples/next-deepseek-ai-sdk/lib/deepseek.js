import { createDeepSeek } from '@ai-sdk/deepseek';

const REQUIRED_MODEL = 'deepseek-v4-pro';

export function getDeepSeekModelId() {
  const modelId = process.env.DEEPSEEK_MODEL ?? REQUIRED_MODEL;

  if (modelId !== REQUIRED_MODEL) {
    throw new Error(
      `DEEPSEEK_MODEL must be exactly ${REQUIRED_MODEL}. Do not append feature suffixes such as -thinking-search.`
    );
  }

  return modelId;
}

export function getDeepSeekModel() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required.');
  }

  const deepseek = createDeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  return deepseek(getDeepSeekModelId());
}

export const deepSeekRequiredFeatures = {
  reasoning: { effort: 'high' },
  enableSearch: true,
};
