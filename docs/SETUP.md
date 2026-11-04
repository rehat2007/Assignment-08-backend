# StudioSpace API — Connecting the Back End to the Front End

Step-by-step algorithm for wiring the Express API (this folder) into the
Next.js app (`../studiospace_front_end`). Follow the steps in order — each one
builds on the previous.

```
┌────────────────────────┐        fetch + cookies        ┌────────────────────────┐
│  Next.js front end     │ ───────────────────────────▶  │  Express API (here)    │
│  localhost:3000        │ ◀───────────────────────────  │  localhost:3001        │
│                        │        JSON responses         │                        │
│  Better Auth issues    │   BOTH READ THE SAME COOKIE   │  requireUser() matches │
│  better-auth.session_  │ ◀────── localhost scope ──▶   │  the token against     │
│  token on sign-in      │      (cookies ignore ports)   │  Better Auth's session │
└───────────┬────────────┘                               └───────────┬────────────┘
            │                                                        │
            └──────────────── MongoDB Atlas: studiospace ────────────┘
                 Better Auth owns user/session/account,
                 the API owns studio/booking/review/wishlist/newsletterSubscriber
```

---

## Step 0 — Prerequisites

- Node 20+ installed.
- MongoDB Atlas cluster credentials (already in both `.env` files).
- Front end runs on `http://localhost:3000` (Next.js dev server).
- The API runs on `http://localhost:3001` — never on 3000, Next owns that port.

---

## Step 1 — Configure the back-end environment

Open `studiospace_back_end/.env` and confirm these values:

```ini
PORT=3001
MONGODB_URI=mongodb://<user>:<pass>@ac-...shard-00-00.../studiospace?...&replicaSet=atlas-6e663a-shard-0
CORS_ORIGIN=http://localhost:3000     # front end origin, add others comma-separated
IMGBB_API_KEY=                        # optional until you need POST /api/uploads
```

Rules:

- `MONGODB_URI` must use the **non-SRV** `mongodb://` form (`mongodb+srv://`
  breaks on this machine — Node's `resolveSrv` fails with `querySrv ECONNREFUSED`).
- `CORS_ORIGIN` must exactly match the front-end origin including the port,
  because the fetch calls send cookies (`credentials: "include"`).

---

## Step 2 — Seed the database (one-time, safe to re-run)

```bash
cd studiospace_back_end
npm run seed       # catalog + sample reviews only
npm run seed:demo  # catalog + demo accounts, listings, bookings, reviews, wishlist
```

`npm run seed` output:

```
Seeded studio → 8 created, 0 updated. Reviews ensured. Hosts linked: 1/4 emails.
```

What it does: upserts the 8 studios from `../studiospace_front_end/src/lib/studios.js`
into the `studio` collection (keyed by `slug`), inserts the catalog's sample
reviews once, and links `hostUserId` to real Better Auth accounts where the
owner email exists (e.g. `ayesha@studiospace.dev`).

### Demo data — `npm run seed:demo`

Runs the catalog seed first, then creates everything needed to click through
both dashboards. It is idempotent, so re-run it any time.

| Account | Password | What it can do |
|---|---|---|
| `host@studiospace.dev` | `Studio123` | Owns 4 listings; incoming bookings in every state |
| `customer@studiospace.dev` | `Studio123` | 4 bookings (pending/confirmed/completed), 3 saved studios |
| `maya@studiospace.dev` | `Studio123` | Completed booking on Blue Note, ready to leave a review |

The login page lists these accounts and pre-fills the host one. Seeded
booking slots are visible in the detail page's availability picker (e.g.
Reverb Room +10 days, 10:00–13:00), so the conflict check can be tried
without creating anything first.

---

## Step 3 — Start the API and verify it

```bash
# terminal 1 — backend
cd studiospace_back_end
npm run dev        # nodemon watch; or npm start for production
```

Verify before touching the front end:

| Check | Command | Expected |
|---|---|---|
| health | `curl http://localhost:3001/api/health` | `{"ok":true,...}` |
| public list | `curl "http://localhost:3001/api/studios?limit=3"` | `{"studios":[...],"total":8}` |
| protected route | `curl http://localhost:3001/api/wishlist` | `{"error":"Please sign in to continue."}` (`401`) |

The `401` on `/api/wishlist` is the key check: session auth is armed.

