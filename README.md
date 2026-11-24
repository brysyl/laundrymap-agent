# LaundryMap

**Nigeria, Nasarawa × Abuja.** Laundry-Map is an on-demand laundry marketplace built as an installable PWA for the Karu–Mararaba corridor in Nasarawa State and the neighbouring FCT/Abuja border. The product promise is clean blue washing water, soaps and detergent laundry care, and neighborhood discovery and tracking along the corridor.

What is implemented today:

- Customers find approved vendors by radius search around their location (`GET /api/vendors/nearby`, PostGIS in Postgres), sorted by distance and shown as a list. The customer page falls back to a point near Karu (9.0, 7.59) when location is unavailable and searches a 10 km radius.
- Demo seed data (`SEED_DEMO=true`) contains four vendors in Mararaba, Karu, Gurku and New Karu (`backend/src/services/vendors.ts`). There is no seed data for the Abuja side. Vendors register their own coordinates from the browser's location.
- Customers pay through Paystack and track an order by status, with live Socket.IO updates. A courier's location is posted to the API while a job is active.
- Vendors accept and process orders. Couriers claim and deliver them with a delivery OTP. Admins approve vendors and couriers, issue refunds and record payouts.

Map: the home page (`/`) has an interactive local SVG demo corridor map (search, service filter, sort, vendor details and a demo pickup flow) driven by static demo data in `frontend/src/lib/demoVendors.ts`. It is not a tile map and not live vendor data, makes no API calls, and every element is labelled "Demo Data". The backend seed is unchanged; the Abuja side vendors exist only in the frontend demo data. In the signed-in app, discovery is the nearby-vendor list, and tracking means order status and live updates, not a courier pin on a map. Nothing in the code models water quality, soap or detergent products. Vendors list a unit price and customers describe items as free text, so the blue-water and detergent positioning is branding, not a feature.

- `frontend/`: Next.js 16 PWA (service worker, offline queue, role dashboards).
- `backend/`: Express 4 and Socket.IO API in TypeScript, with PostgreSQL/PostGIS, Redis, and an in-memory store and cache for development and tests.

## Architecture

- The browser reaches the API through a Next.js rewrite of `/api/*` (`API_PROXY_TARGET`) and Socket.IO directly (`NEXT_PUBLIC_SOCKET_URL`).
- Routes live in `backend/src/http/app.ts` and call services in `backend/src/services` (orders, payments, ledger, OTP, vendors, auth, state machine). Services use the `Store` interface (`MemoryStore` for dev and tests, `PostgresStore` for production) and a cache (in-memory or Redis).
- Order status changes go through a state machine with compare-and-set updates. Money is integer kobo and the ledger is double entry.
- The timeout and refund sweeper runs inside the API process (`backend/src/worker.ts`).
- The frontend keeps pure logic in `frontend/src/lib` (retry queue, throttle, countdown, connection state). `frontend/public/sw.js` and `sw-routing.js` implement caching and the `/offline` fallback.

## Verification status

Run in the authoring sandbox: typecheck, unit and integration tests (in-memory store and cache), and both production builds. The Postgres integration suite is skipped there, so it has not been run by the authors.

Not run anywhere yet, so treat as unverified until the staging checklist below is done:

- `PostgresStore`, SQL migrations, PostGIS queries and the ledger database triggers against a real Postgres.
- `RedisCache` and the Socket.IO Redis adapter against a real Redis.
- Docker image builds and `docker-compose.yml` (the sandbox has no Docker daemon).
- Live Paystack calls and webhooks.
- Lighthouse PWA audit and install behavior on a real device.

## Local development

Requires Node 20 or newer (CI uses 22).

```bash
npm install
cp backend/.env.example backend/.env      # then export the values, the server reads process.env
cp frontend/.env.example frontend/.env.local
```

Without `DATABASE_URL` and `REDIS_URL` the backend uses its in-memory store and cache, so state is lost on restart. Set `SEED_DEMO=true` to seed demo vendors.

