# Family Rhythm backend

Subscription/billing backend for the Family Rhythm Flutter app. Node.js +
TypeScript + Express + PostgreSQL (via Prisma).

The Flutter app (`/lib`) currently has **no real authentication or
in-app-purchase integration** — logins and purchases are fully mocked
client-side. This backend is the first real component; wiring the Flutter
app up to it is a separate, later change (not part of this backend work).

## Architecture

```
Flutter app
   │  POST /api/auth/signup or /login        → { userId, token }
   ▼
Backend ── users, subscriptions, purchase_transactions (PostgreSQL)
   │
   │  POST /api/subscriptions/verify  { platform, productId, purchaseToken }
   ▼
Google Play Developer API  /  Apple App Store Server API
   │  verifies the purchase token server-side — the client's own
   │  "I purchased this" claim is never trusted on its own
   ▼
Backend saves the transaction + updates the subscription row
   │
   ▼
GET /api/subscriptions/status → { status, active, expiresAt, ... }
```

See `prisma/schema.prisma` for the full data model and the reasoning
behind each table (`User`, `Subscription`, `PurchaseTransaction`,
`AdminUser`) in its doc comments.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create an account, returns `{ userId, token }` |
| POST | `/api/auth/login` | — | `{ userId, token }` |
| GET | `/api/auth/me` | Bearer user token | `{ id, email, displayName }` — login/signup don't return this, so the client fetches it separately (also used to restore a session from a saved token on app relaunch) |
| GET | `/api/subscriptions/status` | Bearer user token | Current subscription state |
| POST | `/api/subscriptions/verify` | Bearer user token | Verify a store purchase, update subscription |
| GET | `/api/admin/users` | Bearer/cookie admin token | JSON — all users + their subscription |
| GET | `/api/admin/subscriptions` | Bearer/cookie admin token | JSON — all subscriptions + transaction counts |
| GET | `/admin/login`, `/admin/users`, `/admin/subscriptions` | admin cookie | Server-rendered admin website |

`POST /api/subscriptions/verify` request/response:
```json
// request
{ "platform": "android", "productId": "yearly_plan", "purchaseToken": "..." }

// response
{
  "status": "active_paid",
  "active": true,
  "planId": "yearly_plan",
  "platform": "android",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "trialDaysRemaining": 0,
  "autoRenewing": true,
  "valid": true
}
```
`GET /api/subscriptions/status` returns the same shape minus `valid`.

## Local setup

1. **Install PostgreSQL** locally, or run one via Docker:
   ```bash
   docker run --name family-rhythm-db -e POSTGRES_USER=family_rhythm -e POSTGRES_PASSWORD=changeme -e POSTGRES_DB=family_rhythm -p 5432:5432 -d postgres:16
   ```
2. **Install dependencies**
   ```bash
   cd backend
   npm install
   ```
3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Fill in `DATABASE_URL` (matches the Docker command above by default),
   and generate real secrets for `JWT_USER_SECRET`/`JWT_ADMIN_SECRET`:
   ```bash
   openssl rand -hex 32
   ```
   Google/Apple credentials (`GOOGLE_SERVICE_ACCOUNT_*`, `APPLE_*`) are
   only required for `/api/subscriptions/verify` to actually work — the
   rest of the API runs fine without them.
4. **Run migrations**
   ```bash
   npm run prisma:migrate
   ```
5. **Create an admin account** (there's no admin signup endpoint on
   purpose — see `prisma/seed.ts`):
   ```bash
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=a-strong-password npm run seed
   ```
6. **Run the server**
   ```bash
   npm run dev       # ts-node-dev, restarts on change
   # or
   npm run build && npm start
   ```
7. Visit `http://localhost:4000/admin/login`, or `curl http://localhost:4000/health`.

## Getting Google Play / Apple credentials

- **Google Play Developer API**: Play Console → Setup → API access → create
  a service account, grant it "View financial data" for this app, download
  its JSON key. Put the file path in `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, or
  paste the JSON contents into `GOOGLE_SERVICE_ACCOUNT_JSON`. Set
  `GOOGLE_PLAY_PACKAGE_NAME` to the app's package name (e.g.
  `com.familyrhythm.app`).
- **Apple App Store Server API**: App Store Connect → Users and Access →
  Integrations → In-App Purchase key. Note the Key ID and Issuer ID, and
  download the `.p8` private key — its contents go in `APPLE_PRIVATE_KEY`
  (keep the `\n` line breaks if stored as one env var line). Set
  `APPLE_BUNDLE_ID` to the app's bundle identifier. Leave
  `APPLE_USE_SANDBOX=true` until you're verifying real production
  purchases.

## Known gaps (intentionally out of scope for this pass)

- **No renewal/cancellation webhooks.** Google Play Real-time Developer
  Notifications and Apple App Store Server Notifications aren't wired up.
  A subscription that lapses or gets refunded only updates in this
  database the next time `GET /status` happens to be called for that user
  (it recomputes trial/subscription expiry against wall-clock time on every
  read — see `subscriptions.service.ts`'s `resolveCurrentState`). Adding
  the two webhook endpoints is the natural next step.
- **Apple JWS signature isn't fully chain-verified.** `appStoreVerifier.ts`
  decodes the transaction JWT Apple returns but doesn't verify its
  certificate chain up to Apple's root CA — fine for getting this working,
  but should be hardened (`jose`'s `jwtVerify` with Apple's published certs)
  before handling real revenue.
- **No password reset flow.** Signup/login only.
