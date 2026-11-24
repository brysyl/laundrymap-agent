# LaundryMap

On-demand laundry marketplace for Nigeria, built as an installable PWA. Customers find nearby vendors, pay through Paystack, and track pickup and delivery. Vendors accept and process orders. Couriers claim and deliver them. Admins approve vendors and couriers, issue refunds and record payouts.

- `frontend/`: Next.js 16 PWA (service worker, offline queue, role dashboards).
- `backend/`: Express 4 and Socket.IO API in TypeScript, with PostgreSQL/PostGIS, Redis, and an in-memory store and cache for development and tests.

## Verification status

Run in the authoring sandbox: typecheck, unit and integration tests (in-memory store and cache), and both production builds.

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

## PWA build and test

```bash
npm run typecheck
npm test
npm run build --workspace=backend
npm run build --workspace=frontend
```

- Root `npm run typecheck`, `npm test` and `npm run build` run the same script in both workspaces.
- Regenerate the PWA icons with `npm run icons --workspace=frontend`. The PNGs in `frontend/public/icons` are committed.
- Service workers only register in production builds. To try offline behavior: `npm run build --workspace=frontend && npm run start --workspace=frontend`, open the site in Chrome, then use DevTools Application and Network panels.
- Frontend tests cover the manifest, service worker logic and the offline queue. Backend tests cover the order lifecycle, RBAC, OTP, ledger, Paystack webhook, vendor timeout and sockets.

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

- The backend does not implement an `Idempotency-Key` header. Duplicate Paystack webhook deliveries are deduplicated by event id and payment reference, not by a client key.
- The `PostgresStore` payout balance check does not take a row lock, so two concurrent payouts could both pass the balance check. Do not run concurrent admin payouts until a lock is added.
- The rate limiter keeps counters in process memory, so limits are per instance and reset on restart.
- The timeout sweeper runs inside each API process. There is no separate worker service.

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
9. Add a row lock to the `PostgresStore` payout balance check, or restrict payouts to one admin at a time.
10. Decide whether to add `Idempotency-Key` support and a shared (Redis) rate limiter before running more than one API instance.
11. Run a Lighthouse PWA audit against the deployed site and test install, offline mode and live order updates on a real Android device and an iPhone.

## License

See `LICENSE`.