```bash
JWT_SECRET=<32+ chars> OTP_ENCRYPTION_KEY=<different 32+ chars> npm run dev --workspace=backend
npm run dev --workspace=frontend
```

Full stack with Postgres and Redis: copy `.env.example` to `.env`, fill in the placeholders, then `docker compose up --build`. Compose runs Postgres and Redis without TLS, so the backend runs with `NODE_ENV=development` there. See the comments at the top of `docker-compose.yml` for enabling TLS.

## Testing and verification

```bash
npm run typecheck
npm test                                   # backend then frontend
npm test --workspace=backend
npm test --workspace=frontend
npm run build --workspace=backend
npm run build --workspace=frontend
```

Postgres integration tests need a PostGIS database. Without `TEST_DATABASE_URL` they are skipped (`describe.skip`), which is what the counts below reflect:

```bash
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=laundrymap_test postgis/postgis:16-3.4
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/laundrymap_test npm test --workspace=backend
```

Use a throwaway database, because the suite applies the migrations to it. CI (`.github/workflows/ci.yml`) provides a PostGIS service and sets `TEST_DATABASE_URL`.

Results without `TEST_DATABASE_URL`:

- Backend: 12 test files passed and 1 skipped, 124 tests passed and 13 skipped. All 13 skipped tests are in `postgres.integration.test.ts`.
- Frontend: 7 test files, 72 tests passed.

Counts change as tests are added, so re-run to confirm.

Backend tests (`backend/tests`):

| File | Covers |
| --- | --- |
| `lifecycle.test.ts` | Order lifecycle from payment to delivery. |
| `rbac.test.ts`, `invariants.test.ts` | Role checks, ledger balance across lifecycles, kobo split sweep, webhook edge cases, nearby vendor filtering. |
| `webhook.test.ts`, `refund-claims.test.ts`, `timeout.test.ts` | Paystack signature and dedupe, refund claims, backoff and cap, vendor timeout. |
| `otp.test.ts`, `money.test.ts`, `config.test.ts`, `socket.test.ts`, `hardening.test.ts` | OTP, money math, config validation, socket rooms and sessions, review fixes. |
| `migrations.test.ts` | Static checks of the SQL migration files (always run). |
| `postgres.integration.test.ts` | `PostgresStore`, migrations, triggers, payout locking (needs `TEST_DATABASE_URL`). |

Frontend tests (`frontend/tests`): `lib.test.ts` (countdown, `formatNaira`, connection banner, offline page, service worker policy, location throttle, realtime sync, submit guard), `sw.test.ts` (service worker routing, wiring and offline fallback), `api.test.ts`, `client.test.ts`, `config.test.ts`, `manifest.test.ts` and `submitGuard.test.ts`. They run in a Node environment without a DOM, so React components are not rendered.

## PWA build

- Root `npm run typecheck`, `npm test` and `npm run build` run the same script in both workspaces.
- Regenerate the PWA icons with `npm run icons --workspace=frontend`. The PNGs in `frontend/public/icons` are committed.
- Service workers only register in production builds. To try offline behavior: `npm run build --workspace=frontend && npm run start --workspace=frontend`, open the site in Chrome, then use DevTools Application and Network panels.

## Environment variables

Definitions and validation are in `backend/src/config.ts`. Amounts are integer kobo.

