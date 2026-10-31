import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { pool } from './db/index.js';
import { chatRouter } from './routes/chat.route.js';
import { usageRouter } from './routes/usage.route.js';
import { GatewayError } from './services/budget.service.js';
import { UpstreamProviderError } from './services/llm.service.js';

export const app = express();

// Security and middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      database: 'unreachable',
      error: (err as Error).message,
    });
  }
});

// Mount versioned API routes
app.use('/v1/chat', chatRouter);
app.use('/v1/usage', usageRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: 'The requested gateway endpoint does not exist',
    },
  });
});

// Global Error Handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // 1. Zod Validation Errors -> 400
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'invalid_request_error',
        message: 'Schema validation error',
        details: err.issues,
      },
    });
  }

  // 2. Gateway Business Errors (401 Unauthorized, 402 Budget Exceeded)
  if (err instanceof GatewayError) {
    return res.status(err.statusCode).json(err.payload);
  }

  // 3. Upstream Provider Errors (400, 422, 502, 504)
  if (err instanceof UpstreamProviderError) {
    return res.status(err.statusCode).json({
      error: {
        code: 'upstream_provider_error',
        provider: err.provider,
        message: err.message,
      },
    });
  }

  // 4. JSON Body Parse Syntax Error
  if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
    return res.status(400).json({
      error: {
        code: 'bad_request',
        message: 'Invalid JSON payload format in request body',
      },
    });
  }

  // 5. Unhandled Internal Server Errors
  console.error('Unhandled Gateway Exception:', err);
  return res.status(500).json({
    error: {
      code: 'internal_server_error',
      message: 'An unexpected internal error occurred in the gateway',
    },
  });
});
