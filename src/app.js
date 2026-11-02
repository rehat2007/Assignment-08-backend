// Express app shared by the local server (index.js) and the Vercel function
// (api/index.js). Intentionally no app.listen() here.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { connect } from "./db.js";
import studiosRouter from "./routes/studios.js";
import bookingsRouter from "./routes/bookings.js";
import wishlistRouter from "./routes/wishlist.js";
import hostRouter from "./routes/host.js";
import usersRouter from "./routes/users.js";
import uploadsRouter from "./routes/uploads.js";
import newsletterRouter from "./routes/newsletter.js";

const app = express();

// Browser clients are the Next.js front end (locally :3000, in production the
// Vercel deployment). Cookies flow with credentials: true. The front-end proxy
// is same-origin and bypasses CORS, but keeping these origins allows direct
// API calls and local development.
const DEFAULT_ORIGINS =
  "http://localhost:3000,https://studiospace-theta.vercel.app";
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN ?? DEFAULT_ORIGINS)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "40mb" }));

// Connect on the first request instead of at module load. Serverless bundlers
// handle a synchronously-importable app more reliably than top-level await, and
// a failed connection can be retried on the next request.
let connectionPromise;

app.use(async (_req, _res, next) => {
  try {
    connectionPromise ??= connect();
    await connectionPromise;
    next();
  } catch (error) {
    connectionPromise = null;
    next(error);
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "studiospace-api" });
});

app.use("/api/studios", studiosRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/host", hostRouter);
app.use("/api/users", usersRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/newsletter", newsletterRouter);

// 404 for unknown API paths, then the consistent JSON error handler.
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

// eslint-disable-next-line no-unused-vars -- Express requires the 4-arg signature
app.use((error, _req, res, _next) => {
  const status = error?.status ?? 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: error?.status ? error.message : "Something went wrong. Please retry.",
    ...(error?.details ? { details: error.details } : {}),
  });
});

export default app;