### Backend

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `production` turns on the strict checks below. |
| `PORT` | no | `4000` | |
| `LOG_LEVEL` | no | `info` | |
| `DATABASE_URL` | production | none | Must include `sslmode=require`, `verify-ca` or `verify-full` in production. Unset means in-memory store. |
| `REDIS_URL` | production | none | Must be `rediss://` in production. Unset means in-memory cache. |
| `JWT_SECRET` | yes | none | At least 32 characters in production, not a placeholder-looking value, different from `OTP_ENCRYPTION_KEY`. |
| `OTP_ENCRYPTION_KEY` | yes | none | Same rules as `JWT_SECRET`. |
| `JWT_TTL_SECONDS` | no | `43200` | |
| `PAYSTACK_SECRET_KEY` | production | none | Also used to verify webhook signatures. |
| `PAYSTACK_CALLBACK_URL` | no | none | |
| `CORS_EXTRA_ORIGINS` | no | none | Comma separated origins, https only in production. Added to `https://laundrymap.ng` and `https://api.laundrymap.ng`. |
| `TRUST_PROXY` | no | `0` | Proxy hops in front of the API. Use `1` on Render. |
| `PLATFORM_FEE_BPS` | no | `1000` | Basis points, at most 10000. |
| `DELIVERY_FEE_KOBO` | no | `100000` | |
| `GATEWAY_BPS`, `GATEWAY_FLAT_KOBO`, `GATEWAY_FLAT_THRESHOLD_KOBO`, `GATEWAY_CAP_KOBO` | no | `150`, `10000`, `250000`, `200000` | Paystack fee model used for ledger entries. |
| `VENDOR_ACCEPT_TIMEOUT_MS` | no | `120000` | Vendor acceptance window. |
| `WORKER_INTERVAL_MS` | no | `5000` | Timeout sweep interval. |
| `OTP_TTL_MS`, `OTP_MAX_ATTEMPTS`, `OTP_LOCK_MS` | no | `21600000`, `5`, `900000` | Delivery OTP lifetime, attempt limit and lockout. |
| `COURIER_LOCATION_MIN_INTERVAL_MS` | no | `3000` | |
| `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX` | no | `300`, `20` | Requests per minute. The limiter is in process memory, so limits are per instance. |
| `SEED_DEMO` | no | `false` | `true` seeds demo vendors. Keep `false` in production. |
| `ADMIN_EMAIL`, `ADMIN_PHONE`, `ADMIN_PASSWORD` | no | none | Set all three together to create an admin. Password at least 12 characters. |

### Frontend

| Variable | Notes |
| --- | --- |
| `API_PROXY_TARGET` | Origin that `/api/*` is rewritten to. Falls back to `NEXT_PUBLIC_API_URL`. |
| `NEXT_PUBLIC_API_URL` | Browser-visible API origin, for example `https://api.laundrymap.ng`. |
| `NEXT_PUBLIC_SOCKET_URL` | Socket.IO origin. Falls back to `NEXT_PUBLIC_API_URL`. |

The Content Security Policy `connect-src` is built from these values at build time, so changing them requires a rebuild.

## RBAC matrix

Roles: `CUSTOMER`, `VENDOR`, `COURIER`, `ADMIN`. Every authenticated route also applies ownership checks in the service layer. Routes are in `backend/src/http/app.ts`.

| Area | Routes | Public | Customer | Vendor | Courier | Admin |
| --- | --- | --- | --- | --- | --- | --- |
| Health | `GET /health`, `GET /ready` | yes | yes | yes | yes | yes |
| Paystack webhook | `POST /api/webhooks/paystack` | signature only | no | no | no | no |
| Auth | `POST /api/auth/register`, `POST /api/auth/login` | yes | yes | yes | yes | yes |
| Vendor discovery | `GET /api/vendors/nearby` | yes | yes | yes | yes | yes |
| Own profile and orders | `GET /api/me`, `GET /api/me/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/sync` | no | own | own | own | any |
| Place, pay, cancel order, read delivery code | `POST /api/orders`, `POST /api/orders/:id/pay`, `POST /api/orders/:id/cancel`, `GET /api/orders/:id/delivery-code` | no | own | no | no | no |
| Vendor order actions | `POST /api/vendor/orders/:id/{accept,reject,start,ready}` | no | no | own vendor | no | no |
| Courier order actions | `POST /api/courier/orders/:id/{claim,pickup,deliver}`, `POST /api/courier/location` | no | no | no | approved courier | no |
| Admin | `/api/admin/*` (vendors, couriers, refunds, ledger, audit, system, payouts) | no | no | no | no | yes |

