import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import {
  authenticateAndReserve,
  settleReservation,
  releaseReservation,
  UnauthorizedError,
  type ReservationResult,
} from '../services/budget.service.js';
import {
  estimateWorstCaseReservationMicroUsd,
  PRIMARY_MODEL,
} from '../config/pricing.js';
import { executeChatCompletion } from '../services/llm.service.js';

export const chatRouter = Router();

const chatRequestSchema = z.object({
  model: z.string().default(PRIMARY_MODEL),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1, 'Message content must not be empty'),
      })
    )
    .min(1, 'At least one message is required'),
  max_tokens: z.number().int().min(1).max(4096).optional().default(512),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  stream: z
    .boolean()
    .optional()
    .default(false)
    .refine((val) => val === false, {
      message:
        'Streaming (stream: true) is explicitly not supported to guarantee deterministic, zero-trust financial accounting.',
    }),
});

chatRouter.post('/completions', async (req: Request, res: Response, next: NextFunction) => {
  let reservation: ReservationResult | null = null;
  const requestId = (req.headers['x-request-id'] as string) || `req_${crypto.randomUUID()}`;
  res.setHeader('x-request-id', requestId);

  // Link premature client connection drop to abort signal
  const clientAbortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientAbortController.abort();
    }
  });

  try {
    // 1. Extract Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header. Expected Bearer <key>');
    }
    const rawKey = authHeader.slice(7).trim();
    if (!rawKey) {
      throw new UnauthorizedError('Bearer token must not be empty');
    }

    // 2. Validate payload
    const parsedBody = chatRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        error: {
          code: 'invalid_request_error',
          message: 'Request body failed validation',
          details: parsedBody.error.issues,
        },
      });
    }

    const { messages, max_tokens, temperature, model } = parsedBody.data;

    // 3. Pre-flight model-aware worst-case estimation
    const worstCaseMicroUsd = estimateWorstCaseReservationMicroUsd(messages, max_tokens, model);

    // 4. Phase 1: Two-Phase Commit - Authenticate & Pessimistic Reservation
    reservation = await authenticateAndReserve(rawKey, worstCaseMicroUsd);

    // 5. Header injection for testing resilience
    const simulateFailure =
      req.headers['x-simulate-primary-failure'] === 'true' ||
      req.headers['x-simulate-primary-failure'] === '1';

    // 6. Execute Provider Proxy (Groq primary -> retry -> Gemini fallback)
    let executionResult;
    try {
      executionResult = await executeChatCompletion(
        {
          model,
          messages,
          max_tokens,
          temperature,
          stream: false,
        },
        simulateFailure,
        clientAbortController.signal
      );
    } catch (llmErr) {
      // LLM failed or client disconnected - release in-flight reservation immediately
      if (reservation) {
        await releaseReservation(
          reservation.keyId,
          reservation.reservedMicroUsd,
          reservation.reservationId
        );
        reservation = null;
      }
      throw llmErr;
    }

    // 7. Phase 2: Settle reservation with confirmed cost & write usage log
    await settleReservation(
      reservation.keyId,
      reservation.reservedMicroUsd,
      executionResult.costMicroUsd,
      {
        requestId,
        requestedModel: model,
        actualModel: executionResult.actualModel,
        providerUsed: executionResult.providerUsed,
        fallbackTriggered: executionResult.fallbackTriggered,
        fallbackReason: executionResult.fallbackReason,
        promptTokens: executionResult.promptTokens,
        completionTokens: executionResult.completionTokens,
        costMicroUsd: executionResult.costMicroUsd,
        latencyMs: executionResult.latencyMs,
        statusCode: 200,
      },
      reservation.reservationId
    );

    // Mark reservation settled
    reservation = null;

    // 8. Return standard OpenAI completion response with x_gateway metadata
    return res.status(200).json(executionResult.response);
  } catch (err) {
    if (reservation) {
      try {
        await releaseReservation(
          reservation.keyId,
          reservation.reservedMicroUsd,
          reservation.reservationId
        );
      } catch (rollbackErr) {
        console.error('CRITICAL: Failed to release reservation on error:', rollbackErr);
      }
    }
    return next(err);
  }
});