---

## Step 4 — Create the front-end API client

In `studiospace_front_end` add one shared module — `src/lib/api.js`:

```js
// src/lib/api.js
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Thin wrapper around fetch. Every call:
 *  - targets the Express API (port 3001)
 *  - sends the session cookie (credentials: "include")  ← REQUIRED for auth
 *  - unwraps the API's { error } shape into a thrown Error
 */
export async function apiFetch(path, { method = "GET", body, ...rest } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include", // sends better-auth.session_token to :3001
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",      // dashboard data must never be cached
    ...rest,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data;
}
```

(Optional: put the base URL in `studiospace_front_end/.env.local` as
`NEXT_PUBLIC_API_URL=http://localhost:3001`.)

---

## Step 5 — Understand how the session is shared (why this works)

This is the one concept to get right before wiring endpoints:

1. The user signs in via Better Auth in the **Next.js** app (`/api/auth/sign-in/email`).
2. Better Auth sets the cookie `better-auth.session_token=<token>.<signature>`.
3. Cookies are scoped to a **domain, not a port** — so `localhost:3000` and
   `localhost:3001` are the *same* cookie jar in the browser.
4. Every `apiFetch` call ships that cookie to the Express API.
5. The API (`src/auth.js`) strips the signature and looks the token up in the
   `session` collection (which Better Auth also wrote) + checks `expiresAt`.
6. Valid → `req.user` is attached and the route runs; invalid → `401`.

No shared secret, no duplicate login, nothing to configure beyond
`credentials: "include"` + the CORS origin cookie allowed.

Caveat: this holds for localhost (host-only cookies). In production
(front-end `https://app.example.com`, API `https://api.example.com`) the two
must be subdomains of one parent domain, e.g. `app.studiospace.app` +
`api.studiospace.app`, and both `.env` files must set the cookie domain.

---

## Step 6 — Wire the endpoints (swap mocks → API, in this order)

Do these in order; each maps one README endpoint to the exact front-end file
that must stop using mock data.

### 6.1 Explore + detail pages — GET `/api/studios`, GET `/api/studios/:slug`

Replace the `STUDIOS`/`getStudioBySlug` usage in explore/detail pages:

```js
const res = await apiFetch(
  `/api/studios?q=${q}&category=${category}&sort=${sort}&page=${page}`
);
// res = { studios, total, page, pages }
const detail = await apiFetch(`/api/studios/${slug}`);
// detail = { studio, reviews, reviewsSummary }
```

Keep `src/lib/studios.js` as the fallback/seed — you'll still need
`categoryLabel()` and `STUDIO_CATEGORIES` for UI labels.

### 6.2 Listings page — `/dashboard/listings`

`GET /api/host/listings` replaces the `STUDIOS.filter(... === user.email)`:

```js
const { studios } = await apiFetch("/api/host/listings");
```

The delete dialog then calls the real endpoint:

```js
// replaces the removedSlugs local state
await apiFetch(`/api/studios/${studio._id}`, { method: "DELETE" });
```

`403` if the signed-in user isn't the owner — good for catching bugs early.

### 6.3 Bookings page — `/dashboard/bookings`

`INITIAL_BOOKINGS` mock → `GET /api/bookings`:

```js
const { bookings } = await apiFetch("/api/bookings");              // as customer
const { bookings } = await apiFetch("/api/bookings?role=host");    // incoming, for hosts
```

Status transitions ("Cancel Booking" button) → `PATCH`:

```js
await apiFetch(`/api/bookings/${booking._id}`, {
  method: "PATCH",
  body: { status: "cancelled" },   // creator: cancelled · host: confirmed|declined|completed
});
```

The "Invoice" button → real receipt download (replaces the client-built txt):

```js
const res = await fetch(`${API_BASE}/api/bookings/${id}/receipt`, {
  credentials: "include",
});
const blob = await res.blob();
// then the existing anchor-download snippet
```

### 6.4 Booking modal on the detail page — POST `/api/bookings` + availability

```js
// conflict checks when a day is picked
const { bookedSlots, minHours } = await apiFetch(
  `/api/studios/${studio._id}/availability?date=${date}`
);
// submit
const { booking } = await apiFetch("/api/bookings", {
  method: "POST",
  body: { studioId: studio._id, date, startHour, endHour },
});
// booking.total = hours × price + deposit — always trust the server's total, never recompute.
```