Socket.IO rooms are derived from the authenticated identity on the server. A client can only join an order room through `order:join`, which checks ownership.

## Ledger and Paystack notes

- All money is stored as integer kobo (`BIGINT` in Postgres, `bigint` in code). No floats.
- The ledger is append-only and double entry: every posting must balance. Database triggers that enforce this are written in `backend/migrations/001_init.sql` but have not been run against a live Postgres. Application tests use the in-memory store.
- Payment flow: the customer pays through Paystack, the webhook credits the order and the platform ledger, the vendor accept window (2 minutes by default) starts, and a missed window refunds the customer deterministically through the sweeper.
- Webhook verification is HMAC-SHA512 over the raw request body, compared with `timingSafeEqual`. The route is mounted before `express.json()` so the raw bytes are preserved.
- Delivery OTPs are AES-256-GCM encrypted, single use, expiring and attempt-limited.
- Admin payouts are posted to the ledger. Payout transfers to bank accounts are not automated.

Known limitations:

- The backend does not implement an `Idempotency-Key` header, and the frontend no longer sends one. Duplicate Paystack webhook deliveries are deduplicated by event id and payment reference. Replayed vendor and courier actions are made safe by compare-and-set on order status (a replay returns 409, which the offline queue treats as final).
- Refunds are recorded in the ledger first and submitted to Paystack afterwards. A submitter first claims the refund (status `SUBMITTING`, attempt count incremented, `next_attempt_at` set to a lease end of `REFUND_CLAIM_LEASE_MS`, default 5 minutes) with one conditional update. In Postgres that update runs over a `FOR UPDATE SKIP LOCKED` row, so the worker, other API instances and admin retries cannot submit the same refund together. A failed attempt sets `FAILED` and a retry delay that starts at `REFUND_RETRY_MIN_AGE_MS` (60 seconds) and doubles up to `REFUND_BACKOFF_MAX_MS` (1 hour). After `REFUND_MAX_ATTEMPTS` (8) the refund becomes `EXHAUSTED`, a `refund.exhausted` audit row is written and an error with `alert: true` is logged. Nothing retries an exhausted refund automatically. An admin can retry any unsettled refund with `POST /api/admin/refunds/:id/retry`, which ignores backoff and the cap but gets 409 while another submitter holds a live claim.
- Remaining refund risks: Paystack's refund call is not sent with an idempotency key. If the gateway accepts a refund and the database write that records `SUBMITTED` then fails, the refund stays `SUBMITTING` and is sent again once the lease ends (Paystack rejects a second full refund, which then counts as a failed attempt). The ledger does not yet record gateway-side completion, so `payable:customer_refunds` only grows.
- A charge whose amount or currency differs from the order is not applied and the order stays `PENDING_PAYMENT`. The payment is marked `MISMATCH`, the webhook records the received amount when it is a positive NGN amount, and `GET /api/admin/payments/mismatched` lists it. While a `MISMATCH` payment exists for an order, `POST /api/orders/:id/pay` returns 409 `payment_mismatch_unresolved`. An admin resolves it with `POST /api/admin/payments/:id/refund-mismatch` (body `confirm` equal to the payment id, and `reason`). In one transaction that marks the payment `MISMATCH_REFUNDED`, posts cash and the refund liability for the received amount, creates a `MISMATCH` refund (which then follows the same claim, backoff and cap rules) and writes a `payment.mismatch_refund` audit row. After that the customer can pay again. Mismatches in another currency or with an unparseable amount have no stored received amount and return 409 `received_amount_unknown`; refund those in the Paystack dashboard. There is no admin action to apply a mismatched charge to the order instead, and no notification beyond the `alert: true` warning log. Migration 003 and its queries have not been run against Postgres here.
- Payouts take a per-account Postgres advisory lock (`lockAccount`) before checking the balance. This path is covered by a Postgres integration test that has not been run in this repository's development environment (see below).
- Postgres tests live in `backend/tests/postgres.integration.test.ts` and run only when `TEST_DATABASE_URL` points at a PostGIS database. CI provides one. Without it they are skipped, and all other backend tests use the in-memory store. Treat the Postgres store, ledger triggers and migration 002 as unverified until CI has run them.
- Suspending a vendor or courier disconnects their live sockets, sockets end when their JWT expires, and vendor and courier rooms are joined only when approved. Other changes (for example a user account status change) are only checked at connect and on `order:join`. There is no admin endpoint that suspends a user account.
- The JWT is stored in `localStorage`, and the production CSP still allows `'unsafe-inline'` scripts (Next.js needs it without per-request nonces). An XSS bug would expose a 12 hour bearer token. Moving to an httpOnly cookie or a nonce-based CSP needs dynamic rendering and cross-origin cookie work that is not done.
- The offline retry queue is tagged with the user id and cleared on sign-out and on a 401 response. A flush also discards items queued by a different user.
- The courier delivery flow consumes the OTP before the `DELIVERED` transition commits. A refund landing in that window burns the code on an order that is not delivered.
- The rate limiter keeps counters in process memory, so limits are per instance and reset on restart.
- The timeout and refund sweeps run inside each API process. There is no separate worker service.

