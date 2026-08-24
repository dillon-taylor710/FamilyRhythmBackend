import jwt from 'jsonwebtoken';
import { env } from '../config/env';

// Two completely separate token families on purpose — see schema.prisma's
// AdminUser doc comment. `aud` is checked on verify, not just decoded, so
// an admin token can never be replayed against a user-facing endpoint even
// if someone tried signing it with the wrong secret by mistake elsewhere.
const USER_AUDIENCE = 'family-rhythm-app';
const ADMIN_AUDIENCE = 'family-rhythm-admin';

export const signUserToken = (userId: string): string =>
  jwt.sign({ sub: userId, aud: USER_AUDIENCE }, env.JWT_USER_SECRET, {
    // @types/jsonwebtoken types `expiresIn` as a branded string template
    // (e.g. "30d"), not plain `string` — env vars are always plain
    // strings, so this cast is just satisfying that branding, not
    // widening away real type safety.
    expiresIn: env.JWT_USER_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

export const verifyUserToken = (token: string): { userId: string } => {
  const payload = jwt.verify(token, env.JWT_USER_SECRET, { audience: USER_AUDIENCE }) as jwt.JwtPayload;
  if (typeof payload.sub !== 'string') throw new Error('Malformed token payload');
  return { userId: payload.sub };
};

export const signAdminToken = (adminId: string, isSuperAdmin: boolean): string =>
  jwt.sign({ sub: adminId, aud: ADMIN_AUDIENCE, isSuperAdmin }, env.JWT_ADMIN_SECRET, {
    expiresIn: env.JWT_ADMIN_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

export const verifyAdminToken = (token: string): { adminId: string; isSuperAdmin: boolean } => {
  const payload = jwt.verify(token, env.JWT_ADMIN_SECRET, { audience: ADMIN_AUDIENCE }) as jwt.JwtPayload & {
    isSuperAdmin?: boolean;
  };
  if (typeof payload.sub !== 'string') throw new Error('Malformed token payload');
  return { adminId: payload.sub, isSuperAdmin: payload.isSuperAdmin === true };
};
