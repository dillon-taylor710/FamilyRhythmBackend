// Augments Express's Request with the fields our auth middlewares attach,
// so route handlers get typed `req.userId`/`req.adminId` instead of `any`.
declare namespace Express {
  export interface Request {
    userId?: string;
    adminId?: string;
    isSuperAdmin?: boolean;
  }
}