## Deployment

- Backend: Render, using `render.yaml` and `backend/Dockerfile` (`docker build -f backend/Dockerfile .` from the repo root). Health check path is `/health`; `/ready` also checks the store and cache.
- Frontend: Vercel with Root Directory set to `frontend`. `frontend/vercel.json` lives there, so do not add another one at the repo root.
- CI: `.github/workflows/ci.yml` runs install, typecheck, test and both builds.

## Staging and production checklist

Nothing below has been completed. Tick each item in staging before go-live.

1. Provision managed PostgreSQL with PostGIS and TLS. Set `DATABASE_URL` with `sslmode=require` or stronger. Confirm the migration runs and the ledger triggers reject an unbalanced posting.
2. Provision managed Redis with TLS. Set `REDIS_URL` with `rediss://`. Confirm cache reads and Socket.IO events across two API instances.
3. Run the full lifecycle against Postgres and Redis: register, pay, accept, ready, claim, pickup, OTP delivery, plus a vendor timeout and refund.
4. Set `JWT_SECRET` and `OTP_ENCRYPTION_KEY` to distinct random values of 32 or more characters in the host secret store.
5. Set the live `PAYSTACK_SECRET_KEY` and register the webhook URL `https://api.laundrymap.ng/api/webhooks/paystack` in the Paystack dashboard. Send a Paystack test event and confirm the signature check passes and a forged signature is rejected.
6. DNS and SSL: `laundrymap.ng` (Vercel) and `api.laundrymap.ng` (Render) with valid certificates. Set `CORS_EXTRA_ORIGINS` only if extra https origins are needed, `NEXT_PUBLIC_API_URL=https://api.laundrymap.ng`, and `TRUST_PROXY=1`.
7. Set `SEED_DEMO=false`. Create the first admin through `ADMIN_EMAIL`, `ADMIN_PHONE` and `ADMIN_PASSWORD`, then remove the password variable.
8. Build the Docker image (`docker build -f backend/Dockerfile .`) and confirm the container passes its health check.
9. Confirm the Postgres integration tests (`TEST_DATABASE_URL`) pass in CI, including concurrent payouts and the one-pending-payment index. Migration 002 fails if existing data already has two `PENDING` payments for one order.
10. Decide whether to move the JWT to an httpOnly cookie and add a shared (Redis) rate limiter before running more than one API instance. Check the mismatched-payments list (`/api/admin/payments/mismatched`) and failed refunds (`/api/admin/refunds`) daily.
11. Run a Lighthouse PWA audit against the deployed site and test install, offline mode and live order updates on a real Android device and an iPhone.

## License

See `LICENSE`.
