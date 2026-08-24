import { NextFunction, Request, Response } from 'express';
import { verifyUserToken } from '../utils/jwt';
import { unauthorized } from '../utils/httpError';

// Guards every /api/subscriptions/* route. Only ever attaches `req.userId`
// from a verified JWT — never trusts a userId passed in the request body,
// which is the whole point (see root CLAUDE.md: never trust the client).
export function authGuard(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return next(unauthorized('auth.missingToken'));

  try {
    const { userId } = verifyUserToken(token);
    req.userId = userId;
    next();
  } catch {
    next(unauthorized('auth.invalidToken'));
  }
}
