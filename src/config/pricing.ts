export interface ModelPricing {
  inputMicroUsdPer1M: number;
  outputMicroUsdPer1M: number;
}

/**
 * Model pricing table in micro-USD per 1,000,000 tokens (1 USD = 1,000,000 micro-USD).
 * Input/Output rates:
 * - llama-3.3-70b-versatile (Groq Primary): $0.59 / 1M input (590,000 µUSD), $0.79 / 1M output (790,000 µUSD)
 * - gemini-2.5-flash (Gemini Fallback): $0.15 / 1M input (150,000 µUSD), $0.60 / 1M output (600,000 µUSD)
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Groq Modern Stable Models
  'qwen/qwen3.8-27b': {
    inputMicroUsdPer1M: 300_000,
    outputMicroUsdPer1M: 600_000,
  },
  'openai/gpt-oss-20b': {
    inputMicroUsdPer1M: 200_000,
    outputMicroUsdPer1M: 400_000,
  },
  'openai/gpt-oss-120b': {
    inputMicroUsdPer1M: 600_000,
    outputMicroUsdPer1M: 1_200_000,
  },

  // Gemini Modern Stable Models
  'gemini-3.8-flash': {
    inputMicroUsdPer1M: 150_000,
    outputMicroUsdPer1M: 600_000,
  },
  'gemini-3.1-flash-lite': {
    inputMicroUsdPer1M: 100_000,
    outputMicroUsdPer1M: 400_000,
  },

  // Template Legacy Aliases
  'llama-3.3-70b-versatile': {
    inputMicroUsdPer1M: 590_000,
    outputMicroUsdPer1M: 790_000,
  },
  'gemini-2.5-flash': {
    inputMicroUsdPer1M: 150_000,
    outputMicroUsdPer1M: 600_000,
  },
};

export const PRIMARY_MODEL = 'qwen/qwen3.8-27b';
export const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

/**
 * Heuristically estimates input tokens:
 * ~3 characters per token + 20 fixed framing tokens.
 */
export function estimateInputTokens(messages: unknown): number {
  const serialized = JSON.stringify(messages);
  return Math.ceil(serialized.length / 3) + 20;
}

/**
 * Computes worst-case cost reservation in integer micro-USD.
 * Uses the highest price between primary and fallback providers to ensure
 * zero-risk solvency regardless of whether fallback triggers.
 */
export function estimateWorstCaseReservationMicroUsd(
  messages: unknown,
  maxTokens: number = 512
): number {
  const estimatedInput = estimateInputTokens(messages);
  const cappedMaxTokens = Math.min(Math.max(1, maxTokens), 4096);

  const primaryPricing = MODEL_PRICING[PRIMARY_MODEL]!;
  const fallbackPricing = MODEL_PRICING[FALLBACK_MODEL]!;

  const higherInputRate = Math.max(
    primaryPricing.inputMicroUsdPer1M,
    fallbackPricing.inputMicroUsdPer1M
  );
  const higherOutputRate = Math.max(
    primaryPricing.outputMicroUsdPer1M,
    fallbackPricing.outputMicroUsdPer1M
  );

  const inputCost = Math.ceil((estimatedInput * higherInputRate) / 1_000_000);
  const outputCost = Math.ceil((cappedMaxTokens * higherOutputRate) / 1_000_000);

  return Math.max(1, inputCost + outputCost);
}

/**
 * Calculates confirmed micro-USD spend from actual token usage reported by provider.
 */
export function calculateActualCostMicroUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[PRIMARY_MODEL]!;

  const inputCost = Math.ceil((promptTokens * pricing.inputMicroUsdPer1M) / 1_000_000);
  const outputCost = Math.ceil((completionTokens * pricing.outputMicroUsdPer1M) / 1_000_000);

  return inputCost + outputCost;
}
