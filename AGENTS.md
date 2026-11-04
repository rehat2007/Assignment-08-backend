# StudioSpace backend

Express 5 + native `mongodb` driver API for the sibling Next.js app. ESM JavaScript (`"type": "module"`, Node >= 20), no build step, no TypeScript.

## Commands

Run from this directory:

- `npm run dev` — nodemon on port 3001; `npm start` — plain node.
- `npm run seed` — upserts the 8 catalog studios/reviews into the `studio`/`review` collections.
- `npm run seed:demo` — catalog + Better Auth-compatible demo accounts, listings, bookings, reviews, wishlist (idempotent; password `Studio123`).
- No test, lint, typecheck, or build scripts exist. Verify manually with `curl`:
  - `GET /api/health` — no DB touched, so a 500 means the function itself broke.
  - `GET /api/health/db` — 503 when Atlas is unreachable.
  - Unauthenticated `GET /api/wishlist` must return `401`.
- `.env` keys: `PORT=3001`, `MONGODB_URI`, `CORS_ORIGIN`, `DB_NAME` (defaults `studiospace`), optional `IMGBB_API_KEY`.
- Locally use the **non-SRV** `mongodb://` URI; `mongodb+srv://` fails with `querySrv ECONNREFUSED` on this machine (`src/db.js` pins DNS to 1.1.1.1 unless `VERCEL` is set).

## Seed coupling

`src/seed.js` hard-imports `../../studiospace_front_end/src/lib/studios.js`, so seeding requires the sibling front-end checkout. Both seed scripts write to whatever `MONGODB_URI` points at — double-check before running against a production URI. Host ownership is only linked for owner emails that already exist in Better Auth.

## Architecture

- `src/app.js` is the Express app and must never call `app.listen()`.
- Entrypoints: `index.js` (local server, graceful SIGINT/SIGTERM) and `api/index.js` (Vercel function). `vercel.json` rewrites every request to `/api`.
- DB connects lazily in middleware in `src/app.js` (after the health routes) so failed connections retry; `src/db.js` caches the client/db per instance and creates indexes on first connect. `col(name)` throws if `connect()` has not run.
- Routers are mounted under `/api/{studios,bookings,wishlist,host,users,uploads,newsletter}`. This app serves **no** auth routes.
- Shared Atlas database with the front end: Better Auth owns `user`/`session`/`account`; this API owns `studio`/`booking`/`review`/`wishlist`/`newsletterSubscriber`. `seed-demo.js` writes auth users/accounts deliberately, mirroring Better Auth's scrypt hash format.
- Auth (`src/auth.js`): reads the `better-auth.session_token` cookie, strips the `.signature`, looks the token up in the `session` collection with an `expiresAt` check, and `requireUser` sets `req.user`. There is no shared secret or JWT; browser calls need `credentials: "include"`.
- Errors: throw the helpers in `src/errors.js`; the handler in `src/app.js` returns `{ error, details? }` and hides 500 messages. Express 5 forwards async throws — do not wrap routes in try/catch just to call `next(error)`.

## Gotchas

- `assert(condition, message, status)` in `src/validate.js` ignores its third argument and always throws `400`. Owner-only checks written as `assert(..., 403)` therefore return 400 — use `forbidden()` when a real 403 matters.
- Studio routes accept a slug or a 24-hex `_id`; wishlist requires a 24-hex studio `_id`; bookings accept `studioId` or `studioSlug`.
- Booking `date` is always a `YYYY-MM-DD` string (not a `Date`) to avoid timezone drift. The server computes `total = hours × price + deposit` and re-checks overlaps (`409`); never trust a client total.
- Status lifecycle is `pending`/`confirmed`/`completed`/`cancelled`; `declined` is mapped to `cancelled`.
- Reviews need a completed booking by that user and are unique per user + studio (partial unique index ignores seeded reviews with `userId: null`).
- `POST /api/uploads` proxies imgbb and returns `503` when `IMGBB_API_KEY` is missing. Vercel caps request bodies at 4.5 MB even though Express allows 40 MB.
- `CORS_ORIGIN` is a comma-separated list of exact origins including port. Do not set `PORT` on Vercel.
- Relative ESM imports need the `.js` extension.

`docs/SETUP.md` is the authoritative setup/session/deployment walkthrough and endpoint contract; `readme.md` is the project overview. This file only covers what is easy to get wrong.
