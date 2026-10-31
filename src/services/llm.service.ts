import { env } from '../config/env.js';
import {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  calculateActualCostMicroUsd,
} from '../config/pricing.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: false;
}

export interface GatewayMetadata {
  provider_used: 'groq' | 'gemini-fallback';
  fallback_triggered: boolean;
  cost_micro_usd: number;
  latency_ms: number;
}

export interface ProviderChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  x_gateway: GatewayMetadata;
}

export class UpstreamProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly provider: string,
    message: string,
    public readonly isTransient: boolean = false
  ) {
    super(`[${provider}] HTTP ${statusCode}: ${message}`);
    this.name = 'UpstreamProviderError';
  }
}

/**
 * Checks if an HTTP status code or error is transient and eligible for retry.
 */
function isTransientError(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

/**
 * Executes a call to the Primary Provider (Groq) with 8s timeout.
 */
async function callPrimaryProvider(
  payload: ChatCompletionRequest,
  simulateFailure: boolean
): Promise<ProviderChatResponse> {
  if (simulateFailure) {
    throw new UpstreamProviderError(
      503,
      'groq',
      'Simulated primary failure via x-simulate-primary-failure header',
      true
    );
  }

  // Deterministic mock handling for test suites or when mock mode is enabled
  const isMockMode =
    env.FALLBACK_MODE === 'mock' ||
    !env.GROQ_API_KEY ||
    env.GROQ_API_KEY === 'mock_groq_key' ||
    !env.GROQ_API_KEY.startsWith('gsk_') ||
    env.NODE_ENV === 'test';

  if (isMockMode) {
    // Simulate realistic 50ms provider network latency
    await new Promise((resolve) => setTimeout(resolve, 50));
    const promptTokens = Math.max(10, Math.ceil(JSON.stringify(payload.messages).length / 3));
    const completionTokens = Math.min(payload.max_tokens ?? 512, 24);

    return {
      id: `chatcmpl-groq-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: PRIMARY_MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! I am Llama 3.3 70B served via Groq.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      x_gateway: {
        provider_used: 'groq',
        fallback_triggered: false,
        cost_micro_usd: 0, // Calculated after return
        latency_ms: 0,
      },
    };
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: payload.model || PRIMARY_MODEL,
        messages: payload.messages,
        max_tokens: payload.max_tokens ?? 512,
        temperature: payload.temperature ?? 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new UpstreamProviderError(
        res.status,
        'groq',
        errText || res.statusText,
        isTransientError(res.status)
      );
    }

    const data = (await res.json()) as Omit<ProviderChatResponse, 'x_gateway'>;
    return {
      ...data,
      x_gateway: {
        provider_used: 'groq',
        fallback_triggered: false,
        cost_micro_usd: 0,
        latency_ms: 0,
      },
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof UpstreamProviderError) {
      throw err;
    }
    const isTimeout = (err as Error).name === 'AbortError';
    throw new UpstreamProviderError(
      isTimeout ? 504 : 502,
      'groq',
      isTimeout ? 'Request timed out after 8000ms' : (err as Error).message,
      true
    );
  }
}

/**
 * Executes a call to the Fallback Provider (Gemini OpenAI-compatible endpoint) with 10s timeout.
 */
async function callFallbackProvider(
  payload: ChatCompletionRequest
): Promise<ProviderChatResponse> {
  const isMockMode =
    env.FALLBACK_MODE === 'mock' ||
    !env.GEMINI_API_KEY ||
    env.GEMINI_API_KEY === 'mock_gemini_key' ||
    env.NODE_ENV === 'test';

  if (isMockMode) {
    const promptTokens = Math.max(10, Math.ceil(JSON.stringify(payload.messages).length / 3));
    const completionTokens = Math.min(payload.max_tokens ?? 512, 18);

    return {
      id: `chatcmpl-gemini-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: FALLBACK_MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! This is a fallback response from Gemini 2.5 Flash.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      x_gateway: {
        provider_used: 'gemini-fallback',
        fallback_triggered: true,
        cost_micro_usd: 0,
        latency_ms: 0,
      },
    };
  }

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GEMINI_API_KEY}`,
      },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        messages: payload.messages,
        max_tokens: payload.max_tokens ?? 512,
        temperature: payload.temperature ?? 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new UpstreamProviderError(
        res.status,
        'gemini',
        errText || res.statusText,
        isTransientError(res.status)
      );
    }

    const data = (await res.json()) as Omit<ProviderChatResponse, 'x_gateway'>;
    return {
      ...data,
      x_gateway: {
        provider_used: 'gemini-fallback',
        fallback_triggered: true,
        cost_micro_usd: 0,
        latency_ms: 0,
      },
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof UpstreamProviderError) {
      throw err;
    }
    const isTimeout = (err as Error).name === 'AbortError';
    throw new UpstreamProviderError(
      isTimeout ? 504 : 502,
      'gemini',
      isTimeout ? 'Fallback request timed out after 10000ms' : (err as Error).message,
      true
    );
  }
}

/**
 * Main LLM Orchestrator:
 * 1. Attempt Primary (Groq) with 8s timeout.
 * 2. If transient error (429, 5xx, timeout), wait 250ms and retry Primary once.
 *    (Fail immediately on non-transient 400/422).
 * 3. If retry fails, route to Fallback (Gemini) with 10s timeout.
 * 4. Return normalized response with x_gateway metadata.
 */
export async function executeChatCompletion(
  payload: ChatCompletionRequest,
  simulatePrimaryFailure: boolean = false
): Promise<{
  response: ProviderChatResponse;
  actualModel: string;
  providerUsed: 'groq' | 'gemini-fallback';
  fallbackTriggered: boolean;
  fallbackReason: string | null;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  latencyMs: number;
}> {
  const startTime = Date.now();
  let fallbackTriggered = false;
  let fallbackReason: string | null = null;
  let response: ProviderChatResponse;

  // Step 1: Attempt Primary Provider
  try {
    response = await callPrimaryProvider(payload, simulatePrimaryFailure);
  } catch (primaryErr: unknown) {
    const err = primaryErr as UpstreamProviderError;

    // Fail immediately on 400 Bad Request / 422 Unprocessable Entity - do NOT retry or fallback
    if (err.statusCode === 400 || err.statusCode === 422) {
      throw err;
    }

    // Step 2: Retry Primary once if transient
    let retrySucceeded = false;
    if (err.isTransient) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        response = await callPrimaryProvider(payload, simulateFailureAfterRetry(simulatePrimaryFailure));
        retrySucceeded = true;
      } catch (retryErr: unknown) {
        fallbackReason = (retryErr as Error).message;
      }
    } else {
      fallbackReason = err.message;
    }

    // Step 3: Route to Fallback Provider if primary and retry failed
    if (!retrySucceeded) {
      fallbackTriggered = true;
      fallbackReason = fallbackReason || err.message;

      try {
        response = await callFallbackProvider(payload);
      } catch (fallbackErr: unknown) {
        // Both primary and fallback failed -> release reservation and throw 502
        throw new UpstreamProviderError(
          502,
          'gateway',
          `All LLM providers failed. Primary: ${fallbackReason}. Fallback: ${(fallbackErr as Error).message}`
        );
      }
    }
  }

  const latencyMs = Date.now() - startTime;
  const actualModel = response!.model;
  const providerUsed: 'groq' | 'gemini-fallback' = fallbackTriggered
    ? 'gemini-fallback'
    : 'groq';

  const promptTokens = response!.usage?.prompt_tokens ?? 0;
  const completionTokens = response!.usage?.completion_tokens ?? 0;
  const costMicroUsd = calculateActualCostMicroUsd(actualModel, promptTokens, completionTokens);

  response!.x_gateway = {
    provider_used: providerUsed,
    fallback_triggered: fallbackTriggered,
    cost_micro_usd: costMicroUsd,
    latency_ms: latencyMs,
  };

  return {
    response: response!,
    actualModel,
    providerUsed,
    fallbackTriggered,
    fallbackReason,
    promptTokens,
    completionTokens,
    costMicroUsd,
    latencyMs,
  };
}

function simulateFailureAfterRetry(simulate: boolean): boolean {
  return simulate;
}
