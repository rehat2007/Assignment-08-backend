// StudioSpace API — Express 5 back end implementing the endpoint contract in
// studiospace_front_end/README.md. Runs on :3001 and shares the `studiospace`
// Mongo database (and session cookie) with the Next.js Better Auth instance.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { connect } from "./src/db.js";
import studiosRouter from "./src/routes/studios.js";
import bookingsRouter from "./src/routes/bookings.js";
import wishlistRouter from "./src/routes/wishlist.js";
import hostRouter from "./src/routes/host.js";
import usersRouter from "./src/routes/users.js";
import uploadsRouter from "./src/routes/uploads.js";
import newsletterRouter from "./src/routes/newsletter.js";

const PORT = Number(process.env.PORT) || 3001;

await connect();

const app = express();

// The Next.js front end (localhost:3000) is the only browser client; cookies
// flow with credentials: true.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "40mb" }));

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

const server = app.listen(PORT, () => {
  console.log(`StudioSpace API listening on http://localhost:${PORT}`);
  console.log(`CORS: ${ALLOWED_ORIGINS.join(", ")}`);
});

// Nodemon/SIGINT friendly shutdown so Mongo connections don't leak between restarts.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
