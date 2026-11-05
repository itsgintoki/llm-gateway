import { Router, type Request, type Response, type NextFunction } from 'express';
import { getKeyUsage, UnauthorizedError } from '../services/budget.service.js';

export const usageRouter = Router();

usageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let rawKey: string | null = null;

    // 1. Try Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawKey = authHeader.slice(7).trim();
    }

    // 2. Fall back to ?key= query parameter (with security advisory header)
    if (!rawKey && typeof req.query.key === 'string') {
      rawKey = req.query.key.trim();
      res.setHeader(
        'x-security-advisory',
        'Passing API keys in query parameters is discouraged; prefer Authorization: Bearer <key>'
      );
    }

    if (!rawKey) {
      throw new UnauthorizedError(
        'Missing API key. Provide via Authorization header (Bearer rok_...) or ?key= query parameter.'
      );
    }

    const usage = await getKeyUsage(rawKey);
    return res.status(200).json(usage);
  } catch (err) {
    return next(err);
  }
});