Handle `409` ("That time slot is no longer available…" — someone grabbed the
slot between the availability check and the submit) by re-fetching availability.

### 6.5 Wishlist — `src/lib/wishlist.js`

Keep the file's public API (`useWishlist`, `toggleWishlist`, …) identical so
components don't change — swap its internals from localStorage to the API:

```js
const { studios } = await apiFetch("/api/wishlist");              // ids the hearts prefill from
const { wishlisted } = await apiFetch("/api/wishlist", {          // toggle anywhere
  method: "POST",
  body: { studioId },
});
await apiFetch(`/api/wishlist/${studioId}`, { method: "DELETE" }); // explicit remove
```

Because `/dashboard`'s "Saved studios" stat reads the same store, it becomes
true automatically.

### 6.6 Dashboard stats — `/dashboard`

`GET /api/host/stats` replaces the `PENDING_BOOKINGS`/`CONFIRMED_BOOKINGS`
constants:

```js
const { listings, savedStudios, bookings } = await apiFetch("/api/host/stats");
```

### 6.7 Supporting endpoints

| File / flow | Endpoint |
|---|---|
| `/register-host` form submit | `POST /api/studios` |
| Register-host image picker → imgbb | `POST /api/uploads` (`{ image: dataURI }` → `{ url }`) — needs `IMGBB_API_KEY` in backend `.env` |
| Footer newsletter "Join" | `POST /api/newsletter` (`{ email }`) — always succeeds, dedupes silently |
| Navbar profile / `PATCH` name & avatar | `PATCH /api/users/me` (`{ name, image }` — `image: null` clears to initials) |
| Studio detail reviews form | `POST /api/studios/:id/reviews` — only works after a completed booking (`403` explains itself) |

---

## Step 7 — Run both servers together

```bash
# terminal 1
cd studiospace_back_end  &&  npm run dev          # API on :3001

# terminal 2
cd studiospace_front_end &&  npm run dev          # Next on :3000
```

The front end may keep Better Auth handlers on :3000 — those keep working;
the API never serves auth.

---

## Step 8 — End-to-end smoke test (run through in the browser)

Run `npm run seed:demo` first, then sign in with the demo accounts from Step 2.

1. Sign in as `host@studiospace.dev` → navbar shows **Nadia Karim**.
2. `/dashboard` shows 4 listings and 7 bookings: 2 pending, 1 confirmed,
   3 completed, 1 cancelled.
3. `/dashboard/listings` shows Reverb Room, Blackbox, North Sound Stage and
   Blue Note — coming from Mongo, not the constants file. Edit or delete one
   and confirm the change survives a reload.
4. `/studios/reverb-room-recording-suite` → pick the date +10 days; the
   10:00–13:00 slot is already booked by `customer@studiospace.dev`. Booking an
   overlapping slot must fail with `409`.
5. As the host, confirm a pending booking at `/dashboard/bookings`; then sign
   in as the customer and download its receipt.
6. Sign in as `maya@studiospace.dev` → open Blue Note and post a review (her
   completed booking makes her eligible). Attempting a second review must fail
   with `409`; reviewing a studio without a completed booking returns `403`.
7. Sign out; wishlist hearts and `/dashboard/*` must refuse (`401`) and send
   you to login.

---

## Step 9 — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to fetch` / CORS error in console | Origin not in `CORS_ORIGIN`, or `credentials: "include"` missing | Match the exact origin+port in backend `.env`; add `credentials: "include"` to the fetch |
| Every protected route returns `401` while logged in | Cookie not sent (fetch without `credentials`) or session expired | Re-fetch sign-in, re-check fetch options |
| `401` even with cookies sent |Front-end server restarted wiped the session / Atlas row expired | Sign in again — sessions live in Mongo, so only expiry should bite |
| `set-cookie` never lands | Testing on `127.0.0.1` while `.env` say `localhost` | Use one name consistently — prefer `http://localhost:3000` |
| Port 3001 already in use | A previous `node index.js` still running | Kill it (`Get-Process node`, or close the terminal) or set another `PORT` here and update `API_BASE` on the front end |
| Uploads return `503` | `IMGBB_API_KEY` empty | Get a free key from imgbb.com, put it in backend `.env`, restart nodemon |
| Atlas connection fails with `querySrv ECONNREFUSED` | SRV URI used | Use the non-SRV `mongodb://` URI (see Step 1) |

