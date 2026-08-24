import { Router } from 'express';
import { authGuard } from '../../middleware/authGuard';
import { asyncHandler } from '../../utils/asyncHandler';
import { verifyPurchaseSchema } from './subscriptions.schemas';
import * as subscriptionsService from './subscriptions.service';

export const subscriptionsRouter = Router();

subscriptionsRouter.use(authGuard);

subscriptionsRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const result = await subscriptionsService.getStatus(req.userId!);
    res.json(result);
  }),
);

// Active plan catalog (label + current price) — the Flutter app fetches
// this right after login (see `SubscriptionController`) so Purchase
// Screen's plan list reflects whatever a super admin has set on the admin
// Plans page, instead of a hardcoded label/price baked into the app build.
subscriptionsRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    res.json({ plans: await subscriptionsService.listActivePlans() });
  }),
);

subscriptionsRouter.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const input = verifyPurchaseSchema.parse(req.body);
    const result = await subscriptionsService.verifyPurchase(req.userId!, input);
    res.json(result);
  }),
);
