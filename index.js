// Local / long-running server entry. Vercel uses api/index.js instead.
import app from "./src/app.js";

const PORT = Number(process.env.PORT) || 3001;

const server = app.listen(PORT, () => {
  console.log(`StudioSpace API listening on http://localhost:${PORT}`);
});

// Nodemon/SIGINT friendly shutdown so Mongo connections don't leak between restarts.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