---

## Step 10 — Deploy the API on Vercel

The back end is now serverless-ready:

| File | Purpose |
|---|---|
| `src/app.js` | Express app (routes, CORS, error handler) — **no `app.listen()`** |
| `index.js` | Long-running local server entry (`npm start` / `npm run dev`) |
| `api/index.js` | Vercel function entry; exports the Express app |
| `vercel.json` | Rewrites every request to the function |

Steps:

1. Push this folder to its own GitHub repository.
2. Vercel → **Add New → Project** → import that repository.
   - Framework Preset: **Other**
   - Root Directory: repository root
   - Build Command: leave empty (Vercel installs dependencies and bundles
     `api/index.js`)
   - Node: 20 or newer
3. Add environment variables:

   | Key | Value |
   |---|---|
   | `MONGODB_URI` | Atlas URI (`mongodb://` or `mongodb+srv://`) |
   | `DB_NAME` | `studiospace` |
   | `CORS_ORIGIN` | `https://studiospace-theta.vercel.app,http://localhost:3000` |
   | `IMGBB_API_KEY` | optional — enables `/api/uploads` |

   Do **not** set `PORT`; Vercel manages the port.
4. Deploy. **This project is live at
   `https://assignment-08-backend-pi.vercel.app`** — redeploy after changing
   `src/app.js`, routes, or environment variables.
5. Verify:

   ```bash
   curl https://assignment-08-backend-pi.vercel.app/api/health
   # {"ok":true,"service":"studiospace-api"}

   curl https://assignment-08-backend-pi.vercel.app/api/health/db
   # {"ok":true,"database":"studiospace"}
   # 503 + hasUri/name/message if Atlas is unreachable

   curl -i https://assignment-08-backend-pi.vercel.app/api/wishlist
   # 401 {"error":"Please sign in to continue."}
   ```

   `/api/health` never touches the database, so a `500` there means the function
   itself failed. A `200` from `/api/health` plus a `503` from `/api/health/db`
   means the code is fine but the database is not reachable — check that
   `MONGODB_URI` is set on **this** Vercel project and that Atlas Network Access
   allows `0.0.0.0/0`.

6. On the **frontend** Vercel project, set
   `API_PROXY_TARGET=https://assignment-08-backend-pi.vercel.app` and redeploy
   (production builds already default to this URL, so the variable is optional).
   The frontend proxies `/api/proxy/*` to this URL so the Better Auth cookie
   works despite both apps being on separate `*.vercel.app` domains.

Notes:

- The API connects to MongoDB on the first request (see the connection
  middleware in `src/app.js`) rather than using top-level `await`, so the
  serverless module loads reliably and a failed connection can retry.
- Vercel limits request bodies to **4.5 MB**; the API's 40 MB JSON limit only
  applies on a normal host. Use Railway/Render (`npm start`) if large uploads
  matter.
- Serverless functions cold-start and open a Mongo connection per instance;
  `src/db.js` caches the connection while the instance stays warm.
- Atlas **Network Access** must allow `0.0.0.0/0` (Vercel egress IPs vary).

---

## Quick reference — endpoint ↔ origin

| Method | Endpoint (base `http://localhost:3001`) | Auth |
|---|---|---|
| POST | `/api/auth/sign-up/email` ✅ (Next, not the Express app) | — |
| GET | `/api/studios` (+`[slug]`, `/availability`, `/reviews`) | public |
| POST | `/api/studios` (`/reviews`) | auth |
| PATCH/DELETE | `/api/studios/:id` | owner |
| GET | `/api/bookings` (`?role=host`), `/receipt` | auth |
| POST/PATCH | `/api/bookings`, `/api/bookings/:id` | auth |
| GET/POST/DELETE | `/api/wishlist…` | auth |
| GET | `/api/host/listings`, `/api/host/stats` | auth |
| PATCH | `/api/users/me` | auth |
| POST | `/api/uploads` (needs IMGBB key), `/api/newsletter` | auth / public |




on this filecreate a well-designed README.md that includes:
Project name 
Short description
Technologies used
5 key features of the project
