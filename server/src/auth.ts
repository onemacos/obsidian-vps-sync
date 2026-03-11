import type { Request, Response, NextFunction } from 'express';
import type { WsMessage, AuthPayload } from './types';

export function createAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.headers['x-api-key'];
    if (!apiKey || key === apiKey) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}

export function validateWsAuth(apiKey: string, message: WsMessage): boolean {
  if (message.type !== 'AUTH') return false;
  const payload = message.payload as AuthPayload;
  return typeof payload?.apiKey === 'string' && payload.apiKey === apiKey;
}
